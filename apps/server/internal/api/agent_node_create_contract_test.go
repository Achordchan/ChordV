package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

func agentNodeCreateRequest(t *testing.T, a *testAPI, input Object) (int, Object) {
	t.Helper()
	raw, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest("POST", a.http.URL+"/api/admin/nodes/agent-native", bytes.NewReader(raw))
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
	var result Object
	if err = json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal("创建响应不是JSON对象", err)
	}
	return response.StatusCode, result
}

func agentNodeCreateLocalPanel() Object {
	return Object{"mode": "validate_panel", "listenPort": 443, "serverHost": "127.0.0.1", "realityPublicKey": base64.RawURLEncoding.EncodeToString(make([]byte, 32)), "serverNames": []any{"example.com"}, "panelVersion": "3.1.0"}
}

func TestAgentNodeCreateRejectsLegacyInvalidInputWithoutWritesOrSSEHTTP(t *testing.T) {
	a := newTestAPI(t)
	a.call("POST", "/api/admin/nodes/agent-native", Object{"name": "原有待接入节点"}, 200)
	events, _ := a.eventStream("/api/admin/events/stream", "")
	waitLiveEvent(t, events, func(event liveEvent) bool { return event.data["type"] == "presence_updated" })
	cases := []Object{{}}
	for _, value := range []any{nil, false, 0, []any{}, Object{}, "", " ", strings.Repeat("x", 121), " " + strings.Repeat("x", 120) + " ", strings.Repeat("😀", 61), strings.Repeat("字\ufe0f", 61)} {
		cases = append(cases, Object{"name": value})
	}
	for _, field := range []string{"countryCode", "region", "provider"} {
		limit := 120
		if field == "countryCode" {
			limit = 64
		}
		for _, value := range []any{1, true, []any{}, Object{}, strings.Repeat("x", limit+1)} {
			cases = append(cases, Object{"name": "节点", field: value})
		}
	}
	for _, field := range []string{"isActive", "recommended"} {
		for _, value := range []any{"true", "false", 0, 1, []any{}, Object{}} {
			cases = append(cases, Object{"name": "节点", field: value})
		}
	}
	for _, value := range []any{[]any{strings.Repeat("x", 65)}, []any{strings.Repeat("😀", 65)}, "a", []any{1}, []any{nil}, Object{}} {
		cases = append(cases, Object{"name": "节点", "tags": value})
	}
	for _, value := range []any{false, 0, 1, "", []any{}, []any{"x"}, Object{}, Object{"mode": "bad"}, Object{"mode": "validate_panel"}} {
		cases = append(cases, Object{"name": "节点", "panelInbound": value})
	}
	for _, invalid := range []Object{{"mode": "bad"}, {"rotateKeys": true}, {"listenPort": "443"}, {"listenPort": true}, {"listenPort": 0}, {"listenPort": 65536}, {"listenPort": 1.5}, {"listenPort": json.Number("1e999")}} {
		panel := agentNodeCreateLocalPanel()
		for key, value := range invalid {
			panel[key] = value
		}
		cases = append(cases, Object{"name": "节点", "panelInbound": panel})
	}
	for index, input := range cases {
		before := policySchemaDigest(t, a)
		a.server.events.mu.Lock()
		sequence := a.server.events.sequence
		a.server.events.mu.Unlock()
		status, result := agentNodeCreateRequest(t, a, input)
		after := policySchemaDigest(t, a)
		a.server.events.mu.Lock()
		afterSequence := a.server.events.sequence
		a.server.events.mu.Unlock()
		marker, unexpected := newID(), []Object{}
		a.server.events.publish("admin", Object{"type": "test_create_node_barrier", "marker": marker})
		waitLiveEvent(t, events, func(event liveEvent) bool {
			if event.data["type"] == "test_create_node_barrier" && event.data["marker"] == marker {
				return true
			}
			unexpected = append(unexpected, event.data)
			return false
		})
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
		t.Logf("case=%d input=%s status=%d tables=%d before=%s after=%s changed=%v sequence=%d→%d SSE=%v", index, rawInput, status, len(before), tokenHash(string(beforeRaw)), tokenHash(string(afterRaw)), changed, sequence, afterSequence, unexpected)
		if status != 400 || !reflect.DeepEqual(before, after) || sequence != afterSequence || len(unexpected) != 0 {
			t.Errorf("旧DTO/创建前校验拒绝的请求必须400且不新增节点/注册令牌、不发事件；message=%v", result["message"])
		}
	}
}

