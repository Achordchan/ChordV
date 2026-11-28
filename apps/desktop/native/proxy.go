package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"time"
)

type proxySetting struct {
	Service string            `json:"service"`
	Kind    string            `json:"kind"`
	Scope   string            `json:"scope,omitempty"`
	Values  map[string]string `json:"values"`
}
type proxyChange struct {
	Before proxySetting `json:"before"`
	Owned  proxySetting `json:"owned"`
}
type proxyJournal struct {
	Version         int           `json:"version"`
	PID             int           `json:"pid"`
	Binary          string        `json:"binary"`
	ProcessIdentity string        `json:"processIdentity"`
	Changes         []proxyChange `json:"changes"`
}

type proxyWatchdog struct {
	pipe *os.File
	done chan error
}

func (w *proxyWatchdog) Close() error { return w.pipe.Close() }

var readProxySettings = platformReadProxy
var writeProxySetting = platformWriteProxy
var launchProxyWatchdog = startProxyWatchdog
var prepareProxyAuthorization = platformPrepareProxyAuthorization

var errProxyChanged = errors.New("系统代理已被其他操作修改，当前设置已保留")

type proxyExpectationKey struct{}

func expectedProxyContext(ctx context.Context, setting proxySetting) context.Context {
	return context.WithValue(ctx, proxyExpectationKey{}, setting)
}

func proxyJournalPath(dir string) string { return filepath.Join(dir, "proxy-journal.json") }
func proxyEnabled(setting proxySetting) bool {
	return strings.EqualFold(setting.Values["enabled"], "yes") || strings.EqualFold(setting.Values["enabled"], "on") || setting.Values["enabled"] == "1"
}

func desiredProxy(before proxySetting, httpPort, socksPort int) (proxySetting, error) {
	if before.Kind == gnomeProxyKind {
		return gnomeOwnedProxy(before, httpPort, socksPort)
	}
	if before.Kind == "macos" {
		return macOwnedProxy(before, httpPort, socksPort)
	}
	if before.Kind != "windows" {
		return proxySetting{}, errors.New("系统代理类型无效")
	}
	owned := proxySetting{Service: before.Service, Kind: before.Kind, Values: map[string]string{}}
	for key, value := range before.Values {
		owned.Values[key] = value
	}
	owned.Values["ProxyEnable"] = "1"
	owned.Values["ProxyServer"] = fmt.Sprintf("http=127.0.0.1:%d;https=127.0.0.1:%d;socks=127.0.0.1:%d", httpPort, httpPort, socksPort)
	owned.Values["AutoConfigURL"] = ""
	owned.Values["AutoDetect"] = "0"
	owned.Values["connectionFlags"] = "3"
	owned.Values["effectiveFlags"] = "3"
	owned.Values["effectiveProxyServer"] = owned.Values["ProxyServer"]
	owned.Values["effectiveProxyOverride"] = owned.Values["ProxyOverride"]
	owned.Values["effectiveAutoConfigURL"] = ""
	owned.Values["restoreConnections"] = "0"
	for _, key := range []string{"ProxyEnable", "ProxyServer", "AutoConfigURL", "AutoDetect"} {
		delete(owned.Values, key+".missing")
	}
	if data, err := base64.StdEncoding.DecodeString(owned.Values["DefaultConnectionSettings"]); err == nil && len(data) > 8 {
		data[8] = 3
		owned.Values["DefaultConnectionSettings"] = base64.StdEncoding.EncodeToString(data)
	}
	return owned, nil
}

func (s *DesktopService) checkNetworkConflict(ctx context.Context, forceTakeover bool) error {
	if err := requireUnusedMacUpdateJournal(s.cfg.DataDir); err != nil {
		return err
	}
	// Probe ownership before requesting a lease. connect rechecks under its own lock.
	release, err := lockRuntimeMutation(s.cfg.DataDir)
	if err != nil {
		return err
	}
	release()
	if forceTakeover {
		return nil
	}
	settings, err := readProxySettings(ctx)
	if err != nil {
		return err
	}
	for _, setting := range settings {
		if setting.Kind == "windows" {
			if setting.Values["ProxyEnable"] == "1" || setting.Values["AutoConfigURL"] != "" {
				return errors.New("系统正在使用其他代理，请先关闭或确认接管")
			}
			continue
		}
		if proxyEnabled(setting) {
			return errors.New("系统正在使用其他代理，请先关闭或确认接管")
		}
	}
	return nil
}

