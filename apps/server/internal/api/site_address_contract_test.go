package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/Achordchan/ChordV/apps/server/internal/config"
)

func newSiteContractAPI(t *testing.T, production bool) *testAPI {
	t.Helper()
	a := newTestAPI(t)
	if !production {
		return a
	}
	a.http.Close()
	a.server.Close()
	cfg := a.server.Config
	cfg.Mode = "production"
	cfg.PublicOrigin = " HTTPS://CONFIGURED.Example:443/ "
	cfg.AllowedOrigins = []string{"https://approved-origin.example"}
	cfg.OutboundOrigins = []string{"https://credential-allowed.example"}
	s := New(a.server.DB, cfg)
	t.Cleanup(s.Close)
	if err := s.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	h := httptest.NewServer(s.Handler())
	t.Cleanup(h.Close)
	return &testAPI{t: t, server: s, http: h, token: a.token, adminID: a.adminID}
}

func siteContractLegacy(t *testing.T, raw any) []string {
	t.Helper()
	values, ok := raw.([]any)
	if !ok {
		t.Fatalf("legacyOrigins必须是数组：%T", raw)
	}
	out := []string{}
	for _, value := range values {
		s, ok := value.(string)
		if !ok {
			t.Fatal("legacyOrigins包含非字符串")
		}
		out = append(out, s)
	}
	return out
}

func TestSiteAddressCanonicalSaveAndPrimaryRemovalHTTP(t *testing.T) {
	a := newSiteContractAPI(t, true)
	longOrigin := "https://" + strings.Join([]string{strings.Repeat("a", 40), strings.Repeat("b", 40), strings.Repeat("c", 40), "test"}, ".")
	cases := []struct {
		name, primary, want string
		legacy, aliases     []string
	}{
		{"numeric_public_ipv4", "https://0x08080808:443/", "https://8.8.8.8", []string{"https://010.010.010.010", "https://134744072", "https://8.8.2056", "https://8.8.8.8."}, []string{}},
		{"mapped_ipv6", "https://[::FFFF:192.0.2.1]:443", "https://[::ffff:c000:201]", []string{}, []string{}},
		{"browser_idna_options", "https://ＥＸＡＭＰＬＥ。ＴＥＳＴ", "https://example.test", []string{"https://foo_bar.example", "https://-a.example", "https://💩.la", "https://e\u0301.test"}, []string{"https://foo_bar.example", "https://-a.example", "https://xn--ls8h.la", "https://xn--9ca.test"}},
		{"percent_hostname", "https://%65xample.test/", "https://example.test", []string{}, []string{}},
		{"raw_unicode_2048", strings.Repeat("\u3000", 2048-len("https://limit.example")) + "https://limit.example", "https://limit.example", []string{strings.Repeat("\u3000", 2048-len("https://old.example")) + "https://old.example"}, []string{"https://old.example"}},
		{"ecma_bom", "\ufeffHTTPS://NEW.example:443/\ufeff", "https://new.example", []string{}, []string{}},
		{"case_default_port", " HTTPS://NEW.Example:443/ ", "https://new.example", []string{"https://OLD.example/", "https://old.example:443", "https://new.example/", "https://NEW.EXAMPLE:443/"}, []string{"https://old.example"}},
		{"exact_duplicate", "https://new.example", "https://new.example", []string{"https://old.example", "https://old.example"}, []string{"https://old.example"}},
		{"numeric_nondefault_port", "https://EXAMPLE.test:08443/", "https://example.test:8443", []string{}, []string{}},
		{"idna", "https://例子.测试/", "https://xn--fsqu00a.xn--0zwm56d", []string{"https://XN--FSQU00A.XN--0ZWM56D:443", "https://faß.de", "https://xn--fa-hia.de/"}, []string{"https://xn--fa-hia.de"}},
		{"ipv6", "https://[2001:0DB8:0000:0000:0000:0000:0000:0001]:443/", "https://[2001:db8::1]", []string{"https://[2001:db8::1]", "https://[2001:db8::2]:08443"}, []string{"https://[2001:db8::2]:8443"}},
		{"legacy_over_128", "https://new.example", "https://new.example", []string{longOrigin}, []string{longOrigin}},
		{"primary_exact_removed", "https://new.example", "https://new.example", []string{"https://new.example"}, []string{}},
	}
	for _, entry := range cases {
		t.Run(entry.name, func(t *testing.T) {
			copy := *a
			copy.t = t
			a := &copy
			saved := a.call("PUT", "/api/admin/site-address", Object{"primaryOrigin": entry.primary, "legacyOrigins": entry.legacy}, 200)
			if saved["primaryOrigin"] != entry.want || !reflect.DeepEqual(siteContractLegacy(t, saved["legacyOrigins"]), entry.aliases) || saved["updatedAt"] == nil || len(saved) != 3 {
				t.Error("保存必须规范化主域/历史项，稳定去重并从历史项剔除主域", saved, entry.want, entry.aliases)
			}
			stored, err := one(context.Background(), a.server.DB, `SELECT value FROM "SystemSetting" WHERE key='site-address'`)
			if err != nil || stored["primaryOrigin"] != entry.want || !reflect.DeepEqual(siteContractLegacy(t, stored["legacyOrigins"]), entry.aliases) || len(stored) != 2 {
				t.Error("实际持久化必须只有规范化配置，updatedAt来自数据库列", stored, err)
			}
			for _, path := range []string{"/api/admin/site-address", "/api/client/site-address"} {
				read := a.call("GET", path, nil, 200)
				if !reflect.DeepEqual(saved, read) {
					t.Error("两个GET必须与保存响应一致", path, read, saved)
				}
			}
		})
	}
}

