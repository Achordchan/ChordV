package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

type observedInstallerContext struct {
	context.Context
	checked chan struct{}
	once    sync.Once
}

func (c *observedInstallerContext) Err() error {
	err := c.Context.Err()
	c.once.Do(func() { close(c.checked) })
	return err
}

func TestInstallerHandoffCancellationWhileWaitingForOperationLockDoesNotDisconnect(t *testing.T) {
	s, p := installerHandoffFixture(t, "http://127.0.0.1:1")
	s.runtime.Status = "connected"
	rootContext := s.ctx
	base, cancel := context.WithCancel(context.Background())
	defer cancel()
	ctx := &observedInstallerContext{Context: base, checked: make(chan struct{})}
	disconnects, starts, quits := 0, 0, 0
	s.emit = func(event NativeEvent) {
		if event.Name == "chordv://runtime-status" {
			disconnects++
		}
	}
	s.operationMu.Lock()
	done := make(chan error, 1)
	go func() {
		_, err := s.handoffInstaller(ctx, p, installerHandoffOps{start: func(string) error { starts++; return nil }, quit: func() { quits++ }})
		done <- err
	}()
	select {
	case <-ctx.checked:
	case <-time.After(3 * time.Second):
		s.operationMu.Unlock()
		t.Fatal("安装请求未完成入口上下文检查")
	}
	cancel()
	s.operationMu.Unlock()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) || disconnects != 0 || starts != 0 || quits != 0 || s.runtime.Status != "connected" || installerIsReserved(s) || s.ctx != rootContext || s.ctx.Err() != nil {
			t.Fatalf("锁等待取消后仍产生交接副作用: err=%v disconnects=%d starts=%d quits=%d status=%s reserved=%t", err, disconnects, starts, quits, s.runtime.Status, installerIsReserved(s))
		}
	case <-time.After(3 * time.Second):
		t.Fatal("取消的安装请求未结束")
	}
}

func TestOpenInstallerDispatchesWindowsBeforeDisconnect(t *testing.T) {
	source, err := os.ReadFile("installer.go")
	if err != nil {
		t.Fatal(err)
	}
	start := strings.Index(string(source), "func (s *DesktopService) openInstaller(")
	end := strings.Index(string(source), "func (s *DesktopService) installWindowsUpdate(")
	if start < 0 || end <= start {
		t.Fatal("未找到安装入口")
	}
	wrapper := string(source[start:end])
	dispatch, cleanup := strings.Index(wrapper, `if runtime.GOOS == "windows"`), strings.Index(wrapper, "s.disconnect()")
	if dispatch < 0 || cleanup < 0 || dispatch >= cleanup || !strings.Contains(wrapper[dispatch:cleanup], "return s.installWindowsUpdate(ctx)") {
		t.Fatal("Windows入口必须先进入共享安装交接的上下文/预占门禁，不得预先断开连接")
	}
}

func TestWindowsInstallWrapperRejectsOtherPlatformsWithoutDisconnect(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("仅验证非Windows平台门禁，不启动安装器")
	}
	s, _ := installerHandoffFixture(t, "http://127.0.0.1:1")
	s.runtime.Status = "connected"
	if _, err := s.installWindowsUpdate(context.Background()); err == nil || s.runtime.Status != "connected" || installerIsReserved(s) || s.ctx.Err() != nil {
		t.Fatal("非Windows平台应保持连接和服务生命周期不变", err)
	}
}

