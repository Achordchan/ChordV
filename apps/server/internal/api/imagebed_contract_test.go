package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

type imageProviderReply struct {
	body   string
	status int
}

func imageManagementFixture(t *testing.T) (*testAPI, func(any, int), string) {
	t.Helper()
	a := newTestAPI(t)
	token := "image-contract-" + newID()
	var reply atomic.Value
	reply.Store(imageProviderReply{`{}`, 200})
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.Header.Get("Authorization") != "Bearer "+token || !strings.HasPrefix(r.URL.Path, "/api/manage/") {
			w.WriteHeader(400)
			return
		}
		current := reply.Load().(imageProviderReply)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(current.status)
		_, _ = w.Write([]byte(current.body))
	}))
	t.Cleanup(provider.Close)
	a.call("PATCH", "/api/admin/image-bed/config", Object{"baseUrl": provider.URL, "apiToken": token}, 200)
	return a, func(value any, status int) {
		if raw, ok := value.([]byte); ok {
			reply.Store(imageProviderReply{string(raw), status})
			return
		}
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		reply.Store(imageProviderReply{string(raw), status})
	}, token
}

func TestImageBedDeleteManagementContract(t *testing.T) {
	a, respond, token := imageManagementFixture(t)
	const file = "e2e/image.png"
	for _, tc := range []struct {
		name    string
		payload any
		want    Object
	}{
		{"minimal_provider_success", Object{"success": true, "deletedCount": 1}, Object{"success": true, "fileId": file, "deleted": []any{}, "failed": []any{}}},
		{"filtered_arrays", Object{"success": true, "fileId": " provider-id ", "deleted": []any{file, 123}, "failed": []any{nil, false}}, Object{"success": true, "fileId": "provider-id", "deleted": []any{file}, "failed": []any{}}},
		{"deleted_without_success", Object{"deleted": []any{file}}, Object{"success": true, "fileId": file, "deleted": []any{file}, "failed": []any{}}},
		{"partial_failure", Object{"success": true, "deleted": []any{file}, "failed": []any{" authorization: Bearer sensitive-secret123\n token=other-secret123  ", 5}}, Object{"success": false, "fileId": file, "deleted": []any{file}, "failed": []any{"authorization: Bearer *** token=***"}}},
		{"business_failure_message", Object{"success": false, "message": "上游拒绝 token=" + token}, Object{"success": false, "fileId": file, "deleted": []any{}, "failed": []any{"上游拒绝 token=***"}}},
		{"business_failure_error", Object{"success": false, "error": " 请求失败 https://example.invalid/?api_token=hidden-secret&key=another-secret "}, Object{"success": false, "fileId": file, "deleted": []any{}, "failed": []any{"请求失败 https://example.invalid/?api_token=***&key=***"}}},
		{"business_failure_without_details", Object{"success": false}, Object{"success": false, "fileId": file, "deleted": []any{}, "failed": []any{file}}},
		{"malformed_optional_fields", Object{"success": "yes", "fileId": 123, "deleted": "bad", "failed": Object{}}, Object{"success": false, "fileId": file, "deleted": []any{}, "failed": []any{}}},
		{"empty_error_entries", Object{"success": false, "failed": []any{"", " \n\t"}}, Object{"success": false, "fileId": file, "deleted": []any{}, "failed": []any{file}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			respond(tc.payload, 200)
			actual := a.call("DELETE", "/api/admin/image-bed/files?path=e2e%2Fimage.png", nil, 200)
			if !reflect.DeepEqual(actual, tc.want) {
				t.Error("删除DTO未符合success/fileId/deleted/failed契约或错误脱敏要求")
			}
			raw, _ := json.Marshal(actual)
			if strings.Contains(string(raw), token) {
				t.Error("删除结果泄露图床凭据")
			}
		})
	}
}

func TestImageBedManagementInvalidResponseAndErrorRedaction(t *testing.T) {
	a, respond, token := imageManagementFixture(t)
	for _, payload := range []any{nil, []any{}, "not-an-object", 3, []byte(`{`), []byte("<html>token=" + token + "</html>")} {
		respond(payload, 200)
		a.call("DELETE", "/api/admin/image-bed/files?path=e2e%2Fimage.png", nil, 502)
		a.call("GET", "/api/admin/image-bed/files", nil, 502)
	}
	respond(Object{"success": false, "message": "Authorization: Bearer " + token}, 200)
	raw := a.request("GET", "/api/admin/image-bed/files", nil, 502)
	if strings.Contains(string(raw), token) {
		t.Fatal("列表业务失败暴露图床凭据")
	}
	respond(Object{"success": false, "message": "token=" + token, "failed": []any{token}}, 503)
	raw = a.request("DELETE", "/api/admin/image-bed/files?path=e2e%2Fimage.png", nil, 502)
	if strings.Contains(string(raw), token) {
		t.Fatal("HTTP失败暴露图床凭据")
	}
	respond(Object{"success": false, "failed": []any{"原始凭据 " + token + " " + strings.Repeat("长", 350)}}, 200)
	result := a.call("DELETE", "/api/admin/image-bed/files?path=e2e%2Fimage.png", nil, 200)
	failed, ok := result["failed"].([]any)
	if !ok || len(failed) != 1 {
		t.Fatal("失败详情必须规范成字符串数组")
	}
	detail, ok := failed[0].(string)
	if !ok || len([]rune(detail)) > 303 || strings.Contains(detail, token) || !strings.HasSuffix(detail, "...") {
		t.Fatal("失败详情未截断或泄漏凭据")
	}
}

