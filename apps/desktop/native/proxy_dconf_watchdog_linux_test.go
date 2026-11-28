//go:build linux

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

type dconfTestProcess struct {
	PID              int
	Binary, Identity string
}

func captureDconfProcess(t *testing.T, pid int) dconfTestProcess {
	t.Helper()
	binary, err := processExecutable(context.Background(), pid)
	if err != nil {
		t.Fatal(err)
	}
	identity, err := processIdentity(context.Background(), pid)
	if err != nil {
		t.Fatal(err)
	}
	return dconfTestProcess{pid, binary, identity}
}

func stopDconfProcess(p dconfTestProcess) {
	identity, err := processIdentity(context.Background(), p.PID)
	if err != nil || identity != p.Identity {
		return
	}
	binary, err := processExecutable(context.Background(), p.PID)
	if err == nil && binary == p.Binary {
		if process, err := os.FindProcess(p.PID); err == nil {
			_ = process.Kill()
		}
	}
}

func startDconfTarget(t *testing.T) (*exec.Cmd, <-chan error) {
	t.Helper()
	command := exec.Command("/bin/sleep", "120")
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait(); close(done) }()
	t.Cleanup(func() { _ = command.Process.Kill(); <-done })
	return command, done
}

func startDconfTakeover(t *testing.T, root string, target *exec.Cmd) (*DesktopService, *proxyWatchdog) {
	t.Helper()
	dir := filepath.Join(root, "data")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	s := newDesktopService(appConfig{DataDir: dir})
	t.Cleanup(s.cancel)
	binary, err := processExecutable(context.Background(), target.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	guard, err := s.takeProxy(context.Background(), 10809, 10808, target.Process.Pid, binary, true)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = guard.Close() })
	return s, guard
}

func assertDconfRestored(t *testing.T, root string, before proxySetting) {
	t.Helper()
	actual, err := platformReadProxy(context.Background())
	if err != nil || len(actual) != 1 || !reflect.DeepEqual(actual[0], before) {
		t.Fatal("independent child did not restore the actual session dconf", actual, err)
	}
	if _, err = os.Stat(proxyJournalPath(filepath.Join(root, "data"))); !os.IsNotExist(err) {
		t.Fatal("successful real dconf recovery left its journal", err)
	}
}

func testRealDconfWatchdogEOF(t *testing.T, root string, original proxySetting) {
	target, targetDone := startDconfTarget(t)
	_, guard := startDconfTakeover(t, root, target)
	if got := realDconfCommand(t, "get", "org.gnome.system.proxy.http", "port"); got != "10809" {
		t.Fatal("actual dconf takeover did not happen", got)
	}
	if err := guard.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-guard.done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("real watchdog EOF exit timed out")
	}
	select {
	case <-targetDone:
	case <-time.After(time.Second):
		t.Fatal("real watchdog did not stop its recorded target")
	}
	assertDconfRestored(t, root, original)
	t.Log("actual Linux dconf, original takeProxy/startProxyWatchdog/main entry, EOF restoration and exact owned process exit")
}

func testRealDconfForeignChange(t *testing.T, root string) {
	target, targetDone := startDconfTarget(t)
	_, guard := startDconfTakeover(t, root, target)
	realDconfCommand(t, "set", "org.gnome.system.proxy.http", "host", "'foreign.test'")
	foreign, err := platformReadProxy(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err = guard.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-guard.done:
	case <-time.After(20 * time.Second):
		t.Fatal("bounded watchdog retries did not terminate")
	}
	actual, err := platformReadProxy(context.Background())
	if err != nil || !reflect.DeepEqual(actual, foreign) {
		t.Fatal("watchdog overwrote a foreign dconf modification", actual, err)
	}
	for _, name := range []string{"proxy-journal.json", "watchdog-error.json"} {
		if _, err = os.Stat(filepath.Join(root, "data", name)); err != nil {
			t.Fatal("unresolved real dconf recovery lost its evidence", name, err)
		}
	}
	if _, err = processIdentity(context.Background(), target.Process.Pid); err != nil {
		t.Fatal("watchdog killed the target despite unresolved foreign proxy state", err)
	}
	select {
	case <-targetDone:
		t.Fatal("target exited despite unresolved foreign proxy state")
	default:
	}
	t.Log("foreign actual dconf value preserved; finite recovery retries retain journal/error and do not kill the target")
}

