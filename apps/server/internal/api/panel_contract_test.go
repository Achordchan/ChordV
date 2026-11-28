package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

type panelLegacySample struct {
	Name   string `json:"name"`
	Input  Object `json:"input"`
	Status int    `json:"status"`
	Output Object `json:"output"`
}

func panelLegacySamples(t *testing.T) ([]panelLegacySample, []panelLegacySample) {
	t.Helper()
	raw, err := os.ReadFile("testdata/panel-inbound-legacy.json")
	if err != nil {
		t.Fatal(err)
	}
	var proof struct {
		Commit        string              `json:"commit"`
		NormalResults []panelLegacySample `json:"normalResults"`
		ParserResults []panelLegacySample `json:"parserResults"`
	}
	if err = json.Unmarshal(raw, &proof); err != nil || proof.Commit != "397a64d" {
		t.Fatal("旧helper实证testdata无效", err)
	}
	return proof.NormalResults, proof.ParserResults
}

func panelCanonical(t *testing.T, value any) Object {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var result Object
	if err = json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestPanelContractNormalizerMatchesOriginalInputTable(t *testing.T) {
	samples, _ := panelLegacySamples(t)
	for _, sample := range samples {
		output, err := normalizeInbound(sample.Input, true)
		status := 200
		if err != nil {
			if httpError, ok := err.(HTTPError); ok {
				status = httpError.Status
			} else {
				t.Fatal(err)
			}
		}
		// The production/local server-host policy is intentionally not changed
		// by this helper-contract audit. Its pre-existing rejection is HTTP403.
		if strings.HasPrefix(sample.Name, "serverHost:") && sample.Status == 400 && status == 403 {
			t.Logf("明确保留serverHost网络策略差异: sample=%s old=%d current=%d", sample.Name, sample.Status, status)
			continue
		}
		if status != sample.Status || status == 200 && !reflect.DeepEqual(panelCanonical(t, output), sample.Output) {
			t.Errorf("旧normalizer差异: sample=%s status=%d want=%d output=%v expected=%v error=%v", sample.Name, status, sample.Status, output, sample.Output, err)
		}
	}
}

func TestPanelContractParserOriginalInputTableHTTPHasNoSideEffects(t *testing.T) {
	a := newTestAPI(t)
	_, samples := panelLegacySamples(t)
	events, _ := a.eventStream("/api/admin/events/stream", "")
	waitLiveEvent(t, events, func(event liveEvent) bool { return event.data["type"] == "presence_updated" })
	for _, sample := range samples {
		input := Object{}
		for field, value := range sample.Input {
			input[field] = value
		}
		if link, ok := input["link"].(string); ok {
			input["link"] = strings.ReplaceAll(strings.ReplaceAll(link, "node.example.com", "127.0.0.1"), "node.\texample.com", "127.0.\t0.1")
			input["link"] = strings.ReplaceAll(input["link"].(string), "[2606:4700:4700::1111]", "[::1]")
			input["link"] = strings.ReplaceAll(input["link"].(string), "[2606:4700:4700:0:0:0:0:1111]", "[0:0:0:0:0:0:0:1]")
			input["link"] = strings.ReplaceAll(input["link"].(string), "[::ffff:192.0.2.1]", "[0:0:0:0:0:0:0:1]")
		}
		before, sequence := policySchemaDigest(t, a), panelEventSequence(a)
		status, result := routingContractRequest(t, a, "POST", "/api/admin/nodes/panel-inbound/parse", input)
		expected := Object{}
		for field, value := range sample.Output {
			expected[field] = value
		}
		if expected["serverHost"] == "node.example.com" {
			expected["serverHost"] = "127.0.0.1"
		}
		if expected["serverHost"] == "2606:4700:4700::1111" {
			expected["serverHost"] = "::1"
		}
		if expected["serverHost"] == "::ffff:c000:201" {
			expected["serverHost"] = "::1"
		}
		if status != sample.Status || status == 200 && !reflect.DeepEqual(result, expected) {
			t.Errorf("旧parser差异: sample=%s status=%d want=%d got=%v expected=%v", sample.Name, status, sample.Status, result, expected)
		}
		if !reflect.DeepEqual(before, policySchemaDigest(t, a)) {
			t.Errorf("解析链接不应改动48表: %s", sample.Name)
		}
		panelAssertNoEvents(t, a, events, sequence)
		t.Logf("sample=%s status=%d expected=%d tables=%d noWrites=true", sample.Name, status, sample.Status, len(before))
	}
}

func panelEventSequence(a *testAPI) uint64 {
	a.server.events.mu.Lock()
	defer a.server.events.mu.Unlock()
	return a.server.events.sequence
}

func panelAssertNoEvents(t *testing.T, a *testAPI, events <-chan liveEvent, before uint64) {
	t.Helper()
	after := panelEventSequence(a)
	if before != after {
		t.Errorf("拒绝或解析请求不应发布任何事件: %d→%d", before, after)
	}
	marker, unexpected := newID(), []Object{}
	a.server.events.publish("admin", Object{"type": "test_panel_contract_barrier", "marker": marker})
	waitLiveEvent(t, events, func(event liveEvent) bool {
		if event.data["type"] == "test_panel_contract_barrier" && event.data["marker"] == marker {
			return true
		}
		unexpected = append(unexpected, event.data)
		return false
	})
	if len(unexpected) != 0 {
		t.Errorf("真实SSE不应有业务事件: %v", unexpected)
	}
}

func TestPanelContractRejectsBadPayloadBeforeQueueWritesHTTP(t *testing.T) {
	a := newTestAPI(t)
	node, _ := a.createNode()
	samples, _ := panelLegacySamples(t)
	events, _ := a.eventStream("/api/admin/events/stream", "")
	waitLiveEvent(t, events, func(event liveEvent) bool { return event.data["type"] == "presence_updated" })
	for _, sample := range samples {
		if sample.Status != 400 || strings.HasPrefix(sample.Name, "serverHost:") {
			continue
		}
		payload := Object{}
		for field, value := range sample.Input {
			payload[field] = value
		}
		payload["serverHost"] = "127.0.0.1"
		before, sequence := policySchemaDigest(t, a), panelEventSequence(a)
		status, response := routingContractRequest(t, a, "POST", "/api/admin/nodes/"+text(node, "id")+"/agent-commands", Object{"type": "ENSURE_INBOUND", "payload": payload})
		if status != 400 || !reflect.DeepEqual(before, policySchemaDigest(t, a)) {
			t.Errorf("非法入站不得新增命令/修订或改任何48表: sample=%s status=%d message=%v", sample.Name, status, response["message"])
		}
		panelAssertNoEvents(t, a, events, sequence)
	}
}

func TestPanelContractCanonicalPayloadSurvivesRealQueueAndReportHTTP(t *testing.T) {
	a := newTestAPI(t)
	node, agentToken := a.createNode()
	key := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	longName := strings.Repeat("a", 63) + "." + strings.Repeat("b", 63) + ".example"
	payload := Object{"mode": "validate_panel", "listenPort": 443, "serverHost": " 127.0.0.1 ", "realityPublicKey": "\ufeff " + key + " \u00a0", "shortId": nil, "serverNames": []any{" " + longName + " "}, "flow": nil, "fingerprint": nil, "spiderX": nil, "panelVersion": " v3.1.0 "}
	job := a.call("POST", "/api/admin/nodes/"+text(node, "id")+"/agent-commands", Object{"type": "ENSURE_INBOUND", "payload": payload, "expectedInboundAppliedRevision": "0"}, 200)
	spec := Object(job["payload"].(map[string]any))
	if spec["realityPublicKey"] != key || spec["panelVersion"] != "3.1.0" || spec["fingerprint"] != "chrome" || spec["spiderX"] != "/" || !reflect.DeepEqual(spec["serverNames"], []any{longName}) {
		t.Fatalf("实际下发公钥/SNI/版本/nullable默认值未规范化: %v", spec)
	}
	a.token = agentToken
	commands, _ := a.eventStream("/api/agent/v1/events", "")
	delivered := waitLiveEvent(t, commands, func(event liveEvent) bool { return event.data["commandId"] == job["commandId"] })
	if !reflect.DeepEqual(delivered.data["payload"], job["payload"]) {
		t.Fatal("真实Agent SSE交付了不同入站payload")
	}
	a.call("POST", "/api/agent/v1/commands/"+text(job, "commandId")+"/result", Object{"status": "completed", "result": Object{"inbound": Object{"mode": "validate_panel", "validated": true, "inboundTag": "inbound-443", "serverHost": "127.0.0.1", "serverPort": 443, "realityPublicKey": key, "shortId": "", "serverName": longName, "flow": "", "fingerprint": "chrome", "spiderX": "/"}}}, 200)
	var active bool
	var stored, revision string
	if err := a.server.DB.QueryRow(context.Background(), `SELECT "isActive","realityPublicKey","inboundAppliedRevision"::text FROM "Node" WHERE id=$1`, node["id"]).Scan(&active, &stored, &revision); err != nil || !active || stored != key || revision != job["targetRevision"] {
		t.Fatal("规范公钥回执未真实完成待接入节点入站", active, revision, err)
	}
}

func TestPanelContractPreservesExistingServerHostPoliciesWithoutNetwork(t *testing.T) {
	for _, sample := range []struct {
		host       string
		production bool
		status     int
	}{{"127.0.0.1", false, 200}, {"[::1]", false, 200}, {"node.example.com", false, 403}, {"192.0.2.1", false, 403}, {"node.example.com", true, 200}, {"192.0.2.1", true, 200}, {"127.0.0.1", true, 200}, {"10.0.0.1", true, 200}} {
		_, err := normalizeInbound(Object{"mode": "validate_panel", "listenPort": 443, "serverHost": sample.host, "realityPublicKey": base64.RawURLEncoding.EncodeToString(make([]byte, 32)), "serverNames": []any{"example.com"}, "panelVersion": "auto"}, sample.production)
		status := 200
		if err != nil {
			status = err.(HTTPError).Status
		}
		if status != sample.status {
			t.Errorf("不得顺手改动既有serverHost模式策略: host=%s production=%v status=%d want=%d", sample.host, sample.production, status, sample.status)
		}
	}
}

func TestPanelContractEveryAcceptedLegacySpecCanQueueOnLocalNodeHTTP(t *testing.T) {
	a := newTestAPI(t)
	node, _ := a.createNode()
	samples, _ := panelLegacySamples(t)
	accepted := 0
	for _, sample := range samples {
		if sample.Status != 200 {
			continue
		}
		payload, expected := Object{}, Object{}
		for key, value := range sample.Input {
			payload[key] = value
		}
		for key, value := range sample.Output {
			expected[key] = value
		}
		payload["serverHost"], expected["serverHost"] = "127.0.0.1", "127.0.0.1"
		before := policySchemaDigest(t, a)
		status, result := routingContractRequest(t, a, "POST", "/api/admin/nodes/"+text(node, "id")+"/agent-commands", Object{"type": "ENSURE_INBOUND", "payload": payload})
		if status != 200 || !reflect.DeepEqual(result["payload"], map[string]any(expected)) {
			t.Errorf("不得将旧合法入站缩成拒绝或写入不同参数: sample=%s status=%d got=%v expected=%v", sample.Name, status, result["payload"], expected)
		}
		after := policySchemaDigest(t, a)
		for table, digest := range before {
			if table != "Node" && table != "NodeCommandJob" && !reflect.DeepEqual(digest, after[table]) {
				t.Errorf("合法入站排队改动无关表: sample=%s table=%s", sample.Name, table)
			}
		}
		accepted++
	}
	t.Logf("全部旧合法spec真实本地HTTP排队通过: %d", accepted)
}

func TestPanelContractPureParserAlsoMatchesOriginalPublicReferenceTable(t *testing.T) {
	_, samples := panelLegacySamples(t)
	for _, sample := range samples {
		input, err := validatePanelLinkInput(sample.Input)
		var output Object
		if err == nil {
			output, err = parsePanelLink(input, true)
		}
		status := 200
		if err != nil {
			status = err.(HTTPError).Status
		}
		if status != sample.Status || status == 200 && !reflect.DeepEqual(panelCanonical(t, output), sample.Output) {
			t.Errorf("纯CPU旧public参考表差异（无联网/不改模式策略）: sample=%s status=%d want=%d got=%v expected=%v", sample.Name, status, sample.Status, output, sample.Output)
		}
	}
}
