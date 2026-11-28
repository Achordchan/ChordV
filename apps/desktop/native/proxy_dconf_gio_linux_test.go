//go:build linux

package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func invokeDefaultGIO(t *testing.T, uri, payload string) ([]byte, string, error) {
	t.Helper()
	probe := os.Getenv("CHORDV_TEST_GIO_PROBE")
	if !filepath.IsAbs(probe) {
		t.Fatal("system GIO probe must be explicitly provisioned at an absolute path")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	args := []string{uri}
	if payload != "" {
		args = append(args, payload)
	}
	command := exec.CommandContext(ctx, probe, args...)
	command.Env = os.Environ()
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	err := command.Run()
	if ctx.Err() != nil {
		t.Fatal("system GIO probe exceeded its own deadline", stderr.String(), ctx.Err())
	}
	if !strings.Contains(stderr.String(), "resolver=GProxyResolverGnome\n") {
		t.Fatal("system selected a different resolver; this is not GNOME discovery", stderr.String(), err)
	}
	return stdout.Bytes(), stderr.String(), err
}

func requireGIOProxyList(t *testing.T, observation, expected string) {
	t.Helper()
	var proxies []string
	for _, line := range strings.Split(observation, "\n") {
		if proxy, found := strings.CutPrefix(line, "proxy="); found {
			proxies = append(proxies, proxy)
		}
	}
	if !reflect.DeepEqual(proxies, []string{expected}) {
		t.Fatal("system GIO returned an unexpected proxy or direct fallback", proxies, expected, observation)
	}
}

func testDconfDefaultGIO(t *testing.T, root string, original proxySetting) {
	f := newDconfRuntimeFixture(t, root)
	uri := strings.Replace(f.echo.URL, "127.0.0.1", "chordv-proxy-target.test", 1) + "/"
	file := filepath.Join(root, "gio-payload.bin")
	if err := os.WriteFile(file, f.payload, 0600); err != nil {
		t.Fatal(err)
	}
	lookup := func(target, proxy string) {
		t.Helper()
		_, observation, err := invokeDefaultGIO(t, target, "")
		if err != nil {
			t.Fatal("default GIO lookup differs from actual GNOME state", observation, err)
		}
		requireGIOProxyList(t, observation, proxy)
	}
	lookup(uri, "direct://")
	connect := func() *proxyWatchdog {
		t.Helper()
		raw, _ := json.Marshal(map[string]any{"config": f.config, "forceTakeover": true})
		if _, err := f.service.Invoke(context.Background(), "connect_runtime", raw); err != nil {
			t.Fatal(err)
		}
		f.service.mu.Lock()
		guard := f.service.runtime.watchdog
		f.service.mu.Unlock()
		return guard
	}
	disconnect := func(guard *proxyWatchdog) {
		t.Helper()
		if _, err := f.service.Invoke(context.Background(), "disconnect_runtime", nil); err != nil {
			t.Fatal(err)
		}
		select {
		case <-guard.done:
		case <-time.After(10 * time.Second):
			t.Fatal("GIO connection left watchdog running after disconnect")
		}
		if got := readActualDconf(t); !reflect.DeepEqual(got, original) {
			t.Fatal("GIO test did not restore the exact dconf snapshot", got)
		}
		lookup(uri, "direct://")
	}
	roundTrip := func(target string) (*http.Response, error) {
		raw, observation, err := invokeDefaultGIO(t, target, file)
		requireGIOProxyList(t, observation, fmt.Sprintf("http://127.0.0.1:%d", f.config.LocalHTTPPort))
		if !strings.Contains(observation, "proxy-negotiating\n") {
			t.Fatal("GIO request did not reach negotiation with the selected proxy", observation, err)
		}
		if err != nil {
			exit, ok := err.(*exec.ExitError)
			if !ok || exit.ExitCode() != 5 && exit.ExitCode() != 8 {
				t.Fatal("GIO failed outside a network connect/stream operation", observation, err)
			}
			t.Logf("GIO network failure after proxy selection and negotiation began: %s (%v)", observation, err)
			return nil, err
		}
		if !strings.Contains(observation, "proxy-negotiated\n") || !strings.Contains(observation, fmt.Sprintf("proxy=http://127.0.0.1:%d\n", f.config.LocalHTTPPort)) {
			return nil, fmt.Errorf("default GIO did not negotiate the production proxy: %s", observation)
		}
		return http.ReadResponse(bufio.NewReader(bytes.NewReader(raw)), nil)
	}
	request := func(wantHits int32) error {
		response, err := roundTrip(uri)
		if err != nil {
			return err
		}
		defer response.Body.Close()
		body, err := io.ReadAll(io.LimitReader(response.Body, int64(len(f.payload)+1)))
		if err != nil || response.StatusCode != 200 || !bytes.Equal(body, f.payload) || f.hits.Load() != wantHits {
			return fmt.Errorf("default GIO tunneled echo mismatch: HTTP=%d bytes=%d hits=%d error=%v", response.StatusCode, len(body), f.hits.Load(), err)
		}
		return nil
	}
	guard := connect()
	lookup(uri, fmt.Sprintf("http://127.0.0.1:%d", f.config.LocalHTTPPort))
	lookup(f.echo.URL, "direct://") // Existing loopback exclusions must remain honored.
	if err := request(1); err != nil {
		t.Fatal("default GIO real tunnel failed", err)
	}
	var deniedHits atomic.Int32
	denied := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		deniedHits.Add(1)
		_, _ = w.Write(f.payload)
	}))
	defer denied.Close()
	transport := &http.Transport{Proxy: nil}
	defer transport.CloseIdleConnections()
	direct := &http.Client{Transport: transport, Timeout: 4 * time.Second}
	positive, err := direct.Get(denied.URL)
	if err != nil {
		t.Fatal("non-echo target must be reachable directly before the policy control", err)
	}
	_, err = io.Copy(io.Discard, positive.Body)
	_ = positive.Body.Close()
	if err != nil || positive.StatusCode != 200 || deniedHits.Load() != 1 {
		t.Fatal("non-echo target direct positive control failed", err)
	}
	deniedHits.Store(0)
	deniedURI := strings.Replace(denied.URL, "127.0.0.1", "chordv-proxy-target.test", 1) + "/"
	blocked, blockedErr := roundTrip(deniedURI)
	if blocked != nil {
		_ = blocked.Body.Close()
	}
	if blockedErr == nil && blocked.StatusCode == 200 || deniedHits.Load() != 0 {
		t.Fatal("Reality test peer escaped its exact echo-port allow rule", deniedHits.Load(), blockedErr)
	}
	t.Logf("directly reachable non-echo port rejected through real default-GIO proxy: %v", blockedErr)
	disconnect(guard)
	originalOutbound := f.config.Outbound
	f.config.Outbound.UUID = "22222222-2222-4222-8222-222222222222"
	guard = connect()
	negativeErr := request(2)
	if negativeErr == nil || f.hits.Load() != 1 {
		t.Fatal("wrong-user control reached echo; GIO may have bypassed the real tunnel", negativeErr, f.hits.Load())
	}
	t.Logf("wrong-user request failed after validated GNOME selection/proxy negotiation, echo hits remain 1: %v", negativeErr)
	disconnect(guard)
	f.config.Outbound = originalOutbound
	guard = connect()
	if err := request(2); err != nil {
		t.Fatal("default GIO reconnect failed", err)
	}
	disconnect(guard)
	t.Logf("unmodified system default GNOME resolver and GSocketClient negotiated actual dconf proxy, %d bytes twice; wrong-user blocked, loopback exclusions preserved, disconnected lookups direct", len(f.payload))
}
