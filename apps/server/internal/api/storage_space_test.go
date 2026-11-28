package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestStorageScanReportsActualAvailableDiskSpaceHTTP(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("当前生产Linux及本地macOS支持真实磁盘空间读取")
	}
	a := newTestAPI(t)
	if err := os.WriteFile(filepath.Join(a.server.Config.DataDir, "protected-space-proof"), []byte("test-only"), 0600); err != nil {
		t.Fatal(err)
	}
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
	if response.StatusCode != 200 {
		t.Fatal(response.StatusCode, string(raw))
	}
	var complete Object
	for _, frame := range bytes.Split(raw, []byte("\n\n")) {
		if !bytes.HasPrefix(frame, []byte("data: ")) {
			continue
		}
		var event Object
		if err := json.Unmarshal(bytes.TrimPrefix(frame, []byte("data: ")), &event); err != nil {
			t.Fatal(err)
		}
		if event["type"] == "complete" {
			complete = event["snapshot"].(map[string]any)
		}
	}
	if complete == nil {
		t.Fatal("missing SSE completion")
	}
	free, ok := complete["diskFreeBytes"].(float64)
	if !ok || free < 0 {
		t.Fatalf("Go scan lost old actual disk-space field: %v", complete["diskFreeBytes"])
	}
	listed := a.call("GET", "/api/admin/storage", nil, 200)
	if listed["diskFreeBytes"] != free {
		t.Fatal("SSE/list returned different persisted space snapshots", listed["diskFreeBytes"], free)
	}
	state, err := a.server.storageState(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	stored := state["snapshot"].(map[string]any)
	if stored["diskFreeBytes"] != free {
		t.Fatal("available space not persisted with the completed scan")
	}
	t.Logf("completed SSE/list/persisted snapshot all contain actual free bytes %.0f", free)
}

func TestStorageAvailableByteArithmeticIsExact(t *testing.T) {
	for _, item := range []struct {
		blocks, blockSize, want uint64
		invalid                 bool
	}{
		{0, 4096, 0, false}, {123, 4096, 503808, false}, {1<<53 - 1, 1, 1<<53 - 1, false},
		{1, 0, 0, true}, {1 << 53, 1, 0, true}, {1 << 63, 4096, 0, true},
	} {
		actual, err := checkedStorageAvailableBytes(item.blocks, item.blockSize)
		if item.invalid {
			if err == nil {
				t.Fatal("invalid capacity accepted", item)
			}
			continue
		}
		if err != nil || actual != item.want {
			t.Fatal("incorrect capacity", item, actual, err)
		}
	}
}
