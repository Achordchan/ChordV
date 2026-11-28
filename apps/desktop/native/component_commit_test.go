package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func componentCommitFixture(t *testing.T) (*DesktopService, componentItem, json.RawMessage, []byte, []byte) {
	t.Helper()
	s := testService(t, "http://127.0.0.1:1")
	old, next := []byte("old locally installed component"), []byte("new signed component payload")
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s.cfg.ReleaseRepository = "round19/component-commit"
	s.cfg.ReleasePublicKey = base64.StdEncoding.EncodeToString(public)
	hash := testHash(next)
	size := int64(len(next))
	asset := releaseAsset{Platform: platformName(), Architecture: architectureName(), FileName: "geoip.dat", SHA256: hash, SizeBytes: size, Component: "geoip", SourceFormat: "direct"}
	manifest := releaseManifest{SchemaVersion: 1, Tag: "v9.1.0", Version: "9.1.0", Channel: "stable", Build: 19, Installers: []releaseAsset{{Platform: platformName(), Architecture: architectureName(), FileName: "client.dmg", SHA256: testHash([]byte("installer")), SizeBytes: 9}}, RuntimeComponents: []releaseAsset{asset}}
	body, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	auth, _ := json.Marshal(map[string]string{"manifest": string(body), "signature": base64.StdEncoding.EncodeToString(ed25519.Sign(private, body)), "tag": manifest.Tag})
	if _, err = s.authorizeReleaseManifest(context.Background(), auth); err != nil {
		t.Fatal(err)
	}
	target, _ := s.componentPath("geoip")
	if err = os.MkdirAll(s.binDir(), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(target, old, 0700); err != nil {
		t.Fatal(err)
	}
	record := installedComponent{Kind: "geoip", VersionLabel: pointer("old"), ArtifactSHA256: testHash(old), InstalledSHA256: testHash(old), InstalledSize: int64(len(old))}
	if err = atomicJSON(filepath.Join(s.binDir(), "geoip.json"), record); err != nil {
		t.Fatal(err)
	}
	cache := filepath.Join(s.cfg.DataDir, "downloads", hash+".download."+hash[:16]+".part")
	if err = os.MkdirAll(filepath.Dir(cache), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(cache, next, 0600); err != nil {
		t.Fatal(err)
	}
	item := componentItem{Component: "geoip", FileName: "geoip.dat", SourceFormat: "direct", FileSizeBytes: &size, ChecksumSHA256: &hash, VersionLabel: pointer("new")}
	input, _ := json.Marshal(map[string]any{"component": item, "url": "https://github.com/round19/component-commit/releases/download/v9.1.0/geoip.dat"})
	return s, item, input, old, next
}

func TestComponentMetadataWriteFailureDoesNotReplaceExistingAsset(t *testing.T) {
	s, _, input, old, _ := componentCommitFixture(t)
	path := filepath.Join(s.binDir(), "geoip.json")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	value, err := s.downloadComponent(context.Background(), input)
	if value != nil || err == nil {
		t.Fatal("metadata directory must reject installation", value, err)
	}
	target, _ := s.componentPath("geoip")
	actual, err := os.ReadFile(target)
	if err != nil || string(actual) != string(old) {
		t.Fatal("failed metadata installation replaced the existing asset", string(actual), err)
	}
}
