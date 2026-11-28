//go:build darwin

package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMacUpdateLaunchesFullSealedHelperBundle(t *testing.T) {
	f := macFixture(t, "13.0")
	h := startMacHolder(t, f)
	h.ready(t)
	ctx := context.Background()
	clone, err := readMacBundle(ctx, filepath.Join(h.work, "helper.app"), true)
	if err != nil || !macBundleSealMatches(clone, f.CurrentInfo) {
		t.Fatalf("the running update must keep a full copy of the original signed bundle: %v", err)
	}
	if clone.Node == f.CurrentInfo.Node {
		t.Fatal("helper must be an independent copy")
	}
	executable, err := processExecutable(ctx, h.helperPID)
	if err != nil || executable != clone.Executable {
		t.Fatalf("the independent helper is not running out of the checked bundle: %q %v", executable, err)
	}
	if hash, err := macHealthProcessCDHash(h.helperPID); err != nil || hash != clone.CDHash {
		t.Fatalf("the running helper and the original seal do not match: %q %v", hash, err)
	}
	if _, err = fmt.Fprintln(h.pipe, "ABORT"); err != nil {
		t.Fatal(err)
	}
	if got := h.line(t); got != "ABORTED" {
		t.Fatal(got)
	}
	if _, err = os.Lstat(h.work); !os.IsNotExist(err) {
		t.Fatal("cancel did not remove the exact owned copy", err)
	}
	if node, err := macNode(f.Current); err != nil || node != f.CurrentInfo.Node {
		t.Fatal("cancel changed the installed bundle", err)
	}
}

func TestMacUpdateWillNotArmWithReplacedHelperBundle(t *testing.T) {
	f := macFixture(t, "13.0")
	h := startMacHolder(t, f)
	h.ready(t)
	path := filepath.Join(h.work, macUpdateHelperBundleName)
	retained := filepath.Join(f.Root, "retained-helper.app")
	if err := os.Rename(path, retained); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := os.Rename(path, filepath.Join(f.Root, "substitute-helper.app")); err != nil && !os.IsNotExist(err) {
			t.Error(err)
		}
		if err := os.Rename(retained, path); err != nil {
			t.Error(err)
		}
	}()
	if _, err := runMacUpdateCommand(context.Background(), 30*time.Second, "/usr/bin/ditto", retained, path); err != nil {
		t.Fatal(err)
	}
	journal := filepath.Join(f.DataDir, "updater", "mac-update-journal.json")
	before, err := os.ReadFile(journal)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fmt.Fprintln(h.pipe, "COMMIT_REJECT"); err != nil {
		t.Fatal(err)
	}
	if got := h.line(t); !strings.HasPrefix(got, "REJECTED:") {
		t.Fatal(got)
	}
	if after, err := os.ReadFile(journal); err != nil || string(after) != string(before) {
		t.Fatal("refused handoff must not write an armed journal", err)
	}
	if node, err := macNode(f.Current); err != nil || node != f.CurrentInfo.Node {
		t.Fatal("refused handoff changed the installed bundle", err)
	}
	if _, err := os.Stat(filepath.Join(h.work, "next.app")); err != nil {
		t.Fatal("refusal removed the staged candidate", err)
	}
}

func TestMacUpdateRejectsAndPreservesReplacedHelperBundle(t *testing.T) {
	ctx := context.Background()
	root, err := macCanonical(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "Installed.app")
	createMacTestBundle(t, target, self, "app.chordv.mygo.local.helper-copy-test", "1.0.0", 1, "13.0")
	current, err := readMacBundle(ctx, target, true)
	if err != nil {
		t.Fatal(err)
	}
	work, err := os.MkdirTemp(root, ".chordv-mac-update-")
	if err != nil {
		t.Fatal(err)
	}
	dir, err := readMacSwapDirectories(target, work)
	if err != nil {
		t.Fatal(err)
	}
	p := macUpdatePlan{Work: work, Current: current, Directories: &dir}
	scope := dir.cleanupScope(current)
	if err := p.stageHelperBundle(ctx, &scope); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(work, macUpdateHelperBundleName)
	retained := filepath.Join(root, "preserved-copy.app")
	if err := os.Rename(path, retained); err != nil {
		t.Fatal(err)
	}
	if _, err = runMacUpdateCommand(ctx, 30*time.Second, "/usr/bin/ditto", retained, path); err != nil {
		t.Fatal(err)
	}
	if clone, err := readMacBundle(ctx, path, true); err != nil || !macBundleSealMatches(clone, current) {
		t.Fatal("the substitute must be a valid, identical signed clone", err)
	}
	if err := p.verifyHelperBundle(ctx); err == nil {
		t.Fatal("an identical signature did not prove ownership of a replacement directory")
	}
	if err := cleanupMacParentWork(work, &scope); err == nil {
		t.Fatal("an unowned helper copy must not be removed by the parent")
	}
	if err := cleanupMacUpdateWorkWithScope(work, &scope); err == nil {
		t.Fatal("an unowned helper copy must not be removed by the terminal cleanup")
	}
	for _, bundle := range []string{target, retained, path} {
		if actual, err := readMacBundle(ctx, bundle, true); err != nil || !macBundleSealMatches(actual, current) {
			t.Fatal("refusal did not preserve all sealed bundles", bundle, err)
		}
	}
}

func TestMacUpdateEarlyCancelPreservesWorkAfterOriginalIsReplaced(t *testing.T) {
	f := newMacRecoveryFixture(t, false)
	p := &f.plan
	if err := os.RemoveAll(filepath.Join(p.Work, "next.app")); err != nil {
		t.Fatal(err)
	}
	updater := filepath.Join(p.DataDir, "updater")
	if err := os.Remove(filepath.Join(updater, "mac-update-journal.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(p.Work, "transaction.json")); err != nil {
		t.Fatal(err)
	}
	bindMacFixtureSwapDirectories(t, p)
	scope := p.Directories.cleanupScope(p.Current)
	if err := p.stageHelperBundle(context.Background(), &scope); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(p.Work, "helper")); err != nil {
		t.Fatal(err)
	}
	retained := filepath.Join(f.root, "retained-original.app")
	if err := os.Rename(p.Current.Path, retained); err != nil {
		t.Fatal(err)
	}
	if _, err := runMacUpdateCommand(context.Background(), 30*time.Second, "/usr/bin/ditto", retained, p.Current.Path); err != nil {
		t.Fatal(err)
	}
	if err := cleanupMacParentWork(p.Work, &scope); err == nil {
		t.Fatal("parent cleaned work despite the different installed identity")
	}
	if err := p.cancelPreparedWork(); err == nil || !strings.Contains(err.Error(), "安装位置已变化") {
		t.Fatal("early cancellation must retain work after the installed identity changes", err)
	}
	for _, path := range []string{filepath.Join(p.Work, macUpdatePlanName), p.helperExecutable(), p.Current.Path, retained} {
		if _, err := os.Stat(path); err != nil {
			t.Fatal("refusal did not preserve", path, err)
		}
	}
}
