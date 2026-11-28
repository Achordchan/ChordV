package api

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestLegacyUpdateHTTPBetaMinimumAndStableRequirements(t *testing.T) {
	for _, tc := range []struct {
		name, channel, minimum, current, requirement string
		force, hasUpdate, forced, blocked, byRelease bool
	}{
		{"beta_release_flag_ignored", "beta", "1.2.0", "1.1.12", "optional", true, true, false, false, false},
		{"beta_minimum_ignored", "beta", "1.2.0", "1.1.12", "optional", false, true, false, false, false},
		{"stable_minimum_required", "stable", "1.2.0", "1.1.12", "required_minimum", false, true, true, true, false},
		{"stable_release_required", "stable", "1.0.0", "1.1.12", "required_release", true, true, true, false, true},
		{"stable_optional_unchanged", "stable", "1.0.0", "1.1.12", "optional", false, true, false, false, false},
		{"newer_stable_not_downgraded", "stable", "1.0.0", "3.0.0", "optional", true, false, false, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := newTestAPI(t)
			public, private, err := ed25519.GenerateKey(rand.Reader)
			if err != nil {
				t.Fatal(err)
			}
			manifest := testManifest()
			manifest.Channel, manifest.MinimumVersion, manifest.ForceUpgrade = tc.channel, tc.minimum, tc.force
			if tc.channel == "beta" {
				manifest.Version, manifest.Tag = "2.0.0-beta.1", "v2.0.0-beta.1"
			}
			body, err := json.Marshal(manifest)
			if err != nil {
				t.Fatal(err)
			}
			signature := base64.StdEncoding.EncodeToString(ed25519.Sign(private, body))
			origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
					t.Error("GitHub清单读取不应携带业务凭据")
					w.WriteHeader(400)
					return
				}
				path := "/local-fixture/binaries/release-channels/" + tc.channel + ".json"
				if r.URL.Path == path {
					_, _ = w.Write(body)
				} else if r.URL.Path == path+".sig" {
					_, _ = w.Write([]byte(signature))
				} else {
					w.WriteHeader(404)
				}
			}))
			t.Cleanup(origin.Close)
			local, _ := url.Parse(origin.URL)
			transport := &http.Transport{Proxy: nil}
			t.Cleanup(transport.CloseIdleConnections)
			a.server.Config.GitHubRepository = "local-fixture/binaries"
			a.server.Config.GitHubPublicKey = base64.StdEncoding.EncodeToString(public)
			a.server.HTTP = &http.Client{Transport: releaseTransport(func(r *http.Request) (*http.Response, error) {
				if r.URL.Scheme != "https" || r.URL.Host != "raw.githubusercontent.com" {
					return nil, fail(502, "测试仅映射官方GitHub清单到回环HTTP")
				}
				cloned := r.Clone(r.Context())
				cloned.URL.Scheme, cloned.URL.Host, cloned.Host = local.Scheme, local.Host, local.Host
				return transport.RoundTrip(cloned)
			})}
			result := a.call("POST", "/api/client/update/check", Object{"platform": "windows", "architecture": "x64", "channel": tc.channel, "currentVersion": tc.current, "currentBuild": 1}, 200)
			minimum := tc.minimum
			if tc.channel == "beta" {
				minimum = "0.0.0"
			}
			expectedFields := Object{"hasUpdate": tc.hasUpdate, "forceUpgrade": tc.forced, "blockedByMinimumVersion": tc.blocked,
				"forcedByRelease": tc.byRelease, "minimumVersion": minimum, "updateRequirement": tc.requirement,
				"releaseChannel": tc.channel, "channel": tc.channel, "latestVersion": manifest.Version, "latestBuild": float64(manifest.Build)}
			for key, expected := range expectedFields {
				if result[key] != expected {
					t.Errorf("旧接口字段%s=%v，预期%v", key, result[key], expected)
				}
			}
			if tc.hasUpdate {
				artifact, ok := result["recommendedArtifact"].(map[string]any)
				if !ok || artifact["fileHash"] != strings.Repeat("a", 64) || artifact["fileSizeBytes"] != "1234" || !strings.Contains(text(artifact, "downloadUrl"), "/releases/download/"+manifest.Tag+"/") {
					t.Fatal("beta字段纠正不能改变原有资产Hash/长度/固定标签投影")
				}
			}
		})
	}
}
