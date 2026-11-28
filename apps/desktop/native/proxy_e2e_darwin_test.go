//go:build e2e && darwin

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func e2eProxyFixture(t *testing.T) (string, appConfig, e2eProxyDocument) {
	t.Helper()
	temporary, err := filepath.EvalSymlinks(os.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	root, err := os.MkdirTemp(temporary, "chordv-support-e2e-proxy-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	dir := filepath.Join(root, ".data", "mygo", "desktop")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	document := e2eProxyDocument{Schema: 1, TestOnly: true, Settings: []proxySetting{{Service: e2eProxyService, Kind: "windows", Values: map[string]string{"ProxyEnable": "0", "ProxyServer": "", "ProxyOverride": "<local>", "AutoConfigURL": "", "AutoDetect": "0"}}}}
	state := filepath.Join(dir, e2eProxyStateName)
	writeE2EProxyDocument(t, state, document)
	return state, appConfig{DataDir: dir, APIBase: "http://127.0.0.1:1"}, document
}

func writeE2EProxyDocument(t *testing.T, state string, document e2eProxyDocument) {
	t.Helper()
	data, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(state, data, 0600); err != nil {
		t.Fatal(err)
	}
}

func e2eProxyChildEnvironment(state, dataDir, api string) []string {
	env := []string{}
	for _, value := range os.Environ() {
		if !strings.HasPrefix(value, "CHORDV_") && !strings.HasPrefix(value, "MYGO_") {
			env = append(env, value)
		}
	}
	return append(env, "CHORDV_E2E_PROXY_CHILD=1", "CHORDV_E2E_PROXY_STATE="+state, "CHORDV_MYGO_DATA_DIR="+dataDir, "CHORDV_API_BASE_URL="+api)
}

func TestE2EProxyInvalidEnvironmentFailsBeforeEntry(t *testing.T) {
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(binary, "-test.run=^TestE2EProxyEntrySentinel$")
	cmd.Env = e2eProxyChildEnvironment(filepath.Join(t.TempDir(), "not-qa-state.json"), t.TempDir(), "http://127.0.0.1:1")
	output, err := cmd.CombinedOutput()
	if err == nil || strings.Contains(string(output), "E2E_PROXY_ENTRY_REACHED") || !strings.Contains(string(output), "E2E文件代理配置无效，启动已停止") {
		t.Fatalf("invalid explicit profile continued to entry instead of failing closed: err=%v output=%s", err, output)
	}
}

func TestE2EProxyEntrySentinel(t *testing.T) {
	mode := os.Getenv("CHORDV_E2E_PROXY_CHILD")
	if mode == "" {
		return
	}
	production := reflect.ValueOf(readProxySettings).Pointer() == reflect.ValueOf(platformReadProxy).Pointer()
	if mode == "disabled" {
		if !production {
			t.Fatal("unset profile replaced production functions")
		}
	} else {
		if production {
			t.Fatal("explicit profile fell back to OS reader")
		}
		settings, err := readProxySettings(context.Background())
		if err != nil || len(settings) != 1 || settings[0].Service != e2eProxyService {
			t.Fatalf("wrong file reader: %v %v", settings, err)
		}
	}
	fmt.Println("E2E_PROXY_ENTRY_REACHED")
}

func TestE2EProxyExplicitStartupAndAbsentOptIn(t *testing.T) {
	state, cfg, _ := e2eProxyFixture(t)
	binary, _ := os.Executable()
	for _, enabled := range []bool{true, false} {
		cmd := exec.Command(binary, "-test.run=^TestE2EProxyEntrySentinel$")
		cmd.Env = e2eProxyChildEnvironment(state, cfg.DataDir, cfg.APIBase)
		if !enabled {
			env := []string{}
			for _, value := range cmd.Env {
				if !strings.HasPrefix(value, "CHORDV_E2E_PROXY_STATE=") && !strings.HasPrefix(value, "CHORDV_E2E_PROXY_CHILD=") {
					env = append(env, value)
				}
			}
			cmd.Env = append(env, "CHORDV_E2E_PROXY_CHILD=disabled")
		}
		if output, err := cmd.CombinedOutput(); err != nil || !strings.Contains(string(output), "E2E_PROXY_ENTRY_REACHED") {
			t.Fatalf("startup enabled=%v: %v %s", enabled, err, output)
		}
	}
}

func TestE2EProxyRejectsUnsafeProfile(t *testing.T) {
	for _, scenario := range []string{"release", "remote-api", "named-api", "data-dir-mismatch", "wrong-name", "relative", "bad-mode", "symlink-file", "hardlink-file", "symlink-directory", "schema", "test-only", "service", "kind", "extra-setting", "missing-value", "malformed", "trailing", "unknown-field", "large", "fifo"} {
		t.Run(scenario, func(t *testing.T) {
			state, cfg, document := e2eProxyFixture(t)
			mode := "local"
			switch scenario {
			case "release":
				mode = "release"
			case "remote-api":
				cfg.APIBase = "http://198.51.100.1:1"
			case "named-api":
				cfg.APIBase = "http://localhost:1"
			case "data-dir-mismatch":
				cfg.DataDir = t.TempDir()
			case "wrong-name":
				state = filepath.Join(cfg.DataDir, "other.json")
			case "relative":
				state = "qa-proxy-state.json"
			case "bad-mode":
				os.Chmod(state, 0644)
			case "symlink-file":
				target := filepath.Join(t.TempDir(), "outside.json")
				writeE2EProxyDocument(t, target, document)
				os.Remove(state)
				if err := os.Symlink(target, state); err != nil {
					t.Fatal(err)
				}
			case "hardlink-file":
				if err := os.Link(state, filepath.Join(t.TempDir(), "linked.json")); err != nil {
					t.Fatal(err)
				}
			case "symlink-directory":
				original := cfg.DataDir + "-original"
				if err := os.Rename(cfg.DataDir, original); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(original, cfg.DataDir); err != nil {
					t.Fatal(err)
				}
			case "schema":
				document.Schema = 2
				writeE2EProxyDocument(t, state, document)
			case "test-only":
				document.TestOnly = false
				writeE2EProxyDocument(t, state, document)
			case "service":
				document.Settings[0].Service = "real-os-service"
				writeE2EProxyDocument(t, state, document)
			case "kind":
				document.Settings[0].Kind = "macos"
				writeE2EProxyDocument(t, state, document)
			case "extra-setting":
				document.Settings = append(document.Settings, document.Settings[0])
				writeE2EProxyDocument(t, state, document)
			case "missing-value":
				delete(document.Settings[0].Values, "ProxyServer")
				writeE2EProxyDocument(t, state, document)
			case "malformed":
				os.WriteFile(state, []byte("{"), 0600)
			case "trailing":
				data, _ := os.ReadFile(state)
				os.WriteFile(state, append(data, []byte(" {}")...), 0600)
			case "unknown-field":
				os.WriteFile(state, []byte(`{"schema":1,"testOnly":true,"unknown":true,"settings":[]}`), 0600)
			case "large":
				os.WriteFile(state, []byte(strings.Repeat(" ", 65537)), 0600)
			case "fifo":
				os.Remove(state)
				if err := unix.Mkfifo(state, 0600); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := newE2EFileProxy(state, cfg, mode); err == nil {
				t.Fatal("unsafe profile accepted")
			}
		})
	}
}

func TestE2EProxyCASChangesOnlyDedicatedJSON(t *testing.T) {
	state, cfg, document := e2eProxyFixture(t)
	sentinel := filepath.Join(cfg.DataDir, "untouched.txt")
	if err := os.WriteFile(sentinel, []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	adapter, err := newE2EFileProxy(state, cfg, "local")
	if err != nil {
		t.Fatal(err)
	}
	before := document.Settings[0]
	owned, err := desiredProxy(before, 41001, 41002)
	if err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(state)
	if err := adapter.write(context.Background(), owned); err == nil {
		t.Fatal("write without CAS accepted")
	}
	if err := adapter.write(expectedProxyContext(context.Background(), before), owned); err != nil {
		t.Fatal(err)
	}
	current, err := adapter.read(context.Background())
	if err != nil || !reflect.DeepEqual(current[0], owned) {
		t.Fatalf("owned state mismatch: %v %v", current, err)
	}
	if err := adapter.write(expectedProxyContext(context.Background(), before), before); !errors.Is(err, errProxyChanged) {
		t.Fatalf("stale CAS not rejected: %v", err)
	}
	if err := adapter.write(expectedProxyContext(context.Background(), owned), before); err != nil {
		t.Fatal(err)
	}
	current, err = adapter.read(context.Background())
	if err != nil || !reflect.DeepEqual(current[0], before) {
		t.Fatalf("original state mismatch: %v %v", current, err)
	}
	current[0].Values["ProxyServer"] = "mutated caller snapshot"
	again, _ := adapter.read(context.Background())
	if !reflect.DeepEqual(again[0], before) {
		t.Fatal("reader returned aliased state")
	}
	after, _ := os.Stat(state)
	if !os.SameFile(info, after) || after.Mode() != 0600 {
		t.Fatal("file inode or permissions changed")
	}
	data, _ := os.ReadFile(sentinel)
	entries, _ := os.ReadDir(cfg.DataDir)
	if string(data) != "preserve" || len(entries) != 2 {
		t.Fatal("adapter changed a file outside its dedicated JSON")
	}
}

func TestE2EProxyConcurrentCASAndLockCancellation(t *testing.T) {
	state, cfg, document := e2eProxyFixture(t)
	adapter, err := newE2EFileProxy(state, cfg, "local")
	if err != nil {
		t.Fatal(err)
	}
	before := document.Settings[0]
	results := make(chan error, 2)
	var started sync.WaitGroup
	started.Add(2)
	begin := make(chan struct{})
	for _, port := range []int{41001, 41003} {
		go func(port int) {
			started.Done()
			<-begin
			owned, _ := desiredProxy(before, port, port+1)
			results <- adapter.write(expectedProxyContext(context.Background(), before), owned)
		}(port)
	}
	started.Wait()
	close(begin)
	success, conflict := 0, 0
	for range 2 {
		err := <-results
		if err == nil {
			success++
		} else if errors.Is(err, errProxyChanged) {
			conflict++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("CAS not serialized: %d/%d", success, conflict)
	}
	file, err := os.OpenFile(state, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err := unix.Flock(int(file.Fd()), unix.LOCK_EX); err != nil {
		t.Fatal(err)
	}
	defer unix.Flock(int(file.Fd()), unix.LOCK_UN)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, err := adapter.read(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("lock ignored cancellation: %v", err)
	}
}

func TestE2EProxyRejectsLaterTamperWithoutOSFallback(t *testing.T) {
	for _, scenario := range []string{"missing", "malformed", "mode", "symlink", "directory-replaced"} {
		t.Run(scenario, func(t *testing.T) {
			state, cfg, document := e2eProxyFixture(t)
			adapter, err := newE2EFileProxy(state, cfg, "local")
			if err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "missing":
				os.Remove(state)
			case "malformed":
				os.WriteFile(state, []byte("bad"), 0600)
			case "mode":
				os.Chmod(state, 0644)
			case "symlink":
				os.Remove(state)
				target := filepath.Join(t.TempDir(), "outside.json")
				writeE2EProxyDocument(t, target, document)
				os.Symlink(target, state)
			case "directory-replaced":
				os.Rename(cfg.DataDir, cfg.DataDir+"-old")
				os.Mkdir(cfg.DataDir, 0700)
				writeE2EProxyDocument(t, state, document)
			}
			if _, err := adapter.read(context.Background()); err == nil {
				t.Fatal("tampered state read accepted")
			}
			owned, _ := desiredProxy(document.Settings[0], 41001, 41002)
			if err := adapter.write(expectedProxyContext(context.Background(), document.Settings[0]), owned); err == nil {
				t.Fatal("tampered state write accepted")
			}
		})
	}
}

func TestE2EProxyInstalledHooksUseProductionJournal(t *testing.T) {
	state, cfg, document := e2eProxyFixture(t)
	t.Setenv("CHORDV_MYGO_DATA_DIR", cfg.DataDir)
	t.Setenv("CHORDV_API_BASE_URL", cfg.APIBase)
	originalRead, originalWrite, originalAuthorization, originalWatchdog := readProxySettings, writeProxySetting, prepareProxyAuthorization, launchProxyWatchdog
	t.Cleanup(func() {
		readProxySettings = originalRead
		writeProxySetting = originalWrite
		prepareProxyAuthorization = originalAuthorization
		launchProxyWatchdog = originalWatchdog
	})
	fallback := 0
	readProxySettings = func(context.Context) ([]proxySetting, error) { fallback++; return nil, errors.New("OS fallback") }
	writeProxySetting = func(context.Context, proxySetting) error { fallback++; return errors.New("OS fallback") }
	prepareProxyAuthorization = func() error { fallback++; return errors.New("OS fallback") }
	launchProxyWatchdog = func(string) (*proxyWatchdog, error) { fallback++; return nil, errors.New("OS fallback") }
	if err := installE2EFileProxy(state); err != nil {
		t.Fatal(err)
	}
	target, err := startE2EWatchdogTarget()
	if err != nil {
		t.Fatal(err)
	}
	var guard *proxyWatchdog
	defer func() { cleanupE2EWatchdog(cfg.DataDir, guard, target) }()
	service := newDesktopService(cfg)
	defer service.cancel()
	guard, err = service.takeProxy(context.Background(), 41001, 41002, target.process.PID, target.process.Binary, false)
	if err != nil {
		t.Fatal(err)
	}
	settings, err := readProxySettings(context.Background())
	if err != nil || settings[0].Values["ProxyEnable"] != "1" {
		t.Fatalf("proxy not taken: %v %v", settings, err)
	}
	if err := restoreProxyJournal(cfg.DataDir, false); err != nil {
		t.Fatal(err)
	}
	settings, err = readProxySettings(context.Background())
	if err != nil || !reflect.DeepEqual(settings[0], document.Settings[0]) {
		t.Fatalf("production restore did not restore JSON: %v %v", settings, err)
	}
	if err := guard.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-guard.done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("independent watchdog did not exit")
	}
	if err := os.WriteFile(state, []byte("invalid"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readProxySettings(context.Background()); err == nil {
		t.Fatal("broken profile returned fake success")
	}
	if err := writeProxySetting(expectedProxyContext(context.Background(), document.Settings[0]), document.Settings[0]); err == nil {
		t.Fatal("broken profile write accepted")
	}
	if fallback != 0 {
		t.Fatalf("test profile called OS fallback %d times", fallback)
	}
}
