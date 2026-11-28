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
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
	"golang.org/x/sys/unix"
)

func fullMacGUIPayloadFixture(t *testing.T, app string) (macUpdateFixture, macBundleInfo, releaseAsset) {
	t.Helper()
	source, err := readMacBundle(context.Background(), app, true)
	if err != nil || source.Build.Mode != "local" {
		t.Fatal("full GUI requires a sealed local app", err)
	}
	image := os.Getenv("CHORDV_TEST_FULL_GUI_DMG")
	info, err := os.Lstat(image)
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || filepath.Ext(image) != ".dmg" {
		t.Fatal("full GUI requires the original local build DMG (CHORDV_TEST_FULL_GUI_DMG)", err)
	}
	hash, err := fileSHA256(image)
	if err != nil {
		t.Fatal(err)
	}
	f := macFixture(t, "13.0")
	// This private fixture has its own trust root; never change the packaged source.
	plistPath := filepath.Join(f.Current, "Contents", "Info.plist")
	raw, err := os.ReadFile(plistPath)
	if err != nil {
		t.Fatal(err)
	}
	dict, err := parsePlist(raw)
	if err != nil {
		t.Fatal(err)
	}
	dict["CFBundleIdentifier"] = source.Identifier
	raw, err = marshalPlist(dict)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(plistPath, raw, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err = runMacUpdateCommand(context.Background(), 30*time.Second, "/usr/bin/codesign", "--force", "--sign", "-", f.Current); err != nil {
		t.Fatal(err)
	}
	if err = os.RemoveAll(f.Candidate); err != nil {
		t.Fatal(err)
	}
	if _, err = runMacUpdateCommand(context.Background(), 30*time.Second, "/usr/bin/ditto", app, f.Candidate); err != nil {
		t.Fatal(err)
	}
	f.DataDir = filepath.Join(f.Root, "full-gui-data")
	if err = os.MkdirAll(filepath.Join(f.DataDir, "updater"), 0700); err != nil {
		t.Fatal(err)
	}
	f.Installer = filepath.Join(f.DataDir, "updater", "update.dmg")
	if _, err = runMacUpdateCommand(context.Background(), 90*time.Second, "/bin/cp", image, f.Installer); err != nil {
		t.Fatal(err)
	}
	if err = verifyFile(f.Installer, hash, info.Size()); err != nil {
		t.Fatal("the private update fixture differs from the original installer", err)
	}
	t.Logf("original local installer SHA256=%s", hash)
	asset := releaseAsset{Platform: "macos", Architecture: architectureName(), FileName: "update.dmg", SHA256: hash, SizeBytes: info.Size()}
	return f, source, asset
}

func requirePackagedMacCandidate(t *testing.T, staged, expected macBundleInfo) {
	t.Helper()
	if staged.CDHash != expected.CDHash || staged.Build != expected.Build || staged.Identifier != expected.Identifier {
		t.Fatal("staged DMG candidate differs from the sealed build output")
	}
}

func fullMacGUIFixture(t *testing.T, app string) macUpdateFixture {
	t.Helper()
	f, source, asset := fullMacGUIPayloadFixture(t, app)
	manifest := releaseManifest{SchemaVersion: 1, Tag: "v" + source.Version, Version: source.Version, Channel: "stable", Build: source.Build.Build, Installers: []releaseAsset{asset}}
	body, _ := json.Marshal(manifest)
	signature := base64.StdEncoding.EncodeToString(ed25519.Sign(f.SigningKey, body))
	repository := "test/desktop"
	key := base64.StdEncoding.EncodeToString(f.SigningKey.Public().(ed25519.PublicKey))
	service := newDesktopService(appConfig{DataDir: f.DataDir, ReleaseRepository: repository, ReleasePublicKey: key})
	defer service.cancel()
	input, _ := json.Marshal(map[string]string{"manifest": string(body), "signature": signature, "tag": manifest.Tag})
	if _, err := service.authorizeReleaseManifest(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	grant, err := service.authorizedDownload("https://github.com/"+repository+"/releases/download/"+manifest.Tag+"/update.dmg", asset.SHA256, asset.SizeBytes)
	if err != nil {
		t.Fatal(err)
	}
	if err = atomicJSON(filepath.Join(f.DataDir, "updater", "pending.json"), pendingInstaller{Path: f.Installer, SHA256: asset.SHA256, Size: asset.SizeBytes, Version: source.Version, Grant: grant}); err != nil {
		t.Fatal(err)
	}
	if err = atomicJSON(f.Config, macFixtureConfig{f.DataDir, repository, key, f.Installer}); err != nil {
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
	return f
}

func TestMacUpdatePackagedChordVGUIReadyWithoutNetwork(t *testing.T) {
	app := os.Getenv("CHORDV_TEST_FULL_GUI_APP")
	if app == "" && os.Getenv("CHORDV_TEST_FULL_GUI_DMG") == "" {
		t.Skip("requires the original local DMG and its explicitly built ChordV bundle")
	}
	app, err := macCanonical(app)
	if err != nil {
		t.Fatal(err)
	}
	f := fullMacGUIFixture(t, app)
	if _, err := os.Stat(proxyJournalPath(f.DataDir)); !os.IsNotExist(err) {
		t.Fatal("full GUI must start without any proxy journal", err)
	}
	h := startMacHolder(t, f)
	h.ready(t)
	_, _ = fmt.Fprintln(h.pipe, "ARM")
	if got := h.line(t); got != "ARMED" {
		t.Fatal(got)
	}
	// The exact candidate inode was captured only after genuine staging/validation.
	staged, err := readMacBundle(context.Background(), filepath.Join(h.work, "next.app"), true)
	if err != nil {
		t.Fatal(err)
	}
	requirePackagedMacCandidate(t, staged, f.CandidateInfo)
	_, _ = fmt.Fprintln(h.pipe, "EXIT")
	if err := <-h.done; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		stopFullMacGUI(t, f.Current, staged)
	})
	// The GUI consumes install-report.json; cleanup, not a transient report, is the commit witness.
	macWait(t, f.Root, 75*time.Second, func() bool { _, err := os.Stat(h.work); return os.IsNotExist(err) })
	installed, err := readMacBundle(context.Background(), f.Current, true)
	if err != nil || installed.Node != staged.Node || installed.CDHash != staged.CDHash {
		t.Fatal("full packaged GUI did not remain installed", err)
	}
	if _, err := os.Stat(h.work); !os.IsNotExist(err) {
		t.Fatal("healthy GUI retained work", err)
	}
	if _, err := os.Stat(filepath.Join(f.DataDir, "updater", "mac-update-journal.json")); !os.IsNotExist(err) {
		t.Fatal("healthy GUI retained journal", err)
	}
	if _, err := os.Stat(proxyJournalPath(f.DataDir)); !os.IsNotExist(err) {
		t.Fatal("GUI-only readiness created a proxy journal", err)
	}
	if pid, err := fullGUIRegisteredPID(f.Current, staged); err != nil || pid == 0 {
		t.Fatal("healthy schema1 GUI is absent from fresh LaunchServices/kernel witnesses", pid, err)
	}
	t.Logf("full packaged ChordV GUI native+frontend ACK passed: version=%s build=%d CDHash=%s; API is loopback port1, no proxy journal", installed.Version, installed.Build.Build, installed.CDHash)
}

// Use a fresh LaunchServices query, not NSWorkspace's run-loop-maintained cached collection.
// The independent kernel path scan makes a missed registration a failure, not successful cleanup.
func fullGUIRegisteredPID(target string, expected macBundleInfo) (int, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if _, err := purego.Dlopen("/System/Library/Frameworks/AppKit.framework/AppKit", purego.RTLD_GLOBAL|purego.RTLD_NOW); err != nil {
		return 0, err
	}
	pool := objc.ID(objc.GetClass("NSAutoreleasePool")).Send(objc.RegisterName("new"))
	defer pool.Send(objc.RegisterName("drain"))
	apps := objc.ID(objc.GetClass("NSRunningApplication")).Send(objc.RegisterName("runningApplicationsWithBundleIdentifier:"), macLaunchString(expected.Identifier))
	count := objc.Send[uint64](apps, objc.RegisterName("count"))
	pid := 0
	for index := uint64(0); index < count; index++ {
		app := apps.Send(objc.RegisterName("objectAtIndex:"), index)
		candidatePID := int(objc.Send[int32](app, objc.RegisterName("processIdentifier")))
		app = objc.ID(objc.GetClass("NSRunningApplication")).Send(objc.RegisterName("runningApplicationWithProcessIdentifier:"), int32(candidatePID))
		if app == 0 {
			continue
		}
		if objc.Send[bool](app, objc.RegisterName("isTerminated")) {
			continue
		}
		url := app.Send(objc.RegisterName("bundleURL"))
		if url == 0 {
			continue
		}
		path := objc.Send[string](url.Send(objc.RegisterName("path")), objc.RegisterName("UTF8String"))
		if !fullGUIBundleURLMatches(path, target) {
			continue
		}
		executable, err := macHealthProcessPath(candidatePID)
		if err != nil {
			continue
		}
		if executable != filepath.Join(target, "Contents", "MacOS", filepath.Base(expected.Executable)) {
			return 0, fmt.Errorf("registered GUI executable mismatch")
		}
		hash, err := macHealthProcessCDHash(candidatePID)
		if err != nil || hash != expected.CDHash {
			return 0, fmt.Errorf("registered GUI dynamic signature mismatch: %w", err)
		}
		if pid != 0 {
			return 0, fmt.Errorf("multiple registered GUIs at the exact fixture path")
		}
		pid = candidatePID
	}
	processes, err := unix.SysctlKinfoProcSlice("kern.proc.all")
	if err != nil {
		return 0, err
	}
	kernelPID := 0
	for _, process := range processes {
		if process.Eproc.Ucred.Uid != uint32(os.Getuid()) || process.Proc.P_stat == 5 {
			continue
		}
		candidatePID := int(process.Proc.P_pid)
		executable, err := macHealthProcessPath(candidatePID)
		if err != nil || executable != filepath.Join(target, "Contents", "MacOS", filepath.Base(expected.Executable)) {
			continue
		}
		if hash, err := macHealthProcessCDHash(candidatePID); err != nil || hash != expected.CDHash {
			return 0, fmt.Errorf("kernel GUI dynamic signature mismatch: %w", err)
		}
		if kernelPID != 0 {
			return 0, fmt.Errorf("multiple kernel GUIs at the exact fixture path")
		}
		kernelPID = candidatePID
	}
	if pid != kernelPID {
		return 0, fmt.Errorf("fresh LaunchServices PID %d differs from owned kernel PID %d", pid, kernelPID)
	}
	return pid, nil
}

func fullGUIBundleURLMatches(path, target string) bool {
	actual, err := macCanonical(path)
	return err == nil && actual == target
}

func stopFullMacGUI(t *testing.T, target string, staged macBundleInfo) {
	t.Helper()
	pid, err := fullGUIRegisteredPID(target, staged)
	if err != nil {
		t.Error(err)
		return
	}
	if pid == 0 {
		return
	}
	owned, err := ownMacUpdateProcess(pid, filepath.Join(target, "Contents", "MacOS", filepath.Base(staged.Executable)))
	if err != nil {
		t.Error(err)
		return
	}
	defer owned.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := owned.StopAndWait(ctx); err != nil {
		t.Error(err)
	}
	if identity, err := macHealthProcessIdentity(pid); err == nil && identity == owned.identity {
		t.Error("owned GUI identity remains after cleanup", pid)
	}
	if remaining, err := fullGUIRegisteredPID(target, staged); err != nil || remaining != 0 {
		t.Error("owned GUI registration remains after cleanup", remaining, err)
	}
}

func TestFullGUIBundleURLCanonicalAliases(t *testing.T) {
	target, err := macCanonical(t.TempDir())
	if err != nil || !strings.HasPrefix(target, "/private/var/") {
		t.Fatal("requires canonical macOS private temporary directory", target, err)
	}
	alias := strings.TrimPrefix(target, "/private")
	if !fullGUIBundleURLMatches(target, target) || !fullGUIBundleURLMatches(alias, target) {
		t.Fatal("equivalent /var and /private/var URLs differ")
	}
	other, err := macCanonical(t.TempDir())
	if err != nil || fullGUIBundleURLMatches(other, target) || fullGUIBundleURLMatches(filepath.Join(target, "absent"), target) {
		t.Fatal("unrelated or absent bundle URL matched", err)
	}
}
