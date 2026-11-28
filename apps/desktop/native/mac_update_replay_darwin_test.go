//go:build darwin

package main

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestMacRecoveryReplayWithoutProviderPreservesEveryFile(t *testing.T) {
	f := newMacRecoveryFixture(t, false)
	anchor, err := deriveRecoveryAnchor(context.Background(), f.cfg, f.plan.Current.Executable)
	if err != nil {
		t.Fatal(err)
	}
	before := macRecoveryTree(t, f.root)
	result, err := replayMacUpdateRecovery(context.Background(), anchor, nil, nil)
	if err == nil || result != "needs_authority" || !reflect.DeepEqual(before, macRecoveryTree(t, f.root)) {
		t.Fatal("missing provider must preserve all files, including lock files", result, err)
	}
}

func TestMacRecoveryReplayKilledWorkerCanRetryWithoutSecondSwap(t *testing.T) {
	f := newMacRecoveryFixture(t, false)
	a := newMacReplayTestAuthority(t, f)
	if err := f.plan.swap(f.transaction.Current.Node, f.transaction.Candidate.Node); err != nil {
		t.Fatal(err)
	}
	first := startMacReplayTestRun(t, f, a, 5*time.Second, false)
	first.closePipe(t)
	before := macRecoveryTree(t, f.root)
	if err := unix.Kill(first.worker, unix.SIGKILL); err != nil {
		t.Fatal(err)
	}
	result := first.receive(t)
	first.exitParent(t)
	if result.Error == "" || !reflect.DeepEqual(before, macRecoveryTree(t, f.root)) {
		t.Fatal("worker SIGKILL changed application or forged success", result)
	}
	second := startMacReplayTestRun(t, f, a, 5*time.Second, false)
	second.closePipe(t)
	second.exitParent(t)
	result = second.receive(t)
	if result.Error != "" || result.State != "rolled_back_retained" {
		t.Fatal("fresh worker failed to resume exact authorized rollback", result)
	}
	if node, err := macNode(f.plan.Current.Path); err != nil || node != f.transaction.Current.Node {
		t.Fatal("fresh worker did not restore original A", node, err)
	}
}

func TestMacRecoveryReplayFreshWorkerWaitsForActualBExit(t *testing.T) {
	f := newMacRecoveryFixture(t, false)
	a := newMacReplayTestAuthority(t, f)
	if err := f.plan.swap(f.transaction.Current.Node, f.transaction.Candidate.Node); err != nil {
		t.Fatal(err)
	}
	run := startMacReplayTestRun(t, f, a, 8*time.Second, false)
	run.closePipe(t)
	select {
	case result := <-run.result:
		t.Fatal("EOF while B alive must not finish rollback", result)
	case <-time.After(150 * time.Millisecond):
	}
	if target, err := macNode(f.plan.Current.Path); err != nil || target != f.transaction.Candidate.Node {
		t.Fatal("EOF without matching EXIT changed B", target, err)
	}
	run.exitParent(t)
	result := run.receive(t)
	if result.State != "rolled_back_retained" || result.Error != "" {
		t.Fatal("authorized fresh-process rollback failed", result)
	}
	if target, err := macNode(f.plan.Current.Path); err != nil || target != f.transaction.Current.Node {
		t.Fatal("reverse CAS did not restore exact A", target, err)
	}
	if staged, err := macNode(f.transaction.Candidate.Path); err != nil || staged != f.transaction.Candidate.Node {
		t.Fatal("rollback deleted or changed B backup", staged, err)
	}
	anchor, err := deriveRecoveryAnchor(context.Background(), f.cfg, f.plan.Current.Executable)
	if err != nil {
		t.Fatal(err)
	}
	if state, err := replayMacUpdateRecovery(context.Background(), anchor, a, nil); err != nil || state != "original_retained" {
		t.Fatal("a retry must observe physical A and not swap again", state, err)
	}
	for _, name := range []string{"plan.json", "transaction.json", "helper"} {
		if _, err := os.Stat(filepath.Join(f.plan.Work, name)); err != nil {
			t.Fatal("partial recovery must retain all recovery artifacts", name, err)
		}
	}
}

func TestMacRecoveryReplayPhysicalRolesNeverUseJournalHealth(t *testing.T) {
	f := newMacRecoveryFixture(t, false)
	a := newMacReplayTestAuthority(t, f)
	run := func(want string) {
		t.Helper()
		anchor, err := deriveRecoveryAnchor(context.Background(), f.cfg, f.plan.Current.Executable)
		if err != nil {
			t.Fatal(err)
		}
		result, err := replayMacUpdateRecovery(context.Background(), anchor, a, nil)
		if result != want || (err != nil) != (want == "needs_parent_exit") {
			t.Fatal("unexpected replay", result, want, err)
		}
	}
	f.journal.Phase = "swapped"
	f.persist(t)
	run("original_retained")
	if err := f.plan.swap(f.transaction.Current.Node, f.transaction.Candidate.Node); err != nil {
		t.Fatal(err)
	}
	f.journal.Phase = "healthy"
	f.persist(t)
	if err := os.WriteFile(filepath.Join(f.plan.Work, "healthy.json"), []byte(`{"ok":true}`), 0600); err != nil {
		t.Fatal(err)
	}
	before := macRecoveryTree(t, f.root)
	run("needs_parent_exit")
	if !reflect.DeepEqual(before, macRecoveryTree(t, f.root)) {
		t.Fatal("plain healthy file or phase caused a mutation")
	}
	a.intent.Capability = "hold_candidate"
	run("healthy_retained")
	if !reflect.DeepEqual(before, macRecoveryTree(t, f.root)) {
		t.Fatal("authenticated health must retain backup in this partial executor")
	}
}
