//go:build darwin

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func (p *macUpdatePlan) swap(expected, staged macNodeIdentity) error {
	directories, err := readMacSwapDirectories(p.Current.Path, p.Work)
	if err != nil {
		return err
	}
	return p.swapWithDirectories(expected, staged, directories)
}

func bindMacFixtureSwapDirectories(t *testing.T, p *macUpdatePlan) {
	t.Helper()
	directories, err := readMacSwapDirectories(p.Current.Path, p.Work)
	if err != nil {
		t.Fatal(err)
	}
	p.Directories = &directories
}

// Keep every child inode, including the signed app, while replacing the directory.
func rebindMacUpdateWork(t *testing.T, work string) {
	t.Helper()
	old := work + ".retained"
	if err := os.Rename(work, old); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(work, 0700); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(old)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if err := os.Rename(filepath.Join(old, entry.Name()), filepath.Join(work, entry.Name())); err != nil {
			t.Fatal(err)
		}
	}
}

func TestMacUpdateReboundWorkAfterArmCannotExchange(t *testing.T) {
	f := macFixture(t, "13.0")
	h := startMacHolder(t, f)
	h.ready(t)
	_, _ = fmt.Fprintln(h.pipe, "ARM")
	if got := h.line(t); got != "ARMED" {
		t.Fatal(got)
	}
	_, _ = fmt.Fprintln(h.pipe, "PIPE_EOF")
	if got := h.line(t); got != "PIPE_CLOSED" {
		t.Fatal(got)
	}
	updater := filepath.Join(f.DataDir, "updater")
	journal := filepath.Join(updater, "mac-update-journal.json")
	macWait(t, updater, 10*time.Second, func() bool {
		raw, _ := os.ReadFile(journal)
		return strings.Contains(string(raw), `"phase": "waiting_parent_exit"`)
	})
	staged := filepath.Join(h.work, "next.app")
	candidate, err := macNode(staged)
	if err != nil {
		t.Fatal(err)
	}
	rebindMacUpdateWork(t, h.work)
	_, _ = fmt.Fprintln(h.pipe, "EXIT")
	if err := <-h.done; err != nil {
		t.Fatal(err)
	}
	report := filepath.Join(updater, "install-report.json")
	macWait(t, updater, 45*time.Second, func() bool {
		_, err := os.Stat(report)
		return err == nil
	})
	if node, err := macNode(f.Current); err != nil || node != f.CurrentInfo.Node {
		t.Fatal("replacement workspace exchanged the original app", node, err)
	}
	if node, err := macNode(staged); err != nil || node != candidate {
		t.Fatal("replacement workspace lost its staged app", node, err)
	}
	for _, path := range []string{f.Marker, filepath.Join(h.work, "transaction.json")} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatal("rebound work progressed beyond authenticated handoff", path, err)
		}
	}
	if raw, err := os.ReadFile(journal); err != nil || !strings.Contains(string(raw), `"phase": "waiting_parent_exit"`) {
		t.Fatal("last owned journal was not preserved", string(raw), err)
	}
}

func TestMacUpdateCancelledReboundWorkIsPreserved(t *testing.T) {
	f := macFixture(t, "13.0")
	h := startMacHolder(t, f)
	h.ready(t)
	staged := filepath.Join(h.work, "next.app")
	node, err := macNode(staged)
	if err != nil {
		t.Fatal(err)
	}
	rebindMacUpdateWork(t, h.work)
	_, _ = fmt.Fprintln(h.pipe, "ABORT")
	select {
	case <-h.lines:
	case <-h.done:
	case <-time.After(20 * time.Second):
		t.Fatal("cancellation did not settle")
	}
	if got, err := macNode(staged); err != nil || got != node {
		t.Fatal("cancellation removed the staged app from a substitute directory", got, err)
	}
	if _, err := os.Stat(filepath.Join(h.work, macUpdatePlanName)); err != nil {
		t.Fatal("cancellation removed recovery evidence", err)
	}
}

func TestMacUpdateRollbackCannotExchangeReboundWork(t *testing.T) {
	f := newMacRecoveryFixture(t, false)
	p, b := &f.plan, f.transaction.Candidate
	bindMacFixtureSwapDirectories(t, p)
	var err error
	f.transaction.Filesystem, err = captureMacUpdateFilesystem(p, b)
	if err != nil {
		t.Fatal(err)
	}
	f.journal.Phase = "swapped"
	f.persist(t)
	p.planSHA256, p.transactionSHA256 = f.journal.PlanSHA256, f.journal.TransactionSHA256
	path := filepath.Join(p.DataDir, "updater", "mac-update-journal.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	p.lastJournalSHA256 = macPlanDigest(raw)
	if err := p.swap(p.Current.Node, b.Node); err != nil {
		t.Fatal(err)
	}
	rebindMacUpdateWork(t, p.Work)
	cause := errors.New("候选启动未通过")
	if result := p.rollbackFailedUpdate(b, cause, nil); !errors.Is(result, cause) || result == cause {
		t.Fatal("rollback must preserve the original and refusal errors", result)
	}
	for name, expected := range map[string]macNodeIdentity{p.Current.Path: b.Node, b.Path: p.Current.Node} {
		if actual, err := macNode(name); err != nil || actual != expected {
			t.Fatal("rollback exchanged a substitute workspace", name, actual, err)
		}
	}
	if current, err := os.ReadFile(path); err != nil || string(current) != string(raw) {
		t.Fatal("rollback changed the journal of a substitute workspace", err)
	}
}
