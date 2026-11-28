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
	"time"
)

func nodePatchStatus(t *testing.T, a *testAPI, id string, input Object) (int, string) {
	t.Helper()
	raw, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest("PATCH", a.http.URL+"/api/admin/nodes/"+id, bytes.NewReader(raw))
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

func nodePatchFixture(t *testing.T) (*testAPI, Object, Object, Object, Object, string) {
	t.Helper()
	a := newTestAPI(t)
	user, plan := a.createUser(), a.createPlan("personal")
	sub := a.call("POST", "/api/admin/subscriptions", Object{"userId": user["id"], "planId": plan["id"], "expireAt": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}, 200)
	node, agentToken, binding := a.readyBinding(user, sub)
	admin := a.token
	a.token = a.loginUser(user)
	session := a.call("POST", "/api/client/session/connect", Object{"nodeId": node["id"], "mode": "rule"}, 200)
	a.token = admin
	a.server.tasks.wg.Wait()
	return a, user, node, binding, session, agentToken
}

func TestNodePatchRejectsInvalidDTOFieldsWithoutWritesOrSSEHTTP(t *testing.T) {
	a, user, node, _, _, _ := nodePatchFixture(t)
	admin := a.token
	a.token = a.loginUser(user)
	clientEvents, _ := a.eventStream("/api/client/events/stream", "")
	waitLiveEvent(t, clientEvents, func(event liveEvent) bool { return event.data["type"] == "ticket_updated" })
	a.token = admin
	adminEvents, _ := a.eventStream("/api/admin/events/stream", "")
	waitLiveEvent(t, adminEvents, func(event liveEvent) bool { return event.data["type"] == "presence_updated" })
	control := &nodePatchPresenceControl{}
	t.Logf("Node PATCH观测夹具: node=%s user=%s", text(node, "id"), text(user, "id"))
	cases := []Object{}
	for _, field := range []string{"isActive", "recommended"} {
		for _, value := range []any{nil, "true", "false", " TRUE ", "0", "1", 1, 0, []any{}, Object{}, "", "yes", "off"} {
			cases = append(cases, Object{field: value})
		}
	}
	for _, field := range []string{"name", "region", "provider"} {
		for _, value := range []any{nil, "", 1, true, []any{}, Object{}} {
			cases = append(cases, Object{field: value})
		}
	}
	for _, value := range []any{nil, "", "USA", " us ", "1A", 0} {
		cases = append(cases, Object{"countryCode": value})
	}
	for _, value := range []any{nil, "x", []any{1}, []any{nil}, []any{true}, Object{}} {
		cases = append(cases, Object{"tags": value})
	}
	for _, input := range cases {
		before := policySchemaDigest(t, a)
		a.server.events.mu.Lock()
		sequence := a.server.events.sequence
		a.server.events.mu.Unlock()
		status, response := nodePatchStatus(t, a, text(node, "id"), input)
		a.server.tasks.wg.Wait()
		after := policySchemaDigest(t, a)
		afterSequence, unexpectedReplay := control.since(t, a, sequence)
		unexpected := []Object{}
		for _, stream := range []struct {
			target string
			events <-chan liveEvent
		}{{"admin", adminEvents}, {text(user, "id"), clientEvents}} {
			marker := newID()
			a.server.events.publish(stream.target, Object{"type": "test_node_patch_barrier", "marker": marker})
			waitLiveEvent(t, stream.events, func(event liveEvent) bool {
				if event.data["type"] == "test_node_patch_barrier" {
					return event.data["marker"] == marker
				}
				if stream.target == "admin" && control.accepts(t, a, event.id, event.data) {
					return false
				}
				unexpected = append(unexpected, event.data)
				return false
			})
		}
		changed := []string{}
		for table, digest := range before {
			if !reflect.DeepEqual(digest, after[table]) {
				changed = append(changed, table)
			}
		}
		sort.Strings(changed)
		beforeRaw, _ := json.Marshal(before)
		afterRaw, _ := json.Marshal(after)
		rawInput, _ := json.Marshal(input)
		t.Logf("input=%s status=%d tables=%d before=%s after=%s changed=%v eventSequence=%d→%d controlID=%q unexpectedReplay=%v unexpectedSSE=%v", rawInput, status, len(before), tokenHash(string(beforeRaw)), tokenHash(string(afterRaw)), changed, sequence, afterSequence, control.id, unexpectedReplay, unexpected)
		if status != 400 || !reflect.DeepEqual(before, after) || len(unexpectedReplay) != 0 || len(unexpected) != 0 {
			t.Errorf("旧DTO拒绝的字段必须400且不写库、不撤销/同步、不发布事件: %s", response)
		}
	}
	assertNodePatchObserverNegativeControls(t, a, control, adminEvents, clientEvents, text(user, "id"))
}

func TestNodePatchWhitelistAndOmittedFieldsHTTP(t *testing.T) {
	a := newTestAPI(t)
	node, _ := a.createNode()
	before, err := one(context.Background(), a.server.DB, `SELECT to_jsonb(n) FROM "Node" n WHERE id=$1`, node["id"])
	if err != nil {
		t.Fatal(err)
	}
	beforeSchema := policySchemaDigest(t, a)
	a.call("PATCH", "/api/admin/nodes/"+text(node, "id"), Object{"name": "白名单节点", "serverHost": "192.0.2.19", "serverPort": 1, "uuid": nil, "protocol": "other", "registrationStatus": "agent_ready", "agentConfigRevision": "999", "probeStatus": "healthy"}, 200)
	after, err := one(context.Background(), a.server.DB, `SELECT to_jsonb(n) FROM "Node" n WHERE id=$1`, node["id"])
	if err != nil {
		t.Fatal(err)
	}
	before["name"], before["updatedAt"] = "白名单节点", after["updatedAt"]
	if !reflect.DeepEqual(before, after) {
		t.Fatal("PATCH写入了白名单外字段或改变缺省布尔值", before, after)
	}
	afterSchema := policySchemaDigest(t, a)
	for table, digest := range beforeSchema {
		if table != "Node" && !reflect.DeepEqual(digest, afterSchema[table]) {
			t.Fatal("无isActive变更的元数据更新改变了其他表", table)
		}
	}
	a.call("PATCH", "/api/admin/nodes/"+text(node, "id"), Object{}, 200)
}

func TestNodePatchJSONBooleansPreserveDisableAndReenableEffectsHTTP(t *testing.T) {
	a, user, node, binding, session, agentToken := nodePatchFixture(t)
	admin := a.token
	a.token = a.loginUser(user)
	clientEvents, _ := a.eventStream("/api/client/events/stream", "")
	waitLiveEvent(t, clientEvents, func(event liveEvent) bool { return event.data["type"] == "ticket_updated" })
	a.token = admin
	updated := a.call("PATCH", "/api/admin/nodes/"+text(node, "id"), Object{"isActive": false, "recommended": true}, 200)
	if updated["isActive"] != false || updated["recommended"] != true {
		t.Fatal("合法JSON布尔值没有原样保存", updated)
	}
	event := waitLiveEvent(t, clientEvents, func(event liveEvent) bool { return event.data["type"] == "session_revoked" })
	if event.data["sessionId"] != session["sessionId"] || event.data["reasonCode"] != "node_access_revoked" {
		t.Fatal("停用节点没有精确撤销实际会话", event.data)
	}
	var leaseStatus, bindingStatus, commandID string
	if err := a.server.DB.QueryRow(context.Background(), `SELECT l.status::text,b.status::text FROM "NodeSessionLease" l JOIN "PanelClientBinding" b ON b.id=$2 WHERE l."sessionId"=$1`, session["sessionId"], binding["id"]).Scan(&leaseStatus, &bindingStatus); err != nil || leaseStatus != "revoked" || bindingStatus != "disabled" {
		t.Fatal("节点停用必须同时撤销租约和停用绑定", leaseStatus, bindingStatus, err)
	}
	if err := a.server.DB.QueryRow(context.Background(), `SELECT id FROM "NodeCommandJob" WHERE "bindingId"=$1 AND "commandType"='DISABLE_USER' AND status='pending' ORDER BY "targetRevision" DESC LIMIT 1`, binding["id"]).Scan(&commandID); err != nil {
		t.Fatal("节点停用没有生成真实停用命令", err)
	}
	a.token = agentToken
	a.call("POST", "/api/agent/v1/commands/"+commandID+"/result", Object{"status": "completed", "result": Object{"disableWatermarks": []any{}}}, 200)
	a.server.tasks.wg.Wait()
	a.token = admin
	updated = a.call("PATCH", "/api/admin/nodes/"+text(node, "id"), Object{"isActive": true, "recommended": false}, 200)
	if updated["isActive"] != true || updated["recommended"] != false {
		t.Fatal("合法重新启用未原样保存", updated)
	}
	if err := a.server.DB.QueryRow(context.Background(), `SELECT status::text FROM "PanelClientBinding" WHERE id=$1`, binding["id"]).Scan(&bindingStatus); err != nil || bindingStatus != "active" {
		t.Fatal("重新启用必须恢复订阅绑定", bindingStatus, err)
	}
	if err := a.server.DB.QueryRow(context.Background(), `SELECT id FROM "NodeCommandJob" WHERE "bindingId"=$1 AND "commandType"='ENSURE_USER' AND status='pending' ORDER BY "targetRevision" DESC LIMIT 1`, binding["id"]).Scan(&commandID); err != nil {
		t.Fatal("重新启用未生成真实同步命令", err)
	}
}

func TestNodePatchPreservesLegacyMetadataNormalizationHTTP(t *testing.T) {
	a := newTestAPI(t)
	node, _ := a.createNode()
	for _, sample := range []struct {
		input Object
		want  Object
	}{
		{Object{"name": "  新节点  ", "provider": "  新供应商  "}, Object{"name": "新节点", "provider": "新供应商"}},
		{Object{"name": " \t", "provider": "\ufeff "}, Object{"name": "", "provider": ""}},
		{Object{"name": "\u0085X\u0085", "provider": "\ufeff供应商\u00a0"}, Object{"name": "\u0085X\u0085", "provider": "供应商"}},
		{Object{"tags": []any{" a ", "", " a "}}, Object{"tags": []any{"a", "a"}}},
		{Object{"tags": []any{" "}}, Object{"tags": []any{}}},
		{Object{"tags": []any{}}, Object{"tags": []any{"香港"}}},
		{Object{"name": "SG 新节点", "tags": []any{}}, Object{"name": "SG 新节点", "tags": []any{"新加坡"}}},
		{Object{"name": "普通节点", "tags": []any{}}, Object{"name": "普通节点", "tags": []any{"导入"}}},
		{Object{"countryCode": "us"}, Object{"countryCode": "US", "region": "美国"}},
		{Object{"countryCode": "ZZ"}, Object{"countryCode": "HK", "region": "香港"}},
		{Object{"region": "美国"}, Object{"countryCode": "HK", "region": "香港"}},
		{Object{"region": " "}, Object{"countryCode": "HK", "region": "香港"}},
	} {
		before, err := update(context.Background(), a.server.DB, "Node", text(node, "id"), Object{"name": "HK 原节点", "countryCode": "HK", "region": "香港", "provider": "原供应商", "tags": []string{"原标签"}}, "name", "countryCode", "region", "provider", "tags")
		if err != nil {
			t.Fatal(err)
		}
		status, response := nodePatchStatus(t, a, text(node, "id"), sample.input)
		after, err := one(context.Background(), a.server.DB, `SELECT to_jsonb(n) FROM "Node" n WHERE id=$1`, node["id"])
		if err != nil {
			t.Fatal(err)
		}
		for field, want := range sample.want {
			before[field] = want
		}
		before["updatedAt"] = after["updatedAt"]
		if status != 200 || !reflect.DeepEqual(before, after) {
			t.Errorf("未恢复旧文本/标签/国家正规化: input=%v status=%d expected=%v actual=%v response=%s", sample.input, status, before, after, response)
		}
	}
}

func TestNodePatchNoopDoesNotWriteOrPublishHTTP(t *testing.T) {
	a, user, node, _, _, _ := nodePatchFixture(t)
	admin := a.token
	a.token = a.loginUser(user)
	client, _ := a.eventStream("/api/client/events/stream", "")
	waitLiveEvent(t, client, func(event liveEvent) bool { return event.data["type"] == "ticket_updated" })
	a.token = admin
	events, _ := a.eventStream("/api/admin/events/stream", "")
	waitLiveEvent(t, events, func(event liveEvent) bool { return event.data["type"] == "presence_updated" })
	control := &nodePatchPresenceControl{}
	for _, input := range []Object{{}, {"serverHost": "192.0.2.19"}, {"isActive": true}} {
		before := policySchemaDigest(t, a)
		a.server.events.mu.Lock()
		sequence := a.server.events.sequence
		a.server.events.mu.Unlock()
		a.call("PATCH", "/api/admin/nodes/"+text(node, "id"), input, 200)
		after := policySchemaDigest(t, a)
		afterSequence, unexpectedReplay := control.since(t, a, sequence)
		marker := newID()
		a.server.events.publish("admin", Object{"type": "test_node_patch_noop_barrier", "marker": marker})
		unexpected := []Object{}
		waitLiveEvent(t, events, func(event liveEvent) bool {
			if event.data["type"] == "test_node_patch_noop_barrier" && event.data["marker"] == marker {
				return true
			}
			if control.accepts(t, a, event.id, event.data) {
				return false
			}
			unexpected = append(unexpected, event.data)
			return false
		})
		for table, digest := range before {
			if table == "Node" && input["isActive"] == true {
				continue // The old explicit same-value Prisma update still touches updatedAt.
			}
			if !reflect.DeepEqual(digest, after[table]) {
				t.Errorf("无状态转换不应同步绑定/命令或空写: input=%v table=%s", input, table)
			}
		}
		if len(unexpectedReplay) != 0 || len(unexpected) != 0 {
			t.Errorf("空/仅额外字段/同值isActive不应发布变更事件: input=%v sequence=%d→%d unexpected=%v", input, sequence, afterSequence, unexpected)
		}
	}
}

func TestNodePatchPreservesLegacyOnboardingGuardHTTP(t *testing.T) {
	a := newTestAPI(t)
	node, _ := a.createNode()
	events, _ := a.eventStream("/api/admin/events/stream", "")
	waitLiveEvent(t, events, func(event liveEvent) bool { return event.data["type"] == "presence_updated" })
	base := Object{"isActive": true, "registrationStatus": "agent_ready", "protocol": "vless", "security": "reality", "serverHost": "127.0.0.1", "serverPort": 443, "uuid": newID(), "realityPublicKey": "key", "serverName": "example.com", "fingerprint": "chrome"}
	for _, invalid := range []Object{{"registrationStatus": "pending_register"}, {"protocol": "other"}, {"security": "other"}, {"serverHost": "PENDING-AGENT"}, {"serverPort": 0}, {"serverPort": 65536}, {"uuid": " "}, {"realityPublicKey": " "}, {"serverName": " "}, {"fingerprint": " "}} {
		input := Object{}
		for field, value := range base {
			input[field] = value
		}
		for field, value := range invalid {
			input[field] = value
		}
		fields := []string{}
		for field := range input {
			fields = append(fields, field)
		}
		if _, err := update(context.Background(), a.server.DB, "Node", text(node, "id"), input, fields...); err != nil {
			t.Fatal(err)
		}
		before := policySchemaDigest(t, a)
		a.server.events.mu.Lock()
		sequence := a.server.events.sequence
		a.server.events.mu.Unlock()
		status, response := nodePatchStatus(t, a, text(node, "id"), Object{"recommended": true})
		after := policySchemaDigest(t, a)
		a.server.events.mu.Lock()
		afterSequence := a.server.events.sequence
		a.server.events.mu.Unlock()
		marker, unexpected := newID(), []Object{}
		a.server.events.publish("admin", Object{"type": "test_node_patch_guard_barrier", "marker": marker})
		waitLiveEvent(t, events, func(event liveEvent) bool {
			if event.data["type"] == "test_node_patch_guard_barrier" && event.data["marker"] == marker {
				return true
			}
			unexpected = append(unexpected, event.data)
			return false
		})
		if status != 400 || !reflect.DeepEqual(before, after) || sequence != afterSequence || len(unexpected) != 0 {
			t.Errorf("旧就绪检查应在元数据/启用更新前400且不写入: invalid=%v status=%d response=%s", invalid, status, response)
		}
	}
	a.call("PATCH", "/api/admin/nodes/"+text(node, "id"), Object{"isActive": false}, 200)
	if _, err := update(context.Background(), a.server.DB, "Node", text(node, "id"), Object{"registrationStatus": nil, "realityPublicKey": "", "uuid": "", "serverName": "", "fingerprint": ""}, "registrationStatus", "realityPublicKey", "uuid", "serverName", "fingerprint"); err != nil {
		t.Fatal(err)
	}
	a.call("PATCH", "/api/admin/nodes/"+text(node, "id"), Object{"isActive": true}, 200)
}

func TestNodePatchCountryDataAndLegacyInference(t *testing.T) {
	a := newTestAPI(t)
	node, _ := a.createNode()
	updated := a.call("PATCH", "/api/admin/nodes/"+text(node, "id"), Object{"name": "SİNGAPORE", "region": " "}, 200)
	if updated["countryCode"] != nil || updated["region"] != "未分组" {
		t.Fatal("真实HTTP未保留旧JS的U+0130推导边界", updated)
	}
	for raw, label := range nodePatchCountries.Codes {
		input := Object{"region": strings.ToLower(raw)}
		normalizeNodePatchMetadata(input, Object{"name": "原节点", "region": "未分组", "countryCode": nil, "serverHost": "127.0.0.1"})
		if input["countryCode"] != raw || input["region"] != label {
			t.Fatalf("原ISO合法代码未保留: raw=%s got=%v", raw, input)
		}
	}
	for name, code := range nodePatchCountries.Names {
		input := Object{"region": strings.ToUpper(name)}
		normalizeNodePatchMetadata(input, Object{"name": "原节点", "region": "未分组", "countryCode": nil, "serverHost": "127.0.0.1"})
		if input["countryCode"] != code || input["region"] != nodePatchCountries.Codes[code] {
			t.Fatalf("原中英名称未保留: name=%s code=%s got=%v", name, code, input)
		}
	}
	if region := nodePatchInferredRegion("SİNGAPORE", "127.0.0.1"); region != "未分组" {
		t.Fatal("推导阶段不能用Go单字符小写吞掉旧JS的组合点", region)
	}
	for _, sample := range []struct {
		region string
		code   any
		label  string
	}{{"United States", "US", "美国"}, {"USA", "USA", "美国"}, {"840", "840", "美国"}, {"ß", "SS", "南苏丹"}, {"ﬁ", "FI", "芬兰"}, {"ﬆ", "ST", "圣多美和普林西比"}, {"united kİngdom", nil, "united kİngdom"}, {"未知", nil, "未知"}, {" ", nil, "未分组"}} {
		a := newTestAPI(t)
		node, _ := a.createNode()
		updated := a.call("PATCH", "/api/admin/nodes/"+text(node, "id"), Object{"region": sample.region}, 200)
		if updated["countryCode"] != sample.code || updated["region"] != sample.label {
			t.Errorf("旧国家helper的真实HTTP结果不一致: input=%q expected=(%v,%s) actual=(%v,%v)", sample.region, sample.code, sample.label, updated["countryCode"], updated["region"])
		}
	}
	t.Logf("完整生成表对照: codeKeys=%d nameKeys=%d JSUpperExpansions=%d", len(nodePatchCountries.Codes), len(nodePatchCountries.Names), len(nodePatchCountries.UpperExpansions))
}
