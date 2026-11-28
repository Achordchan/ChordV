//go:build darwin

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestMacUpdateLiveHelperDefersForOrdinaryLaunchGateHolder(t *testing.T) {
	f := macFixture(t, "13.0")
	h := startMacHolder(t, f)
	h.ready(t)
	gate, err := lockMacTargetLaunch(f.Current, false)
	if err != nil {
		t.Fatal(err)
	}
	defer gate.Close()
	_, _ = fmt.Fprintln(h.pipe, "ARM")
	if got := h.line(t); got != "ARMED" {
		t.Fatal(got)
	}
	_, _ = fmt.Fprintln(h.pipe, "EXIT")
	if err := <-h.done; err != nil {
		t.Fatal(err)
	}
	var report []byte
	macWait(t, filepath.Join(f.DataDir, "updater"), 40*time.Second, func() bool {
		report, _ = os.ReadFile(filepath.Join(f.DataDir, "updater", "install-report.json"))
		return len(report) > 0
	})
	if !strings.Contains(string(report), errMacTargetLaunchBusy.Error()) {
		t.Fatalf("live helper did not decline a swap with an ordinary launch in progress: %s", report)
	}
	installed, err := readMacBundle(context.Background(), f.Current, true)
	if err != nil || installed.Node != f.CurrentInfo.Node || !macBundleSealMatches(installed, f.CurrentInfo) {
		t.Fatal("live helper changed the locked installation", err)
	}
	if _, err = os.Lstat(f.Marker + ".pid"); !os.IsNotExist(err) {
		t.Fatal("candidate started under contended launch gate", err)
	}
	for _, path := range []string{h.work, filepath.Join(f.DataDir, "updater", "mac-update-journal.json")} {
		if _, err = os.Lstat(path); !os.IsNotExist(err) {
			t.Fatalf("contended update did not clean its own prepared state: %s: %v", path, err)
		}
	}
}

func TestMacUpdatePackagedOrdinaryLaunchIsExcludedDuringSwap(t *testing.T) {
	ctx, candidate := macHealthPackagedCandidate(t)
	gate, err := lockMacTargetLaunch(candidate.Path, true)
	if err != nil {
		t.Fatal(err)
	}
	defer gate.Close()
	for _, name := range []string{"data-a", "data-b"} {
		root := filepath.Dir(candidate.Path)
		data := filepath.Join(root, name)
		childCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		child := exec.CommandContext(childCtx, candidate.Executable)
		child.Env = append(systemProcessEnvironment(), "CHORDV_MYGO_DATA_DIR="+data, "CHORDV_API_BASE_URL=http://127.0.0.1:1")
		if name == "data-b" {
			child.Env = append(child.Env, "HOME="+root, "TMPDIR="+root)
		}
		output, runErr := child.CombinedOutput()
		cancel()
		if _, err = os.Lstat(data); !os.IsNotExist(err) {
			t.Fatalf("ordinary candidate initialized data while its installed path was exclusively locked: %s, %v", name, err)
		}
		if runErr == nil || !strings.Contains(string(output), errMacTargetLaunchBusy.Error()) {
			t.Fatalf("ordinary candidate did not report blocked startup: %v %s", runErr, output)
		}
	}
	if err = gate.Close(); err != nil {
		t.Fatal(err)
	}
	data := filepath.Join(filepath.Dir(candidate.Path), "data-after-swap")
	childCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	child := exec.CommandContext(childCtx, candidate.Executable)
	child.Env = append(systemProcessEnvironment(), "CHORDV_MYGO_DATA_DIR="+data, "CHORDV_API_BASE_URL=http://127.0.0.1:1")
	output, _ := child.CombinedOutput()
	if _, err = os.Stat(data); err != nil {
		t.Fatalf("ordinary launch remained blocked after releasing the gate: %v %s", err, output)
	}
}

func TestMacRecoveryReplayDefersForOrdinaryLaunchGateHolder(t *testing.T) {
	f := newMacRecoveryFixture(t, false)
	a := newMacReplayTestAuthority(t, f)
	if err := f.plan.swap(f.transaction.Current.Node, f.transaction.Candidate.Node); err != nil {
		t.Fatal(err)
	}
	gate, err := lockMacTargetLaunch(f.plan.Current.Path, false)
	if err != nil {
		t.Fatal(err)
	}
	defer gate.Close()
	run := startMacReplayTestRun(t, f, a, 12*time.Second, false)
	before := macRecoveryTree(t, f.root)
	run.closePipe(t)
	run.exitParent(t)
	result := run.receive(t)
	if result.State != "deferred" || !strings.Contains(result.Error, errMacTargetLaunchBusy.Error()) || !reflect.DeepEqual(before, macRecoveryTree(t, f.root)) {
		t.Fatal("replay did not preserve both bundles for a concurrent ordinary start", result)
	}
	if err = gate.Close(); err != nil {
		t.Fatal(err)
	}
	run = startMacReplayTestRun(t, f, a, 12*time.Second, false)
	run.closePipe(t)
	run.exitParent(t)
	result = run.receive(t)
	if result.Error != "" || result.State != "rolled_back_retained" {
		t.Fatal("replay did not proceed after ordinary launch released its gate", result)
	}
}

func TestMacTargetLaunchLocksAreScopedByInstallAndMode(t *testing.T) {
	root, err := macCanonical(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "Installed.app")
	shared, err := lockMacTargetLaunch(path, false)
	if err != nil {
		t.Fatal(err)
	}
	defer shared.Close()
	if lock, err := lockMacTargetLaunch(strings.ToUpper(path), true); !errors.Is(err, errMacTargetLaunchBusy) {
		if lock != nil {
			lock.Close()
		}
		t.Fatal("same installed path did not contend", err)
	}
	other, err := lockMacTargetLaunch(filepath.Join(root, "Other.app"), true)
	if err != nil {
		t.Fatal("unrelated installation did not get its own lock", err)
	}
	other.Close()
}
