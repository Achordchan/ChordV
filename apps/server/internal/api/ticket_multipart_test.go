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
	"time"
)

func ticketContractPNG(t *testing.T) []byte {
	t.Helper()
	var data bytes.Buffer
	if err := png.Encode(&data, image.NewRGBA(image.Rect(0, 0, 1, 1))); err != nil {
		t.Fatal(err)
	}
	return data.Bytes()
}
func ticketContractMultipart(a *testAPI, path, body string, file []byte, status int) Object {
	a.t.Helper()
	var data bytes.Buffer
	writer := multipart.NewWriter(&data)
	if body != "" {
		_ = writer.WriteField("body", body)
	}
	if file != nil {
		part, err := writer.CreateFormFile("file", "fixture.png")
		if err != nil {
			a.t.Fatal(err)
		}
		_, _ = part.Write(file)
	}
	_ = writer.Close()
	request, _ := http.NewRequest("POST", a.http.URL+path, &data)
	request.Header.Set("Authorization", "Bearer "+a.token)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response, err := a.http.Client().Do(request)
	if err != nil {
		a.t.Fatal(err)
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	if response.StatusCode != status {
		a.t.Fatalf("multipart %s HTTP%d want%d %s", path, response.StatusCode, status, raw)
	}
	var result Object
	if err = json.Unmarshal(raw, &result); err != nil {
		a.t.Fatal(err)
	}
	return result
}
func ticketContractFixture(t *testing.T, provider http.Handler) (*testAPI, string, string) {
	t.Helper()
	a := newTestAPI(t)
	imageServer := httptest.NewServer(provider)
	t.Cleanup(imageServer.Close)
	a.call("PATCH", "/api/admin/image-bed/config", Object{"baseUrl": imageServer.URL, "apiToken": "test-only-image-token"}, 200)
	user := a.createUser()
	adminToken := a.token
	a.token = a.loginUser(user)
	userToken := a.token
	ticket := a.call("POST", "/api/client/tickets", Object{"title": "合并图片回复契约", "body": "初始消息"}, 200)
	a.token = adminToken
	return a, text(ticket, "id"), userToken
}
func ticketContractMessageCount(a *testAPI, ticketID string) int {
	a.t.Helper()
	var count int
	if err := a.server.DB.QueryRow(context.Background(), `SELECT count(*) FROM "SupportTicketMessage" WHERE "ticketId"=$1`, ticketID).Scan(&count); err != nil {
		a.t.Fatal(err)
	}
	return count
}

func TestTicketMultipartAdminPreservesTextOnImageFailure(t *testing.T) {
	var uploads atomic.Int32
	a, ticketID, _ := ticketContractFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-only-image-token" || r.URL.Path != "/upload" {
			w.WriteHeader(400)
			return
		}
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		defer r.MultipartForm.RemoveAll()
		file, _, err := r.FormFile("file")
		if err != nil {
			t.Error(err)
			return
		}
		defer file.Close()
		if _, err = png.Decode(file); err != nil {
			t.Error(err)
			return
		}
		uploads.Add(1)
		w.WriteHeader(503)
	}))
	result := ticketContractMultipart(a, "/api/admin/tickets/"+ticketID+"/attachments", "管理员文字回复", ticketContractPNG(t), 200)
	if result["attachmentUploadStatus"] != "failed" || !strings.Contains(text(result, "attachmentUploadError"), "503") {
		t.Fatal("必须以已有DTO字段返回部分成功", result)
	}
	if result["id"] != ticketID || result["status"] != "waiting_user" || ticketContractMessageCount(a, ticketID) != 2 || uploads.Load() != 1 {
		t.Fatal("图床失败时文字未真实保存，或发生重复发送", result)
	}
	var saved string
	if err := a.server.DB.QueryRow(context.Background(), `SELECT body FROM "SupportTicketMessage" WHERE "ticketId"=$1 AND "authorRole"='admin'`, ticketID).Scan(&saved); err != nil {
		t.Fatal(err)
	}
	if saved != "管理员文字回复\n\n附件上传失败，文字回复已保存。请检查图床配置或稍后重试。" {
		t.Fatal("保存的文字/部分失败说明不符合旧契约", saved)
	}
	for _, table := range []string{"SupportTicketAttachment", "SupportTicketPendingAttachment"} {
		var count int
		if err := a.server.DB.QueryRow(context.Background(), `SELECT count(*) FROM `+quote(table)+` WHERE "ticketId"=$1`, ticketID).Scan(&count); err != nil || count != 0 {
			t.Fatal("图床失败不应伪造附件记录", table, count, err)
		}
	}
}

