//go:build darwin

package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMacUpdateCancelBeforeReadyUsesRealPreparationAndDetaches(t *testing.T) {
	f := macFixture(t, "13.0")
	if err := os.WriteFile(filepath.Join(f.DataDir, "updater", "prepare-gate-request"), []byte("test-only barrier"), 0600); err != nil {
		t.Fatal(err)
	}
	h := startMacHolder(t, f)
	macWait(t, filepath.Join(f.DataDir, "updater"), 30*time.Second, func() bool {
		_, err := os.Stat(filepath.Join(f.DataDir, "updater", "prepare-gate-ready"))
		return err == nil
	})
	data, err := os.ReadFile(filepath.Join(f.DataDir, "updater", "mac-update-journal.json"))
	if err != nil {
		t.Fatal(err)
	}
	var journal macUpdateJournal
	if err = json.Unmarshal(data, &journal); err != nil {
		t.Fatal(err)
	}
	h.work = journal.Work
	started := time.Now()
	_, _ = fmt.Fprintln(h.pipe, "ABORT")
	select {
	case line := <-h.lines:
		if line != "ABORTED" {
			t.Fatal(line)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("cancel blocked behind preparation mutex")
	}
	if node, err := macNode(f.Current); err != nil || node != f.CurrentInfo.Node {
		t.Fatal("cancel changed installed app", err)
	}
	if _, err = os.Stat(f.Marker); !os.IsNotExist(err) {
		t.Fatal("cancel executed candidate", err)
	}
	if _, err = os.Stat(h.work); !os.IsNotExist(err) {
		t.Fatal("cancel retained helper work", err)
	}
	assertMacNoMount(t, h.work, f.Installer)
	t.Logf("READY-before barrier cancellation completed in %s", time.Since(started))
}

func TestMacUpdatePendingChangesBetweenPrepareAndArmAreRejected(t *testing.T) {
	for _, reload := range []bool{false, true} {
		t.Run(fmt.Sprintf("reloadCache=%t", reload), func(t *testing.T) {
			f := macFixture(t, "13.0")
			h := startMacHolder(t, f)
			h.ready(t)
			data, err := os.ReadFile(filepath.Join(f.DataDir, "updater", "pending.json"))
			if err != nil {
				t.Fatal(err)
			}
			var before pendingInstaller
			if err = json.Unmarshal(data, &before); err != nil {
				t.Fatal(err)
			}
			var cfg macFixtureConfig
			data, _ = os.ReadFile(f.Config)
			if err = json.Unmarshal(data, &cfg); err != nil {
				t.Fatal(err)
			}
			s := newDesktopService(appConfig{DataDir: f.DataDir, ReleaseRepository: cfg.Repository, ReleasePublicKey: cfg.PublicKey})
			defer s.cancel()
			var manifest releaseManifest
			if err = json.Unmarshal([]byte(before.Grant.Manifest), &manifest); err != nil {
				t.Fatal(err)
			}
			manifest.Channel = "beta"
			body, _ := json.Marshal(manifest)
			signature := base64.StdEncoding.EncodeToString(ed25519.Sign(f.SigningKey, body))
			input, _ := json.Marshal(map[string]string{"manifest": string(body), "signature": signature, "tag": manifest.Tag})
			if _, err = s.authorizeReleaseManifest(context.Background(), input); err != nil {
				t.Fatal(err)
			}
			grant, err := s.authorizedDownload("https://github.com/"+cfg.Repository+"/releases/download/v2.0.0/update.dmg", before.SHA256, before.Size)
			if err != nil {
				t.Fatal(err)
			}
			after := before
			after.Grant = grant
			if err = s.verifyGrantReceipt(before.Grant); err != nil {
				t.Fatal("old channel floor no longer valid", err)
			}
			if err = s.verifyGrantReceipt(after.Grant); err != nil {
				t.Fatal("second channel receipt not independently valid", err)
			}
			if err = atomicJSON(filepath.Join(f.DataDir, "updater", "pending.json"), after); err != nil {
				t.Fatal(err)
			}
			if reload {
				_, _ = fmt.Fprintln(h.pipe, "RELOAD_PENDING")
				if got := h.line(t); got != "RELOADED" {
					t.Fatal(got)
				}
			}
			_, _ = fmt.Fprintln(h.pipe, "COMMIT_REJECT")
			if got := h.line(t); !strings.Contains(got, "REJECTED:") {
				t.Fatal(got)
			}
			data, _ = os.ReadFile(filepath.Join(f.DataDir, "updater", "mac-update-journal.json"))
			if strings.Contains(string(data), `"phase": "armed"`) {
				t.Fatal("changed pending was armed")
			}
			if node, err := macNode(f.Current); err != nil || node != f.CurrentInfo.Node {
				t.Fatal("pending change modified original app", err)
			}
			_, _ = fmt.Fprintln(h.pipe, "ABORT")
			if got := h.line(t); got != "ABORTED" {
				t.Fatal(got)
			}
			assertMacNoMount(t, h.work, f.Installer)
		})
	}
}

func TestMacUpdateTargetLockAndFDIdentityGuard(t *testing.T) {
	root, err := macCanonical(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "Installed.app")
	if err = os.Mkdir(target, 0700); err != nil {
		t.Fatal(err)
	}
	work, err := os.MkdirTemp(root, ".chordv-mac-update-")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(filepath.Join(work, "next.app"), 0700); err != nil {
		t.Fatal(err)
	}
	p := macUpdatePlan{Current: macBundleInfo{Path: target}, Work: work, DataDir: filepath.Join(root, "data-one")}
	first, err := p.targetLock()
	if err != nil {
		t.Fatal(err)
	}
	secondPlan := p
	secondPlan.DataDir = filepath.Join(root, "different-data")
	if second, err := secondPlan.targetLock(); err == nil {
		second.Close()
		t.Fatal("different DataDir bypassed target lock")
	}
	first.Close()
	second, err := secondPlan.targetLock()
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	old, _ := macNode(target)
	next, _ := macNode(filepath.Join(work, "next.app"))
	if err = p.swap(old, next); err != nil {
		t.Fatal(err)
	}
	if got, _ := macNode(target); got != next {
		t.Fatal("atomic swap did not place staged inode")
	}
	if err = p.swap(next, old); err != nil {
		t.Fatal("atomic rollback failed", err)
	}
	if err = os.Rename(target, filepath.Join(root, "externally-moved.app")); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(target, 0700); err != nil {
		t.Fatal(err)
	}
	if err = p.swap(old, next); err == nil {
		t.Fatal("stale target inode bypassed final FD guard")
	}
	if got, _ := macNode(filepath.Join(work, "next.app")); got != next {
		t.Fatal("rejected swap changed staged app")
	}
}

func TestMacUpdateSealedCurrentMetadataRejectsCandidateDowngrade(t *testing.T) {
	f := macFixture(t, "13.0")
	data, _ := os.ReadFile(filepath.Join(f.DataDir, "updater", "pending.json"))
	var pending pendingInstaller
	if err := json.Unmarshal(data, &pending); err != nil {
		t.Fatal(err)
	}
	var cfg macFixtureConfig
	data, _ = os.ReadFile(f.Config)
	if err := json.Unmarshal(data, &cfg); err != nil {
		t.Fatal(err)
	}
	for _, metadata := range []macBuildInfo{{Version: "3.0.0", Build: 1, Mode: "local", Platform: "macos", Architecture: architectureName()}, {Version: "2.0.0", Build: 3, Mode: "local", Platform: "macos", Architecture: architectureName()}} {
		path := filepath.Join(f.Current, "Contents", "Info.plist")
		data, _ = os.ReadFile(path)
		dict, err := parsePlist(data)
		if err != nil {
			t.Fatal(err)
		}
		dict["CFBundleShortVersionString"], dict["CFBundleVersion"] = metadata.Version, metadata.Version
		dict["ChordVBuildInfo"] = map[string]any{"version": metadata.Version, "build": metadata.Build, "mode": metadata.Mode, "platform": metadata.Platform, "architecture": metadata.Architecture}
		data, err = marshalPlist(dict)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(path, data, 0644); err != nil {
			t.Fatal(err)
		}
		if _, err = runMacUpdateCommand(context.Background(), 30*time.Second, "/usr/bin/codesign", "--force", "--sign", "-", f.Current); err != nil {
			t.Fatal(err)
		}
		current, err := readMacBundle(context.Background(), f.Current, true)
		if err != nil {
			t.Fatal(err)
		}
		work, err := os.MkdirTemp(f.Root, ".chordv-mac-update-")
		if err != nil {
			t.Fatal(err)
		}
		if _, err = runMacUpdateCommand(context.Background(), 30*time.Second, "/usr/bin/ditto", f.Candidate, filepath.Join(work, "next.app")); err != nil {
			t.Fatal(err)
		}
		p := macUpdatePlan{Work: work, DataDir: f.DataDir, Repository: cfg.Repository, PublicKey: cfg.PublicKey, Current: current, Installer: pending}
		if _, err = p.verifyCandidate(context.Background()); err == nil || !strings.Contains(err.Error(), "降级") {
			t.Fatalf("sealed current %s/%d did not block downgrade: %v", metadata.Version, metadata.Build, err)
		}
	}
}

func TestMacUpdateParentAndHelperKeepPreparedPlanDigest(t *testing.T) {
	f := macFixture(t, "13.0")
	h := startMacHolder(t, f)
	h.ready(t)
	path := filepath.Join(h.work, macUpdatePlanName)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	// Same decoded fields; a different byte sequence is still not the pipe-authorized plan.
	if err = atomicFile(path, append(raw, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
	_, _ = fmt.Fprintln(h.pipe, "COMMIT_REJECT")
	if got := h.line(t); !strings.HasPrefix(got, "REJECTED:") || !strings.Contains(got, "更新计划已偏离") {
		t.Fatal(got)
	}
	_, _ = fmt.Fprintln(h.pipe, "ARM_RAW")
	if got := h.line(t); got != "RAW_ARM_SENT" {
		t.Fatal(got)
	}
	updater := filepath.Join(f.DataDir, "updater")
	macWait(t, updater, 20*time.Second, func() bool {
		raw, err := os.ReadFile(filepath.Join(updater, "install-report.json"))
		var report struct {
			OK      *bool
			Summary string
		}
		return err == nil && json.Unmarshal(raw, &report) == nil && report.OK != nil && !*report.OK && strings.Contains(report.Summary, "更新计划已偏离")
	})
	if actual, err := macNode(f.Current); err != nil || actual != f.CurrentInfo.Node {
		t.Fatal("original bundle changed", err)
	}
	if _, err := os.Lstat(f.Marker); !os.IsNotExist(err) {
		t.Fatal("candidate unexpectedly started", err)
	}
}
