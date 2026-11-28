package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"testing"
	"time"
)

func (a *testAPI) readyBinding(user, sub Object) (Object, string, Object) {
	a.t.Helper()
	node, token := a.createNode()
	_, err := update(context.Background(), a.server.DB, "Node", text(node, "id"), Object{"serverHost": "127.0.0.1", "serverPort": 54321, "isActive": true, "inboundAppliedRevision": "1", "realityPublicKey": base64.RawURLEncoding.EncodeToString(make([]byte, 32)), "serverName": "example.com"}, "serverHost", "serverPort", "isActive", "inboundAppliedRevision", "realityPublicKey", "serverName")
	if err != nil {
		a.t.Fatal(err)
	}
	var ids []string
	rows, err := list(context.Background(), a.server.DB, `SELECT jsonb_build_object('id',"nodeId") FROM "SubscriptionNodeAccess" WHERE "subscriptionId"=$1`, sub["id"])
	if err != nil {
		a.t.Fatal(err)
	}
	for _, row := range rows {
		ids = append(ids, text(row, "id"))
	}
	ids = append(ids, text(node, "id"))
	a.call("PUT", "/api/admin/subscriptions/"+text(sub, "id")+"/nodes", Object{"nodeIds": ids}, 200)
	bindings, err := list(context.Background(), a.server.DB, `SELECT to_jsonb(b) FROM "PanelClientBinding" b WHERE "subscriptionId"=$1 AND status='active'`, sub["id"])
	if err != nil {
		a.t.Fatal(err)
	}
	// HTTP fixture acknowledgements exercise server state; physical Agent/Xray E2E is separate.
	for _, b := range bindings {
		var jobID string
		if err = a.server.DB.QueryRow(context.Background(), `SELECT id FROM "NodeCommandJob" WHERE "bindingId"=$1 AND "commandType"='ENSURE_USER' AND status='pending' ORDER BY "targetRevision" DESC LIMIT 1`, b["id"]).Scan(&jobID); err != nil {
			continue
		}
		var agentToken string
		if b["nodeId"] == node["id"] {
			agentToken = token
		} else {
			continue
		}
		admin := a.token
		a.token = agentToken
		a.call("POST", "/api/agent/v1/commands/"+jobID+"/result", Object{"status": "completed", "result": Object{}}, 200)
		a.token = admin
	}
	binding, err := one(context.Background(), a.server.DB, `SELECT to_jsonb(b) FROM "PanelClientBinding" b WHERE "subscriptionId"=$1 AND "nodeId"=$2 AND "userId"=$3`, sub["id"], node["id"], user["id"])
	if err != nil {
		a.t.Fatal(err)
	}
	return node, token, binding
}
func (a *testAPI) loginUser(user Object) string {
	admin := a.token
	a.token = ""
	session := a.call("POST", "/api/auth/login", Object{"email": user["email"], "password": "  exact-password  "}, 200)
	a.token = admin
	return text(session, "accessToken")
}
func TestMultiSessionRevocationAndConcurrencyPolicyAcrossNodes(t *testing.T) {
	a := newTestAPI(t)
	user := a.createUser()
	plan := a.createPlan("personal")
	sub := a.call("POST", "/api/admin/subscriptions", Object{"userId": user["id"], "planId": plan["id"], "expireAt": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}, 200)
	nodeA, tokenA, bindingA := a.readyBinding(user, sub)
	nodeB, _, _ := a.readyBinding(user, sub)
	// Authorizing a second node intentionally refreshes the first node's desired account.
	jobs, err := list(context.Background(), a.server.DB, `SELECT jsonb_build_object('id',id) FROM "NodeCommandJob" WHERE "bindingId"=$1 AND "commandType"='ENSURE_USER' AND status='pending'`, bindingA["id"])
	if err != nil {
		t.Fatal(err)
	}
	admin := a.token
	a.token = tokenA
	for _, job := range jobs {
		a.call("POST", "/api/agent/v1/commands/"+text(job, "id")+"/result", Object{"status": "completed", "result": Object{}}, 200)
	}
	a.token = admin
	a.call("PUT", "/api/admin/users/"+text(user, "id")+"/security", Object{"maxConcurrentSessionsOverride": 2}, 200)
	userToken := a.loginUser(user)
	a.token = userToken
	first := a.call("POST", "/api/client/session/connect", Object{"nodeId": nodeA["id"], "mode": "rule"}, 200)
	a.call("POST", "/api/client/session/connect", Object{"nodeId": nodeA["id"], "mode": "rule"}, 200)
	a.call("POST", "/api/client/session/connect", Object{"nodeId": nodeB["id"], "mode": "rule"}, 200)
	var status string
	if err = a.server.DB.QueryRow(context.Background(), `SELECT status FROM "PanelClientBinding" WHERE id=$1`, bindingA["id"]).Scan(&status); err != nil || status != "active" {
		t.Fatal("同节点仍有有效会话时不应停用账号", status, err)
	}
	a.call("POST", "/api/client/session/connect", Object{"nodeId": nodeB["id"], "mode": "rule"}, 200)
	if err = a.server.DB.QueryRow(context.Background(), `SELECT status FROM "PanelClientBinding" WHERE id=$1`, bindingA["id"]).Scan(&status); err != nil || status != "disabled" {
		t.Fatal("最后一个旧节点会话被逐出后必须停用旧节点账号", status, err)
	}
	heartbeat := a.call("POST", "/api/client/session/heartbeat", Object{"sessionId": first["sessionId"]}, 200)
	if heartbeat["status"] != "evicted" {
		t.Fatal("旧租约仍可续租")
	}
	a.token = admin
	a.call("PUT", "/api/admin/users/"+text(user, "id")+"/security", Object{"maxConcurrentSessionsOverride": 1}, 200)
	var count int
	if err = a.server.DB.QueryRow(context.Background(), `SELECT count(*) FROM "NodeSessionLease" WHERE "userId"=$1 AND status='active'`, user["id"]).Scan(&count); err != nil || count != 1 {
		t.Fatal("后台安全策略未收敛到一个会话", count, err)
	}
	var terminal string
	if err = a.server.DB.QueryRow(context.Background(), `SELECT id FROM "NodeCommandJob" WHERE "bindingId"=$1 AND "commandType"='DISABLE_USER' AND status='pending' ORDER BY "targetRevision" DESC LIMIT 1`, bindingA["id"]).Scan(&terminal); err != nil {
		t.Fatal(err)
	}
	a.token = tokenA
	a.call("POST", "/api/agent/v1/commands/"+terminal+"/result", Object{"status": "completed", "result": Object{"disableWatermarks": []any{}}}, 200)
	// Wait for the scheduled provisioning pass to finish, without a database poll.
	a.server.tasks.wg.Wait()
	if err = a.server.DB.QueryRow(context.Background(), `SELECT status FROM "PanelClientBinding" WHERE id=$1`, bindingA["id"]).Scan(&status); err != nil || status != "disabled" {
		t.Fatal("撤销回执不应自动重新启用旧账号", status, err)
	}
}
func TestConcurrentAgentClaimsAreExclusiveAndDedupePayloadIsImmutable(t *testing.T) {
	a := newTestAPI(t)
	node, token := a.createNode()
	id := text(node, "id")
	key := "dedupe-" + newID()
	payload := Object{"users": []any{}}
	job := a.call("POST", "/api/admin/nodes/"+id+"/agent-commands", Object{"type": "RECONCILE_USERS", "payload": payload, "dedupeKey": key}, 200)
	same := a.call("POST", "/api/admin/nodes/"+id+"/agent-commands", Object{"type": "RECONCILE_USERS", "payload": payload, "dedupeKey": key}, 200)
	if job["commandId"] != same["commandId"] {
		t.Fatal("重试生成了不同命令")
	}
	a.call("POST", "/api/admin/nodes/"+id+"/agent-commands", Object{"type": "RECONCILE_USERS", "payload": Object{"users": []string{"changed"}}, "dedupeKey": key}, 409)
	var agentID string
	if err := a.server.DB.QueryRow(context.Background(), `SELECT id FROM "NodeAgent" WHERE "nodeId"=$1`, id).Scan(&agentID); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make(chan []Object, 2)
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			jobs, err := a.server.claimAgentCommands(context.Background(), agentID)
			results <- jobs
			errs <- err
		}()
	}
	wg.Wait()
	close(results)
	close(errs)
	count := 0
	for jobs := range results {
		count += len(jobs)
	}
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if count != 1 {
		t.Fatal("同一命令被多个 SSE 连接重复领取", count)
	}
	a.token = token
	a.call("POST", "/api/agent/v1/commands/"+text(job, "commandId")+"/result", Object{"status": "completed", "result": Object{}}, 200)
}
func TestNodeDeletionWaitsForTerminalSettlementAndPreservesAgent(t *testing.T) {
	a := newTestAPI(t)
	user := a.createUser()
	plan := a.createPlan("personal")
	sub := a.call("POST", "/api/admin/subscriptions", Object{"userId": user["id"], "planId": plan["id"], "expireAt": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}, 200)
	node, agentToken, binding := a.readyBinding(user, sub)
	id := text(node, "id")
	admin := a.token
	a.call("DELETE", "/api/admin/nodes/"+id, nil, 409)
	var count int
	if err := a.server.DB.QueryRow(context.Background(), `SELECT count(*) FROM "NodeAgent" WHERE "nodeId"=$1`, id).Scan(&count); err != nil || count != 1 {
		t.Fatal("未结算时不应级联删除 Agent", count, err)
	}
	var commandID string
	if err := a.server.DB.QueryRow(context.Background(), `SELECT id FROM "NodeCommandJob" WHERE "bindingId"=$1 AND "commandType"='DISABLE_USER' AND status='pending'`, binding["id"]).Scan(&commandID); err != nil {
		t.Fatal(err)
	}
	a.token = agentToken
	a.call("POST", "/api/agent/v1/commands/"+commandID+"/result", Object{"status": "completed", "result": Object{"disableWatermarks": []any{}}}, 200)
	a.token = admin
	a.call("DELETE", "/api/admin/nodes/"+id, nil, 200)
}
func TestSharedQuotaRefreshIsQueuedForEveryActiveNode(t *testing.T) {
	a := newTestAPI(t)
	user := a.createUser()
	plan := a.createPlan("personal")
	sub := a.call("POST", "/api/admin/subscriptions", Object{"userId": user["id"], "planId": plan["id"], "expireAt": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}, 200)
	_, agentToken, binding := a.readyBinding(user, sub)
	other, _, _ := a.readyBinding(user, sub)
	a.token = agentToken
	a.call("POST", "/api/agent/v1/usage-batches", Object{"bootId": "quota-boot", "sequence": "1", "sampledAt": now(), "samples": []Object{{"bindingId": binding["id"], "counterGeneration": "1", "uplinkBytes": "100", "downlinkBytes": "0", "uplinkDeltaBytes": "100", "downlinkDeltaBytes": "0"}}}, 200)
	var remaining string
	if err := a.server.DB.QueryRow(context.Background(), `SELECT payload->>'quotaRemainingBytes' FROM "NodeCommandJob" WHERE "subscriptionId"=$1 AND "nodeId"=$2 AND "commandType"='REFRESH_QUOTA' AND status='pending' ORDER BY "targetRevision" DESC LIMIT 1`, sub["id"], other["id"]).Scan(&remaining); err != nil || remaining != "10737418140" {
		t.Fatal("其他节点没有收到共享剩余配额", remaining, err)
	}
}

// Keep real HTTP response handling available to concurrent-request tests without mutating a.token.
func concurrentJSON(client *http.Client, base, token, path string, input Object) (Object, error) {
	raw, _ := json.Marshal(input)
	request, _ := http.NewRequest("POST", base+path, bytes.NewReader(raw))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, err
	}
	if response.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d: %s", response.StatusCode, body)
	}
	var result Object
	err = json.Unmarshal(body, &result)
	return result, err
}
