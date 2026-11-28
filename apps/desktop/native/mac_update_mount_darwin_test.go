//go:build darwin

package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The cleanup owns this exact image; the fixture never detaches a foreign disk.
func macMountTestFixture(t *testing.T) (string, string, string) {
	t.Helper()
	temporary, err := os.MkdirTemp("", strings.ReplaceAll(t.Name(), "/", "_")+"-")
	if err != nil {
		t.Fatal(err)
	}
	root, err := macCanonical(temporary)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		out, err := runMacUpdateCommand(context.Background(), 30*time.Second, "/usr/bin/hdiutil", "info", "-plist")
		if err != nil || strings.Contains(string(out), root) {
			t.Errorf("ownership fixture evidence retained at %s; attached inventory uncertain: %v", root, err)
			return
		}
		if t.Failed() {
			t.Logf("failed ownership fixture evidence retained at %s", root)
			return
		}
		if err = os.RemoveAll(root); err != nil {
			t.Error(err)
		}
	})
	work, err := os.MkdirTemp(root, ".chordv-mac-update-")
	if err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(root, "source")
	if err = os.Mkdir(src, 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(src, "payload"), []byte("isolated update image"), 0600); err != nil {
		t.Fatal(err)
	}
	image := filepath.Join(work, "image.dmg")
	if _, err = runMacUpdateCommand(context.Background(), time.Minute, "/usr/bin/hdiutil", "create", "-ov", "-format", "UDZO", "-srcfolder", src, image); err != nil {
		t.Fatal(err)
	}
	if err = os.Chmod(image, 0600); err != nil {
		t.Fatal(err)
	}
	mount := filepath.Join(work, "mount")
	if err = os.Mkdir(mount, 0700); err != nil {
		t.Fatal(err)
	}
	out, err := runMacUpdateCommand(context.Background(), time.Minute, "/usr/bin/hdiutil", "attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount, "-plist", image)
	if err != nil {
		t.Fatal(err)
	}
	p, err := parsePlist(out)
	if err != nil {
		t.Fatal(err)
	}
	entities, ok := p["system-entities"].([]any)
	if !ok {
		t.Fatal("missing attach devices")
	}
	disk := ""
	for _, v := range entities {
		m, ok := v.(map[string]any)
		if !ok {
			t.Fatal("bad entity")
		}
		d, _ := m["dev-entry"].(string)
		if strings.HasPrefix(d, "/dev/disk") && !strings.Contains(strings.TrimPrefix(d, "/dev/disk"), "s") {
			disk = d
			break
		}
	}
	if disk == "" {
		t.Fatal("missing whole disk")
	}
	t.Cleanup(func() {
		out, err := runMacUpdateCommand(context.Background(), 30*time.Second, "/usr/bin/hdiutil", "info", "-plist")
		if err != nil {
			t.Error(err)
			return
		}
		p, err := parsePlist(out)
		if err != nil {
			t.Error(err)
			return
		}
		images, _ := p["images"].([]any)
		for _, v := range images {
			m, _ := v.(map[string]any)
			if m["image-path"] != image {
				continue
			}
			if m["owner-uid"] != int64(os.Getuid()) || m["writeable"] != false {
				t.Error("fixture ownership changed")
				return
			}
			es, _ := m["system-entities"].([]any)
			found := false
			for _, e := range es {
				em, _ := e.(map[string]any)
				found = found || em["dev-entry"] == disk
			}
			if !found {
				t.Error("fixture device changed")
				return
			}
			if _, err = runMacUpdateCommand(context.Background(), 30*time.Second, "/usr/bin/hdiutil", "detach", disk); err != nil {
				t.Error(err)
			}
			return
		}
	})
	return work, image, disk
}

func TestMacUpdateCleanupRetainsUnprovenAttachedOnlyOwnership(t *testing.T) {
	work, image, disk := macMountTestFixture(t)
	if err := atomicJSON(filepath.Join(work, "mount-owned.json"), map[string]string{"mountpoint": filepath.Join(work, "mount"), "image": image}); err != nil {
		t.Fatal(err)
	}
	if _, err := runMacUpdateCommand(context.Background(), 30*time.Second, "/usr/sbin/diskutil", "unmountDisk", disk); err != nil {
		t.Fatal(err)
	}
	if err := cleanupMacUpdateWork(work); err == nil {
		t.Error("cleanup reported success for an attached-only legacy image without proven ownership")
	}
	if _, err := os.Stat(filepath.Join(work, "mount-owned.json")); err != nil {
		t.Error("cleanup lost ownership evidence", err)
	}
}

