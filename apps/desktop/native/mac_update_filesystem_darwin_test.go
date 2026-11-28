//go:build darwin

package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func runMacRecoverySnapshotTest(configPath string) error {
	raw, err := os.ReadFile(configPath)
	if err != nil {
		return err
	}
	var cfg appConfig
	if err = json.Unmarshal(raw, &cfg); err != nil {
		return err
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	executable, err = macCanonical(executable)
	if err != nil {
		return err
	}
	anchor, err := deriveRecoveryAnchor(context.Background(), cfg, executable)
	if err != nil {
		return err
	}
	result, err := inspectMacUpdateRecovery(context.Background(), anchor)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}

func TestMacRecoveryPersistentSnapshotSurvivesNewProcessAndStalePhase(t *testing.T) {
	f := newMacRecoveryFixture(t, false)
	fs, err := captureMacUpdateFilesystem(&f.plan, f.transaction.Candidate)
	if err != nil {
		t.Fatal(err)
	}
	f.transaction.Filesystem = fs
	f.persist(t)
	config := filepath.Join(f.root, "snapshot-config.json")
	if err := atomicJSON(config, f.cfg); err != nil {
		t.Fatal(err)
	}
	snapshot := func(want string) {
		t.Helper()
		command := exec.Command(f.plan.Current.Executable, "--mac-recovery-snapshot-test", config)
		command.Env = systemProcessEnvironment()
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("fresh-process snapshot: %s %v", output, err)
		}
		var result macRecoveryInspection
		if err := json.Unmarshal(output, &result); err != nil {
			t.Fatal(err, string(output))
		}
		if result.Placement != want || result.MutationAuthorized || !result.RequiresRevalidation {
			t.Fatalf("unexpected fresh-process snapshot: %+v", result)
		}
		t.Logf("new process actual executable bundle placement=%s phase=%s mutationAuthorized=%t", result.Placement, result.PhaseHint, result.MutationAuthorized)
	}
	snapshot("original_staged")
	if err := f.plan.swap(f.plan.Current.Node, f.transaction.Candidate.Node); err != nil {
		t.Fatal(err)
	}
	// No swapped journal is written: process termination can happen after rename.
	snapshot("candidate_installed")
	f.journal.Phase = "healthy"
	f.persist(t)
	snapshot("candidate_installed")
}

func TestMacUpdatePersistentFilesystemIdentityFollowsAtomicSwap(t *testing.T) {
	root, err := macCanonical(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "Installed.app")
	work, err := os.MkdirTemp(root, ".chordv-mac-update-")
	if err != nil {
		t.Fatal(err)
	}
	staged := filepath.Join(work, "next.app")
	for _, path := range []string{target, staged} {
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	currentID, currentNode, err := readMacFilesystemNode(target)
	if err != nil {
		t.Fatal(err)
	}
	candidateID, candidateNode, err := readMacFilesystemNode(staged)
	if err != nil {
		t.Fatal(err)
	}
	if currentID.VolumeUUID != candidateID.VolumeUUID || currentID.FileID == candidateID.FileID {
		t.Fatal("same-volume distinct directory identity not observed")
	}
	p := &macUpdatePlan{Work: work, Current: macBundleInfo{Path: target, Node: currentNode}}
	fs, err := captureMacUpdateFilesystem(p, macBundleInfo{Path: staged, Node: candidateNode})
	if err != nil {
		t.Fatal(err)
	}
	if fs.Current != currentID || fs.Candidate != candidateID {
		t.Fatal("capture changed identities")
	}
	if err := p.swap(currentNode, candidateNode); err != nil {
		t.Fatal(err)
	}
	installed, live, err := readMacFilesystemNode(target)
	if err != nil || installed != candidateID || live != candidateNode {
		t.Fatal("swap lost persistent candidate identity", err)
	}
	old, _, err := readMacFilesystemNode(staged)
	if err != nil || old != currentID {
		t.Fatal("swap lost original persistent identity", err)
	}
	if err := p.swap(candidateNode, currentNode); err != nil {
		t.Fatal(err)
	}
	if got, _, err := readMacFilesystemNode(target); err != nil || got != currentID {
		t.Fatal("rollback changed persistent identity", err)
	}
	if err := os.Rename(target, filepath.Join(root, "moved.app")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(target, 0700); err != nil {
		t.Fatal(err)
	}
	if got, _, err := readMacFilesystemNode(target); err != nil || got == currentID {
		t.Fatal("external replacement reused trusted identity", err)
	}
	if err := p.swap(currentNode, candidateNode); err == nil {
		t.Fatal("persistent record replaced the live FD CAS guard")
	}
}

func TestMacUpdatePersistentFilesystemRejectsLinksAndFiles(t *testing.T) {
	root, err := macCanonical(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "file")
	if err := os.WriteFile(file, []byte("test-only"), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(root, link); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{file, link, filepath.Join(link, "file"), filepath.Join(root, "missing")} {
		if _, _, err := readMacFilesystemNode(path); err == nil {
			t.Fatalf("accepted non-directory or linked path %s", path)
		}
	}
}

func TestMacRecoveryPersistentIdentityNotOldDeviceNumber(t *testing.T) {
	f := newMacRecoveryFixture(t, false)
	fs, err := captureMacUpdateFilesystem(&f.plan, f.transaction.Candidate)
	if err != nil {
		t.Fatal(err)
	}
	f.transaction.Filesystem = fs
	// Model a changed runtime device number in persisted records, not a real reboot.
	f.plan.Current.Node.Device++
	f.transaction.Current = f.plan.Current
	f.transaction.Candidate.Node.Device++
	f.persist(t)
	anchor, err := deriveRecoveryAnchor(context.Background(), f.cfg, f.plan.Current.Executable)
	if err != nil {
		t.Fatal(err)
	}
	result, err := inspectMacUpdateRecovery(context.Background(), anchor)
	if err != nil || result.Placement != "original_staged" || result.MutationAuthorized {
		t.Fatalf("persistent identity did not classify readonly: %+v %v", result, err)
	}
	current, _ := macNode(f.plan.Current.Path)
	candidate, _ := macNode(f.transaction.Candidate.Path)
	if err := f.plan.swap(current, candidate); err != nil {
		t.Fatal(err)
	}
	anchor, err = deriveRecoveryAnchor(context.Background(), f.cfg, f.plan.Current.Executable)
	if err != nil {
		t.Fatal(err)
	}
	result, err = inspectMacUpdateRecovery(context.Background(), anchor)
	if err != nil || result.Placement != "candidate_installed" || result.MutationAuthorized {
		t.Fatalf("persistent swapped identity not classified: %+v %v", result, err)
	}
	f.transaction.Filesystem.Current.BirthNsec = (f.transaction.Filesystem.Current.BirthNsec + 1) % 1e9
	f.persist(t)
	result, err = inspectMacUpdateRecovery(context.Background(), anchor)
	if err == nil && result.Classification != "conflict" {
		t.Fatalf("changed creation identity accepted: %+v", result)
	}
}
