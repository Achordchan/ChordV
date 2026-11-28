//go:build darwin

package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

type macReplayHealthTestAuthority struct {
	*macReplayTestAuthority
	want      macVerifiedUpdateHealth
	supersede bool
	afterMark context.CancelFunc
	markError error
	markCalls int
}

func (a *macReplayHealthTestAuthority) markHealthy(ctx context.Context, expected macRecoveryIntent, proof macVerifiedUpdateHealth) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.markCalls++
	if proof != a.want {
		return errors.New("test authority received evidence for a different verified health session")
	}
	if a.supersede {
		// Model a new generation becoming active just before the protected compare-and-set.
		a.intent.Generation += "-superseded"
	}
	if a.intent != expected || a.intent.Capability != "rollback_original" {
		return errors.New("test authority refused to mark a stale recovery intent")
	}
	a.intent.Capability = "hold_candidate"
	if a.afterMark != nil {
		a.afterMark()
	}
	return a.markError
}

func TestMacRecoveryHealthCommitFromSignedCandidate(t *testing.T) {
	root, err := macCanonical(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	binary := macHealthFixtureBinary(t, root)
	for _, tc := range []struct {
		name, mode, wantCapability, wantReplay string
		wantCalls                              int
		supersede, cancelAfterMark, markError  bool
		tamperTransaction                      bool
	}{
		{name: "dual-ready", mode: "healthy", wantCapability: "hold_candidate", wantReplay: "healthy_retained", wantCalls: 1},
		{name: "wrong-challenge", mode: "wrong-ack", wantCapability: "rollback_original", wantReplay: "needs_parent_exit"},
		{name: "native-not-ready", mode: "native-error", wantCapability: "rollback_original", wantReplay: "needs_parent_exit"},
		{name: "transaction-original-bytes-changed", mode: "healthy", wantCapability: "rollback_original", wantReplay: "conflict", tamperTransaction: true},
		{name: "superseded-generation", mode: "healthy", wantCapability: "rollback_original", wantReplay: "needs_parent_exit", wantCalls: 1, supersede: true},
		{name: "cancel-after-commit", mode: "healthy", wantCapability: "hold_candidate", wantReplay: "healthy_retained", wantCalls: 1, cancelAfterMark: true},
		{name: "provider-error-after-commit", mode: "healthy", wantCapability: "hold_candidate", wantReplay: "healthy_retained", wantCalls: 1, markError: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newMacRecoveryFixtureWithHelper(t, false, true)
			path := f.transaction.Candidate.Path
			createMacTestBundle(t, path, binary, f.plan.Current.Identifier, "2.0.0", 2, "13.0")
			ctx := context.Background()
			candidate, err := readMacBundle(ctx, path, true)
			if err != nil {
				t.Fatal(err)
			}
			f.transaction.Candidate = candidate
			f.journal.CandidateCDHash, f.journal.Phase = candidate.CDHash, "launch_requested"
			a := &macReplayHealthTestAuthority{macReplayTestAuthority: newMacReplayTestAuthority(t, f), supersede: tc.supersede}
			intent, err := a.active(ctx, f.plan.Current.Path, f.cfg.DataDir)
			if err != nil || intent.Capability != "rollback_original" {
				t.Fatal("missing original recovery intent", intent, err)
			}
			f.plan.planSHA256, f.plan.transactionSHA256 = f.journal.PlanSHA256, f.journal.TransactionSHA256
			journalPath := filepath.Join(f.cfg.DataDir, "updater", "mac-update-journal.json")
			journalRaw, err := os.ReadFile(journalPath)
			if err != nil {
				t.Fatal(err)
			}
			f.plan.lastJournalSHA256 = macPlanDigest(journalRaw)
			targetLock, err := f.plan.targetLock()
			if err != nil {
				t.Fatal(err)
			}
			defer targetLock.Close()
			dataLock, err := lockMacUpdateData(f.cfg.DataDir)
			if err != nil {
				t.Fatal(err)
			}
			defer dataLock.Close()
			if err = f.plan.swap(f.plan.Current.Node, candidate.Node); err != nil {
				t.Fatal(err)
			}
			installed, err := readMacBundle(ctx, f.plan.Current.Path, true)
			if err != nil || installed.Node != candidate.Node || !macBundleSealMatches(installed, candidate) {
				t.Fatal("staged candidate was not installed", err)
			}
			health, err := startMacUpdateHealth(&f.plan, candidate)
			if err != nil {
				t.Fatal(err)
			}
			defer health.Close()
			env := append(health.RestartEnvironment(), "CHORDV_HEALTH_PROOF_MODE="+tc.mode, "CHORDV_HEALTH_PROOF_MARKER="+filepath.Join(f.root, "client-result"))
			launchCtx, cancelLaunch := context.WithTimeout(ctx, 15*time.Second)
			owned, err := launchMacUpdateApplication(launchCtx, installed, env)
			cancelLaunch()
			if err != nil {
				t.Fatal(err)
			}
			defer owned.Close()
			stop := func() error {
				stopCtx, cancelStop := context.WithTimeout(ctx, 6*time.Second)
				defer cancelStop()
				return owned.StopAndWait(stopCtx)
			}
			defer func() {
				if err := stop(); err != nil {
					t.Error("owned candidate cleanup:", err)
				}
			}()
			a.want = macVerifiedUpdateHealth{
				Operation: intent.Operation, Target: intent.Target, DataDir: intent.DataDir,
				PlanSHA256: intent.PlanSHA256, TransactionSHA256: intent.TransactionSHA256,
				Candidate: intent.Candidate, CandidateFilesystem: intent.Filesystem.Candidate,
				PID: owned.PID, ProcessIdentity: owned.identity, ChallengeSHA256: macPlanDigest([]byte(health.challenge)),
			}
			waitCtx, cancelWait := context.WithTimeout(ctx, 10*time.Second)
			defer cancelWait()
			if tc.cancelAfterMark {
				a.afterMark = cancelWait
			}
			if tc.markError {
				a.markError = errors.New("test provider lost confirmation after changing the intent")
			}
			if tc.tamperTransaction {
				path := filepath.Join(f.plan.Work, "transaction.json")
				raw, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				if err = os.WriteFile(path, append(raw, '\n'), 0600); err != nil {
					t.Fatal(err)
				}
			}
			err = health.Wait(waitCtx, owned, &macRecoveryHealthCommit{authority: a, expected: intent})
			if (err == nil) != (tc.name == "dual-ready") || errors.Is(err, errMacUpdateHealthCommitUncertain) != (tc.cancelAfterMark || tc.supersede || tc.markError) {
				t.Fatal("unexpected health commit result", err)
			}
			active, err := a.active(ctx, intent.Target, intent.DataDir)
			a.mu.Lock()
			calls := a.markCalls
			a.mu.Unlock()
			if err != nil || active.Capability != tc.wantCapability || calls != tc.wantCalls || (active.Generation != intent.Generation) != tc.supersede {
				t.Fatal("unexpected protected recovery state", active, "mark calls", calls, err)
			}
			if err = stop(); err != nil {
				t.Fatal("candidate exit was not confirmed before replay", err)
			}
			if err = errors.Join(dataLock.Close(), targetLock.Close()); err != nil {
				t.Fatal("release installer locks before replay", err)
			}
			actualJournal, err := os.ReadFile(journalPath)
			if err != nil || string(actualJournal) != string(journalRaw) {
				t.Fatal("protected health must not depend on rewriting the launch journal", err)
			}
			anchor, err := deriveRecoveryAnchor(ctx, f.cfg, installed.Executable)
			if err != nil {
				t.Fatal(err)
			}
			before := macRecoveryTree(t, f.root)
			state, err := replayMacUpdateRecovery(ctx, anchor, a, nil)
			if state != tc.wantReplay || (err == nil) != (state == "healthy_retained") || !reflect.DeepEqual(before, macRecoveryTree(t, f.root)) {
				t.Fatal("replay changed the installed candidate, original backup or recovery records", state, err)
			}
		})
	}
}
