package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestLeaseLoopPublishesExplicitTerminal(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(403) }))
	defer server.Close()
	s := testService(t, server.URL)
	if err := s.sessions.save(s.sessionPath(), testSession("loop")); err != nil {
		t.Fatal(err)
	}
	config := leaseTestConfig()
	s.runtime = runtimeState{Status: "connected", ActiveSessionID: pointer(config.SessionID), Config: &config}
	events := make(chan NativeEvent, 8)
	s.emit = func(event NativeEvent) { events <- event }
	s.leaseHeartbeatLoop(context.Background(), config)
	event := awaitHandoffNativeEvent(t, events, "chordv://native-lease-heartbeat", "")
	payload := event.Payload.(map[string]any)
	if payload["terminal"] != true || payload["reasonCode"] != "session_invalid" {
		t.Fatalf("missing explicit terminal: %#v", payload)
	}
	status, err := s.Invoke(context.Background(), "runtime_status", nil)
	if err != nil || status.(runtimeState).Status != "idle" {
		t.Fatalf("terminal did not stop owned runtime: %+v %v", status, err)
	}
}

func TestLeaseGraceEventsUseFirstFailureAndResetOnSuccess(t *testing.T) {
	s := testService(t, "http://127.0.0.1:1")
	config := leaseTestConfig()
	s.runtime = runtimeState{Status: "connected", ActiveSessionID: pointer(config.SessionID), Config: &config}
	events := make(chan NativeEvent, 16)
	s.emit = func(event NativeEvent) { events <- event }
	var failures leaseFailureWindow
	start := time.Unix(1700000000, 0)
	for _, step := range []struct {
		seconds      int
		ok, terminal bool
	}{
		{0, true, false}, {1000, false, false}, {1299, false, false}, {1300, true, false},
		{2000, false, false}, {2299, false, false}, {2300, false, true},
	} {
		result := temporaryLeaseFailure()
		if step.ok {
			result = leaseHeartbeatResult{Status: "ok", LeaseExpiresAt: "2099-01-01T00:00:00Z"}
		}
		more := s.completeLeaseHeartbeat(context.Background(), &config, &failures, result, start.Add(time.Duration(step.seconds)*time.Second))
		event := awaitHandoffNativeEvent(t, events, "chordv://native-lease-heartbeat", "")
		payload := event.Payload.(map[string]any)
		if more == step.terminal || payload["terminal"] != step.terminal {
			t.Fatalf("time=%d: more=%v payload=%+v", step.seconds, more, payload)
		}
		if step.terminal && (payload["reasonCode"] != "heartbeat_grace_exceeded" || payload["message"] == nil) {
			t.Fatal("grace terminal omitted cause")
		}
	}
	status, _ := s.Invoke(context.Background(), "runtime_status", nil)
	if status.(runtimeState).Status != "idle" {
		t.Fatal("grace terminal did not finish disconnect")
	}
}

func TestLeaseCleanupFailurePreservesJournalAndReportsError(t *testing.T) {
	s := testService(t, "http://127.0.0.1:1")
	config := leaseTestConfig()
	s.runtime = runtimeState{Status: "connected", ActiveSessionID: pointer(config.SessionID), Config: &config}
	journal := proxyJournalPath(s.cfg.DataDir)
	if err := os.WriteFile(journal, []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	events := make(chan NativeEvent, 16)
	s.emit = func(event NativeEvent) { events <- event }
	result := leaseHeartbeatResult{Status: "error", Terminal: true, ReasonCode: "session_expired", Message: "连接会话已过期"}
	if s.completeLeaseHeartbeat(context.Background(), &config, &leaseFailureWindow{}, result, time.Now()) {
		t.Fatal("terminal continued")
	}
	event := awaitHandoffNativeEvent(t, events, "chordv://runtime-interrupted", "")
	interrupted := event.Payload.(runtimeInterruption)
	if interrupted.ProxyRestored || interrupted.Cause != "lease-ended" || !strings.Contains(interrupted.Message, "重试断开") {
		t.Fatalf("cleanup failure suppressed: %+v", interrupted)
	}
	status, _ := s.Invoke(context.Background(), "runtime_status", nil)
	if status.(runtimeState).Status != "error" || status.(runtimeState).LastError == nil {
		t.Fatal("cleanup failure reported success")
	}
	if _, err := os.Stat(journal); err != nil {
		t.Fatal("failed recovery removed journal", err)
	}
	if _, err := s.Invoke(context.Background(), "disconnect_runtime", nil); err == nil {
		t.Fatal("retry falsely reported recovery")
	}
	if err := os.Remove(journal); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Invoke(context.Background(), "disconnect_runtime", nil); err != nil {
		t.Fatal("retry after journal repair failed", err)
	}
}

func TestLeaseCancelledCompletionDoesNotEmitOrStop(t *testing.T) {
	s := testService(t, "http://127.0.0.1:1")
	config := leaseTestConfig()
	s.runtime = runtimeState{Status: "connected", Config: &config}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	s.emit = func(NativeEvent) { t.Error("cancelled response emitted") }
	if s.completeLeaseHeartbeat(ctx, &config, &leaseFailureWindow{}, leaseHeartbeatResult{Status: "error", Terminal: true}, time.Now()) || s.runtime.Status != "connected" {
		t.Fatal("cancelled response affected runtime")
	}
}

func TestLeaseLateResponseCannotStopReplacementRuntime(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(started); <-release; w.WriteHeader(403) }))
	defer server.Close()
	s := testService(t, server.URL)
	if err := s.sessions.save(s.sessionPath(), testSession("loop")); err != nil {
		t.Fatal(err)
	}
	old := leaseTestConfig()
	s.runtime = runtimeState{Status: "connected", ActiveSessionID: pointer(old.SessionID), Config: &old}
	events := make(chan NativeEvent, 8)
	s.emit = func(event NativeEvent) { events <- event }
	done := make(chan struct{})
	go func() { defer close(done); s.leaseHeartbeatLoop(context.Background(), old) }()
	<-started
	next := leaseTestConfig()
	next.SessionID = old.SessionID // Reusing the session ID must still reject the old runtime owner.
	s.operationMu.Lock()
	s.mu.Lock()
	s.runtime = runtimeState{Status: "connected", ActiveSessionID: pointer(next.SessionID), Config: &next}
	s.mu.Unlock()
	s.operationMu.Unlock()
	close(release)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("old heartbeat did not exit")
	}
	status, _ := s.Invoke(context.Background(), "runtime_status", nil)
	if status.(runtimeState).Status != "connected" || status.(runtimeState).Config != &next {
		t.Fatal("old response stopped replacement runtime")
	}
	if len(events) != 0 {
		t.Fatal("old response emitted events after replacement")
	}
}
