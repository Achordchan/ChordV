package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestSupportConnectionTestsSavedCredentialsBeforeEnabling(t *testing.T) {
	a := newTestAPI(t)
	var launchCalls, unreadCalls atomic.Int32
	var invalidProfile atomic.Bool
	var provider *httptest.Server
	provider = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, secret, ok := r.BasicAuth()
		if !ok || id != "connection-client" || secret != "connection-secret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/launch-tickets") {
			launchCalls.Add(1)
			var input Object
			_ = json.NewDecoder(r.Body).Decode(&input)
			profile, _ := input["user"].(map[string]any)
			attributes, _ := profile["attributes"].(map[string]any)
			if profile["id"] != "chordv-connection-test" || profile["email"] != "" || len(attributes) != 10 {
				invalidProfile.Store(true)
			}
			for _, value := range attributes {
				if value != "连接测试" {
					invalidProfile.Store(true)
				}
			}
			writeJSON(w, 200, Object{"data": Object{"launchUrl": provider.URL + "/launch/test", "expiresAt": time.Now().Add(time.Minute).UTC().Format(time.RFC3339)}})
			return
		}
		unreadCalls.Add(1)
		if !strings.HasSuffix(r.URL.Path, "/contacts/chordv-connection-test/unread") {
			invalidProfile.Store(true)
		}
		writeJSON(w, 200, Object{"data": Object{"unreadCount": 0}})
	}))
	t.Cleanup(provider.Close)
	a.call("PUT", "/api/admin/support-integration", Object{"baseUrl": provider.URL, "clientId": "connection-client", "clientSecret": "connection-secret", "enabled": false}, 200)
	result := a.call("POST", "/api/admin/support-integration/test", Object{}, 200)
	if result["ok"] != true || launchCalls.Load() != 1 || unreadCalls.Load() != 1 || invalidProfile.Load() {
		t.Fatal("关闭客户入口仍应使用专用测试联系人校验已保存凭据及全部字段", result, launchCalls.Load(), unreadCalls.Load(), invalidProfile.Load())
	}
	config := a.call("GET", "/api/admin/support-integration", nil, 200)
	if config["enabled"] != false || config["hasWebhookSecret"] != false {
		t.Fatal("连接测试不能隐式启用入口或补造Webhook凭据", config)
	}
}

func TestSupportConnectionExplicitTestRechecksRejectedAttributes(t *testing.T) {
	a := newTestAPI(t)
	var accept atomic.Bool
	var attributesCalls, fallbackCalls atomic.Int32
	var provider *httptest.Server
	provider = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/launch-tickets") {
			writeJSON(w, 200, Object{"data": Object{"unreadCount": 0}})
			return
		}
		var input Object
		_ = json.NewDecoder(r.Body).Decode(&input)
		profile, _ := input["user"].(map[string]any)
		if profile["attributes"] != nil {
			attributesCalls.Add(1)
			if !accept.Load() {
				writeJSON(w, 422, Object{"code": "UNDECLARED_PROFILE_ATTRIBUTE"})
				return
			}
		} else {
			fallbackCalls.Add(1)
		}
		writeJSON(w, 200, Object{"data": Object{"launchUrl": provider.URL + "/launch/test", "expiresAt": time.Now().Add(time.Minute).UTC().Format(time.RFC3339)}})
	}))
	t.Cleanup(provider.Close)
	a.call("PUT", "/api/admin/support-integration", Object{"baseUrl": provider.URL, "clientId": "connection-client", "clientSecret": "connection-secret", "webhookSecret": "connection-webhook", "enabled": true}, 200)
	admin := a.token
	a.token = a.loginUser(a.createUser())
	a.call("POST", "/api/client/support/launch", Object{}, 200)
	a.call("POST", "/api/client/support/launch", Object{}, 200)
	if attributesCalls.Load() != 1 || fallbackCalls.Load() != 2 {
		t.Fatal("普通客户请求必须保留422负缓存", attributesCalls.Load(), fallbackCalls.Load())
	}
	a.token = admin
	rejected := a.call("POST", "/api/admin/support-integration/test", Object{}, 200)
	if rejected["ok"] != true || rejected["attributes"].(map[string]any)["ok"] != false || attributesCalls.Load() != 2 || fallbackCalls.Load() != 3 {
		t.Fatal("显式测试被拒后仍只做一次无字段重试，不能把字段能力伪报通过", rejected, attributesCalls.Load(), fallbackCalls.Load())
	}
	accept.Store(true)
	result := a.call("POST", "/api/admin/support-integration/test", Object{}, 200)
	attributes := result["attributes"].(map[string]any)
	if result["ok"] != true || attributes["ok"] != true || attributesCalls.Load() != 3 || fallbackCalls.Load() != 3 {
		t.Fatal("显式测试必须立即携带字段重验，不能复用普通客户负缓存", result, attributesCalls.Load(), fallbackCalls.Load())
	}
}

func TestSupportConnectionRejectsInvalidLaunchAndMissingCredentials(t *testing.T) {
	a := newTestAPI(t)
	missing := a.call("POST", "/api/admin/support-integration/test", Object{}, 200)
	if missing["ok"] != false || missing["unread"].(map[string]any)["message"] != "未测试" {
		t.Fatal("未保存凭据不得尝试测试连接", missing)
	}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/launch-tickets") {
			writeJSON(w, 200, Object{"data": Object{"launchUrl": "https://other-origin.invalid/ticket", "expiresAt": time.Now().Add(time.Minute).UTC().Format(time.RFC3339)}})
			return
		}
		writeJSON(w, 200, Object{"data": Object{"unreadCount": 0}})
	}))
	t.Cleanup(provider.Close)
	a.call("PUT", "/api/admin/support-integration", Object{"baseUrl": provider.URL, "clientId": "connection-client", "clientSecret": "connection-secret", "enabled": false}, 200)
	result := a.call("POST", "/api/admin/support-integration/test", Object{}, 200)
	if result["ok"] != false || result["launch"].(map[string]any)["ok"] != false || result["unread"].(map[string]any)["ok"] != true {
		t.Fatal("同一票据校验必须拒绝跨站打开地址，不能误报连接正常", result)
	}
}
