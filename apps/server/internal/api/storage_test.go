package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestStorageScansOnlyLocalManagedTreeAndProtectsFiles(t *testing.T) {
	a := newTestAPI(t)
	dir := a.server.Config.DataDir
	if err := os.MkdirAll(filepath.Join(dir, "agent-dist"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "tmp"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "agent-dist", "keep.bin"), []byte("protected-agent"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "tmp", "fresh.part"), []byte("temporary"), 0600); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "outside-secret")
	if err := os.WriteFile(outside, []byte("must-not-scan"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "tmp", "escape")); err != nil {
		t.Fatal(err)
	}
	if err := a.server.scanStorage(context.Background(), func(int, string) {}); err != nil {
		t.Fatal(err)
	}
	snapshot := a.call("GET", "/api/admin/storage", nil, 200)
	if snapshot["totalFiles"] != float64(2) {
		t.Fatal("扫描跟随符号链接或没有读取真实文件")
	}
	items := snapshot["items"].([]any)
	for _, raw := range items {
		item := raw.(map[string]any)
		if item["canCleanup"] == true {
			t.Fatal("新文件或Agent产物不能被清理")
		}
		a.call("POST", "/api/admin/storage/cleanup", Object{"ids": []string{text(item, "id")}}, 400)
	}
	if _, err := os.Stat(outside); err != nil {
		t.Fatal("符号链接外部文件被触碰")
	}
	if err := a.server.cleanLocalTemporary(context.Background(), "../outside-secret"); err == nil {
		t.Fatal("允许了非托管清理路径")
	}
	if err := a.server.cleanLocalTemporary(context.Background(), "tmp/fresh.part"); err == nil {
		t.Fatal("允许了24小时内的新文件清理")
	}
	past := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(filepath.Join(dir, "tmp", "fresh.part"), past, past); err != nil {
		t.Fatal(err)
	}
	if err := a.server.cleanLocalTemporary(context.Background(), "tmp/fresh.part"); err == nil {
		t.Fatal("只伪造mtime就绕过了ctime保护")
	}
}
func TestStorageScanUsesRealSSECompletion(t *testing.T) {
	a := newTestAPI(t)
	request, _ := http.NewRequest("POST", a.http.URL+"/api/admin/storage/scan", nil)
	request.Header.Set("Authorization", "Bearer "+a.token)
	response, err := a.http.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 || !bytes.Contains(raw, []byte(`"type":"complete"`)) {
		t.Fatalf("扫描没有通过SSE返回真实完成结果: %s", raw)
	}
	frames := bytes.Split(raw, []byte("\n\n"))
	for _, frame := range frames {
		if !bytes.HasPrefix(frame, []byte("data: ")) {
			continue
		}
		var event Object
		if json.Unmarshal(bytes.TrimPrefix(frame, []byte("data: ")), &event) != nil {
			t.Fatal("扫描事件JSON格式无效")
		}
		if event["type"] == "complete" {
			snapshot := event["snapshot"].(map[string]any)
			if snapshot["scannedAt"] == nil {
				t.Fatal("完成事件缺少真实扫描时间")
			}
		}
	}
}
