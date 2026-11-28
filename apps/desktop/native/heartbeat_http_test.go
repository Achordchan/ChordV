package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestLeaseRefreshTemporaryFailureIsNotTerminal(t *testing.T) {
	for _, status := range []int{503, 429, 401, 403} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/auth/refresh" {
					w.WriteHeader(status)
					return
				}
				w.WriteHeader(401)
			}))
			defer server.Close()
			s := testService(t, server.URL)
			if err := s.sessions.save(s.sessionPath(), testSession("lease-http")); err != nil {
				t.Fatal(err)
			}
			result := s.leaseHeartbeatOnce(context.Background(), "lease-http")
			wantTerminal := status == 401 || status == 403
			if result.Terminal != wantTerminal || result.Status != "error" || result.Message == "" {
				t.Fatalf("refresh HTTP %d result=%+v", status, result)
			}
		})
	}
}

func TestLeaseHTTPResponseValidation(t *testing.T) {
	for _, scenario := range []struct {
		name         string
		status       int
		body         string
		ok, terminal bool
	}{
		{"active", 200, `{"sessionId":"lease-http","status":"active","leaseExpiresAt":"2099-01-01T00:00:00Z"}`, true, false},
		{"malformed-json", 200, `{`, false, false},
		{"missing-session", 200, `{"status":"active","leaseExpiresAt":"2099-01-01T00:00:00Z"}`, false, false},
		{"wrong-session", 200, `{"sessionId":"another","status":"expired"}`, false, false},
		{"missing-expiry", 200, `{"sessionId":"lease-http","status":"active"}`, false, false},
		{"bad-expiry", 200, `{"sessionId":"lease-http","status":"active","leaseExpiresAt":"tomorrow"}`, false, false},
		{"zero-expiry", 200, `{"sessionId":"lease-http","status":"active","leaseExpiresAt":"0001-01-01T00:00:00Z"}`, false, false},
		{"unknown-status", 200, `{"sessionId":"lease-http","status":"pending"}`, false, false},
		{"expired", 200, `{"sessionId":"lease-http","status":"expired","reasonCode":"session_expired","reasonMessage":"会话已过期"}`, false, true},
		{"revoked", 200, `{"sessionId":"lease-http","status":"revoked"}`, false, true},
		{"evicted", 200, `{"sessionId":"lease-http","status":"evicted","reasonCode":"connection_taken_over"}`, false, true},
		{"forbidden", 403, `{}`, false, true}, {"not-found", 404, `{}`, false, true}, {"conflict", 409, `{}`, false, true},
		{"bad-request", 400, `{}`, false, false}, {"throttled", 429, `{}`, false, false}, {"unavailable", 503, `{}`, false, false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body struct {
					SessionID string `json:"sessionId"`
				}
				if r.URL.Path != "/api/client/session/heartbeat" || r.Method != "POST" || r.Header.Get("Authorization") != "Bearer access-lease-http" || json.NewDecoder(r.Body).Decode(&body) != nil || body.SessionID != "lease-http" {
					t.Error("heartbeat HTTP request contract mismatch")
				}
				w.WriteHeader(scenario.status)
				fmt.Fprint(w, scenario.body)
			}))
			defer server.Close()
			s := testService(t, server.URL)
			if err := s.sessions.save(s.sessionPath(), testSession("lease-http")); err != nil {
				t.Fatal(err)
			}
			result := s.leaseHeartbeatOnce(context.Background(), "lease-http")
			if (result.Status == "ok") != scenario.ok || result.Terminal != scenario.terminal {
				t.Fatalf("response classification: %+v", result)
			}
			if !scenario.ok && (result.Message == "" || result.ReasonCode == "") {
				t.Fatalf("missing failure guidance: %+v", result)
			}
			if scenario.name == "evicted" && result.ReasonCode != "connection_taken_over" {
				t.Fatal("lost typed reason")
			}
		})
	}
}

func TestLeaseHTTPRefreshNetworkFailureAndRotation(t *testing.T) {
	for _, scenario := range []string{"network", "malformed", "rotate", "second-401"} {
		t.Run(scenario, func(t *testing.T) {
			var heartbeats atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/auth/refresh" {
					switch scenario {
					case "network":
						conn, _, _ := w.(http.Hijacker).Hijack()
						_ = conn.Close()
					case "malformed":
						fmt.Fprint(w, `{"accessToken":"partial"}`)
					default:
						w.Write(testSession("rotated"))
					}
					return
				}
				if heartbeats.Add(1) == 1 || scenario == "second-401" {
					w.WriteHeader(401)
					return
				}
				if r.Header.Get("Authorization") != "Bearer access-rotated" {
					t.Error("rotated token not used")
				}
				fmt.Fprint(w, `{"sessionId":"lease-http","status":"active","leaseExpiresAt":"2099-01-01T00:00:00Z"}`)
			}))
			defer server.Close()
			s := testService(t, server.URL)
			if err := s.sessions.save(s.sessionPath(), testSession("old")); err != nil {
				t.Fatal(err)
			}
			result := s.leaseHeartbeatOnce(context.Background(), "lease-http")
			if result.Terminal != (scenario == "second-401") || (result.Status == "ok") != (scenario == "rotate") {
				t.Fatalf("refresh %s: %+v", scenario, result)
			}
			if scenario == "rotate" || scenario == "second-401" {
				stored, err := s.sessions.load(s.sessionPath())
				if err != nil || tokenIdentity(stored) != tokenIdentity(testSession("rotated")) {
					t.Fatal("rotation not persisted", err)
				}
			}
		})
	}
}
