//go:build darwin

package main

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func init() {
	if len(os.Args) == 2 && os.Args[1] == "--mac-recovery-inspect-test-helper" {
		fmt.Fprintln(os.Stdout, "INSPECT_READY")
		_, _ = io.Copy(io.Discard, os.Stdin)
		os.Exit(0)
	}
}

type macRecoveryFixture struct {
	root        string
	cfg         appConfig
	plan        macUpdatePlan
	transaction macUpdateTransaction
	journal     macUpdateJournal
	stopHelper  func()
}

func newMacRecoveryFixture(t *testing.T, keepHelper bool) *macRecoveryFixture {
	t.Helper()
	return newMacRecoveryFixtureWithHelper(t, keepHelper, false)
}

func newMacRecoveryFixtureWithHelper(t *testing.T, keepHelper, fullBundle bool) *macRecoveryFixture {
	t.Helper()
	root, err := macCanonical(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	work, err := os.MkdirTemp(root, ".chordv-mac-update-")
	if err != nil {
		t.Fatal(err)
	}
	cfg := appConfig{DataDir: filepath.Join(root, "data"), ReleaseRepository: "test/recovery", APIBase: "http://127.0.0.1:1"}
	if err = os.MkdirAll(filepath.Join(cfg.DataDir, "updater"), 0700); err != nil {
		t.Fatal(err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	id := "app.chordv.mygo.local.recovery." + macPlanDigest([]byte(root))[:12]
	target, candidate := filepath.Join(root, "Installed.app"), filepath.Join(work, "next.app")
	createMacTestBundle(t, target, self, id, "1.0.0", 1, "13.0")
	createMacTestBundle(t, candidate, self, id, "2.0.0", 2, "13.0")
	current, err := readMacBundle(context.Background(), target, true)
	if err != nil {
		t.Fatal(err)
	}
	next, err := readMacBundle(context.Background(), candidate, true)
	if err != nil {
		t.Fatal(err)
	}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ReleasePublicKey = base64.StdEncoding.EncodeToString(public)
	// This read-only inspector verifies a real signed receipt, not a disk image.
	// No DMG is created, mounted, or used to claim an installation was tested.
	asset := releaseAsset{Platform: "macos", Architecture: architectureName(), FileName: "update.dmg", SHA256: testHash([]byte("receipt-only inspector boundary")), SizeBytes: 512}
	manifest := releaseManifest{SchemaVersion: 1, Tag: "v2.0.0", Version: "2.0.0", Channel: "stable", Build: 2, Installers: []releaseAsset{asset}}
	manifestRaw, _ := json.Marshal(manifest)
	input, _ := json.Marshal(map[string]string{"manifest": string(manifestRaw), "tag": manifest.Tag, "signature": base64.StdEncoding.EncodeToString(ed25519.Sign(private, manifestRaw))})
	service := newDesktopService(cfg)
	defer service.cancel()
	if _, err = service.authorizeReleaseManifest(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	grant, err := service.authorizedDownload("https://github.com/test/recovery/releases/download/v2.0.0/update.dmg", asset.SHA256, asset.SizeBytes)
	if err != nil {
		t.Fatal(err)
	}
	plan := macUpdatePlan{Schema: 1, ID: strings.TrimPrefix(filepath.Base(work), ".chordv-mac-update-"), Work: work, DataDir: cfg.DataDir,
		Repository: cfg.ReleaseRepository, PublicKey: cfg.ReleasePublicKey, APIBase: cfg.APIBase, Current: current,
		ParentPID: os.Getpid(), ParentExecutable: current.Executable,
		Installer: pendingInstaller{Path: filepath.Join(cfg.DataDir, "updater", asset.FileName), SHA256: asset.SHA256, Size: asset.SizeBytes, Version: manifest.Version, Grant: grant}}
	var filesystem *macUpdateFilesystem
	if fullBundle {
		bindMacFixtureSwapDirectories(t, &plan)
		scope := macCleanupScope{target: target, parent: plan.Directories.ParentStable, workspace: plan.Directories.WorkStable}
		if err = plan.stageHelperBundle(context.Background(), &scope); err != nil {
			t.Fatal(err)
		}
		if filesystem, err = captureMacUpdateFilesystem(&plan, next); err != nil {
			t.Fatal(err)
		}
	} else {
		helper := plan.helperExecutable()
		if err = copyAtomic(current.Executable, helper, 0700); err != nil {
			t.Fatal(err)
		}
		if plan.HelperSHA256, err = fileSHA256(helper); err != nil {
			t.Fatal(err)
		}
	}
	helper := plan.helperExecutable()
	pid, stop := startMacRecoveryInspectTestHelper(t, helper)
	identity, err := processIdentity(context.Background(), pid)
	if err != nil {
		t.Fatal(err)
	}
	f := &macRecoveryFixture{root: root, cfg: cfg, plan: plan, stopHelper: stop,
		transaction: macUpdateTransaction{Schema: 1, ID: plan.ID, Current: current, Candidate: next, HelperPID: pid, HelperIdentity: identity, HelperExecutable: helper, Filesystem: filesystem},
		journal:     macUpdateJournal{Schema: 1, ID: plan.ID, Target: target, Work: work, Phase: "swap_pending", CandidateCDHash: next.CDHash}}
	f.persist(t)
	t.Logf("private recovery work=%s helperPID=%d keepAlive=%t; no GUI or DMG launched", work, pid, keepHelper)
	if !keepHelper {
		stop()
	}
	return f
}

func startMacRecoveryInspectTestHelper(t *testing.T, helper string) (int, func()) {
	t.Helper()
	command := exec.Command(helper, "--mac-recovery-inspect-test-helper")
	pipe, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = command.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait(); close(done) }()
	ready := make(chan string, 1)
	go func() { line, _ := bufio.NewReader(stdout).ReadString('\n'); ready <- strings.TrimSpace(line) }()
	var stopOnce sync.Once
	stop := func() {
		stopOnce.Do(func() { _ = pipe.Close() })
		select {
		case err := <-done:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(5 * time.Second):
			t.Error("private inspection helper did not exit after EOF")
		}
	}
	t.Cleanup(stop)
	select {
	case line := <-ready:
		if line != "INSPECT_READY" {
			t.Fatal("private inspection helper did not become ready", line)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("private inspection helper readiness timeout")
	}
	return command.Process.Pid, stop
}

func (f *macRecoveryFixture) persist(t *testing.T) {
	t.Helper()
	planPath := filepath.Join(f.plan.Work, macUpdatePlanName)
	if err := atomicJSON(planPath, f.plan); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(planPath)
	f.transaction.PlanSHA256, f.journal.PlanSHA256 = macPlanDigest(raw), macPlanDigest(raw)
	path := filepath.Join(f.plan.Work, "transaction.json")
	if err := atomicJSON(path, f.transaction); err != nil {
		t.Fatal(err)
	}
	raw, _ = os.ReadFile(path)
	f.journal.TransactionSHA256 = macPlanDigest(raw)
	if err := atomicJSON(filepath.Join(f.cfg.DataDir, "updater", "mac-update-journal.json"), f.journal); err != nil {
		t.Fatal(err)
	}
}

func macRecoveryTree(t *testing.T, root string) map[string]string {
	t.Helper()
	result := map[string]string{}
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		detail := fmt.Sprintf("%s:%d:%s", info.Mode(), info.Size(), info.ModTime().UTC())
		if info.Mode().IsRegular() {
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			digest := sha256.Sum256(data)
			detail += ":" + hex.EncodeToString(digest[:])
		} else if info.Mode()&os.ModeSymlink != 0 {
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			detail += ":" + link
		}
		result[path] = detail
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func (f *macRecoveryFixture) inspect(t *testing.T) (macRecoveryInspection, error) {
	t.Helper()
	before := macRecoveryTree(t, f.root)
	executable := filepath.Join(f.plan.Current.Path, "Contents", "MacOS", "Fixture")
	anchor, err := deriveRecoveryAnchor(context.Background(), f.cfg, executable)
	if err != nil {
		t.Fatal(err)
	}
	inspection, err := inspectMacUpdateRecovery(context.Background(), anchor)
	if inspection.MutationAuthorized || !inspection.RequiresRevalidation || !reflect.DeepEqual(before, macRecoveryTree(t, f.root)) {
		t.Fatal("inspection gained mutation authority or changed private assets", inspection)
	}
	return inspection, err
}

func TestMacRecoveryInspectionClassifiesPhysicalRolesWithoutAuthority(t *testing.T) {
	f := newMacRecoveryFixture(t, false)
	inspection, err := f.inspect(t)
	if err != nil || inspection.Classification != "original_staged" || inspection.HelperState != "gone" || !inspection.ReceiptValid {
		t.Fatal("original/staged pairing not recognized", inspection, err)
	}
	if err = f.plan.swap(f.transaction.Current.Node, f.transaction.Candidate.Node); err != nil {
		t.Fatal(err)
	}
	for _, phase := range []string{"swap_pending", "swapped", "launch_requested", "healthy"} {
		f.journal.Phase = phase
		f.persist(t)
		inspection, err = f.inspect(t)
		if err != nil || inspection.Classification != "candidate_installed" || inspection.PhaseHint != phase {
			t.Fatal("phase hint incorrectly overrode physical placement", inspection, err)
		}
	}
	if err = os.Rename(filepath.Join(f.plan.Work, "next.app"), filepath.Join(f.root, "RetainedOriginal.app")); err != nil {
		t.Fatal(err)
	}
	inspection, err = f.inspect(t)
	if err != nil || inspection.Classification != "backup_or_candidate_missing" {
		t.Fatal("missing backup was not retained as a diagnostic condition", inspection, err)
	}
}

func TestMacRecoveryInspectionRejectsUntrustedRecordsAndNewUpgrade(t *testing.T) {
	f := newMacRecoveryFixture(t, false)
	originalPlan, originalTransaction, originalJournal := f.plan, f.transaction, f.journal
	journalPath := filepath.Join(f.cfg.DataDir, "updater", "mac-update-journal.json")
	for _, name := range []string{"foreign-target", "foreign-key-self-consistent", "bad-signature-self-consistent", "journal-symlink", "journal-hardlink", "journal-permissions", "transaction-digest"} {
		t.Run(name, func(t *testing.T) {
			f.plan, f.transaction, f.journal = originalPlan, originalTransaction, originalJournal
			_ = os.Remove(journalPath)
			f.persist(t)
			switch name {
			case "foreign-target":
				f.journal.Target = filepath.Join(f.root, "AnotherUserApp.app")
				createMacTestBundle(t, f.journal.Target, f.transaction.HelperExecutable, "app.chordv.mygo.local.another", "3.0.0", 3, "13.0")
				f.persist(t)
			case "foreign-key-self-consistent":
				f.plan.PublicKey = base64.StdEncoding.EncodeToString(make([]byte, ed25519.PublicKeySize))
				f.persist(t)
			case "bad-signature-self-consistent":
				f.plan.Installer.Grant.Signature = base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))
				f.persist(t)
			case "journal-symlink", "journal-hardlink":
				outside := filepath.Join(f.root, name+".json")
				if err := os.Rename(journalPath, outside); err != nil {
					t.Fatal(err)
				}
				link := os.Symlink
				if name == "journal-hardlink" {
					link = os.Link
				}
				if err := link(outside, journalPath); err != nil {
					t.Fatal(err)
				}
			case "journal-permissions":
				if err := os.Chmod(journalPath, 0644); err != nil {
					t.Fatal(err)
				}
			case "transaction-digest":
				if err := atomicFile(filepath.Join(f.plan.Work, "transaction.json"), []byte("{}"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if inspection, err := f.inspect(t); err == nil {
				t.Fatal("untrusted recovery record accepted", inspection)
			}
		})
	}
	f.plan, f.transaction, f.journal = originalPlan, originalTransaction, originalJournal
	_ = os.Remove(journalPath)
	f.persist(t)
	if err := os.Rename(f.plan.Current.Path, filepath.Join(f.root, "OriginalPreserved.app")); err != nil {
		t.Fatal(err)
	}
	createMacTestBundle(t, f.plan.Current.Path, f.transaction.HelperExecutable, f.plan.Current.Identifier, "3.0.0", 3, "13.0")
	if inspection, err := f.inspect(t); err != nil || inspection.Classification != "conflict" {
		t.Fatal("new user upgrade must not be overwritten or authorized for cleanup", inspection, err)
	}
}

func TestMacRecoveryInspectionDefersLiveOrUncertainHelper(t *testing.T) {
	f := newMacRecoveryFixture(t, true)
	inspection, err := f.inspect(t)
	if err != nil || inspection.Classification != "deferred" || inspection.HelperState != "alive" {
		t.Fatal("live private helper not recognized", inspection, err)
	}
	f.transaction.HelperIdentity += "-reused-identity"
	f.persist(t)
	inspection, err = f.inspect(t)
	if err != nil || inspection.Classification != "deferred" || inspection.HelperState != "unknown" {
		t.Fatal("uncertain helper identity must not authorize mutation", inspection, err)
	}
}

func TestMacRecoveryInspectionChecksFullSealedHelperWithoutAuthority(t *testing.T) {
	f := newMacRecoveryFixtureWithHelper(t, true, true)
	inspection, err := f.inspect(t)
	if err != nil || inspection.Classification != "deferred" || inspection.Placement != "original_staged" || inspection.HelperState != "alive" || !inspection.ReceiptValid {
		t.Fatal("live sealed helper did not defer inspection", inspection, err)
	}
	f.stopHelper()
	inspection, err = f.inspect(t)
	if err != nil || inspection.Classification != "original_staged" || inspection.HelperState != "gone" || !inspection.ReceiptValid {
		t.Fatal("original pairing not recognized after sealed helper exited", inspection, err)
	}
	if err := f.plan.swap(f.transaction.Current.Node, f.transaction.Candidate.Node); err != nil {
		t.Fatal(err)
	}
	inspection, err = f.inspect(t)
	if err != nil || inspection.Classification != "candidate_installed" || inspection.HelperState != "gone" || !inspection.ReceiptValid {
		t.Fatal("sealed helper not recognized with the original bundle now staged", inspection, err)
	}
	path := filepath.Join(f.plan.Work, macUpdateHelperBundleName)
	retained := filepath.Join(f.root, "PreservedHelper.app")
	if err := os.Rename(path, retained); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := runMacUpdateCommand(ctx, 30*time.Second, "/usr/bin/ditto", retained, path); err != nil {
		t.Fatal(err)
	}
	clone, err := readMacBundle(ctx, path, true)
	if err != nil || !macBundleSealMatches(clone, f.plan.Current) || verifyFile(clone.Executable, f.plan.HelperSHA256, 0) != nil {
		t.Fatal("replacement must carry the same seal and executable bytes", err)
	}
	inspection, err = f.inspect(t)
	if err == nil || !strings.Contains(err.Error(), "目录身份不一致") || inspection.Classification != "unavailable" || inspection.Placement != "candidate_installed" || !inspection.ReceiptValid {
		t.Fatal("identically sealed replacement was not refused by its directory identity", inspection, err)
	}
}

func TestMacRecoveryInspectionRequiresAnchorAndHonorsCancellation(t *testing.T) {
	if inspection, err := inspectMacUpdateRecovery(context.Background(), macRecoveryAnchor{}); err == nil || inspection.MutationAuthorized {
		t.Fatal("unsealed anchor accepted", inspection, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := deriveRecoveryAnchor(ctx, appConfig{}, "untrusted"); !errors.Is(err, context.Canceled) {
		t.Fatal("anchor derivation ignored cancellation", err)
	}
	if inspection, err := inspectMacUpdateRecovery(ctx, macRecoveryAnchor{}); !errors.Is(err, context.Canceled) || inspection.MutationAuthorized {
		t.Fatal("inspection ignored cancellation", inspection, err)
	}
	f := newMacRecoveryFixture(t, false)
	if err := os.Remove(filepath.Join(f.cfg.DataDir, "updater", "mac-update-journal.json")); err != nil {
		t.Fatal(err)
	}
	if inspection, err := f.inspect(t); err != nil || inspection.Classification != "none" {
		t.Fatal("absent journal must not create one", inspection, err)
	}
	f.persist(t)
	if err := os.Remove(filepath.Join(f.plan.Work, "transaction.json")); err != nil {
		t.Fatal(err)
	}
	if inspection, err := f.inspect(t); err != nil || inspection.Classification != "missing_transaction" {
		t.Fatal("legacy journal without transaction cannot authorize recovery", inspection, err)
	}
}

func TestMacStartupReportFollowsRecoveryDisposition(t *testing.T) {
	for _, mode := range []string{"journal-retired", "journal-retained"} {
		t.Run(mode, func(t *testing.T) {
			s := testService(t, "http://127.0.0.1:1")
			s.startupDone = make(chan struct{})
			updater := filepath.Join(s.cfg.DataDir, "updater")
			journal := filepath.Join(updater, "mac-update-journal.json")
			report := filepath.Join(updater, installReportName)
			if err := atomicFile(journal, []byte("pending test record"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := atomicJSON(report, map[string]any{"ok": false, "platform": "macos", "mode": "replace", "summary": "原版本已恢复"}); err != nil {
				t.Fatal(err)
			}
			base, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			ctx := &installReportWaitContext{Context: base, waiting: make(chan struct{})}
			type reply struct {
				value any
				err   error
			}
			done := make(chan reply, 1)
			go func() {
				value, err := s.Invoke(ctx, "consume_desktop_update_install_report", nil)
				done <- reply{value, err}
			}()
			select {
			case <-ctx.waiting:
			case got := <-done:
				t.Fatalf("reported stale recovery state before startup finished: %#v (%v)", got.value, got.err)
			case <-base.Done():
				t.Fatal("report command did not reach the startup barrier")
			}
			if _, err := os.Stat(report); err != nil {
				t.Fatal("report consumed while startup was still running", err)
			}
			if mode == "journal-retired" {
				if err := os.Remove(journal); err != nil {
					t.Fatal(err)
				}
			} else {
				s.mu.Lock()
				s.startupErr = errors.New("recovery could not retire the journal")
				s.mu.Unlock()
			}
			close(s.startupDone)
			got := <-done
			fields, ok := got.value.(map[string]any)
			if got.err != nil || !ok || fields["ok"] != false || fields["summary"] != "原版本已恢复" ||
				(fields["recoveryPending"] == true) != (mode == "journal-retained") {
				t.Fatal("report did not reflect the settled recovery state", got.value, got.err)
			}
			if _, err := os.Stat(report); !os.IsNotExist(err) {
				t.Fatal("settled report was not consumed", err)
			}
			if mode == "journal-retained" {
				if got, err := os.ReadFile(journal); err != nil || string(got) != "pending test record" {
					t.Fatal("report check altered the still-active record", err)
				}
			}
		})
	}
}

func TestMacStartupStatusKeepsRecoveryRecord(t *testing.T) {
	s := testService(t, "http://127.0.0.1:1")
	ctx := context.Background()
	call := func() any {
		t.Helper()
		v, err := s.Invoke(ctx, "consume_desktop_update_install_report", nil)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	if call() != nil {
		t.Fatal("ordinary startup should be quiet")
	}
	updater := filepath.Join(s.cfg.DataDir, "updater")
	record := filepath.Join(updater, "mac-update-journal.json")
	if err := atomicFile(record, []byte("untrusted record: do not replay"), 0600); err != nil {
		t.Fatal(err)
	}
	before := macRecoveryTree(t, s.cfg.DataDir)
	want := map[string]string{"state": "pending_recovery"}
	if !reflect.DeepEqual(call(), want) || !reflect.DeepEqual(before, macRecoveryTree(t, s.cfg.DataDir)) {
		t.Fatal("startup status must leave the record unchanged")
	}
	s.updateHealth = &macUpdateHealthClient{}
	if call() != nil {
		t.Fatal("candidate health check should not warn")
	}
	s.updateHealth = nil
	for _, ok := range []bool{true, false} {
		if err := atomicJSON(filepath.Join(updater, "install-report.json"), map[string]any{"ok": ok, "platform": "macos", "mode": "replace"}); err != nil {
			t.Fatal(err)
		}
		v := call()
		if ok && !reflect.DeepEqual(v, want) {
			t.Fatal("handoff is not completion")
		}
		if !ok {
			fields := v.(map[string]any)
			if fields["ok"] != false || fields["recoveryPending"] != true {
				t.Fatal("actual failure and the recovery gate must both be reported")
			}
		}
	}
	// The helper records successful startup before it finishes cleanup.
	report := map[string]any{"ok": true, "platform": "macos", "mode": "automatic_bundle_swap"}
	reportPath := filepath.Join(updater, "install-report.json")
	if err := atomicJSON(reportPath, report); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(call(), want) {
		t.Fatal("successful startup did not settle a remaining recovery record")
	}
	if b, err := os.ReadFile(record); err != nil || string(b) != "untrusted record: do not replay" {
		t.Fatal("journal changed")
	}
	if err := os.Remove(record); err != nil {
		t.Fatal(err)
	}
	if err := atomicJSON(reportPath, report); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(call(), report) || call() != nil {
		t.Fatal("clean successful update should pass through once without a recovery warning")
	}
}

func TestMacStartupKeepsPendingWarningWhenReportUnreadable(t *testing.T) {
	s := testService(t, "http://127.0.0.1:1")
	updater := filepath.Join(s.cfg.DataDir, "updater")
	journal := filepath.Join(updater, "mac-update-journal.json")
	report := filepath.Join(updater, "install-report.json")
	if err := atomicFile(journal, []byte("pending"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := atomicFile(report, []byte("partial report"), 0600); err != nil {
		t.Fatal(err)
	}
	before := macRecoveryTree(t, s.cfg.DataDir)
	v, err := s.startupInstallStatus(context.Background())
	if err != nil || !reflect.DeepEqual(v, map[string]string{"state": "pending_recovery"}) {
		t.Fatal("a damaged report hid the pending recovery gate", v, err)
	}
	if !reflect.DeepEqual(before, macRecoveryTree(t, s.cfg.DataDir)) {
		t.Fatal("diagnostic changed damaged record or journal")
	}
}

func TestMacStartupRejectsLinkedReport(t *testing.T) {
	s := testService(t, "http://127.0.0.1:1")
	path := filepath.Join(s.cfg.DataDir, "updater", "install-report.json")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	witness := filepath.Join(s.cfg.DataDir, "witness.json")
	if err := atomicJSON(witness, map[string]any{"ok": true, "platform": "macos", "mode": "replace"}); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(witness, path); err != nil {
		t.Fatal(err)
	}
	before := macRecoveryTree(t, s.cfg.DataDir)
	if report, err := s.consumeInstallReport(); err == nil || report != nil {
		t.Fatal("reported a result from a linked file")
	}
	if !reflect.DeepEqual(before, macRecoveryTree(t, s.cfg.DataDir)) {
		t.Fatal("refusing a link changed local files")
	}
}

func TestMacStartupRejectsLinkedUpdaterAndFIFO(t *testing.T) {
	for _, kind := range []string{"directory-link", "fifo"} {
		t.Run(kind, func(t *testing.T) {
			s := testService(t, "http://127.0.0.1:1")
			updater := filepath.Join(s.cfg.DataDir, "updater")
			if err := os.MkdirAll(updater, 0700); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(updater, "install-report.json")
			if kind == "directory-link" {
				if err := atomicJSON(path, map[string]any{"ok": true, "platform": "macos", "mode": "replace"}); err != nil {
					t.Fatal(err)
				}
				other := filepath.Join(s.cfg.DataDir, "retained-updater")
				if err := os.Rename(updater, other); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(other, updater); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := unix.Mkfifo(path, 0600); err != nil {
					t.Fatal(err)
				}
			}
			before := macRecoveryTree(t, s.cfg.DataDir)
			if v, err := s.consumeInstallReport(); err == nil || v != nil {
				t.Fatal("report path must be an ordinary file in the expected directory", v, err)
			}
			if !reflect.DeepEqual(before, macRecoveryTree(t, s.cfg.DataDir)) {
				t.Fatal("rejecting a non-regular report changed local files")
			}
		})
	}
}
