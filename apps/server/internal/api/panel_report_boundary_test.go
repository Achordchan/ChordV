package api

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
)

func TestPanelReportContractIdentityGuardsHaveNoWritesHTTP(t *testing.T) {
	f := newPanelReportFixture(t)
	f.a.token = f.adminToken
	otherNode, otherToken := f.a.createNode()
	f.drainSuccess(t)
	var otherAgent string
	if err := f.a.server.DB.QueryRow(context.Background(), `SELECT id FROM "NodeAgent" WHERE "nodeId"=$1`, otherNode["id"]).Scan(&otherAgent); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, token string
		changes     Object
		status      int
	}{
		{"missing-auth", "", nil, 401}, {"invalid-auth", "chordv_agent_invalid", nil, 401},
		{"admin-is-not-agent", f.adminToken, nil, 401}, {"foreign-agent", otherToken, nil, 404},
		{"job-node-mismatch", f.agentToken, Object{"nodeId": otherNode["id"]}, 404},
		{"job-agent-mismatch", f.agentToken, Object{"agentId": otherAgent}, 404},
	} {
		t.Run(test.name, func(t *testing.T) {
			f.reset(t, nil, test.changes)
			f.a.token = test.token
			f.unchanged(t, f.input, test.status)
		})
	}
	f.reset(t, nil, nil)
	original := f.jobID
	f.jobID = newID()
	f.unchanged(t, f.input, 404)
	f.jobID = original
	if _, err := f.a.server.DB.Exec(context.Background(), `UPDATE "NodeAgent" SET "revokedAt"=now() WHERE id=$1`, f.job["agentId"]); err != nil {
		t.Fatal(err)
	}
	f.unchanged(t, f.input, 401)
}

func TestPanelReportContractConfirmedTagAndCanonicalRevalidationHTTP(t *testing.T) {
	f := newPanelReportFixture(t)
	confirmed := panelCanonical(t, f.job["payload"])
	confirmed["inboundTag"], confirmed["tagOverrideConfirmed"] = "actual-runtime", true
	f.reset(t, nil, Object{"payload": confirmed})
	bad := panelCanonical(t, f.input)
	bad["result"].(map[string]any)["inbound"].(map[string]any)["inboundTag"] = "different-tag"
	f.unchanged(t, bad, 400)
	status, _ := f.request(t, f.input)
	if status != 200 {
		t.Fatal("已确认且相同tag应正常完成", status)
	}
	f.drainSuccess(t)
	canonical := panelCanonical(t, f.job["payload"])
	canonical["serverHost"] = " 127.0.0.1 "
	canonical["realityPublicKey"] = "\ufeff " + canonical["realityPublicKey"].(string) + " \u00a0"
	canonical["shortId"], canonical["flow"], canonical["fingerprint"], canonical["spiderX"] = nil, nil, nil, nil
	canonical["serverNames"], canonical["panelVersion"] = []any{" example.com "}, " v3.1.0 "
	f.reset(t, nil, Object{"payload": canonical})
	status, _ = f.request(t, f.input)
	if status != 200 {
		t.Fatal("回执比较前必须重规范化旧排队payload", status)
	}
	node, job := f.rows(t)
	if node["serverHost"] != "127.0.0.1" || node["serverName"] != "example.com" || node["fingerprint"] != "chrome" {
		t.Fatal("Node未存规范公共参数", node)
	}
	canonical["inboundTag"], canonical["tagOverrideConfirmed"] = "actual-runtime", true
	if !reflect.DeepEqual(job["payload"], map[string]any(canonical)) {
		t.Fatal("应只冻结实际tag，不改写旧payload其他字段")
	}
	f.drainSuccess(t)
	for _, changes := range []Object{{"panelVersion": "2.0.0"}, {"realityPublicKey": "bad-key"}, {"serverNames": []any{}}, {"listenPort": "443"}, {"inboundTag": "not-confirmed"}, {"rotateKeys": true}} {
		payload := panelCanonical(t, f.job["payload"])
		for key, value := range changes {
			payload[key] = value
		}
		f.reset(t, nil, Object{"payload": payload})
		f.unchanged(t, f.input, 400)
	}
}

func TestPanelReportContractJSONNumericPortAndExactBigintRevisionHTTP(t *testing.T) {
	f := newPanelReportFixture(t)
	for _, value := range []json.Number{"443.0", "4.43e2"} {
		f.reset(t, nil, nil)
		input := panelCanonical(t, f.input)
		input["result"].(map[string]any)["inbound"].(map[string]any)["serverPort"] = value
		status, _ := f.request(t, input)
		if status != 200 {
			t.Fatal("同一JSON数字语义不应按词面拒绝", value, status)
		}
		f.drainSuccess(t)
	}
	f.reset(t, Object{"inboundAppliedRevision": "9007199254740992"}, Object{"targetRevision": "9007199254740993"})
	status, _ := f.request(t, f.input)
	if status != 200 {
		t.Fatal("相邻bigint revision不得经float舍入后误拒绝", status)
	}
	var exact string
	if err := f.a.server.DB.QueryRow(context.Background(), `SELECT "inboundAppliedRevision"::text FROM "Node" WHERE id=$1`, f.nodeID).Scan(&exact); err != nil || exact != "9007199254740993" {
		t.Fatal("回执revision不精确", exact, err)
	}
	f.drainSuccess(t)
	f.reset(t, Object{"inboundAppliedRevision": "9007199254740993"}, Object{"targetRevision": "9007199254740992"})
	f.unchanged(t, f.input, 400)
}

func TestPanelReportContractNonPanelCompletionKeepsDedupeAndNodeHTTP(t *testing.T) {
	f := newPanelReportFixture(t)
	f.reset(t, nil, Object{"commandType": "RECONCILE_USERS", "payload": Object{"users": []any{}}})
	nodeBefore, jobBefore := f.rows(t)
	before := policySchemaDigest(t, f.a)
	status, _ := f.request(t, Object{"status": "completed", "result": nil})
	if status != 200 {
		t.Fatal("非panel合法命令回执被新增校验误伤", status)
	}
	nodeAfter, jobAfter := f.rows(t)
	if !reflect.DeepEqual(nodeBefore, nodeAfter) || jobAfter["dedupeKey"] != jobBefore["dedupeKey"] || !reflect.DeepEqual(jobBefore["payload"], jobAfter["payload"]) || jobAfter["status"] != "completed" || !reflect.DeepEqual(jobAfter["result"], Object{}) {
		t.Fatal("非panel回执改动Node/dedupe/payload或未完成")
	}
	after := policySchemaDigest(t, f.a)
	for table, digest := range before {
		if table != "NodeCommandJob" && !reflect.DeepEqual(digest, after[table]) {
			t.Errorf("非panel完成改动无关表:%s", table)
		}
	}
	f.drainSuccess(t)
}
