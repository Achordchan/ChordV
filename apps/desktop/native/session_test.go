package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestSessionClearRejectsRetiredCredentials(t *testing.T) {
	s := testService(t, "http://127.0.0.1:3100")
	old := testSession("old")
	if err := s.sessions.save(s.sessionPath(), old); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(s.sessionPath())
	if info.Mode().Perm() != 0600 {
		t.Fatal("session not owner-only")
	}
	if err := s.sessions.clear(s.sessionPath()); err != nil {
		t.Fatal(err)
	}
	if err := s.sessions.save(s.sessionPath(), old); err == nil {
		t.Fatal("old session restored after logout")
	}
	if data, err := s.sessions.load(s.sessionPath()); err != nil || data != nil {
		t.Fatal("logged-out session readable")
	}
	if err := s.sessions.save(s.sessionPath(), testSession("new-login")); err != nil {
		t.Fatal(err)
	}
}
func TestFailedClearKeepsTombstoneAndBlocksOldReads(t *testing.T) {
	s := testService(t, "http://127.0.0.1:3100")
	old := testSession("old")
	s.sessions.save(s.sessionPath(), old)
	if err := s.sessions.clearWith(s.sessionPath(), func() error { return errors.New("proxy restore pending") }); err == nil {
		t.Fatal("cleanup failure ignored")
	}
	if _, err := os.Stat(s.sessionPath()); err != nil {
		t.Fatal("session file unexpectedly removed")
	}
	if data, err := s.sessions.load(s.sessionPath()); err != nil || data != nil {
		t.Fatal("failed clear exposed stale credentials")
	}
	if err := s.sessions.save(s.sessionPath(), old); err == nil {
		t.Fatal("retired token accepted")
	}
}
func TestSessionRefreshCannotOverwriteNewLogin(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release
		w.Header().Set("Content-Type", "application/json")
		w.Write(testSession("rotated"))
	}))
	defer server.Close()
	s := testService(t, server.URL)
	s.sessions.save(s.sessionPath(), testSession("old"))
	result := make(chan error, 1)
	go func() { _, err := s.refreshSession(context.Background(), nil); result <- err }()
	<-started
	if err := s.sessions.save(s.sessionPath(), testSession("new-login")); err != nil {
		t.Fatal(err)
	}
	close(release)
	if err := <-result; err == nil {
		t.Fatal("late refresh accepted")
	}
	data, _ := s.sessions.load(s.sessionPath())
	if tokenIdentity(data) != tokenIdentity(testSession("new-login")) {
		t.Fatal("new login overwritten")
	}
}
func TestSessionRefreshSurvivesRedundantSaveAndRetiresOldToken(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release
		w.Write(testSession("rotated"))
	}))
	defer server.Close()
	s := testService(t, server.URL)
	old := testSession("old")
	s.sessions.save(s.sessionPath(), old)
	events := make(chan NativeEvent, 1)
	s.emit = func(event NativeEvent) { events <- event }
	result := make(chan error, 1)
	go func() { _, err := s.refreshSession(context.Background(), nil); result <- err }()
	<-started
	s.sessions.save(s.sessionPath(), old)
	close(release)
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	if err := s.sessions.save(s.sessionPath(), old); err == nil {
		t.Fatal("rotated old token accepted")
	}
	event := <-events
	if event.Name != "chordv://native-session-refreshed" {
		t.Fatal("refresh event not delivered")
	}
}
func TestSessionRejectsInvalidJSONAndNeverCreatesFile(t *testing.T) {
	s := testService(t, "http://127.0.0.1:3100")
	if err := s.sessions.save(s.sessionPath(), []byte(`{"accessToken":"partial"}`)); err == nil {
		t.Fatal("invalid credentials accepted")
	}
	if _, err := os.Stat(filepath.Join(s.cfg.DataDir, "session.json")); !os.IsNotExist(err) {
		t.Fatal("invalid credentials persisted")
	}
}
