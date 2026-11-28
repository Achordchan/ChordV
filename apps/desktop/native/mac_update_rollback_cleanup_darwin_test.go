//go:build darwin

package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func macRollbackCleanupFixture(t *testing.T, f *macRecoveryFixture, intent macRecoveryIntent) (*macRecoverySlotAuthority, *macRecoverySlotTestBackend, macRecoveryPendingArm) {
	t.Helper()
	ctx := context.Background()
	backend := &macRecoverySlotTestBackend{items: make(map[string][]byte)}
	store := openTestMacRecoverySlot(t, backend, intent)
	arm := macRecoveryPendingArm{Intent: intent, HelperPID: f.transaction.HelperPID, HelperIdentity: f.transaction.HelperIdentity, HelperExecutable: f.transaction.HelperExecutable}
	arm.Intent.Capability, arm.Intent.TransactionSHA256 = "", ""
	if err := store.reserve(ctx, arm); err != nil {
		t.Fatal(err)
	}
	if err := store.bind(ctx, arm, intent.TransactionSHA256); err != nil {
		t.Fatal(err)
	}
	return store, backend, arm
}

func assertMacRollbackCleaned(t *testing.T, anchor macRecoveryAnchor, store *macRecoverySlotAuthority, intent macRecoveryIntent) {
	t.Helper()
	ctx := context.Background()
	for _, path := range []string{intent.Work, filepath.Join(intent.DataDir, "updater", "mac-update-journal.json")} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatal("rollback cleanup left its workspace or journal", err)
		}
	}
	if _, err := store.active(ctx, intent.Target, intent.DataDir); !errors.Is(err, errMacRecoverySlotMissing) {
		t.Fatal("rollback authorization was not retired", err)
	}
	current, err := readMacBundle(ctx, intent.Target, true)
	if err != nil || !macRecoveryBundleMatches(current, anchor.bundle) || !macRecoveryPersistentBundleMatches(current, intent.Current, intent.Filesystem.Current) {
		t.Fatal("rollback cleanup did not keep the exact original", err)
	}
}

func macRollbackFixtureHealth(intent macRecoveryIntent) macVerifiedUpdateHealth {
	return macVerifiedUpdateHealth{Operation: intent.Operation, Target: intent.Target, DataDir: intent.DataDir, PlanSHA256: intent.PlanSHA256,
		TransactionSHA256: intent.TransactionSHA256, Candidate: intent.Candidate, CandidateFilesystem: intent.Filesystem.Candidate,
		PID: 42, ProcessIdentity: "independent-test-candidate", ChallengeSHA256: macPlanDigest([]byte("fixture challenge"))}
}

func TestMacRollbackRealProcessThenRetiresOriginalCheckpoint(t *testing.T) {
	ctx := context.Background()
	f := newMacRecoveryFixtureWithHelper(t, false, true)
	f.journal.Phase = "launch_requested"
	controller := newMacReplayTestAuthority(t, f)
	intent := controller.intent
	store, _, _ := macRollbackCleanupFixture(t, f, intent)
	if err := f.plan.swap(intent.Current.Node, intent.Candidate.Node); err != nil {
		t.Fatal(err)
	}
	// Real candidate parent, pipe EOF and the parent's actual process exit are
	// required by the existing rollback worker for its physical reverse swap.
	worker := startMacReplayTestRun(t, f, controller, 20*time.Second, false)
	worker.closePipe(t)
	worker.exitParent(t)
	if result := worker.receive(t); result.Error != "" || result.State != "rolled_back_retained" {
		t.Fatal("authorized worker did not reverse the actual swap", result)
	}
	pid, stop := startMacReplayExtraProcess(t, intent.Current.Executable)
	defer stop()
	anchor, err := deriveRecoveryAnchor(ctx, f.cfg, intent.Current.Executable)
	if err != nil {
		t.Fatal(err)
	}
	service := newDesktopService(f.cfg)
	defer service.cancel()
	service.startupDone = make(chan struct{})
	report := filepath.Join(f.cfg.DataDir, "updater", installReportName)
	if err := atomicJSON(report, map[string]any{"ok": false, "platform": "macos", "mode": "replace", "summary": "原版本已恢复"}); err != nil {
		t.Fatal(err)
	}
	reportCtx, cancelReport := context.WithTimeout(ctx, 15*time.Second)
	defer cancelReport()
	wait := &installReportWaitContext{Context: reportCtx, waiting: make(chan struct{})}
	readDone := make(chan error, 1)
	go func() {
		value, err := service.Invoke(wait, "consume_desktop_update_install_report", nil)
		fields, ok := value.(map[string]any)
		if err != nil || !ok || fields["summary"] != "原版本已恢复" || fields["recoveryPending"] == true {
			err = fmt.Errorf("recovered app got a stale or missing result: %#v (%v)", value, err)
		}
		readDone <- err
	}()
	select {
	case <-wait.waiting:
	case err := <-readDone:
		t.Fatal("report did not wait for real protected cleanup", err)
	case <-reportCtx.Done():
		t.Fatal("report did not reach the startup barrier", reportCtx.Err())
	}
	state, startupErr := runMacStartupRecovery(ctx, anchor, store)
	service.mu.Lock()
	service.startupErr = startupErr
	service.mu.Unlock()
	close(service.startupDone)
	if startupErr != nil || state != "kept_original" {
		t.Fatal("recovered original could not retire the rollback", state, startupErr)
	}
	if err := <-readDone; err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(report); !os.IsNotExist(err) {
		t.Fatal("ordinary startup did not consume the settled report", err)
	}
	assertMacRollbackCleaned(t, anchor, store, intent)
	if path, err := macHealthProcessPath(pid); err != nil || path != intent.Current.Executable {
		t.Fatal("cleanup stopped the running original", err)
	}
}

