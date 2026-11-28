//go:build darwin

package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestMacUpdateJournalProtectsInstalledComponent(t *testing.T) {
	for _, phase := range []string{"before-download", "before-install"} {
		t.Run(phase, func(t *testing.T) {
			s, _, input, _, _ := componentCommitFixture(t)
			updater := filepath.Join(s.cfg.DataDir, "updater")
			if err := os.MkdirAll(updater, 0700); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(updater, "mac-update-journal.json")
			record := []byte(`{"phase":"interrupted"}`)
			write := func() {
				t.Helper()
				if err := os.WriteFile(path, record, 0600); err != nil {
					t.Fatal(err)
				}
			}
			installed := macRecoveryTree(t, s.binDir())
			downloads := macRecoveryTree(t, filepath.Join(s.cfg.DataDir, "downloads"))
			var phases []string
			if phase == "before-download" {
				write()
			}
			s.emit = func(e NativeEvent) {
				if p, ok := e.Payload.(downloadProgress); ok {
					phases = append(phases, p.Phase)
					if phase == "before-install" && p.Phase == "verifying" {
						write()
					}
				}
			}
			v, err := s.downloadComponent(context.Background(), input)
			if err == nil || !strings.Contains(err.Error(), "mac_update_pending") || v != nil {
				t.Fatalf("unfinished update did not block component: %v, %v", v, err)
			}
			if !reflect.DeepEqual(installed, macRecoveryTree(t, s.binDir())) {
				t.Fatal("installed component or metadata changed")
			}
			data, err := os.ReadFile(path)
			if err != nil || string(data) != string(record) {
				t.Fatal("update journal changed", err)
			}
			if phase == "before-download" {
				if len(phases) != 0 || !reflect.DeepEqual(downloads, macRecoveryTree(t, filepath.Join(s.cfg.DataDir, "downloads"))) {
					t.Fatal("download started before refusal", phases)
				}
			} else if len(phases) == 0 || phases[len(phases)-1] != "failed" {
				t.Fatal("late refusal missing failed event", phases)
			}
		})
	}
}

