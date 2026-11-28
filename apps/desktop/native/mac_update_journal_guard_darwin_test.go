//go:build darwin

package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestMacUpdatePreservesInterruptedJournalBeforeNewInstall(t *testing.T) {
	for _, kind := range []string{"record", "truncated", "dangling-link", "directory"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			dir := filepath.Join(root, "updater")
			if err := os.Mkdir(dir, 0700); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(dir, "mac-update-journal.json")
			if err := requireUnusedMacUpdateJournal(root); err != nil {
				t.Fatal(err)
			}
			var err error
			switch kind {
			case "record":
				err = os.WriteFile(path, []byte(`{"schema":1,"id":"previous","phase":"swapped"}`), 0600)
			case "truncated":
				err = os.WriteFile(path, []byte(`{"schema":`), 0600)
			case "dangling-link":
				err = os.Symlink("not-present", path)
			case "directory":
				err = os.Mkdir(path, 0700)
			}
			if err != nil {
				t.Fatal(err)
			}
			before := macRecoveryTree(t, root)
			service := newDesktopService(appConfig{DataDir: root})
			defer service.cancel()
			if _, err := service.prepareMacUpdate(context.Background(), filepath.Join(dir, "missing.dmg")); err == nil || !strings.Contains(err.Error(), "已保留原记录") {
				t.Fatal("new install did not report the pending recovery before validation", err)
			}
			for _, force := range []bool{false, true} {
				if _, err := service.connect(context.Background(), runtimeConfig{}, force); err == nil || !strings.Contains(err.Error(), "mac_update_pending") {
					t.Fatalf("connect(force=%t) did not stop at the update gate: %v", force, err)
				}
				if err := service.checkNetworkConflict(context.Background(), force); err == nil || !strings.Contains(err.Error(), "mac_update_pending") {
					t.Fatal("preflight missed pending update", err)
				}
			}
			after := macRecoveryTree(t, root)
			if len(before) != len(after) {
				t.Fatal("unexpected files")
			}
			for k, v := range before {
				if after[k] != v {
					t.Fatal("changed entry", k)
				}
			}
		})
	}
}

func TestMacUpdateHelperPreservesJournalCreatedAfterPreflight(t *testing.T) {
	f := macFixture(t, "13.0")
	updater := filepath.Join(f.DataDir, "updater")
	journal := filepath.Join(updater, "mac-update-journal.json")
	witness := filepath.Join(updater, "test-late-journal")
	record := []byte(`{"schema":1,"id":"interrupted-test-operation","phase":"swap_pending"}`)
	if err := os.WriteFile(witness, record, 0600); err != nil {
		t.Fatal(err)
	}
	original, err := os.Stat(witness)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(journal); !os.IsNotExist(err) {
		t.Fatal("journal already present before preflight", err)
	}
	h := startMacHolder(t, f)
	select {
	case line, ok := <-h.lines:
		if ok {
			t.Fatalf("unexpected helper readiness: %q", line)
		}
	case <-time.After(40 * time.Second):
		t.Fatal("helper did not reject competing journal")
	}
	if err := <-h.done; err == nil {
		t.Fatal("holder accepted competing operation")
	}
	kept, err := os.Lstat(journal)
	if err != nil || !os.SameFile(original, kept) {
		t.Fatal("competing record lost or replaced", err)
	}
	raw, err := os.ReadFile(journal)
	if err != nil || string(raw) != string(record) {
		t.Fatal("competing record changed", err)
	}
	if node, err := macNode(f.Current); err != nil || node != f.CurrentInfo.Node {
		t.Fatal("installed bundle changed", err)
	}
	matches, err := filepath.Glob(filepath.Join(f.Root, ".chordv-mac-update-*"))
	if err != nil || len(matches) != 0 {
		t.Fatal("new operation left a work directory", matches, err)
	}
	if _, err := os.Lstat(filepath.Join(updater, "install-report.json")); !os.IsNotExist(err) {
		t.Fatal("new operation wrote an install report", err)
	}
}

