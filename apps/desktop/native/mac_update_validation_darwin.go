//go:build darwin

package main

import (
	"bytes"
	"context"
	"debug/macho"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

type macBuildInfo struct {
	Version      string `json:"version"`
	Build        int64  `json:"build"`
	Mode         string `json:"mode"`
	Platform     string `json:"platform"`
	Architecture string `json:"architecture"`
}

type macNodeIdentity struct {
	Device uint64 `json:"device"`
	Inode  uint64 `json:"inode"`
}

type macBundleInfo struct {
	Path       string          `json:"path"`
	Executable string          `json:"executable"`
	Identifier string          `json:"identifier"`
	Version    string          `json:"version"`
	Team       string          `json:"team"`
	CDHash     string          `json:"cdHash"`
	Adhoc      bool            `json:"adhoc"`
	Build      macBuildInfo    `json:"build"`
	Node       macNodeIdentity `json:"node"`
}

type macUpdatePlan struct {
	Schema                  int                    `json:"schema"`
	ID                      string                 `json:"id"`
	Work                    string                 `json:"work"`
	DataDir                 string                 `json:"dataDir"`
	Repository              string                 `json:"repository"`
	PublicKey               string                 `json:"publicKey"`
	APIBase                 string                 `json:"apiBase"`
	ExtraRestartEnvironment []string               `json:"extraRestartEnvironment,omitempty"`
	ParentPID               int                    `json:"parentPid"`
	ParentIdentity          string                 `json:"parentIdentity"`
	ParentExecutable        string                 `json:"parentExecutable"`
	HelperSHA256            string                 `json:"helperSha256"`
	HelperBundle            *macFilesystemIdentity `json:"helperBundle,omitempty"`
	Current                 macBundleInfo          `json:"current"`
	Installer               pendingInstaller       `json:"installer"`
	Directories             *macSwapDirectories    `json:"directories,omitempty"`
	planSHA256              string
	lastJournalSHA256       string // Only the live helper retains its last durable journal revision.
	transactionSHA256       string
	launchedProcess         *macUpdateLaunchedProcess
	preparedCandidate       macBundleInfo // Live helper only; never reloaded from the journal.
}

type macCommandOutput struct {
	mu       sync.Mutex
	data     bytes.Buffer
	overflow bool
}

func (w *macCommandOutput) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	n := len(p)
	left := (1 << 20) - w.data.Len()
	if len(p) > left {
		w.overflow = true
		p = p[:left]
	}
	_, _ = w.data.Write(p)
	return n, nil
}

func runMacUpdateCommand(ctx context.Context, timeout time.Duration, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = systemProcessEnvironment()
	out := &macCommandOutput{}
	cmd.Stdout = out
	cmd.Stderr = out
	err := cmd.Run()
	if out.overflow {
		return nil, errors.New("更新校验命令输出过大")
	}
	if err != nil {
		return nil, fmt.Errorf("%s: %w: %.2048s", filepath.Base(name), err, out.data.String())
	}
	return out.data.Bytes(), nil
}

func macCanonical(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(abs)
}

func macNode(path string) (macNodeIdentity, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return macNodeIdentity{}, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return macNodeIdentity{}, errors.New("更新目标不能是符号链接")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return macNodeIdentity{}, errors.New("无法读取更新路径身份")
	}
	return macNodeIdentity{uint64(stat.Dev), stat.Ino}, nil
}

func macPathInside(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

func validateMacBundleTree(root string) error {
	canonical, err := macCanonical(root)
	if err != nil || canonical != root {
		return errors.New("应用路径不能经过符号链接")
	}
	var size int64
	entries := 0
	return filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		entries++
		if entries > 20000 {
			return errors.New("应用条目过多")
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode()&(os.ModeSetuid|os.ModeSetgid|os.ModeDevice|os.ModeNamedPipe|os.ModeSocket) != 0 {
			return errors.New("应用包含特殊权限或特殊文件")
		}
		if info.Mode()&os.ModeSymlink != 0 {
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			resolved, err := macCanonical(path)
			if filepath.IsAbs(link) || err != nil || !macPathInside(root, resolved) {
				return errors.New("应用符号链接逃出bundle")
			}
			return nil
		}
		if info.Mode().IsRegular() {
			size += info.Size()
			if size > 2*maxDownloadBytes {
				return errors.New("应用解包大小超过限制")
			}
		}
		return nil
	})
}

