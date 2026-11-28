//go:build linux

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func dconfProxyHTTP(t *testing.T, target string, body []byte) ([]byte, error) {
	t.Helper()
	setting := readActualDconf(t)
	if setting.Values["mode"] != "'manual'" || setting.Values["http.host"] != "'127.0.0.1'" {
		t.Fatal("actual dconf does not point to the active kernel", setting)
	}
	proxy, err := url.Parse("http://127.0.0.1:" + setting.Values["http.port"])
	if err != nil {
		t.Fatal(err)
	}
	transport := &http.Transport{Proxy: http.ProxyURL(proxy), DisableKeepAlives: true}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 4 * time.Second}
	response, err := client.Post(target, "application/octet-stream", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return nil, fmt.Errorf("local echo returned HTTP %d", response.StatusCode)
	}
	return io.ReadAll(io.LimitReader(response.Body, int64(len(body)+1)))
}

type dconfRuntimeFixture struct {
	service *DesktopService
	config  runtimeConfig
	echo    *httptest.Server
	hits    *atomic.Int32
	payload []byte
	peer    dconfTestProcess
}

func newDconfRuntimeFixture(t *testing.T, root string) dconfRuntimeFixture {
	t.Helper()
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/client/session/heartbeat" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"sessionId":"real-linux-dconf-loopback","status":"active","leaseExpiresAt":"2099-01-01T00:00:00Z"}`)
	}))
	t.Cleanup(api.Close)
	dir := filepath.Join(root, "data")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	s := newDesktopService(appConfig{DataDir: dir, APIBase: api.URL})
	t.Cleanup(s.cancel)
	prepareRealXrayFixture(t, s)
	t.Cleanup(func() { _, _ = s.disconnect() })
	t.Cleanup(func() {
		if t.Failed() {
			raw, _ := os.ReadFile(filepath.Join(s.cfg.DataDir, "runtime", "xray.log"))
			t.Logf("real runtime log: %s", raw)
		}
	})
	if err := s.sessions.save(s.sessionPath(), testSession("isolated-linux-real-runtime")); err != nil {
		t.Fatal(err)
	}
	binary, _ := s.componentPath("xray")
	hits := &atomic.Int32{}
	echo := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		_, _ = io.Copy(w, io.LimitReader(r.Body, 128*1024))
	}))
	t.Cleanup(echo.Close)
	outbound, peer := startDconfRealityServer(t, binary, echo.Listener.Addr().(*net.TCPAddr).Port)
	httpPort, socksPort := localTestPorts(t)
	config := runtimeConfig{SessionID: "real-linux-dconf-loopback", LeaseHeartbeatIntervalSeconds: 30, LeaseGraceSeconds: 300, Mode: "global", LocalHTTPPort: httpPort, LocalSocksPort: socksPort,
		Node: nodeSummary{ID: "real-local-reality", Name: "本地真实Reality", ServerHost: outbound.Server, ServerPort: outbound.Port, Protocol: "vless", Security: "reality"}, Outbound: outbound}
	payload := []byte(strings.Repeat("ChordV-real-Linux-Reality-", 4096))
	return dconfRuntimeFixture{s, config, echo, hits, payload, peer}
}