func TestMacUpdateClearJournalRequiresPrivateOwnedRecord(t *testing.T) {
	for _, kind := range []string{"valid", "missing", "symlink", "dangling", "hardlink", "public", "unknown-schema", "different-plan"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			updater := filepath.Join(root, "updater")
			if err := os.Mkdir(updater, 0700); err != nil {
				t.Fatal(err)
			}
			p := macUpdatePlan{ID: "operation", DataDir: root, Work: filepath.Join(root, "work")}
			p.Current.Path = filepath.Join(root, "current.app")
			path := filepath.Join(updater, "mac-update-journal.json")
			witness := filepath.Join(root, "witness")
			schema := 1
			if kind == "unknown-schema" {
				schema = 2
			}
			p.planSHA256 = macPlanDigest([]byte("original plan"))
			j := macUpdateJournal{Schema: schema, ID: p.ID, Work: p.Work, Target: p.Current.Path, PlanSHA256: p.planSHA256}
			if kind == "different-plan" {
				j.PlanSHA256 = macPlanDigest([]byte("different plan"))
			}
			var err error
			switch kind {
			case "missing":
			case "dangling":
				err = os.Symlink(witness, path)
			case "symlink", "hardlink":
				if err = atomicJSON(witness, j); err == nil {
					if kind == "symlink" {
						err = os.Symlink(witness, path)
					} else {
						err = os.Link(witness, path)
					}
				}
			default:
				if err = atomicJSON(path, j); err == nil && kind == "public" {
					err = os.Chmod(path, 0644)
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			raw, err := json.MarshalIndent(j, "", "  ")
			if err != nil {
				t.Fatal(err)
			}
			p.lastJournalSHA256 = macPlanDigest(raw)
			before, _ := os.Lstat(path)
			err = p.clearJournal("", "")
			after, statErr := os.Lstat(path)
			if kind == "valid" || kind == "missing" {
				if err != nil || !os.IsNotExist(statErr) {
					t.Fatalf("expected cleared slot: %v, %v", err, statErr)
				}
				return
			}
			if err == nil || statErr != nil || !os.SameFile(before, after) {
				t.Fatalf("invalid entry not refused and preserved: %v, %v", err, statErr)
			}
		})
	}
}

func TestMacTerminalCleanupRetainsBackupWithoutMatchingJournal(t *testing.T) {
	f := newMacRecoveryFixture(t, false)
	p := &f.plan
	candidate := f.transaction.Candidate
	p.planSHA256, p.transactionSHA256 = f.journal.PlanSHA256, f.journal.TransactionSHA256
	if err := p.swap(p.Current.Node, candidate.Node); err != nil {
		t.Fatal(err)
	}
	journalPath := filepath.Join(p.DataDir, "updater", "mac-update-journal.json")
	for _, failure := range []string{"not-terminal", "wrong-terminal", "wrong-candidate", "wrong-plan", "missing"} {
		t.Run(failure, func(t *testing.T) {
			journal := f.journal
			journal.Phase = "healthy"
			switch failure {
			case "not-terminal":
				journal.Phase = "awaiting_health"
			case "wrong-terminal":
				journal.Phase = "rolled_back"
			case "wrong-candidate":
				journal.CandidateCDHash = "different"
			case "wrong-plan":
				journal.PlanSHA256 = "different"
			}
			raw, err := json.MarshalIndent(journal, "", "  ")
			if err != nil {
				t.Fatal(err)
			}
			p.lastJournalSHA256 = macPlanDigest(raw)
			if err := atomicJSON(journalPath, journal); err != nil {
				t.Fatal(err)
			}
			if failure == "missing" {
				if err := os.Remove(journalPath); err != nil {
					t.Fatal(err)
				}
			}
			before := macRecoveryTree(t, f.root)
			if err := p.finishMacUpdate("healthy", candidate); err == nil {
				t.Fatal("nonmatching journal accepted")
			}
			if !reflect.DeepEqual(before, macRecoveryTree(t, f.root)) {
				t.Fatal("refusal changed recovery evidence")
			}
		})
	}
}

