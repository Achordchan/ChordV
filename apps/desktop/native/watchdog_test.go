package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Only this test subprocess substitutes the OS proxy store with an isolated file.
func TestWatchdogHelperProcess(t *testing.T) {
	role := os.Getenv("CHORDV_TEST_WATCHDOG_ROLE")
	if role == "" {
		return
	}
	dir := os.Getenv("CHORDV_TEST_WATCHDOG_DIR")
	if role == "holder" {
		reader, writer, err := os.Pipe()
		if err != nil {
			os.Exit(2)
		}
		defer writer.Close()
		cmd := exec.Command(os.Args[0], "-test.run=^TestWatchdogHelperProcess$")
		cmd.Env = append(os.Environ(), "CHORDV_TEST_WATCHDOG_ROLE=watchdog")
		cmd.Stdin = reader
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		detachWatchdog(cmd)
		if cmd.Start() != nil {
			os.Exit(3)
		}
		if writeWatchdogHello(writer) != nil {
			os.Exit(5)
		}
		reader.Close()
		fmt.Fprintln(os.Stdout, "HOLDER_READY")
		io.Copy(io.Discard, os.Stdin)
		return
	}
	readProxySettings = func(context.Context) ([]proxySetting, error) {
		data, err := os.ReadFile(filepath.Join(dir, "test-proxy.json"))
		if err != nil {
			return nil, err
		}
		var settings []proxySetting
		err = json.Unmarshal(data, &settings)
		return settings, err
	}
	writeProxySetting = func(_ context.Context, setting proxySetting) error {
		return atomicJSON(filepath.Join(dir, "test-proxy.json"), []proxySetting{setting})
	}
	if err := runProxyWatchdog(dir); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(4)
	}
	fmt.Fprintln(os.Stdout, "WATCHDOG_RESTORED")
}

func TestIndependentWatchdogRestoresAfterParentIsKilled(t *testing.T) {
	if testing.Short() {
		t.Skip("subprocess lifecycle test")
	}
	dir := t.TempDir()
	before := proxySetting{Service: "test-only", Kind: "web", Values: map[string]string{"enabled": "Yes", "server": "previous.test", "port": "8899", "authenticated": "0"}}
	owned := testDesiredProxy(before, 10809, 10808)
	if err := atomicJSON(proxyJournalPath(dir), proxyJournal{Version: 1, Changes: []proxyChange{{Before: before, Owned: owned}}}); err != nil {
		t.Fatal(err)
	}
	atomicJSON(filepath.Join(dir, "test-proxy.json"), []proxySetting{owned})
	cmd := exec.Command(os.Args[0], "-test.run=^TestWatchdogHelperProcess$")
	prepareHolderGroup(cmd)
	cmd.Env = append(os.Environ(), "CHORDV_TEST_WATCHDOG_ROLE=holder", "CHORDV_TEST_WATCHDOG_DIR="+dir)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()
	lines := make(chan string, 8)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			lines <- scanner.Text()
		}
		close(lines)
	}()
	ready := false
	for !ready {
		select {
		case line := <-lines:
			if strings.Contains(line, "CHORDV_WATCHDOG_READY") {
				ready = true
			}
		case <-time.After(5 * time.Second):
			t.Fatal("watchdog handshake timeout")
		}
	}
	if err = killHolderGroup(cmd); err != nil {
		t.Fatal(err)
	}
	restored := false
	for !restored {
		select {
		case line, open := <-lines:
			if !open {
				t.Fatal("watchdog exited before recovery")
			}
			if strings.Contains(line, "WATCHDOG_RESTORED") {
				restored = true
			}
		case <-time.After(5 * time.Second):
			t.Fatal("watchdog recovery timeout after parent kill")
		}
	}
	_ = cmd.Wait()
	data, err := os.ReadFile(filepath.Join(dir, "test-proxy.json"))
	if err != nil {
		t.Fatal(err)
	}
	var state []proxySetting
	json.Unmarshal(data, &state)
	if len(state) != 1 || state[0].Values["server"] != "previous.test" || state[0].Values["port"] != "8899" {
		t.Fatal("previous proxy not restored", state)
	}
	if _, err := os.Stat(proxyJournalPath(dir)); !os.IsNotExist(err) {
		t.Fatal("completed watchdog journal remains")
	}
}
