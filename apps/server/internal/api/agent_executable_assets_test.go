package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/Achordchan/ChordV/apps/server/internal/buildinfo"
	"github.com/Achordchan/ChordV/apps/server/internal/config"
)

// Run the stamped native test executable from the extracted release directory
// to exercise the production os.Executable resolver, with no private injection.
func TestAgentExecutableAssetsHTTP(t *testing.T) {
	if os.Getenv("CHORDV_TEST_EXECUTABLE_AGENT_PATH") != "1" {
		t.Skip("仅由真实归档离线验证脚本运行")
	}
	t.Chdir(t.TempDir())
	s := New(nil, config.Config{DataDir: t.TempDir()})
	t.Cleanup(s.Close)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		t.Fatal(err)
	}
	if s.agentRelease == nil || s.agentRelease.directory != filepath.Join(filepath.Dir(executable), "agent-dist") || s.agentRelease.manifestSHA256 != buildinfo.AgentManifestSHA256 {
		t.Fatal("必须由生产构造器从真实exe固定路径及内嵌信任锚，禁止测试注入")
	}
	h := httptest.NewServer(s.Handler())
	defer h.Close()
	release, root, err := s.loadAgentDistribution()
	if err != nil {
		t.Fatal(err)
	}
	root.Close()
	if release.Version != buildinfo.Version || release.Commit != buildinfo.Commit {
		t.Fatal("未绑定可执行文件版本")
	}
	for _, arch := range []string{"amd64", "arm64"} {
		response, err := h.Client().Get(h.URL + "/api/agent-download/go/" + release.Version + "/" + arch)
		if err != nil {
			t.Fatal(err)
		}
		contents, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(contents)
		if response.StatusCode != http.StatusOK || hex.EncodeToString(sum[:]) != release.SHA256[arch] {
			t.Fatal("真实exe目录HTTP下载校验失败", arch, response.StatusCode)
		}
	}
	entries, err := os.ReadDir(s.Config.DataDir)
	if err != nil || len(entries) != 0 {
		t.Fatal("DataDir不得参与Agent供给", err)
	}
	raw, _ := json.Marshal(release)
	t.Log("无路径注入，工作目录独立，双架构HTTP产物绑定当前exe内嵌信任锚", string(raw))
}
