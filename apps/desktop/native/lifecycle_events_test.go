package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"
	"testing/synctest"
)

func TestStaleWatchdogExitDoesNotDisconnectReplacement(t *testing.T) {
	s := testService(t, "http://127.0.0.1:1")
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()
	synctest.Test(t, func(t *testing.T) {
		startup := make(chan struct{})
		s.startupDone = startup
		old := &proxyWatchdog{done: make(chan error)}
		current := &proxyWatchdog{pipe: writer}
		s.runtime.Status, s.runtime.watchdog = "connected", old
		var events []NativeEvent
		s.emit = func(event NativeEvent) { events = append(events, event) }
		go s.monitorWatchdog(old)
		close(old.done)
		synctest.Wait() // The exit handler has reached the startup gate.
		s.operationMu.Lock()
		s.mu.Lock()
		s.runtime.watchdog = current
		s.mu.Unlock()
		s.operationMu.Unlock()
		close(startup)
		synctest.Wait()
		if s.runtime.watchdog != current || s.runtime.Status != "connected" || len(events) != 0 {
			t.Fatalf("old watchdog affected the replacement connection: status=%s events=%+v", s.runtime.Status, events)
		}
	})
}

func TestLifecycleFailureEventsPreserveOperationContext(t *testing.T) {
	for _, operation := range []string{"watchdog-restored", "watchdog-restore-failed", "kernel-restore-failed", "shutdown-failed"} {
		t.Run(operation, func(t *testing.T) {
			s := testService(t, "http://127.0.0.1:1")
			before := proxySetting{Service: "test-only", Kind: "web", Values: map[string]string{"enabled": "No"}}
			owned := testDesiredProxy(before, 10809, 10808)
			testProxySettings(t, []proxySetting{owned})
			if err := atomicJSON(proxyJournalPath(s.cfg.DataDir), proxyJournal{Version: 1, Changes: []proxyChange{{Before: before, Owned: owned}}}); err != nil {
				t.Fatal(err)
			}
			if operation != "watchdog-restored" {
				writeProxySetting = func(context.Context, proxySetting) error { return errors.New("permission denied") }
			}
			var events []NativeEvent
			s.emit = func(event NativeEvent) { events = append(events, event) }
			if strings.HasPrefix(operation, "watchdog") {
				reader, writer, err := os.Pipe()
				if err != nil {
					t.Fatal(err)
				}
				defer reader.Close()
				defer writer.Close()
				guard := &proxyWatchdog{pipe: writer, done: make(chan error)}
				close(guard.done)
				s.runtime.Status, s.runtime.watchdog = "connected", guard
				s.monitorWatchdog(guard)
			} else if operation == "kernel-restore-failed" {
				process := &exec.Cmd{}
				s.runtime.process = process
				s.runtimeExited(process)
			} else if s.shutdown() == nil {
				t.Fatal("shutdown unexpectedly succeeded")
			}
			wanted := "chordv://runtime-interrupted"
			if operation == "shutdown-failed" {
				wanted = "chordv://exit-cleanup-failed"
			}
			found := false
			for _, event := range events {
				if event.Name == "chordv://exit-cleanup-failed" && operation != "shutdown-failed" {
					t.Fatalf("non-exit operation emitted exit failure: %+v", event)
				}
				if event.Name != wanted {
					continue
				}
				found = true
				if operation == "shutdown-failed" {
					continue
				}
				data, _ := json.Marshal(event.Payload)
				var payload struct {
					Cause         string `json:"cause"`
					ProxyRestored bool   `json:"proxyRestored"`
					Message       string `json:"message"`
				}
				if err := json.Unmarshal(data, &payload); err != nil {
					t.Fatal(err)
				}
				cause := "watchdog-exited"
				if operation == "kernel-restore-failed" {
					cause = "kernel-exited"
				}
				if payload.Cause != cause || payload.ProxyRestored != (operation == "watchdog-restored") || payload.Message == "" {
					t.Fatalf("incorrect interruption context: %s", data)
				}
			}
			if !found {
				t.Fatalf("missing %s: %+v", wanted, events)
			}
		})
	}
}
