package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestNativePresenceUsesServerGETContractAndThrottles(t *testing.T) {
	var calls atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/client/ping", func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Authorization") == "" || r.ContentLength > 0 {
			t.Error("presence must send authenticated GET without a request body")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	server := httptest.NewServer(mux)
	defer server.Close()
	s := testService(t, server.URL)
	if err := s.sessions.save(s.sessionPath(), testSession("presence")); err != nil {
		t.Fatal(err)
	}
	if err := s.nudgePresence(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := s.nudgePresence(context.Background()); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("GET presence calls = %d, want one successful, throttled report", calls.Load())
	}
}

func TestNativePresenceHTTPFailureIsNotReportedAsSuccess(t *testing.T) {
	for _, status := range []int{401, 405, 503} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(status) }))
			defer server.Close()
			s := testService(t, server.URL)
			if err := s.sessions.save(s.sessionPath(), testSession("presence")); err != nil {
				t.Fatal(err)
			}
			if err := s.nudgePresence(context.Background()); err == nil {
				t.Fatal("failed presence report was silently accepted")
			}
		})
	}
}
