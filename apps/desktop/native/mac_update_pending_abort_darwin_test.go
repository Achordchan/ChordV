//go:build darwin

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestMacPendingAbortPreservesOriginalAndConsumesExactReservation(t *testing.T) {
	for _, tc := range []struct {
		name, phase string
		transaction bool
		refused     bool
	}{
		{name: "prepared", phase: "prepared"}, {name: "armed", phase: "armed"},
		{name: "waiting-parent", phase: "waiting_parent_exit"}, {name: "transaction-before-journal", phase: "waiting_parent_exit", transaction: true},
		{name: "before-bind", phase: "swap_pending", transaction: true}, {name: "original-running", phase: "armed"},
		{name: "lost-checkpoint-reply", phase: "armed"}, {name: "after-work-removed", phase: "swap_pending", transaction: true},
		{name: "after-journal-removed", phase: "prepared"},
		{name: "missing-work-no-checkpoint", phase: "armed", refused: true}, {name: "live-helper", phase: "armed", refused: true},
		{name: "normal-launch-of-candidate", phase: "armed", refused: true}, {name: "bound-slot", phase: "swap_pending", transaction: true, refused: true},
		{name: "already-swapped", phase: "swap_pending", transaction: true, refused: true}, {name: "post-swap-phase", phase: "swapped", transaction: true, refused: true},
		{name: "foreign-transaction", phase: "swap_pending", transaction: true, refused: true}, {name: "modified-journal", phase: "armed", refused: true},
		{name: "modified-plan", phase: "prepared", refused: true}, {name: "partial-workspace", phase: "swap_pending", transaction: true, refused: true},
		{name: "staged-seal-changed-during-checkpoint", phase: "armed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			f := newMacRecoveryFixtureWithHelper(t, tc.name == "live-helper", true)
			intent := newMacReplayTestAuthority(t, f).intent
			intent.Capability, intent.TransactionSHA256 = "", ""
			arm := macRecoveryPendingArm{Intent: intent, HelperPID: f.transaction.HelperPID, HelperIdentity: f.transaction.HelperIdentity, HelperExecutable: f.transaction.HelperExecutable}
			backend := &macRecoverySlotTestBackend{items: make(map[string][]byte)}
			store := openTestMacRecoverySlot(t, backend, intent)
			if err := store.reserve(ctx, arm); err != nil {
				t.Fatal(err)
			}
			journalFile := filepath.Join(intent.DataDir, "updater", "mac-update-journal.json")
			transactionFile := filepath.Join(intent.Work, "transaction.json")
			if err := os.Remove(journalFile); err != nil {
				t.Fatal(err)
			}
			if err := os.Remove(transactionFile); err != nil {
				t.Fatal(err)
			}
			plan := f.plan
			plan.planSHA256 = intent.PlanSHA256
			var digest string
			if tc.transaction {
				raw, err := macUpdateTransactionBytes(f.transaction)
				if err != nil {
					t.Fatal(err)
				}
				if err := atomicFile(transactionFile, raw, 0600); err != nil {
					t.Fatal(err)
				}
				digest = macPlanDigest(raw)
				if tc.phase != "waiting_parent_exit" {
					plan.transactionSHA256 = digest
				}
			}
			if err := plan.journal(tc.phase, intent.Candidate.CDHash, ""); err != nil {
				t.Fatal(err)
			}
			checkpoint := macRecoveryPendingAbort{Phase: tc.phase, TransactionWritten: tc.transaction}
			var originalPID int
			switch tc.name {
			case "original-running":
				pid, stop := startMacReplayExtraProcess(t, intent.Current.Executable)
				defer stop()
				originalPID = pid
			case "normal-launch-of-candidate":
				gate, err := lockMacTargetLaunch(intent.Candidate.Path, false)
				if err != nil {
					t.Fatal(err)
				}
				defer gate.Close()
			case "bound-slot":
				if err := store.bind(ctx, arm, digest); err != nil {
					t.Fatal(err)
				}
			case "already-swapped":
				if err := plan.swap(intent.Current.Node, intent.Candidate.Node); err != nil {
					t.Fatal(err)
				}
			case "foreign-transaction", "modified-journal", "modified-plan":
				path := map[string]string{"foreign-transaction": transactionFile, "modified-journal": journalFile, "modified-plan": filepath.Join(intent.Work, macUpdatePlanName)}[tc.name]
				raw, err := readMacRecoveryFile(path)
				if err != nil {
					t.Fatal(err)
				}
				if err := atomicFile(path, append(raw, ' '), 0600); err != nil {
					t.Fatal(err)
				}
			case "partial-workspace":
				if err := store.checkpointPendingAbort(ctx, arm, checkpoint); err != nil {
					t.Fatal(err)
				}
				if err := os.Rename(intent.Candidate.Path, filepath.Join(f.root, "saved-candidate.app")); err != nil {
					t.Fatal(err)
				}
			case "after-work-removed", "after-journal-removed", "missing-work-no-checkpoint":
				if tc.name != "missing-work-no-checkpoint" {
					if err := store.checkpointPendingAbort(ctx, arm, checkpoint); err != nil {
						t.Fatal(err)
					}
				}
				scope := macCleanupScope{target: intent.Target, parent: intent.Filesystem.Parent, workspace: intent.Filesystem.Work,
					installed: intent.Current.Node, staged: intent.Candidate.Node, helper: plan.HelperBundle, detachedOnly: true}
				if err := cleanupMacUpdateWorkWithScope(intent.Work, &scope); err != nil {
					t.Fatal(err)
				}
				if tc.name == "after-journal-removed" {
					if err := os.Remove(journalFile); err != nil {
						t.Fatal(err)
					}
				}
			}
			installed, err := readMacBundle(ctx, intent.Target, true)
			if err != nil {
				t.Fatal(err)
			}
			anchor, err := deriveRecoveryAnchor(ctx, f.cfg, installed.Executable)
			if err != nil {
				t.Fatal(err)
			}
			target, err := plan.targetLock()
			if err != nil {
				t.Fatal(err)
			}
			target.Close()
			data, err := lockMacUpdateData(intent.DataDir)
			if err != nil {
				t.Fatal(err)
			}
			data.Close()
			before := macRecoveryTree(t, f.root)
			record, _ := backend.read(ctx, store.key)
			if tc.name == "staged-seal-changed-during-checkpoint" {
				plist := filepath.Join(intent.Candidate.Path, "Contents", "Info.plist")
				original, err := os.ReadFile(plist)
				if err != nil {
					t.Fatal(err)
				}
				changed := append(original, ' ')
				backend.afterChange = func(_, after []byte) error {
					if after == nil {
						return nil
					}
					return os.WriteFile(plist, changed, 0644)
				}
				err = resumeMacPendingAbort(ctx, anchor, store)
				if data, readErr := os.ReadFile(plist); err == nil || readErr != nil || !bytes.Equal(data, changed) {
					t.Fatal("cleanup removed a copy whose signed content changed during checkpoint", err, readErr)
				}
				if held, pending, err := store.pendingArm(ctx); err != nil || held != arm || pending == nil || *pending != checkpoint {
					t.Fatal("the changed copy did not retain its exact checkpoint", err)
				}
				return
			}
			ackLost := errors.New("isolated store lost checkpoint acknowledgment")
			if tc.name == "lost-checkpoint-reply" {
				backend.afterChange = func(_, value []byte) error {
					var saved macRecoverySlotRecord
					if json.Unmarshal(value, &saved) == nil && saved.PendingAbort != nil {
						return ackLost
					}
					return nil
				}
			}
			if tc.refused {
				err := resumeMacPendingAbort(ctx, anchor, store)
				current, _ := backend.read(ctx, store.key)
				if err == nil || !bytes.Equal(record, current) || !reflect.DeepEqual(before, macRecoveryTree(t, f.root)) {
					t.Fatal("refusal touched files or authority", err)
				}
				return
			}
			if tc.name == "lost-checkpoint-reply" {
				if err := resumeMacPendingAbort(ctx, anchor, store); !errors.Is(err, ackLost) || !reflect.DeepEqual(before, macRecoveryTree(t, f.root)) {
					t.Fatal("unconfirmed checkpoint allowed file cleanup", err)
				}
				backend.afterChange = nil
				if err := store.bind(ctx, arm, macPlanDigest([]byte("late transaction"))); !errors.Is(err, errMacRecoverySlotConflict) {
					t.Fatal("checkpoint still allowed binding and update", err)
				}
			}
			fresh := openTestMacRecoverySlot(t, backend, intent)
			if err := resumeMacPendingAbort(ctx, anchor, fresh); err != nil {
				t.Fatal("authorized recovery did not finish", err)
			}
			for _, path := range []string{intent.Work, journalFile} {
				if _, err := os.Lstat(path); !os.IsNotExist(err) {
					t.Fatal("authorized cleanup left its workspace or journal", err)
				}
			}
			if _, _, err := fresh.pendingArm(ctx); !errors.Is(err, errMacRecoverySlotMissing) {
				t.Fatal("successful cleanup did not retire the reservation", err)
			}
			original, err := readMacBundle(ctx, intent.Target, true)
			if err != nil || !macRecoveryPersistentBundleMatches(original, intent.Current, intent.Filesystem.Current) {
				t.Fatal("recovery changed the installed original", err)
			}
			if originalPID != 0 {
				if path, err := macHealthProcessPath(originalPID); err != nil || path != original.Executable {
					t.Fatal("recovery interrupted the installed original", err)
				}
			}
			newer := arm
			newer.Intent.Generation += "-new"
			if err := fresh.reserve(ctx, newer); err != nil {
				t.Fatal("retired reservation is still blocking the installation", err)
			}
			if err := fresh.retirePendingAbort(ctx, arm, checkpoint); !errors.Is(err, errMacRecoverySlotConflict) {
				t.Fatal("old checkpoint consumed the replacement reservation", err)
			}
		})
	}
}
