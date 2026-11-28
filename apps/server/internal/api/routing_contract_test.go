package api

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestRoutingContractRejectsInvalidFieldsWithoutWritesOrSSEHTTP(t *testing.T) {
	f := newRoutingContractFixture(t)
	cases := []struct {
		method string
		input  Object
		status int
	}{}
	for _, method := range []string{"POST", "PATCH"} {
		for _, input := range []Object{
			{"enabled": "true"}, {"enabled": "false"}, {"enabled": 0}, {"enabled": 1}, {"enabled": []any{}}, {"enabled": Object{}},
			{"name": 1}, {"name": true}, {"name": []any{}}, {"name": Object{}}, {"name": strings.Repeat("字", 81)},
			{"action": " proxy "}, {"action": true}, {"action": "other"}, {"action": nil},
			{"value": nil}, {"value": 1}, {"value": true}, {"value": []any{}}, {"value": Object{}}, {"value": ""},
			{"value": "192.0.2.0/24"}, {"value": "/example.*/"}, {"value": "regexp:^x$"}, {"value": "https://example.com"},
			{"value": strings.Repeat("a", 65)}, {"value": strings.Repeat("a", 64) + ".com"}, {"value": strings.Repeat(".", 125) + "word"}, {"value": "\u0085example.com"},
		} {
			body := Object{}
			if method == "POST" {
				body["value"], body["action"] = "valid.example", "proxy"
			}
			for field, value := range input {
				body[field] = value
			}
			cases = append(cases, struct {
				method string
				input  Object
				status int
			}{method, body, 400})
		}
	}
	cases = append(cases, struct {
		method string
		input  Object
		status int
	}{"PATCH", Object{"enabled": nil}, 500})
	for _, method := range []string{"POST", "PATCH"} {
		input := Object{"name": "a" + strings.Repeat("😀", 40)}
		if method == "POST" {
			input["value"], input["action"] = "valid.example", "proxy"
		}
		cases = append(cases, struct {
			method string
			input  Object
			status int
		}{method, input, 500})
		cases = append(cases, struct {
			method string
			input  Object
			status int
		}{method, Object{"name": "a" + strings.Repeat("😀", 40), "value": "https://invalid.example", "action": "proxy"}, 400})
	}
	for _, sample := range cases {
		before, sequence := policySchemaDigest(t, f.a), f.sequence()
		path := "/api/client/routing-rules"
		if sample.method == "PATCH" {
			path += "/" + text(f.rule, "id")
		}
		status, response := routingContractRequest(t, f.a, sample.method, path, sample.input)
		after := policySchemaDigest(t, f.a)
		raw, _ := json.Marshal(sample.input)
		beforeRaw, _ := json.Marshal(before)
		afterRaw, _ := json.Marshal(after)
		t.Logf("method=%s input=%s status=%d want=%d tables=%d before=%s after=%s", sample.method, raw, status, sample.status, len(before), tokenHash(string(beforeRaw)), tokenHash(string(afterRaw)))
		if status != sample.status || !reflect.DeepEqual(before, after) {
			t.Errorf("旧拒绝输入应保持整库不变: response=%v", response)
		}
		f.observe(t, sequence, false)
	}
}

func TestRoutingContractPreservesLegacyValuesAndNamesHTTP(t *testing.T) {
	f := newRoutingContractFixture(t)
	for index, sample := range []struct {
		value, normalized, kind string
	}{
		{"-", "-", "keyword"}, {"---", "---", "keyword"}, {"-a", "-a", "keyword"}, {"a-", "a-", "keyword"},
		{strings.Repeat("a", 64), strings.Repeat("a", 64), "keyword"}, {"..Example.COM", "example.com", "domain"}, {"127.0.0.1", "127.0.0.1", "domain"},
		{"localhost", "localhost", "keyword"}, {"\ufeffEDGE.EXAMPLE\u00a0", "edge.example", "domain"},
		{strings.Repeat("a", 63) + "." + strings.Repeat("b", 63), strings.Repeat("a", 63) + "." + strings.Repeat("b", 63), "domain"},
	} {
		before, sequence := policySchemaDigest(t, f.a), f.sequence()
		status, result := routingContractRequest(t, f.a, "POST", "/api/client/routing-rules", Object{"value": sample.value, "action": "direct", "enabled": nil, "userId": f.other["id"], "matchType": "regexp", "id": "supplied-id"})
		if status != 200 || result["value"] != sample.normalized || result["matchType"] != sample.kind || result["enabled"] != true || result["name"] != nil || result["userId"] != f.owner["id"] || result["id"] == "supplied-id" {
			t.Errorf("旧合法类型/白名单/缺省值未保留: sample=%d status=%d got=%v", index, status, result)
		}
		after := policySchemaDigest(t, f.a)
		for table, digest := range before {
			if table != "ClientRoutingRule" && !reflect.DeepEqual(digest, after[table]) {
				t.Errorf("创建规则改变无关表:%s", table)
			}
		}
		f.observe(t, sequence, status == 200)
	}
	for _, sample := range []struct {
		input any
		want  any
	}{{nil, nil}, {"", nil}, {"  ", nil}, {"  中文名称  ", "中文名称"}, {strings.Repeat("字", 80), strings.Repeat("字", 80)}, {strings.Repeat("😀", 41), strings.Repeat("😀", 40)}, {strings.Repeat("字\ufe0f", 80), strings.Repeat("字\ufe0f", 40)}} {
		sequence := f.sequence()
		result := f.a.call("PATCH", "/api/client/routing-rules/"+text(f.rule, "id"), Object{"name": sample.input}, 200)
		if result["name"] != sample.want {
			t.Errorf("规则名称未保留trim/nullable/UTF16截断: input=%v got=%v want=%v", sample.input, result["name"], sample.want)
		}
		f.observe(t, sequence, true)
	}
}

