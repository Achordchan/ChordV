package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"
	"time"
)

func (a *testAPI) createNode() (Object, string) {
	node := a.call("POST", "/api/admin/nodes/agent-native", Object{"name": "集成测试节点", "region": "本地", "provider": "本地"}, 200)
	id := text(node["node"].(map[string]any), "id")
	a.t.Cleanup(func() { _, _ = a.server.DB.Exec(context.Background(), `DELETE FROM "Node" WHERE id=$1`, id) })
	admin := a.token
	a.token = ""
	agentToken := "chordv_agent_" + randomToken()
	request := Object{"registerToken": node["registerToken"], "agentToken": agentToken, "hostname": "local-test", "arch": "linux-arm64", "agentVersion": "go-test", "bootId": "boot-1"}
	registered := a.call("POST", "/api/agent/v1/register", request, 200)
	if registered["accepted"] != true {
		a.t.Fatal("节点注册失败")
	}
	replayed := a.call("POST", "/api/agent/v1/register", request, 200)
	if replayed["agentId"] != registered["agentId"] {
		a.t.Fatal("注册重试没有保持身份")
	}
	request["agentToken"] = "chordv_agent_" + randomToken()
	a.call("POST", "/api/agent/v1/register", request, 401)
	a.token = admin
	return node["node"].(map[string]any), agentToken
}
func TestAgentRegistrationCommandsAndMetering(t *testing.T) {
	a := newTestAPI(t)
	node, agentToken := a.createNode()
	nodeID := text(node, "id")
	adminToken := a.token
	user := a.createUser()
	plan := a.createPlan("personal")
	subscription := a.call("POST", "/api/admin/subscriptions", Object{"userId": user["id"], "planId": plan["id"], "expireAt": time.Now().AddDate(0, 1, 0).UTC().Format(time.RFC3339)}, 200)
	key := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	spec := Object{"mode": "validate_panel", "listenPort": 54321, "serverHost": "127.0.0.1", "realityPublicKey": key, "shortId": "abcd", "serverNames": []string{"example.com"}, "flow": "xtls-rprx-vision", "fingerprint": "chrome", "spiderX": "/", "panelVersion": "3.1.0", "inboundTag": "inbound-54321", "tagOverrideConfirmed": true}
	command := a.call("POST", "/api/admin/nodes/"+nodeID+"/agent-commands", Object{"type": "ENSURE_INBOUND", "payload": spec, "expectedInboundAppliedRevision": "0"}, 200)
	a.token = agentToken
	a.call("POST", "/api/agent/v1/heartbeat", Object{"bootId": "boot-1", "version": "go-test", "configRevision": "0", "queueDepth": 0, "xrayStatus": "awaiting_inbound"}, 200)
	config := a.call("GET", "/api/agent/v1/config", nil, 200)
	if config["nodeId"] != nodeID {
		t.Fatal("Agent返回其他节点配置")
	}
	result := Object{"inbound": Object{"mode": "validate_panel", "validated": true, "inboundTag": "inbound-54321", "serverHost": "127.0.0.1", "serverPort": 54321, "realityPublicKey": key, "shortId": "abcd", "serverName": "example.com", "flow": "xtls-rprx-vision", "fingerprint": "chrome", "spiderX": "/"}}
	a.call("POST", "/api/agent/v1/commands/"+text(command, "commandId")+"/result", Object{"status": "completed", "result": result}, 200)
	a.token = adminToken
	nodes := a.array("/api/admin/nodes")
	found := false
	for _, v := range nodes {
		if v["id"] == nodeID {
			found = v["isActive"] == true && v["inboundAppliedRevision"] == command["targetRevision"]
		}
	}
	if !found {
		t.Fatal("节点未按校验结果激活")
	}
	a.call("PUT", "/api/admin/subscriptions/"+text(subscription, "id")+"/nodes", Object{"nodeIds": []string{nodeID}}, 200)
	binding, err := one(context.Background(), a.server.DB, `SELECT to_jsonb(b) FROM "PanelClientBinding" b WHERE "subscriptionId"=$1 AND "userId"=$2 AND "nodeId"=$3`, subscription["id"], user["id"], nodeID)
	if err != nil {
		t.Fatal(err)
	}
	sample := func(up int) Object {
		return Object{"bindingId": binding["id"], "counterGeneration": "1", "uplinkBytes": fmt.Sprint(up), "downlinkBytes": "0", "uplinkDeltaBytes": fmt.Sprint(up), "downlinkDeltaBytes": "0"}
	}
	batch := func(seq string, up int) Object {
		return Object{"bootId": "boot-1", "sequence": seq, "sampledAt": time.Date(2026, 11, 1, 1, 0, 0, 0, time.UTC).Format(time.RFC3339), "samples": []Object{sample(up)}}
	}
	a.token = agentToken
	first := a.call("POST", "/api/agent/v1/usage-batches", batch("1", 100), 200)
	if first["ackThrough"] != "1" {
		t.Fatal("首次流量基线未确认")
	}
	third := a.call("POST", "/api/agent/v1/usage-batches", batch("3", 300), 200)
	if third["ackThrough"] != "1" {
		t.Fatal("越过了乱序流量缺口")
	}
	second := a.call("POST", "/api/agent/v1/usage-batches", batch("2", 200), 200)
	if second["ackThrough"] != "3" {
		t.Fatal("未顺序结算补齐后的批次")
	}
	duplicate := a.call("POST", "/api/agent/v1/usage-batches", batch("2", 200), 200)
	if duplicate["duplicate"] != true {
		t.Fatal("重复批次未标记")
	}
	a.call("POST", "/api/agent/v1/usage-batches", batch("2", 201), 409)
	a.call("POST", "/api/agent/v1/usage-batches", batch("4", 299), 409)
	var used int64
	if err = a.server.DB.QueryRow(context.Background(), `SELECT "usedTrafficBytes" FROM "Subscription" WHERE id=$1`, subscription["id"]).Scan(&used); err != nil {
		t.Fatal(err)
	}
	if used != 300 {
		t.Fatalf("新绑定从零基线开始，应按绝对计数结算300字节，实际%d", used)
	}
	a.token = adminToken
	a.call("GET", "/api/admin/nodes/"+nodeID+"/agent-commands/"+text(command, "commandId")+"/outcome", nil, 200)
	a.call("GET", "/api/admin/nodes/"+nodeID+"/inbound-spec", nil, 200)
}
func TestTeamsOwnershipAndSharedSubscription(t *testing.T) {
	a := newTestAPI(t)
	owner := a.createUser()
	member := a.createUser()
	team := a.call("POST", "/api/admin/teams", Object{"name": "集成测试团队", "ownerUserId": owner["id"]}, 200)
	teamID := text(team, "id")
	t.Cleanup(func() { _, _ = a.server.DB.Exec(context.Background(), `DELETE FROM "Team" WHERE id=$1`, teamID) })
	team = a.call("POST", "/api/admin/teams/"+teamID+"/members", Object{"userId": member["id"], "role": "member"}, 200)
	if team["memberCount"] != float64(2) {
		t.Fatal("团队成员未写入")
	}
	plan := a.createPlan("team")
	a.call("POST", "/api/admin/teams/"+teamID+"/subscriptions", Object{"planId": plan["id"], "expireAt": time.Now().AddDate(0, 1, 0).UTC().Format(time.RFC3339)}, 200)
	admin := a.token
	a.token = ""
	session := a.call("POST", "/api/auth/login", Object{"email": member["email"], "password": "  exact-password  "}, 200)
	a.token = text(session, "accessToken")
	sub := a.call("GET", "/api/client/subscription", nil, 200)
	if sub["ownerType"] != "team" || sub["teamId"] != teamID {
		t.Fatal("成员未读取共享团队订阅")
	}
	a.token = admin
	var ownerMemberID string
	for _, raw := range team["members"].([]any) {
		m := raw.(map[string]any)
		if m["role"] == "owner" {
			ownerMemberID = text(m, "id")
		}
	}
	a.call("DELETE", "/api/admin/teams/"+teamID+"/members/"+ownerMemberID, nil, 409)
	a.call("PATCH", "/api/admin/teams/"+teamID, Object{"ownerUserId": member["id"]}, 200)
}