func TestMacRollbackCleanupRequiresPhysicalOriginalAndSameCheckpoint(t *testing.T) {
	for _, mode := range []string{"before-forward-swap", "lost-checkpoint-reply", "after-work-removed", "after-journal-removed",
		"foreign-journal-after-checkpoint", "second-swap-after-checkpoint", "candidate-still-installed", "helper-still-running",
		"candidate-live-after-external-restore", "missing-work-no-checkpoint", "ordinary-healthy-phase", "protected-health"} {
		t.Run(mode, func(t *testing.T) {
			ctx := context.Background()
			f := newMacRecoveryFixtureWithHelper(t, mode == "helper-still-running", true)
			if mode != "before-forward-swap" {
				f.journal.Phase = "launch_requested"
			}
			if mode == "ordinary-healthy-phase" {
				f.journal.Phase = "healthy"
			}
			intent := newMacReplayTestAuthority(t, f).intent
			store, backend, arm := macRollbackCleanupFixture(t, f, intent)
			journal := filepath.Join(intent.DataDir, "updater", "mac-update-journal.json")
			raw, err := readMacRecoveryFile(journal)
			if err != nil {
				t.Fatal(err)
			}
			checkpoint := macRecoveryCleanupCheckpoint{Intent: intent, JournalSHA256: macPlanDigest(raw)}
			checkpoint.Intent.Capability = "keep_original"
			switch mode {
			case "after-work-removed", "after-journal-removed", "foreign-journal-after-checkpoint", "second-swap-after-checkpoint":
				if err := store.checkpointRollbackCleanup(ctx, intent, checkpoint.JournalSHA256); err != nil {
					t.Fatal(err)
				}
			}
			switch mode {
			case "after-work-removed", "after-journal-removed", "missing-work-no-checkpoint":
				scope := macCleanupScope{target: intent.Target, parent: intent.Filesystem.Parent, workspace: intent.Filesystem.Work,
					installed: intent.Current.Node, staged: intent.Candidate.Node, helper: f.plan.HelperBundle, detachedOnly: true}
				if err := cleanupMacUpdateWorkWithScope(intent.Work, &scope); err != nil {
					t.Fatal(err)
				}
				if mode == "after-journal-removed" {
					if err := os.Remove(journal); err != nil {
						t.Fatal(err)
					}
				}
			case "foreign-journal-after-checkpoint":
				if err := atomicFile(journal, append(raw, '\n'), 0600); err != nil {
					t.Fatal(err)
				}
			case "candidate-still-installed", "second-swap-after-checkpoint":
				if err := f.plan.swap(intent.Current.Node, intent.Candidate.Node); err != nil {
					t.Fatal(err)
				}
			case "candidate-live-after-external-restore":
				if err := f.plan.swap(intent.Current.Node, intent.Candidate.Node); err != nil {
					t.Fatal(err)
				}
				pid, stop := startMacReplayExtraProcess(t, intent.Current.Executable)
				defer stop()
				if err := f.plan.swap(intent.Candidate.Node, intent.Current.Node); err != nil {
					t.Fatal(err)
				}
				if hash, err := macHealthProcessCDHash(pid); err != nil || hash != intent.Candidate.CDHash {
					t.Fatal("fixture did not retain a live candidate process", err)
				}
			case "protected-health":
				if err := store.markHealthy(ctx, intent, macRollbackFixtureHealth(intent)); err != nil {
					t.Fatal(err)
				}
			}
			anchor, err := deriveRecoveryAnchor(ctx, f.cfg, f.plan.Current.Executable)
			if err != nil {
				t.Fatal(err)
			}
			dataLock, err := lockMacUpdateData(intent.DataDir)
			if err != nil {
				t.Fatal(err)
			}
			dataLock.Close()
			targetLock, err := f.plan.targetLock()
			if err != nil {
				t.Fatal(err)
			}
			targetLock.Close()
			before := macRecoveryTree(t, f.root)
			beforeSlot, _ := backend.read(ctx, store.key)
			switch mode {
			case "before-forward-swap", "after-work-removed", "after-journal-removed":
			case "lost-checkpoint-reply":
				ackLost := errors.New("test backend lost acknowledgment after writing checkpoint")
				backend.afterChange = func(_, _ []byte) error { return ackLost }
				if err := resumeMacRollbackCleanup(ctx, anchor, store); !errors.Is(err, ackLost) || !reflect.DeepEqual(before, macRecoveryTree(t, f.root)) {
					t.Fatal("uncertain checkpoint caused filesystem changes", err)
				}
				backend.afterChange = nil
				stored, err := store.activeCleanup(ctx, intent.Target, intent.DataDir)
				if err != nil || stored != checkpoint {
					t.Fatal("exact checkpoint not readable after lost reply", err)
				}
				if err := store.markHealthy(ctx, intent, macRollbackFixtureHealth(intent)); !errors.Is(err, errMacRecoverySlotConflict) {
					t.Fatal("late health modified the rollback cleanup checkpoint", err)
				}
			default:
				if err := resumeMacRollbackCleanup(ctx, anchor, store); err == nil {
					t.Fatal("invalid rollback cleanup was accepted")
				}
				if mode == "second-swap-after-checkpoint" {
					if state, err := replayMacUpdateRecovery(ctx, anchor, store, nil); err == nil || state != "conflict" {
						t.Fatal("record already in cleanup could authorize a second swap", state, err)
					}
				}
				afterSlot, _ := backend.read(ctx, store.key)
				if !reflect.DeepEqual(before, macRecoveryTree(t, f.root)) || !bytes.Equal(beforeSlot, afterSlot) {
					t.Fatal("refusal touched update artifacts or the protected slot")
				}
				return
			}
			fresh := openTestMacRecoverySlot(t, backend, intent)
			if err := resumeMacRollbackCleanup(ctx, anchor, fresh); err != nil {
				t.Fatal("exact rollback checkpoint could not be retired", err)
			}
			assertMacRollbackCleaned(t, anchor, fresh, intent)
			arm.Intent.Generation += "-current"
			if err := fresh.reserve(ctx, arm); err != nil {
				t.Fatal("old authorization still occupied the installation slot", err)
			}
			if err := fresh.retireCleanup(ctx, checkpoint); !errors.Is(err, errMacRecoverySlotConflict) {
				t.Fatal("old rollback checkpoint could consume the newer reservation", err)
			}
		})
	}
}

