//go:build e2e && darwin

package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

func TestMacLockedXrayRealityHTTPAndSOCKSLifecycle(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/client/session/heartbeat" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"sessionId":"mac-current-reality-session","status":"active","leaseExpiresAt":"2099-01-01T00:00:00Z"}`)
	}))
	t.Cleanup(api.Close)
	state, cfg, original := e2eProxyFixture(t)
	cfg.APIBase = api.URL
	installE2EWatchdogProfile(t, cfg, state)
	fileAuthorize := prepareProxyAuthorization
	var lockChecks int
	prepareProxyAuthorization = func() error {
		lock, err := lockMacUpdateData(cfg.DataDir)
		if err == nil {
			lock.Close()
			return errors.New("update lock available during proxy takeover")
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) {
			return err
		}
		lockChecks++
		return fileAuthorize()
	}
	service := newDesktopService(cfg)
	t.Cleanup(service.cancel)
	prepareRealXrayFixture(t, service)
	t.Cleanup(func() { _, _ = service.disconnect() })
	if err := service.sessions.save(service.sessionPath(), testSession("mac-current-locked-reality")); err != nil {
		t.Fatal(err)
	}
	var hits atomic.Int32
	payload := bytes.Repeat([]byte("mac-current-locked-reality-payload\x00"), 4096)
	echo := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		received, err := io.ReadAll(io.LimitReader(r.Body, int64(len(payload)+1)))
		if err != nil || r.Method != "POST" || r.URL.Path != "/reality-echo" || !bytes.Equal(received, payload) {
			http.Error(w, "request mismatch", 400)
			return
		}
		_, _ = w.Write(received)
	}))
	t.Cleanup(echo.Close)
	core, _ := service.componentPath("xray")
	outbound, _ := startRealityTestPeer(t, core, echo.Listener.Addr().(*net.TCPAddr).Port)
	httpPort, socksPort := localTestPorts(t)
	config := runtimeConfig{SessionID: "mac-current-reality-session", LeaseHeartbeatIntervalSeconds: 30, LeaseGraceSeconds: 300, Mode: "global", LocalHTTPPort: httpPort, LocalSocksPort: socksPort, Node: nodeSummary{ID: "mac-local-actual-reality", Name: "本地真实Reality", ServerHost: outbound.Server, ServerPort: outbound.Port, Protocol: "vless", Security: "reality"}, Outbound: outbound}
	events := make(chan NativeEvent, 64)
	service.emit = func(e NativeEvent) { events <- e }
	connect := func() *proxyWatchdog {
		t.Helper()
		input, err := json.Marshal(map[string]any{"config": config, "forceTakeover": true})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = service.Invoke(context.Background(), "connect_runtime", input); err != nil {
			logs, _ := service.runtimeLogs()
			t.Fatal("production Invoke connect failed", err, logs)
		}
		lock, err := lockMacUpdateData(cfg.DataDir)
		if err != nil {
			t.Fatal("connection retained update lock after startup", err)
		}
		lock.Close()
		service.mu.Lock()
		guard, status := service.runtime.watchdog, service.runtime.Status
		service.mu.Unlock()
		if guard == nil || status != "connected" {
			t.Fatal("Invoke did not create a connected kernel and independent watchdog")
		}
		settings, err := readProxySettings(context.Background())
		if err != nil || len(settings) != 1 || reflect.DeepEqual(settings[0], original.Settings[0]) {
			t.Fatal("isolated file proxy takeover missing", err)
		}
		receipt, err := readE2EWatchdogReceipt(cfg.DataDir)
		if err != nil || receipt.ParentPID != os.Getpid() || receipt.Process.PID == os.Getpid() || receipt.StatePath != state {
			t.Fatal("watchdog is not a distinct profile-bound process", err)
		}
		return guard
	}
	waitGuard := func(guard *proxyWatchdog) {
		t.Helper()
		select {
		case err := <-guard.done:
			if err != nil {
				t.Fatal("watchdog failed", err)
			}
		case <-time.After(8 * time.Second):
			t.Fatal("independent watchdog failed to exit")
		}
	}
	checkRestored := func() {
		t.Helper()
		settings, err := readProxySettings(context.Background())
		if err != nil || !reflect.DeepEqual(settings, original.Settings) {
			t.Fatal("original file proxy not restored", settings, err)
		}
		if _, err = os.Stat(proxyJournalPath(cfg.DataDir)); !os.IsNotExist(err) {
			t.Fatal("completed proxy journal remains", err)
		}
	}
	disconnect := func(guard *proxyWatchdog) {
		t.Helper()
		if _, err := service.Invoke(context.Background(), "disconnect_runtime", nil); err != nil {
			t.Fatal(err)
		}
		waitGuard(guard)
		checkRestored()
	}
	target := strings.Replace(echo.URL, "127.0.0.1", "chordv-proxy-target.test", 1) + "/reality-echo"
	request := func(protocol string) (body []byte, err error) {
		transport := &http.Transport{Proxy: nil, DisableKeepAlives: true}
		if protocol == "http" {
			proxy, _ := url.Parse("http://127.0.0.1:" + strconv.Itoa(httpPort))
			transport.Proxy = http.ProxyURL(proxy)
		} else {
			transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
				return macRealitySOCKSDial(ctx, socksPort, address)
			}
		}
		defer transport.CloseIdleConnections()
		client := &http.Client{Transport: transport, Timeout: 4 * time.Second}
		response, err := client.Post(target, "application/octet-stream", bytes.NewReader(payload))
		if err != nil {
			return nil, err
		}
		defer response.Body.Close()
		body, err = io.ReadAll(io.LimitReader(response.Body, int64(len(payload)+1)))
		if err == nil && response.StatusCode != 200 {
			err = fmt.Errorf("HTTP status %d", response.StatusCode)
		}
		return body, err
	}
	assertTraffic := func(protocol string, want int32) {
		t.Helper()
		body, err := request(protocol)
		if err != nil || !bytes.Equal(body, payload) || hits.Load() != want {
			logs, _ := service.runtimeLogs()
			t.Fatal("actual Reality payload failed", protocol, len(body), hits.Load(), err, logs)
		}
	}
	guard := connect()
	assertTraffic("http", 1)
	assertTraffic("socks", 2)
	if _, err := service.Invoke(context.Background(), "connect_runtime", mustJSONRuntimeConfig(t, config)); err == nil {
		t.Fatal("duplicate connect replaced the active kernel")
	}
	disconnect(guard)
	config.Outbound.UUID = "22222222-2222-4222-8222-222222222222"
	guard = connect()
	for _, protocol := range []string{"http", "socks"} {
		body, err := request(protocol)
		if err == nil || hits.Load() != 2 {
			t.Fatal("wrong UUID bypassed Reality", protocol, len(body), hits.Load(), err)
		}
		if errors.Is(err, context.DeadlineExceeded) {
			t.Fatal("negative control only timed out", protocol, err)
		}
		t.Logf("wrong UUID %s failed without reaching echo: %v", protocol, err)
	}
	disconnect(guard)
	config.Outbound = outbound
	guard = connect()
	assertTraffic("http", 3)
	assertTraffic("socks", 4)
	service.mu.Lock()
	process, done := service.runtime.process, service.runtime.processDone
	service.mu.Unlock()
	if err := process.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("owned actual Xray did not exit")
	}
	waitForNativeRuntime(t, events, "error")
	waitGuard(guard)
	checkRestored()
	if err := os.Remove(filepath.Join(cfg.DataDir, e2eWatchdogResultName)); err != nil {
		t.Fatal(err)
	}
	guard = connect()
	assertTraffic("http", 5)
	assertTraffic("socks", 6)
	service.mu.Lock()
	done = service.runtime.processDone
	service.mu.Unlock()
	// EOF is handled by the independent actual watchdog, not an in-process stub.
	if err := guard.Close(); err != nil {
		t.Fatal(err)
	}
	waitGuard(guard)
	waitE2EWatchdogResult(t, cfg.DataDir)
	// The watchdog stops Xray before exiting. Either observer may finish first.
	if waitForNativeRuntime(t, events, "error", "idle") == "idle" {
		select {
		case event := <-events:
			interruption, ok := event.Payload.(runtimeInterruption)
			if event.Name != "chordv://runtime-interrupted" || !ok || interruption.Cause != "watchdog-exited" || !interruption.ProxyRestored {
				t.Fatalf("incorrect watchdog exit event: %+v", event)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("missing watchdog interruption event")
		}
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Xray is still running after watchdog EOF")
	}
	checkRestored()
	if lockChecks != 4 {
		t.Fatal("expected four lock checks during proxy takeover", lockChecks)
	}
	t.Logf("production Invoke + locked genuine macOS Xray: HTTP and full SOCKS CONNECT each echoed %d bytes three times; wrong UUIDs rejected; kernel kill and independent watchdog EOF restored only private file proxy", len(payload))
}

