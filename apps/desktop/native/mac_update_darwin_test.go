//go:build darwin

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestMacUpdateRestartDoesNotOverridePackagedAPIOrigin(t *testing.T) {
	mode := buildMode
	t.Cleanup(func() { buildMode = mode })
	plan := macUpdatePlan{DataDir: t.TempDir(), APIBase: "https://previous-api.invalid", Repository: "project/desktop", PublicKey: "local-test-key"}
	buildMode = "release"
	if got := plan.restartEnvironment(); !slices.Equal(got, []string{"CHORDV_MYGO_DATA_DIR=" + plan.DataDir}) {
		t.Fatalf("release restart leaked configuration from the previous build: %v", got)
	}
	buildMode = "local"
	plan.APIBase = "http://127.0.0.1:21300"
	want := []string{"CHORDV_MYGO_DATA_DIR=" + plan.DataDir, "CHORDV_API_BASE_URL=" + plan.APIBase,
		"CHORDV_GITHUB_RELEASE_REPOSITORY=" + plan.Repository, "CHORDV_GITHUB_RELEASE_PUBLIC_KEY=" + plan.PublicKey}
	if got := plan.restartEnvironment(); !slices.Equal(got, want) {
		t.Fatalf("local restart lost its independent configuration: %v", got)
	}
}

func TestMacUpdateValidationNeverExecutesCandidate(t *testing.T) {
	f := macFixture(t, "13.0")
	if _, err := os.Stat(f.Marker); !os.IsNotExist(err) {
		t.Fatal("metadata validation executed the candidate", err)
	}
	if f.CandidateInfo.Build.Build != 2 || f.CandidateInfo.Version != "2.0.0" {
		t.Fatal("sealed build metadata not read")
	}
	data, err := os.ReadFile(filepath.Join(f.Candidate, "Contents", "Info.plist"))
	if err != nil {
		t.Fatal(err)
	}
	dict, err := parsePlist(data)
	if err != nil {
		t.Fatal(err)
	}
	delete(dict, "ChordVBuildInfo")
	data, err = marshalPlist(dict)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(f.Candidate, "Contents", "Info.plist"), data, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err = runMacUpdateCommand(context.Background(), 30*time.Second, "/usr/bin/codesign", "--force", "--sign", "-", f.Candidate); err != nil {
		t.Fatal(err)
	}
	if _, err = readMacBundle(context.Background(), f.Candidate, true); err == nil || !strings.Contains(err.Error(), "ChordVBuildInfo") {
		t.Fatalf("missing sealed metadata was not rejected: %v", err)
	}
	if _, err = os.Stat(f.Marker); !os.IsNotExist(err) {
		t.Fatal("missing metadata triggered executable fallback", err)
	}
}