func TestSiteAddressRawDTO2048AndCardinalityRejectWithoutWritesHTTP(t *testing.T) {
	a := newSiteContractAPI(t, true)
	a.call("PUT", "/api/admin/site-address", Object{"primaryOrigin": "https://known.example", "legacyOrigins": []string{}}, 200)
	aliases := []string{}
	for range 11 {
		aliases = append(aliases, "https://old.example")
	}
	cases := []Object{
		{"primaryOrigin": strings.Repeat(" ", 2049) + "https://new.example", "legacyOrigins": []string{}},
		{"primaryOrigin": "https://new.example", "legacyOrigins": []string{strings.Repeat(" ", 2049) + "https://old.example"}},
		{"primaryOrigin": "https://new.example", "legacyOrigins": aliases},
		{"primaryOrigin": "https://new.example"},
		{"primaryOrigin": "https://new.example", "legacyOrigins": nil},
		{"primaryOrigin": 12, "legacyOrigins": []string{}},
		{"primaryOrigin": "https://new.example", "legacyOrigins": []any{1}},
		{"primaryOrigin": "https://xn--example-.com", "legacyOrigins": []string{}},
		{"primaryOrigin": "https://1..2", "legacyOrigins": []string{}},
		{"primaryOrigin": "https://%2fexample.test", "legacyOrigins": []string{}},
		{"primaryOrigin": "https://example.test%3a443", "legacyOrigins": []string{}},
		{"primaryOrigin": "https://a\u200db.test", "legacyOrigins": []string{}},
	}
	for i, input := range cases {
		t.Run(string(rune('a'+i)), func(t *testing.T) {
			copy := *a
			copy.t = t
			a := &copy
			before := policySchemaDigest(t, a)
			a.request("PUT", "/api/admin/site-address", input, 400)
			if !reflect.DeepEqual(before, policySchemaDigest(t, a)) {
				t.Error("无效DTO不得写入任何私有表")
			}
		})
	}
}

func TestSiteAddressCanonicalReadIsPureAndBadStoredValueFailsClosedHTTP(t *testing.T) {
	a := newSiteContractAPI(t, true)
	if err := a.server.saveSetting(context.Background(), "site-address", Object{"primaryOrigin": "https://NEW.example:443/", "legacyOrigins": []string{"https://old.example/", "https://OLD.example:443", "https://new.example"}}); err != nil {
		t.Fatal(err)
	}
	before := policySchemaDigest(t, a)
	for _, path := range []string{"/api/admin/site-address", "/api/client/site-address"} {
		value := a.call("GET", path, nil, 200)
		if value["primaryOrigin"] != "https://new.example" || !reflect.DeepEqual(siteContractLegacy(t, value["legacyOrigins"]), []string{"https://old.example"}) {
			t.Error("合法存量读取也须返回同一规范结果", value)
		}
	}
	if !reflect.DeepEqual(before, policySchemaDigest(t, a)) {
		t.Error("GET不得隐式迁移或更新数据库")
	}
	for _, bad := range []Object{
		{"primaryOrigin": "https://valid.example", "legacyOrigins": []string{"https://user:pass@old.example"}},
		{"primaryOrigin": "https://valid.example", "legacyOrigins": []any{false}},
		{"primaryOrigin": "https://valid.example", "legacyOrigins": []string{"https://xn--example-.com"}},
		{"primaryOrigin": "http://remote.example", "legacyOrigins": []string{}},
	} {
		if err := a.server.saveSetting(context.Background(), "site-address", bad); err != nil {
			t.Fatal(err)
		}
		a.request("GET", "/api/admin/site-address", nil, 400)
		a.request("GET", "/api/client/site-address", nil, 400)
	}
}

