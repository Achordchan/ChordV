package api

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

func (a *testAPI) sendWebhook(secret string, event Object, status int) Object {
	a.t.Helper()
	raw, _ := json.Marshal(event)
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestamp + "."))
	mac.Write(raw)
	request, _ := http.NewRequest("POST", a.http.URL+"/api/integrations/achord-connect/webhook", bytes.NewReader(raw))
	request.Header.Set("X-Achord-Timestamp", timestamp)
	request.Header.Set("X-Achord-Event-Id", text(event, "id"))
	request.Header.Set("X-Achord-Signature", "v1="+hex.EncodeToString(mac.Sum(nil)))
	response, err := a.http.Client().Do(request)
	if err != nil {
		a.t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != status {
		a.t.Fatalf("Webhook status=%d want=%d %s", response.StatusCode, status, body)
	}
	var result Object
	_ = json.Unmarshal(body, &result)
	return result
}
func TestSupportWebhookOrderDedupSignatureAndResyncRace(t *testing.T) {
	a := newTestAPI(t)
	previous, err := a.server.setting(context.Background(), "achord-connect")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.server.saveSetting(context.Background(), "achord-connect", previous) })
	user := a.createUser()
	uid := text(user, "id")
	secret := "local-webhook-secret-123456"
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	var block atomic.Bool
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		username, password, ok := r.BasicAuth()
		if !ok || username != "local-client" || password != "local-client-secret" {
			w.WriteHeader(401)
			return
		}
		if r.URL.Path == "/api/v1/integrations/universal/contacts/"+uid+"/unread" && block.CompareAndSwap(true, false) {
			entered <- struct{}{}
			<-release
		}
		writeJSON(w, 200, Object{"data": Object{"unreadCount": 9}})
	}))
	t.Cleanup(provider.Close)
	cfgResult := a.call("PUT", "/api/admin/support-integration", Object{"baseUrl": provider.URL, "clientId": "local-client", "clientSecret": "local-client-secret", "webhookSecret": secret, "enabled": true}, 200)
	if cfgResult["clientSecret"] != nil || cfgResult["webhookSecret"] != nil || cfgResult["hasClientSecret"] != true {
		t.Fatal("工单配置泄露密钥或未记录凭据状态")
	}
	base := time.Now().UTC().Truncate(time.Second)
	event := func(id string, at time.Time, count int) Object {
		return Object{"id": id, "type": "request.unread.changed", "createdAt": at.Format(time.RFC3339Nano), "data": Object{"externalUserId": uid, "request": Object{"id": "request-1"}, "unreadCount": count, "contactUnreadCount": count}}
	}
	first := event(newID(), base, 3)
	a.sendWebhook("wrong-secret", first, 401)
	accepted := a.sendWebhook(secret, first, 200)
	if accepted["result"] != "accepted" {
		t.Fatal("Webhook未接受")
	}
	duplicate := a.sendWebhook(secret, first, 200)
	if duplicate["result"] != "duplicate" {
		t.Fatal("Webhook未去重")
	}
	a.sendWebhook(secret, event(newID(), base.Add(-time.Second), 99), 200)
	readCount := func() int {
		var n int
		if err := a.server.DB.QueryRow(context.Background(), `SELECT "unreadCount" FROM "SupportUnreadState" WHERE "userId"=$1`, uid).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if readCount() != 3 {
		t.Fatal("旧事件覆盖了较新的总数")
	}
	cfg, err := a.server.setting(context.Background(), "achord-connect")
	if err != nil {
		t.Fatal(err)
	}
	block.Store(true)
	done := make(chan error, 1)
	go func() { done <- a.server.resyncSupportUnread(context.Background(), uid, cfg) }()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("校准请求没有到达本地工单服务")
	}
	a.sendWebhook(secret, event(newID(), base.Add(time.Second), 5), 200)
	close(release)
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("查询期间到达Webhook后仍采用旧快照")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("校准请求未结束")
	}
	if readCount() != 5 {
		t.Fatal("查询快照覆盖了WebHook的新总数")
	}
	if err = a.server.resyncSupportUnread(context.Background(), uid, cfg); err != nil {
		t.Fatal(err)
	}
	if readCount() != 9 {
		t.Fatal("权威未读校准未生效")
	}
	a.call("PUT", "/api/admin/support-integration", Object{"enabled": false}, 200)
	adminToken := a.token
	a.token = ""
	session := a.call("POST", "/api/auth/login", Object{"email": user["email"], "password": "  exact-password  "}, 200)
	a.token = text(session, "accessToken")
	status := a.call("GET", "/api/client/support/status", nil, 200)
	if status["enabled"] != false || status["unreadCount"] != float64(0) {
		t.Fatal("停用后未读提醒未清零")
	}
	a.token = adminToken
}
func TestLegacyTicketWriteArchiveSwitch(t *testing.T) {
	a := newTestAPI(t)
	previous, err := a.server.setting(context.Background(), "achord-connect")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.server.saveSetting(context.Background(), "achord-connect", previous) })
	if err = a.server.saveSetting(context.Background(), "achord-connect", Object{"enabled": false}); err != nil {
		t.Fatal(err)
	}
	user := a.createUser()
	adminToken := a.token
	a.token = ""
	session := a.call("POST", "/api/auth/login", Object{"email": user["email"], "password": "  exact-password  "}, 200)
	a.token = text(session, "accessToken")
	ticket := a.call("POST", "/api/client/tickets", Object{"title": "真实数据库工单", "body": "初始消息"}, 200)
	ticketID := text(ticket, "id")
	if len(ticket["messages"].([]any)) != 1 {
		t.Fatal("新工单消息没有写入")
	}
	a.call("POST", "/api/client/tickets/"+ticketID+"/replies", Object{"body": "补充信息"}, 200)
	a.token = adminToken
	detail := a.call("POST", "/api/admin/tickets/"+ticketID+"/replies", Object{"body": "已收到"}, 200)
	if detail["status"] != "waiting_user" {
		t.Fatal("管理员回复后工单状态不正确")
	}
	a.call("POST", "/api/admin/tickets/"+ticketID+"/close", nil, 200)
	a.call("POST", "/api/admin/tickets/"+ticketID+"/replies", Object{"body": "关闭后拒绝"}, 409)
	if err = a.server.saveSetting(context.Background(), "achord-connect", Object{"enabled": true, "baseUrl": "http://127.0.0.1:39999", "clientId": "test-local", "clientSecret": "test-local-client", "webhookSecret": "test-local-webhook"}); err != nil {
		t.Fatal(err)
	}
	a.call("POST", "/api/admin/tickets/"+ticketID+"/reopen", nil, 410)
	a.token = text(session, "accessToken")
	a.call("POST", "/api/client/tickets/"+ticketID+"/replies", Object{"body": "旧工单只读"}, 410)
	a.call("GET", "/api/client/tickets/"+ticketID, nil, 200)
	var count int
	if err = a.server.DB.QueryRow(context.Background(), `SELECT count(*) FROM "SupportTicketMessage" WHERE "ticketId"=$1`, ticketID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 3 {
		t.Fatal(fmt.Sprintf("旧工单写入错误：%d", count))
	}
}