func TestMacJournalWriterPreservesUnexpectedPreviousRecord(t *testing.T) {
	for _, kind := range []string{"occupied-first-write", "changed", "removed", "normal"} {
		t.Run(kind, func(t *testing.T) {
			dir := t.TempDir()
			updater := filepath.Join(dir, "updater")
			if err := os.Mkdir(updater, 0700); err != nil {
				t.Fatal(err)
			}
			plan := []byte(`{"id":"test-operation"}`)
			if err := os.WriteFile(filepath.Join(dir, macUpdatePlanName), plan, 0600); err != nil {
				t.Fatal(err)
			}
			p := macUpdatePlan{ID: "test-operation", DataDir: dir, Work: dir, planSHA256: macPlanDigest(plan)}
			path := filepath.Join(updater, "mac-update-journal.json")
			if kind != "occupied-first-write" {
				if err := p.journal("mounting", "", ""); err != nil {
					t.Fatal(err)
				}
			}
			switch kind {
			case "occupied-first-write":
				if err := os.WriteFile(path, []byte("previous operation"), 0600); err != nil {
					t.Fatal(err)
				}
			case "changed":
				f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0600)
				if err != nil {
					t.Fatal(err)
				}
				_, err = f.WriteString("\n")
				if closeErr := f.Close(); err != nil || closeErr != nil {
					t.Fatal(err, closeErr)
				}
			case "removed":
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
			}
			before := macRecoveryTree(t, updater)
			err := p.journal("prepared", "candidate", "")
			if kind == "normal" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if err == nil || !reflect.DeepEqual(before, macRecoveryTree(t, updater)) {
				t.Fatal("unexpected journal was recreated or replaced", err)
			}
		})
	}
}

func TestMacPreparedCancelKeepsWorkWhenJournalChanged(t *testing.T) {
	for _, kind := range []string{"changed", "missing"} {
		t.Run(kind, func(t *testing.T) {
			f := macFixture(t, "13.0")
			h := startMacHolder(t, f)
			h.ready(t)
			path := filepath.Join(f.DataDir, "updater", "mac-update-journal.json")
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			changed := append(raw, '\n')
			if kind == "missing" {
				err = os.Remove(path)
			} else {
				err = os.WriteFile(path, changed, 0600)
			}
			if err != nil {
				t.Fatal(err)
			}
			candidate, err := macNode(filepath.Join(h.work, "next.app"))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := h.pipe.WriteString("ABORT\n"); err != nil {
				t.Fatal(err)
			}
			select {
			case line, ok := <-h.lines:
				if ok {
					t.Fatalf("unexpected cancellation acknowledgment: %s", line)
				}
			case <-time.After(30 * time.Second):
				t.Fatal("cancel did not return")
			}
			if err := <-h.done; err == nil {
				t.Fatal("holder claimed successful cleanup")
			}
			after, readErr := os.ReadFile(path)
			if kind == "missing" && !os.IsNotExist(readErr) || kind == "changed" && (readErr != nil || string(after) != string(changed)) {
				t.Fatal("unexpected journal state", readErr)
			}
			if after, err := macNode(filepath.Join(h.work, "next.app")); err != nil || after != candidate {
				t.Fatal("staged application was not preserved", err)
			}
			if after, err := macNode(f.Current); err != nil || after != f.CurrentInfo.Node {
				t.Fatal("installed application changed", err)
			}
			if _, err := os.Lstat(filepath.Join(h.work, macUpdatePlanName)); err != nil {
				t.Fatal("recovery plan missing", err)
			}
			assertMacNoMount(t, h.work, f.Installer)
		})
	}
}
