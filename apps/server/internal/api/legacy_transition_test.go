package api

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestProductionLegacyEndpointCannotBeUnlockedByAQueryOrManifestDeclaration(t *testing.T) {
	s := &Server{}
	server := httptest.NewServer(s.Handler())
	defer server.Close()
	for _, query := range []string{"currentVersion=1.1.12", "currentVersion=1.1.12&currentBuild=1&verified=true&legacyEnabled=true", "current_version=1.1.12&target=windows-x86_64"} {
		response, err := http.Get(server.URL + "/api/client/update/tauri?" + query)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil || response.StatusCode != 204 || len(body) != 0 {
			t.Fatal("生产过渡门禁必须真实HTTP204且不读任何发布源", err)
		}
	}
}

func TestLegacyProjectionUsesDistinctOldKeyBuildMetadataAndExactInstaller(t *testing.T) {
	s := &Server{}
	s.Config.GitHubRepository = "fixture/binaries"
	raw, err := os.ReadFile("assets/legacy-minisign-test.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct{ PublicKey, Signature string }
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	m := legacyContractManifest{releaseManifest: testManifest()}
	m.Version = "2.0.0"
	m.Build = 42
	m.LegacyTransitions = []legacyTransitionAsset{{releaseAsset: m.Installers[0], Format: "tauri-nsis-v1", Signature: fixture.Signature}}
	if !legacyEnvelope(fixture.Signature, fixture.PublicKey) || legacyEnvelope(fixture.Signature, legacyTauriPublicKey) {
		t.Fatal("测试key不可替代正式旧key")
	}
	for _, tc := range []struct {
		current string
		build   int
		version string
	}{{"1.1.12", 0, "2.0.0"}, {"1.1.12", 41, "2.0.0+42"}, {"2.0.0", 41, "2.0.0+42"}} {
		result := s.legacyProjection(m, tc.current, tc.build, fixture.PublicKey)
		if result == nil || result["version"] != tc.version || result["signature"] != fixture.Signature || result["fileSizeBytes"] != "1234" || result["fileHash"] != m.Installers[0].SHA256 {
			t.Fatal("旧协议投影丢失版本/大小/签名/Hash")
		}
		if result["url"] != "https://github.com/fixture/binaries/releases/download/v2.0.0/ChordV_2.0.0_windows_x64.exe" || result["originDownloadUrl"] != result["url"] {
			t.Fatal("投影不得引入GitHub以外的下载真相")
		}
	}
	for _, tc := range []struct {
		current string
		build   int
	}{{"2.0.0", 0}, {"2.0.0", 42}, {"3.0.0", 1}} {
		if s.legacyProjection(m, tc.current, tc.build, fixture.PublicKey) != nil {
			t.Fatal("没有更高版本/build不得自动更新")
		}
	}
	if s.legacyProjection(m, "1.1.12", 1, legacyTauriPublicKey) != nil {
		t.Fatal("生产固定key必须拒绝临时key")
	}
	m.LegacyTransitions[0].SHA256 = strings.Repeat("b", 64)
	if s.legacyProjection(m, "1.1.12", 1, fixture.PublicKey) != nil {
		t.Fatal("签名资产必须与GitHub完整installer一致")
	}
	decoded, _ := base64.StdEncoding.DecodeString(fixture.Signature)
	changed := base64.StdEncoding.EncodeToString([]byte(strings.Replace(string(decoded), "trusted comment: timestamp", "trusted comment: changedtimestamp", 1)))
	if legacyEnvelope(changed, fixture.PublicKey) || legacyEnvelope(base64.StdEncoding.EncodeToString(make([]byte, 64)), fixture.PublicKey) {
		t.Fatal("可信注释篡改/新Ed25519裸签名不能充当Minisign")
	}
}