func TestConnectWaitsForRealAgentAcknowledgementWithoutPolling(t *testing.T) {
	a := newTestAPI(t)
	node, agentToken := a.createNode()
	user := a.createUser()
	plan := a.createPlan("personal")
	sub := a.call("POST", "/api/admin/subscriptions", Object{"userId": user["id"], "planId": plan["id"], "expireAt": time.Now().AddDate(0, 1, 0).UTC().Format(time.RFC3339)}, 200)
	key := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	if _, err := update(context.Background(), a.server.DB, "Node", text(node, "id"), Object{"serverHost": "127.0.0.1", "serverPort": 54321, "isActive": true, "inboundAppliedRevision": "1", "realityPublicKey": key, "serverName": "example.com"}, "serverHost", "serverPort", "isActive", "inboundAppliedRevision", "realityPublicKey", "serverName"); err != nil {
		t.Fatal(err)
	}
	a.call("PUT", "/api/admin/subscriptions/"+text(sub, "id")+"/nodes", Object{"nodeIds": []string{text(node, "id")}}, 200)
	a.token = ""
	session := a.call("POST", "/api/auth/login", Object{"email": user["email"], "password": "  exact-password  "}, 200)
	userToken := text(session, "accessToken")
	a.token = agentToken
	stream, _ := a.eventStream("/api/agent/v1/events", "")
	payload, _ := json.Marshal(Object{"nodeId": node["id"], "mode": "rule"})
	request, _ := http.NewRequest("POST", a.http.URL+"/api/client/session/connect", bytes.NewReader(payload))
	request.Header.Set("Authorization", "Bearer "+userToken)
	request.Header.Set("Content-Type", "application/json")
	done := make(chan *http.Response, 1)
	failed := make(chan error, 1)
	go func() {
		response, err := a.http.Client().Do(request)
		if err != nil {
			failed <- err
			return
		}
		done <- response
	}()
	command := waitLiveEvent(t, stream, func(e liveEvent) bool { return e.data["type"] == "ENSURE_USER" })
	select {
	case response := <-done:
		response.Body.Close()
		t.Fatal("Agent尚未确认时就返回了连接结果")
	default:
	}
	a.call("POST", "/api/agent/v1/commands/"+text(command.data, "commandId")+"/result", Object{"status": "completed", "result": Object{}}, 200)
	select {
	case response := <-done:
		defer response.Body.Close()
		raw, _ := io.ReadAll(response.Body)
		if response.StatusCode != 200 {
			t.Fatalf("Agent确认后未完成同一次连接: %d %s", response.StatusCode, raw)
		}
		var runtime Object
		if json.Unmarshal(raw, &runtime) != nil || text(runtime, "sessionId") == "" {
			t.Fatal("未生成真实会话配置")
		}
	case err := <-failed:
		t.Fatal(err)
	case <-time.After(3 * time.Second):
		t.Fatal("Agent确认后连接请求未被事件唤醒")
	}
}