func TestMacUpdateHelperRejectsNonprivateDataLockBeforePreparing(t *testing.T) {
	f := macFixture(t, "13.0")
	lockPath := filepath.Join(f.DataDir, "updater", "mac-update.lock")
	if err := os.WriteFile(lockPath, []byte("keep existing lock"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(lockPath, 0644); err != nil {
		t.Fatal(err)
	}
	h := startMacHolder(t, f)
	select {
	case line := <-h.lines:
		if line != "" {
			t.Fatalf("invalid lock reached update readiness: %s", line)
		}
	case <-time.After(40 * time.Second):
		t.Fatal("update helper did not reject invalid lock")
	}
	if err := <-h.done; err == nil {
		t.Fatal("invalid lock accepted by installer")
	}
	if raw, err := os.ReadFile(lockPath); err != nil || string(raw) != "keep existing lock" {
		t.Fatal("existing lock content changed", err)
	}
	if node, err := macNode(f.Current); err != nil || node != f.CurrentInfo.Node {
		t.Fatal("installed application changed", err)
	}
	if _, err := os.Lstat(filepath.Join(f.DataDir, "updater", "mac-update-journal.json")); !os.IsNotExist(err) {
		t.Fatal("unexpected update journal", err)
	}
}

func TestMacUpdatePreparedAbortAndLostArmAcknowledgment(t *testing.T) {
	for _, armed := range []bool{false, true} {
		t.Run(fmt.Sprintf("armed=%t", armed), func(t *testing.T) {
			f := macFixture(t, "13.0")
			h := startMacHolder(t, f)
			h.ready(t)
			assertMacNoMount(t, h.work, f.Installer)
			if armed {
				_, _ = fmt.Fprintln(h.pipe, "ARM_RAW")
				if got := h.line(t); got != "RAW_ARM_SENT" {
					t.Fatal(got)
				}
				macWait(t, filepath.Join(f.DataDir, "updater"), 10*time.Second, func() bool {
					data, _ := os.ReadFile(filepath.Join(f.DataDir, "updater", "mac-update-journal.json"))
					return strings.Contains(string(data), `"phase": "armed"`)
				})
			}
			_, _ = fmt.Fprintln(h.pipe, "ABORT")
			if got := h.line(t); got != "ABORTED" {
				t.Fatal(got)
			}
			if node, err := macNode(f.Current); err != nil || node != f.CurrentInfo.Node {
				t.Fatal("abort replaced current app", err)
			}
			if _, err := os.Stat(f.Marker); !os.IsNotExist(err) {
				t.Fatal("abort launched candidate", err)
			}
			if _, err := os.Stat(h.work); !os.IsNotExist(err) {
				t.Fatal("abort retained work", err)
			}
			assertMacNoMount(t, h.work, f.Installer)
		})
	}
}

func TestMacUpdateArmedEOFWaitsForActualParentExitAndRestarts(t *testing.T) {
	f := macFixture(t, "13.0")
	h := startMacHolder(t, f)
	h.ready(t)
	_, _ = fmt.Fprintln(h.pipe, "ARM_REPORT_FAIL")
	if got := h.line(t); got != "QUIT_REQUESTED" {
		t.Fatal(got)
	}
	if got := h.line(t); got != "COMMITTED" {
		t.Fatal(got)
	}
	_, _ = fmt.Fprintln(h.pipe, "ABORT_REJECT")
	if got := h.line(t); got != "CANCEL_REJECTED" {
		t.Fatal(got)
	}
	_, _ = fmt.Fprintln(h.pipe, "PIPE_EOF")
	if got := h.line(t); got != "PIPE_CLOSED" {
		t.Fatal(got)
	}
	macWait(t, filepath.Join(f.DataDir, "updater"), 10*time.Second, func() bool {
		data, _ := os.ReadFile(filepath.Join(f.DataDir, "updater", "mac-update-journal.json"))
		return strings.Contains(string(data), `"phase": "waiting_parent_exit"`)
	})
	if node, err := macNode(f.Current); err != nil || node != f.CurrentInfo.Node {
		t.Fatal("pipe EOF was mistaken for actual GUI process exit", err)
	}
	_, _ = fmt.Fprintln(h.pipe, "EXIT")
	if err := <-h.done; err != nil {
		t.Fatal(err)
	}
	macWait(t, filepath.Join(f.DataDir, "updater"), 40*time.Second, func() bool {
		data, _ := os.ReadFile(filepath.Join(f.DataDir, "updater", "install-report.json"))
		return strings.Contains(string(data), `"ok": true`)
	})
	macWait(t, f.Root, 20*time.Second, func() bool {
		_, markerErr := os.Stat(f.Marker)
		_, workErr := os.Stat(h.work)
		return markerErr == nil && os.IsNotExist(workErr)
	})
	installed, err := readMacBundle(context.Background(), f.Current, true)
	if err != nil {
		t.Fatal(err)
	}
	if installed.CDHash != f.CandidateInfo.CDHash || installed.Build.Build != 2 {
		t.Fatal("new verified bundle not installed")
	}
	if _, err = os.Stat(h.work); !os.IsNotExist(err) {
		t.Fatal("successful handoff retained its work", err)
	}
	assertMacNoMount(t, h.work, f.Installer)
}

func TestMacUpdateOSLaunchRejectionRollsBackAtomically(t *testing.T) {
	f := macFixture(t, "99.0")
	h := startMacHolder(t, f)
	h.ready(t)
	_, _ = fmt.Fprintln(h.pipe, "ARM")
	if got := h.line(t); got != "ARMED" {
		t.Fatal(got)
	}
	_, _ = fmt.Fprintln(h.pipe, "EXIT")
	if err := <-h.done; err != nil {
		t.Fatal(err)
	}
	macWait(t, filepath.Join(f.DataDir, "updater"), 45*time.Second, func() bool {
		data, _ := os.ReadFile(filepath.Join(f.DataDir, "updater", "install-report.json"))
		return strings.Contains(string(data), `"ok": false`)
	})
	installed, err := readMacBundle(context.Background(), f.Current, true)
	if err != nil {
		t.Fatal(err)
	}
	if installed.Node != f.CurrentInfo.Node || installed.CDHash != f.CurrentInfo.CDHash {
		t.Fatal("launch rejection did not restore original bundle")
	}
	if _, err = os.Stat(f.Marker); !os.IsNotExist(err) {
		t.Fatal("OS-rejected app unexpectedly executed", err)
	}
	assertMacNoMount(t, h.work, f.Installer)
	assertMacRollbackDisposition(t, f, h.work)
}

func TestMacUpdateNativeHealthFailureStopsCandidateBeforeRollback(t *testing.T) {
	f := macFixtureHealth(t, "13.0", "native-error")
	h := startMacHolder(t, f)
	h.ready(t)
	_, _ = fmt.Fprintln(h.pipe, "ARM")
	if got := h.line(t); got != "ARMED" {
		t.Fatal(got)
	}
	_, _ = fmt.Fprintln(h.pipe, "EXIT")
	if err := <-h.done; err != nil {
		t.Fatal(err)
	}
	macWait(t, filepath.Join(f.DataDir, "updater"), 45*time.Second, func() bool {
		data, _ := os.ReadFile(filepath.Join(f.DataDir, "updater", "install-report.json"))
		return strings.Contains(string(data), `"ok": false`)
	})
	installed, err := readMacBundle(context.Background(), f.Current, true)
	if err != nil || installed.Node != f.CurrentInfo.Node || installed.CDHash != f.CurrentInfo.CDHash {
		t.Fatal("failed native startup did not restore original app", err)
	}
	if _, err := os.Stat(f.Marker); !os.IsNotExist(err) {
		t.Fatal("failed native startup was reported as healthy", err)
	}
	if _, err := os.Stat(filepath.Join(f.Root, "original-restarted")); err != nil {
		t.Fatal("restored old executable was not restarted", err)
	}
	data, err := os.ReadFile(f.Marker + ".pid")
	if err != nil {
		t.Fatal("failed candidate did not actually execute", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		t.Fatal(err)
	}
	if path, err := macHealthProcessPath(pid); err == nil && path == f.CurrentInfo.Executable {
		t.Fatal("candidate was still alive after reverse swap")
	}
	assertMacNoMount(t, h.work, f.Installer)
	assertMacRollbackDisposition(t, f, h.work)
}

func assertMacRollbackDisposition(t *testing.T, f macUpdateFixture, work string) {
	t.Helper()
	updater := filepath.Join(f.DataDir, "updater")
	journalPath := filepath.Join(updater, "mac-update-journal.json")
	raw, err := os.ReadFile(filepath.Join(updater, "install-report.json"))
	var report struct{ Summary string }
	if err != nil || json.Unmarshal(raw, &report) != nil || report.Summary == "" {
		t.Fatal("missing update failure report", err)
	}
	// The fixture original exits after writing its restart marker; LaunchServices
	// can observe either side of that exit. An unconfirmed relaunch must retain both records.
	if strings.Contains(report.Summary, "原版本已恢复，重新启动未确认") {
		raw, err = readMacRecoveryFile(journalPath)
		var j macUpdateJournal
		if err != nil || json.Unmarshal(raw, &j) != nil || j.Phase != "rolled_back" || j.Target != f.Current || j.Work != work {
			t.Fatal("unconfirmed relaunch did not preserve its rollback journal", err)
		}
		staged, err := readMacBundle(context.Background(), filepath.Join(work, "next.app"), true)
		if err != nil || staged.CDHash != f.CandidateInfo.CDHash || staged.Build != f.CandidateInfo.Build {
			t.Fatal("unconfirmed relaunch lost the candidate bundle", err)
		}
		return
	}
	for _, path := range []string{work, journalPath} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatalf("completed rollback did not clear %s: %v", path, err)
		}
	}
}

func TestMacUpdateParentKilledDuringPreparationDetachesOwnedImage(t *testing.T) {
	f := macFixture(t, "13.0")
	h := startMacHolder(t, f)
	macWait(t, filepath.Join(f.DataDir, "updater"), 30*time.Second, func() bool {
		data, _ := os.ReadFile(filepath.Join(f.DataDir, "updater", "mac-update-journal.json"))
		var journal macUpdateJournal
		if json.Unmarshal(data, &journal) != nil || journal.Phase != "mounting" {
			return false
		}
		h.work = journal.Work
		return true
	})
	if err := h.command.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	<-h.done
	macWait(t, f.Root, 45*time.Second, func() bool { _, err := os.Stat(h.work); return os.IsNotExist(err) })
	assertMacNoMount(t, h.work, f.Installer)
	if node, err := macNode(f.Current); err != nil || node != f.CurrentInfo.Node {
		t.Fatal("unarmed parent death modified installed app", err)
	}
	if _, err := os.Stat(f.Marker); !os.IsNotExist(err) {
		t.Fatal("unarmed parent death launched candidate", err)
	}
}
