//go:build darwin

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

type macRecoveryCleanupTestStore struct {
	*macRecoveryArmTestStore
	checkpoint macRecoveryCleanupCheckpoint
}

func (s *macRecoveryCleanupTestStore) checkpointCleanup(ctx context.Context, checkpoint macRecoveryCleanupCheckpoint) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if s.checkpoint != (macRecoveryCleanupCheckpoint{}) || s.bound != checkpoint.Intent || s.bound.Capability != "hold_candidate" {
		return errors.New("test store refused stale checkpoint")
	}
	s.checkpoint = checkpoint
	if err := s.write("cleanup-checkpoint", s.bound); err != nil {
		return err
	}
	if s.mode == "cleanup-checkpoint-error" {
		return errors.New("checkpoint was stored but caller lost acknowledgment")
	}
	return nil
}

func (s *macRecoveryCleanupTestStore) activeCleanup(ctx context.Context, target, dataDir string) (macRecoveryCleanupCheckpoint, error) {
	if err := ctx.Err(); err != nil {
		return macRecoveryCleanupCheckpoint{}, err
	}
	if s.checkpoint.Intent.Target != target || s.checkpoint.Intent.DataDir != dataDir {
		return macRecoveryCleanupCheckpoint{}, errors.New("no test cleanup checkpoint")
	}
	return s.checkpoint, nil
}

func (s *macRecoveryCleanupTestStore) retireCleanup(ctx context.Context, checkpoint macRecoveryCleanupCheckpoint) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if s.mode == "replace-on-retire" {
		s.bound.Generation += "-replacement"
	}
	if s.checkpoint != checkpoint || s.bound != checkpoint.Intent {
		return errors.New("test store refused retirement of a replaced authorization")
	}
	for _, path := range []string{s.bound.Work, filepath.Join(s.updater, "mac-update-journal.json")} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			return errors.New("retirement started before workspace and journal were absent")
		}
	}
	if s.mode == "cleanup-retire-error" {
		return errors.New("lost store reply after filesystem cleanup")
	}
	if err := s.write("cleanup-retired", s.bound); err != nil {
		return err
	}
	s.bound = macRecoveryIntent{}
	s.checkpoint = macRecoveryCleanupCheckpoint{}
	return nil
}

func TestMacRecoveryHealthyLiveHelperCheckpointsBeforeCleaning(t *testing.T) {
	for _, tc := range []struct {
		mode, reportText string
		removed, retired bool
	}{
		{mode: "cleanup-complete", removed: true, retired: true},
		{mode: "cleanup-checkpoint-error", reportText: "受保护更新清理授权未确认"},
		{mode: "cleanup-retire-error", reportText: "lost store reply after filesystem cleanup", removed: true},
		{mode: "slot-authority-complete", removed: true, retired: true},
		{mode: "slot-authority-lost-checkpoint", reportText: "受保护更新清理授权未确认"},
	} {
		t.Run(tc.mode, func(t *testing.T) {
			f := macFixture(t, "13.0")
			updater := filepath.Join(f.DataDir, "updater")
			if err := os.WriteFile(filepath.Join(updater, "test-protected-recovery-mode"), []byte(tc.mode), 0600); err != nil {
				t.Fatal(err)
			}
			h := startMacHolder(t, f)
			h.ready(t)
			prepared, err := readMacBundle(context.Background(), filepath.Join(h.work, "next.app"), true)
			if err != nil || !macBundleSealMatches(prepared, f.CandidateInfo) {
				t.Fatal("candidate was not prepared", err)
			}
			_, _ = fmt.Fprintln(h.pipe, "ARM")
			if got := h.line(t); got != "ARMED" {
				t.Fatal(got)
			}
			_, _ = fmt.Fprintln(h.pipe, "EXIT")
			if err = <-h.done; err != nil {
				t.Fatal(err)
			}
			retired := filepath.Join(updater, "test-protected-cleanup-retired.json")
			macWait(t, updater, 50*time.Second, func() bool {
				if tc.retired {
					_, err := os.Lstat(retired)
					return err == nil
				}
				raw, _ := os.ReadFile(filepath.Join(updater, "install-report.json"))
				return strings.Contains(string(raw), tc.reportText)
			})
			rawCheckpoint, err := readMacRecoveryFile(filepath.Join(updater, "test-protected-cleanup-checkpoint.json"))
			if err != nil {
				t.Fatal("workspace cleanup had no healthy capability checkpoint", err)
			}
			if strings.HasPrefix(tc.mode, "slot-authority-") {
				var record macRecoverySlotRecord
				if json.Unmarshal(rawCheckpoint, &record) != nil || record.Health == nil || record.Arm.Intent.Capability != "hold_candidate" ||
					!macRecoverySlotHealthMatches(record.Arm.Intent, *record.Health) || !macRecoverySlotDigest(record.CleanupSHA256) {
					t.Fatal("live helper did not obtain a checkpoint for its own verified health", string(rawCheckpoint))
				}
			}
			if !tc.retired {
				if _, err = os.Lstat(retired); !os.IsNotExist(err) {
					t.Fatal("uncertain cleanup retired its capability", err)
				}
			}
			installed, err := readMacBundle(context.Background(), f.Current, true)
			if err != nil || !macRecoveryBundleMatches(installed, prepared) {
				t.Fatal("health cleanup changed the live candidate", err)
			}
			for _, path := range []string{h.work, filepath.Join(updater, "mac-update-journal.json")} {
				_, err := os.Lstat(path)
				if tc.removed && !os.IsNotExist(err) || !tc.removed && err != nil {
					t.Fatalf("unexpected retained update path %s: %v", path, err)
				}
			}
			if !tc.removed {
				backup, err := readMacBundle(context.Background(), filepath.Join(h.work, "next.app"), true)
				if err != nil || !macRecoveryBundleMatches(backup, f.CurrentInfo) {
					t.Fatal("uncertain checkpoint did not preserve the exact original", err)
				}
			}
		})
	}
}