func (s *DesktopService) takeProxy(ctx context.Context, httpPort, socksPort, pid int, binary string, force bool) (*proxyWatchdog, error) {
	settings, err := readProxySettings(ctx)
	if err != nil {
		return nil, err
	}
	for _, setting := range settings {
		if setting.Values["authenticated"] == "1" {
			return nil, errors.New("系统使用了带密码的代理，无法完整恢复凭据，请先在系统设置中关闭该代理")
		}
	}
	if !force {
		for _, setting := range settings {
			if proxyEnabled(setting) || (setting.Kind == "windows" && (setting.Values["ProxyEnable"] == "1" || setting.Values["AutoConfigURL"] != "")) {
				return nil, errors.New("系统代理已被其他应用占用，请确认接管")
			}
		}
	}
	identity, err := processIdentity(ctx, pid)
	if err != nil {
		return nil, err
	}
	if err = prepareProxyAuthorization(); err != nil {
		return nil, err
	}
	journal := proxyJournal{Version: 1, PID: pid, Binary: binary, ProcessIdentity: identity, Changes: []proxyChange{}}
	for _, before := range settings {
		owned, err := desiredProxy(before, httpPort, socksPort)
		if err != nil {
			return nil, err
		}
		journal.Changes = append(journal.Changes, proxyChange{Before: before, Owned: owned})
	}
	if err = atomicJSON(proxyJournalPath(s.cfg.DataDir), journal); err != nil {
		return nil, err
	}
	pipe, err := launchProxyWatchdog(s.cfg.DataDir)
	if err != nil {
		_ = os.Remove(proxyJournalPath(s.cfg.DataDir))
		return nil, err
	}
	for _, change := range journal.Changes {
		if err = writeProxySetting(expectedProxyContext(ctx, change.Before), change.Owned); err != nil {
			restoreErr := restoreProxyJournal(s.cfg.DataDir, false)
			pipe.Close()
			if restoreErr != nil {
				return nil, errors.Join(err, restoreErr)
			}
			return nil, err
		}
	}
	return pipe, nil
}