func readMacBundle(ctx context.Context, path string, requireMetadata bool) (macBundleInfo, error) {
	var result macBundleInfo
	canonical, err := macCanonical(path)
	if err != nil || canonical != path || !strings.HasSuffix(path, ".app") {
		return result, errors.New("更新目标不是规范的app目录")
	}
	if err := validateMacBundleTree(path); err != nil {
		return result, err
	}
	plistPath := filepath.Join(path, "Contents", "Info.plist")
	info, err := os.Lstat(plistPath)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 1<<20 {
		return result, errors.New("应用Info.plist无效")
	}
	data, err := runMacUpdateCommand(ctx, 15*time.Second, "/usr/bin/plutil", "-convert", "xml1", "-o", "-", plistPath)
	if err != nil {
		return result, err
	}
	dict, err := parsePlist(data)
	if err != nil {
		return result, err
	}
	get := func(key string) string { value, _ := dict[key].(string); return value }
	name := get("CFBundleExecutable")
	if get("CFBundlePackageType") != "APPL" || name == "" || filepath.Base(name) != name || strings.ContainsAny(name, "/\\:") || name == "." || name == ".." {
		return result, errors.New("应用可执行文件声明无效")
	}
	executable := filepath.Join(path, "Contents", "MacOS", name)
	realExe, err := macCanonical(executable)
	if err != nil || realExe != executable {
		return result, errors.New("应用主程序不能是符号链接")
	}
	mainInfo, err := os.Lstat(executable)
	if err != nil || !mainInfo.Mode().IsRegular() || mainInfo.Mode().Perm()&0111 == 0 {
		return result, errors.New("应用主程序不可执行")
	}
	file, err := macho.Open(executable)
	if err != nil {
		return result, errors.New("应用主程序不是受支持的单架构Mach-O")
	}
	architecture := ""
	switch file.Cpu {
	case macho.CpuArm64:
		architecture = "arm64"
	case macho.CpuAmd64:
		architecture = "x64"
	}
	file.Close()
	if architecture != architectureName() {
		return result, errors.New("应用主程序架构不匹配")
	}
	if _, err = runMacUpdateCommand(ctx, 30*time.Second, "/usr/bin/codesign", "--verify", "--deep", "--strict", "--all-architectures", path); err != nil {
		return result, err
	}
	sign, err := runMacUpdateCommand(ctx, 15*time.Second, "/usr/bin/codesign", "-d", "--verbose=4", path)
	if err != nil {
		return result, err
	}
	result = macBundleInfo{Path: path, Executable: executable, Identifier: get("CFBundleIdentifier"), Version: get("CFBundleShortVersionString")}
	for _, line := range strings.Split(string(sign), "\n") {
		if strings.HasPrefix(line, "TeamIdentifier=") {
			result.Team = strings.TrimPrefix(line, "TeamIdentifier=")
		}
		if strings.HasPrefix(line, "CDHash=") {
			result.CDHash = strings.TrimPrefix(line, "CDHash=")
		}
		if line == "Signature=adhoc" {
			result.Adhoc = true
		}
	}
	if result.Identifier == "" || result.Version == "" || result.CDHash == "" {
		return result, errors.New("应用缺少身份信息")
	}
	if buildMode == "release" {
		if result.Adhoc || len(result.Team) != 10 || strings.IndexFunc(result.Team, func(r rune) bool { return !(r >= 'A' && r <= 'Z' || r >= '0' && r <= '9') }) >= 0 {
			return result, errors.New("正式应用缺少有效Apple团队身份")
		}
		requirement := fmt.Sprintf(`anchor apple generic and certificate leaf[subject.OU] = "%s"`, result.Team)
		if _, err = runMacUpdateCommand(ctx, 30*time.Second, "/usr/bin/codesign", "--verify", "--deep", "--strict", "--all-architectures", "-R", requirement, path); err != nil {
			return result, err
		}
	}
	result.Node, err = macNode(path)
	if err != nil {
		return result, err
	}
	if requireMetadata {
		metadata, ok := dict["ChordVBuildInfo"].(map[string]any)
		if !ok {
			return result, errors.New("应用缺少已签名的ChordVBuildInfo，拒绝自动更新")
		}
		data, err = json.Marshal(metadata)
		if err != nil || json.Unmarshal(data, &result.Build) != nil {
			return result, errors.New("应用内嵌构建信息无效")
		}
		if result.Build.Version != result.Version || result.Build.Platform != "macos" || result.Build.Architecture != architecture {
			return result, errors.New("应用声明与实际构建信息不一致")
		}
	}
	return result, nil
}