func TestRoutingContractNoopToggleOwnershipAndDeleteHTTP(t *testing.T) {
	f := newRoutingContractFixture(t)
	path := "/api/client/routing-rules/" + text(f.rule, "id")
	for _, input := range []Object{{}, {"userId": f.other["id"], "matchType": "regexp", "id": "new-id"}} {
		before, sequence := policySchemaDigest(t, f.a), f.sequence()
		f.a.call("PATCH", path, input, 200)
		if !reflect.DeepEqual(before, policySchemaDigest(t, f.a)) {
			t.Error("旧空/仅额外字段更新不应改updatedAt或数据")
		}
		f.observe(t, sequence, true)
	}
	for _, enabled := range []bool{false, true, true} {
		sequence := f.sequence()
		result := f.a.call("PATCH", path, Object{"enabled": enabled}, 200)
		if result["enabled"] != enabled {
			t.Fatal("合法布尔启停未保存", result)
		}
		f.observe(t, sequence, true)
	}
	f.a.token = f.otherToken
	for _, input := range []Object{{"enabled": nil}, {"value": "https://invalid.example"}} {
		before, sequence := policySchemaDigest(t, f.a), f.sequence()
		status, _ := routingContractRequest(t, f.a, "PATCH", path, input)
		if status != 404 || !reflect.DeepEqual(before, policySchemaDigest(t, f.a)) {
			t.Fatal("DTO通过后应先检查所有权，不能泄露规则或提前运行值归一", input, status)
		}
		f.observe(t, sequence, false)
	}
	for _, method := range []string{"PATCH", "DELETE"} {
		before, sequence := policySchemaDigest(t, f.a), f.sequence()
		status, _ := routingContractRequest(t, f.a, method, path, Object{"enabled": false})
		if status != 404 || !reflect.DeepEqual(before, policySchemaDigest(t, f.a)) {
			t.Fatal("其他用户不得修改/删除规则", method, status)
		}
		f.observe(t, sequence, false)
	}
	f.a.token = ""
	for _, method := range []string{"POST", "PATCH", "DELETE"} {
		before, sequence := policySchemaDigest(t, f.a), f.sequence()
		requestPath := path
		if method == "POST" {
			requestPath = "/api/client/routing-rules"
		}
		status, _ := routingContractRequest(t, f.a, method, requestPath, Object{"value": "x", "action": "proxy"})
		if status != 401 || !reflect.DeepEqual(before, policySchemaDigest(t, f.a)) {
			t.Fatal("缺少鉴权时不得修改规则", method, status)
		}
		f.observe(t, sequence, false)
	}
	f.a.token = f.ownerToken
	sequence := f.sequence()
	deleted := f.a.call("DELETE", path, nil, 200)
	if deleted["ok"] != true || deleted["deletedId"] != f.rule["id"] {
		t.Errorf("DELETE旧响应契约丢失deletedId: %v", deleted)
	}
	f.observe(t, sequence, true)
	before, sequence := policySchemaDigest(t, f.a), f.sequence()
	f.a.call("DELETE", path, nil, 404)
	if !reflect.DeepEqual(before, policySchemaDigest(t, f.a)) {
		t.Error("重复删除不应改变数据")
	}
	f.observe(t, sequence, false)
}

func TestRoutingContractLimitAndDuplicateAreAtomicHTTP(t *testing.T) {
	f := newRoutingContractFixture(t)
	if _, err := f.a.server.DB.Exec(context.Background(), `INSERT INTO "ClientRoutingRule"(id,"userId",value,"matchType",action,enabled,"updatedAt") SELECT $1||n::text,$2,'seed'||n::text,'keyword','proxy',true,now() FROM generate_series(1,99) n`, newID(), f.owner["id"]); err != nil {
		t.Fatal(err)
	}
	before, sequence := policySchemaDigest(t, f.a), f.sequence()
	status, response := routingContractRequest(t, f.a, "POST", "/api/client/routing-rules", Object{"value": "one-more", "action": "proxy"})
	if status != 400 || !reflect.DeepEqual(before, policySchemaDigest(t, f.a)) {
		t.Errorf("100条上限应旧400且不写入: status=%d response=%v", status, response)
	}
	f.observe(t, sequence, false)
	if _, err := f.a.server.DB.Exec(context.Background(), `DELETE FROM "ClientRoutingRule" WHERE "userId"=$1 AND value='seed99'`, f.owner["id"]); err != nil {
		t.Fatal(err)
	}
	sequence = f.sequence()
	f.a.call("POST", "/api/client/routing-rules", Object{"value": "one-more", "action": "proxy"}, 200)
	f.observe(t, sequence, true)
	// Duplicate behavior is observed below the count limit, for both create and update.
	if _, err := f.a.server.DB.Exec(context.Background(), `DELETE FROM "ClientRoutingRule" WHERE "userId"=$1 AND value='seed98'`, f.owner["id"]); err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"POST", "PATCH"} {
		before, sequence := policySchemaDigest(t, f.a), f.sequence()
		path := "/api/client/routing-rules"
		if method == "PATCH" {
			path += "/" + text(f.rule, "id")
		}
		status, _ := routingContractRequest(t, f.a, method, path, Object{"value": "one-more", "action": "direct"})
		if status != 409 || !reflect.DeepEqual(before, policySchemaDigest(t, f.a)) {
			t.Fatal("重复规则应409且整个事务不写入", method, status)
		}
		f.observe(t, sequence, false)
	}
}