func TestImageBedFileListManagementContract(t *testing.T) {
	a, respond, _ := imageManagementFixture(t)
	respond(Object{"files": []any{
		Object{"name": "e2e/a.png", "metadata": Object{"File-Mime": " image/png ", "File-Size": 1234, "TimeStamp": "2026-11-17T08:00:00+08:00", "Channel": " local "}},
		Object{"name": "short.png", "fullId": "e2e/b.png", "metadata": Object{"fileType": "image/png", "fileSize": "5678", "timestamp": "1794873600000", "channel": "alias"}},
		Object{"fileId": "e2e/c.png", "metadata": Object{"File-Size": Object{}, "TimeStamp": "invalid-date"}},
		Object{"path": "e2e/d.png"}, Object{"key": "e2e/e.png"},
		nil, Object{}, Object{"name": "../bad"},
	}, "directories": []any{"e2e", 7, nil}, "totalCount": "42", "returnedCount": "8", "indexLastUpdated": "2026-11-17T08:00:00+08:00"}, 200)
	result := a.call("GET", "/api/admin/image-bed/files", nil, 200)
	files, ok := result["files"].([]any)
	if !ok || len(files) != 5 {
		t.Fatalf("列表未保留合法文件ID别名并跳过非法项: count=%d", len(files))
	}
	for i, size := range []any{"1234", "5678", nil, nil, nil} {
		file := files[i].(map[string]any)
		if file["fileSizeBytes"] != size {
			t.Error("fileSizeBytes必须为字符串或null", i)
		}
		if !strings.Contains(text(file, "url"), "/file/e2e/") {
			t.Error("文件地址没有使用完整文件ID", i)
		}
	}
	first, second := files[0].(map[string]any), files[1].(map[string]any)
	if first["mimeType"] != "image/png" || first["channel"] != "local" || first["uploadedAt"] != "2026-11-17T00:00:00.000Z" || second["uploadedAt"] != "2026-11-17T00:00:00.000Z" || files[2].(map[string]any)["uploadedAt"] != nil {
		t.Error("列表时间、空值或metadata别名没有规范化")
	}
	if result["totalCount"] != float64(42) || result["returnedCount"] != float64(8) || result["indexLastUpdated"] != "2026-11-17T00:00:00.000Z" || !reflect.DeepEqual(result["directories"], []any{"e2e"}) {
		t.Error("列表计数、目录或索引时间没有符合旧DTO契约")
	}
	respond(Object{"files": []any{Object{"name": "e2e/default.png"}, nil}, "totalCount": "not-number", "returnedCount": nil, "indexLastUpdated": "invalid-date"}, 200)
	result = a.call("GET", "/api/admin/image-bed/files", nil, 200)
	if result["totalCount"] != float64(2) || result["returnedCount"] != float64(2) || result["indexLastUpdated"] != nil || !reflect.DeepEqual(result["directories"], []any{}) {
		t.Error("列表缺省计数应回退原始条目数；时间为null且目录为空数组")
	}
	respond(Object{"files": "invalid", "directories": Object{}, "totalCount": "Infinity", "returnedCount": "NaN"}, 200)
	result = a.call("GET", "/api/admin/image-bed/files", nil, 200)
	if result["totalCount"] != float64(0) || result["returnedCount"] != float64(0) || result["indexLastUpdated"] != nil || !reflect.DeepEqual(result["files"], []any{}) || !reflect.DeepEqual(result["directories"], []any{}) {
		t.Error("空列表或无效元数据未返回DTO安全默认值")
	}
}

func TestImageBedManagementForwardsQueriesAndUnicodeDirectoryDeletion(t *testing.T) {
	a := newTestAPI(t)
	token := "image-contract-" + newID()
	var listed, deleted atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(400)
			return
		}
		if r.URL.Path == "/api/manage/list" {
			listed.Add(1)
			for key, value := range map[string]string{"start": "2", "count": "3", "fileType": "image", "search": "截图", "dir": "e2e/目录", "recursive": "true"} {
				if r.URL.Query().Get(key) != value {
					t.Error("图床列表未转发查询参数", key)
				}
			}
			writeJSON(w, 200, Object{"files": []any{}, "totalCount": 0})
			return
		}
		if r.URL.Path == "/api/manage/delete/e2e/目录" && r.URL.Query().Get("folder") == "true" {
			deleted.Add(1)
			writeJSON(w, 200, Object{"success": true, "deletedCount": 2})
			return
		}
		w.WriteHeader(400)
	}))
	t.Cleanup(provider.Close)
	a.call("PATCH", "/api/admin/image-bed/config", Object{"baseUrl": provider.URL, "apiToken": token}, 200)
	a.call("GET", "/api/admin/image-bed/files?start=2&count=3&search=%E6%88%AA%E5%9B%BE&dir=e2e%2F%E7%9B%AE%E5%BD%95&recursive=true", nil, 200)
	result := a.call("DELETE", "/api/admin/image-bed/files?path=e2e%2F%E7%9B%AE%E5%BD%95&folder=true", nil, 200)
	if result["fileId"] != "e2e/目录" || !reflect.DeepEqual(result["deleted"], []any{}) || !reflect.DeepEqual(result["failed"], []any{}) || listed.Load() != 1 || deleted.Load() != 1 {
		t.Fatal("目录删除必须转发原始路径且返回稳定数组字段")
	}
}
