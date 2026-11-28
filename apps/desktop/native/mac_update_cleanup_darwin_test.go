//go:build darwin

package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func cleanupMacUpdateWork(dir string) error { return cleanupMacUpdateWorkWithScope(dir, nil) }

func TestMacUpdateCleanupOnlyKnownEntries(t *testing.T) {
	for _, kind := range []string{"ordinary", "unknown", "wrong-type", "link", "nonempty-mount"} {
		t.Run(kind, func(t *testing.T) {
			root, err := macCanonical(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			work, err := os.MkdirTemp(root, ".chordv-mac-update-")
			if err != nil {
				t.Fatal(err)
			}
			write := func(path string) {
				t.Helper()
				if err := os.WriteFile(path, []byte("retained"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			mkdir := func(path string) {
				t.Helper()
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			}
			plan := filepath.Join(work, macUpdatePlanName)
			write(plan)
			mount := filepath.Join(work, "mount")
			mkdir(mount)
			next := filepath.Join(work, "next.app")
			mkdir(next)
			write(filepath.Join(next, "bundle-data"))
			witness := filepath.Join(root, "outside")
			write(witness)
			var suspect string
			switch kind {
			case "unknown":
				suspect = filepath.Join(work, "user-notes")
				write(suspect)
			case "wrong-type":
				suspect = filepath.Join(work, "helper.log")
				mkdir(suspect)
			case "link":
				suspect = filepath.Join(work, "image.dmg")
				if err := os.Symlink(witness, suspect); err != nil {
					t.Fatal(err)
				}
			case "nonempty-mount":
				suspect = filepath.Join(mount, "user-notes")
				write(suspect)
			}
			err = cleanupMacUpdateWork(work)
			if kind == "ordinary" {
				if err != nil {
					t.Fatal(err)
				}
				if _, err = os.Lstat(work); !os.IsNotExist(err) {
					t.Fatal("work not removed", err)
				}
				if err = cleanupMacUpdateWork(work); err != nil {
					t.Fatal(err)
				}
			} else {
				if err == nil {
					t.Fatal("unexpected cleanup success")
				}
				for _, path := range []string{suspect, plan, filepath.Join(next, "bundle-data")} {
					if _, err = os.Lstat(path); err != nil {
						t.Fatal(err)
					}
				}
			}
			if data, err := os.ReadFile(witness); err != nil || string(data) != "retained" {
				t.Fatal("outside changed", err)
			}
		})
	}
}

func TestMacUpdateCleanupChecksBothTransactionRoles(t *testing.T) {
	for _, changed := range []string{"none", "target", "staged", "missing-staged"} {
		t.Run(changed, func(t *testing.T) {
			root, err := macCanonical(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			work, err := os.MkdirTemp(root, ".chordv-mac-update-")
			if err != nil {
				t.Fatal(err)
			}
			target, next := filepath.Join(root, "Installed.app"), filepath.Join(work, "next.app")
			for _, path := range []string{target, next} {
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			}
			a, err := macNode(target)
			if err != nil {
				t.Fatal(err)
			}
			b, err := macNode(next)
			if err != nil {
				t.Fatal(err)
			}
			parent, _, err := readMacFilesystemNode(root)
			if err != nil {
				t.Fatal(err)
			}
			workspace, _, err := readMacFilesystemNode(work)
			if err != nil {
				t.Fatal(err)
			}
			scope := &macCleanupScope{target: target, installed: a, staged: b, parent: parent, workspace: workspace}
			plan := filepath.Join(work, macUpdatePlanName)
			if err := os.WriteFile(plan, []byte("plan"), 0600); err != nil {
				t.Fatal(err)
			}
			if changed != "none" {
				p := next
				if changed == "target" {
					p = target
				}
				if err := os.Rename(p, filepath.Join(root, "retained")); err != nil {
					t.Fatal(err)
				}
				if changed != "missing-staged" {
					if err := os.Mkdir(p, 0700); err != nil {
						t.Fatal(err)
					}
				}
			}
			before := macRecoveryTree(t, root)
			err = cleanupMacUpdateWorkWithScope(work, scope)
			if changed == "none" {
				if err != nil {
					t.Fatal(err)
				}
				if _, err = os.Lstat(work); !os.IsNotExist(err) {
					t.Fatal("work not removed", err)
				}
				return
			}
			if err == nil || !reflect.DeepEqual(before, macRecoveryTree(t, root)) {
				t.Fatal("changed placement must preserve recovery data", err)
			}
		})
	}
}

func TestMacUpdateCleanupRejectsUnrelatedOpenRoot(t *testing.T) {
	root, err := macCanonical(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	work := filepath.Join(root, ".chordv-mac-update-fd-check")
	if err := os.Mkdir(work, 0700); err != nil {
		t.Fatal(err)
	}
	unrelated, err := os.OpenRoot(work)
	if err != nil {
		t.Fatal(err)
	}
	defer unrelated.Close()
	if err := os.Rename(work, filepath.Join(root, "original-open-root")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(work, 0700); err != nil {
		t.Fatal(err)
	}
	parent, _, err := readMacFilesystemNode(root)
	if err != nil {
		t.Fatal(err)
	}
	workspace, _, err := readMacFilesystemNode(work)
	if err != nil {
		t.Fatal(err)
	}
	scope := macCleanupScope{target: filepath.Join(root, "Installed.app"), parent: parent, workspace: workspace}
	if err := scope.verifyDirectories(unrelated); err == nil {
		t.Fatal("a matching canonical path must not authorize a different open directory")
	}
}

func TestMacUpdateTerminalCleanupUsesRecordedWorkspace(t *testing.T) {
	for _, tc := range []struct{ phase, change string }{
		{"healthy", "none"}, {"rolled_back", "none"},
		{"healthy", "replaced-work"}, {"rolled_back", "replaced-work"},
		{"healthy", "changed-plan"}, {"healthy", "changed-transaction"},
	} {
		t.Run(tc.phase+"/"+tc.change, func(t *testing.T) {
			f := newMacRecoveryFixture(t, false)
			p, candidate := &f.plan, f.transaction.Candidate
			var err error
			f.transaction.Filesystem, err = captureMacUpdateFilesystem(p, candidate)
			if err != nil {
				t.Fatal(err)
			}
			f.journal.Phase = tc.phase
			f.persist(t)
			p.planSHA256, p.transactionSHA256 = f.journal.PlanSHA256, f.journal.TransactionSHA256
			journal := filepath.Join(p.DataDir, "updater", "mac-update-journal.json")
			raw, err := os.ReadFile(journal)
			if err != nil {
				t.Fatal(err)
			}
			p.lastJournalSHA256 = macPlanDigest(raw)
			installed := p.Current.Node
			if tc.phase == "healthy" {
				if err := p.swap(p.Current.Node, candidate.Node); err != nil {
					t.Fatal(err)
				}
				installed = candidate.Node
			}
			switch tc.change {
			case "replaced-work":
				retained := filepath.Join(f.root, "retained-work")
				if err := os.Rename(p.Work, retained); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(p.Work, 0700); err != nil {
					t.Fatal(err)
				}
				for _, name := range []string{macUpdatePlanName, "transaction.json", "helper", "next.app"} {
					if err := os.Rename(filepath.Join(retained, name), filepath.Join(p.Work, name)); err != nil {
						t.Fatal(err)
					}
				}
			case "changed-plan", "changed-transaction":
				name := macUpdatePlanName
				if tc.change == "changed-transaction" {
					name = "transaction.json"
				}
				path := filepath.Join(p.Work, name)
				raw, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, append(raw, '\n'), 0600); err != nil {
					t.Fatal(err)
				}
			}
			before := macRecoveryTree(t, f.root)
			err = p.finishMacUpdate(tc.phase, candidate)
			if tc.change != "none" {
				if err == nil || !reflect.DeepEqual(before, macRecoveryTree(t, f.root)) {
					t.Fatal("changed Work or original record must preserve the full tree", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			for _, path := range []string{p.Work, journal} {
				if _, err := os.Lstat(path); !os.IsNotExist(err) {
					t.Fatal("terminal recovery record was not removed", path, err)
				}
			}
			if actual, err := macNode(p.Current.Path); err != nil || actual != installed {
				t.Fatal("cleanup changed the installed application", actual, err)
			}
		})
	}
}
