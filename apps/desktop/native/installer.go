package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/mail"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"unicode"
	"unicode/utf8"
)

type pendingInstaller struct {
	Path    string            `json:"path"`
	SHA256  string            `json:"sha256"`
	Size    int64             `json:"size"`
	Version string            `json:"version"`
	Grant   releaseAssetGrant `json:"grant"`
}

func (s *DesktopService) downloadInstaller(ctx context.Context, raw json.RawMessage) (result any, err error) {
	var input struct {
		URL               string `json:"url"`
		SHA256            string `json:"sha256"`
		FileSizeBytes     int64  `json:"fileSizeBytes"`
		FileName          string `json:"fileName"`
		ExpectedVersion   string `json:"expectedVersion"`
		MinBytesPerSecond int64  `json:"minBytesPerSecond"`
	}
	if err = decode(raw, &input); err != nil {
		return nil, err
	}
	if input.FileName == "" || filepath.Base(input.FileName) != input.FileName || strings.ContainsAny(input.FileName, "\\/:") {
		return nil, errors.New("安装包名称无效")
	}
	ext := strings.ToLower(filepath.Ext(input.FileName))
	if (runtime.GOOS == "windows" && ext != ".exe") || (runtime.GOOS == "darwin" && ext != ".dmg") {
		return nil, errors.New("安装包类型与当前平台不一致")
	}
	grant, err := s.authorizedDownload(input.URL, input.SHA256, input.FileSizeBytes)
	if err != nil {
		return nil, err
	}
	if grant.Component != "" || grant.FileName != input.FileName {
		return nil, errors.New("安装包与已授权发布清单不一致")
	}
	if input.ExpectedVersion != "" && input.ExpectedVersion != grant.Version {
		return nil, errors.New("预期安装版本与发布授权不一致")
	}
	ctx, finish, err := s.beginDownload(ctx)
	if err != nil {
		return nil, err
	}
	defer finish()
	path := filepath.Join(s.cfg.DataDir, "updater", input.FileName)
	event := downloadProgress{Phase: "preparing", FileName: &input.FileName, TotalBytes: &input.FileSizeBytes}
	emit := func() { s.publish("chordv://update-download-progress", event) }
	emit()
	defer func() {
		if err != nil {
			event.Phase = "failed"
			event.Message = pointer(err.Error())
			emit()
		}
	}()
	event.Phase = "downloading"
	if err = downloadVerified(ctx, input.URL, path, input.SHA256, input.FileSizeBytes, input.MinBytesPerSecond, func(n int64, total *int64) { event.DownloadedBytes = n; event.TotalBytes = total; emit() }); err != nil {
		return nil, err
	}
	event.Phase = "verifying"
	emit()
	pending := &pendingInstaller{Path: path, SHA256: strings.ToLower(input.SHA256), Size: input.FileSizeBytes, Version: grant.Version, Grant: grant}
	s.pendingMu.Lock()
	err = atomicJSON(filepath.Join(s.cfg.DataDir, "updater", "pending.json"), pending)
	if err == nil {
		s.pending = pending
	}
	s.pendingMu.Unlock()
	if err != nil {
		return nil, err
	}
	event.Phase = "completed"
	event.LocalPath = &path
	emit()
	return map[string]any{"fileName": input.FileName, "localPath": path, "totalBytes": input.FileSizeBytes}, nil
}

func (s *DesktopService) validatedInstaller(requested string) (*pendingInstaller, error) {
	s.pendingMu.Lock()
	defer s.pendingMu.Unlock()
	pending := s.pending
	if pending == nil {
		data, err := os.ReadFile(filepath.Join(s.cfg.DataDir, "updater", "pending.json"))
		if err != nil {
			return nil, errors.New("没有已校验的安装包")
		}
		pending = new(pendingInstaller)
		if json.Unmarshal(data, pending) != nil {
			return nil, errors.New("安装包记录无效")
		}
	}
	p := *pending
	if err := s.verifyGrantReceipt(p.Grant); err != nil {
		return nil, err
	}
	if p.SHA256 != p.Grant.SHA256 || p.Size != p.Grant.Size || p.Version != p.Grant.Version || filepath.Base(p.Path) != p.Grant.FileName {
		return nil, errors.New("安装包记录与发布授权不一致")
	}
	root := filepath.Join(s.cfg.DataDir, "updater")
	if filepath.Dir(p.Path) != root || (requested != "" && filepath.Clean(requested) != p.Path) {
		return nil, errors.New("安装包不在应用更新目录内")
	}
	resolved, err := filepath.EvalSymlinks(p.Path)
	if err != nil {
		return nil, err
	}
	canonicalRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	if filepath.Dir(resolved) != canonicalRoot {
		return nil, errors.New("安装包真实路径无效")
	}
	if err := verifyFile(p.Path, p.SHA256, p.Size); err != nil {
		return nil, err
	}
	s.pending = pending
	return &p, nil
}
func (s *DesktopService) openInstaller(ctx context.Context, path string) (any, error) {
	if runtime.GOOS == "darwin" {
		return s.prepareMacUpdate(ctx, path)
	}
	p, err := s.validatedInstaller(path)
	if err != nil {
		return nil, err
	}
	if runtime.GOOS == "windows" {
		return s.installWindowsUpdate(ctx)
	}
	if _, err = s.disconnect(); err != nil {
		return nil, err
	}
	_, err = commandOutput(ctx, "xdg-open", p.Path)
	return map[string]bool{"ok": err == nil}, err
}
func (s *DesktopService) installWindowsUpdate(ctx context.Context) (any, error) {
	if runtime.GOOS != "windows" {
		return nil, errors.New("此安装操作仅适用于 Windows")
	}
	p, err := s.validatedInstaller("")
	if err != nil {
		return nil, err
	}
	var quit func()
	if s.shell != nil {
		quit = s.shell.quit
	}
	return s.handoffInstaller(ctx, p, installerHandoffOps{start: startWindowsInstaller, quit: quit, writeReport: atomicJSON, platform: "windows", mode: "installer", summary: "安装程序已启动"})
}

