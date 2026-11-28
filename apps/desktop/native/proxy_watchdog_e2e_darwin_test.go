//go:build e2e && darwin

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func installE2EWatchdogProfile(t *testing.T, cfg appConfig, state string) {
	t.Helper()
	t.Setenv("CHORDV_API_BASE_URL", cfg.APIBase)
	t.Setenv("CHORDV_MYGO_DATA_DIR", cfg.DataDir)
	read, write, authorize, launch := readProxySettings, writeProxySetting, prepareProxyAuthorization, launchProxyWatchdog
	t.Cleanup(func() {
		readProxySettings = read
		writeProxySetting = write
		prepareProxyAuthorization = authorize
		launchProxyWatchdog = launch
	})
	if err := installE2EFileProxy(state); err != nil {
		t.Fatal(err)
	}
}

func TestE2EIndependentWatchdogEOFRestoresAndStopsOwnedTarget(t *testing.T) {
	state, cfg, document := e2eProxyFixture(t)
	installE2EWatchdogProfile(t, cfg, state)
	t.Setenv("MYGO_AUTOMATION", filepath.Join(t.TempDir(), "must-not-reach-watchdog.sock"))
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
	if err := guard.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-guard.done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("watchdog EOF exit timeout")
	}
	settings, err := readProxySettings(context.Background())
	if err != nil || !reflect.DeepEqual(settings[0], document.Settings[0]) {
		t.Fatalf("EOF did not restore isolated JSON: %v %v", settings, err)
	}
	select {
	case <-target.done:
	case <-time.After(time.Second):
		t.Fatal("watchdog did not stop its owned target")
	}
	receipt, err := readE2EWatchdogReceipt(cfg.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	if receipt.Process.PID == os.Getpid() || receipt.Process.PID == target.process.PID || receipt.ParentPID != os.Getpid() {
		t.Fatalf("watchdog is not independent: %+v", receipt)
	}
	if receipt.StatePath != state || receipt.DataDir != cfg.DataDir || receipt.APIBase != cfg.APIBase || receipt.Automation != "" {
		t.Fatalf("wrong child isolation environment: %+v", receipt)
	}
}