func TestMacRecoveryResumesOnlyAuthorizedCleanup(t *testing.T) {
	for _, tc := range []struct {
		mode        string
		workRemoved bool
	}{
		{mode: "workspace-intact"}, {mode: "historical-device-number"}, {mode: "live-candidate"},
		{mode: "partial-workspace"}, {mode: "unknown-entry"}, {mode: "missing-helper"},
		{mode: "live-helper"}, {mode: "restarted-helper"}, {mode: "live-backup"}, {mode: "backup-launch-gate"}, {mode: "same-signature-backup"},
		{mode: "no-checkpoint-intact"}, {mode: "foreign-journal-intact"}, {mode: "superseded-intact"},
		{mode: "workspace-gone", workRemoved: true}, {mode: "journal-already-gone", workRemoved: true},
		{mode: "no-checkpoint", workRemoved: true}, {mode: "foreign-journal", workRemoved: true},
		{mode: "same-signature-new-install", workRemoved: true}, {mode: "superseded", workRemoved: true}, {mode: "replace-on-retire", workRemoved: true},
	} {
		mode := tc.mode
		t.Run(mode, func(t *testing.T) {
			ctx := context.Background()
			f := newMacRecoveryFixtureWithHelper(t, mode == "live-helper", true)
			f.journal.Phase = "healthy"
			a := newMacReplayTestAuthority(t, f)
			intent := a.intent
			intent.Capability = "hold_candidate"
			if err := f.plan.swap(intent.Current.Node, intent.Candidate.Node); err != nil {
				t.Fatal(err)
			}
			if mode == "historical-device-number" {
				f.plan.Current.Node.Device ^= 1
				f.transaction.Current.Node = f.plan.Current.Node
				f.transaction.Candidate.Node.Device ^= 1
				f.plan.Directories.Parent.Device ^= 1
				f.plan.Directories.Work.Device ^= 1
				f.persist(t)
				intent.Current, intent.Candidate = f.transaction.Current, f.transaction.Candidate
				intent.PlanSHA256, intent.TransactionSHA256 = f.journal.PlanSHA256, f.journal.TransactionSHA256
			}
			updater := filepath.Join(intent.DataDir, "updater")
			path := filepath.Join(updater, "mac-update-journal.json")
			raw, err := readMacRecoveryFile(path)
			if err != nil {
				t.Fatal(err)
			}
			store := &macRecoveryCleanupTestStore{macRecoveryArmTestStore: &macRecoveryArmTestStore{mode: mode, updater: updater, bound: intent}}
			if err := store.checkpointCleanup(ctx, macRecoveryCleanupCheckpoint{Intent: intent, JournalSHA256: macPlanDigest(raw)}); err != nil {
				t.Fatal(err)
			}
			if tc.workRemoved {
				scope := macCleanupScope{target: intent.Target, parent: intent.Filesystem.Parent, workspace: intent.Filesystem.Work,
					installed: intent.Candidate.Node, staged: intent.Current.Node, helper: f.plan.HelperBundle}
				if err := cleanupMacUpdateWorkWithScope(intent.Work, &scope); err != nil {
					t.Fatal(err)
				}
			}
			var candidatePID int
			switch mode {
			case "unknown-entry":
				if err := os.WriteFile(filepath.Join(intent.Work, "unowned.txt"), []byte("keep"), 0600); err != nil {
					t.Fatal(err)
				}
			case "missing-helper":
				if err := os.Rename(filepath.Join(intent.Work, macUpdateHelperBundleName), filepath.Join(f.root, "preserved-helper.app")); err != nil {
					t.Fatal(err)
				}
			case "restarted-helper":
				_, stop := startMacReplayExtraProcess(t, f.plan.helperExecutable())
				defer stop()
			case "live-candidate":
				installed, err := readMacBundle(ctx, intent.Target, true)
				if err != nil {
					t.Fatal(err)
				}
				pid, stop := startMacReplayExtraProcess(t, installed.Executable)
				defer stop()
				candidatePID = pid
			case "live-backup":
				backup, err := readMacBundle(ctx, intent.Candidate.Path, true)
				if err != nil {
					t.Fatal(err)
				}
				_, stop := startMacReplayExtraProcess(t, backup.Executable)
				defer stop()
			case "backup-launch-gate":
				gate, err := lockMacTargetLaunch(intent.Candidate.Path, false)
				if err != nil {
					t.Fatal(err)
				}
				defer gate.Close()
			case "same-signature-backup":
				moved := filepath.Join(f.root, "preserved-backup.app")
				if err := os.Rename(intent.Candidate.Path, moved); err != nil {
					t.Fatal(err)
				}
				if _, err := runMacUpdateCommand(ctx, 20*time.Second, "/usr/bin/ditto", moved, intent.Candidate.Path); err != nil {
					t.Fatal(err)
				}
			case "partial-workspace":
				work, err := os.OpenRoot(intent.Work)
				if err != nil {
					t.Fatal(err)
				}
				err = work.RemoveAll("next.app")
				if err = errors.Join(err, work.Close()); err != nil {
					t.Fatal(err)
				}
			case "no-checkpoint", "no-checkpoint-intact":
				store.checkpoint = macRecoveryCleanupCheckpoint{}
			case "journal-already-gone":
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
			case "foreign-journal", "foreign-journal-intact":
				if err := os.WriteFile(path, append(raw, '\n'), 0600); err != nil {
					t.Fatal(err)
				}
			case "same-signature-new-install":
				moved := filepath.Join(f.root, "preserved-candidate.app")
				if err := os.Rename(intent.Target, moved); err != nil {
					t.Fatal(err)
				}
				if _, err := runMacUpdateCommand(ctx, 20*time.Second, "/usr/bin/ditto", moved, intent.Target); err != nil {
					t.Fatal(err)
				}
			case "superseded", "superseded-intact":
				store.bound.Generation += "-replacement"
			}
			target, err := f.plan.targetLock()
			if err != nil {
				t.Fatal(err)
			}
			_ = target.Close()
			data, err := lockMacUpdateData(intent.DataDir)
			if err != nil {
				t.Fatal(err)
			}
			_ = data.Close()
			anchor, err := deriveRecoveryAnchor(ctx, f.cfg, filepath.Join(intent.Target, "Contents", "MacOS", filepath.Base(intent.Candidate.Executable)))
			if err != nil {
				t.Fatal(err)
			}
			before := macRecoveryTree(t, f.root)
			checkpoint := store.checkpoint
			err = resumeMacRecoveryCleanup(ctx, anchor, store)
			switch mode {
			case "workspace-intact", "historical-device-number", "live-candidate", "workspace-gone", "journal-already-gone":
				if err != nil || store.bound != (macRecoveryIntent{}) || store.checkpoint != (macRecoveryCleanupCheckpoint{}) {
					t.Fatal("verified cleanup tail did not retire the exact authorization", err)
				}
				if _, err = os.Lstat(path); !os.IsNotExist(err) {
					t.Fatal("verified cleanup tail left a journal", err)
				}
				if _, err = os.Lstat(intent.Work); !os.IsNotExist(err) {
					t.Fatal("verified cleanup left the workspace", err)
				}
				installed, err := readMacBundle(ctx, intent.Target, true)
				if err != nil || !macRecoveryPersistentBundleMatches(installed, intent.Candidate, intent.Filesystem.Candidate) {
					t.Fatal("cleanup changed the healthy installed candidate", err)
				}
				if candidatePID != 0 {
					if live, err := macHealthProcessPath(candidatePID); err != nil || live != installed.Executable {
						t.Fatal("cleanup interrupted the healthy installed candidate", err)
					}
				}
				if err = resumeMacRecoveryCleanup(ctx, anchor, store); err == nil {
					t.Fatal("retired checkpoint was accepted again")
				}
			case "replace-on-retire":
				if err == nil || store.bound.Generation != intent.Generation+"-replacement" || store.checkpoint != checkpoint {
					t.Fatal("retirement consumed a newer capability", err)
				}
			default:
				if err == nil || store.checkpoint != checkpoint || !reflect.DeepEqual(before, macRecoveryTree(t, f.root)) {
					t.Fatal("rejected cleanup changed application, journal or checkpoint", err)
				}
				if mode == "partial-workspace" && !errors.Is(err, errMacRecoveryCleanupWorkPresent) {
					t.Fatal("existing workspace was not distinguished from interrupted finalization", err)
				}
			}
		})
	}
}
