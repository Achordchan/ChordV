//go:build e2e && darwin

package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestLeaseLockedXrayPrivateProxyLifecycle(t *testing.T) {
	for _, scenario := range []string{"grace-recovery", "expired", "restore-locked", "other-owner", "stale-response"} {
		t.Run(scenario, func(t *testing.T) {
			var mode atomic.Int32
			staleStarted, staleRelease := make(chan struct{}), make(chan struct{})
			defer func() {
				select {
				case <-staleRelease:
				default:
					close(staleRelease)
				}
			}()
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var request struct {
					SessionID string `json:"sessionId"`
				}
				if r.URL.Path != "/api/client/session/heartbeat" || json.NewDecoder(r.Body).Decode(&request) != nil {
					http.NotFound(w, r)
					return
				}
				switch mode.Load() {
				case 412:
					close(staleStarted)
					<-staleRelease
					fmt.Fprintf(w, `{"sessionId":%q,"status":"expired","reasonCode":"session_expired"}`, request.SessionID)
				case 503:
					w.WriteHeader(503)
				case 410:
					fmt.Fprintf(w, `{"sessionId":%q,"status":"expired","reasonCode":"session_expired","reasonMessage":"连接会话已过期"}`, request.SessionID)
				default:
					fmt.Fprintf(w, `{"sessionId":%q,"status":"active","leaseExpiresAt":"2099-01-01T00:00:00Z"}`, request.SessionID)
				}
			}))
			t.Cleanup(api.Close)
			state, cfg, original := e2eProxyFixture(t)
			cfg.APIBase = api.URL
			installE2EWatchdogProfile(t, cfg, state)
			s := newDesktopService(cfg)
			t.Cleanup(s.cancel)
			prepareRealXrayFixture(t, s)
			t.Cleanup(func() { _, _ = s.disconnect() })
			if err := s.sessions.save(s.sessionPath(), testSession("lease-runtime")); err != nil {
				t.Fatal(err)
			}
			httpPort, socksPort := localTestPorts(t)
			config := leaseTestConfig()
			config.LocalHTTPPort, config.LocalSocksPort = httpPort, socksPort
			config.LeaseHeartbeatIntervalSeconds = 2147483
			config.LeaseGraceSeconds = 30
			config.Outbound = runtimeOutbound{Protocol: "vless", Server: "127.0.0.1", Port: 1, UUID: "11111111-1111-4111-8111-111111111111", RealityPublicKey: base64.RawURLEncoding.EncodeToString(make([]byte, 32)), ShortID: "0123456789abcdef", ServerName: "example.test", Fingerprint: "chrome"}
			events := make(chan NativeEvent, 64)
			s.emit = func(event NativeEvent) { events <- event }
			payload, _ := json.Marshal(map[string]any{"config": config})
			if _, err := s.Invoke(context.Background(), "connect_runtime", payload); err != nil {
				t.Fatal(err)
			}
			initial := awaitHandoffNativeEvent(t, events, "chordv://native-lease-heartbeat", "").Payload.(map[string]any)
			if initial["terminal"] != false || initial["status"] != "ok" {
				t.Fatal("initial native loop did not renew", initial)
			}
			s.mu.Lock()
			owner, done, guard := s.runtime.Config, s.runtime.processDone, s.runtime.watchdog
			s.mu.Unlock()
			if owner == nil || done == nil || guard == nil {
				t.Fatal("Invoke did not start real owned kernel/watchdog")
			}
			var failures leaseFailureWindow
			start := time.Unix(1700000000, 0)
			if scenario == "stale-response" {
				mode.Store(412)
				late := make(chan leaseHeartbeatResult, 1)
				go func() { late <- s.leaseHeartbeatOnce(context.Background(), config.SessionID) }()
				<-staleStarted
				if _, err := s.Invoke(context.Background(), "disconnect_runtime", nil); err != nil {
					t.Fatal(err)
				}
				select {
				case <-done:
				case <-time.After(3 * time.Second):
					t.Fatal("old real Xray remained live")
				}
				select {
				case <-guard.done:
				case <-time.After(8 * time.Second):
					t.Fatal("old watchdog remained live")
				}
				mode.Store(0)
				if _, err := s.Invoke(context.Background(), "connect_runtime", payload); err != nil {
					t.Fatal("replacement connect", err)
				}
				awaitHandoffNativeEvent(t, events, "chordv://native-lease-heartbeat", "")
				close(staleRelease)
				if s.completeLeaseHeartbeat(context.Background(), owner, &failures, <-late, start) {
					t.Fatal("late result continued")
				}
				s.mu.Lock()
				newOwner, newDone, newGuard, status := s.runtime.Config, s.runtime.processDone, s.runtime.watchdog, s.runtime.Status
				s.mu.Unlock()
				if newOwner == owner || status != "connected" {
					t.Fatal("late HTTP result stopped replacement real Xray")
				}
				select {
				case <-newDone:
					t.Fatal("replacement kernel exited")
				default:
				}
				owner, done, guard = newOwner, newDone, newGuard
			}
			if scenario == "grace-recovery" {
				for _, step := range []struct {
					seconds int
					status  int32
				}{{1000, 503}, {1029, 503}, {1030, 0}, {2000, 503}, {2029, 503}, {2030, 503}} {
					mode.Store(step.status)
					result := s.leaseHeartbeatOnce(context.Background(), config.SessionID)
					more := s.completeLeaseHeartbeat(context.Background(), owner, &failures, result, start.Add(time.Duration(step.seconds)*time.Second))
					if more != (step.seconds != 2030) {
						t.Fatalf("first-failure/recovery timing at %d", step.seconds)
					}
					if more {
						select {
						case <-done:
							t.Fatal("kernel stopped before failure grace")
						default:
						}
					}
				}
			} else {
				if scenario == "other-owner" {
					data, err := os.ReadFile(state)
					if err != nil {
						t.Fatal(err)
					}
					var alien e2eProxyDocument
					if err := json.Unmarshal(data, &alien); err != nil {
						t.Fatal(err)
					}
					alien.Settings[0].Values["ProxyServer"] = "http=127.0.0.1:49998"
					writeE2EProxyDocument(t, state, alien)
					original = alien
				}
				var locked *os.File
				if scenario == "restore-locked" {
					var err error
					locked, err = os.OpenFile(state, os.O_RDWR, 0600)
					if err != nil {
						t.Fatal(err)
					}
					defer locked.Close()
					if err := unix.Flock(int(locked.Fd()), unix.LOCK_EX); err != nil {
						t.Fatal(err)
					}
					defer unix.Flock(int(locked.Fd()), unix.LOCK_UN)
				}
				mode.Store(410)
				result := s.leaseHeartbeatOnce(context.Background(), config.SessionID)
				if !result.Terminal || result.ReasonCode != "session_expired" {
					t.Fatal("real HTTP terminal not classified", result)
				}
				if s.completeLeaseHeartbeat(context.Background(), owner, &failures, result, start) {
					t.Fatal("expired heartbeat continued")
				}
				if locked != nil {
					interruption := awaitHandoffNativeEvent(t, events, "chordv://runtime-interrupted", "").Payload.(runtimeInterruption)
					if interruption.ProxyRestored || interruption.Cause != "lease-ended" {
						t.Fatal("locked file restoration falsely succeeded", interruption)
					}
					if _, err := os.Stat(proxyJournalPath(cfg.DataDir)); err != nil {
						t.Fatal("failed restoration removed journal", err)
					}
					status, _ := s.Invoke(context.Background(), "runtime_status", nil)
					if status.(runtimeState).Status != "error" {
						t.Fatal("failed restoration lacks error status")
					}
					if err := unix.Flock(int(locked.Fd()), unix.LOCK_UN); err != nil {
						t.Fatal(err)
					}
					if _, err := s.Invoke(context.Background(), "disconnect_runtime", nil); err != nil {
						t.Fatal("recovery retry failed", err)
					}
				}
			}
			select {
			case <-done:
			case <-time.After(3 * time.Second):
				t.Fatal("lease terminal did not stop real Xray")
			}
			select {
			case err := <-guard.done:
				if err != nil {
					t.Fatal("isolated watchdog exit failed", err)
				}
			case <-time.After(8 * time.Second):
				t.Fatal("watchdog remained live")
			}
			settings, err := readProxySettings(context.Background())
			if err != nil || !reflect.DeepEqual(settings, original.Settings) {
				t.Fatal("proxy ownership/restoration failed", settings, err)
			}
			if _, err := os.Stat(proxyJournalPath(cfg.DataDir)); !os.IsNotExist(err) {
				t.Fatal("successful cleanup retained journal", err)
			}
			t.Logf("real Xray stopped; private file proxy and independent watchdog verified: %s", scenario)
		})
	}
}
