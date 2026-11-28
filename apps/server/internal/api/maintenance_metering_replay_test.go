package api

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"
)

func TestMaintenanceRedactionPreservesOldBootReplayAndTerminalWatermarkHTTP(t *testing.T) {
	a := newTestAPI(t)
	user := a.createUser()
	plan := a.createPlan("personal")
	sub := a.call("POST", "/api/admin/subscriptions", Object{"userId": user["id"], "planId": plan["id"], "expireAt": time.Now().UTC().Add(time.Hour).Format(time.RFC3339)}, 200)
	node, token, binding := a.readyBinding(user, sub)
	sampled := time.Now().UTC().Add(-40 * 24 * time.Hour).Truncate(time.Second).Format(time.RFC3339)
	batch := func(sequence, up int) Object {
		return Object{"bootId": "retained-old-boot", "sequence": fmt.Sprint(sequence), "sampledAt": sampled, "samples": []Object{{"bindingId": binding["id"], "counterGeneration": "1", "uplinkBytes": fmt.Sprint(up), "downlinkBytes": "0", "uplinkDeltaBytes": fmt.Sprint(up), "downlinkDeltaBytes": "0"}}}
	}
	a.token = token
	for sequence := 1; sequence <= 2; sequence++ {
		if result := a.call("POST", "/api/agent/v1/usage-batches", batch(sequence, sequence*100), 200); result["ackThrough"] != fmt.Sprint(sequence) {
			t.Fatal("初始真实计量水位错误", result)
		}
	}
	oldBatchRows, err := list(context.Background(), a.server.DB, `SELECT to_jsonb(b)-'payload'-'createdAt' FROM "NodeUsageBatch" b WHERE "nodeId"=$1 ORDER BY sequence`, node["id"])
	if err != nil {
		t.Fatal(err)
	}
	meteringExec(t, a, `UPDATE "NodeUsageBatch" SET "createdAt"=$1 WHERE "nodeId"=$2`, time.Now().UTC().Add(-40*24*time.Hour), node["id"])
	before := policySchemaDigest(t, a)
	if err = a.server.reclaimMeteringHistory(context.Background()); err != nil {
		t.Fatal(err)
	}
	rows, err := list(context.Background(), a.server.DB, `SELECT to_jsonb(b)-'payload'-'createdAt' FROM "NodeUsageBatch" b WHERE "nodeId"=$1 ORDER BY sequence`, node["id"])
	if err != nil || !reflect.DeepEqual(oldBatchRows, rows) {
		t.Fatal("清载荷改变了批次行/哈希/序列/accountedAt", err)
	}
	var empty int
	if err = a.server.DB.QueryRow(context.Background(), `SELECT count(*) FROM "NodeUsageBatch" WHERE "nodeId"=$1 AND payload='{}'::jsonb`, node["id"]).Scan(&empty); err != nil || empty != 2 {
		t.Fatal("未清空已入账旧载荷", empty, err)
	}
	watermarks := Object{"nodeId": node["id"], "directDisableWatermarks": []any{Object{"bootId": "retained-old-boot", "sequenceThrough": "2"}}}
	if err = assertTerminalSettled(context.Background(), a.server.DB, watermarks); err != nil {
		t.Fatal("清理后终结水位必须仍可结算", err)
	}
	watermarks["directDisableWatermarks"] = []any{Object{"bootId": "retained-old-boot", "sequenceThrough": "3"}}
	if err = assertTerminalSettled(context.Background(), a.server.DB, watermarks); !errors.Is(err, errResetSettling) {
		t.Fatal("缺失水位负控不应放行", err)
	}
	a.call("POST", "/api/agent/v1/usage-batches", Object{"bootId": "newer-boot", "sequence": "1", "sampledAt": now(), "samples": []Object{}}, 200)
	replayed := a.call("POST", "/api/agent/v1/usage-batches", batch(1, 100), 200)
	if replayed["duplicate"] != true || replayed["ackThrough"] != "2" {
		t.Fatal("切回旧boot必须跨保留行连续确认，不可出现永久序列缺口", replayed)
	}
	a.call("POST", "/api/agent/v1/usage-batches", batch(1, 101), 409)
	after := policySchemaDigest(t, a)
	for _, table := range []string{"TrafficLedger", "TrafficSnapshot", "Subscription", "PanelClientBinding"} {
		if !reflect.DeepEqual(before[table], after[table]) {
			t.Error("已入账重放不得再次扣费或改变计量账本", table)
		}
	}
}

func TestMaintenanceMeteringTablesCrossChunkBoundary(t *testing.T) {
	f := newMeteringStateFixture(t)
	a := f.a
	before := time.Now().UTC().Add(-100 * 24 * time.Hour)
	meteringExec(t, a, `INSERT INTO "NodeUsageBatch"(id,"nodeId","agentId","bootId",sequence,"payloadHash",payload,"sampledAt","createdAt","accountedAt") SELECT 'bulk-'||g,$1,a.id,'bulk-retention',g,'hash','{"raw":true}',$2,$2,$2 FROM "NodeAgent" a CROSS JOIN generate_series(1,5001) g WHERE a."nodeId"=$1`, f.nodes["A"]["id"], before)
	meteringExec(t, a, `INSERT INTO "MeteringIncident"(id,"subscriptionId","nodeId",reason,status,"openedAt","createdAt","updatedAt") SELECT 'bulk-'||g,$1,$2,'bulk-retention','resolved',$3,$3,$3 FROM generate_series(1,5001) g`, f.sub["id"], f.nodes["A"]["id"], before)
	for _, statement := range []string{redactUsagePayloadsSQL, pruneMeteringIncidentsSQL} {
		q := &retentionExecAdapter{queryer: a.server.DB}
		if n, err := retentionChunks(context.Background(), q, statement, before.Add(time.Second)); err != nil || n != 5001 || q.calls != 2 {
			t.Fatal("计量表5001行必须分两次提交", n, q.calls, err)
		}
	}
}
