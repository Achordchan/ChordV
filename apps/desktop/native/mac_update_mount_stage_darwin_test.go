//go:build darwin

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func macMountPlanFixture(t *testing.T, work, source string) *macUpdatePlan {
	t.Helper()
	root := filepath.Dir(work)
	dataDir := filepath.Join(root, "data")
	if err := os.MkdirAll(filepath.Join(dataDir, "updater"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(work, macUpdatePlanName), []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	hash, err := fileSHA256(source)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(source)
	if err != nil {
		t.Fatal(err)
	}
	return &macUpdatePlan{planSHA256: macPlanDigest([]byte(`{}`)), Work: work, DataDir: dataDir, Installer: pendingInstaller{Path: source, SHA256: hash, Size: info.Size()}}
}

func TestMacUpdateMountOwnsPrivateImageIndependentOfCache(t *testing.T) {
	work, image, disk := macMountTestFixture(t)
	if _, err := runMacUpdateCommand(context.Background(), 30*time.Second, "/usr/bin/hdiutil", "detach", disk); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(filepath.Dir(work), "cache.dmg")
	if err := os.Rename(image, source); err != nil {
		t.Fatal(err)
	}
	original, err := macNode(source)
	if err != nil {
		t.Fatal(err)
	}
	p := macMountPlanFixture(t, work, source)
	if err = p.mountImage(context.Background()); err != nil {
		t.Fatal(err)
	}
	r, err := readMacMountRecord(work)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := cleanupMacUpdateWork(work); err != nil {
			t.Error(err)
		}
	})
	if r.Phase != "attached" || len(r.Devices) == 0 || r.ImageNode == original || r.Image != image {
		t.Fatal("mount did not capture an independent private image", r)
	}
	if err = os.Remove(source); err != nil {
		t.Fatal(err)
	}
	if _, err = runMacUpdateCommand(context.Background(), 30*time.Second, "/usr/sbin/diskutil", "unmountDisk", r.DetachDevice); err != nil {
		t.Fatal(err)
	}
	if err = cleanupMacUpdateWork(work); err != nil {
		t.Fatal(err)
	}
	assertMacTestImageAttached(t, image, false)
}

func TestMacUpdateFailedAttachRetainsIntentAndOwnershipEvidence(t *testing.T) {
	root, err := macCanonical(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	work, err := os.MkdirTemp(root, ".chordv-mac-update-")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(filepath.Join(work, "mount"), 0700); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(root, "not-a-dmg")
	if err = os.WriteFile(source, []byte("invalid disk image"), 0600); err != nil {
		t.Fatal(err)
	}
	p := macMountPlanFixture(t, work, source)
	if err = p.mountImage(context.Background()); err == nil {
		t.Fatal("invalid DMG unexpectedly attached")
	}
	r, err := readMacMountRecord(work)
	if err != nil {
		t.Fatal(err)
	}
	if r.Phase != "attaching" {
		t.Fatal("failed attach lost intent", r.Phase)
	}
	if err = cleanupMacUpdateWork(work); err == nil {
		t.Fatal("failed attach discarded unsettled backend intent")
	}
	if _, err = os.Stat(filepath.Join(work, macMountRecordName)); err != nil {
		t.Fatal("failed attach lost ownership record", err)
	}
	assertMacTestImageAttached(t, r.Image, false)
}

func TestMacUpdateCancellationAfterAttachIntentCapturesBeforeCleanup(t *testing.T) {
	work, image, disk := macMountTestFixture(t)
	if _, err := runMacUpdateCommand(context.Background(), 30*time.Second, "/usr/bin/hdiutil", "detach", disk); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(filepath.Dir(work), "cache.dmg")
	if err := os.Rename(image, source); err != nil {
		t.Fatal(err)
	}
	p := macMountPlanFixture(t, work, source)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- p.mountImage(ctx) }()
	macWait(t, work, 15*time.Second, func() bool {
		data, _ := os.ReadFile(filepath.Join(work, macMountRecordName))
		var r macMountRecord
		return json.Unmarshal(data, &r) == nil && r.Phase == "attaching"
	})
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal("original cancellation was not returned after capture", err)
		}
	case <-time.After(macUpdateAttachCaptureTimeout + 5*time.Second):
		t.Fatal("bounded attach did not finish after cancellation")
	}
	r, err := readMacMountRecord(work)
	if err != nil || r.Phase != "attached" || len(r.Devices) == 0 {
		t.Fatal("cancellation interrupted ownership capture", r, err)
	}
	assertMacTestImageAttached(t, image, true)
	if err := cleanupMacUpdateWork(work); err != nil {
		t.Fatal(err)
	}
	assertMacTestImageAttached(t, image, false)
}

func TestMacUpdateCancelAndParentExitAfterProtectedAttachIntent(t *testing.T) {
	for _, mode := range []string{"cancel", "parent-exit"} {
		t.Run(mode, func(t *testing.T) {
			f := macFixture(t, "13.0")
			h := startMacHolder(t, f)
			macWait(t, filepath.Join(f.DataDir, "updater"), 30*time.Second, func() bool {
				data, _ := os.ReadFile(filepath.Join(f.DataDir, "updater", "mac-update-journal.json"))
				var j macUpdateJournal
				if json.Unmarshal(data, &j) != nil || j.Phase != "mounting" {
					return false
				}
				h.work = j.Work
				return true
			})
			macWait(t, h.work, 15*time.Second, func() bool {
				data, _ := os.ReadFile(filepath.Join(h.work, macMountRecordName))
				var r macMountRecord
				return json.Unmarshal(data, &r) == nil && r.Phase == "attaching"
			})
			t.Log("durable protected attach intent witnessed before cancellation")
			if mode == "cancel" {
				_, _ = fmt.Fprintln(h.pipe, "ABORT")
				if got := h.line(t); got != "ABORTED" {
					t.Fatal(got)
				}
			} else {
				if err := h.command.Process.Kill(); err != nil {
					t.Fatal(err)
				}
				<-h.done
			}
			macWait(t, f.Root, 45*time.Second, func() bool { _, err := os.Stat(h.work); return os.IsNotExist(err) })
			assertMacNoMount(t, h.work, f.Installer)
			if node, err := macNode(f.Current); err != nil || node != f.CurrentInfo.Node {
				t.Fatal("cancel changed current bundle", err)
			}
			if _, err := os.Stat(f.Marker); !os.IsNotExist(err) {
				t.Fatal("unarmed cancel launched candidate", err)
			}
		})
	}
}

func TestMacUpdateAbortBudgetCoversProtectedAttachAndDetach(t *testing.T) {
	if macUpdateAbortTimeout < macUpdateAttachCaptureTimeout+macUpdateDetachTimeout+5*time.Second {
		t.Fatal("abort may kill the helper before bounded capture and cleanup can finish")
	}
}
