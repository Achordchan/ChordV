package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"strings"
	"testing"
)

func TestManifestSignaturesAcceptPEMRawAndDERAndRejectChangedBytes(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	manifest := "{\"version\":\"1.2.3\"}\n"
	signature := base64.StdEncoding.EncodeToString(ed25519.Sign(private, []byte(manifest)))
	der, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{base64.StdEncoding.EncodeToString(public), base64.StdEncoding.EncodeToString(der), string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))} {
		valid, err := verifyManifestSignature(manifest, signature, key)
		if err != nil || !valid {
			t.Fatal("valid key rejected", err)
		}
		valid, err = verifyManifestSignature(strings.TrimSpace(manifest), signature, key)
		if err != nil || valid {
			t.Fatal("modified manifest accepted", err)
		}
	}
}
func TestNativeDownloadsRequireConfiguredManifestAuthorization(t *testing.T) {
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	service := testService(t, "http://127.0.0.1:3100")
	service.cfg.ReleaseRepository = "owner/repo"
	service.cfg.ReleasePublicKey = base64.StdEncoding.EncodeToString(public)
	manifest := releaseManifest{SchemaVersion: 1, Tag: "v1.2.3", Version: "1.2.3", Build: 10, Channel: "stable", Installers: []releaseAsset{{Platform: platformName(), Architecture: architectureName(), FileName: "ChordV.dmg", SHA256: strings.Repeat("a", 64), SizeBytes: 42}}}
	bytes, _ := json.Marshal(manifest)
	signature := base64.StdEncoding.EncodeToString(ed25519.Sign(private, bytes))
	input, _ := json.Marshal(map[string]string{"manifest": string(bytes), "signature": signature, "tag": "v1.2.3"})
	origin := "https://github.com/owner/repo/releases/download/v1.2.3/ChordV.dmg"
	if _, err := service.authorizedDownload(origin, strings.Repeat("a", 64), 42); err == nil {
		t.Fatal("unapproved download accepted")
	}
	if _, err := service.authorizeReleaseManifest(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	if _, err := service.authorizedDownload(origin, strings.Repeat("a", 64), 42); err != nil {
		t.Fatal(err)
	}
	if _, err := service.authorizedDownload("https://ghfast.top/"+origin, strings.Repeat("a", 64), 42); err != nil {
		t.Fatal(err)
	}
	if _, err := service.authorizedDownload(origin, strings.Repeat("b", 64), 42); err == nil {
		t.Fatal("modified hash accepted")
	}
	if _, err := service.authorizedDownload(strings.Replace(origin, "owner/repo", "other/repo", 1), strings.Repeat("a", 64), 42); err == nil {
		t.Fatal("different repository accepted")
	}
}
func TestManifestAuthorizationCannotTrustCallerSuppliedKey(t *testing.T) {
	public, _, _ := ed25519.GenerateKey(rand.Reader)
	_, foreign, _ := ed25519.GenerateKey(rand.Reader)
	s := testService(t, "http://127.0.0.1:3100")
	s.cfg.ReleaseRepository = "owner/repo"
	s.cfg.ReleasePublicKey = base64.StdEncoding.EncodeToString(public)
	body := `{"schemaVersion":1,"tag":"v1.2.3","version":"1.2.3","channel":"stable","build":1}`
	signature := base64.StdEncoding.EncodeToString(ed25519.Sign(foreign, []byte(body)))
	input, _ := json.Marshal(map[string]string{"manifest": body, "signature": signature, "tag": "v1.2.3"})
	if _, err := s.authorizeReleaseManifest(context.Background(), input); err == nil {
		t.Fatal("foreign signing key accepted")
	}
}
func TestReleaseTextScopeBlocksOtherRepositoriesAndLocalServices(t *testing.T) {
	s := testService(t, "http://127.0.0.1:3100")
	s.cfg.ReleaseRepository = "owner/repo"
	s.cfg.ReleasePublicKey = "configured"
	for _, address := range []string{"https://raw.githubusercontent.com/owner/repo/release-channels/stable.json", "https://ghfast.top/https://raw.githubusercontent.com/owner/repo/release-channels/beta.json.sig", "https://github.com/owner/repo/releases/download/v1.2.3/chordv-release.json", "https://api.github.com/repos/owner/repo/releases?per_page=30"} {
		if err := s.validateReleaseTextURL(address); err != nil {
			t.Fatal(address, err)
		}
	}
	for _, address := range []string{"http://127.0.0.1:3306/secret", "https://raw.githubusercontent.com/evil/repo/release-channels/stable.json", "https://github.com/owner/repo/releases/download/latest/chordv-release.json", "https://api.github.com/repos/owner/repo/issues", "https://ghfast.top/https://127.0.0.1/private"} {
		if s.validateReleaseTextURL(address) == nil {
			t.Fatal("out-of-scope source accepted", address)
		}
	}
}

func TestNativeReleaseFloorPersistsAndRejectsReplayOrChangedSameBuild(t *testing.T) {
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	s := testService(t, "http://127.0.0.1:3100")
	s.cfg.ReleaseRepository = "owner/repo"
	s.cfg.ReleasePublicKey = base64.StdEncoding.EncodeToString(public)
	authorize := func(service *DesktopService, version string, build int64, suffix string) error {
		manifest := releaseManifest{SchemaVersion: 1, Tag: "v" + version, Version: version, Build: build, Channel: "stable", Installers: []releaseAsset{{Platform: platformName(), Architecture: architectureName(), FileName: "app.dmg", SHA256: strings.Repeat("a", 64), SizeBytes: 42}}}
		body, _ := json.Marshal(manifest)
		body = append(body, []byte(suffix)...)
		input, _ := json.Marshal(map[string]string{"manifest": string(body), "signature": base64.StdEncoding.EncodeToString(ed25519.Sign(private, body)), "tag": "v" + version})
		_, err := service.authorizeReleaseManifest(context.Background(), input)
		return err
	}
	if err := authorize(s, "1.3.0", 10, ""); err != nil {
		t.Fatal(err)
	}
	restarted := newDesktopService(s.cfg)
	defer restarted.cancel()
	if err := authorize(restarted, "1.2.9", 999, ""); err == nil {
		t.Fatal("older version accepted after restart")
	}
	if err := authorize(restarted, "1.3.0", 9, ""); err == nil {
		t.Fatal("older build accepted")
	}
	if err := authorize(restarted, "1.3.0", 10, "\n"); err == nil {
		t.Fatal("same version/build manifest replacement accepted")
	}
	if err := authorize(restarted, "1.3.0", 11, ""); err != nil {
		t.Fatal("newer build rejected", err)
	}
	if _, err := s.authorizedDownload("https://github.com/owner/repo/releases/download/v1.3.0/app.dmg", strings.Repeat("a", 64), 42); err == nil {
		t.Fatal("previously cached grant bypassed new floor")
	}
}

func TestNativeSemanticVersionOrdering(t *testing.T) {
	for _, pair := range [][2]string{{"1.9.0", "1.10.0"}, {"1.0.0-beta.9", "1.0.0-beta.10"}, {"1.0.0-beta.10", "1.0.0"}, {"1.0.0-1", "1.0.0-alpha"}, {"1.0.0-alpha", "1.0.0-alpha.1"}} {
		comparison, err := compareReleaseVersions(pair[0], pair[1])
		if err != nil || comparison >= 0 {
			t.Fatal(pair, comparison, err)
		}
	}
}

func TestNativeStrictSemverAndBuildMetadataMatchFrontend(t *testing.T) {
	for _, version := range []string{"1.0.0+build.1", "2.0.0-beta.9999999999999999999999999999999+arm64", "0.0.0", "1.0.0-0"} {
		if !releaseTagPattern.MatchString("v" + version) {
			t.Fatal("valid version rejected", version)
		}
	}
	for _, version := range []string{"01.0.0", "1.00.0", "1.0.01", "1.0.0-01", "1.0.0-beta..1", "1.0.0+", "1.0.0+build..1", "9007199254740992.0.0"} {
		if _, err := compareReleaseVersions(version, version); err == nil {
			t.Fatal("invalid version accepted", version)
		}
	}
	if comparison, err := compareReleaseVersions("1.0.0+build.1", "1.0.0+build.999"); err != nil || comparison != 0 {
		t.Fatal("metadata changed semantic precedence", comparison, err)
	}
	if comparison, err := compareReleaseVersions("1.0.0-beta.9999999999999999999999999999998", "1.0.0-beta.9999999999999999999999999999999"); err != nil || comparison >= 0 {
		t.Fatal("large prerelease numeric comparison wrong", comparison, err)
	}
}

func TestEncodedPlusTagAndFilenameMatchNativeAuthorization(t *testing.T) {
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	s := testService(t, "http://127.0.0.1:3100")
	s.cfg.ReleaseRepository = "owner/repo"
	s.cfg.ReleasePublicKey = base64.StdEncoding.EncodeToString(public)
	manifest := releaseManifest{SchemaVersion: 1, Tag: "v2.0.0+build.1", Version: "2.0.0+build.1", Build: 10, Channel: "stable", Installers: []releaseAsset{{Platform: platformName(), Architecture: architectureName(), FileName: "app+arm64.dmg", SHA256: strings.Repeat("A", 64), SizeBytes: 42}}}
	body, _ := json.Marshal(manifest)
	raw, _ := json.Marshal(map[string]string{"manifest": string(body), "signature": base64.StdEncoding.EncodeToString(ed25519.Sign(private, body)), "tag": manifest.Tag})
	if _, err := s.authorizeReleaseManifest(context.Background(), raw); err != nil {
		t.Fatal(err)
	}
	grant, err := s.authorizedDownload("https://github.com/owner/repo/releases/download/v2.0.0%2Bbuild.1/app%2Barm64.dmg", strings.Repeat("a", 64), 42)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.verifyGrantReceipt(grant); err != nil {
		t.Fatal("uppercase manifest checksum receipt rejected", err)
	}
}

func TestDesktopReleaseRepositoryConfiguration(t *testing.T) {
	for value, valid := range map[string]bool{"Team-1/.releases": true, "Team-1/Client": true, "bad_owner/releases": false, "owner/..": false, "": false} {
		if got := validRepository(value); got != valid {
			t.Errorf("repository %q: got %t, want %t", value, got, valid)
		}
	}
}
