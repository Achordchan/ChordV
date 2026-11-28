package api

import (
	"context"
	"testing"
	"time"
)

func TestMeteringStateLegacyFallbackLatestAgentsAndDeterministicTies(t *testing.T) {
	f := newMeteringStateFixture(t)
	f.reset(t)
	clock := time.Now().UTC().Truncate(time.Millisecond)
	f.lease(t, "A", false, clock, false)
	f.incident(t, "A", "NODE_USER_SAMPLE_MISSING", "open", clock, clock)
	nodeID := text(f.nodes["A"], "id")
	meteringExec(t, f.a, `UPDATE "Node" SET "registrationStatus"=NULL WHERE id=$1`, nodeID)
	meteringExec(t, f.a, `UPDATE "NodeAgent" SET "revokedAt"=now() WHERE "nodeId"=$1`, nodeID)
	f.assertHTTP(t, "ok", nil)
	meteringExec(t, f.a, `DELETE FROM "NodeAgent" WHERE "nodeId"=$1`, nodeID)
	f.assertHTTP(t, "degraded", "流量统计正在校准，请稍后查看")
	meteringExec(t, f.a, `UPDATE "Node" SET "controlStatus"='offline' WHERE id=$1`, nodeID)
	f.assertHTTP(t, "ok", nil)
	// Equal lastSeenAt falls through createdAt then id; revoked newer rows are ignored.
	for _, row := range []struct {
		id, status        string
		created, lastSeen time.Time
		revoked           any
	}{
		{"agent-a", "online", clock, clock, nil},
		{"agent-b", "offline", clock, clock, nil},
		{"agent-c", "online", clock.Add(time.Second), clock, clock},
	} {
		meteringExec(t, f.a, `INSERT INTO "NodeAgent"(id,"agentId","nodeId","tokenHash","tokenPrefix",status,"xrayStatus","createdAt","updatedAt","lastSeenAt","revokedAt") VALUES($1,$1,$2,$1,'fixture',$3,'healthy',$4,$4,$5,$6)`, row.id, nodeID, row.status, row.created, row.lastSeen, row.revoked)
	}
	f.assertHTTP(t, "ok", nil)
	var adminNode Object
	for _, candidate := range f.a.array("/api/admin/nodes") {
		if candidate["id"] == nodeID {
			adminNode = candidate
		}
	}
	if adminNode == nil {
		t.Fatal("管理端节点缺失")
	}
	if text(adminNode["agent"].(map[string]any), "id") != "agent-b" {
		t.Fatal("管理端Agent选择与计量投影tie-break不一致")
	}
	meteringExec(t, f.a, `UPDATE "NodeAgent" SET "createdAt"=$1 WHERE id='agent-a'`, clock.Add(time.Second))
	f.assertHTTP(t, "degraded", "流量统计正在校准，请稍后查看")
	meteringExec(t, f.a, `UPDATE "NodeAgent" SET "lastSeenAt"=$1 WHERE id='agent-b'`, clock.Add(time.Second))
	f.assertHTTP(t, "ok", nil)
	meteringExec(t, f.a, `UPDATE "NodeAgent" SET "lastSeenAt"=NULL WHERE id='agent-b'`)
	f.assertHTTP(t, "degraded", "流量统计正在校准，请稍后查看")
}

func TestMeteringStateLeaseTieBreakGraceBoundaryAndTransactionVisibility(t *testing.T) {
	f := newMeteringStateFixture(t)
	f.reset(t)
	clock := time.Now().UTC().Truncate(time.Millisecond)
	leaseA := f.lease(t, "A", false, clock, false)
	leaseB := f.lease(t, "B", false, clock, false)
	f.incident(t, "A", "NODE_USER_SAMPLE_MISSING", "open", clock, clock)
	meteringExec(t, f.a, `UPDATE "NodeSessionLease" SET id=CASE WHEN id=$1 THEN 'lease-a' ELSE 'lease-b' END WHERE id IN($1,$2)`, leaseA["id"], leaseB["id"])
	f.assertHTTP(t, "ok", nil)
	meteringExec(t, f.a, `UPDATE "NodeSessionLease" SET "createdAt"=$1 WHERE id='lease-a'`, clock.Add(time.Second))
	f.assertHTTP(t, "degraded", "流量统计正在校准，请稍后查看")
	meteringExec(t, f.a, `UPDATE "NodeSessionLease" SET "updatedAt"=$1 WHERE id='lease-b'`, clock.Add(time.Second))
	f.assertHTTP(t, "ok", nil)
	meteringExec(t, f.a, `UPDATE "NodeSessionLease" SET "lastHeartbeatAt"=$1 WHERE id='lease-a'`, clock.Add(time.Second))
	f.assertHTTP(t, "degraded", "流量统计正在校准，请稍后查看")
	meteringExec(t, f.a, `DELETE FROM "MeteringIncident"`)
	f.incident(t, "A", "NODE_METERING_UNAVAILABLE", "open", clock.Add(-90*time.Second), clock.Add(-90*time.Second))
	for _, sample := range []struct {
		at     time.Time
		status string
	}{{clock.Add(-time.Millisecond), "ok"}, {clock, "degraded"}} {
		state, err := subscriptionMeteringState(context.Background(), f.a.server.DB, text(f.user, "id"), text(f.sub, "id"), sample.at)
		if err != nil || state["meteringStatus"] != sample.status {
			t.Fatal("90秒边界错误", state, err)
		}
	}
	tx, err := f.a.server.DB.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(context.Background(), `UPDATE "MeteringIncident" SET reason='NODE_USER_SAMPLE_MISSING'`); err != nil {
		t.Fatal(err)
	}
	state, err := subscriptionMeteringState(context.Background(), tx, text(f.user, "id"), text(f.sub, "id"), clock.Add(-time.Second))
	if err != nil || state["meteringMessage"] != "流量统计正在校准，请稍后查看" {
		t.Fatal("投影必须使用调用者事务而非新连接", state, err)
	}
}
