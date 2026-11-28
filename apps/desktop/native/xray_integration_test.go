package main

import (
	"context"
	"encoding/base64"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"sync"
	"testing"
	"time"
)

func localTestPorts(t *testing.T) (int, int) {
	t.Helper()
	first, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	return first.Addr().(*net.TCPAddr).Port, second.Addr().(*net.TCPAddr).Port
}

func prepareRealXrayFixture(t *testing.T, s *DesktopService) {
	t.Helper()
	dir := os.Getenv("CHORDV_TEST_XRAY_DIR")
	if dir == "" {
		t.Skip("provide CHORDV_TEST_XRAY_DIR with genuine Xray/GEO artifacts for local-only integration")
	}
	binary := xrayFileName()
	if runtime.GOOS == "darwin" {
		if runtime.GOARCH == "arm64" {
			binary = "xray-aarch64-apple-darwin"
		} else {
			binary = "xray-x86_64-apple-darwin"
		}
	}
	for _, entry := range []struct{ kind, source string }{{"xray", binary}, {"geoip", "geoip.dat"}, {"geosite", "geosite.dat"}} {
		source := filepath.Join(dir, entry.source)
		target, _ := s.componentPath(entry.kind)
		if err := copyAtomic(source, target, 0700); err != nil {
			t.Fatalf("real %s fixture unavailable: %v", entry.kind, err)
		}
		hash, err := fileSHA256(target)
		if err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(target)
		if err != nil {
			t.Fatal(err)
		}
		if err := atomicJSON(filepath.Join(s.binDir(), entry.kind+".json"), installedComponent{Kind: entry.kind, VersionLabel: pointer("local-integration-fixture"), ArtifactSHA256: hash, InstalledSHA256: hash, InstalledSize: info.Size()}); err != nil {
			t.Fatal(err)
		}
	}
}