func mustJSONRuntimeConfig(t *testing.T, config runtimeConfig) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"config": config, "forceTakeover": true})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func macRealitySOCKSDial(ctx context.Context, port int, address string) (net.Conn, error) {
	connection, err := (&net.Dialer{Timeout: time.Second}).DialContext(ctx, "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return nil, err
	}
	keep := false
	defer func() {
		if !keep {
			_ = connection.Close()
		}
	}()
	deadline := time.Now().Add(3 * time.Second)
	if value, ok := ctx.Deadline(); ok && value.Before(deadline) {
		deadline = value
	}
	_ = connection.SetDeadline(deadline)
	if _, err = connection.Write([]byte{5, 1, 0}); err != nil {
		return nil, err
	}
	reader := bufio.NewReader(connection)
	greeting := make([]byte, 2)
	if _, err = io.ReadFull(reader, greeting); err != nil {
		return nil, err
	}
	if !bytes.Equal(greeting, []byte{5, 0}) {
		return nil, errors.New("SOCKS5 anonymous greeting rejected")
	}
	host, portText, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	targetPort, err := strconv.Atoi(portText)
	if err != nil || targetPort < 1 || targetPort > 65535 || len(host) > 255 {
		return nil, errors.New("invalid SOCKS CONNECT target")
	}
	command := append([]byte{5, 1, 0, 3, byte(len(host))}, []byte(host)...)
	command = binary.BigEndian.AppendUint16(command, uint16(targetPort))
	if _, err = connection.Write(command); err != nil {
		return nil, err
	}
	header := make([]byte, 4)
	if _, err = io.ReadFull(reader, header); err != nil {
		return nil, err
	}
	if header[0] != 5 || header[1] != 0 || header[2] != 0 {
		return nil, fmt.Errorf("SOCKS5 CONNECT rejected: %v", header)
	}
	var skip int
	switch header[3] {
	case 1:
		skip = 4
	case 4:
		skip = 16
	case 3:
		length, readErr := reader.ReadByte()
		if readErr != nil {
			return nil, readErr
		}
		skip = int(length)
	default:
		return nil, errors.New("SOCKS5 bound address type invalid")
	}
	if _, err = io.CopyN(io.Discard, reader, int64(skip+2)); err != nil {
		return nil, err
	}
	// SOCKS CONNECT and the echoed HTTP request must share the same actual socket.
	if reader.Buffered() != 0 {
		return nil, errors.New("unexpected bytes before SOCKS application request")
	}
	keep = true
	return connection, nil
}
