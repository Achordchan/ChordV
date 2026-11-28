package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func siteInstallerFixture(a *testAPI) Object {
	a.t.Helper()
	installAgentFixture(a.t, a.server)
	return a.call("POST", "/api/admin/nodes/agent-native", Object{"name": "主地址契约节点"}, 200)
}

func assertSiteDownstream(a *testAPI, token, origin string, status int) {
	a.t.Helper()
	config := a.call("GET", "/api/admin/support-integration", nil, status)
	if status == 200 && config["webhookUrl"] != origin+"/api/integrations/achord-connect/webhook" {
		a.t.Fatal("Webhook没有跟随已保存主地址", config["webhookUrl"])
	}
	raw, _ := json.Marshal(Object{"token": token})
	req, _ := http.NewRequest("POST", a.http.URL+"/api/agent-install/script.sh", bytes.NewReader(raw))
	req.Host = "untrusted.example.test"
	req.Header.Set("X-Forwarded-Host", "forwarded.example.test")
	req.Header.Set("X-Forwarded-Proto", "https")
	response, err := a.http.Client().Do(req)
	if err != nil {
		a.t.Fatal(err)
	}
	defer response.Body.Close()
	script, _ := io.ReadAll(response.Body)
	if response.StatusCode != status {
		a.t.Fatalf("安装脚本HTTP%d，期望%d", response.StatusCode, status)
	}
	if status == 200 && (!bytes.Contains(script, []byte("API_BASE="+shellLiteral(origin)+"\n")) || bytes.Contains(script, []byte("untrusted.example.test")) || bytes.Contains(script, []byte("forwarded.example.test"))) {
		a.t.Fatal("安装脚本主地址不一致或信任了请求Host")
	}
}

func restartTestAPI(a *testAPI) *testAPI {
	a.t.Helper()
	a.http.Close()
	a.server.Close()
	s := New(a.server.DB, a.server.Config)
	s.agentRelease = a.server.agentRelease
	a.t.Cleanup(s.Close)
	if err := s.Start(context.Background()); err != nil {
		a.t.Fatal(err)
	}
	h := httptest.NewServer(s.Handler())
	a.t.Cleanup(h.Close)
	return &testAPI{t: a.t, server: s, http: h, token: a.token, adminID: a.adminID}
}

func TestSiteAddressSaveControlsWebhookInstallerAndRestart(t *testing.T) {
	a := newTestAPI(t)
	node := siteInstallerFixture(a)
	token := text(node, "registerToken")
	initial := a.call("GET", "/api/admin/site-address", nil, 200)
	assertSiteDownstream(a, token, text(initial, "primaryOrigin"), 200)
	const primary = "http://127.0.0.1:34321"
	saved := a.call("PUT", "/api/admin/site-address", Object{"primaryOrigin": primary, "legacyOrigins": []string{"http://127.0.0.1:3100"}}, 200)
	if saved["primaryOrigin"] != primary || saved["updatedAt"] == nil {
		t.Fatal("主地址未保存")
	}
	if read := a.call("GET", "/api/client/site-address", nil, 200); read["primaryOrigin"] != primary {
		t.Fatal("客户端主地址与后台保存值不一致")
	}
	assertSiteDownstream(a, token, primary, 200)
	a = restartTestAPI(a)
	assertSiteDownstream(a, token, primary, 200)
	if read := a.call("GET", "/api/admin/site-address", nil, 200); read["primaryOrigin"] != primary {
		t.Fatal("新Server实例丢失数据库主地址")
	}
}

func TestSiteAddressReadFailureAndInvalidStoredOriginNeverFallback(t *testing.T) {
	a := newTestAPI(t)
	node := siteInstallerFixture(a)
	token := text(node, "registerToken")
	if _, err := a.server.DB.Exec(context.Background(), `ALTER TABLE "SystemSetting" RENAME TO "site_settings_unavailable"`); err != nil {
		t.Fatal(err)
	}
	a.request("GET", "/api/admin/site-address", nil, 500)
	assertSiteDownstream(a, token, "", 500)
	if _, err := a.server.DB.Exec(context.Background(), `ALTER TABLE "site_settings_unavailable" RENAME TO "SystemSetting"`); err != nil {
		t.Fatal(err)
	}
	if err := a.server.saveSetting(context.Background(), "site-address", Object{"primaryOrigin": "https://not-local.example.test", "legacyOrigins": []string{}}); err != nil {
		t.Fatal(err)
	}
	a.request("GET", "/api/admin/site-address", nil, 400)
	assertSiteDownstream(a, token, "", 400)
}

func TestSiteAddressProductionHTTPSAndLocalBoundary(t *testing.T) {
	a := newTestAPI(t)
	a.call("PUT", "/api/admin/site-address", Object{"primaryOrigin": "https://external.example.test", "legacyOrigins": []string{}}, 400)
	a.http.Close()
	a.server.Close()
	cfg := a.server.Config
	cfg.Mode = "production"
	cfg.PublicOrigin = "https://original.example.test"
	s := New(a.server.DB, cfg)
	t.Cleanup(s.Close)
	if err := s.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	h := httptest.NewServer(s.Handler())
	t.Cleanup(h.Close)
	a = &testAPI{t: t, server: s, http: h, token: a.token, adminID: a.adminID}
	node := siteInstallerFixture(a)
	assertSiteDownstream(a, text(node, "registerToken"), cfg.PublicOrigin, 200)
	for _, invalid := range []string{"http://remote.example.test", "http://127.0.0.1:34321", "https://user:pass@example.test", "https://example.test/path", "https://example.test?q=1", "https://example.test#fragment"} {
		a.call("PUT", "/api/admin/site-address", Object{"primaryOrigin": invalid, "legacyOrigins": []string{}}, 400)
	}
	a.call("PUT", "/api/admin/site-address", Object{"primaryOrigin": "https://new.example.test", "legacyOrigins": []string{cfg.PublicOrigin}}, 200)
	assertSiteDownstream(a, text(node, "registerToken"), "https://new.example.test", 200)
}