func restoreProxyJournal(dir string, stopProcess bool) error {
	path := proxyJournalPath(dir)
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var journal proxyJournal
	if err = json.Unmarshal(data, &journal); err != nil {
		return errors.New("系统代理恢复记录损坏")
	}
	if journal.Version != 1 {
		return errors.New("系统代理恢复记录版本无效")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	current, err := readProxySettings(ctx)
	if err != nil {
		return err
	}
	var failures []error
	for _, change := range journal.Changes {
		if change.Owned.Kind == gnomeProxyKind {
			if err := restoreGNOMEProxyChange(ctx, change, current); err != nil {
				failures = append(failures, err)
			}
			continue
		}
		for _, setting := range current {
			if setting.Service == change.Owned.Service && setting.Kind == change.Owned.Kind && (proxyOwnershipMatches(setting, change.Owned) || proxyOwnershipMatches(setting, change.Before) || proxyPartiallyOwned(setting, change.Before, change.Owned)) {
				if err = writeProxySetting(expectedProxyContext(ctx, setting), change.Before); err != nil && !errors.Is(err, errProxyChanged) {
					failures = append(failures, err)
				}
				break
			}
		}
	}
	if len(failures) > 0 {
		return errors.Join(failures...)
	}
	if stopProcess && journal.PID > 0 {
		if identity, err := processIdentity(ctx, journal.PID); err == nil && identity == journal.ProcessIdentity {
			if executable, err := processExecutable(ctx, journal.PID); err == nil && filepath.Clean(executable) == filepath.Clean(journal.Binary) {
				if process, err := os.FindProcess(journal.PID); err == nil {
					_ = process.Kill()
				}
			}
		}
	}
	return os.Remove(path)
}

func proxyOwnershipMatches(current, expected proxySetting) bool {
	if current.Kind != "windows" {
		return reflect.DeepEqual(current.Values, expected.Values)
	}
	for _, key := range []string{"ProxyEnable", "ProxyServer", "ProxyOverride", "AutoConfigURL", "AutoDetect", "effectiveFlags", "effectiveProxyServer", "effectiveProxyOverride", "effectiveAutoConfigURL"} {
		if current.Values[key] != expected.Values[key] {
			return false
		}
	}
	return true
}

func proxyPartiallyOwned(current, before, owned proxySetting) bool {
	if current.Kind == gnomeProxyKind {
		return gnomePartiallyOwned(current, before, owned)
	}
	if current.Kind != "windows" {
		return false
	}
	for _, key := range []string{"ProxyEnable", "ProxyServer", "ProxyOverride", "AutoConfigURL", "AutoDetect", "effectiveFlags", "effectiveProxyServer", "effectiveProxyOverride", "effectiveAutoConfigURL"} {
		value := current.Values[key]
		if value != before.Values[key] && value != owned.Values[key] {
			return false
		}
	}
	return true
}

func recoverProxyJournal(dir string) error { return restoreProxyJournal(dir, true) }

func startProxyWatchdog(dir string) (*proxyWatchdog, error) {
	return startProxyWatchdogWithEnvironment(dir, systemProcessEnvironment())
}

func startProxyWatchdogWithEnvironment(dir string, environment []string) (*proxyWatchdog, error) {
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	reader, writer, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(executable, "--proxy-watchdog", dir)
	cmd.Env = environment
	cmd.Stdin = reader
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		reader.Close()
		writer.Close()
		return nil, err
	}
	cmd.Stderr = io.Discard
	detachWatchdog(cmd)
	if err = cmd.Start(); err != nil {
		reader.Close()
		writer.Close()
		return nil, fmt.Errorf("启动独立代理恢复进程失败：%w", err)
	}
	reader.Close()
	if err = writeWatchdogHello(writer); err != nil {
		writer.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return nil, err
	}
	ready := make(chan error, 1)
	go func() {
		line, err := bufio.NewReader(stdout).ReadString('\n')
		if err == nil && strings.TrimSpace(line) != "CHORDV_WATCHDOG_READY" {
			err = errors.New("代理恢复进程握手无效")
		}
		ready <- err
	}()
	select {
	case err := <-ready:
		if err != nil {
			writer.Close()
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			return nil, errors.New("独立代理恢复进程未就绪")
		}
	case <-time.After(5 * time.Second):
		writer.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return nil, errors.New("独立代理恢复进程启动超时")
	}
	watchdog := &proxyWatchdog{pipe: writer, done: make(chan error, 1)}
	go func() { watchdog.done <- cmd.Wait(); close(watchdog.done) }()
	return watchdog, nil
}

func runProxyWatchdog(dir string) error {
	if _, err := os.Stat(proxyJournalPath(dir)); err != nil {
		return err
	}
	input := bufio.NewReaderSize(os.Stdin, 4096)
	hello, err := input.ReadString('\n')
	if err != nil {
		return errors.New("代理恢复进程缺少私有握手")
	}
	var message struct {
		Authorization string `json:"authorization"`
	}
	if len(hello) > 2048 || json.Unmarshal([]byte(hello), &message) != nil {
		return errors.New("代理恢复进程握手无效")
	}
	if err := platformImportWatchdogAuthorization(message.Authorization); err != nil {
		return err
	}
	if _, err := fmt.Fprintln(os.Stdout, "CHORDV_WATCHDOG_READY"); err != nil {
		return err
	}
	// The pipe closes in the kernel even after SIGKILL; no timer or parent defer is required.
	_, err = io.Copy(io.Discard, input)
	if err != nil {
		return err
	}
	for attempt := 0; attempt < 6; attempt++ {
		err = restoreProxyJournal(dir, true)
		if err == nil {
			return nil
		}
		if attempt < 5 {
			time.Sleep(time.Duration(250*(1<<attempt)) * time.Millisecond)
		}
	}
	return err
}

func writeWatchdogHello(writer io.Writer) error {
	data, err := json.Marshal(map[string]string{"authorization": platformWatchdogAuthorization()})
	if err != nil {
		return err
	}
	data = append(data, '\n')
	_, err = writer.Write(data)
	return err
}
