package api

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Achordchan/ChordV/apps/server/internal/config"
)

type releaseTransport func(*http.Request) (*http.Response, error)

func (f releaseTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func testManifest() releaseManifest {
	m := releaseManifest{SchemaVersion: 1, Version: "2.0.0", Tag: "v2.0.0", Channel: "stable", Build: 42, MinimumVersion: "1.1.0", Title: "测试发布", Changelog: []string{"真实字段契约"}, PublishedAt: "2026-11-16T00:00:00Z"}
	m.Installers = []releaseAsset{{Platform: "windows", Architecture: "x64", FileName: "ChordV_2.0.0_windows_x64.exe", SHA256: strings.Repeat("a", 64), SizeBytes: 1234}}
	for _, kind := range []string{"xray", "geoip", "geosite"} {
		m.RuntimeComponents = append(m.RuntimeComponents, releaseComponent{releaseAsset: releaseAsset{Platform: "windows", Architecture: "x64", FileName: kind + ".dat", SHA256: strings.Repeat("b", 64), SizeBytes: 2345}, Component: kind, Version: "test-version", SourceFormat: "direct"})
	}
	return m
}
func signedReleaseServer(t *testing.T, m releaseManifest) (*Server, func(bool)) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	signature := []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(private, raw)))
	tampered := false
	s := New(nil, config.Config{GitHubRepository: "local-fixture/binaries", GitHubPublicKey: base64.StdEncoding.EncodeToString(public)})
	s.HTTP = &http.Client{Transport: releaseTransport(func(r *http.Request) (*http.Response, error) {
		if r.Header.Get("Authorization") != "" {
			t.Fatal("向发布源发送了凭据")
		}
		content := raw
		if strings.HasSuffix(r.URL.Path, ".sig") {
			content = signature
		} else if tampered {
			content = append(bytes.Clone(raw), ' ')
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(content)), Header: http.Header{}}, nil
	})}
	return s, func(value bool) { tampered = value }
}
func TestGitHubSignedManifestAndTamper(t *testing.T) {
	s, tamper := signedReleaseServer(t, testManifest())
	m, err := s.latestManifest(context.Background(), "stable")
	if err != nil {
		t.Fatal(err)
	}
	if m.Version != "2.0.0" || len(m.RuntimeComponents) != 3 {
		t.Fatal("清单字段没有正确解码")
	}
	tamper(true)
	if _, err = s.latestManifest(context.Background(), "stable"); err == nil {
		t.Fatal("重序列化或篡改后的清单通过了签名")
	}
}
func TestManifestRejectsMismatchedAndUnsafeAssets(t *testing.T) {
	for _, change := range []func(*releaseManifest){func(m *releaseManifest) { m.Tag = "v9.0.0" }, func(m *releaseManifest) { m.Channel = "beta" }, func(m *releaseManifest) { m.Installers[0].FileName = "../../payload.exe" }, func(m *releaseManifest) { m.Installers[0].SHA256 = "bad" }, func(m *releaseManifest) { m.Installers = append(m.Installers, m.Installers[0]) }, func(m *releaseManifest) {
		m.RuntimeComponents[0].SourceFormat = "zip_entry"
		m.RuntimeComponents[0].ArchiveEntryName = "../../xray"
	}} {
		m := testManifest()
		change(&m)
		if err := validateManifest(m, "stable"); err == nil {
			t.Fatal("无效或可穿越的发布清单被接受")
		}
	}
}
func TestSemverOrdering(t *testing.T) {
	for _, entry := range []struct {
		a, b string
		want int
	}{{"2.0.0", "1.99.99", 1}, {"2.0.0-beta.10", "2.0.0-beta.2", 1}, {"2.0.0-beta.1", "2.0.0", -1}, {"2.0.0+build1", "2.0.0+build2", 0}, {"1.0.0-alpha", "1.0.0-alpha.1", -1}} {
		result, err := compareVersion(entry.a, entry.b)
		if err != nil || result != entry.want {
			t.Errorf("compare %s %s=%d (%v)", entry.a, entry.b, result, err)
		}
	}
	for _, version := range []string{"1.2", "01.2.3", "1.2.3-beta.01", "v1.2.3", "1.2.3-"} {
		if _, err := parseVersion(version); err == nil {
			t.Errorf("接受了无效版本 %s", version)
		}
	}
}
func TestLegacyUpdateAndComponentProjection(t *testing.T) {
	s, _ := signedReleaseServer(t, testManifest())
	r, _ := http.NewRequest("POST", "http://127.0.0.1/api/client/update/check", strings.NewReader(`{"currentVersion":"1.1.12","platform":"windows","channel":"stable"}`))
	value, err := s.checkUpdate(nil, r, nil)
	if err != nil {
		t.Fatal(err)
	}
	result := value.(Object)
	artifact := result["recommendedArtifact"].(Object)
	if result["hasUpdate"] != true || artifact["fileHash"] != strings.Repeat("a", 64) || artifact["originDownloadUrl"] != "https://github.com/local-fixture/binaries/releases/download/v2.0.0/ChordV_2.0.0_windows_x64.exe" {
		t.Fatal("旧版更新投影不符合契约")
	}
	request, _ := http.NewRequest("GET", "http://127.0.0.1/api/client/runtime-components/plan?platform=windows&architecture=x64", nil)
	value, err = s.componentPlan(nil, request, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(value.(Object)["components"].([]Object)) != 3 {
		t.Fatal("旧组件计划不完整")
	}
	r, _ = http.NewRequest("POST", "http://127.0.0.1/api/client/update/check", strings.NewReader(`{"currentVersion":"3.0.0","platform":"windows","channel":"stable"}`))
	value, err = s.checkUpdate(nil, r, nil)
	if err != nil {
		t.Fatal(err)
	}
	if value.(Object)["hasUpdate"] != false {
		t.Fatal("允许了自动降级")
	}
}

func TestLegacyMacNeverGuessesInstallerArchitecture(t *testing.T) {
	manifest := testManifest()
	manifest.Installers = []releaseAsset{{Platform: "macos", Architecture: "arm64", FileName: "ChordV_2.0.0_macos_arm64.dmg", SHA256: strings.Repeat("a", 64), SizeBytes: 1234}, {Platform: "macos", Architecture: "x64", FileName: "ChordV_2.0.0_macos_x64.dmg", SHA256: strings.Repeat("b", 64), SizeBytes: 1234}}
	s, _ := signedReleaseServer(t, manifest)
	request, _ := http.NewRequest("POST", "http://127.0.0.1/api/client/update/check", strings.NewReader(`{"currentVersion":"1.1.12","platform":"macos","channel":"stable"}`))
	result, err := s.checkUpdate(nil, request, nil)
	if err != nil {
		t.Fatal(err)
	}
	update := result.(Object)
	if update["deliveryMode"] != "external_download" || update["downloadUrl"] != "https://github.com/local-fixture/binaries/releases/tag/v2.0.0" || update["fileHash"] != nil {
		t.Fatal("未报告架构的旧Mac不应自动选择arm64安装包")
	}
}

func TestClientVersionSelectsByArchitecture(t *testing.T) {
	m := testManifest()
	m.Installers = nil
	for _, platform := range []string{"macos", "windows"} {
		for _, arch := range []string{"arm64", "x64"} {
			m.Installers = append(m.Installers, releaseAsset{Platform: platform, Architecture: arch, FileName: platform + "-" + arch + ".pkg", SHA256: strings.Repeat("c", 64), SizeBytes: 42})
		}
	}
	s, _ := signedReleaseServer(t, m)
	const root = "https://github.com/local-fixture/binaries/releases/"
	for _, platform := range []string{"macos", "windows"} {
		for _, arch := range []string{"", "arm64", "x64", "other"} {
			t.Run(platform+"/"+arch, func(t *testing.T) {
				r, _ := http.NewRequest("GET", "http://127.0.0.1/api/client/version?platform="+platform+"&architecture="+arch, nil)
				result, err := s.clientVersion(nil, r, nil)
				if err != nil {
					t.Fatal(err)
				}
				var want any
				switch arch {
				case "":
					want = root + "tag/v2.0.0"
				case "x64", "arm64":
					want = root + "download/v2.0.0/" + platform + "-" + arch + ".pkg"
				}
				bootstrap, err := s.bootstrapVersion(r.Context(), platform, arch)
				if err != nil {
					t.Fatal(err)
				}
				for _, info := range []Object{result.(Object), bootstrap} {
					if got := info["downloadUrl"]; got != want || info["currentVersion"] != m.Version {
						t.Fatalf("version result = %v, want URL %v", info, want)
					}
				}
			})
		}
	}
}

func TestAuthenticatedBootstrapReportsMatchingInstaller(t *testing.T) {
	a := newTestAPI(t)
	user, plan := a.createUser(), a.createPlan("personal")
	a.call("POST", "/api/admin/subscriptions", Object{"userId": user["id"], "planId": plan["id"], "expireAt": time.Now().AddDate(0, 1, 0).UTC().Format(time.RFC3339)}, 200)
	manifest := testManifest()
	manifest.Installers = []releaseAsset{
		{Platform: "macos", Architecture: "arm64", FileName: "apple-silicon.dmg", SHA256: strings.Repeat("a", 64), SizeBytes: 42},
		{Platform: "macos", Architecture: "x64", FileName: "intel.dmg", SHA256: strings.Repeat("b", 64), SizeBytes: 42},
	}
	releases, _ := signedReleaseServer(t, manifest)
	t.Cleanup(releases.Close)
	a.server.HTTP, a.server.Config.GitHubRepository, a.server.Config.GitHubPublicKey = releases.HTTP, releases.Config.GitHubRepository, releases.Config.GitHubPublicKey
	a.token = ""
	const path = "/api/client/bootstrap?platform=macos"
	a.request("GET", path, nil, 401)
	login := a.call("POST", "/api/auth/login", Object{"email": user["email"], "password": "  exact-password  "}, 200)
	a.token = text(login, "accessToken")
	for _, tc := range []struct {
		suffix string
		want   any
	}{
		{"&architecture=x64", "https://github.com/local-fixture/binaries/releases/download/v2.0.0/intel.dmg"},
		{"&architecture=arm64", "https://github.com/local-fixture/binaries/releases/download/v2.0.0/apple-silicon.dmg"},
		{"", "https://github.com/local-fixture/binaries/releases/tag/v2.0.0"},
		{"&architecture=unknown", nil},
	} {
		got := a.call("GET", path+tc.suffix, nil, 200)
		version := got["version"].(map[string]any)
		if version["downloadUrl"] != tc.want || version["currentVersion"] != manifest.Version || got["user"].(map[string]any)["id"] != user["id"] {
			t.Fatalf("bootstrap%s: unexpected version or account: %v", tc.suffix, version)
		}
	}
}

func TestSignedReleaseVersionOrderingContract(t *testing.T) {
	for _, tc := range []struct {
		current, offered string
		wantUpdate       bool
	}{
		{"2.0.0-beta.99999999999999999999", "2.0.0-beta.100000000000000000000", true},
		{"2.0.0-beta.100000000000000000000", "2.0.0-beta.99999999999999999999", false},
		{"2.0.0-beta.18446744073709551616", "2.0.0-beta.0a", true},
	} {
		m := testManifest()
		m.Channel, m.Version, m.Tag = "beta", tc.offered, "v"+tc.offered
		s, _ := signedReleaseServer(t, m)
		t.Cleanup(s.Close)
		raw, _ := json.Marshal(Object{"currentVersion": tc.current, "channel": "beta", "platform": "windows", "architecture": "x64"})
		r, _ := http.NewRequest("POST", "http://127.0.0.1/api/client/update/check", bytes.NewReader(raw))
		out, err := s.checkUpdate(nil, r, nil)
		if err != nil || out.(Object)["hasUpdate"] != tc.wantUpdate {
			t.Errorf("current=%s offered=%s: expected hasUpdate=%v, error=%v", tc.current, tc.offered, tc.wantUpdate, err)
		}
	}
	m := testManifest()
	m.MinimumVersion = "2.0.1"
	s, _ := signedReleaseServer(t, m)
	t.Cleanup(s.Close)
	if _, err := s.latestManifest(context.Background(), "stable"); err == nil {
		t.Error("accepted a signed minimum version above the offered version")
	}
}
