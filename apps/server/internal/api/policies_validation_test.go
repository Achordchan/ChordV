package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"sort"
	"strings"
	"testing"
)

func policySchemaDigest(t *testing.T, a *testAPI) Object {
	t.Helper()
	tables, err := list(context.Background(), a.server.DB, `SELECT jsonb_build_object('name',tablename) FROM pg_catalog.pg_tables WHERE schemaname=current_schema() ORDER BY tablename`)
	if err != nil || len(tables) == 0 {
		t.Fatal("读取私有schema表清单失败", err)
	}
	parts := make([]string, 0, len(tables))
	for _, row := range tables {
		name := text(row, "name")
		parts = append(parts, `SELECT '`+strings.ReplaceAll(name, "'", "''")+`' AS name,jsonb_build_object('rows',count(*),'digest',md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb)::text)) AS fingerprint FROM `+quote(name)+` r`)
	}
	result, err := one(context.Background(), a.server.DB, `SELECT jsonb_object_agg(name,fingerprint) FROM (`+strings.Join(parts, ` UNION ALL `)+`) snapshots`)
	if err != nil {
		t.Fatal("读取私有schema全表摘要失败", err)
	}
	return result
}

func policyPatchStatus(t *testing.T, a *testAPI, input Object) (int, string) {
	t.Helper()
	raw, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest("PATCH", a.http.URL+"/api/admin/policies", bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+a.token)
	response, err := a.http.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, string(body)
}

func TestPolicyBooleanFieldsRejectNonBooleansWithoutWritesHTTP(t *testing.T) {
	a := newTestAPI(t)
	invalid := []struct {
		name  string
		value any
	}{{"string-true", "true"}, {"string-false", "false"}, {"string-FALSE", "FALSE"}, {"string-yes", "yes"}, {"string-no", "no"}, {"string-on", "on"}, {"string-off", "off"}, {"string-one", "1"}, {"string-zero", "0"}, {"number-one", 1}, {"number-zero", 0}, {"number-two", 2}, {"null", nil}, {"array", []any{}}, {"object", Object{}}, {"empty-string", ""}}
	for _, field := range []string{"blockAds", "chinaDirect", "aiServicesProxy"} {
		for _, value := range invalid {
			t.Run(field+"/"+value.name, func(t *testing.T) {
				beforePolicy := a.call("GET", "/api/admin/policies", nil, 200)
				before := policySchemaDigest(t, a)
				status, response := policyPatchStatus(t, a, Object{"defaultMode": "direct", "modes": []string{"direct"}, field: value.value})
				after := policySchemaDigest(t, a)
				afterPolicy := a.call("GET", "/api/admin/policies", nil, 200)
				changed := []string{}
				for table, snapshot := range before {
					if !reflect.DeepEqual(snapshot, after[table]) {
						changed = append(changed, table)
					}
				}
				sort.Strings(changed)
				beforeRaw, _ := json.Marshal(before)
				afterRaw, _ := json.Marshal(after)
				t.Logf("status=%d tables=%d before=%s after=%s changed=%v beforePolicy=%v afterPolicy=%v", status, len(before), tokenHash(string(beforeRaw)), tokenHash(string(afterRaw)), changed, beforePolicy, afterPolicy)
				if status != 400 || !reflect.DeepEqual(before, after) || !reflect.DeepEqual(beforePolicy, afterPolicy) {
					t.Errorf("非法布尔值必须400且整个私有schema不变: %s", response)
				}
			})
		}
	}
}

func TestPolicyBooleanFieldsPreserveJSONBooleansAndOmissionHTTP(t *testing.T) {
	a, control := newTestAPI(t), newTestAPI(t)
	controlBefore := policySchemaDigest(t, control)
	for _, enabled := range []bool{false, true, false} {
		policy := a.call("PATCH", "/api/admin/policies", Object{"blockAds": enabled, "chinaDirect": enabled, "aiServicesProxy": enabled}, 200)
		features := policy["features"].(map[string]any)
		for _, field := range []string{"blockAds", "chinaDirect", "aiServicesProxy"} {
			if features[field] != enabled {
				t.Fatal("合法JSON布尔值未原样保存", policy)
			}
		}
	}
	before := a.call("GET", "/api/admin/policies", nil, 200)
	after := a.call("PATCH", "/api/admin/policies", Object{"defaultMode": "direct", "modes": []string{"direct", "rule"}, "features": Object{"blockAds": "bad"}, "forceUpgrade": true}, 200)
	if after["defaultMode"] != "direct" || !reflect.DeepEqual(before["features"], after["features"]) {
		t.Fatal("缺省布尔值或DTO外字段改变了已有功能开关", before, after)
	}
	var forceUpgrade bool
	if err := a.server.DB.QueryRow(context.Background(), `SELECT "forceUpgrade" FROM "PolicyProfile" WHERE id='default'`).Scan(&forceUpgrade); err != nil || forceUpgrade {
		t.Fatal("DTO外forceUpgrade不应写入", forceUpgrade, err)
	}
	if !reflect.DeepEqual(controlBefore, policySchemaDigest(t, control)) {
		t.Fatal("策略写入泄漏到另一个私有schema")
	}
	t.Logf("合法true/false、缺省保留、额外字段忽略与另一个schema隔离通过: %v", after)
}

func TestPolicyBooleanFixKeepsExistingModeValidationHTTP(t *testing.T) {
	a := newTestAPI(t)
	for _, input := range []Object{
		{"modes": []string{"rule", "rule"}},
		{"modes": []string{}},
		{"defaultMode": "rule", "modes": []string{"direct"}},
		{"modes": []string{"rule", "unknown"}},
	} {
		before := policySchemaDigest(t, a)
		a.call("PATCH", "/api/admin/policies", input, 400)
		if !reflect.DeepEqual(before, policySchemaDigest(t, a)) {
			t.Fatal("既有模式校验失败时改变了私有表", input)
		}
	}
	a.call("PATCH", "/api/admin/policies", Object{"defaultMode": "rule", "modes": []string{"rule", "direct"}}, 200)
}