func TestTicketMultipartSuccessfulUploadsAndTextOnlyReply(t *testing.T) {
	var uploads atomic.Int32
	a, ticketID, _ := ticketContractFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		uploads.Add(1)
		writeJSON(w, 200, Object{"success": true, "url": "/file/contract/upload.png"})
	}))
	for _, content := range []string{"文字和图片", ""} {
		result := ticketContractMultipart(a, "/api/admin/tickets/"+ticketID+"/attachments", content, ticketContractPNG(t), 200)
		if result["attachmentUploadStatus"] != "uploaded" || result["attachmentUploadError"] != nil {
			t.Fatal("实际上传成功必须返回uploaded", result)
		}
	}
	textOnly := ticketContractMultipart(a, "/api/admin/tickets/"+ticketID+"/attachments", "仅文字", nil, 200)
	if textOnly["attachmentUploadStatus"] != "none" || uploads.Load() != 2 || ticketContractMessageCount(a, ticketID) != 4 {
		t.Fatal("纯文字合并请求不应调用图床或创建空消息", textOnly)
	}
	var attached, consumed, imageBody int
	if err := a.server.DB.QueryRow(context.Background(), `SELECT count(*) FROM "SupportTicketAttachment" WHERE "ticketId"=$1`, ticketID).Scan(&attached); err != nil {
		t.Fatal(err)
	}
	if err := a.server.DB.QueryRow(context.Background(), `SELECT count(*) FROM "SupportTicketPendingAttachment" WHERE "ticketId"=$1 AND consumed`, ticketID).Scan(&consumed); err != nil {
		t.Fatal(err)
	}
	if err := a.server.DB.QueryRow(context.Background(), `SELECT count(*) FROM "SupportTicketMessage" WHERE "ticketId"=$1 AND body='上传了附件：fixture.png'`, ticketID).Scan(&imageBody); err != nil {
		t.Fatal(err)
	}
	if attached != 2 || consumed != 2 || imageBody != 1 {
		t.Fatal("成功附件必须关联消息并消费上传令牌", attached, consumed, imageBody)
	}
}

func TestTicketMultipartDoesNotSaveEmptyInvalidOrTwoStepFailures(t *testing.T) {
	var uploads atomic.Int32
	a, ticketID, userToken := ticketContractFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		uploads.Add(1)
		w.WriteHeader(503)
	}))
	merged := "/api/admin/tickets/" + ticketID + "/attachments"
	ticketContractMultipart(a, merged, "", ticketContractPNG(t), 502)
	ticketContractMultipart(a, merged, "", nil, 400)
	ticketContractMultipart(a, merged, "非法图片不能部分成功", []byte("not-an-image"), 400)
	ticketContractMultipart(a, merged, "空图片不能部分成功", []byte{}, 400)
	ticketContractMultipart(a, merged, strings.Repeat("字", 4001), ticketContractPNG(t), 400)
	// 两步上传只返回凭据，不具有合并回复的部分成功语义。
	ticketContractMultipart(a, "/api/client/tickets/"+ticketID+"/attachments/upload", "非所属用户不能写入", ticketContractPNG(t), 404)
	a.token = userToken
	ticketContractMultipart(a, "/api/client/tickets/"+ticketID+"/attachments/upload", "不能保存此文字", ticketContractPNG(t), 502)
	if ticketContractMessageCount(a, ticketID) != 1 || uploads.Load() != 2 {
		t.Fatal("图片单独失败、非法输入或两步上传不能保存回复", uploads.Load())
	}
}

