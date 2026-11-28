package api

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestImageUploadConsumeExpiryAndFailedPersistenceCleanup(t *testing.T) {
	a := newTestAPI(t)
	previous, err := a.server.setting(context.Background(), "image-bed")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.server.saveSetting(context.Background(), "image-bed", previous) })
	support, err := a.server.setting(context.Background(), "achord-connect")
	if err != nil {
		t.Fatal(err)
	}
	if err = a.server.saveSetting(context.Background(), "achord-connect", Object{"enabled": false}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.server.saveSetting(context.Background(), "achord-connect", support) })
	user := a.createUser()
	var uploads, deletes atomic.Int32
	var deleteTicket atomic.Value
	deleteTicket.Store("")
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer local-image-token" {
			w.WriteHeader(401)
			return
		}
		if r.URL.Path == "/upload" {
			uploads.Add(1)
			if err := r.ParseMultipartForm(1 << 20); err != nil {
				w.WriteHeader(400)
				return
			}
			defer r.MultipartForm.RemoveAll()
			file, _, err := r.FormFile("file")
			if err != nil {
				w.WriteHeader(400)
				return
			}
			defer file.Close()
			if _, err = png.Decode(file); err != nil {
				w.WriteHeader(400)
				return
			}
			if id := deleteTicket.Load().(string); id != "" {
				_, _ = a.server.DB.Exec(context.Background(), `DELETE FROM "SupportTicket" WHERE id=$1`, id)
			}
			writeJSON(w, 200, Object{"success": true, "url": "/file/local/upload.png"})
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/manage/delete/") {
			deletes.Add(1)
			writeJSON(w, 200, Object{"success": true})
			return
		}
		w.WriteHeader(404)
	}))
	t.Cleanup(provider.Close)
	a.call("PATCH", "/api/admin/image-bed/config", Object{"baseUrl": provider.URL, "apiToken": "local-image-token"}, 200)
	a.token = a.loginUser(user)
	ticket := a.call("POST", "/api/client/tickets", Object{"title": "真实图床对接", "body": "附件集成测试"}, 200)
	ticketID := text(ticket, "id")
	t.Cleanup(func() {
		_, _ = a.server.DB.Exec(context.Background(), `DELETE FROM "SupportTicket" WHERE id=$1`, ticketID)
	})
	upload := func(id string, status int) Object {
		var payload, encoded bytes.Buffer
		_ = png.Encode(&encoded, image.NewRGBA(image.Rect(0, 0, 1, 1)))
		writer := multipart.NewWriter(&payload)
		part, _ := writer.CreateFormFile("file", "fixture.png")
		_, _ = part.Write(encoded.Bytes())
		_ = writer.Close()
		request, _ := http.NewRequest("POST", a.http.URL+"/api/client/tickets/"+id+"/attachments/upload", &payload)
		request.Header.Set("Authorization", "Bearer "+a.token)
		request.Header.Set("Content-Type", writer.FormDataContentType())
		response, err := a.http.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		raw, _ := io.ReadAll(response.Body)
		if response.StatusCode != status {
			t.Fatalf("上传HTTP%d want%d %s", response.StatusCode, status, raw)
		}
		var result Object
		_ = json.Unmarshal(raw, &result)
		return result
	}
	uploaded := upload(ticketID, 200)
	if text(uploaded, "uploadToken") == "" || uploaded["mimeType"] != "image/png" {
		t.Fatal("上传结果缺少真实附件信息", uploaded)
	}
	a.call("POST", "/api/client/tickets/"+ticketID+"/replies", Object{"body": "已上传", "attachment": uploaded}, 200)
	a.call("POST", "/api/client/tickets/"+ticketID+"/replies", Object{"body": "重复消费", "attachment": uploaded}, 409)
	expire := func(attachment Object) {
		tokenID := tokenHash(text(attachment, "uploadToken"))
		_, err := a.server.DB.Exec(context.Background(), `UPDATE "SupportTicketPendingAttachment" SET "expiresAt"=now()-interval '1 second' WHERE "tokenId"=$1`, tokenID)
		if err != nil {
			t.Fatal(err)
		}
		if err = a.server.expireAttachment(context.Background(), tokenID); err != nil {
			t.Fatal(err)
		}
	}
	expire(uploaded)
	if deletes.Load() != 0 {
		t.Fatal("已被工单消息引用的附件不应删除")
	}
	abandoned := upload(ticketID, 200)
	expire(abandoned)
	if deletes.Load() != 1 {
		t.Fatal("到期未消费附件没有删除远端文件")
	}
	deleteTicket.Store(ticketID)
	upload(ticketID, 409)
	if deletes.Load() != 2 {
		t.Fatal("上传后数据库写入失败没有立即清理孤儿文件")
	}
	if uploads.Load() != 3 {
		t.Fatal("上传次数不正确")
	}
}