func TestMacComponentCommitWhileUpdateHelperOwnsLock(t *testing.T) {
	const envKey = "CHORDV_PRIVATE_COMPONENT_LOCK_TEST_DIR"
	if dir := os.Getenv(envKey); dir != "" {
		lock, err := lockMacUpdateData(dir)
		if err != nil {
			t.Fatal(err)
		}
		defer lock.Close()
		fmt.Println("LOCKED")
		_, err = io.Copy(io.Discard, os.Stdin)
		if err != nil {
			t.Fatal(err)
		}
		return
	}
	s, item, input, old, next := componentCommitFixture(t)
	dir, err := macCanonical(s.cfg.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(filepath.Join(dir, "updater"), 0700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	child := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestMacComponentCommitWhileUpdateHelperOwnsLock$")
	child.Env = append(os.Environ(), envKey+"="+dir)
	reader, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	writer, err := child.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = child.Start(); err != nil {
		t.Fatal(err)
	}
	waited := false
	defer func() {
		writer.Close()
		if !waited {
			_ = child.Wait()
		}
	}()
	if line, err := bufio.NewReader(reader).ReadString('\n'); err != nil || strings.TrimSpace(line) != "LOCKED" {
		t.Fatal("no child lock witness", line, err)
	}
	before := macRecoveryTree(t, s.binDir())
	read := readProxySettings
	t.Cleanup(func() { readProxySettings = read })
	proxyReads := 0
	readProxySettings = func(context.Context) ([]proxySetting, error) {
		proxyReads++
		return nil, nil
	}
	config := leaseTestConfig()
	config.LocalHTTPPort, config.LocalSocksPort = localTestPorts(t)
	for _, force := range []bool{false, true} {
		if err := s.checkNetworkConflict(ctx, force); err == nil || !strings.Contains(err.Error(), "mac_update_pending") || proxyReads != 0 {
			t.Errorf("preflight(force=%t) during update: %v (proxy reads %d)", force, err, proxyReads)
		}
		if _, err := s.connect(ctx, config, force); err == nil || !strings.Contains(err.Error(), "mac_update_pending") {
			t.Errorf("connect(force=%t) while helper holds lock: %v", force, err)
		}
	}
	for _, path := range []string{filepath.Join(dir, "runtime", "config.json"), filepath.Join(dir, "runtime", "xray.log"), proxyJournalPath(dir)} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatalf("unexpected runtime side effect %s: %v", path, err)
		}
	}
	v, err := s.downloadComponent(ctx, input)
	if err == nil || !strings.Contains(err.Error(), "mac_update_pending") || v != nil || !reflect.DeepEqual(before, macRecoveryTree(t, s.binDir())) {
		t.Fatal("component commit was not refused before changing the old pair", err)
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	err = child.Wait()
	waited = true
	if err != nil {
		t.Fatal(err)
	}
	if err := s.checkNetworkConflict(ctx, false); err != nil || proxyReads != 1 {
		t.Fatalf("preflight after release: %v (proxy reads %d)", err, proxyReads)
	}
	hash := *item.ChecksumSHA256
	cached := filepath.Join(dir, "downloads", hash+".download")
	if err = os.Rename(cached, cached+"."+hash[:16]+".part"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.downloadComponent(ctx, input); err != nil {
		t.Fatal("retry after release", err)
	}
	target, _ := s.componentPath(item.Component)
	data, err := os.ReadFile(target)
	if err != nil || !bytes.Equal(data, next) || bytes.Equal(data, old) {
		t.Fatal("retry did not install the verified component", err)
	}
}

func TestComponentInstallLockRejectsUnexpectedUpdaterDirectory(t *testing.T) {
	root, err := macCanonical(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	other := t.TempDir()
	if err = os.Symlink(other, filepath.Join(root, "updater")); err != nil {
		t.Fatal(err)
	}
	if release, err := lockRuntimeMutation(root); err == nil {
		release()
		t.Fatal("accepted redirected lock directory")
	}
	entries, err := os.ReadDir(other)
	if err != nil || len(entries) != 0 {
		t.Fatal("created lock outside updater", err)
	}
}

func TestComponentStartupRecoveryRespectsUpdateOwnership(t *testing.T) {
	for _, gate := range []string{"held-lock", "retained-journal"} {
		t.Run(gate, func(t *testing.T) {
			s, f, old, next := recoveryFixture(t)
			root, err := macCanonical(s.cfg.DataDir)
			if err != nil {
				t.Fatal(err)
			}
			updater := filepath.Join(root, "updater")
			if err = os.MkdirAll(updater, 0700); err != nil {
				t.Fatal(err)
			}
			occupy := func() func() {
				if gate == "held-lock" {
					lock, err := lockMacUpdateData(root)
					if err != nil {
						t.Fatal(err)
					}
					t.Cleanup(func() { lock.Close() })
					return func() { lock.Close() }
				} else {
					path := filepath.Join(updater, "mac-update-journal.json")
					if err = os.WriteFile(path, []byte("interrupted"), 0600); err != nil {
						t.Fatal(err)
					}
					return func() {
						if err := os.Remove(path); err != nil {
							t.Fatal(err)
						}
					}
				}
			}
			release := occupy()
			if err = componentChild(t, f, "recover"); err != nil {
				t.Fatal("clean boot must not contend with update health handshake", err)
			}
			release()
			err = componentChild(t, f, "after-component")
			var exit *exec.ExitError
			if !errors.As(err, &exit) || exit.ExitCode() != 23 {
				t.Fatal("fixture failed to exit between component and metadata", err)
			}
			target, _ := s.componentPath(f.Record.Kind)
			data, err := os.ReadFile(target)
			if err != nil || !bytes.Equal(data, next) {
				t.Fatal("partial pair missing", err)
			}
			release = occupy()
			before := macRecoveryTree(t, s.binDir())
			if err = componentChild(t, f, "recover"); err == nil {
				t.Fatal("startup changed partial component during application update")
			}
			if !reflect.DeepEqual(before, macRecoveryTree(t, s.binDir())) {
				t.Fatal("denied recovery changed files")
			}
			release()
			if err = componentChild(t, f, "recover"); err != nil {
				t.Fatal("next startup did not recover component", err)
			}
			data, err = os.ReadFile(target)
			if err != nil || !bytes.Equal(data, old) {
				t.Fatal("old component was not restored", err)
			}
			meta, err := s.componentMetadata(f.Record.Kind)
			if err != nil || meta.InstalledSHA256 != testHash(old) {
				t.Fatal("old metadata was not restored", err)
			}
		})
	}
}
