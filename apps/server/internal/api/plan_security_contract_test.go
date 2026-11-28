package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
)

func planSecurityStatus(t *testing.T, a *testAPI, id string, input Object) (int, string) {
	t.Helper()
	raw, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest("PUT", a.http.URL+"/api/admin/plans/"+id+"/security", bytes.NewReader(raw))
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

func planSecurityRecord(t *testing.T, a *testAPI, id string) Object {
	t.Helper()
	row, err := one(context.Background(), a.server.DB, `SELECT to_jsonb(p) FROM "Plan" p WHERE id=$1`, id)
	if err != nil {
		t.Fatal(err)
	}
	return row
}

func TestPlanSecurityWhitelistOnlyChangesConcurrentLimitHTTP(t *testing.T) {
	a := newTestAPI(t)
	plan, control := a.createPlan("personal"), a.createPlan("team")
	controlBefore := planSecurityRecord(t, a, text(control, "id"))
	for _, extra := range []Object{
		{"name": "不能从安全入口改名", "scope": "team", "totalTrafficGb": 0, "renewable": false, "isActive": false},
		{"name": nil, "scope": "invalid", "totalTrafficGb": "bad", "renewable": "bad", "isActive": nil},
	} {
		before := planSecurityRecord(t, a, text(plan, "id"))
		beforeSchema := policySchemaDigest(t, a)
		extra["maxConcurrentSessions"] = 2
		status, response := planSecurityStatus(t, a, text(plan, "id"), extra)
		after := planSecurityRecord(t, a, text(plan, "id"))
		afterSchema := policySchemaDigest(t, a)
		expected := Object{}
		for field, value := range before {
			expected[field] = value
		}
		expected["maxConcurrentSessions"], expected["updatedAt"] = float64(2), after["updatedAt"]
		if status != 200 || !reflect.DeepEqual(expected, after) {
			t.Errorf("安全入口必须忽略旧DTO外字段，仅修改并发上限: status=%d before=%v after=%v response=%s", status, before, after, response)
		}
		for table, digest := range beforeSchema {
			if table != "Plan" && !reflect.DeepEqual(digest, afterSchema[table]) {
				t.Errorf("安全入口修改了无关表%s", table)
			}
		}
		t.Logf("status=%d privateTables=%d before=%v after=%v", status, len(beforeSchema), before, after)
	}
	if !reflect.DeepEqual(controlBefore, planSecurityRecord(t, a, text(control, "id"))) {
		t.Fatal("其他套餐发生变化")
	}
	updated := a.call("PATCH", "/api/admin/plans/"+text(control, "id"), Object{"name": "普通编辑仍可使用", "totalTrafficGb": 25, "renewable": false, "isActive": false}, 200)
	if updated["name"] != "普通编辑仍可使用" || updated["totalTrafficGb"] != float64(25) || updated["renewable"] != false || updated["isActive"] != false {
		t.Fatal("专属安全白名单误限制了普通套餐编辑", updated)
	}
}

func TestPlanSecurityRequiresValidLimitWithoutWritesOrSSEHTTP(t *testing.T) {
	a := newTestAPI(t)
	plan := a.createPlan("personal")
	events, _ := a.eventStream("/api/admin/events/stream", "")
	waitLiveEvent(t, events, func(event liveEvent) bool { return event.data["type"] == "presence_updated" })
	for _, sample := range []struct {
		input  Object
		status int
	}{
		{Object{}, 400}, {Object{"isActive": false}, 400}, {Object{"maxConcurrentSessions": nil}, 400}, {Object{"maxConcurrentSessions": 0}, 400}, {Object{"maxConcurrentSessions": false}, 400},
		{Object{"maxConcurrentSessions": "bad"}, 400}, {Object{"maxConcurrentSessions": "NaN"}, 400}, {Object{"maxConcurrentSessions": "Infinity"}, 400},
		{Object{"maxConcurrentSessions": json.Number("1e10000")}, 400}, {Object{"maxConcurrentSessions": []any{}}, 400}, {Object{"maxConcurrentSessions": Object{}}, 400},
		{Object{"maxConcurrentSessions": 2147483648}, 503}, {Object{"maxConcurrentSessions": "2147483648"}, 503},
		{Object{"maxConcurrentSessions": ""}, 400}, {Object{"maxConcurrentSessions": " \t\r\n"}, 400}, {Object{"maxConcurrentSessions": 0.9}, 400},
		{Object{"maxConcurrentSessions": "1_0"}, 400}, {Object{"maxConcurrentSessions": "0x1p2"}, 400}, {Object{"maxConcurrentSessions": "\u00851"}, 400},
		{Object{"maxConcurrentSessions": "0x10000000000000000"}, 503}, {Object{"maxConcurrentSessions": "0x" + strings.Repeat("f", 300)}, 400},
	} {
		before := policySchemaDigest(t, a)
		a.server.events.mu.Lock()
		sequence := a.server.events.sequence
		a.server.events.mu.Unlock()
		status, response := planSecurityStatus(t, a, text(plan, "id"), sample.input)
		after := policySchemaDigest(t, a)
		a.server.events.mu.Lock()
		afterSequence := a.server.events.sequence
		a.server.events.mu.Unlock()
		marker := newID()
		a.server.events.publish("admin", Object{"type": "test_plan_security_barrier", "marker": marker})
		unexpected := []Object{}
		waitLiveEvent(t, events, func(event liveEvent) bool {
			if event.data["type"] == "test_plan_security_barrier" && event.data["marker"] == marker {
				return true
			}
			unexpected = append(unexpected, event.data)
			return false
		})
		beforeRaw, _ := json.Marshal(before)
		afterRaw, _ := json.Marshal(after)
		t.Logf("input=%v status=%d expected=%d tables=%d before=%s after=%s eventSequence=%d→%d unexpectedSSE=%v", sample.input, status, sample.status, len(before), tokenHash(string(beforeRaw)), tokenHash(string(afterRaw)), sequence, afterSequence, unexpected)
		if status != sample.status || !reflect.DeepEqual(before, after) || sequence != afterSequence || len(unexpected) != 0 {
			t.Errorf("非法或缺省并发上限应在写入前拒绝且不发事件: %s", response)
		}
	}
}

func TestPlanSecurityPreservesLegacyNumberAndStorageConversionsHTTP(t *testing.T) {
	a := newTestAPI(t)
	plan := a.createPlan("personal")
	for _, sample := range []struct {
		input any
		want  float64
	}{{3, 3}, {101, 101}, {"3", 3}, {" 3e0 ", 3}, {"0x10", 16}, {"0b10", 2}, {"0o10", 8}, {true, 1}, {1.5, 1}, {"1.5", 1}, {2.9, 2}, {"2.9", 2}, {2147483647, 2147483647}, {"2147483647", 2147483647}, {2147483647.9, 2147483647}, {"\ufeff1\u00a0", 1}, {"+1.", 1}, {".15e2", 15}} {
		status, response := planSecurityStatus(t, a, text(plan, "id"), Object{"maxConcurrentSessions": sample.input})
		stored := planSecurityRecord(t, a, text(plan, "id"))
		t.Logf("input=%v status=%d stored=%v expected=%v", sample.input, status, stored["maxConcurrentSessions"], sample.want)
		if status != 200 || stored["maxConcurrentSessions"] != sample.want {
			t.Errorf("没有保留真实旧DTO/Prisma转换: %s", response)
		}
	}
}

func TestPlanSecurityKeepsOrdinaryPlanValidationHTTP(t *testing.T) {
	a := newTestAPI(t)
	plan := a.createPlan("personal")
	for _, input := range []any{101, "3", true} {
		before := policySchemaDigest(t, a)
		a.call("POST", "/api/admin/plans", Object{"name": "普通新增仍受原限制", "scope": "personal", "totalTrafficGb": 10, "renewable": true, "maxConcurrentSessions": input}, 400)
		a.call("PATCH", "/api/admin/plans/"+text(plan, "id"), Object{"maxConcurrentSessions": input}, 400)
		if !reflect.DeepEqual(before, policySchemaDigest(t, a)) {
			t.Fatal("PUT专属转换误应用到普通POST/PATCH", input)
		}
	}
	updated := a.call("PATCH", "/api/admin/plans/"+text(plan, "id"), Object{"maxConcurrentSessions": 100}, 200)
	if updated["maxConcurrentSessions"] != float64(100) {
		t.Fatal("普通PATCH的原合法上限失效", updated)
	}
	before := policySchemaDigest(t, a)
	for _, input := range []any{3, 2147483648} {
		status, response := planSecurityStatus(t, a, newID(), Object{"maxConcurrentSessions": input})
		if status != 404 || !reflect.DeepEqual(before, policySchemaDigest(t, a)) {
			t.Fatalf("通过DTO后的不存在套餐应先404而不是存储域错误: status=%d response=%s", status, response)
		}
	}
}

func TestPlanSecurityLimitReductionReconcilesLiveHTTPLeases(t *testing.T) {
	a := newTestAPI(t)
	user, plan := a.createUser(), a.createPlan("personal")
	sub := a.call("POST", "/api/admin/subscriptions", Object{"userId": user["id"], "planId": plan["id"], "expireAt": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}, 200)
	node, _, binding := a.readyBinding(user, sub)
	admin := a.token
	a.token = a.loginUser(user)
	sessions := []Object{}
	for range 3 {
		sessions = append(sessions, a.call("POST", "/api/client/session/connect", Object{"nodeId": node["id"], "mode": "rule"}, 200))
	}
	a.token = admin
	updated := a.call("PUT", "/api/admin/plans/"+text(plan, "id")+"/security", Object{"maxConcurrentSessions": "1.9", "isActive": false}, 200)
	if updated["maxConcurrentSessions"] != float64(1) || updated["isActive"] != true {
		t.Fatal("专属转换/白名单没有用于实际套餐", updated)
	}
	for index, session := range sessions {
		var status, reason string
		if err := a.server.DB.QueryRow(context.Background(), `SELECT status::text,coalesce("revokedReason",'') FROM "NodeSessionLease" WHERE "sessionId"=$1`, session["sessionId"]).Scan(&status, &reason); err != nil {
			t.Fatal(err)
		}
		if (index < 2 && (status != "evicted" || reason != "concurrency_limit")) || (index == 2 && status != "active") {
			t.Fatalf("套餐限额没有仅逐出最旧超额会话: index=%d status=%s reason=%s", index, status, reason)
		}
	}
	var status string
	if err := a.server.DB.QueryRow(context.Background(), `SELECT status::text FROM "PanelClientBinding" WHERE id=$1`, binding["id"]).Scan(&status); err != nil || status != "active" {
		t.Fatal("同节点保留有效会话时不能停用账号", status, err)
	}
}