func TestTicketMultipartClientFailureAndMaximumBody(t *testing.T) {
	a, ticketID, token := ticketContractFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
	a.token = token
	content := strings.Repeat("字", 4000)
	result := ticketContractMultipart(a, "/api/client/tickets/"+ticketID+"/attachments", content, ticketContractPNG(t), 200)
	if result["attachmentUploadStatus"] != "failed" || result["status"] != "waiting_admin" || ticketContractMessageCount(a, ticketID) != 2 {
		t.Fatal("客户端合并请求也应保留有效文字", result)
	}
	var body string
	if err := a.server.DB.QueryRow(context.Background(), `SELECT body FROM "SupportTicketMessage" WHERE "ticketId"=$1 AND body LIKE $2`, ticketID, content+"%").Scan(&body); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(body, content+"\n\n") {
		t.Fatal("附加失败说明不能吞掉最大长度的有效文字")
	}
}

func TestTicketMultipartTimeoutPreservesTextButClosedTicketDoesNot(t *testing.T) {
	var uploads atomic.Int32
	a, ticketID, _ := ticketContractFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		uploads.Add(1)
		select {
		case <-r.Context().Done():
		case <-time.After(time.Second):
		}
	}))
	a.server.HTTP.Timeout = 40 * time.Millisecond
	result := ticketContractMultipart(a, "/api/admin/tickets/"+ticketID+"/attachments", "超时仍保存文字", ticketContractPNG(t), 200)
	if result["attachmentUploadStatus"] != "failed" || ticketContractMessageCount(a, ticketID) != 2 {
		t.Fatal("图床超时不应丢失合法文字", result)
	}
	a.call("POST", "/api/admin/tickets/"+ticketID+"/close", nil, 200)
	ticketContractMultipart(a, "/api/admin/tickets/"+ticketID+"/attachments", "关闭工单不能保存", ticketContractPNG(t), 409)
	if ticketContractMessageCount(a, ticketID) != 2 || uploads.Load() != 1 {
		t.Fatal("部分成功不能绕过工单关闭检查")
	}
}

func TestTicketMultipartProviderResponseAndConfigurationFailure(t *testing.T) {
	var mode atomic.Value
	mode.Store("invalid-json")
	var uploads atomic.Int32
	a, ticketID, _ := ticketContractFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		uploads.Add(1)
		switch mode.Load().(string) {
		case "invalid-json":
			_, _ = io.WriteString(w, "not-json")
		case "foreign-url":
			writeJSON(w, 200, Object{"success": true, "url": "https://not-local.invalid/file.png"})
		}
	}))
	for _, failure := range []string{"invalid-json", "foreign-url", "missing-token"} {
		mode.Store(failure)
		if failure == "missing-token" {
			a.call("PATCH", "/api/admin/image-bed/config", Object{"apiToken": ""}, 200)
		}
		result := ticketContractMultipart(a, "/api/admin/tickets/"+ticketID+"/attachments", "保留文字："+failure, ticketContractPNG(t), 200)
		if result["attachmentUploadStatus"] != "failed" || text(result, "attachmentUploadError") == "" {
			t.Fatal("图床响应或配置失败仍需返回部分成功及真实错误", result)
		}
	}
	if ticketContractMessageCount(a, ticketID) != 4 || uploads.Load() != 2 {
		t.Fatal("配置缺失不能发请求，已接受的文字必须全部保存", uploads.Load())
	}
}

func TestTicketMultipartFailureDoesNotPretendTextSavedAfterConcurrentClose(t *testing.T) {
	var api *testAPI
	var closingID string
	a, ticketID, _ := ticketContractFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := api.server.DB.Exec(context.Background(), `UPDATE "SupportTicket" SET status='closed',"closedAt"=now() WHERE id=$1`, closingID); err != nil {
			t.Error(err)
		}
		w.WriteHeader(503)
	}))
	api, closingID = a, ticketID
	ticketContractMultipart(a, "/api/admin/tickets/"+ticketID+"/attachments", "状态改变后不能伪造部分成功", ticketContractPNG(t), 409)
	if ticketContractMessageCount(a, ticketID) != 1 {
		t.Fatal("并发关闭不能被图床失败后的文字保存路径绕过")
	}
}
