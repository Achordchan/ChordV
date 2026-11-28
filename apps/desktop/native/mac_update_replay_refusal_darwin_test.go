//go:build darwin

package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestMacRecoveryReplayRejectsSelfConsistentForgeryAndUnknownState(t *testing.T) {
	for _, name := range []string{"ordinary-files-resigned-by-attacker", "wrong-uid", "wrong-generation-shape", "unknown-health", "missing-backup", "new-target-C", "live-helper", "unknown-helper"} {
		t.Run(name, func(t *testing.T) {
			f := newMacRecoveryFixture(t, name == "live-helper" || name == "unknown-helper")
			if name == "unknown-helper" {
				f.transaction.HelperIdentity += "-unknown"
			}
			a := newMacReplayTestAuthority(t, f)
			if err := f.plan.swap(f.transaction.Current.Node, f.transaction.Candidate.Node); err != nil {
				t.Fatal(err)
			}
			switch name {
			case "ordinary-files-resigned-by-attacker":
				f.plan.HelperSHA256 = testHash([]byte("attacker replacement"))
				f.persist(t) // All ordinary hashes agree; protected intent must not.
			case "wrong-uid":
				a.intent.UID++
			case "wrong-generation-shape":
				a.intent.Generation = "../../old-generation"
			case "unknown-health":
				a.intent.Capability = "health_unreadable"
			case "missing-backup":
				if err := os.Rename(f.transaction.Candidate.Path, filepath.Join(f.root, "RetainedA.app")); err != nil {
					t.Fatal(err)
				}
			case "new-target-C":
				if err := os.Rename(f.plan.Current.Path, filepath.Join(f.root, "RetainedB.app")); err != nil {
					t.Fatal(err)
				}
				createMacTestBundle(t, f.plan.Current.Path, f.transaction.HelperExecutable, f.plan.Current.Identifier, "3.0.0", 3, "13.0")
			}
			anchor, err := deriveRecoveryAnchor(context.Background(), f.cfg, f.plan.Current.Executable)
			if err != nil {
				t.Fatal(err)
			}
			lock, err := f.plan.targetLock()
			if err != nil {
				t.Fatal(err)
			}
			lock.Close()
			lock, err = lockMacUpdateData(f.cfg.DataDir)
			if err != nil {
				t.Fatal(err)
			}
			lock.Close()
			before := macRecoveryTree(t, f.root)
			state, err := replayMacUpdateRecovery(context.Background(), anchor, a, nil)
			if err == nil || state != "conflict" && state != "deferred" || !reflect.DeepEqual(before, macRecoveryTree(t, f.root)) {
				t.Fatal("untrusted/uncertain recovery must retain every file", state, err)
			}
		})
	}
}

func TestMacRecoveryReplayControllerProofRejectsReplayAndForgedCapability(t *testing.T) {
	f := newMacRecoveryFixture(t, false)
	a := newMacReplayTestAuthority(t, f)
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		t.Fatal(err)
	}
	proof := a.proof(nonce)
	if _, err := verifyMacReplayTestProof(a.public, nonce, proof, a.intent.Target, a.intent.DataDir); err != nil {
		t.Fatal(err)
	}
	proof.Intent.Capability = "hold_candidate"
	if _, err := verifyMacReplayTestProof(a.public, nonce, proof, a.intent.Target, a.intent.DataDir); err == nil {
		t.Fatal("altered test-controller capability passed signature validation")
	}
	proof = a.proof(nonce)
	nonce[0] ^= 1
	if _, err := verifyMacReplayTestProof(a.public, nonce, proof, a.intent.Target, a.intent.DataDir); err == nil {
		t.Fatal("old proof passed a fresh request nonce")
	}
}

func TestMacRecoveryReplayRevalidatesAfterBExit(t *testing.T) {
	for _, name := range []string{"new-generation", "healthy-same-generation", "work-replaced", "backup-replaced", "extra-B-instance", "stale-ARM", "EOF-without-EXIT"} {
		t.Run(name, func(t *testing.T) {
			f := newMacRecoveryFixture(t, false)
			a := newMacReplayTestAuthority(t, f)
			if err := f.plan.swap(f.transaction.Current.Node, f.transaction.Candidate.Node); err != nil {
				t.Fatal(err)
			}
			timeout := 5 * time.Second
			if name == "EOF-without-EXIT" {
				timeout = time.Second
			}
			run := startMacReplayTestRun(t, f, a, timeout, name == "stale-ARM")
			switch name {
			case "new-generation":
				a.update(func(i *macRecoveryIntent) { i.Generation += "-new" })
			case "healthy-same-generation":
				a.update(func(i *macRecoveryIntent) { i.Capability = "hold_candidate" })
			case "work-replaced":
				retained := filepath.Join(f.root, "RetainedWork")
				if err := os.Rename(f.plan.Work, retained); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(f.plan.Work, 0700); err != nil {
					t.Fatal(err)
				}
			case "backup-replaced":
				if err := os.Rename(f.transaction.Candidate.Path, filepath.Join(f.root, "RetainedA.app")); err != nil {
					t.Fatal(err)
				}
				createMacTestBundle(t, f.transaction.Candidate.Path, f.transaction.HelperExecutable, f.plan.Current.Identifier, "3.0.0", 3, "13.0")
			case "extra-B-instance":
				stop := startMacReplayExtraB(t, f.plan.Current.Executable)
				defer stop()
			}
			run.closePipe(t)
			before := macRecoveryTree(t, f.root)
			if name != "EOF-without-EXIT" {
				run.exitParent(t)
			}
			result := run.receive(t)
			if result.Error == "" || result.State == "rolled_back_retained" || !reflect.DeepEqual(before, macRecoveryTree(t, f.root)) {
				t.Fatal("state change or incomplete handoff caused rollback", result)
			}
			if name == "EOF-without-EXIT" {
				run.exitParent(t)
			}
		})
	}
}

