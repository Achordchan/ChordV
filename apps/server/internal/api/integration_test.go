package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func (a *testAPI) request(method, path string, input any, status int) []byte {
	a.t.Helper()
	var reader io.Reader
	if input != nil {
		raw, err := json.Marshal(input)
		if err != nil {
			a.t.Fatal(err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, a.http.URL+path, reader)
	if err != nil {
		a.t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if a.token != "" {
		req.Header.Set("Authorization", "Bearer "+a.token)
	}
	res, err := a.http.Client().Do(req)
	if err != nil {
		a.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		a.t.Fatal(err)
	}
	if res.StatusCode != status {
		a.t.Fatalf("%s %s status=%d want=%d body=%s", method, path, res.StatusCode, status, raw)
	}
	return raw
}
func (a *testAPI) call(method, path string, input any, status int) Object {
	a.t.Helper()
	raw := a.request(method, path, input, status)
	var v Object
	if err := json.Unmarshal(raw, &v); err != nil {
		a.t.Fatalf("%s JSON: %v", path, err)
	}
	return v
}
func (a *testAPI) array(path string) []Object {
	a.t.Helper()
	raw := a.request("GET", path, nil, 200)
	var v []Object
	if err := json.Unmarshal(raw, &v); err != nil {
		a.t.Fatalf("%s JSON: %v", path, err)
	}
	return v
}
func (a *testAPI) createUser() Object {
	user := a.call("POST", "/api/admin/users", Object{"email": "integration-" + newID() + "@local.test", "displayName": "集成测试用户", "password": "  exact-password  ", "role": "user"}, 200)
	a.t.Cleanup(func() {
		_, _ = a.server.DB.Exec(context.Background(), `DELETE FROM "SupportTicketPendingAttachment" WHERE "userId"=$1`, user["id"])
		_, _ = a.server.DB.Exec(context.Background(), `DELETE FROM "User" WHERE id=$1`, user["id"])
	})
	return user
}
func (a *testAPI) createPlan(scope string) Object {
	plan := a.call("POST", "/api/admin/plans", Object{"name": "集成测试套餐", "scope": scope, "totalTrafficGb": 10, "renewable": true, "maxConcurrentSessions": 3}, 200)
	a.t.Cleanup(func() { _, _ = a.server.DB.Exec(context.Background(), `DELETE FROM "Plan" WHERE id=$1`, plan["id"]) })
	return plan
}
func TestLocalBusinessHTTPIntegration(t *testing.T) {
	a := newTestAPI(t)
	a.call("GET", "/api/health", nil, 200)
	user := a.createUser()
	plan := a.createPlan("personal")
	if user["passwordHash"] != nil {
		t.Fatal("用户接口泄露密码哈希")
	}
	sub := a.call("POST", "/api/admin/subscriptions", Object{"userId": user["id"], "planId": plan["id"], "expireAt": time.Now().AddDate(0, 1, 0).UTC().Format(time.RFC3339)}, 200)
	if sub["state"] != "active" || sub["remainingTrafficGb"] != float64(10) {
		t.Fatal("订阅初始化不正确")
	}
	a.call("POST", "/api/admin/subscriptions", Object{"userId": user["id"], "planId": plan["id"], "expireAt": time.Now().AddDate(0, 1, 0).UTC().Format(time.RFC3339)}, 409)
	adminToken := a.token
	a.token = ""
	session := a.call("POST", "/api/auth/login", Object{"email": user["email"], "password": "  exact-password  "}, 200)
	a.token = text(session, "accessToken")
	a.call("GET", "/api/admin/users", nil, 403)
	bootstrap := a.call("GET", "/api/client/bootstrap", nil, 200)
	if bootstrap["subscription"].(map[string]any)["meteringStatus"] != "ok" {
		t.Fatal("计量状态不符合共享契约")
	}
	if len(a.array("/api/client/nodes")) != 0 {
		t.Fatal("不应返回未授权节点")
	}
	rule := a.call("POST", "/api/client/routing-rules", Object{"value": ".Example.COM", "action": "proxy"}, 200)
	if rule["value"] != "example.com" || rule["matchType"] != "domain" {
		t.Fatal("规则没有规范化")
	}
	a.call("POST", "/api/client/routing-rules", Object{"value": "example.com", "action": "proxy"}, 409)
	a.call("POST", "/api/client/routing-rules", Object{"value": 123, "action": "proxy"}, 400)
	a.call("POST", "/api/client/routing-rules", Object{"value": "https://example.com", "action": "proxy"}, 400)
	a.call("PATCH", "/api/client/routing-rules/"+text(rule, "id"), Object{"enabled": false}, 200)
	a.call("DELETE", "/api/client/routing-rules/"+text(rule, "id"), nil, 200)
	a.call("GET", "/api/client/ping", nil, 200)
	a.call("GET", "/api/client/support/status", nil, 200)
	a.call("GET", "/api/client/runtime", nil, 200)
	a.call("POST", "/api/client/update/check", Object{"currentVersion": "1.1.12", "platform": "windows", "channel": "stable"}, 503)
	rotated := a.call("POST", "/api/auth/refresh", Object{"refreshToken": session["refreshToken"]}, 200)
	a.call("GET", "/api/client/subscription", nil, 401)
	a.token = text(rotated, "accessToken")
	a.call("GET", "/api/client/subscription", nil, 200)
	a.call("POST", "/api/auth/refresh", Object{"refreshToken": session["refreshToken"]}, 401)
	a.token = adminToken
	a.call("GET", "/api/admin/dashboard", nil, 200)
	a.array("/api/admin/users")
	a.array("/api/admin/plans")
	a.array("/api/admin/subscriptions")
	a.array("/api/admin/teams")
	a.array("/api/admin/nodes")
	a.call("GET", "/api/admin/nodes/node-command-jobs", nil, 200)
	a.call("GET", "/api/admin/presence", nil, 200)
	a.call("GET", "/api/admin/support-integration", nil, 200)
	a.call("GET", "/api/admin/site-address", nil, 200)
	a.call("PUT", "/api/admin/site-address", Object{"primaryOrigin": "https://production.example", "legacyOrigins": []string{}}, 400)
	a.call("PATCH", "/api/admin/subscriptions/"+text(sub, "id"), Object{"usedTrafficGb": 12}, 200)
	exhausted := a.array("/api/admin/subscriptions")
	found := false
	for _, v := range exhausted {
		if v["id"] == sub["id"] {
			found = v["state"] == "exhausted"
		}
	}
	if !found {
		t.Fatal("流量耗尽未正确体现")
	}
	a.call("POST", "/api/admin/subscriptions/"+text(sub, "id")+"/reset-traffic", Object{}, 200)
	a.call("PATCH", "/api/admin/users/"+text(user, "id"), Object{"status": "disabled"}, 200)
	a.token = text(rotated, "accessToken")
	a.call("GET", "/api/client/subscription", nil, 401)
}
func TestSessionLogoutWithoutBody(t *testing.T) {
	a := newTestAPI(t)
	a.call("POST", "/api/auth/logout", nil, 200)
	a.call("GET", "/api/admin/users", nil, 401)
}
func TestCrossOriginDenied(t *testing.T) {
	a := newTestAPI(t)
	r, _ := http.NewRequest("GET", a.http.URL+"/api/health", nil)
	r.Header.Set("Origin", "https://production.example")
	response, err := a.http.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 403 {
		t.Fatal("允许了非本地来源")
	}
}
func TestStrictJSONBody(t *testing.T) {
	a := newTestAPI(t)
	for _, raw := range []string{"null", "[]", "{}garbage", "{}{}"} {
		r, _ := http.NewRequest("POST", a.http.URL+"/api/auth/login", strings.NewReader(raw))
		r.Header.Set("Content-Type", "application/json")
		response, err := a.http.Client().Do(r)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != 400 {
			t.Errorf("无效正文被接受: %s", raw)
		}
	}
}

func TestUserWithoutSubscriptionReceivesBusinessMessage(t *testing.T) {
	a := newTestAPI(t)
	user := a.createUser()
	a.token = ""
	session := a.call("POST", "/api/auth/login", Object{"email": user["email"], "password": "  exact-password  "}, 200)
	a.token = text(session, "accessToken")
	for _, path := range []string{"/api/client/bootstrap", "/api/client/subscription"} {
		result := a.call("GET", path, nil, 404)
		if result["message"] != "当前没有可用订阅" {
			t.Fatalf("%s缺少旧客户端识别的未开通提示", path)
		}
	}
	if nodes := a.array("/api/client/nodes"); len(nodes) != 0 {
		t.Fatal("未开通用户的节点应返回空列表")
	}
}
