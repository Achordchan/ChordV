//go:build darwin

package main

import (
	"context"
	"errors"
	"golang.org/x/sys/unix"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestMacRecoverySwapRejectsReboundWorkWithSameBundleNodes(t *testing.T) {
	f := newMacRecoveryFixture(t, false)
	parentStable, parent, err := readMacFilesystemNode(filepath.Dir(f.plan.Current.Path))
	if err != nil {
		t.Fatal(err)
	}
	workStable, work, err := readMacFilesystemNode(f.plan.Work)
	if err != nil {
		t.Fatal(err)
	}
	retained := filepath.Join(f.root, "RetainedWork")
	if err := os.Rename(f.plan.Work, retained); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(f.plan.Work, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(retained, "next.app"), f.transaction.Candidate.Path); err != nil {
		t.Fatal(err)
	}
	err = f.plan.swapWithDirectories(f.transaction.Current.Node, f.transaction.Candidate.Node, macSwapDirectories{Parent: parent, Work: work, ParentStable: parentStable, WorkStable: workStable})
	if err == nil {
		t.Fatal("same child inodes must not authorize a replacement work directory")
	}
	if target, err := macNode(f.plan.Current.Path); err != nil || target != f.transaction.Current.Node {
		t.Fatal("unauthorized Work changed target", target, err)
	}
}

func TestMacRecoveryRetryAfterDirectorySyncFailure(t *testing.T) {
	for _, failed := range []string{"parent", "work", "both"} {
		t.Run(failed, func(t *testing.T) {
			ctx := context.Background()
			f := newMacRecoveryFixture(t, false)
			authority := newMacReplayTestAuthority(t, f)
			a, b := f.transaction.Current.Node, f.transaction.Candidate.Node
			if err := f.plan.swap(a, b); err != nil {
				t.Fatal(err)
			}
			anchor, err := deriveRecoveryAnchor(ctx, f.cfg, f.plan.Current.Executable)
			if err != nil {
				t.Fatal(err)
			}
			snapshot, err := loadMacRecoveryReplay(ctx, anchor, authority.intent)
			if err != nil || snapshot.placement != "candidate_installed" {
				t.Fatal(snapshot, err)
			}
			var attempted []string
			err = f.plan.swapDirectories(b, a, snapshot.directories, func(fd int) error {
				var st unix.Stat_t
				if err := unix.Fstat(fd, &st); err != nil {
					t.Fatal(err)
				}
				var name string
				switch (macNodeIdentity{Device: uint64(st.Dev), Inode: st.Ino}) {
				case snapshot.directories.Parent:
					name = "parent"
				case snapshot.directories.Work:
					name = "work"
				default:
					t.Fatal("sync on unexpected directory")
				}
				attempted = append(attempted, name)
				if failed == name || failed == "both" {
					if name == "parent" {
						return unix.EIO
					}
					return unix.ENOSPC
				}
				return unix.Fsync(fd)
			})
			if errors.Is(err, unix.EIO) != (failed != "work") || errors.Is(err, unix.ENOSPC) != (failed != "parent") || !reflect.DeepEqual(attempted, []string{"parent", "work"}) {
				t.Fatalf("sync attempts %v, error %v", attempted, err)
			}
			anchor, err = deriveRecoveryAnchor(ctx, f.cfg, f.plan.Current.Executable)
			if err != nil {
				t.Fatal(err)
			}
			if state, err := replayMacUpdateRecovery(ctx, anchor, authority, nil); err != nil || state != "original_retained" {
				t.Fatal(state, err)
			}
			for path, want := range map[string]macNodeIdentity{f.plan.Current.Path: a, f.transaction.Candidate.Path: b} {
				if got, err := macNode(path); err != nil || got != want {
					t.Fatal(path, got, want, err)
				}
			}
		})
	}
}

func TestMacRollbackRequiresRecordedIntentBeforeExchange(t *testing.T) {
	for _, failure := range []string{"journal-unwritable", "transaction-changed"} {
		t.Run(failure, func(t *testing.T) {
			f := newMacRecoveryFixture(t, false)
			p := &f.plan
			bindMacFixtureSwapDirectories(t, p)
			f.persist(t)
			p.planSHA256, p.transactionSHA256 = f.journal.PlanSHA256, f.journal.TransactionSHA256
			if err := p.swap(p.Current.Node, f.transaction.Candidate.Node); err != nil {
				t.Fatal(err)
			}
			raw, err := os.ReadFile(filepath.Join(p.DataDir, "updater", "mac-update-journal.json"))
			if err != nil {
				t.Fatal(err)
			}
			p.lastJournalSHA256 = macPlanDigest(raw)
			if err := p.journal("swapped", f.transaction.Candidate.CDHash, ""); err != nil {
				t.Fatal(err)
			}
			if failure == "journal-unwritable" {
				path := filepath.Join(p.DataDir, "updater", "mac-update-journal.json")
				if err := os.Rename(path, path+".saved"); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			} else if err := os.WriteFile(filepath.Join(p.Work, "transaction.json"), []byte("changed"), 0600); err != nil {
				t.Fatal(err)
			}
			before := macRecoveryTree(t, p.Work)
			cause := errors.New("candidate health check failed")
			err = p.rollbackFailedUpdate(f.transaction.Candidate, cause, nil)
			if !errors.Is(err, cause) || err == cause {
				t.Fatal("both failures must survive", err)
			}
			if target, err := macNode(p.Current.Path); err != nil || target != f.transaction.Candidate.Node {
				t.Fatal("exchanged target without recorded rollback intent", target, err)
			}
			if backup, err := macNode(filepath.Join(p.Work, "next.app")); err != nil || backup != p.Current.Node {
				t.Fatal("original backup moved", backup, err)
			}
			if !reflect.DeepEqual(before, macRecoveryTree(t, p.Work)) {
				t.Fatal("recovery files changed")
			}
		})
	}
}