func installerHandoffFixture(t *testing.T, base string) (*DesktopService, *pendingInstaller) {
	t.Helper()
	s := testService(t, base)
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s.cfg.ReleaseRepository = "test-only/handoff"
	s.cfg.ReleasePublicKey = base64.StdEncoding.EncodeToString(public)
	data := []byte("test-only installer bytes; never executable")
	name := "test-only-installer.exe"
	if runtime.GOOS == "darwin" {
		name = "test-only-installer.dmg"
	}
	asset := releaseAsset{Platform: platformName(), Architecture: architectureName(), FileName: name, SHA256: testHash(data), SizeBytes: int64(len(data))}
	manifest := releaseManifest{SchemaVersion: 1, Tag: "v2.0.0", Version: "2.0.0", Channel: "stable", Build: 2, Installers: []releaseAsset{asset}}
	body, _ := json.Marshal(manifest)
	input, _ := json.Marshal(map[string]string{"manifest": string(body), "tag": manifest.Tag, "signature": base64.StdEncoding.EncodeToString(ed25519.Sign(private, body))})
	if _, err = s.authorizeReleaseManifest(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	grant, err := s.authorizedDownload("https://github.com/test-only/handoff/releases/download/v2.0.0/"+asset.FileName, asset.SHA256, asset.SizeBytes)
	if err != nil {
		t.Fatal(err)
	}
	p := &pendingInstaller{Path: filepath.Join(s.cfg.DataDir, "updater", asset.FileName), SHA256: asset.SHA256, Size: asset.SizeBytes, Version: manifest.Version, Grant: grant}
	if err = os.MkdirAll(filepath.Dir(p.Path), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(p.Path, data, 0600); err != nil {
		t.Fatal(err)
	}
	s.pending = p
	return s, p
}

func installerIsReserved(s *DesktopService) bool {
	s.operationMu.Lock()
	defer s.operationMu.Unlock()
	return s.installing
}

func TestInstallerHandoffStartFailureKeepsServiceRetryable(t *testing.T) {
	s, p := installerHandoffFixture(t, "http://127.0.0.1:1")
	launchErr := errors.New("test-only launch failure")
	ops := installerHandoffOps{
		start: func(path string) error {
			if path != p.Path || !installerIsReserved(s) || s.runtime.Status != "idle" {
				t.Fatal("安装前未完成验证、预占和断开")
			}
			return launchErr
		},
		quit:        func() { t.Fatal("启动失败不应退出") },
		writeReport: func(string, any) error { t.Fatal("启动失败不应写成功报告"); return nil },
	}
	if _, err := s.handoffInstaller(context.Background(), p, ops); !errors.Is(err, launchErr) {
		t.Fatal("未保留启动失败", err)
	}
	if s.ctx.Err() != nil || installerIsReserved(s) {
		t.Fatal("启动失败永久关闭服务或未释放安装预占", s.ctx.Err())
	}
	if _, err := s.validatedInstaller(p.Path); err != nil {
		t.Fatal("启动失败丢失了可重试安装包", err)
	}
	var order []string
	s.emit = func(event NativeEvent) {
		if event.Name == "chordv://runtime-status" {
			order = append(order, "disconnect")
		}
	}
	result, err := s.handoffInstaller(context.Background(), p, installerHandoffOps{
		start: func(string) error { order = append(order, "start"); return nil },
		writeReport: func(path string, report any) error {
			order = append(order, "report")
			return atomicJSON(path, report)
		},
		quit: func() { order = append(order, "quit") },
	})
	if err != nil || result.(map[string]bool)["ok"] != true || strings.Join(order, ",") != "disconnect,start,report,quit" || !installerIsReserved(s) {
		t.Fatal("重试未按唯一交接顺序完成", order, err)
	}
	report, err := s.consumeInstallReport()
	if err != nil || report.(map[string]any)["summary"] != "安装程序已启动" {
		t.Fatal("启动报告内容错误", report, err)
	}
}

func TestInstallerHandoffReportFailureStillQuits(t *testing.T) {
	s, p := installerHandoffFixture(t, "http://127.0.0.1:1")
	var order []string
	diagnostic := false
	s.emit = func(event NativeEvent) {
		if event.Name == "chordv://update-install-report-failed" {
			diagnostic = true
		}
	}
	result, err := s.handoffInstaller(context.Background(), p, installerHandoffOps{
		start: func(string) error { order = append(order, "start"); return nil },
		writeReport: func(string, any) error {
			order = append(order, "report")
			return errors.New("test-only write failure")
		},
		quit: func() { order = append(order, "quit") },
	})
	if err != nil || result == nil || result.(map[string]bool)["ok"] != true || strings.Join(order, ",") != "start,report,quit" || !diagnostic || !installerIsReserved(s) {
		t.Fatal("启动后的报告失败阻断退出或误报未启动", order, diagnostic, err)
	}
}

func TestInstallerHandoffActualReportWriteFailureStillQuits(t *testing.T) {
	s, p := installerHandoffFixture(t, "http://127.0.0.1:1")
	path := filepath.Join(s.cfg.DataDir, "updater", "install-report.json")
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	quit := 0
	result, err := s.handoffInstaller(context.Background(), p, installerHandoffOps{
		start: func(string) error { return nil },
		quit:  func() { quit++ },
	})
	if err != nil || result == nil || quit != 1 || !installerIsReserved(s) {
		t.Fatal("真实文件系统报告写入失败阻断退出", quit, err)
	}
	if info, err := os.Stat(path); err != nil || !info.IsDir() {
		t.Fatal("错误时破坏了原报告路径证据", err)
	}
}

func TestInstallerHandoffRejectsMissingCallbacksBeforeCleanup(t *testing.T) {
	for _, missing := range []string{"start", "quit"} {
		t.Run(missing, func(t *testing.T) {
			s, p := installerHandoffFixture(t, "http://127.0.0.1:1")
			s.runtime.Status = "connected"
			ops := installerHandoffOps{start: func(string) error { t.Fatal("参数缺失仍启动"); return nil }, quit: func() { t.Fatal("参数缺失仍退出") }}
			if missing == "start" {
				ops.start = nil
			} else {
				ops.quit = nil
			}
			if _, err := s.handoffInstaller(context.Background(), p, ops); err == nil || s.runtime.Status != "connected" || s.ctx.Err() != nil || installerIsReserved(s) {
				t.Fatal("缺失回调未在清理前拒绝", err)
			}
		})
	}
}

func TestInstallerHandoffRevalidatesReceiptAndFile(t *testing.T) {
	for _, changed := range []string{"receipt", "file"} {
		t.Run(changed, func(t *testing.T) {
			s, p := installerHandoffFixture(t, "http://127.0.0.1:1")
			s.runtime.Status = "connected"
			if changed == "receipt" {
				s.pending.Grant.Signature = "invalid-signature"
			} else if err := os.WriteFile(p.Path, []byte("changed"), 0600); err != nil {
				t.Fatal(err)
			}
			ops := installerHandoffOps{start: func(string) error { t.Fatal("未拒绝失效授权或文件"); return nil }, quit: func() { t.Fatal("验证失败仍退出") }}
			if _, err := s.handoffInstaller(context.Background(), p, ops); err == nil || s.runtime.Status != "connected" || s.ctx.Err() != nil || installerIsReserved(s) {
				t.Fatal("安装前验证失败改变服务生命周期", err)
			}
		})
	}
}

func TestInstallerHandoffCleanupFailureDoesNotLaunch(t *testing.T) {
	s, p := installerHandoffFixture(t, "http://127.0.0.1:1")
	before := proxySetting{Service: "test-only", Kind: "web", Values: map[string]string{"enabled": "No"}}
	owned := testDesiredProxy(before, 10809, 10808)
	testProxySettings(t, []proxySetting{owned})
	if err := atomicJSON(proxyJournalPath(s.cfg.DataDir), proxyJournal{Version: 1, Changes: []proxyChange{{Before: before, Owned: owned}}}); err != nil {
		t.Fatal(err)
	}
	writeProxySetting = func(context.Context, proxySetting) error { return errors.New("test-only restore failure") }
	ops := installerHandoffOps{start: func(string) error { t.Fatal("恢复失败仍启动安装器"); return nil }, quit: func() { t.Fatal("恢复失败仍退出") }}
	if _, err := s.handoffInstaller(context.Background(), p, ops); err == nil || s.ctx.Err() != nil || installerIsReserved(s) {
		t.Fatal("清理失败取消服务或未释放预占", err)
	}
	if _, err := os.Stat(proxyJournalPath(s.cfg.DataDir)); err != nil {
		t.Fatal("清理失败丢失恢复凭据", err)
	}
}

func TestInstallerHandoffHonorsCancellationBeforeStart(t *testing.T) {
	for _, point := range []string{"before", "after-disconnect"} {
		t.Run(point, func(t *testing.T) {
			s, p := installerHandoffFixture(t, "http://127.0.0.1:1")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if point == "before" {
				cancel()
			} else {
				s.emit = func(event NativeEvent) {
					if event.Name == "chordv://runtime-status" {
						cancel()
					}
				}
			}
			ops := installerHandoffOps{start: func(string) error { t.Fatal("请求取消后仍启动"); return nil }, quit: func() { t.Fatal("请求取消后仍退出") }}
			if _, err := s.handoffInstaller(ctx, p, ops); !errors.Is(err, context.Canceled) || s.ctx.Err() != nil || installerIsReserved(s) {
				t.Fatal("请求取消污染了服务根生命周期", err)
			}
		})
	}
}

func TestInstallerHandoffSerializesConcurrentAttempts(t *testing.T) {
	s, p := installerHandoffFixture(t, "http://127.0.0.1:1")
	entered, release := make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	defer unblock()
	launchErr := errors.New("test-only delayed start failure")
	go func() {
		_, err := s.handoffInstaller(context.Background(), p, installerHandoffOps{start: func(string) error { close(entered); <-release; return launchErr }, quit: func() {}})
		done <- err
	}()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("首次安装未进入启动阶段")
	}
	_, err := s.handoffInstaller(context.Background(), p, installerHandoffOps{start: func(string) error { t.Fatal("重复安装启动了第二个进程"); return nil }, quit: func() {}})
	if err == nil || !installerIsReserved(s) {
		t.Fatal("未拒绝重复安装", err)
	}
	if _, err := s.connect(context.Background(), runtimeConfig{}, false); err == nil || !strings.Contains(err.Error(), "交接") {
		t.Fatal("安装交接中允许重连或未经过原生门禁", err)
	}
	unblock()
	select {
	case err = <-done:
		if !errors.Is(err, launchErr) || installerIsReserved(s) {
			t.Fatal("失败安装未释放预占", err)
		}
		if _, err := s.connect(context.Background(), runtimeConfig{}, false); err == nil || strings.Contains(err.Error(), "交接") {
			t.Fatal("启动失败后仍阻止普通连接校验", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("首次安装未结束")
	}
}