func TestSiteAddressDefaultLocalBoundaryAndCredentialPolicyUnchangedHTTP(t *testing.T) {
	a := newSiteContractAPI(t, true)
	initial := a.call("GET", "/api/client/site-address", nil, 200)
	if initial["primaryOrigin"] != "https://configured.example" || initial["updatedAt"] != nil || len(siteContractLegacy(t, initial["legacyOrigins"])) != 0 {
		t.Error("默认主域也规范化，但不恢复旧硬编码历史域", initial)
	}
	global, err := config.HTTPSOrigin("https://CREDENTIAL-ALLOWED.example:443/")
	if err != nil || global != "https://CREDENTIAL-ALLOWED.example:443" {
		t.Fatal("站点修复不得改全局HTTPSOrigin", global, err)
	}
	_, err = a.server.integrationOrigin("https://CREDENTIAL-ALLOWED.example:443/")
	leaseWantHTTPError(t, err, 403)
	for _, invalid := range []string{"http://remote.example", "https://127.0.0.1", "https://LOCALHOST:443", "https://[0:0:0:0:0:0:0:1]:443", "https://127.000.000.001", "https://0x7f000001", "https://2130706433", "https://user:pass@example.test", "https://example.test/path"} {
		a.request("PUT", "/api/admin/site-address", Object{"primaryOrigin": invalid, "legacyOrigins": []string{}}, 400)
	}
	a.call("PUT", "/api/admin/site-address", Object{"primaryOrigin": "https://new.example", "legacyOrigins": []string{}}, 200)
	req, _ := http.NewRequest("GET", a.http.URL+"/api/admin/site-address", nil)
	req.Header.Set("Authorization", "Bearer "+a.token)
	req.Header.Set("Origin", "https://new.example")
	response, err := a.http.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 403 {
		t.Error("保存站点不得隐式扩大全局CORS allowlist", response.StatusCode)
	}
}

func TestSiteAddressLocalCanonicalBoundaryHTTP(t *testing.T) {
	b := newSiteContractAPI(t, false)
	saved := b.call("PUT", "/api/admin/site-address", Object{"primaryOrigin": " HTTP://LOCALHOST:80/ ", "legacyOrigins": []string{"http://localhost", "http://127.0.0.1:080/", "http://[0:0:0:0:0:0:0:1]:80"}}, 200)
	if saved["primaryOrigin"] != "http://localhost" || !reflect.DeepEqual(siteContractLegacy(t, saved["legacyOrigins"]), []string{"http://127.0.0.1", "http://[::1]"}) {
		t.Error("本地只允许回环HTTP且同样规范化", saved)
	}
	for _, bad := range []string{"https://remote.example", "http://remote.example", "https://127.0.0.1"} {
		b.request("PUT", "/api/admin/site-address", Object{"primaryOrigin": bad, "legacyOrigins": []string{}}, 400)
	}
}

func TestSiteAddressCanonicalRestartAccessAndDownstreamHTTP(t *testing.T) {
	a := newSiteContractAPI(t, true)
	node := siteInstallerFixture(a)
	const primary = "https://xn--fsqu00a.xn--0zwm56d"
	a.call("PUT", "/api/admin/site-address", Object{"primaryOrigin": "HTTPS://例子.测试:443/", "legacyOrigins": []string{"https://old.example/", "https://OLD.example:443", "https://例子.测试"}}, 200)
	assertSiteDownstream(a, text(node, "registerToken"), primary, 200)
	a = restartTestAPI(a)
	public := *a
	public.token = ""
	read := public.call("GET", "/api/client/site-address", nil, 200)
	if read["primaryOrigin"] != primary || !reflect.DeepEqual(siteContractLegacy(t, read["legacyOrigins"]), []string{"https://old.example"}) {
		t.Fatal("规范配置必须在新Server实例和匿名发现接口保留", read)
	}
	public.request("GET", "/api/admin/site-address", nil, 401)
	user := a.createUser()
	nonadmin := *a
	nonadmin.token = a.loginUser(user)
	nonadmin.request("GET", "/api/admin/site-address", nil, 403)
	nonadmin.request("PUT", "/api/admin/site-address", Object{"primaryOrigin": "https://attacker.example", "legacyOrigins": []string{}}, 403)
	assertSiteDownstream(a, text(node, "registerToken"), primary, 200)
}
