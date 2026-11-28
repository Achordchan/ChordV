package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestComponentCancellationBeforeInstallPreservesPreviousVersion(t *testing.T) {
	for _, format := range []string{"direct", "zip_entry"} {
		for _, scenario := range []string{"cancelled", "waiting-lock", "success", "cancel-after-commit"} {
			cancelled := scenario == "cancelled" || scenario == "waiting-lock"
			label := format + "/" + scenario
			t.Run(label, func(t *testing.T) {
				s := testService(t, "http://127.0.0.1:1")
				old := []byte("previous verified GEOIP content")
				next := []byte("next signed immutable GEOIP content")
				archive := next
				entry := "geoip.dat"
				if format == "zip_entry" {
					var buffer bytes.Buffer
					writer := zip.NewWriter(&buffer)
					file, err := writer.Create(entry)
					if err != nil {
						t.Fatal(err)
					}
					if _, err = file.Write(next); err != nil {
						t.Fatal(err)
					}
					if err = writer.Close(); err != nil {
						t.Fatal(err)
					}
					archive = buffer.Bytes()
				}
				hash := testHash(archive)
				filename := "geoip.dat"
				if format == "zip_entry" {
					filename = "geoip.zip"
				}
				public, private, err := ed25519.GenerateKey(rand.Reader)
				if err != nil {
					t.Fatal(err)
				}
				s.cfg.ReleaseRepository = "round17/cancellation-proof"
				s.cfg.ReleasePublicKey = base64.StdEncoding.EncodeToString(public)
				component := releaseAsset{Platform: platformName(), Architecture: architectureName(), FileName: filename, SHA256: hash, SizeBytes: int64(len(archive)), Component: "geoip", SourceFormat: format}
				if format == "zip_entry" {
					component.ArchiveEntryName = entry
				}
				manifest := releaseManifest{SchemaVersion: 1, Tag: "v9.0.0", Version: "9.0.0", Channel: "stable", Build: 17, Installers: []releaseAsset{{Platform: platformName(), Architecture: architectureName(), FileName: "client.dmg", SHA256: testHash([]byte("signed installer")), SizeBytes: 16}}, RuntimeComponents: []releaseAsset{component}}
				body, err := json.Marshal(manifest)
				if err != nil {
					t.Fatal(err)
				}
				authorization, err := json.Marshal(map[string]string{"manifest": string(body), "signature": base64.StdEncoding.EncodeToString(ed25519.Sign(private, body)), "tag": manifest.Tag})
				if err != nil {
					t.Fatal(err)
				}
				if _, err = s.authorizeReleaseManifest(context.Background(), authorization); err != nil {
					t.Fatal(err)
				}
				target, err := s.componentPath("geoip")
				if err != nil {
					t.Fatal(err)
				}
				if err = os.MkdirAll(filepath.Dir(target), 0700); err != nil {
					t.Fatal(err)
				}
				if err = os.WriteFile(target, old, 0700); err != nil {
					t.Fatal(err)
				}
				recordPath := filepath.Join(s.binDir(), "geoip.json")
				previousRecord := installedComponent{Kind: "geoip", VersionLabel: pointer("previous"), ArtifactSHA256: testHash(old), InstalledSHA256: testHash(old), InstalledSize: int64(len(old))}
				if err = atomicJSON(recordPath, previousRecord); err != nil {
					t.Fatal(err)
				}
				metadata, err := os.ReadFile(recordPath)
				if err != nil {
					t.Fatal(err)
				}
				cached := filepath.Join(s.cfg.DataDir, "downloads", hash+".download")
				if err = os.MkdirAll(filepath.Dir(cached), 0700); err != nil {
					t.Fatal(err)
				}
				// A complete real part is a valid resume state after interruption before rename.
				if err = os.WriteFile(cached+"."+hash[:16]+".part", archive, 0600); err != nil {
					t.Fatal(err)
				}
				var phases []string
				reachedBoundary := make(chan struct{})
				lockHeld := scenario == "waiting-lock"
				if lockHeld {
					s.operationMu.Lock()
					defer func() {
						if lockHeld {
							s.operationMu.Unlock()
						}
					}()
				}
				cancelledAtBoundary := false
				s.emit = func(event NativeEvent) {
					if event.Name != "chordv://runtime-component-download-progress" {
						return
					}
					progress, ok := event.Payload.(downloadProgress)
					if !ok {
						t.Fatal("unexpected progress payload")
					}
					phases = append(phases, progress.Phase)
					boundary := "verifying"
					if format == "zip_entry" {
						boundary = "extracting"
					}
					if scenario == "cancelled" && progress.Phase == boundary {
						cancelledAtBoundary = true
						s.cancelDownload()
					}
					if scenario == "waiting-lock" && progress.Phase == boundary {
						close(reachedBoundary)
					}
					if scenario == "cancel-after-commit" && progress.Phase == "completed" {
						s.cancelDownload()
					}
				}
				item := componentItem{Component: "geoip", FileName: filename, FileSizeBytes: pointer(int64(len(archive))), SourceFormat: format, ChecksumSHA256: &hash, VersionLabel: pointer("next")}
				if format == "zip_entry" {
					item.ArchiveEntryName = &entry
				}
				input, err := json.Marshal(map[string]any{"component": item, "url": "https://github.com/round17/cancellation-proof/releases/download/v9.0.0/" + filename})
				if err != nil {
					t.Fatal(err)
				}
				var value any
				var downloadErr error
				if scenario == "waiting-lock" {
					finished := make(chan struct{})
					go func() { defer close(finished); value, downloadErr = s.downloadComponent(context.Background(), input) }()
					<-reachedBoundary
					// Observe the actual blocked mutex frame, rather than timing a cancellation.
					stack := make([]byte, 1<<20)
					blocked := false
					for attempt := 0; attempt < 10000; attempt++ {
						n := runtime.Stack(stack, true)
						for _, goroutine := range strings.Split(string(stack[:n]), "\n\n") {
							if strings.Contains(goroutine, "downloadComponent") && (strings.Contains(goroutine, "[sync.Mutex.Lock]") || strings.Contains(goroutine, "[sync.Mutex.Lock,")) {
								blocked = true
								break
							}
						}
						if blocked {
							break
						}
						runtime.Gosched()
					}
					if !blocked {
						t.Error("component did not reach the held operation mutex")
					}
					cancelledAtBoundary = true
					s.cancelDownload()
					s.operationMu.Unlock()
					lockHeld = false
					<-finished
				} else {
					value, downloadErr = s.downloadComponent(context.Background(), input)
				}
				actual, err := os.ReadFile(target)
				if err != nil {
					t.Fatal(err)
				}
				installedMetadata, err := os.ReadFile(recordPath)
				if err != nil {
					t.Fatal(err)
				}
				if cancelled {
					if !cancelledAtBoundary {
						t.Fatal("cancellation boundary was not exercised")
					}
					if !errors.Is(downloadErr, context.Canceled) || value != nil {
						t.Errorf("cancelled install reported success: value=%v err=%v phases=%v", value, downloadErr, phases)
					}
					if !bytes.Equal(actual, old) || !bytes.Equal(installedMetadata, metadata) {
						t.Error("cancelled component install changed previous file or metadata")
					}
					for _, phase := range phases {
						if phase == "completed" {
							t.Error("cancelled component emitted completed")
						}
					}
					if err = verifyFile(cached, hash, int64(len(archive))); err != nil {
						t.Error("cancelled validated download should remain available for retry", err)
					}
				} else {
					if downloadErr != nil || value == nil || !bytes.Equal(actual, next) {
						t.Errorf("uncancelled signed component installation failed: %v", downloadErr)
					}
					if err = verifyFile(target, testHash(next), int64(len(next))); err != nil {
						t.Fatal(err)
					}
					if phases[len(phases)-1] != "completed" {
						t.Fatal("successful install did not complete", phases)
					}
				}
				if s.downloadCancel != nil {
					t.Error("download ownership was not released")
				}
				leftovers, err := filepath.Glob(cached + ".extracted")
				if err != nil || len(leftovers) != 0 {
					t.Error("temporary extracted component was retained", err)
				}
			})
		}
	}
}
