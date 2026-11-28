package api

import (
	"context"
	"strings"
	"testing"
)

// Credential examples never appear in test names, HTTP error output or reports.
func TestSupportCredentialContractRejectsMalformedValuesAtomically(t *testing.T) {
	a, origin, _, _, _ := supportRotationFixture(t)
	cases := []struct {
		name, field string
		value       any
	}{
		{"client-id-unicode", "clientId", "工单连接"},
		{"client-id-tab", "clientId", "client\tid"},
		{"client-id-control", "clientId", "client\x00id"},
		{"client-id-long", "clientId", strings.Repeat("a", 192)},
		{"client-id-wrong-type", "clientId", 7},
		{"client-id-object", "clientId", Object{}},
		{"client-id-colon", "clientId", "client:id"},
		{"client-id-raw-over-limit", "clientId", strings.Repeat(" ", 257)},
		{"base-url-wrong-type", "baseUrl", 7},
		{"base-url-object", "baseUrl", Object{}},
		{"base-url-raw-over-limit", "baseUrl", strings.Repeat(" ", 2049)},
	}
	for _, field := range []string{"clientSecret", "webhookSecret"} {
		for _, item := range []struct {
			name  string
			value any
		}{
			{"unicode", "凭据"}, {"internal-space", "part one"}, {"internal-tab", "part\tone"}, {"control", "part\x00one"},
			{"empty", ""}, {"blank", "  "}, {"wrong-type", 7}, {"object", Object{"value": "invalid"}}, {"too-long", strings.Repeat("a", 513)},
			{"raw-over-limit", strings.Repeat(" ", 1025)}, {"next-line-is-not-js-whitespace", "\u0085part\u0085"},
		} {
			cases = append(cases, struct {
				name, field string
				value       any
			}{field + "-" + item.name, field, item.value})
		}
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			before := readSupportRotationSnapshot(t, a)
			input := Object{"baseUrl": origin, item.field: item.value}
			// A valid rotated webhook avoids an unrelated connection-switch guard
			// masking malformed Client ID validation.
			if item.field == "clientId" {
				input["webhookSecret"] = newID()
			}
			if item.field == "baseUrl" {
				input["webhookSecret"] = newID()
			}
			status := putSupportRotation(t, a, input)
			after := readSupportRotationSnapshot(t, a)
			if status != 400 {
				t.Errorf("畸形凭据必须HTTP400，实际%d", status)
			}
			if after != before {
				t.Error("拒绝必须保持设置整行及generation/epoch/未读/事件完整不变")
			}
		})
	}
}

func TestSupportCredentialContractNormalizesBeforeComparingAndSupportsExplicitClear(t *testing.T) {
	a, origin, _, oldWebhook, _ := supportRotationFixture(t)
	before := readSupportRotationSnapshot(t, a)
	input := Object{"baseUrl": "  " + origin + "/  ", "clientId": "  first-client  ", "clientSecret": "  " + strings.Repeat("s", 512) + "  ", "webhookSecret": "  " + oldWebhook + "  "}
	if status := putSupportRotation(t, a, input); status != 200 {
		t.Fatalf("trim后的合法凭据应成功，实际%d", status)
	}
	after := readSupportRotationSnapshot(t, a)
	if before.generation != after.generation || before.epoch != after.epoch || before.unread != after.unread {
		t.Error("规范化后同一连接不得推进代次/清除未读")
	}
	var stored Object
	if err := a.server.DB.QueryRow(context.Background(), `SELECT value FROM "SystemSetting" WHERE key='achord-connect'`).Scan(&stored); err != nil {
		t.Fatal("读取私有schema配置失败")
	}
	if stored["clientId"] != "first-client" || stored["clientSecret"] != strings.Repeat("s", 512) || stored["webhookSecret"] != oldWebhook || stored["baseUrl"] != origin {
		t.Error("只能存储规范化凭据，不得保留输入边界空白")
	}
	before = readSupportRotationSnapshot(t, a)
	if status := putSupportRotation(t, a, Object{"clientSecret": nil, "enabled": true}); status != 400 {
		t.Errorf("启用时显式清除必需凭据必须400，实际%d", status)
	}
	if readSupportRotationSnapshot(t, a) != before {
		t.Error("启用时清除凭据被拒绝不得更改配置/未读代次")
	}
	a.call("PUT", "/api/admin/support-integration", Object{"clientSecret": nil, "webhookSecret": nil, "enabled": false}, 200)
	read := a.call("GET", "/api/admin/support-integration", nil, 200)
	if read["hasClientSecret"] != false || read["hasWebhookSecret"] != false || read["enabled"] != false {
		t.Error("显式null必须清除，不能用空字符串替代清除契约")
	}
}

func TestSupportCredentialContractEmptyAddressAndClientIDRemainNullable(t *testing.T) {
	for _, field := range []string{"clientId", "baseUrl"} {
		for _, item := range []struct {
			name  string
			value any
		}{{"null", nil}, {"empty", ""}, {"blank", " \t "}} {
			t.Run(field+"/"+item.name, func(t *testing.T) {
				a, _, _, _, _ := supportRotationFixture(t)
				// Clearing an existing connection still requires the existing rotation gate.
				input := Object{field: item.value, "webhookSecret": newID(), "enabled": false}
				if status := putSupportRotation(t, a, input); status != 200 {
					t.Fatalf("旧契约的可空连接字段清除应成功，实际%d", status)
				}
				var isNull bool
				if err := a.server.DB.QueryRow(context.Background(), `SELECT value->$1='null'::jsonb FROM "SystemSetting" WHERE key='achord-connect'`, field).Scan(&isNull); err != nil || !isNull {
					t.Fatal("连接字段空值必须存为JSON null", err)
				}
			})
		}
	}
}

func TestSupportCredentialContractOmittedFieldsAndPrintableLimits(t *testing.T) {
	a := newTestAPI(t)
	input := Object{"baseUrl": "http://127.0.0.1:54321", "clientId": "\uFEFF" + strings.Repeat("c", 191) + "\uFEFF", "clientSecret": "\uFEFF" + strings.Repeat("s", 512) + "\uFEFF", "webhookSecret": strings.Repeat("w", 512), "enabled": false}
	if status := putSupportRotation(t, a, input); status != 200 {
		t.Fatalf("JS trim及ID191/Secret512合法边界必须成功，实际%d", status)
	}
	var before, after string
	query := `SELECT md5(value::text) FROM "SystemSetting" WHERE key='achord-connect'`
	if err := a.server.DB.QueryRow(context.Background(), query).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if status := putSupportRotation(t, a, Object{}); status != 200 {
		t.Fatalf("省略凭据必须保留，实际%d", status)
	}
	if err := a.server.DB.QueryRow(context.Background(), query).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatal("省略不得更改已有配置值")
	}
	var normalized bool
	if err := a.server.DB.QueryRow(context.Background(), `SELECT length(value->>'clientId')=191 AND length(value->>'clientSecret')=512 FROM "SystemSetting" WHERE key='achord-connect'`).Scan(&normalized); err != nil || !normalized {
		t.Fatal("合法边界输入必须先按JS trim规范化", err)
	}
}
