package main

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/egoist/mygo"
)

func TestAppReadyRejectsMissingNativeWindow(t *testing.T) {
	s := testService(t, "http://127.0.0.1:1")
	if _, err := s.Invoke(context.Background(), "app_ready", json.RawMessage(`{"input":{"screen":"login"}}`)); err == nil {
		t.Fatal("app_ready acknowledged without an initialized native window")
	}
}

func TestAppReadyChecksLocalReadinessWithoutNetwork(t *testing.T) {
	for _, state := range []string{"login", "main", "startup-failed", "quitting", "closed", "invalid-screen", "cancelled"} {
		t.Run(state, func(t *testing.T) {
			s := testService(t, "http://127.0.0.1:1")
			s.shell = &desktopShell{main: &mygo.Window{}}
			s.startupDone = make(chan struct{})
			close(s.startupDone)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			screen := "login"
			switch state {
			case "main":
				screen = state
			case "startup-failed":
				s.startupErr = errors.New("isolated startup recovery failed")
			case "quitting":
				s.shell.quitting = true
			case "closed":
				s.cancel()
			case "invalid-screen":
				screen = "splash"
			case "cancelled":
				cancel()
			}
			input, _ := json.Marshal(map[string]string{"screen": screen})
			err := s.confirmAppReady(ctx, input)
			if state == "login" || state == "main" {
				if err != nil {
					t.Fatal("offline local screen was not acknowledged", err)
				}
			} else if err == nil {
				t.Fatal("unready local screen was acknowledged")
			}
		})
	}
}

func TestAppReadyCannotBypassStartupBarrier(t *testing.T) {
	s := testService(t, "http://127.0.0.1:1")
	s.shell = &desktopShell{main: &mygo.Window{}}
	s.startupDone = make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- s.confirmAppReady(ctx, json.RawMessage(`{"screen":"login"}`)) }()
	select {
	case err := <-done:
		t.Fatal("acknowledged before startup completed", err)
	default:
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatal("startup wait did not honor cancellation", err)
	}
}

func TestShowWindowDoesNotWaitForStartup(t *testing.T) {
	s := testService(t, "http://127.0.0.1:1")
	s.startupDone = make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := s.Invoke(ctx, "show_main_window", nil); err != nil {
		t.Fatal("show command was incorrectly coupled to startup health", err)
	}
}

func TestArmedRecoveryShutdownKeepsStartupClosed(t *testing.T) {
	s := testService(t, "http://127.0.0.1:1")
	s.startupDone = make(chan struct{})
	s.startupErr = errMacRecoveryExitArmed
	close(s.startupDone)
	stream, stop := context.WithCancel(context.Background())
	defer stop()
	s.streams["startup"] = &eventStreamHandle{cancel: stop}
	download, finish, err := s.beginDownload(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer finish()
	if err := s.shutdown(); err != nil {
		t.Fatal(err)
	}
	if s.ctx.Err() == nil || stream.Err() == nil || download.Err() == nil || len(s.streams) != 0 {
		t.Fatal("armed handoff did not close service resources")
	}
	if _, err := s.connect(context.Background(), runtimeConfig{}, false); !errors.Is(err, errMacRecoveryExitArmed) {
		t.Fatalf("disconnect reopened startup during the armed exit: %v", err)
	}
}