func TestMacRollbackCheckpointCompetesWithHealth(t *testing.T) {
	ctx := context.Background()
	f := newMacRecoveryFixtureWithHelper(t, false, true)
	intent := newMacReplayTestAuthority(t, f).intent
	store, _, _ := macRollbackCleanupFixture(t, f, intent)
	journalDigest := macPlanDigest([]byte("exact journal"))
	start, checkpoint, health := make(chan struct{}), make(chan error, 1), make(chan error, 1)
	go func() { <-start; checkpoint <- store.checkpointRollbackCleanup(ctx, intent, journalDigest) }()
	go func() { <-start; health <- store.markHealthy(ctx, intent, macRollbackFixtureHealth(intent)) }()
	close(start)
	checkpointErr, healthErr := <-checkpoint, <-health
	active, err := store.active(ctx, intent.Target, intent.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	switch {
	case checkpointErr == nil && errors.Is(healthErr, errMacRecoverySlotConflict):
		saved, err := store.activeCleanup(ctx, intent.Target, intent.DataDir)
		if err != nil || saved.Intent != active || active.Capability != "keep_original" || saved.JournalSHA256 != journalDigest {
			t.Fatal("rollback winner was not retained exactly", err)
		}
	case healthErr == nil && errors.Is(checkpointErr, errMacRecoverySlotConflict):
		if active.Capability != "hold_candidate" {
			t.Fatal("health winner was overwritten", active.Capability)
		}
	default:
		t.Fatal("health and rollback cleanup must have exactly one winner", checkpointErr, healthErr)
	}
}