func TestRealXrayLocalLifecycleWithIsolatedOSProxy(t *testing.T) {
	s := testService(t, "http://127.0.0.1:1")
	prepareRealXrayFixture(t, s)
	originalRead, originalWrite, originalLaunch, originalAuthorize := readProxySettings, writeProxySetting, launchProxyWatchdog, prepareProxyAuthorization
	t.Cleanup(func() {
		readProxySettings = originalRead
		writeProxySetting = originalWrite
		launchProxyWatchdog = originalLaunch
		prepareProxyAuthorization = originalAuthorize
	})
	raw, _ := marshalPlist(map[string]any{"HTTPEnable": int64(0), "HTTPProxy": "", "ExceptionsList": []any{"*.local"}})
	before := proxySetting{Service: "isolated-test-service-not-an-os-uuid", Kind: "macos", Values: map[string]string{"name": "isolated test proxy", "configuration": base64.StdEncoding.EncodeToString(raw), "missing": "0", "enabled": "No"}}
	var proxyMu sync.Mutex
	state := before
	readProxySettings = func(context.Context) ([]proxySetting, error) {
		proxyMu.Lock()
		defer proxyMu.Unlock()
		return []proxySetting{state}, nil
	}
	writeProxySetting = func(_ context.Context, setting proxySetting) error {
		proxyMu.Lock()
		defer proxyMu.Unlock()
		state = setting
		return nil
	}
	prepareProxyAuthorization = func() error { return nil }
	launchProxyWatchdog = func(string) (*proxyWatchdog, error) {
		reader, writer, err := os.Pipe()
		if err != nil {
			return nil, err
		}
		guard := &proxyWatchdog{pipe: writer, done: make(chan error, 1)}
		go func() { _, err := io.Copy(io.Discard, reader); reader.Close(); guard.done <- err; close(guard.done) }()
		return guard, nil
	}
	events := make(chan NativeEvent, 64)
	s.emit = func(event NativeEvent) { events <- event }
	httpPort, socksPort := localTestPorts(t)
	config := runtimeConfig{SessionID: "local-xray-integration", LeaseID: "local-lease", LeaseHeartbeatIntervalSeconds: 30, LeaseGraceSeconds: 120, Node: nodeSummary{ID: "local-node", Name: "本机测试节点", Region: "本地", Tags: []string{"integration"}, Protocol: "vless", Security: "reality", ServerHost: "127.0.0.1", ServerPort: 1}, Mode: "global", LocalHTTPPort: httpPort, LocalSocksPort: socksPort, Outbound: runtimeOutbound{Protocol: "vless", Server: "127.0.0.1", Port: 1, UUID: "11111111-1111-4111-8111-111111111111", Flow: "xtls-rprx-vision", RealityPublicKey: base64.RawURLEncoding.EncodeToString(make([]byte, 32)), ShortID: "0123456789abcdef", ServerName: "example.test", Fingerprint: "chrome", SpiderX: "/"}}
	config.Mode = "direct"
	if _, err := s.connect(context.Background(), config, false); err != nil {
		logs, _ := s.runtimeLogs()
		t.Fatalf("genuine Xray startup failed: %v; %v", err, logs)
	}
	t.Cleanup(func() { s.disconnect() })
	s.mu.Lock()
	status := s.runtime
	process := s.runtime.process
	s.mu.Unlock()
	if status.Status != "connected" || status.ActivePID == nil || *status.ActivePID == 0 {
		t.Fatal("genuine Xray not connected")
	}
	proxyMu.Lock()
	applied := state
	proxyMu.Unlock()
	if reflect.DeepEqual(applied, before) {
		t.Fatal("isolated proxy was not applied")
	}
	for _, port := range []int{config.LocalHTTPPort, config.LocalSocksPort} {
		conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), time.Second)
		if err != nil {
			t.Fatal("genuine Xray port unavailable", err)
		}
		conn.Close()
	}
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-ChordV-Test") != "native-local" {
			t.Error("local origin request contract mismatch")
		}
		io.WriteString(w, "ChordV genuine local Xray traffic")
	}))
	defer origin.Close()
	proxyURL, _ := url.Parse("http://127.0.0.1:" + strconv.Itoa(config.LocalHTTPPort))
	transport := &http.Transport{Proxy: http.ProxyURL(proxyURL)}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 3 * time.Second}
	request, _ := http.NewRequest("GET", origin.URL+"/native-e2e", nil)
	request.Header.Set("X-ChordV-Test", "native-local")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal("actual HTTP proxy traffic failed", err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || string(body) != "ChordV genuine local Xray traffic" {
		t.Fatal("actual HTTP proxy response invalid", response.StatusCode, string(body))
	}
	socks, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(config.LocalSocksPort), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	socks.SetDeadline(time.Now().Add(2 * time.Second))
	socks.Write([]byte{5, 1, 0})
	greeting := make([]byte, 2)
	_, err = io.ReadFull(socks, greeting)
	socks.Close()
	if err != nil || !reflect.DeepEqual(greeting, []byte{5, 0}) {
		t.Fatal("actual SOCKS5 handshake failed", greeting, err)
	}
	if err := process.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	waitForNativeRuntime(t, events, "error")
	proxyMu.Lock()
	restored := state
	proxyMu.Unlock()
	if !reflect.DeepEqual(restored, before) {
		t.Fatal("unexpected Xray exit did not restore isolated proxy")
	}
	config.Mode = "global"
	if _, err := s.connect(context.Background(), config, false); err != nil {
		t.Fatal("genuine Xray restart failed", err)
	}
	if _, err := s.disconnect(); err != nil {
		t.Fatal(err)
	}
	proxyMu.Lock()
	restored = state
	proxyMu.Unlock()
	if !reflect.DeepEqual(restored, before) {
		t.Fatal("disconnect did not restore exact blank/missing proxy fields")
	}
	if _, err := os.Stat(proxyJournalPath(s.cfg.DataDir)); !os.IsNotExist(err) {
		t.Fatal("completed recovery journal remains")
	}
}

func waitForNativeRuntime(t *testing.T, events <-chan NativeEvent, statuses ...string) string {
	t.Helper()
	timeout := time.NewTimer(8 * time.Second)
	defer timeout.Stop()
	for {
		select {
		case event := <-events:
			if event.Name != "chordv://runtime-status" {
				continue
			}
			var actual string
			switch value := event.Payload.(type) {
			case map[string]string:
				actual = value["status"]
			case runtimeState:
				actual = value.Status
			}
			for _, status := range statuses {
				if actual == status {
					return actual
				}
			}
		case <-timeout.C:
			t.Fatalf("native runtime event timeout, expected one of %v", statuses)
			return ""
		}
	}
}