func TestAgentNodeCreatePreservesNullableDefaultsMetadataAndTokenHTTP(t *testing.T) {
	a := newTestAPI(t)
	events, _ := a.eventStream("/api/admin/events/stream", "")
	waitLiveEvent(t, events, func(event liveEvent) bool { return event.data["type"] == "presence_updated" })
	for _, sample := range []struct {
		input Object
		want  Object
	}{
		{Object{"name": "  节点  "}, Object{"name": "节点"}},
		{Object{"name": "节点", "countryCode": nil, "region": nil, "provider": nil, "tags": nil, "recommended": nil, "isActive": nil, "panelInbound": nil}, Object{}},
		{Object{"name": "节点", "countryCode": " \t", "region": " ", "provider": ""}, Object{}},
		{Object{"name": "节点", "countryCode": "  zz  ", "region": "  自定义地区  ", "provider": "  供应商  ", "tags": []any{"", " a ", " a "}, "recommended": true, "isActive": true}, Object{"countryCode": "zz", "region": "自定义地区", "provider": "供应商", "tags": []any{"", " a ", " a "}, "recommended": true}},
		{Object{"name": "\u0085"}, Object{"name": "\u0085"}},
		{Object{"name": "\ufeff名称\u00a0"}, Object{"name": "名称"}},
		{Object{"name": strings.Repeat("x", 120)}, Object{"name": strings.Repeat("x", 120)}},
		{Object{"name": strings.Repeat("😀", 60)}, Object{"name": strings.Repeat("😀", 60)}},
		{Object{"name": "节点", "countryCode": strings.Repeat("字\ufe0f", 64), "region": strings.Repeat("字\ufe0f", 120), "provider": strings.Repeat("字\ufe0e", 120), "tags": []any{strings.Repeat("字\ufe0f", 64)}}, Object{"countryCode": strings.Repeat("字\ufe0f", 64), "region": strings.Repeat("字\ufe0f", 120), "provider": strings.Repeat("字\ufe0e", 120), "tags": []any{strings.Repeat("字\ufe0f", 64)}}},
		{Object{"name": "节点", "countryCode": strings.Repeat("😀", 64), "region": strings.Repeat("😀", 120), "provider": strings.Repeat("😀", 120), "tags": []any{strings.Repeat("😀", 64)}}, Object{"countryCode": strings.Repeat("😀", 64), "region": strings.Repeat("😀", 120), "provider": strings.Repeat("😀", 120), "tags": []any{strings.Repeat("😀", 64)}}},
	} {
		before := policySchemaDigest(t, a)
		a.server.events.mu.Lock()
		sequence := a.server.events.sequence
		a.server.events.mu.Unlock()
		started := time.Now()
		status, result := agentNodeCreateRequest(t, a, sample.input)
		if status != 200 {
			t.Errorf("旧创建分支接受的nullable/默认值被拒绝: input=%v status=%d message=%v", sample.input, status, result["message"])
			continue
		}
		node := Object(result["node"].(map[string]any))
		want := Object{"name": "节点", "countryCode": nil, "region": "未指定", "provider": "未指定", "tags": []any{}, "recommended": false, "isActive": false, "registrationStatus": "pending_register", "controlStatus": "pending_register", "serverHost": "pending-agent", "serverPort": float64(0)}
		for field, value := range sample.want {
			want[field] = value
		}
		for field, value := range want {
			if !reflect.DeepEqual(node[field], value) {
				t.Errorf("创建字段未保留旧存储表达式: field=%s got=%v want=%v", field, node[field], value)
			}
		}
		token := stringValue(result, "registerToken")
		if !strings.HasPrefix(token, "chordv_register_") || len(token) < 24 {
			t.Fatal("没有返回一次性注册令牌")
		}
		var tokenHashValue, prefix, stored string
		var count int
		if err := a.server.DB.QueryRow(context.Background(), `SELECT count(*),max("tokenHash"),max("tokenPrefix"),max(to_jsonb(t)::text) FROM "AgentRegisterToken" t WHERE "nodeId"=$1`, node["id"]).Scan(&count, &tokenHashValue, &prefix, &stored); err != nil || count != 1 || tokenHashValue != a.server.agentHash(token) || prefix != token[:24] || strings.Contains(stored, token) {
			t.Fatal("注册令牌应仅保存一行摘要/前缀，不得明文存储", err)
		}
		expires, err := time.Parse(time.RFC3339Nano, stringValue(result, "registerTokenExpiresAt"))
		if err != nil || expires.Before(started.Add(24*time.Hour-time.Second)) || expires.After(time.Now().Add(24*time.Hour+time.Second)) {
			t.Fatal("注册令牌应保持24小时有效期", err)
		}
		after := policySchemaDigest(t, a)
		for table, digest := range before {
			if table != "Node" && table != "AgentRegisterToken" && !reflect.DeepEqual(digest, after[table]) {
				t.Errorf("待接入创建不应更改其他表: %s", table)
			}
		}
		var counts [2]int
		if err := a.server.DB.QueryRow(context.Background(), `SELECT (SELECT count(*) FROM "Node"),(SELECT count(*) FROM "AgentRegisterToken")`).Scan(&counts[0], &counts[1]); err != nil || counts[0] != counts[1] {
			t.Fatal("每次创建必须只生成一个节点和一个注册令牌", counts, err)
		}
		a.server.events.mu.Lock()
		afterSequence := a.server.events.sequence
		a.server.events.mu.Unlock()
		marker, mutationEvents := newID(), []Object{}
		a.server.events.publish("admin", Object{"type": "test_create_node_valid_barrier", "marker": marker})
		waitLiveEvent(t, events, func(event liveEvent) bool {
			if event.data["type"] == "test_create_node_valid_barrier" && event.data["marker"] == marker {
				return true
			}
			mutationEvents = append(mutationEvents, event.data)
			return false
		})
		if afterSequence != sequence+1 || len(mutationEvents) != 1 || mutationEvents[0]["type"] != "node_access_updated" {
			t.Errorf("合法创建应保留单次节点刷新通知: sequence=%d→%d events=%v", sequence, afterSequence, mutationEvents)
		}
	}
}

