package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Achordchan/ChordV/apps/server/internal/config"
)

func TestProductionOriginsProxyAndCookiesWithoutExternalRequests(t *testing.T) {
	s := New(nil, config.Config{Mode: "production", PublicOrigin: "https://api.example.test", OutboundOrigins: []string{"https://support.example.test"}, TrustedProxies: []string{"127.0.0.1/32", "10.0.0.0/8"}})
	defer s.Close()
	if v, err := s.integrationOrigin("https://support.example.test/"); err != nil || v != "https://support.example.test" {
		t.Fatal(v, err)
	}
	for _, raw := range []string{"http://support.example.test", "https://evil.example.test", "https://support.example.test@evil.example.test", "https://support.example.test/path"} {
		if _, err := s.integrationOrigin(raw); err == nil {
			t.Fatal("出站地址应被拒绝", raw)
		}
	}
	request := httptest.NewRequest("GET", "https://api.example.test/", nil)
	request.RemoteAddr = "127.0.0.1:51234"
	request.Header.Set("X-Forwarded-For", "198.51.100.42, 10.1.2.3")
	if s.requestIP(request) != "198.51.100.42" {
		t.Fatal("未按受信代理链还原来源")
	}
	request.RemoteAddr = "198.51.100.8:51234"
	if s.requestIP(request) != "198.51.100.8" {
		t.Fatal("未受信来源伪造了 XFF")
	}
	recorder := httptest.NewRecorder()
	s.setSessionCookie(recorder, Object{"refreshToken": "test-token", "refreshTokenExpiresAt": time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano)})
	cookie := recorder.Result().Cookies()[0]
	if !cookie.Secure || !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode {
		t.Fatal("生产 Cookie 未配置 Secure/HttpOnly/SameSite")
	}
	if s.defaultPublicOrigin() != "https://api.example.test" {
		t.Fatal("Webhook 公开 origin 不准确")
	}
	local := New(nil, config.Config{})
	defer local.Close()
	if _, err := local.integrationOrigin("https://support.example.test"); err == nil {
		t.Fatal("local 模式放行外部地址")
	}
	if !nodeHostAllowed("node.example.test", true) || nodeHostAllowed("node.example.test", false) || nodeHostAllowed("0.0.0.0", true) {
		t.Fatal("节点地址模式边界不正确")
	}
	if _, err := probeLocal(context.Background(), Object{"serverHost": "node.example.test", "serverPort": 443}); err == nil {
		t.Fatal("本地探测应在网络请求前被拒绝")
	}
}
