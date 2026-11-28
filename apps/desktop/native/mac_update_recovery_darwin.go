//go:build darwin

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

type macUpdateTransaction struct {
	Schema           int                  `json:"schema"`
	ID               string               `json:"id"`
	PlanSHA256       string               `json:"planSha256"`
	Current          macBundleInfo        `json:"current"`
	Candidate        macBundleInfo        `json:"candidate"`
	HelperPID        int                  `json:"helperPid"`
	HelperIdentity   string               `json:"helperIdentity"`
	HelperExecutable string               `json:"helperExecutable"`
	Filesystem       *macUpdateFilesystem `json:"filesystem,omitempty"`
}

type macRecoveryAnchor struct {
	cfg    appConfig
	bundle macBundleInfo
	valid  bool
}

type macRecoveryInspection struct {
	Classification       string `json:"classification"`
	Placement            string `json:"placement"`
	PhaseHint            string `json:"phaseHint"`
	HelperState          string `json:"helperState"`
	ReceiptValid         bool   `json:"receiptValid"`
	MutationAuthorized   bool   `json:"mutationAuthorized"`
	RequiresRevalidation bool   `json:"requiresRevalidation"`
	Reason               string `json:"reason"`
}

// A future startup caller must supply its actual os.Executable(), never a path
// obtained from a journal. The inspector deliberately has no mutation authority.
func deriveRecoveryAnchor(ctx context.Context, cfg appConfig, executable string) (macRecoveryAnchor, error) {
	var anchor macRecoveryAnchor
	if err := ctx.Err(); err != nil {
		return anchor, err
	}
	canonical, err := macCanonical(executable)
	if err != nil || canonical != executable || !filepath.IsAbs(executable) {
		return anchor, errors.New("恢复启动程序必须是独立确认的规范路径")
	}
	bundle, err := readMacBundle(ctx, filepath.Dir(filepath.Dir(filepath.Dir(executable))), true)
	if err != nil {
		return anchor, err
	}
	if bundle.Executable != executable || bundle.Build.Mode != buildMode {
		return anchor, errors.New("恢复启动程序与当前应用身份不一致")
	}
	if err = validateMacSigning(bundle, bundle, buildMode); err != nil {
		return anchor, err
	}
	dataDir, err := macCanonical(cfg.DataDir)
	if err != nil || dataDir != cfg.DataDir || macPathInside(bundle.Path, dataDir) {
		return anchor, errors.New("恢复数据目录不能位于应用内或经过符号链接")
	}
	return macRecoveryAnchor{cfg: cfg, bundle: bundle, valid: true}, nil
}

func readMacRecoveryFile(path string) ([]byte, error) {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || stat.Uid != uint32(os.Getuid()) || stat.Nlink != 1 || info.Size() > 2<<20 {
		return nil, errors.New("恢复记录类型、权限、所有者或大小无效")
	}
	data, err := io.ReadAll(io.LimitReader(file, (2<<20)+1))
	if err != nil || len(data) > 2<<20 {
		return nil, errors.New("恢复记录读取失败或过大")
	}
	after, err := os.Lstat(path)
	if err != nil || !os.SameFile(info, after) || info.Size() != after.Size() || !info.ModTime().Equal(after.ModTime()) {
		return nil, errors.New("恢复记录在读取期间发生变化")
	}
	return data, nil
}

func macRecoveryBundleMatches(actual, expected macBundleInfo) bool {
	return actual.Node == expected.Node && macBundleSealMatches(actual, expected)
}

func macRecoveryPersistentBundleMatches(actual, expected macBundleInfo, stable macFilesystemIdentity) bool {
	if stable.FileID == 0 || len(stable.VolumeUUID) != 32 {
		return false
	}
	// Device numbers can change after reboot. The current directory FD remains
	// the live CAS identity; only a volume UUID + file ID can replace the old one.
	expected.Node = actual.Node
	if !macRecoveryBundleMatches(actual, expected) {
		return false
	}
	identity, node, err := readMacFilesystemNode(actual.Path)
	return err == nil && identity == stable && node == actual.Node
}

func validMacRecoveryID(id string) bool {
	if id == "" || len(id) > 128 {
		return false
	}
	for _, char := range id {
		if !(char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || char == '-' || char == '_') {
			return false
		}
	}
	return true
}