func startMacReplayExtraB(t *testing.T, executable string) func() {
	_, stop := startMacReplayExtraProcess(t, executable)
	return stop
}

func startMacReplayExtraProcess(t *testing.T, executable string) (int, func()) {
	t.Helper()
	command := exec.Command(executable, "--mac-recovery-inspect-test-helper")
	command.Env = systemProcessEnvironment()
	input, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = command.Start(); err != nil {
		t.Fatal(err)
	}
	if line, err := bufio.NewReader(output).ReadString('\n'); err != nil || line != "INSPECT_READY\n" {
		t.Fatal("extra B did not start", line, err)
	}
	return command.Process.Pid, func() {
		input.Close()
		if err := command.Wait(); err != nil {
			t.Error(err)
		}
	}
}

func TestMacRecoveryQuiescenceChecksUnlinkedKernelImageNotProcessName(t *testing.T) {
	for _, sameB := range []bool{false, true} {
		t.Run(map[bool]string{false: "different-C-kernel-signature", true: "same-B-kernel-signature"}[sameB], func(t *testing.T) {
			f := newMacRecoveryFixture(t, false)
			original := f.transaction.Current.Executable
			if sameB {
				original = f.transaction.Candidate.Executable
			}
			unlinked := filepath.Join(f.root, "Unlinked-running-image")
			if err := copyAtomic(original, unlinked, 0700); err != nil {
				t.Fatal(err)
			}
			pid, stop := startMacReplayExtraProcess(t, unlinked)
			defer stop()
			if err := os.Remove(unlinked); err != nil {
				t.Fatal(err)
			}
			if path, err := macHealthProcessPath(pid); err == nil {
				t.Fatal("fixture must actually have an unreadable kernel path", path)
			}
			hash, err := macHealthProcessCDHash(pid)
			if err != nil || (hash == f.transaction.Candidate.CDHash) != sameB {
				t.Fatal("real kernel code signature fixture mismatch", hash, sameB, err)
			}
			err = macRecoveryCandidateQuiescent(macBundleInfo{Executable: f.plan.Current.Executable, CDHash: f.transaction.Candidate.CDHash})
			if (err != nil) != sameB {
				t.Fatal("unreadable path must exclude only a proven non-B kernel image", sameB, err)
			}
			t.Logf("unlinked owned pid=%d path unreadable; sameB=%t codehash=%s rejected=%t", pid, sameB, hash, err != nil)
		})
	}
}

func TestMacRecoveryReplayHonorsTargetThenDataLocks(t *testing.T) {
	f := newMacRecoveryFixture(t, false)
	a := newMacReplayTestAuthority(t, f)
	anchor, err := deriveRecoveryAnchor(context.Background(), f.cfg, f.plan.Current.Executable)
	if err != nil {
		t.Fatal(err)
	}
	targetLock, err := f.plan.targetLock()
	if err != nil {
		t.Fatal(err)
	}
	state, replayErr := replayMacUpdateRecovery(context.Background(), anchor, a, nil)
	targetLock.Close()
	if replayErr == nil || state != "deferred" || a.calls != 0 {
		t.Fatal("target lock contention must precede provider access", state, replayErr, a.calls)
	}
	dataLock, err := lockMacUpdateData(f.cfg.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	state, replayErr = replayMacUpdateRecovery(context.Background(), anchor, a, nil)
	dataLock.Close()
	if replayErr == nil || state != "deferred" || a.calls != 0 {
		t.Fatal("data lock contention must precede provider access", state, replayErr, a.calls)
	}
	lockPath := filepath.Join(f.cfg.DataDir, "updater", "mac-update.lock")
	if err := os.Rename(lockPath, lockPath+"-retained"); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(lockPath+"-retained", lockPath); err != nil {
		t.Fatal(err)
	}
	state, replayErr = replayMacUpdateRecovery(context.Background(), anchor, a, nil)
	if replayErr == nil || state != "deferred" || a.calls != 0 {
		t.Fatal("symlink data lock must not be followed", state, replayErr, a.calls)
	}
}
