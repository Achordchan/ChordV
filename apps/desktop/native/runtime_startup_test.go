package main

import (
	"context"
	"errors"
	"io"
	"os"
	"reflect"
	"sync"
	"testing"
	"time"
)

func TestRealXrayAbortDuringProxySetupNeverReportsConnected(t *testing.T) {
	for _, reason := range []string{"kernel-exit", "cancelled", "watchdog-exit"} {
		t.Run(reason, func(t *testing.T) {
			s := testService(t, "http://127.0.0.1:1")
			prepareRealXrayFixture(t, s)
			read, write, launch, authorize := readProxySettings, writeProxySetting, launchProxyWatchdog, prepareProxyAuthorization
			t.Cleanup(func() {
				readProxySettings, writeProxySetting, launchProxyWatchdog, prepareProxyAuthorization = read, write, launch, authorize
			})
			before := proxySetting{Service: "e2e-startup-proxy", Kind: "windows", Values: map[string]string{"ProxyEnable": "0", "ProxyServer": "", "ProxyOverride": "<local>", "AutoConfigURL": "", "AutoDetect": "0"}}
			state := before
			var proxyMu sync.Mutex
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			interrupted := false
			var finishWatchdog func(error)
			readProxySettings = func(context.Context) ([]proxySetting, error) {
				proxyMu.Lock()
				defer proxyMu.Unlock()
				return []proxySetting{state}, nil
			}
			writeProxySetting = func(_ context.Context, setting proxySetting) error {
				proxyMu.Lock()
				state = setting
				proxyMu.Unlock()
				if !interrupted && setting.Values["ProxyEnable"] == "1" {
					interrupted = true
					if reason == "cancelled" {
						cancel()
					} else if reason == "watchdog-exit" {
						finishWatchdog(errors.New("test-only watchdog exited"))
					} else {
						s.mu.Lock()
						process, done := s.runtime.process, s.runtime.processDone
						s.mu.Unlock()
						if err := process.Process.Kill(); err != nil {
							return err
						}
						select {
						case <-done:
						case <-time.After(3 * time.Second):
							return errors.New("真实内核未按预期退出")
						}
					}
				}
				return nil
			}
			prepareProxyAuthorization = func() error { return nil }
			launchProxyWatchdog = func(string) (*proxyWatchdog, error) {
				r, w, err := os.Pipe()
				if err != nil {
					return nil, err
				}
				guard := &proxyWatchdog{pipe: w, done: make(chan error, 1)}
				var once sync.Once
				finishWatchdog = func(err error) { once.Do(func() { guard.done <- err; close(guard.done) }) }
				go func() { _, err := io.Copy(io.Discard, r); r.Close(); finishWatchdog(err) }()
				return guard, nil
			}
			t.Cleanup(func() { s.disconnect() })
			connected := 0
			s.emit = func(event NativeEvent) {
				if value, ok := event.Payload.(runtimeState); ok && value.Status == "connected" {
					connected++
				}
			}
			httpPort, socksPort := localTestPorts(t)
			config := runtimeConfig{SessionID: "isolated-startup-abort", LeaseHeartbeatIntervalSeconds: 30, LeaseGraceSeconds: 300, Mode: "direct", LocalHTTPPort: httpPort, LocalSocksPort: socksPort,
				Node:     nodeSummary{ID: "local-only", Name: "启动中断测试", ServerHost: "127.0.0.1", ServerPort: 1, Protocol: "vless", Security: "reality"},
				Outbound: runtimeOutbound{Protocol: "vless", Server: "127.0.0.1", Port: 1, UUID: "11111111-1111-4111-8111-111111111111", ServerName: "example.test", RealityPublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", Fingerprint: "chrome"}}
			_, err := s.connect(ctx, config, false)
			if !interrupted {
				t.Fatal("没有实际到达代理设置中断点", err)
			}
			if err == nil {
				t.Fatal("代理设置期间已中断，仍返回连接成功")
			}
			if reason == "cancelled" && !errors.Is(err, context.Canceled) {
				t.Fatal("丢失取消原因", err)
			}
			if connected != 0 {
				t.Fatal("启动已中断却发布已连接事件")
			}
			proxyMu.Lock()
			restored := state
			proxyMu.Unlock()
			if !reflect.DeepEqual(restored, before) {
				t.Fatal("启动中断后没有恢复隔离代理原值")
			}
			s.mu.Lock()
			status, process := s.runtime.Status, s.runtime.process
			s.mu.Unlock()
			if status != "error" || process != nil {
				t.Fatal("启动中断后仍保留活动内核", status)
			}
			if _, err := os.Stat(proxyJournalPath(s.cfg.DataDir)); !os.IsNotExist(err) {
				t.Fatal("已成功恢复但journal仍残留", err)
			}
		})
	}
}