func macRecoveryHelperState(ctx context.Context, transaction macUpdateTransaction) string {
	processes, err := unix.SysctlKinfoProcSlice("kern.proc.pid", transaction.HelperPID)
	if err != nil {
		return "unknown"
	}
	if len(processes) == 0 || len(processes) == 1 && processes[0].Proc.P_stat == 5 {
		return "gone"
	}
	identity, err := processIdentity(ctx, transaction.HelperPID)
	if err != nil || identity != transaction.HelperIdentity {
		return "unknown"
	}
	executable, err := processExecutable(ctx, transaction.HelperPID)
	if err != nil || executable != transaction.HelperExecutable {
		return "unknown"
	}
	return "alive"
}

func inspectMacUpdateRecovery(ctx context.Context, anchor macRecoveryAnchor) (macRecoveryInspection, error) {
	result := macRecoveryInspection{Classification: "unavailable", Placement: "unknown", HelperState: "unknown", RequiresRevalidation: true,
		Reason: "仅未持锁的只读快照；journal与摘要一致不构成恢复授权"}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	if !anchor.valid {
		return result, errors.New("恢复检查缺少独立启动锚")
	}
	updater := filepath.Join(anchor.cfg.DataDir, "updater")
	canonical, err := macCanonical(updater)
	if os.IsNotExist(err) {
		result.Classification = "none"
		return result, nil
	}
	if err != nil || canonical != updater {
		return result, errors.New("恢复记录目录不规范")
	}
	journalPath := filepath.Join(updater, "mac-update-journal.json")
	journalRaw, err := readMacRecoveryFile(journalPath)
	if os.IsNotExist(err) {
		result.Classification = "none"
		return result, nil
	}
	if err != nil {
		return result, err
	}
	var journal macUpdateJournal
	if json.Unmarshal(journalRaw, &journal) != nil || journal.Schema != 1 || !validMacRecoveryID(journal.ID) {
		return result, errors.New("恢复记录格式无效")
	}
	work := filepath.Join(filepath.Dir(anchor.bundle.Path), ".chordv-mac-update-"+journal.ID)
	if journal.Target != anchor.bundle.Path || journal.Work != work || macPathInside(work, anchor.cfg.DataDir) {
		return result, errors.New("恢复记录不能选择其他应用或数据目录")
	}
	result.PhaseHint = journal.Phase
	if err = validateMacWork(work); err != nil {
		return result, err
	}
	planPath := filepath.Join(work, macUpdatePlanName)
	planRaw, err := readMacRecoveryFile(planPath)
	if err != nil || macPlanDigest(planRaw) != journal.PlanSHA256 {
		return result, errors.New("恢复计划摘要不匹配")
	}
	var plan macUpdatePlan
	if json.Unmarshal(planRaw, &plan) != nil || plan.Schema != 1 || plan.ID != journal.ID || plan.Work != work || plan.Current.Path != anchor.bundle.Path ||
		plan.DataDir != anchor.cfg.DataDir || plan.Repository != anchor.cfg.ReleaseRepository || plan.PublicKey != anchor.cfg.ReleasePublicKey {
		return result, errors.New("恢复计划与独立启动锚不一致")
	}
	transactionPath := filepath.Join(work, "transaction.json")
	transactionRaw, err := readMacRecoveryFile(transactionPath)
	if os.IsNotExist(err) {
		result.Classification = "missing_transaction"
		return result, nil
	}
	if err != nil || macPlanDigest(transactionRaw) != journal.TransactionSHA256 {
		return result, errors.New("恢复事务摘要不匹配")
	}
	var transaction macUpdateTransaction
	if json.Unmarshal(transactionRaw, &transaction) != nil || transaction.Schema != 1 || transaction.ID != plan.ID || transaction.PlanSHA256 != journal.PlanSHA256 ||
		transaction.Current != plan.Current || transaction.Candidate.Path != filepath.Join(work, "next.app") || transaction.Candidate.CDHash != journal.CandidateCDHash ||
		transaction.HelperPID <= 1 || transaction.HelperIdentity == "" || transaction.HelperExecutable != plan.helperExecutable() {
		return result, errors.New("恢复事务身份不一致")
	}
	service := newDesktopService(anchor.cfg)
	defer service.cancel()
	grant := plan.Installer.Grant
	if err = service.verifyGrantReceipt(grant); err != nil {
		return result, err
	}
	if filepath.Base(grant.FileName) != grant.FileName || !strings.EqualFold(filepath.Ext(grant.FileName), ".dmg") || grant.Component != "" ||
		plan.Installer.Path != filepath.Join(updater, grant.FileName) || plan.Installer.Version != grant.Version ||
		plan.Installer.SHA256 != grant.SHA256 || plan.Installer.Size != grant.Size || transaction.Candidate.Version != grant.Version ||
		transaction.Candidate.Build.Version != grant.Version || transaction.Candidate.Build.Build != grant.Build || transaction.Candidate.Build.Mode != buildMode ||
		transaction.Candidate.Build.Platform != "macos" || transaction.Candidate.Build.Architecture != architectureName() {
		return result, errors.New("恢复候选与发布receipt不一致")
	}
	if comparison, err := compareReleaseVersions(transaction.Candidate.Version, transaction.Current.Build.Version); err != nil || comparison < 0 ||
		comparison == 0 && transaction.Candidate.Build.Build < transaction.Current.Build.Build {
		return result, errors.New("恢复记录不能授权降级安装")
	}
	result.ReceiptValid = true
	if transaction.Filesystem != nil {
		for _, item := range []struct {
			path     string
			identity macFilesystemIdentity
		}{{work, transaction.Filesystem.Work}, {filepath.Dir(anchor.bundle.Path), transaction.Filesystem.Parent}} {
			actual, _, err := readMacFilesystemNode(item.path)
			if err != nil || actual != item.identity {
				return result, errors.New("恢复工作目录或父目录持久身份已改变")
			}
		}
		for _, identity := range []macFilesystemIdentity{transaction.Filesystem.Current, transaction.Filesystem.Candidate, transaction.Filesystem.Work} {
			if identity.FileID == 0 || identity.VolumeUUID != transaction.Filesystem.Parent.VolumeUUID {
				return result, errors.New("恢复应用持久卷身份不一致")
			}
		}
	}
	target, err := readMacBundle(ctx, anchor.bundle.Path, true)
	if err != nil {
		return result, err
	}
	if !macRecoveryBundleMatches(target, anchor.bundle) {
		return result, errors.New("启动锚所对应的应用已经变化")
	}
	if _, err := os.Lstat(filepath.Join(work, "next.app")); os.IsNotExist(err) {
		result.Classification = "backup_or_candidate_missing"
		return result, nil
	}
	staged, err := readMacBundle(ctx, filepath.Join(work, "next.app"), true)
	if err != nil {
		return result, err
	}
	if err = validateMacSigning(target, staged, buildMode); err != nil {
		return result, err
	}
	var original macBundleInfo
	matchCurrent := func(actual macBundleInfo) bool {
		if transaction.Filesystem != nil {
			return macRecoveryPersistentBundleMatches(actual, transaction.Current, transaction.Filesystem.Current)
		}
		return macRecoveryBundleMatches(actual, transaction.Current)
	}
	matchCandidate := func(actual macBundleInfo) bool {
		if transaction.Filesystem != nil {
			return macRecoveryPersistentBundleMatches(actual, transaction.Candidate, transaction.Filesystem.Candidate)
		}
		return macRecoveryBundleMatches(actual, transaction.Candidate)
	}
	switch {
	case matchCurrent(target) && matchCandidate(staged):
		result.Placement, original = "original_staged", target
	case matchCandidate(target) && matchCurrent(staged):
		result.Placement, original = "candidate_installed", staged
	default:
		result.Classification = "conflict"
		return result, nil
	}
	originalHash, err := fileSHA256(original.Executable)
	if err != nil || originalHash != plan.HelperSHA256 {
		return result, errors.New("恢复助手摘要没有关联到已验证原应用")
	}
	if plan.HelperBundle != nil {
		if err = plan.verifyHelperBundle(ctx); err != nil {
			return result, err
		}
	} else {
		helperInfo, err := os.Lstat(transaction.HelperExecutable)
		if err != nil || !helperInfo.Mode().IsRegular() || helperInfo.Mode().Perm() != 0700 {
			return result, errors.New("恢复助手必须是工作目录中的独立普通程序文件")
		}
		helperStat, ok := helperInfo.Sys().(*syscall.Stat_t)
		if !ok || helperStat.Uid != uint32(os.Getuid()) || helperStat.Nlink != 1 {
			return result, errors.New("恢复助手所有者或链接数无效")
		}
		if err = verifyFile(transaction.HelperExecutable, originalHash, 0); err != nil {
			return result, err
		}
	}
	for path, expected := range map[string][]byte{journalPath: journalRaw, planPath: planRaw, transactionPath: transactionRaw} {
		actual, err := readMacRecoveryFile(path)
		if err != nil || !bytes.Equal(actual, expected) {
			return result, errors.New("恢复检查期间记录已改变，必须重新验证")
		}
	}
	result.HelperState = macRecoveryHelperState(ctx, transaction)
	if err := ctx.Err(); err != nil {
		return result, err
	}
	result.Classification = result.Placement
	if result.HelperState != "gone" {
		result.Classification = "deferred"
	}
	return result, nil
}
