package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func zipRecoveryFixture(t *testing.T) (*DesktopService, componentRecoveryFixture, []byte, []byte) {
	t.Helper()
	s, f, old, next := recoveryFixture(t)
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	entry, err := writer.Create("nested/geoip.dat")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = entry.Write(next); err != nil {
		t.Fatal(err)
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	archive := buffer.Bytes()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s.cfg.ReleasePublicKey = base64.StdEncoding.EncodeToString(public)
	f.Config = s.cfg
	asset := releaseAsset{Platform: platformName(), Architecture: architectureName(), FileName: "geoip.zip", SHA256: testHash(archive), SizeBytes: int64(len(archive)), Component: "geoip", SourceFormat: "zip_entry", ArchiveEntryName: "nested/geoip.dat"}
	manifest := releaseManifest{SchemaVersion: 1, Tag: "v9.2.0", Version: "9.2.0", Channel: "stable", Build: 20, Installers: []releaseAsset{{Platform: platformName(), Architecture: architectureName(), FileName: "client.dmg", SHA256: testHash([]byte("installer")), SizeBytes: 9}}, RuntimeComponents: []releaseAsset{asset}}
	body, _ := json.Marshal(manifest)
	auth, _ := json.Marshal(map[string]string{"manifest": string(body), "signature": base64.StdEncoding.EncodeToString(ed25519.Sign(private, body)), "tag": manifest.Tag})
	if _, err = s.authorizeReleaseManifest(context.Background(), auth); err != nil {
		t.Fatal(err)
	}
	f.Grant, err = s.authorizedDownload("https://github.com/round19/component-commit/releases/download/v9.2.0/geoip.zip", asset.SHA256, asset.SizeBytes)
	if err != nil {
		t.Fatal(err)
	}
	f.Record.ArtifactSHA256 = asset.SHA256
	if err = os.WriteFile(filepath.Join(s.cfg.DataDir, "downloads", asset.SHA256+".download"), archive, 0600); err != nil {
		t.Fatal(err)
	}
	return s, f, old, next
}
func TestComponentZipPairUsesSignedArchiveDuringFreshRecovery(t *testing.T) {
	for _, phase := range []string{"after-component", "after-pair"} {
		t.Run(phase, func(t *testing.T) {
			s, f, old, next := zipRecoveryFixture(t)
			if err := componentChild(t, f, phase); err == nil {
				t.Fatal("writer did not abruptly exit")
			}
			if err := componentChild(t, f, "recover"); err != nil {
				t.Fatal("signed archive recovery failed", err)
			}
			target, _ := s.componentPath("geoip")
			actual, err := os.ReadFile(target)
			if err != nil {
				t.Fatal(err)
			}
			want := old
			if phase == "after-pair" {
				want = next
			}
			if !bytes.Equal(actual, want) {
				t.Fatal("zip pair recovered wrong content")
			}
		})
	}
}
func TestComponentRecoveryDoesNotTrustForgedInstalledHashOrArchive(t *testing.T) {
	for _, scenario := range []string{"forged-direct-payload", "forged-zip-payload", "changed-zip-archive"} {
		t.Run(scenario, func(t *testing.T) {
			s, f, _, _ := recoveryFixture(t)
			if scenario != "forged-direct-payload" {
				s, f, _, _ = zipRecoveryFixture(t)
			}
			if err := componentChild(t, f, "after-component"); err == nil {
				t.Fatal("writer did not abruptly exit")
			}
			target, _ := s.componentPath("geoip")
			work := filepath.Join(s.binDir(), componentWorkName("geoip"))
			stateFile := filepath.Join(work, "state.json")
			if scenario == "changed-zip-archive" {
				if err := os.WriteFile(filepath.Join(s.cfg.DataDir, "downloads", f.Grant.SHA256+".download"), []byte("changed archive"), 0600); err != nil {
					t.Fatal(err)
				}
			} else {
				forged := []byte("arbitrary bytes must not acquire the signed grant")
				if err := os.WriteFile(target, forged, 0700); err != nil {
					t.Fatal(err)
				}
				raw, _ := os.ReadFile(stateFile)
				var state componentCommitState
				if err := json.Unmarshal(raw, &state); err != nil {
					t.Fatal(err)
				}
				record := f.Record
				record.InstalledSHA256 = testHash(forged)
				record.InstalledSize = int64(len(forged))
				if err := atomicJSON(filepath.Join(work, "next-record"), record); err != nil {
					t.Fatal(err)
				}
				root, err := os.OpenRoot(s.binDir())
				if err != nil {
					t.Fatal(err)
				}
				state.AfterComponent, err = componentFileStateAt(root, filepath.Base(target))
				if err != nil {
					t.Fatal(err)
				}
				state.AfterRecord, err = componentFileStateAt(root, filepath.Join(componentWorkName("geoip"), "next-record"))
				root.Close()
				if err != nil {
					t.Fatal(err)
				}
				if err = atomicJSON(stateFile, state); err != nil {
					t.Fatal(err)
				}
			}
			before, _ := os.ReadFile(target)
			metadataBefore, _ := os.ReadFile(filepath.Join(s.binDir(), "geoip.json"))
			if err := componentChild(t, f, "recover"); err == nil {
				t.Fatal("unverified payload or archive accepted")
			}
			after, _ := os.ReadFile(target)
			metadataAfter, _ := os.ReadFile(filepath.Join(s.binDir(), "geoip.json"))
			if !bytes.Equal(before, after) || !bytes.Equal(metadataBefore, metadataAfter) {
				t.Fatal("refused signature evidence still mutated files")
			}
			if _, err := os.Stat(stateFile); err != nil {
				t.Fatal("refused recovery removed its evidence", err)
			}
		})
	}
}
func TestComponentPreparedCancellationAndIncompletePreparationKeepOldPair(t *testing.T) {
	for _, scenario := range []string{"cancelled-before-rename", "interrupted-prepare"} {
		t.Run(scenario, func(t *testing.T) {
			s, f, old, _ := recoveryFixture(t)
			if scenario == "cancelled-before-rename" {
				tx, err := s.prepareComponentInstall(context.Background(), f.Source, f.Record, f.Grant)
				if err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithCancel(context.Background())
				cancel()
				err = tx.apply(ctx, nil)
				tx.root.Close()
				if err == nil {
					t.Fatal("cancelled preparation committed")
				}
			} else {
				work := filepath.Join(s.binDir(), componentWorkName("geoip"))
				if err := os.Mkdir(work, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(work, "next-component"), []byte("interrupted preparation"), 0700); err != nil {
					t.Fatal(err)
				}
			}
			if err := componentChild(t, f, "recover"); err != nil {
				t.Fatal(err)
			}
			target, _ := s.componentPath("geoip")
			actual, err := os.ReadFile(target)
			if err != nil || !bytes.Equal(old, actual) {
				t.Fatal("pre-commit interruption changed current content", err)
			}
			if _, err = s.componentMetadata("geoip"); err != nil {
				t.Fatal("old metadata not usable after preparation cleanup", err)
			}
		})
	}
}
