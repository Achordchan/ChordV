package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"debug/buildinfo"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The opt-in input is a locally signature-verified production archive, never
// a DataDir sidecar. Ordinary tests keep the real-source unit fixture separate.
func TestAgentRealReleaseArchiveOnboardingHTTP(t *testing.T) {
	archive := os.Getenv("CHORDV_TEST_SERVER_RELEASE_ARCHIVE")
	if archive == "" {
		t.Skip("需要显式本地签名验证后的真实服务端归档")
	}
	a := newTestAPI(t)
	directory := t.TempDir()
	command := exec.Command("tar", "-xzf", archive, "-C", directory)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("解压已验证归档失败: %v %s", err, output)
	}
	raw, err := os.ReadFile(filepath.Join(directory, "build-info.json"))
	if err != nil {
		t.Fatal(err)
	}
	var metadata struct{ Version, Commit string }
	if err = json.Unmarshal(raw, &metadata); err != nil {
		t.Fatal(err)
	}
	info, err := buildinfo.ReadFile(filepath.Join(directory, "chordv-server"))
	if err != nil {
		t.Fatal(err)
	}
	source := &agentReleaseSource{directory: filepath.Join(directory, "agent-dist"), version: metadata.Version, commit: metadata.Commit}
	for _, setting := range info.Settings {
		if setting.Key != "-ldflags" {
			continue
		}
		prefix := "github.com/Achordchan/ChordV/apps/server/internal/buildinfo.AgentManifestSHA256="
		for _, flag := range strings.Fields(setting.Value) {
			if strings.HasPrefix(flag, prefix) {
				source.manifestSHA256 = strings.TrimPrefix(flag, prefix)
			}
		}
	}
	node := a.call("POST", "/api/admin/nodes/agent-native", Object{"name": "真实归档一键接入"}, 200)
	token := node["registerToken"]
	// Missing build assets must not consume the registration token.
	a.request("POST", "/api/agent-install/script.sh", Object{"token": token}, 503)
	var unused bool
	if err = a.server.DB.QueryRow(context.Background(), `SELECT "usedAt" IS NULL FROM "AgentRegisterToken" WHERE "nodeId"=$1`, node["node"].(map[string]any)["id"]).Scan(&unused); err != nil || !unused {
		t.Fatal("缺少发布资产时不应消费注册令牌", err)
	}
	a.server.agentRelease = source
	entries, err := os.ReadDir(a.server.Config.DataDir)
	if err != nil || len(entries) != 0 {
		t.Fatal("必须使用全新空DataDir", err)
	}
	script := a.request("POST", "/api/agent-install/script.sh", Object{"token": token}, 200)
	if bytes.Contains(script, []byte("@@")) || !bytes.Contains(script, []byte(source.version)) {
		t.Fatal("实际安装脚本未绑定归档版本")
	}
	syntax := exec.Command("bash", "-n")
	syntax.Stdin = bytes.NewReader(script)
	if output, err := syntax.CombinedOutput(); err != nil {
		t.Fatalf("脚本语法: %v %s", err, output)
	}
	manifestRaw, err := os.ReadFile(filepath.Join(source.directory, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest agentDistribution
	if err = json.Unmarshal(manifestRaw, &manifest); err != nil {
		t.Fatal(err)
	}
	for _, arch := range []string{"amd64", "arm64"} {
		actual := a.request("GET", "/api/agent-download/go/"+source.version+"/"+arch, nil, 200)
		expected, err := os.ReadFile(filepath.Join(source.directory, "chordv-agent-linux-"+arch))
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(actual)
		if !bytes.Equal(actual, expected) || hex.EncodeToString(sum[:]) != manifest.SHA256[arch] || !bytes.Contains(script, []byte(manifest.SHA256[arch])) {
			t.Fatal("HTTP下载/脚本/归档SHA不一致", arch)
		}
	}
	a.request("GET", "/api/agent-download/go/0.0.1/amd64", nil, 404)
	a.request("GET", "/api/agent-download/go/"+source.version+"/mips", nil, 400)
	if err = os.WriteFile(filepath.Join(source.directory, "chordv-agent-linux-arm64"), []byte("tampered"), 0600); err != nil {
		t.Fatal(err)
	}
	a.request("POST", "/api/agent-install/script.sh", Object{"token": token}, 503)
	a.request("GET", "/api/agent-download/go/"+source.version+"/arm64", nil, 503)
	t.Log("真实发布归档、全新DataDir、HTTP创建节点/脚本/双架构下载/篡改拒绝已验证；未执行宿主安装")
}
