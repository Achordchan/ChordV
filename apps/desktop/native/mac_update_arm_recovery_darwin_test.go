//go:build darwin

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// The real helper process calls this isolated, in-memory store. Observer files
// prove ordering to the test parent; they are never read as authority.
type macRecoveryArmTestStore struct {
	mode, updater string
	pending       macRecoveryPendingArm
	bound         macRecoveryIntent
}

func (s *macRecoveryArmTestStore) write(event string, intent macRecoveryIntent) error {
	return atomicJSON(filepath.Join(s.updater, "test-protected-"+event+".json"), intent)
}

func (s *macRecoveryArmTestStore) reserve(ctx context.Context, pending macRecoveryPendingArm) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if s.pending != (macRecoveryPendingArm{}) || pending.HelperPID != os.Getpid() || pending.Intent.Capability != "" || pending.Intent.TransactionSHA256 != "" {
		return errors.New("invalid test store reservation")
	}
	if _, err := os.Lstat(filepath.Join(pending.Intent.Work, "transaction.json")); !os.IsNotExist(err) {
		return errors.New("reserved only after the transaction already existed")
	}
	s.pending = pending
	if _, err := s.active(ctx, pending.Intent.Target, pending.Intent.DataDir); err == nil {
		return errors.New("unbound reservation exposed an active recovery capability")
	}
	if err := s.write("reserved", pending.Intent); err != nil {
		return err
	}
	if s.mode == "reserve-error" {
		return errors.New("test provider lost reservation acknowledgment")
	}
	return nil
}

func (s *macRecoveryArmTestStore) bind(ctx context.Context, before macRecoveryPendingArm, digest string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if s.mode == "superseded" {
		s.pending.Intent.Generation += "-new"
	}
	if before != s.pending || s.bound != (macRecoveryIntent{}) {
		return errors.New("test store rejected the previous reservation")
	}
	path := filepath.Join(before.Intent.Work, "transaction.json")
	data, err := readMacRecoveryFile(path)
	if err != nil || macPlanDigest(data) != digest {
		return errors.New("test store did not observe the exact transaction")
	}
	var journal macUpdateJournal
	raw, err := readMacRecoveryFile(filepath.Join(s.updater, "mac-update-journal.json"))
	if err != nil || json.Unmarshal(raw, &journal) != nil || journal.Phase != "swap_pending" || journal.TransactionSHA256 != digest {
		return errors.New("test store did not observe the pre-swap durable record")
	}
	s.bound = before.Intent
	s.bound.TransactionSHA256, s.bound.Capability = digest, "rollback_original"
	if err := s.write("bound", s.bound); err != nil {
		return err
	}
	switch s.mode {
	case "bind-error":
		return errors.New("test provider lost binding acknowledgment")
	case "changed-after-binding":
		return os.WriteFile(path, append(data, '\n'), 0600)
	}
	return nil
}

func (s *macRecoveryArmTestStore) active(ctx context.Context, target, dataDir string) (macRecoveryIntent, error) {
	if err := ctx.Err(); err != nil {
		return macRecoveryIntent{}, err
	}
	if s.bound.Target != target || s.bound.DataDir != dataDir {
		return macRecoveryIntent{}, errors.New("reservation has no active recovery capability")
	}
	if s.mode == "changed-before-live-rollback" {
		var journal macUpdateJournal
		raw, _ := readMacRecoveryFile(filepath.Join(s.updater, "mac-update-journal.json"))
		if json.Unmarshal(raw, &journal) == nil && journal.Phase == "launch_requested" {
			changed := s.bound
			changed.Generation += "-replaced"
			return changed, nil
		}
	}
	return s.bound, nil
}

func (s *macRecoveryArmTestStore) markHealthy(ctx context.Context, expected macRecoveryIntent, proof macVerifiedUpdateHealth) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if s.bound != expected || expected.Capability != "rollback_original" || proof.Candidate != expected.Candidate ||
		proof.TransactionSHA256 != expected.TransactionSHA256 || proof.Operation != expected.Operation || proof.PID <= 1 {
		return errors.New("test store rejected stale health proof")
	}
	s.bound.Capability = "hold_candidate"
	if err := s.write("healthy", s.bound); err != nil {
		return err
	}
	if s.mode == "health-ack-lost" {
		return errors.New("test provider lost the durable health acknowledgment")
	}
	return nil
}