func watchdogDconfChild(t *testing.T, dir string) dconfTestProcess {
	t.Helper()
	paths, err := filepath.Glob("/proc/self/task/*/children")
	if err != nil {
		t.Fatal(err)
	}
	found := map[int]dconfTestProcess{}
	for _, path := range paths {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		for _, value := range strings.Fields(string(raw)) {
			pid, _ := strconv.Atoi(value)
			args, err := os.ReadFile(filepath.Join("/proc", value, "cmdline"))
			if err != nil {
				continue
			}
			if string(args) == os.Args[0]+"\x00--proxy-watchdog\x00"+dir+"\x00" {
				found[pid] = captureDconfProcess(t, pid)
			}
		}
	}
	if len(found) != 1 {
		t.Fatal("expected exactly one actual independent watchdog child", found)
	}
	for _, process := range found {
		return process
	}
	panic("unreachable")
}

func runDconfWatchdogHolder(t *testing.T, root string) {
	target, _ := startDconfTarget(t)
	_, guard := startDconfTakeover(t, root, target)
	defer guard.Close()
	ready := struct{ Holder, Target, Watchdog dconfTestProcess }{captureDconfProcess(t, os.Getpid()), captureDconfProcess(t, target.Process.Pid), watchdogDconfChild(t, filepath.Join(root, "data"))}
	if err := json.NewEncoder(os.Stdout).Encode(ready); err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, os.Stdin)
}

func waitDconfPidfd(t *testing.T, fd int, role string) {
	t.Helper()
	fds := []unix.PollFd{{Fd: int32(fd), Events: unix.POLLIN}}
	if n, err := unix.Poll(fds, 10000); err != nil || n != 1 || fds[0].Revents&unix.POLLIN == 0 {
		t.Fatal("kernel pidfd exit notification missing", role, n, err)
	}
}

func testRealDconfWatchdogSIGKILL(t *testing.T, root string, original proxySetting, role string) {
	command := exec.Command(os.Args[0], "-test.run=^TestLinuxDconfSessionHelper$")
	command.Env = append(os.Environ(), "CHORDV_DCONF_TEST_ROLE="+role)
	input, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	output, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	command.Stderr = os.Stderr
	if err = command.Start(); err != nil {
		t.Fatal(err)
	}
	var ready struct{ Holder, Target, Watchdog, Peer dconfTestProcess }
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	t.Cleanup(func() {
		stopDconfProcess(ready.Target)
		stopDconfProcess(ready.Watchdog)
		_ = command.Process.Kill()
		if ready.Peer.PID > 0 {
			fd, err := unix.PidfdOpen(ready.Peer.PID, 0)
			stopDconfProcess(ready.Peer)
			if err == nil {
				defer unix.Close(fd)
				waitDconfPidfd(t, fd, "isolated Reality peer")
			}
		}
	})
	type holderResult struct {
		processes struct{ Holder, Target, Watchdog, Peer dconfTestProcess }
		err       error
	}
	decoded := make(chan holderResult, 1)
	go func() {
		var result holderResult
		result.err = json.NewDecoder(output).Decode(&result.processes)
		decoded <- result
	}()
	select {
	case result := <-decoded:
		if result.err != nil {
			t.Fatal(result.err)
		}
		ready = result.processes
	case <-time.After(10 * time.Second):
		t.Fatal("actual holder takeover handshake timed out")
	}
	if ready.Holder.PID != command.Process.Pid || ready.Target.PID == ready.Watchdog.PID || ready.Watchdog.PID == ready.Holder.PID {
		t.Fatal("not an independent holder/target/watchdog process graph", ready)
	}
	fds := []int{}
	for _, process := range []dconfTestProcess{ready.Target, ready.Watchdog} {
		fd, err := unix.PidfdOpen(process.PID, 0)
		if err != nil {
			t.Fatal(err)
		}
		defer unix.Close(fd)
		fds = append(fds, fd)
	}
	if err = command.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err = <-done; err == nil {
		t.Fatal("holder was not actually SIGKILLed")
	}
	for index, fd := range fds {
		waitDconfPidfd(t, fd, fmt.Sprint(index))
	}
	assertDconfRestored(t, root, original)
	t.Logf("real holder SIGKILL -> kernel pipe EOF -> independent main watchdog -> dconf restored and owned target exited; graph=%+v", ready)
}