func TestAgentNodeCreatePreservesLegacyNameErrorsAndSelectorLengthHTTP(t *testing.T) {
	a := newTestAPI(t)
	for _, sample := range []struct {
		name, message string
	}{{"\ufeff \u00a0", "节点名称不能为空"}, {strings.Repeat("😀", 61), "节点名称过长"}, {strings.Repeat("字\ufe0f", 61), "节点名称过长"}} {
		before := policySchemaDigest(t, a)
		status, result := agentNodeCreateRequest(t, a, Object{"name": sample.name})
		if status != 400 || result["message"] != sample.message || !reflect.DeepEqual(before, policySchemaDigest(t, a)) {
			t.Errorf("旧DTO后名称服务校验错误不一致: status=%d got=%v want=%s", status, result["message"], sample.message)
		}
	}
	for _, sample := range []struct {
		value string
		want  int
	}{{"A\ufe0f", 1}, {"A\ufe0f\ufe0e", 2}, {"\ufe0f\ufe0e", 2}, {"😀\ufe0f", 1}, {"A\u0301", 2}, {"😀", 1}} {
		if got := agentNodeCreateLength(sample.value); got != sample.want {
			t.Errorf("validator.js呈现序列长度不一致: value=%q got=%d want=%d", sample.value, got, sample.want)
		}
	}
}

func TestAgentNodeCreateWhitelistPanelAndRealRegistrationHTTP(t *testing.T) {
	a := newTestAPI(t)
	events, _ := a.eventStream("/api/admin/events/stream", "")
	waitLiveEvent(t, events, func(event liveEvent) bool { return event.data["type"] == "presence_updated" })
	status, result := agentNodeCreateRequest(t, a, Object{"name": "创建白名单", "isActive": true, "id": "supplied-id", "uuid": "supplied-uuid", "serverHost": "192.0.2.20", "serverPort": 65535, "registrationStatus": "agent_ready", "controlStatus": "online", "registerToken": "supplied-token"})
	if status != 200 {
		t.Fatal("合法创建请求失败", status, result["message"])
	}
	node := Object(result["node"].(map[string]any))
	if node["id"] == "supplied-id" || node["uuid"] != nil || node["serverHost"] != "pending-agent" || node["serverPort"] != float64(0) || node["isActive"] != false || node["registrationStatus"] != "pending_register" || node["controlStatus"] != "pending_register" {
		t.Fatal("创建白名单未保护待接入节点状态", node)
	}
	waitLiveEvent(t, events, func(event liveEvent) bool { return event.data["type"] == "node_access_updated" })
	admin := a.token
	a.token = ""
	registered := a.call("POST", "/api/agent/v1/register", Object{"registerToken": result["registerToken"], "agentToken": "chordv_agent_" + randomToken(), "hostname": "local-contract", "arch": "linux-arm64", "agentVersion": "go-test", "bootId": "boot-create-contract"}, 200)
	if registered["accepted"] != true {
		t.Fatal("合法创建令牌不能完成真实HTTP注册")
	}
	a.token = admin
	var active bool
	var state string
	if err := a.server.DB.QueryRow(context.Background(), `SELECT "isActive","registrationStatus"::text FROM "Node" WHERE id=$1`, node["id"]).Scan(&active, &state); err != nil || active || state != "agent_ready" {
		t.Fatal("注册后仍必须等待真实入站校验才能启用", active, state, err)
	}
	status, panelResult := agentNodeCreateRequest(t, a, Object{"name": "保留既有本地入站验证", "panelInbound": agentNodeCreateLocalPanel()})
	if status != 200 {
		t.Fatal("原有合法本地panelInbound路径被破坏", status, panelResult["message"])
	}
	panelNode := Object(panelResult["node"].(map[string]any))
	spec := Object(panelNode["onboardingSpec"].(map[string]any))
	if panelNode["isActive"] != false || spec["mode"] != "validate_panel" || spec["listenPort"] != float64(443) || spec["activateOnFirstValidation"] != true {
		t.Fatal("面板入站必须保持待验证状态", panelNode)
	}
}