func macMountTestRecord(t *testing.T, work, image, disk string) macMountRecord {
	t.Helper()
	node, err := macNode(image)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(image)
	if err != nil {
		t.Fatal(err)
	}
	hash, err := fileSHA256(image)
	if err != nil {
		t.Fatal(err)
	}
	boot, err := macUpdateBootSession()
	if err != nil {
		t.Fatal(err)
	}
	inv, err := macMountInventory(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, im := range inv {
		if im.Image == image {
			devices, err := macMountDeviceSnapshot(im.Entities, filepath.Join(work, "mount"))
			if err != nil {
				t.Fatal(err)
			}
			return macMountRecord{Schema: 2, Work: work, Mount: filepath.Join(work, "mount"), Image: image, ImageNode: node, ImageSize: info.Size(), ImageSHA256: hash, BootSession: boot, Phase: "attached", Devices: devices, DetachDevice: disk}
		}
	}
	t.Fatal("owned image absent")
	return macMountRecord{}
}

func assertMacTestImageAttached(t *testing.T, image string, want bool) {
	t.Helper()
	inv, err := macMountInventory(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, im := range inv {
		found = found || im.Image == image
	}
	if found != want {
		t.Fatalf("owned image attached=%t, want=%t", found, want)
	}
}

func TestMacUpdateCleanupDetachesOwnedAttachedOnlyDevice(t *testing.T) {
	work, image, disk := macMountTestFixture(t)
	record := macMountTestRecord(t, work, image, disk)
	if err := durableMacUpdateJSON(filepath.Join(work, macMountRecordName), record); err != nil {
		t.Fatal(err)
	}
	if _, err := runMacUpdateCommand(context.Background(), 30*time.Second, "/usr/sbin/diskutil", "unmountDisk", disk); err != nil {
		t.Fatal(err)
	}
	assertMacTestImageAttached(t, image, true)
	if err := cleanupMacUpdateWork(work); err != nil {
		t.Fatal(err)
	}
	assertMacTestImageAttached(t, image, false)
	if _, err := os.Stat(work); !os.IsNotExist(err) {
		t.Fatal("successful cleanup retained work", err)
	}
}

func TestMacUpdateCleanupRejectsPartitionAsDetachAuthority(t *testing.T) {
	work, image, disk := macMountTestFixture(t)
	r := macMountTestRecord(t, work, image, disk)
	for _, d := range r.Devices {
		if strings.Contains(strings.TrimPrefix(d.Device, "/dev/disk"), "s") {
			r.DetachDevice = d.Device
			break
		}
	}
	if r.DetachDevice == disk {
		t.Fatal("fixture lacks partition")
	}
	if err := durableMacUpdateJSON(filepath.Join(work, macMountRecordName), r); err != nil {
		t.Fatal(err)
	}
	if err := cleanupMacUpdateWork(work); err == nil {
		t.Error("partition was accepted as whole-disk detach authority")
	}
	assertMacTestImageAttached(t, image, true)
}

func TestMacUpdateCleanupRetainsUncertainOrChangedOwnership(t *testing.T) {
	work, image, disk := macMountTestFixture(t)
	original := macMountTestRecord(t, work, image, disk)
	for _, kind := range []string{"registry-id", "boot-session", "image-node", "image-path", "pending", "record-mode", "record-missing", "record-symlink", "record-hardlink"} {
		t.Run(kind, func(t *testing.T) {
			r := original
			r.Devices = append([]macMountDevice(nil), original.Devices...)
			path := filepath.Join(work, macMountRecordName)
			_ = os.Remove(path)
			switch kind {
			case "registry-id":
				r.Devices[0].RegistryID++
			case "boot-session":
				r.BootSession = "00000000-0000-0000-0000-000000000001"
			case "image-node":
				r.ImageNode.Inode++
			case "image-path":
				r.Image = filepath.Join(work, "unowned.dmg")
			case "pending":
				r.Phase = "attaching"
			}
			if err := durableMacUpdateJSON(path, r); err != nil {
				t.Fatal(err)
			}
			if kind == "record-mode" {
				if err := os.Chmod(path, 0644); err != nil {
					t.Fatal(err)
				}
			}
			if kind == "record-missing" {
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
			}
			if kind == "record-symlink" || kind == "record-hardlink" {
				saved := filepath.Join(work, "record-test-target")
				if err := os.Rename(path, saved); err != nil {
					t.Fatal(err)
				}
				defer os.Remove(saved)
				var err error
				if kind == "record-symlink" {
					err = os.Symlink(saved, path)
				} else {
					err = os.Link(saved, path)
				}
				if err != nil {
					t.Fatal(err)
				}
			}
			if err := cleanupMacUpdateWork(work); err == nil {
				t.Fatal("unproven ownership accepted")
			}
			assertMacTestImageAttached(t, image, true)
			if _, err := os.Stat(work); err != nil {
				t.Fatal("ownership error removed evidence directory", err)
			}
		})
	}
}

func TestMacUpdateCleanupRetainsPendingIntentWithNoAttachment(t *testing.T) {
	work, image, disk := macMountTestFixture(t)
	r := macMountTestRecord(t, work, image, disk)
	if _, err := runMacUpdateCommand(context.Background(), 30*time.Second, "/usr/bin/hdiutil", "detach", disk); err != nil {
		t.Fatal(err)
	}
	r.Phase = "attaching"
	r.Devices = nil
	r.DetachDevice = ""
	if err := durableMacUpdateJSON(filepath.Join(work, macMountRecordName), r); err != nil {
		t.Fatal(err)
	}
	if err := cleanupMacUpdateWork(work); err == nil {
		t.Fatal("empty snapshot discarded an unsettled attach intent")
	}
	if _, err := os.Stat(filepath.Join(work, macMountRecordName)); err != nil {
		t.Fatal("lost pending evidence", err)
	}
}

func TestMacUpdateCleanupRejectsRealReattachedDeviceLifecycle(t *testing.T) {
	work, image, disk := macMountTestFixture(t)
	old := macMountTestRecord(t, work, image, disk)
	if _, err := runMacUpdateCommand(context.Background(), 30*time.Second, "/usr/bin/hdiutil", "detach", disk); err != nil {
		t.Fatal(err)
	}
	out, err := runMacUpdateCommand(context.Background(), time.Minute, "/usr/bin/hdiutil", "attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", filepath.Join(work, "mount"), "-plist", image)
	if err != nil {
		t.Fatal(err)
	}
	dict, err := parsePlist(out)
	if err != nil {
		t.Fatal(err)
	}
	entities := dict["system-entities"].([]any)
	var fixtureEntities []macAttachedEntity
	for _, value := range entities {
		entity := value.(map[string]any)
		device, _ := entity["dev-entry"].(string)
		hint, _ := entity["content-hint"].(string)
		fixtureEntities = append(fixtureEntities, macAttachedEntity{Device: device, Hint: hint})
	}
	freshDisk, err := macWholeImageDevice(fixtureEntities)
	if err != nil {
		t.Fatal(err)
	}
	fresh := macMountTestRecord(t, work, image, freshDisk)
	t.Cleanup(func() {
		inv, err := macMountInventory(context.Background())
		if err != nil {
			t.Error(err)
			return
		}
		present, err := fresh.validateInventory(inv)
		if err != nil {
			t.Error(err)
			return
		}
		if present {
			if _, err = runMacUpdateCommand(context.Background(), 30*time.Second, "/usr/bin/hdiutil", "detach", fresh.DetachDevice); err != nil {
				t.Error(err)
			}
		}
	})
	if sameMacMountDevices(old.Devices, fresh.Devices) {
		t.Fatal("fixture did not create a new registry lifecycle")
	}
	if err = durableMacUpdateJSON(filepath.Join(work, macMountRecordName), old); err != nil {
		t.Fatal(err)
	}
	if err = cleanupMacUpdateWork(work); err == nil {
		t.Fatal("stale lifecycle detached a new attachment")
	}
	assertMacTestImageAttached(t, image, true)
	if err = durableMacUpdateJSON(filepath.Join(work, macMountRecordName), fresh); err != nil {
		t.Fatal(err)
	}
	if err = cleanupMacUpdateWork(work); err != nil {
		t.Fatal(err)
	}
	assertMacTestImageAttached(t, image, false)
}

func TestMacUpdateCleanupMissingWorkDoesNotHideAttachedImage(t *testing.T) {
	work, image, disk := macMountTestFixture(t)
	if _, err := runMacUpdateCommand(context.Background(), 30*time.Second, "/usr/sbin/diskutil", "unmountDisk", disk); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(work); err != nil {
		t.Fatal(err)
	}
	assertMacTestImageAttached(t, image, true)
	if err := cleanupMacUpdateWork(work); err == nil {
		t.Fatal("missing work was treated as cleaned while its exact image remains attached")
	}
}
