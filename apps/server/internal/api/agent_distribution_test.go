package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestAgentArtifactsAreHashCheckedAndInstallerIsSyntaxChecked(t *testing.T) {
	a := newTestAPI(t)
	source := installAgentFixture(t, a.server)
	dir := source.directory
	node := a.call("POST", "/api/admin/nodes/agent-native", Object{"name": "安装脚本测试节点"}, 200)
	t.Cleanup(func() {
		record := node["node"].(map[string]any)
		_, _ = a.server.DB.Exec(context.Background(), `DELETE FROM "Node" WHERE id=$1`, record["id"])
	})
	requestBody, _ := json.Marshal(Object{"token": node["registerToken"]})
	request, _ := http.NewRequest("POST", a.http.URL+"/api/agent-install/script.sh", bytes.NewReader(requestBody))
	response, err := a.http.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	script, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || bytes.Contains(script, []byte("@@")) {
		t.Fatal("安装脚本没有完整渲染")
	}
	command := exec.Command("bash", "-n")
	command.Stdin = bytes.NewReader(script)
	if result, err := command.CombinedOutput(); err != nil {
		t.Fatalf("只检查Bash语法失败: %s", result)
	}
	download := a.request("GET", "/api/agent-download/go/2.0.0-beta.1/amd64", nil, 200)
	if !bytes.Equal(download, agentFixtureFiles["chordv-agent-linux-amd64"]) {
		t.Fatal("下载内容与已校验文件不一致")
	}
	if err := os.WriteFile(filepath.Join(dir, "chordv-agent-linux-amd64"), []byte("tampered"), 0600); err != nil {
		t.Fatal(err)
	}
	a.request("GET", "/api/agent-download/go/2.0.0-beta.1/amd64", nil, 503)
}