func TestMacRecoveryStoreFailureRejectsBeforeReady(t *testing.T) {
	f := macFixture(t, "13.0")
	updater := filepath.Join(f.DataDir, "updater")
	if err := os.WriteFile(filepath.Join(updater, "test-protected-recovery-mode"), []byte("provider-unavailable"), 0600); err != nil {
		t.Fatal(err)
	}
	h := startMacHolder(t, f)
	select {
	case line := <-h.lines:
		if line != "" {
			t.Fatalf("holder announced readiness with no protected store: %s", line)
		}
	case <-time.After(45 * time.Second):
		t.Fatal("provider refusal did not reach the holder")
	}
	if err := <-h.done; err == nil {
		t.Fatal("holder did not report a failed prepare")
	}
	var outcome struct {
		OK      bool   `json:"ok"`
		Summary string `json:"summary"`
	}
	report, err := readMacRecoveryFile(filepath.Join(updater, "install-report.json"))
	if err != nil || json.Unmarshal(report, &outcome) != nil || outcome.OK || !strings.Contains(outcome.Summary, "test protected store unavailable") {
		t.Fatalf("expected the precise provider failure in the report: %v %s", err, report)
	}
	for _, path := range []string{f.Marker + ".pid", filepath.Join(updater, "test-protected-reserved.json"), filepath.Join(updater, "mac-update-journal.json")} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatalf("refused before READY but left an active update witness %s: %v", path, err)
		}
	}
	work, err := filepath.Glob(filepath.Join(f.Root, ".chordv-mac-update-*"))
	if err != nil || len(work) != 0 {
		t.Fatalf("failed prepare retained its private work: %v %v", work, err)
	}
	current, err := readMacBundle(context.Background(), f.Current, true)
	if err != nil || !macRecoveryBundleMatches(current, f.CurrentInfo) {
		t.Fatal("provider refusal changed the original application", err)
	}
}