func testDconfRuntimeTraffic(t *testing.T, root string, original proxySetting) {
	f := newDconfRuntimeFixture(t, root)
	s, config, echo, hits, payload := f.service, f.config, f.echo, f.hits, f.payload
	outbound := config.Outbound
	interrupted := make(chan NativeEvent, 8)
	s.emit = func(event NativeEvent) {
		if state, ok := event.Payload.(map[string]string); ok && state["status"] == "error" {
			interrupted <- event
		}
	}
	connect := func() *proxyWatchdog {
		t.Helper()
		raw, _ := json.Marshal(map[string]any{"config": config, "forceTakeover": true})
		if _, err := s.Invoke(context.Background(), "connect_runtime", raw); err != nil {
			t.Fatal("real Invoke connect failed", err)
		}
		s.mu.Lock()
		guard := s.runtime.watchdog
		s.mu.Unlock()
		return guard
	}
	disconnect := func(guard *proxyWatchdog) {
		t.Helper()
		if _, err := s.Invoke(context.Background(), "disconnect_runtime", nil); err != nil {
			t.Fatal(err)
		}
		select {
		case <-guard.done:
		case <-time.After(10 * time.Second):
			t.Fatal("real disconnect left the independent watchdog running")
		}
		if got := readActualDconf(t); !reflect.DeepEqual(got, original) {
			t.Fatal("real disconnect did not restore dconf", got)
		}
	}
	guard := connect()
	if got, err := dconfProxyHTTP(t, echo.URL, payload); err != nil || !bytes.Equal(got, payload) || hits.Load() != 1 {
		t.Fatal("traffic did not round-trip through the real Reality peer", len(got), err, hits.Load())
	}
	if _, err := s.connect(context.Background(), config, true); err == nil {
		t.Fatal("duplicate connect replaced an active kernel")
	}
	disconnect(guard)
	config.Outbound.UUID = "22222222-2222-4222-8222-222222222222"
	guard = connect()
	if _, err := dconfProxyHTTP(t, echo.URL, payload); err == nil || hits.Load() != 1 {
		t.Fatal("wrong Reality user reached echo; the positive path may have bypassed the tunnel", err, hits.Load())
	}
	disconnect(guard)
	config.Outbound = outbound
	guard = connect()
	if got, err := dconfProxyHTTP(t, echo.URL, payload); err != nil || !bytes.Equal(got, payload) || hits.Load() != 2 {
		t.Fatal("reconnect lost the real data path", len(got), err, hits.Load())
	}
	s.mu.Lock()
	process, done := s.runtime.process, s.runtime.processDone
	s.mu.Unlock()
	if err := process.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	<-done
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	for {
		select {
		case event := <-interrupted:
			if state, ok := event.Payload.(map[string]string); ok && state["status"] == "error" {
				if got := readActualDconf(t); !reflect.DeepEqual(got, original) {
					t.Fatal("kernel crash did not restore the actual dconf snapshot", got)
				}
				select {
				case <-guard.done:
				case <-deadline.C:
					t.Fatal("kernel exit left its watchdog running")
				}
				if _, err := os.Stat(proxyJournalPath(s.cfg.DataDir)); !os.IsNotExist(err) {
					t.Fatal("successful crash recovery left journal", err)
				}
				t.Logf("genuine Xray Reality tunneled %d bytes twice, wrong-user negative control blocked, duplicate/connect/disconnect/reconnect/kernel-crash with real dconf restored; root=%s", len(payload), filepath.Base(root))
				return
			}
		case <-deadline.C:
			t.Fatal("kernel crash did not emit the actual terminal runtime event")
		}
	}
}

func runDconfRuntimeHolder(t *testing.T, root string) {
	f := newDconfRuntimeFixture(t, root)
	raw, _ := json.Marshal(map[string]any{"config": f.config, "forceTakeover": true})
	if _, err := f.service.Invoke(context.Background(), "connect_runtime", raw); err != nil {
		t.Fatal(err)
	}
	if got, err := dconfProxyHTTP(t, f.echo.URL, f.payload); err != nil || !bytes.Equal(got, f.payload) || f.hits.Load() != 1 {
		t.Fatal("holder must verify genuine tunnel traffic before reporting readiness", err)
	}
	f.service.mu.Lock()
	pid := f.service.runtime.process.Process.Pid
	f.service.mu.Unlock()
	graph := struct{ Holder, Target, Watchdog, Peer dconfTestProcess }{
		captureDconfProcess(t, os.Getpid()), captureDconfProcess(t, pid), watchdogDconfChild(t, filepath.Join(root, "data")), f.peer,
	}
	if err := json.NewEncoder(os.Stdout).Encode(graph); err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, os.Stdin)
}
