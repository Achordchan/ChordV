//go:build darwin

package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func macWait(t *testing.T, watch string, timeout time.Duration, condition func() bool) {
	t.Helper()
	dir, err := os.Open(watch)
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	kq, err := unix.Kqueue()
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(kq)
	var change unix.Kevent_t
	unix.SetKevent(&change, int(dir.Fd()), unix.EVFILT_VNODE, unix.EV_ADD|unix.EV_CLEAR)
	change.Fflags = unix.NOTE_WRITE | unix.NOTE_RENAME | unix.NOTE_DELETE | unix.NOTE_ATTRIB | unix.NOTE_EXTEND
	if _, err = unix.Kevent(kq, []unix.Kevent_t{change}, nil, nil); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(timeout)
	for {
		if condition() {
			return
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			t.Fatal("local update vnode event timeout")
		}
		limit := unix.NsecToTimespec(remaining.Nanoseconds())
		events := make([]unix.Kevent_t, 1)
		n, err := unix.Kevent(kq, nil, events, &limit)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		if n == 0 {
			t.Fatal("local update vnode event timeout")
		}
	}
}

func stopMacTestHelper(t *testing.T, h *macHolderProcess) bool {
	t.Helper()
	if h.helperPID == 0 {
		return true
	}
	identity, _ := processIdentity(context.Background(), h.helperPID)
	binary, _ := processExecutable(context.Background(), h.helperPID)
	expected := filepath.Join(h.work, macUpdateHelperBundleName, "Contents", "MacOS", filepath.Base(h.command.Path))
	if identity != h.helperIdentity || binary != expected {
		return true
	}
	fd, err := unix.Kqueue()
	if err != nil {
		t.Error(err)
		return false
	}
	defer unix.Close(fd)
	var change unix.Kevent_t
	unix.SetKevent(&change, h.helperPID, unix.EVFILT_PROC, unix.EV_ADD|unix.EV_ONESHOT)
	change.Fflags = unix.NOTE_EXIT
	if _, err = unix.Kevent(fd, []unix.Kevent_t{change}, nil, nil); errors.Is(err, unix.ESRCH) {
		return true
	} else if err != nil {
		t.Error(err)
		return false
	}
	process, err := os.FindProcess(h.helperPID)
	if err != nil {
		return true
	}
	if err = process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		t.Error(err)
		return false
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			t.Error("owned helper did not produce an EXIT event before deadline")
			return false
		}
		limit := unix.NsecToTimespec(remaining.Nanoseconds())
		events := make([]unix.Kevent_t, 1)
		n, err := unix.Kevent(fd, nil, events, &limit)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil || n != 1 || events[0].Filter != unix.EVFILT_PROC || events[0].Ident != uint64(h.helperPID) || events[0].Fflags&unix.NOTE_EXIT == 0 {
			t.Error("owned helper did not produce a matching EXIT event", err)
			return false
		}
		return true
	}
}

func assertMacNoMount(t *testing.T, work string, images ...string) {
	t.Helper()
	out, err := runMacUpdateCommand(context.Background(), 30*time.Second, "/usr/bin/hdiutil", "info", "-plist")
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range append([]string{work}, images...) {
		if path != "" && strings.Contains(string(out), path) {
			t.Fatalf("owned image or mount remains: %s", path)
		}
	}
}