func TestMacRecoveryArmBindsRealHelperTransactionBeforeSwap(t *testing.T) {
	for _, tc := range []struct {
		mode, startup, errorText                         string
		bound, swapped, healthy, restored, lostHealthAck bool
	}{
		{mode: "healthy", startup: "healthy", bound: true, swapped: true, healthy: true},
		{mode: "startup-failure", startup: "native-error", errorText: "原版本已恢复", bound: true, swapped: true, restored: true},
		{mode: "changed-before-live-rollback", startup: "native-error", errorText: "回滚授权已变化", bound: true, swapped: true},
		{mode: "health-ack-lost", startup: "healthy", errorText: "受保护健康确认或最终回执未能确认", bound: true, swapped: true, lostHealthAck: true},
		{mode: "reserve-error", startup: "healthy", errorText: "预授权未确认"},
		{mode: "superseded", startup: "healthy", errorText: "事务绑定未确认"},
		{mode: "bind-error", startup: "healthy", errorText: "事务绑定未确认", bound: true},
		{mode: "changed-after-binding", startup: "healthy", errorText: "绑定后事务原文变化", bound: true},
	} {
		t.Run(tc.mode, func(t *testing.T) {
			f := macFixtureHealth(t, "13.0", tc.startup)
			updater := filepath.Join(f.DataDir, "updater")
			if err := os.WriteFile(filepath.Join(updater, "test-protected-recovery-mode"), []byte(tc.mode), 0600); err != nil {
				t.Fatal(err)
			}
			h := startMacHolder(t, f)
			h.ready(t)
			prepared, err := readMacBundle(context.Background(), filepath.Join(h.work, "next.app"), true)
			if err != nil || !macBundleSealMatches(prepared, f.CandidateInfo) {
				t.Fatal("prepared copy does not match the signed fixture image", err)
			}
			read := func(event string, exists bool) macRecoveryIntent {
				t.Helper()
				var intent macRecoveryIntent
				data, err := readMacRecoveryFile(filepath.Join(updater, "test-protected-"+event+".json"))
				if !exists && os.IsNotExist(err) {
					return intent
				}
				if !exists || err != nil || json.Unmarshal(data, &intent) != nil {
					t.Fatalf("unexpected test authority observation %s: %v", event, err)
				}
				return intent
			}
			read("reserved", false)
			_, _ = fmt.Fprintln(h.pipe, "ARM")
			if tc.mode == "reserve-error" {
				if err := <-h.done; err == nil {
					t.Fatal("original GUI got ARM success after uncertain reservation")
				}
			} else {
				if got := h.line(t); got != "ARMED" {
					t.Fatal(got)
				}
				read("bound", false)
				if _, err := os.Lstat(filepath.Join(h.work, "transaction.json")); !os.IsNotExist(err) {
					t.Fatal("transaction existed before original process exit", err)
				}
				_, _ = fmt.Fprintln(h.pipe, "EXIT")
				if err := <-h.done; err != nil {
					t.Fatal(err)
				}
			}
			var report []byte
			macWait(t, updater, 50*time.Second, func() bool {
				report, _ = os.ReadFile(filepath.Join(updater, "install-report.json"))
				return len(report) > 0
			})
			var outcome struct {
				OK      bool   `json:"ok"`
				Summary string `json:"summary"`
			}
			if json.Unmarshal(report, &outcome) != nil || tc.healthy != outcome.OK || !strings.Contains(outcome.Summary, tc.errorText) {
				t.Fatal("unexpected helper report", string(report))
			}
			if tc.startup == "native-error" && !strings.Contains(outcome.Summary, "原生启动及界面就绪确认失败") {
				t.Fatal("recovery report lost the original startup failure", string(report))
			}
			reservation := read("reserved", true)
			if !validMacRecoveryID(reservation.Generation) || reservation.Capability != "" || reservation.TransactionSHA256 != "" || reservation.Target != f.Current || reservation.Work != h.work {
				t.Fatal("reservation contained an active or unrelated capability", reservation)
			}
			if intent := read("bound", tc.bound); tc.bound && (intent.Generation != reservation.Generation || intent.Capability != "rollback_original" || intent.TransactionSHA256 == "") {
				t.Fatal("reservation was not bound to the same exact generation", intent)
			}
			persisted := tc.healthy || tc.lostHealthAck
			if intent := read("healthy", persisted); persisted && (intent.Generation != reservation.Generation || intent.Capability != "hold_candidate") {
				t.Fatal("dual readiness did not mark the same generation", intent)
			}
			target, staged := f.CurrentInfo, prepared
			if tc.swapped && !tc.restored {
				target, staged = staged, target
			}
			for actual, expected := range map[string]macBundleInfo{f.Current: target, filepath.Join(h.work, "next.app"): staged} {
				found, err := readMacBundle(context.Background(), actual, true)
				if err != nil || !macRecoveryBundleMatches(found, expected) {
					t.Fatal("live helper lost or substituted an application", actual, err)
				}
			}
			if !tc.swapped {
				if _, err := os.Lstat(f.Marker + ".pid"); !os.IsNotExist(err) {
					t.Fatal("candidate ran without a confirmed recovery transaction", err)
				}
			}
			if tc.startup == "native-error" {
				raw, err := os.ReadFile(f.Marker + ".pid")
				pid, parseErr := strconv.Atoi(strings.TrimSpace(string(raw)))
				if err != nil || parseErr != nil || pid <= 1 || !errors.Is(unix.Kill(pid, 0), unix.ESRCH) {
					t.Fatal("confirmed failed candidate must have exited before the result", err, parseErr)
				}
				reopened := filepath.Join(f.Root, "original-restarted")
				if tc.restored {
					macWait(t, f.Root, 12*time.Second, func() bool {
						raw, err := os.ReadFile(reopened)
						return err == nil && string(raw) == "restarted"
					})
				} else if _, err := os.Lstat(reopened); !os.IsNotExist(err) {
					t.Fatal("refused protected rollback unexpectedly relaunched the original", err)
				}
			}
			if _, err := readMacRecoveryFile(filepath.Join(updater, "mac-update-journal.json")); err != nil {
				t.Fatal("protected operation did not retain its journal", err)
			}
		})
	}
}
