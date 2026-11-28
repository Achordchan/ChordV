//go:build darwin

package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func fullSchema2MacGUIFixture(t *testing.T, app string) (macUpdateFixture, *macSchema2HTTPServer) {
	t.Helper()
	f, source, asset := fullMacGUIPayloadFixture(t, app)
	buildID, err := exec.Command("go", "tool", "buildid", source.Executable).Output()
	if err != nil || !strings.HasPrefix(strings.TrimSpace(string(buildID)), "chordv1:") {
		t.Fatal("schema2 source must have its real canonical Go build identity", err)
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(strings.TrimSpace(string(buildID)), "chordv1:"))
	var identity struct {
		Version, Commit, Platform, Architecture, Mode string
		Build                                         int64
	}
	if err != nil || json.Unmarshal(raw, &identity) != nil || identity.Version != source.Version || identity.Build != source.Build.Build ||
		identity.Platform != "macos" || identity.Architecture != architectureName() || identity.Mode != "local" || len(identity.Commit) != 40 {
		t.Fatal("schema2 source identity differs from actual local candidate", err)
	}
	manifest := map[string]any{"schemaVersion": 2, "tag": "v" + source.Version, "version": source.Version, "channel": "stable", "build": source.Build.Build,
		"sourceCommit": identity.Commit, "tagBinding": map[string]string{"mode": "signed-manifest-tree", "repository": "owner/repo"},
		"installers": []releaseAsset{asset}, "runtimeComponents": []releaseAsset{}}
	server := newMacSchema2HTTPServer(t, manifest)
	writeMacSchema2HTTPConfig(t, f, server)
	cfg := macFixtureConfig{DataDir: f.DataDir, Repository: "owner/repo", PublicKey: server.git.public, Installer: f.Installer}
	restore, err := installMacSchema2HTTPFixture(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(restore)
	service := newDesktopService(appConfig{DataDir: cfg.DataDir, ReleaseRepository: cfg.Repository, ReleasePublicKey: cfg.PublicKey})
	defer service.cancel()
	input, _ := json.Marshal(map[string]string{"manifest": string(server.git.body), "signature": string(server.git.signature), "tag": "v" + source.Version})
	if _, err := service.Invoke(context.Background(), "authorize_release_manifest", input); err != nil {
		t.Fatal("actual schema2 native authorization failed", err)
	}
	grant, err := service.authorizedDownload("https://github.com/owner/repo/releases/download/v"+source.Version+"/update.dmg", asset.SHA256, asset.SizeBytes)
	if err != nil {
		t.Fatal(err)
	}
	if err = atomicJSON(filepath.Join(f.DataDir, "updater", "pending.json"), pendingInstaller{Path: f.Installer, SHA256: asset.SHA256, Size: asset.SizeBytes, Version: source.Version, Grant: grant}); err != nil {
		t.Fatal(err)
	}
	if err = atomicJSON(f.Config, cfg); err != nil {
		t.Fatal(err)
	}
	f.CurrentInfo, err = readMacBundle(context.Background(), f.Current, true)
	if err != nil {
		t.Fatal(err)
	}
	f.CandidateInfo, err = readMacBundle(context.Background(), f.Candidate, true)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("schema2 actual copied source version=%s build=%d commit=%s CDHash=%s", source.Version, source.Build.Build, identity.Commit, source.CDHash)
	return f, server
}

func assertSchema2ChildHTTP(t *testing.T, f macUpdateFixture, server *macSchema2HTTPServer, holder, helper int) {
	t.Helper()
	raw, err := readMacRecoveryFile(filepath.Join(f.DataDir, "updater", macSchema2HTTPFile))
	if err != nil {
		t.Fatal(err)
	}
	counts := map[int]int{}
	for _, request := range server.snapshot() {
		if request.PID != os.Getpid() && request.PID != holder && request.PID != helper {
			t.Fatal("binding HTTP escaped the three known private processes", request)
		}
		counts[request.PID]++
	}
	for _, pid := range []int{os.Getpid(), holder, helper} {
		witnessRaw, err := readMacRecoveryFile(filepath.Join(f.DataDir, "updater", "schema2-transport-"+strconv.Itoa(pid)+".json"))
		var witness struct {
			PID, OwnerPID       int
			ConfigurationSHA256 string
		}
		if err != nil || json.Unmarshal(witnessRaw, &witness) != nil || witness.PID != pid || witness.OwnerPID != os.Getpid() || witness.ConfigurationSHA256 != testHash(raw) || counts[pid] < 7 {
			t.Fatalf("private process did not revalidate the same schema2 network fixture: pid=%d count=%d witness=%s err=%v", pid, counts[pid], witnessRaw, err)
		}
	}
	encoded, _ := json.Marshal(map[string]any{"httpRequests": server.snapshot(), "counts": counts, "ownerPID": os.Getpid(), "holderPID": holder, "helperPID": helper, "fixtureSHA256": testHash(raw)})
	t.Logf("schema2-gui-observation:%s", encoded)
}

func TestMacUpdateSchema2PackagedGUIAndPhaseTampering(t *testing.T) {
	app := os.Getenv("CHORDV_TEST_FULL_GUI_APP")
	if app == "" && os.Getenv("CHORDV_TEST_FULL_GUI_DMG") == "" {
		t.Skip("requires the original local DMG and its explicitly built ChordV bundle")
	}
	app, err := macCanonical(app)
	if err != nil {
		t.Fatal(err)
	}
	for _, phase := range []string{"healthy", "prepared-raw-signature", "armed-git-history"} {
		t.Run(phase, func(t *testing.T) {
			f, server := fullSchema2MacGUIFixture(t, app)
			h := startMacHolder(t, f)
			h.ready(t)
			assertMacNoMount(t, h.work, f.Installer)
			staged, err := readMacBundle(context.Background(), filepath.Join(h.work, "next.app"), true)
			if err != nil {
				t.Fatal(err)
			}
			requirePackagedMacCandidate(t, staged, f.CandidateInfo)
			t.Cleanup(func() { stopFullMacGUI(t, f.Current, staged) })
			if phase == "prepared-raw-signature" {
				server.mutateRawSignature("v" + staged.Version)
				_, _ = fmt.Fprintln(h.pipe, "COMMIT_REJECT")
				if line := h.line(t); !strings.HasPrefix(line, "REJECTED:") || !strings.Contains(line, "发布绑定") {
					t.Fatal("changed official raw.sig reached ARM", line)
				}
				actual, err := readMacBundle(context.Background(), f.Current, true)
				if err != nil || actual.Node != f.CurrentInfo.Node || actual.CDHash != f.CurrentInfo.CDHash {
					t.Fatal("pre-ARM rejection changed original app", err)
				}
				assertSchema2ChildHTTP(t, f, server, h.command.Process.Pid, h.helperPID)
				_, _ = fmt.Fprintln(h.pipe, "ABORT")
				if line := h.line(t); line != "ABORTED" {
					t.Fatal(line)
				}
				if _, err := os.Stat(h.work); !os.IsNotExist(err) {
					t.Fatal("pre-ARM abort retained owned work", err)
				}
				assertMacNoMount(t, h.work, f.Installer)
				return
			}
			_, _ = fmt.Fprintln(h.pipe, "ARM")
			if line := h.line(t); line != "ARMED" {
				t.Fatal(line)
			}
			if phase == "armed-git-history" {
				server.git.changeJSON(t, "/commits/", func(value map[string]any) {
					value["parents"] = []any{map[string]string{"sha": strings.Repeat("b", 40)}}
				})
			}
			_, _ = fmt.Fprintln(h.pipe, "EXIT")
			if err := <-h.done; err != nil {
				t.Fatal(err)
			}
			if phase == "healthy" {
				macWait(t, f.Root, 75*time.Second, func() bool { _, err := os.Stat(h.work); return os.IsNotExist(err) })
				actual, err := readMacBundle(context.Background(), f.Current, true)
				if err != nil || actual.Node != staged.Node || actual.CDHash != staged.CDHash {
					t.Fatal("schema2 real GUI did not complete native and React health ACK", err)
				}
				if _, err := os.Stat(filepath.Join(f.DataDir, "updater", "mac-update-journal.json")); !os.IsNotExist(err) {
					t.Fatal("healthy schema2 update retained journal", err)
				}
				if pid, err := fullGUIRegisteredPID(f.Current, staged); err != nil || pid == 0 {
					t.Fatal("healthy schema2 GUI is absent from fresh LaunchServices/kernel witnesses", pid, err)
				}
			} else {
				var report map[string]any
				macWait(t, filepath.Join(f.DataDir, "updater"), 20*time.Second, func() bool {
					raw, err := os.ReadFile(filepath.Join(f.DataDir, "updater", "install-report.json"))
					return err == nil && json.Unmarshal(raw, &report) == nil && report["ok"] == false
				})
				if !strings.Contains(fmt.Sprint(report["summary"]), "元数据commit") || report["candidatePid"] != nil {
					t.Fatal("post-ARM tree mutation did not fail before candidate launch", report)
				}
				actual, err := readMacBundle(context.Background(), f.Current, true)
				if err != nil || actual.Node != f.CurrentInfo.Node || actual.CDHash != f.CurrentInfo.CDHash {
					t.Fatal("post-parent-exit binding rejection changed original app", err)
				}
				journalRaw, err := os.ReadFile(filepath.Join(f.DataDir, "updater", "mac-update-journal.json"))
				var journal macUpdateJournal
				if err != nil || json.Unmarshal(journalRaw, &journal) != nil || journal.Phase != "waiting_parent_exit" {
					t.Fatal("binding failure lost the unmutated recovery journal", err)
				}
				if _, err := os.Stat(filepath.Join(h.work, "next.app")); err != nil {
					t.Fatal("binding failure removed owned staged app", err)
				}
				if pid, err := fullGUIRegisteredPID(f.Current, staged); err != nil || pid != 0 {
					t.Fatal("post-ARM binding failure registered a candidate GUI", pid, err)
				}
			}
			if _, err := os.Stat(proxyJournalPath(f.DataDir)); !os.IsNotExist(err) {
				t.Fatal("schema2 GUI-only update created a proxy journal", err)
			}
			assertSchema2ChildHTTP(t, f, server, h.command.Process.Pid, h.helperPID)
			assertMacNoMount(t, h.work, f.Installer)
		})
	}
}
