package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func awaitHandoffNativeEvent(t *testing.T, events <-chan NativeEvent, name, stream string) NativeEvent {
	t.Helper()
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	for {
		select {
		case event := <-events:
			if event.Name != name {
				continue
			}
			if stream != "" {
				raw, _ := json.Marshal(event.Payload)
				var payload struct {
					StreamID string `json:"streamId"`
				}
				if json.Unmarshal(raw, &payload) != nil || payload.StreamID != stream {
					continue
				}
			}
			return event
		case <-timer.C:
			t.Fatalf("安装启动失败后未收到真实原生事件 %s/%s", name, stream)
		}
	}
}

func TestInstallerHandoffStartFailurePreservesLiveSSEAndHeartbeat(t *testing.T) {
	sendOld := make(chan struct{}, 1)
	heartbeats := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/client/events/stream":
			if r.Header.Get("Authorization") != "Bearer access-handoff" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, ": ready\n\n")
			w.(http.Flusher).Flush()
			for {
				select {
				case <-r.Context().Done():
					return
				case <-sendOld:
					fmt.Fprint(w, "id: after-failed-install\ndata: {\"type\":\"subscription.updated\",\"payload\":{}}\n\n")
					w.(http.Flusher).Flush()
				}
			}
		case "/api/client/session/heartbeat":
			if r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer access-handoff" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			var input struct {
				SessionID string `json:"sessionId"`
			}
			if json.NewDecoder(r.Body).Decode(&input) != nil || input.SessionID != "handoff-session" {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"sessionId":"handoff-session","status":"active","leaseExpiresAt":"2099-01-01T00:00:00Z"}`)
			heartbeats <- struct{}{}
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	s, p := installerHandoffFixture(t, server.URL)
	events := make(chan NativeEvent, 32)
	s.emit = func(event NativeEvent) { events <- event }
	startStream := func(id string) {
		input, _ := json.Marshal(eventStreamInput{StreamID: id, AccessToken: "access-handoff"})
		if _, err := s.startEventStream(input); err != nil {
			t.Fatal(err)
		}
		awaitHandoffNativeEvent(t, events, "chordv://client-runtime-event-open", id)
	}
	startStream("before-install")
	originalContext := s.ctx
	launchErr := errors.New("test-only installer start failure")
	if _, err := s.handoffInstaller(context.Background(), p, installerHandoffOps{start: func(string) error { return launchErr }, quit: func() { t.Fatal("启动失败仍退出") }}); !errors.Is(err, launchErr) {
		t.Fatal(err)
	}
	sendOld <- struct{}{}
	awaitHandoffNativeEvent(t, events, "chordv://client-runtime-event", "before-install")
	startStream("after-install")
	if s.ctx != originalContext || s.ctx.Err() != nil {
		t.Fatal("失败后替换或取消了根上下文")
	}
	if err := s.sessions.save(s.sessionPath(), testSession("handoff")); err != nil {
		t.Fatal(err)
	}
	config := leaseTestConfig()
	config.SessionID = "handoff-session"
	s.mu.Lock()
	s.runtime = runtimeState{Status: "connected", ActiveSessionID: pointer(config.SessionID), Config: &config}
	s.mu.Unlock()
	heartbeatCtx, cancel := context.WithCancel(s.ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.leaseHeartbeatLoop(heartbeatCtx, config)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Error("心跳 goroutine 未结束")
		}
	})
	select {
	case <-heartbeats:
	case <-time.After(2 * time.Second):
		t.Fatal("失败后同根上下文未发出真实 HTTP 租约心跳")
	}
	event := awaitHandoffNativeEvent(t, events, "chordv://native-lease-heartbeat", "")
	payload, _ := event.Payload.(map[string]any)
	if payload["status"] != "ok" {
		t.Fatal("租约心跳未正常处理本地响应", payload)
	}
}
