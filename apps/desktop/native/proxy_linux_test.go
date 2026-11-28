//go:build linux

package main

import (
	"context"
	"os"
	"runtime"
	"strconv"
	"testing"
)

func TestLinuxProcessIdentityActualStatChanges(t *testing.T) {
	pid := os.Getpid()
	first, err := processIdentity(context.Background(), pid)
	if err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		t.Fatal(err)
	}
	// Page allocation changes real /proc counters without changing process identity.
	memory := make([]byte, 32*1024*1024)
	for n := 0; n < len(memory); n += 4096 {
		memory[n] = byte(n / 4096)
	}
	runtime.KeepAlive(memory)
	after, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		t.Fatal(err)
	}
	second, err := processIdentity(context.Background(), pid)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) == string(after) {
		t.Fatal("real stat counters did not change; old identity bug was not exercised")
	}
	if first != second {
		t.Fatal("mutable kernel counters changed process identity", first, second)
	}
	executable, err := processExecutable(context.Background(), pid)
	if err != nil || executable == "" {
		t.Fatal("real /proc exe read failed", err)
	}
	t.Logf("old full stat bytes changed; stable pid:starttime:boot-id=%s executable=%s", first, executable)
}

func TestLinuxUnsupportedSessionNeverInvokesSettings(t *testing.T) {
	t.Setenv("XDG_CURRENT_DESKTOP", "KDE")
	t.Setenv("DBUS_SESSION_BUS_ADDRESS", "")
	if _, err := platformReadProxy(context.Background()); err == nil {
		t.Fatal("unsupported Linux desktop accepted")
	}
	if err := platformWriteProxy(context.Background(), gnomeTestSnapshot("'none'")); err == nil {
		t.Fatal("unsupported session wrote settings")
	}
}
