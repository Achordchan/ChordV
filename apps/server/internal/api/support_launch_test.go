package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestSupportDiagnosticsRejectSensitiveFieldsAndBoundUTF16(t *testing.T) {
	context := supportContext(Object{"context": Object{"appVersion": "https://secret.example.test/token", "os": "macOS 15 arm64", "timezone": "Asia/Shanghai（UTC+8）", "connectionState": "error", "connectionErrorCode": "proxy_failed", "sessionId": "bad/path", "nodeHost": "192.0.2.1", "recentErrors": []any{Object{"code": "runtime_exited", "at": "2026-11-16T10:21:00Z"}}}})
	if context["appVersion"] != nil || context["sessionId"] != nil || context["nodeHost"] != nil || context["os"] != "macOS 15 arm64" || context["timezone"] != "Asia/Shanghai（UTC+8）" {
		t.Fatal("诊断白名单或敏感内容处理错误", context)
	}
	for _, value := range []string{"node.example.test", "192.0.2.8", "[2001:db8::1]", "/Users/me/secret", "C:\\secret\\file", "abcdefghijklmnopqrstuvwxyz1234567890"} {
		if sanitizeSupportText(value) != "" {
			t.Fatal("敏感值未被剔除", value)
		}
	}
	if truncateUnits("中😀文", 3) != "中😀" {
		t.Fatal("UTF16截断拆开了代理对")
	}
	if supportContext(Object{"context": Object{"components": strings.Repeat("x", 4097)}}) != nil {
		t.Fatal("超过4KiB的诊断信息未整体丢弃")
	}
}
func TestSupportLaunchAttribute422SuppressionAndTrustedPlan(t *testing.T) {
	a := newTestAPI(t)
	previous, err := a.server.setting(context.Background(), "achord-connect")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.server.saveSetting(context.Background(), "achord-connect", previous) })
	user := a.createUser()
	plan := a.createPlan("personal")
	a.call("POST", "/api/admin/subscriptions", Object{"userId": user["id"], "planId": plan["id"], "expireAt": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}, 200)
	var calls, attributesCalls atomic.Int32
	var provider *httptest.Server
	captured := make(chan Object, 1)
	provider = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/launch-tickets") {
			writeJSON(w, 200, Object{"data": Object{"unreadCount": 0}})
			return
		}
		calls.Add(1)
		var body Object
		_ = json.NewDecoder(r.Body).Decode(&body)
		profile, _ := body["user"].(map[string]any)
		if attributes, ok := profile["attributes"].(map[string]any); ok {
			attributesCalls.Add(1)
			select {
			case captured <- attributes:
			default:
			}
			writeJSON(w, 422, Object{"code": "UNDECLARED_PROFILE_ATTRIBUTE"})
			return
		}
		writeJSON(w, 200, Object{"data": Object{"launchUrl": provider.URL + "/launch/one-use", "expiresAt": time.Now().Add(time.Minute).UTC().Format(time.RFC3339)}})
	}))
	t.Cleanup(provider.Close)
	a.call("PUT", "/api/admin/support-integration", Object{"baseUrl": provider.URL, "clientId": "test-client", "clientSecret": "test-secret", "webhookSecret": "test-webhook", "enabled": true}, 200)
	admin := a.token
	a.token = a.loginUser(user)
	input := Object{"context": Object{"appVersion": "2.0.1", "connectionState": "connected", "connectionMode": "forged", "plan": "forged-plan"}}
	a.call("POST", "/api/client/support/launch", input, 200)
	a.call("POST", "/api/client/support/launch", input, 200)
	if calls.Load() != 3 || attributesCalls.Load() != 1 {
		t.Fatal("422仅应无资料重试一次，后续10分钟应抑制重复拒绝", calls.Load(), attributesCalls.Load())
	}
	attributes := <-captured
	if len(attributes) != 10 || !strings.Contains(text(attributes, "plan"), text(plan, "name")) || strings.Contains(text(attributes, "plan"), "forged") || text(attributes, "connection") != "已连接（后台没有对应的有效会话）" {
		t.Fatal("资料没有使用后台套餐和租约事实", attributes)
	}
	a.token = admin
	config := a.call("GET", "/api/admin/support-integration", nil, 200)
	state := config["contactAttributes"].(map[string]any)
	if state["status"] != "rejected" || state["code"] != "UNDECLARED_PROFILE_ATTRIBUTE" {
		t.Fatal("后台缺少真实字段拒绝诊断")
	}
}
func TestSupportLaunchDiscardsTicketAfterConnectionSwitch(t *testing.T) {
	a := newTestAPI(t)
	previous, err := a.server.setting(context.Background(), "achord-connect")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.server.saveSetting(context.Background(), "achord-connect", previous) })
	user := a.createUser()
	entered := make(chan struct{})
	release := make(chan struct{})
	var first, second *httptest.Server
	first = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/launch-tickets") {
			close(entered)
			<-release
		}
		writeJSON(w, 200, Object{"data": Object{"launchUrl": first.URL + "/old-ticket", "expiresAt": time.Now().Add(time.Minute).UTC().Format(time.RFC3339)}})
	}))
	t.Cleanup(first.Close)
	second = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, Object{"data": Object{"launchUrl": second.URL + "/new-ticket", "expiresAt": time.Now().Add(time.Minute).UTC().Format(time.RFC3339)}})
	}))
	t.Cleanup(second.Close)
	a.call("PUT", "/api/admin/support-integration", Object{"baseUrl": first.URL, "clientId": "first-client", "clientSecret": "test-secret", "webhookSecret": "test-webhook", "enabled": true}, 200)
	token := a.loginUser(user)
	result := make(chan Object, 1)
	failed := make(chan error, 1)
	go func() {
		v, e := concurrentJSON(a.http.Client(), a.http.URL, token, "/api/client/support/launch", Object{})
		if e != nil {
			failed <- e
		} else {
			result <- v
		}
	}()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("旧连接请求未到达本地服务")
	}
	a.call("PUT", "/api/admin/support-integration", Object{"baseUrl": second.URL, "clientId": "second-client", "webhookSecret": "second-connection-webhook"}, 200)
	close(release)
	select {
	case v := <-result:
		if v["launchUrl"] != second.URL+"/new-ticket" {
			t.Fatal("返回了切换前的旧票据", v)
		}
	case e := <-failed:
		t.Fatal(e)
	case <-time.After(3 * time.Second):
		t.Fatal("连接切换后未重新申请新票据")
	}
}
