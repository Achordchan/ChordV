//go:build darwin

package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"
)

type macRecoveryStartupReadHook struct {
	macRecoverySlotBackend
	once  sync.Once
	run   func()
	fault error
}

func (b *macRecoveryStartupReadHook) read(ctx context.Context, key string) ([]byte, error) {
	if b.fault != nil {
		return nil, b.fault
	}
	data, err := b.macRecoverySlotBackend.read(ctx, key)
	b.once.Do(b.run)
	return data, err
}

func TestMacStartupRecoveryUsesExactProtectedRoute(t *testing.T) {
	for _, tc := range []struct{ mode, state string }{
		{"empty-install", "none"}, {"legacy-journal", "legacy_pending"}, {"unbound-reservation", "aborted_unbound"},
		{"restored-original", "kept_original"}, {"original-after-work-removed", "kept_original"}, {"exact-candidate-needs-handoff", "needs_exit_handoff"},
		{"candidate-helper-still-alive", "blocked"}, {"same-signature-other-install", "blocked"},
		{"healthy-before-checkpoint", "kept_candidate"}, {"healthy-before-journal-update", "kept_candidate"},
		{"healthy-after-journal-removed", "kept_candidate"}, {"health-peer-mismatch", "blocked"},
		{"slot-replaced-before-lock", "blocked"}, {"data-lock-held", "blocked"}, {"provider-denied", "blocked"},
	} {
		t.Run(tc.mode, func(t *testing.T) {
			ctx := context.Background()
			f := newMacRecoveryFixtureWithHelper(t, tc.mode == "candidate-helper-still-alive", true)
			healthyFixture := tc.state == "kept_candidate" || tc.mode == "health-peer-mismatch"
			if tc.mode == "legacy-journal" {
				f.journal.Phase = "healthy" // A plain success claim is still not a capability.
			}
			if healthyFixture {
				f.journal.Phase = "healthy"
				if tc.mode == "healthy-before-journal-update" || tc.mode == "health-peer-mismatch" {
					f.journal.Phase = "launch_requested"
				}
			}
			intent := newMacReplayTestAuthority(t, f).intent
			proof := macRollbackFixtureHealth(intent)
			if healthyFixture {
				f.journal.CandidatePID, f.journal.CandidateIdentity = proof.PID, proof.ProcessIdentity
				if tc.mode == "health-peer-mismatch" {
					f.journal.CandidateIdentity += "-modified"
				}
				f.persist(t)
			}
			journal := filepath.Join(intent.DataDir, "updater", "mac-update-journal.json")
			store, backend, arm := macRollbackCleanupFixture(t, f, intent)
			switch tc.mode {
			case "empty-install", "legacy-journal", "unbound-reservation":
				delete(backend.items, store.key) // private fixture starts with no slot
			}
			switch tc.mode {
			case "empty-install":
				if err := os.RemoveAll(filepath.Join(intent.DataDir, "updater")); err != nil {
					t.Fatal(err)
				}
			case "unbound-reservation":
				if err := store.reserve(ctx, arm); err != nil {
					t.Fatal(err)
				}
				prepared, err := pendingAbortJournal(arm.Intent, macRecoveryPendingAbort{Phase: "armed"}, "")
				if err != nil {
					t.Fatal(err)
				}
				if err := atomicFile(journal, prepared, 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Remove(filepath.Join(intent.Work, "transaction.json")); err != nil {
					t.Fatal(err)
				}
			case "exact-candidate-needs-handoff", "candidate-helper-still-alive", "healthy-before-checkpoint", "healthy-before-journal-update", "healthy-after-journal-removed", "health-peer-mismatch":
				if err := f.plan.swap(intent.Current.Node, intent.Candidate.Node); err != nil {
					t.Fatal(err)
				}
			case "same-signature-other-install":
				moved := filepath.Join(f.root, "preserved-original.app")
				if err := os.Rename(intent.Target, moved); err != nil {
					t.Fatal(err)
				}
				if _, err := runMacUpdateCommand(ctx, 30*time.Second, "/usr/bin/ditto", moved, intent.Target); err != nil {
					t.Fatal(err)
				}
			}
			if healthyFixture {
				if err := store.markHealthy(ctx, intent, proof); err != nil {
					t.Fatal(err)
				}
			}
			if tc.mode == "healthy-after-journal-removed" || tc.mode == "original-after-work-removed" {
				raw, err := readMacRecoveryFile(journal)
				if err != nil {
					t.Fatal(err)
				}
				installed, staged := intent.Current.Node, intent.Candidate.Node
				if tc.mode == "healthy-after-journal-removed" {
					healthy := intent
					healthy.Capability = "hold_candidate"
					if err := store.checkpointCleanup(ctx, macRecoveryCleanupCheckpoint{Intent: healthy, JournalSHA256: macPlanDigest(raw)}); err != nil {
						t.Fatal(err)
					}
					installed, staged = staged, installed
				} else if err := store.checkpointRollbackCleanup(ctx, intent, macPlanDigest(raw)); err != nil {
					t.Fatal(err)
				}
				scope := macCleanupScope{target: intent.Target, parent: intent.Filesystem.Parent, workspace: intent.Filesystem.Work,
					installed: installed, staged: staged, helper: f.plan.HelperBundle, detachedOnly: true}
				if err := cleanupMacUpdateWorkWithScope(intent.Work, &scope); err != nil {
					t.Fatal(err)
				}
				if tc.mode == "healthy-after-journal-removed" {
					if err := os.Remove(journal); err != nil {
						t.Fatal(err)
					}
				}
			}
			if tc.mode == "slot-replaced-before-lock" {
				originalStore := store
				store = openTestMacRecoverySlot(t, &macRecoveryStartupReadHook{macRecoverySlotBackend: backend, run: func() {
					if err := originalStore.markHealthy(ctx, intent, proof); err != nil {
						t.Fatal(err)
					}
				}}, intent)
			}
			denied := errors.New("isolated authorization backend denied access")
			if tc.mode == "provider-denied" {
				store = openTestMacRecoverySlot(t, &macRecoveryStartupReadHook{macRecoverySlotBackend: backend, fault: denied}, intent)
			}
			if tc.state != "none" && tc.state != "legacy_pending" {
				target, err := f.plan.targetLock()
				if err != nil {
					t.Fatal(err)
				}
				target.Close()
				data, err := lockMacUpdateData(intent.DataDir)
				if err != nil {
					t.Fatal(err)
				}
				if tc.mode == "data-lock-held" {
					defer data.Close()
				} else {
					data.Close()
				}
			}
			anchor, err := deriveRecoveryAnchor(ctx, f.cfg, intent.Current.Executable)
			if err != nil {
				t.Fatal(err)
			}
			var candidatePID int
			if tc.mode == "exact-candidate-needs-handoff" {
				pid, stop := startMacReplayExtraProcess(t, anchor.bundle.Executable)
				defer stop()
				candidatePID = pid
			}
			before := macRecoveryTree(t, f.root)
			beforeSlot, _ := backend.read(ctx, store.key)
			state, err := runMacStartupRecovery(ctx, anchor, store)
			if state != tc.state || ((state == "blocked" || state == "needs_exit_handoff") != (err != nil)) {
				t.Fatal("wrong startup recovery route", state, err)
			}
			if tc.mode == "provider-denied" && !errors.Is(err, denied) {
				t.Fatal("denied provider was treated like an absent slot", err)
			}
			if candidatePID != 0 {
				if live, err := macHealthProcessPath(candidatePID); err != nil || live != anchor.bundle.Executable {
					t.Fatal("startup signalled or replaced the candidate without a real exit handoff", err)
				}
			}
			switch state {
			case "aborted_unbound", "kept_original", "kept_candidate":
				for _, path := range []string{intent.Work, journal} {
					if _, err := os.Lstat(path); !os.IsNotExist(err) {
						t.Fatal("completed route retained its journal or workspace", err)
					}
				}
				if _, _, err := store.load(ctx); !errors.Is(err, errMacRecoverySlotMissing) {
					t.Fatal("completed route retained its slot", err)
				}
				kept, stable := intent.Current, intent.Filesystem.Current
				if state == "kept_candidate" {
					kept, stable = intent.Candidate, intent.Filesystem.Candidate
				}
				if app, err := readMacBundle(ctx, intent.Target, true); err != nil || !macRecoveryPersistentBundleMatches(app, kept, stable) {
					t.Fatal("startup changed the app it was supposed to preserve", err)
				}
			default:
				if state == "needs_exit_handoff" && !errors.Is(err, errMacStartupRollbackHandoff) {
					t.Fatal("no independent exit handoff was requested", err)
				}
				afterSlot, _ := backend.read(ctx, store.key)
				if !reflect.DeepEqual(before, macRecoveryTree(t, f.root)) || (tc.mode != "slot-replaced-before-lock" && !bytes.Equal(beforeSlot, afterSlot)) {
					t.Fatal("a non-mutating startup route touched files or a slot")
				}
				if tc.mode == "slot-replaced-before-lock" {
					if active, err := store.active(ctx, intent.Target, intent.DataDir); err != nil || active.Capability != "hold_candidate" {
						t.Fatal("startup did not preserve the updated slot", err)
					}
				}
			}
		})
	}
}

func TestMacRestoredOriginalWaitsForLiveHelper(t *testing.T) {
	for _, mode := range []string{"original-updater", "independent-worker"} {
		t.Run(mode, func(t *testing.T) {
			assertMacRestoredOriginalWaitsForHelper(t, mode == "independent-worker")
		})
	}
}

func assertMacRestoredOriginalWaitsForHelper(t *testing.T, independent bool) {
	t.Helper()
	f := newMacRecoveryFixtureWithHelper(t, !independent, true)
	pid, stop := f.transaction.HelperPID, f.stopHelper
	if independent {
		pid, stop = startMacRecoveryInspectTestHelper(t, f.plan.helperExecutable())
		if pid == f.transaction.HelperPID {
			t.Fatal("fixture reused the PID of the original updater")
		}
	}
	f.journal.Phase = "launch_requested"
	intent := newMacReplayTestAuthority(t, f).intent
	store, backend, _ := macRollbackCleanupFixture(t, f, intent)
	ctx := context.Background()
	anchor, err := deriveRecoveryAnchor(ctx, f.cfg, intent.Current.Executable)
	if err != nil {
		t.Fatal(err)
	}
	targetLock, err := f.plan.targetLock()
	if err != nil {
		t.Fatal(err)
	}
	defer targetLock.Close()
	dataLock, err := lockMacUpdateData(f.cfg.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer dataLock.Close()
	before := macRecoveryTree(t, f.root)
	slot, err := backend.read(ctx, store.key)
	if err != nil {
		t.Fatal(err)
	}
	whileLive, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if state, err := runMacStartupRecovery(whileLive, anchor, store); state != "blocked" || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("restored original did not wait for the signed helper's exit", state, err)
	}
	if after, err := backend.read(ctx, store.key); err != nil || !bytes.Equal(after, slot) || !reflect.DeepEqual(before, macRecoveryTree(t, f.root)) {
		t.Fatal("waiting for the live helper changed its journal, workspace or authorization", err)
	}
	if path, err := macHealthProcessPath(pid); err != nil || path != f.plan.helperExecutable() {
		t.Fatal("the waiting original terminated its live helper", err)
	}
	helperDone := make(chan struct{})
	timer := time.AfterFunc(250*time.Millisecond, func() {
		_ = dataLock.Close()
		_ = targetLock.Close()
		stop()
		close(helperDone)
	})
	defer timer.Stop()
	state, err := runMacStartupRecovery(ctx, anchor, store)
	<-helperDone
	if err != nil || state != "kept_original" {
		t.Fatal("restored original did not finish cleanup after actual helper exit", state, err)
	}
	assertMacRollbackCleaned(t, anchor, store, intent)
}

func TestMacStartupRecoveryDisabledBuildKeepsOrdinaryStartup(t *testing.T) {
	t.Setenv("CHORDV_MAC_PROTECTED_RECOVERY", "1")
	data := t.TempDir()
	s := newDesktopService(appConfig{DataDir: data, APIBase: "http://127.0.0.1:1"})
	t.Cleanup(s.cancel)
	if err := s.startup(); err != nil {
		t.Fatal("local startup unexpectedly entered protected recovery", err)
	}
	if info, err := os.Stat(s.binDir()); err != nil || !info.IsDir() {
		t.Fatal("normal startup did not prepare the bin directory", err)
	}
}
