package api

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Achordchan/ChordV/apps/server/internal/config"
)

func TestGitHubLegacyReadOnlyHTTPAcceptsDocumentedKeyFormats(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	manifest := testManifest()
	raw, _ := json.Marshal(manifest)
	signature := base64.StdEncoding.EncodeToString(ed25519.Sign(private, raw))
	var tampered atomic.Bool
	var originRequests atomic.Int32
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		originRequests.Add(1)
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Error("只读发布源不应收到业务凭据")
			w.WriteHeader(400)
			return
		}
		switch r.URL.Path {
		case "/local-fixture/binaries/release-channels/stable.json", "/local-fixture/binaries/releases/download/v2.0.0/chordv-release.json":
			_, _ = w.Write(raw)
			if tampered.Load() {
				_, _ = w.Write([]byte(" "))
			}
		case "/local-fixture/binaries/release-channels/stable.json.sig", "/local-fixture/binaries/releases/download/v2.0.0/chordv-release.json.sig":
			_, _ = io.WriteString(w, signature)
		case "/repos/local-fixture/binaries/releases":
			writeJSON(w, 200, []Object{{"tag_name": manifest.Tag, "draft": false, "prerelease": false}})
		default:
			w.WriteHeader(404)
		}
	}))
	defer origin.Close()
	local, _ := url.Parse(origin.URL)
	transport := &http.Transport{Proxy: nil}
	defer transport.CloseIdleConnections()
	for _, key := range []struct{ name, value string }{
		{"raw32", base64.StdEncoding.EncodeToString(public)},
		{"spki_der", base64.StdEncoding.EncodeToString(der)},
		{"spki_pem", string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))},
	} {
		t.Run(key.name, func(t *testing.T) {
			s := New(nil, config.Config{GitHubRepository: "local-fixture/binaries", GitHubPublicKey: key.value})
			defer s.Close()
			s.HTTP = &http.Client{Transport: releaseTransport(func(r *http.Request) (*http.Response, error) {
				if r.URL.Scheme != "https" || (r.URL.Host != "raw.githubusercontent.com" && r.URL.Host != "github.com" && r.URL.Host != "api.github.com") {
					t.Error("测试只接受生产代码生成的GitHub官方地址")
					return nil, fail(502, "测试拒绝外部地址")
				}
				// Only this test transport maps official URLs to a loopback HTTP server.
				cloned := r.Clone(r.Context())
				cloned.URL.Scheme, cloned.URL.Host = local.Scheme, local.Host
				cloned.Host = local.Host
				return transport.RoundTrip(cloned)
			})}
			api := httptest.NewServer(s.Handler())
			defer api.Close()
			a := &testAPI{t: t, server: s, http: api}
			update := a.call("POST", "/api/client/update/check", Object{"currentVersion": "1.1.12", "platform": "windows", "architecture": "x64", "channel": "stable"}, 200)
			if update["hasUpdate"] != true || update["latestVersion"] != "2.0.0" || update["fileHash"] != manifest.Installers[0].SHA256 || update["fileSizeBytes"] != "1234" {
				t.Fatal("旧版更新检查没有保留版本/Hash/大小契约")
			}
			version := a.call("GET", "/api/client/version?platform=windows", nil, 200)
			matched := a.call("GET", "/api/client/version?platform=windows&architecture=x64", nil, 200)
			missing := a.call("GET", "/api/client/version?platform=windows&architecture=arm64", nil, 200)
			if version["downloadUrl"] != "https://github.com/local-fixture/binaries/releases/tag/v2.0.0" || matched["downloadUrl"] != update["downloadUrl"] || missing["downloadUrl"] != nil {
				t.Fatal("版本接口未按请求架构选择已签发布中的地址")
			}
			plan := a.call("GET", "/api/client/runtime-components/plan?platform=windows&architecture=x64", nil, 200)
			history := a.array("/api/client/releases/history?platform=windows&channel=stable")
			if version["currentVersion"] != "2.0.0" || len(plan["components"].([]any)) != 3 || len(history) != 1 || history[0]["version"] != "2.0.0" {
				t.Fatal("旧只读接口没有使用同一签名清单投影")
			}
			tampered.Store(true)
			a.call("POST", "/api/client/update/check", Object{"currentVersion": "1.1.12", "platform": "windows"}, 502)
			tampered.Store(false)
			before := originRequests.Load()
			a.request("GET", "/api/client/update/tauri?target=windows-x86_64&current_version=1.1.12", nil, 204)
			if originRequests.Load() != before {
				t.Fatal("Tauri过渡尚未配置时不应伪造或读取自动安装授权")
			}
		})
	}
}

func TestGitHubDERPublicKeyRejectsInvalidAndWrongAlgorithms(t *testing.T) {
	foreign, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&foreign.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{base64.StdEncoding.EncodeToString(der), base64.StdEncoding.EncodeToString([]byte("malformed DER")), "not-base64"} {
		if _, err := parsePublicKey(key); err == nil {
			t.Fatal("错误格式或非Ed25519的DER发布公钥被接受")
		}
	}
	if _, err := parsePublicKey(strings.Repeat(" ", 16)); err == nil {
		t.Fatal("空公钥被接受")
	}
}