func validateMacSigning(current, candidate macBundleInfo, mode string) error {
	if current.Identifier != candidate.Identifier {
		return errors.New("更新应用bundleID不一致")
	}
	if mode == "release" {
		if current.Identifier != "app.chordv.desktop" || current.Adhoc || candidate.Adhoc || current.Team == "" || current.Team == "not set" || candidate.Team != current.Team {
			return errors.New("正式更新必须由相同Apple团队签名，不能使用临时签名")
		}
	} else if mode != "local" || (!strings.HasPrefix(current.Identifier, "app.chordv.mygo.local.") && current.Identifier != "app.chordv.mygo.local") {
		return errors.New("本地更新只能替换同一local应用")
	}
	return nil
}

func (p *macUpdatePlan) service() *DesktopService {
	return newDesktopService(appConfig{DataDir: p.DataDir, ReleaseRepository: p.Repository, ReleasePublicKey: p.PublicKey})
}

func (p *macUpdatePlan) verifyReceipt() error {
	if buildMode == "release" && (p.Repository != embeddedReleaseRepository || p.PublicKey != embeddedReleasePublicKey || p.PublicKey == "") {
		return errors.New("更新授权来源与本程序不一致")
	}
	s := p.service()
	defer s.cancel()
	if err := s.verifyGrantReceipt(p.Installer.Grant); err != nil {
		return err
	}
	grant := p.Installer.Grant
	if grant.Component != "" || grant.FileName != filepath.Base(p.Installer.Path) || grant.SHA256 != p.Installer.SHA256 || grant.Size != p.Installer.Size || grant.Version != p.Installer.Version {
		return errors.New("安装包receipt字段不一致")
	}
	root, err := macCanonical(filepath.Join(p.DataDir, "updater"))
	if err != nil {
		return err
	}
	path, err := macCanonical(p.Installer.Path)
	if err != nil || filepath.Dir(path) != root || path != p.Installer.Path {
		return errors.New("安装包路径不在规范更新目录内")
	}
	return verifyFile(path, grant.SHA256, grant.Size)
}

func (p *macUpdatePlan) verifyCandidate(ctx context.Context) (macBundleInfo, error) {
	var zero macBundleInfo
	if err := p.verifyReceipt(); err != nil {
		return zero, err
	}
	candidate, err := readMacBundle(ctx, filepath.Join(p.Work, "next.app"), true)
	if err != nil {
		return zero, err
	}
	if err := validateMacSigning(p.Current, candidate, buildMode); err != nil {
		return zero, err
	}
	if buildMode == "release" {
		if _, err = runMacUpdateCommand(ctx, 45*time.Second, "/usr/sbin/spctl", "--assess", "--type", "execute", candidate.Path); err != nil {
			return zero, err
		}
	}
	if candidate.Version != p.Installer.Version || candidate.Build.Version != candidate.Version || candidate.Build.Build != p.Installer.Grant.Build || candidate.Build.Mode != buildMode || candidate.Build.Platform != "macos" || candidate.Build.Architecture != architectureName() {
		return zero, errors.New("候选应用版本、构建或架构与receipt不一致")
	}
	comparison, err := compareReleaseVersions(candidate.Version, p.Current.Build.Version)
	if err != nil || comparison < 0 || comparison == 0 && candidate.Build.Build < p.Current.Build.Build {
		return zero, errors.New("候选应用低于原应用已签名版本或构建，拒绝降级")
	}
	if err := validateMacSigning(p.Current, candidate, buildMode); err != nil {
		return zero, err
	}
	return candidate, nil
}

func macBundleSealMatches(actual, expected macBundleInfo) bool {
	return expected.CDHash != "" && actual.CDHash == expected.CDHash && actual.Identifier == expected.Identifier &&
		actual.Version == expected.Version && actual.Team == expected.Team && actual.Adhoc == expected.Adhoc && actual.Build == expected.Build &&
		filepath.Base(actual.Executable) == filepath.Base(expected.Executable)
}

var errMacUpdateCandidateIdentity = errors.New("候选应用已偏离安装镜像确认的副本，已保留更新资料")

func (p *macUpdatePlan) requirePreparedCandidate(actual macBundleInfo) error {
	if p.preparedCandidate.CDHash == "" || actual != p.preparedCandidate {
		return errMacUpdateCandidateIdentity
	}
	return nil
}

func (p *macUpdatePlan) verifyPreparedCandidate(ctx context.Context) (macBundleInfo, error) {
	candidate, err := p.verifyCandidate(ctx)
	if err != nil {
		return macBundleInfo{}, err
	}
	if err := p.requirePreparedCandidate(candidate); err != nil {
		return macBundleInfo{}, err
	}
	return candidate, nil
}