func (s *DesktopService) installPreparedMacUpdate(ctx context.Context) (result any, err error) {
	defer func() {
		if err != nil {
			err = errors.Join(err, s.abortMacUpdate())
		}
	}()
	var quit func()
	if s.shell != nil {
		quit = s.shell.quit
	}
	p, err := s.validatedInstaller("")
	if err != nil {
		return nil, err
	}
	return s.handoffInstaller(ctx, p, installerHandoffOps{
		start: func(string) error { _, err := s.commitMacUpdate(ctx); return err },
		quit:  quit, writeReport: atomicJSON, platform: "macos", mode: "replace", summary: "更新替换已交接",
	})
}
func (s *DesktopService) localPaths() map[string]string {
	return map[string]string{"appData": s.cfg.DataDir, "xray": filepath.Join(s.binDir(), xrayFileName()), "geoip": filepath.Join(s.binDir(), "geoip.dat"), "geosite": filepath.Join(s.binDir(), "geosite.dat"), "runtime": filepath.Join(s.cfg.DataDir, "runtime"), "updater": filepath.Join(s.cfg.DataDir, "updater")}
}
func (s *DesktopService) listLocalFiles() []map[string]any {
	paths := s.localPaths()
	entries := make([]map[string]any, 0, len(paths))
	for _, kind := range []string{"appData", "xray", "geoip", "geosite", "runtime", "updater"} {
		path := paths[kind]
		isDir := kind == "appData" || kind == "runtime" || kind == "updater"
		entry := map[string]any{"kind": kind, "path": path, "isDirectory": isDir, "exists": false, "sizeBytes": nil}
		if info, err := os.Stat(path); err == nil {
			entry["exists"] = info.IsDir() == isDir
			if !info.IsDir() {
				entry["sizeBytes"] = info.Size()
			}
		}
		entries = append(entries, entry)
	}
	return entries
}
func (s *DesktopService) revealLocalFile(ctx context.Context, kind string) error {
	path, exists := s.localPaths()[kind]
	if !exists {
		return errors.New("未知本地文件位置")
	}
	for {
		if _, err := os.Stat(path); err == nil {
			break
		}
		parent := filepath.Dir(path)
		if parent == path {
			return errors.New("本地目录尚未创建")
		}
		path = parent
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return err
	}
	root, err := filepath.EvalSymlinks(s.cfg.DataDir)
	if err != nil {
		return err
	}
	rel, err := filepath.Rel(root, resolved)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return errors.New("只能打开应用数据目录内的位置")
	}
	switch runtime.GOOS {
	case "darwin":
		_, err = commandOutput(ctx, "/usr/bin/open", "-R", resolved)
	case "windows":
		_, err = commandOutput(ctx, "explorer.exe", "/select,"+resolved)
	default:
		info, _ := os.Stat(resolved)
		if info != nil && !info.IsDir() {
			resolved = filepath.Dir(resolved)
		}
		_, err = commandOutput(ctx, "xdg-open", resolved)
	}
	return err
}

var externalURLCommandOutput = commandOutput

func validateExternalURL(address string) error {
	invalid := errors.New("仅支持有效的 HTTP、HTTPS 或单个收件人的邮件地址")
	if len(address) > 16*1024 || strings.IndexFunc(address, unicode.IsControl) >= 0 {
		return invalid
	}
	u, err := url.Parse(address)
	if err != nil {
		return invalid
	}
	switch u.Scheme {
	case "http", "https":
		if u.Host == "" || !externalURLTextAllowed(address, false) {
			return invalid
		}
	case "mailto":
		if u.Host != "" || u.User != nil || u.Path != "" || u.Opaque == "" || strings.Contains(address, "#") {
			return invalid
		}
		recipient, err := url.PathUnescape(u.Opaque)
		if err != nil || !externalURLTextAllowed(recipient, false) {
			return invalid
		}
		mailbox, err := mail.ParseAddress(recipient)
		if err != nil || mailbox.Name != "" || mailbox.Address != recipient {
			return invalid
		}
		query, err := url.ParseQuery(u.RawQuery)
		if err != nil {
			return invalid
		}
		for key, values := range query {
			if (key != "subject" && key != "body") || len(values) != 1 || !externalURLTextAllowed(values[0], key == "body") {
				return invalid
			}
		}
	default:
		return invalid
	}
	return nil
}

func externalURLTextAllowed(value string, allowLineFeed bool) bool {
	for {
		if !utf8.ValidString(value) {
			return false
		}
		for _, character := range value {
			if unicode.IsControl(character) && !(allowLineFeed && character == '\n') {
				return false
			}
		}
		// 同时拒绝多层编码的头注入；正文仅保留帮助模板使用的LF换行。
		decoded, err := url.PathUnescape(value)
		if err != nil || decoded == value {
			return true
		}
		value = decoded
	}
}

func openExternalURL(ctx context.Context, address string) error {
	if err := validateExternalURL(address); err != nil {
		return err
	}
	var err error
	switch runtime.GOOS {
	case "darwin":
		_, err = externalURLCommandOutput(ctx, "/usr/bin/open", address)
	case "windows":
		_, err = externalURLCommandOutput(ctx, "rundll32.exe", "url.dll,FileProtocolHandler", address)
	default:
		_, err = externalURLCommandOutput(ctx, "xdg-open", address)
	}
	return err
}