func waitE2EWatchdogResult(t *testing.T, dir string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(filepath.Join(dir, e2eWatchdogResultName))
		if err == nil {
			var result map[string]string
			if json.Unmarshal(data, &result) != nil || result["error"] != "" {
				t.Fatalf("independent recovery failed: %s", data)
			}
			return
		}
		if !os.IsNotExist(err) {
			t.Fatal(err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("independent watchdog did not report completion")
}

func TestE2EIndependentWatchdogSurvivesHolderKill(t *testing.T) {
	state, cfg, document := e2eProxyFixture(t)
	binary, _ := os.Executable()
	holder := exec.Command(binary, "--e2e-watchdog-holder", cfg.DataDir)
	prepareHolderGroup(holder)
	holder.Env = e2eProxyChildEnvironment(state, cfg.DataDir, cfg.APIBase)
	input, err := holder.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	stdout, err := holder.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	holder.Stderr = os.Stderr
	if err := holder.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { _ = holder.Wait(); close(done) }()
	var ready struct {
		HolderPID int             `json:"holderPid"`
		Target    e2eOwnedProcess `json:"target"`
	}
	t.Cleanup(func() {
		if receipt, err := readE2EWatchdogReceipt(cfg.DataDir); err == nil {
			stopE2ERecordedProcess(receipt.Process)
		}
		_ = holder.Process.Kill()
		<-done
		if receipt, err := readE2EWatchdogReceipt(cfg.DataDir); err == nil {
			stopE2ERecordedProcess(receipt.Process)
		}
		if ready.Target.PID == 0 {
			data, _ := os.ReadFile(filepath.Join(cfg.DataDir, ".e2e-holder-target.json"))
			_ = json.Unmarshal(data, &ready.Target)
		}
		stopE2ERecordedProcess(ready.Target)
	})
	type holderResult struct {
		value struct {
			HolderPID int             `json:"holderPid"`
			Target    e2eOwnedProcess `json:"target"`
		}
		err error
	}
	decoded := make(chan holderResult, 1)
	go func() {
		var result holderResult
		result.err = json.NewDecoder(bufio.NewReader(stdout)).Decode(&result.value)
		decoded <- result
	}()
	select {
	case result := <-decoded:
		if result.err != nil {
			t.Fatal(result.err)
		}
		ready = result.value
	case <-time.After(8 * time.Second):
		t.Fatal("holder readiness timeout")
	}
	receipt, err := readE2EWatchdogReceipt(cfg.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	if receipt.ParentPID != holder.Process.Pid || receipt.Process.PID == ready.Target.PID || ready.Target.PID == holder.Process.Pid {
		t.Fatalf("wrong independent process graph: %+v %+v", ready, receipt)
	}
	if !e2eRecordedProcessAlive(ready.Target) {
		t.Fatal("owned target not alive before holder kill")
	}
	if err := holder.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	<-done
	waitE2EWatchdogResult(t, cfg.DataDir)
	adapter, err := newE2EFileProxy(state, cfg, "local")
	if err != nil {
		t.Fatal(err)
	}
	settings, err := adapter.read(context.Background())
	if err != nil || !reflect.DeepEqual(settings[0], document.Settings[0]) {
		t.Fatalf("holder kill did not restore JSON: %v %v", settings, err)
	}
	if e2eRecordedProcessAlive(ready.Target) {
		t.Fatal("independent watchdog did not stop owned target after holder kill")
	}
	deadline := time.Now().Add(3 * time.Second)
	for e2eRecordedProcessAlive(receipt.Process) && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if e2eRecordedProcessAlive(receipt.Process) {
		t.Fatal("independent watchdog remained alive after restoration")
	}
}

func TestE2EWatchdogMissingProfileFieldsFailBeforeRecovery(t *testing.T) {
	for _, missing := range []string{"CHORDV_E2E_PROXY_STATE", "CHORDV_MYGO_DATA_DIR", "CHORDV_API_BASE_URL"} {
		t.Run(missing, func(t *testing.T) {
			state, cfg, document := e2eProxyFixture(t)
			owned, _ := desiredProxy(document.Settings[0], 41001, 41002)
			if err := atomicJSON(proxyJournalPath(cfg.DataDir), proxyJournal{Version: 1, Changes: []proxyChange{{Before: document.Settings[0], Owned: owned}}}); err != nil {
				t.Fatal(err)
			}
			env := e2eProxyChildEnvironment(state, cfg.DataDir, cfg.APIBase)
			filtered := []string{}
			for _, value := range env {
				if !strings.HasPrefix(value, missing+"=") {
					filtered = append(filtered, value)
				}
			}
			if missing == "CHORDV_E2E_PROXY_STATE" {
				binary, _ := os.Executable()
				child := exec.Command(binary, "--proxy-watchdog", cfg.DataDir)
				child.Env = filtered
				output, err := child.CombinedOutput()
				if err == nil || !strings.Contains(string(output), "E2E watchdog缺少显式文件代理profile，启动已停止") {
					t.Fatalf("missing STATE did not fail in production e2e init: %v %s", err, output)
				}
			}
			if guard, err := startProxyWatchdogWithEnvironment(cfg.DataDir, filtered); err == nil {
				cleanupE2EWatchdog(cfg.DataDir, guard, nil)
				t.Fatal("missing profile field accepted")
			}
			if _, err := os.Stat(filepath.Join(cfg.DataDir, e2eWatchdogReceiptName)); !os.IsNotExist(err) {
				t.Fatal("invalid profile reached watchdog dispatcher")
			}
		})
	}
	t.Run("argument-directory-mismatch", func(t *testing.T) {
		state, cfg, _ := e2eProxyFixture(t)
		other := t.TempDir()
		if err := atomicJSON(proxyJournalPath(other), proxyJournal{Version: 1}); err != nil {
			t.Fatal(err)
		}
		if guard, err := startProxyWatchdogWithEnvironment(other, e2eProxyChildEnvironment(state, cfg.DataDir, cfg.APIBase)); err == nil {
			cleanupE2EWatchdog(other, guard, nil)
			t.Fatal("watchdog accepted other journal directory")
		}
		if _, err := os.Stat(filepath.Join(other, e2eWatchdogReceiptName)); !os.IsNotExist(err) {
			t.Fatal("mismatched journal reached dispatcher")
		}
	})
}

func TestE2EIndependentWatchdogStopsRealXrayOnEOF(t *testing.T) {
	state, cfg, document := e2eProxyFixture(t)
	service := newDesktopService(cfg)
	defer service.cancel()
	prepareRealXrayFixture(t, service)
	installE2EWatchdogProfile(t, cfg, state)
	httpPort, socksPort := localTestPorts(t)
	config := map[string]any{"log": map[string]string{"loglevel": "warning"}, "inbounds": []any{map[string]any{"listen": "127.0.0.1", "port": httpPort, "protocol": "http", "settings": map[string]any{}}, map[string]any{"listen": "127.0.0.1", "port": socksPort, "protocol": "socks", "settings": map[string]any{}}}, "outbounds": []any{map[string]any{"protocol": "freedom", "settings": map[string]any{}}}}
	file := filepath.Join(cfg.DataDir, "watchdog-real-xray.json")
	if err := atomicJSON(file, config); err != nil {
		t.Fatal(err)
	}
	binary, _ := service.componentPath("xray")
	command := exec.Command(binary, "run", "-config", file)
	command.Env = append(systemProcessEnvironment(), "XRAY_LOCATION_ASSET="+service.binDir())
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	target, err := trackE2EWatchdogTarget(command)
	if err != nil {
		t.Fatal(err)
	}
	var guard *proxyWatchdog
	defer func() { cleanupE2EWatchdog(cfg.DataDir, guard, target) }()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := waitRuntimeReady(ctx, target.done, httpPort, socksPort); err != nil {
		t.Fatal(err)
	}
	guard, err = service.takeProxy(context.Background(), httpPort, socksPort, target.process.PID, target.process.Binary, false)
	if err != nil {
		t.Fatal(err)
	}
	guard.Close()
	select {
	case err := <-guard.done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("real-Xray watchdog exit timeout")
	}
	select {
	case <-target.done:
	case <-time.After(time.Second):
		t.Fatal("real Xray not killed by independent watchdog")
	}
	settings, err := readProxySettings(context.Background())
	if err != nil || !reflect.DeepEqual(settings[0], document.Settings[0]) {
		t.Fatal("real Xray EOF did not restore isolated JSON")
	}
}

func TestE2EIndependentWatchdogPreservesNonOwnedTarget(t *testing.T) {
	for _, mismatch := range []string{"identity", "binary"} {
		t.Run(mismatch, func(t *testing.T) {
			state, cfg, document := e2eProxyFixture(t)
			installE2EWatchdogProfile(t, cfg, state)
			target, err := startE2EWatchdogTarget()
			if err != nil {
				t.Fatal(err)
			}
			var guard *proxyWatchdog
			defer func() { cleanupE2EWatchdog(cfg.DataDir, guard, target) }()
			owned, _ := desiredProxy(document.Settings[0], 41001, 41002)
			writeE2EProxyDocument(t, state, e2eProxyDocument{Schema: 1, TestOnly: true, Settings: []proxySetting{owned}})
			identity, binary := target.process.Identity, target.process.Binary
			if mismatch == "identity" {
				identity += "-not-the-owned-process"
			} else {
				binary = filepath.Join(cfg.DataDir, "different-binary")
			}
			if err := atomicJSON(proxyJournalPath(cfg.DataDir), proxyJournal{Version: 1, PID: target.process.PID, Binary: binary, ProcessIdentity: identity, Changes: []proxyChange{{Before: document.Settings[0], Owned: owned}}}); err != nil {
				t.Fatal(err)
			}
			guard, err = launchProxyWatchdog(cfg.DataDir)
			if err != nil {
				t.Fatal(err)
			}
			guard.Close()
			select {
			case err := <-guard.done:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("watchdog exit timeout")
			}
			settings, err := readProxySettings(context.Background())
			if err != nil || !reflect.DeepEqual(settings[0], document.Settings[0]) {
				t.Fatal("JSON not restored")
			}
			select {
			case <-target.done:
				t.Fatal("non-owned target was killed")
			default:
			}
		})
	}
}
