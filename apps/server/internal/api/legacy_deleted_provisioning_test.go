package api

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestSavingNodeAccessRestoresSettledLegacyDeletedBindingHTTP(t *testing.T) {
	for _, tc := range []struct {
		name, watermarks    string
		keepAccess, settles bool
		unready             bool
	}{
		{"still-authorized-and-settled", `[]`, true, true, false},
		{"still-authorized-but-waiting-for-final-usage", `[{"bootId":"legacy-boot","sequenceThrough":"2"}]`, true, false, false},
		{"no-longer-authorized", `[]`, false, false, false},
		{"still-authorized-but-node-not-ready", `[]`, true, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newLegacyDeletedBindingFixture(t)
			f.markDeleted(t, tc.watermarks)
			if tc.unready {
				meteringExec(t, f.a, `UPDATE "Node" SET "inboundAppliedRevision"=0 WHERE id=$1`, f.nodeID)
			}
			nodeIDs := []string{}
			if tc.keepAccess {
				nodeIDs = append(nodeIDs, f.nodeID)
			}
			f.a.call("PUT", "/api/admin/subscriptions/"+f.subID+"/nodes", Object{"nodeIds": nodeIDs}, 200)
			f.verify(t, tc.settles, 120)
		})
	}
}

func TestHistoricalRemoveSettlesThroughAgentHTTP(t *testing.T) {
	f := newLegacyDeletedBindingFixture(t)
	f.markDeleted(t, nil)
	ctx := context.Background()
	tx, err := f.a.server.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	// Materialize the old pending REMOVE command in its production table. Go no longer
	// creates this history on normal node remove, so use the shared queue writer as a fixture.
	job, err := f.a.server.queueBinding(ctx, tx, f.binding, "REMOVE_USER")
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	f.a.call("PUT", "/api/admin/subscriptions/"+f.subID+"/nodes", Object{"nodeIds": []string{f.nodeID}}, 200)
	f.verify(t, false, 120)

	reportPath := "/api/agent/v1/commands/" + text(job, "id") + "/result"
	report := Object{"status": "completed", "result": Object{"disableWatermarks": []Object{{"bootId": "legacy-boot", "sequenceThrough": "2"}}}}
	meteringExec(t, f.a, `UPDATE "PanelClientBinding" SET "directRevision"="directRevision"+1 WHERE id=$1`, f.bindingID)
	f.agent.call("POST", reportPath, report, 409)
	meteringExec(t, f.a, `UPDATE "PanelClientBinding" SET "directRevision"=$2::bigint WHERE id=$1`, f.bindingID, job["targetRevision"])
	f.agent.call("POST", reportPath, report, 200)
	f.verify(t, false, 120)
	wake, unsubscribe := f.a.server.events.subscribe("agent:" + f.nodeID)
	defer unsubscribe()
	f.sendUsage("2", "180", "40", "80", "20")
	f.waitForProvisioning(t, f.a.server, wake)
	f.verify(t, true, 220)
	// The newly installed account starts its own counters at zero; the first
	// new sample extends, rather than replaces, the previous subscription total.
	f.sendUsage("3", "30", "5", "30", "5")
	var used int64
	if err := f.a.server.DB.QueryRow(ctx, `SELECT "usedTrafficBytes" FROM "Subscription" WHERE id=$1`, f.subID).Scan(&used); err != nil || used != 255 {
		t.Fatalf("恢复后的首笔流量应累加到 255，实际=%d，err=%v", used, err)
	}
}

func TestStartupRestoresSettledLegacyDeletedBindingHTTP(t *testing.T) {
	f := newLegacyDeletedBindingFixture(t)
	// Only the old binding/assignment survives, with no Go resume marker or later Agent event.
	f.markDeleted(t, `[]`)
	f.a.http.Close()
	f.a.server.Close()
	s := New(f.a.server.DB, f.a.server.Config)
	t.Cleanup(s.Close)
	wake, unsubscribe := s.events.subscribe("agent:" + f.nodeID)
	defer unsubscribe()
	if err := s.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	stopTestMaintenance(s)
	f.waitForProvisioning(t, s, wake)
	f.verify(t, true, 120)
}

func TestConnectingRestoresLegacyDeletedBindingWithFreshUUIDHTTP(t *testing.T) {
	f := newLegacyDeletedBindingFixture(t)
	f.markDeleted(t, `[]`)
	client := &testAPI{t: t, http: f.a.http, token: f.a.loginUser(f.user)}
	wake, unsubscribe := f.a.server.events.subscribe("agent:" + f.nodeID)
	defer unsubscribe()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	connected := leaseAsyncRequest(ctx, client, "POST", "/api/client/session/connect", fmt.Sprintf(`{"nodeId":%q,"mode":"rule"}`, f.nodeID))
	f.waitForProvisioning(t, f.a.server, wake)
	f.verify(t, true, 120)
	job, err := one(ctx, f.a.server.DB, `SELECT jsonb_build_object('id',id,'uuid',payload->>'uuid') FROM "NodeCommandJob" WHERE "bindingId"=$1 AND "commandType"='ENSURE_USER' AND status='pending'`, f.bindingID)
	if err != nil {
		t.Fatal(err)
	}
	f.agent.call("POST", "/api/agent/v1/commands/"+text(job, "id")+"/result", Object{"status": "completed", "result": Object{}}, 200)
	if result := <-connected; result.err != nil || result.status != 200 {
		t.Fatalf("节点供给确认后应能连接：status=%d err=%v", result.status, result.err)
	}
	var uuid string
	if err := f.a.server.DB.QueryRow(ctx, `SELECT "xrayUserUuid" FROM "NodeSessionLease" WHERE "subscriptionId"=$1 AND "nodeId"=$2 AND status='active'`, f.subID, f.nodeID).Scan(&uuid); err != nil || uuid != job["uuid"] || uuid == f.binding["panelClientId"] {
		t.Fatal("客户端连接租约未使用节点新凭据", err)
	}
}

type legacyDeletedBindingFixture struct {
	a, agent                 *testAPI
	user, binding            Object
	subID, nodeID, bindingID string
}

func newLegacyDeletedBindingFixture(t *testing.T) legacyDeletedBindingFixture {
	t.Helper()
	a := newTestAPI(t)
	user, plan := a.createUser(), a.createPlan("personal")
	sub := a.call("POST", "/api/admin/subscriptions", Object{"userId": user["id"], "planId": plan["id"], "expireAt": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}, 200)
	node, token, binding := a.readyBinding(user, sub)
	f := legacyDeletedBindingFixture{a: a, agent: &testAPI{t: t, server: a.server, http: a.http, token: token}, user: user, binding: binding, subID: text(sub, "id"), nodeID: text(node, "id"), bindingID: text(binding, "id")}
	f.sendUsage("1", "100", "20", "100", "20")
	// Drain the healthy fixture's earlier Agent wakes before introducing the legacy row.
	// Tests below must observe recovery from their own PUT, final batch, or new Start.
	tasks := a.server.tasks
	tasks.mu.Lock()
	for key, timer := range tasks.timers {
		if strings.HasPrefix(key, "provision") {
			timer.Stop()
			delete(tasks.timers, key)
		}
	}
	tasks.mu.Unlock()
	tasks.wg.Wait()
	return f
}

func (f legacyDeletedBindingFixture) sendUsage(seq, up, down, upDelta, downDelta string) {
	f.agent.call("POST", "/api/agent/v1/usage-batches", Object{"bootId": "legacy-boot", "sequence": seq, "sampledAt": now(), "samples": []Object{{"bindingId": f.bindingID, "counterGeneration": "1", "uplinkBytes": up, "downlinkBytes": down, "uplinkDeltaBytes": upDelta, "downlinkDeltaBytes": downDelta}}}, 200)
}

func (f legacyDeletedBindingFixture) markDeleted(t *testing.T, watermarks any) {
	t.Helper()
	// The old REMOVE_USER path retains the binding and accounting baseline until its terminal samples are billed.
	meteringExec(t, f.a, `UPDATE "PanelClientBinding" SET status='deleted',"directDisabledAt"=now(),"directDisableWatermarks"=$2::jsonb WHERE id=$1`, f.bindingID, watermarks)
}

func (f legacyDeletedBindingFixture) waitForProvisioning(t *testing.T, s *Server, events <-chan Object) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for {
		var exists bool
		err := s.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM "NodeCommandJob" WHERE "bindingId"=$1 AND "commandType"='ENSURE_USER' AND status='pending')`, f.bindingID).Scan(&exists)
		if err != nil || exists {
			if err != nil {
				t.Fatal(err)
			}
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal("已结算关闭任务没有通过事件自动排入新节点供给")
		case <-events:
		}
	}
}

func (f legacyDeletedBindingFixture) verify(t *testing.T, restored bool, wantUsed int64) {
	t.Helper()
	ctx := context.Background()
	got, err := one(ctx, f.a.server.DB, `SELECT to_jsonb(b) FROM "PanelClientBinding" b WHERE b."subscriptionId"=$1 AND b."userId"=$2 AND b."nodeId"=$3`, f.subID, f.binding["userId"], f.nodeID)
	if err != nil || got["id"] != f.bindingID || got["panelClientEmail"] != f.binding["panelClientEmail"] {
		t.Fatalf("应复用原绑定记录和邮箱：id=%v err=%v", got["id"], err)
	}
	wantStatus, wantUp, wantDown, wantCount := "deleted", int64(100), int64(20), 0
	if restored {
		wantStatus, wantUp, wantDown, wantCount = "active", 0, 0, 1
		if uuid := text(got, "panelClientId"); uuid == "" || uuid == f.binding["panelClientId"] || got["directDisabledAt"] != nil || got["directDisableWatermarks"] != nil {
			t.Fatal("已恢复绑定必须更换节点 UUID 并清除停用状态")
		}
	} else if got["panelClientId"] != f.binding["panelClientId"] || got["directDisabledAt"] == nil {
		t.Fatal("尚未恢复的绑定不得修改凭据或停用状态")
	}
	if got["status"] != wantStatus {
		t.Fatalf("绑定状态=%v，期望=%s", got["status"], wantStatus)
	}
	var up, down, used int64
	err = f.a.server.DB.QueryRow(ctx, `SELECT p."uplinkBytes",p."downlinkBytes",s."usedTrafficBytes" FROM "TrafficSnapshot" p JOIN "Subscription" s ON s.id=p."subscriptionId" WHERE p."nodeId"=$1 AND s.id=$2 AND p."userId"=$3`, f.nodeID, f.subID, f.binding["userId"]).Scan(&up, &down, &used)
	if err != nil || up != wantUp || down != wantDown || used != wantUsed {
		t.Fatalf("节点计数基线=%d/%d，订阅累计=%d，期望=%d/%d、%d，err=%v", up, down, used, wantUp, wantDown, wantUsed, err)
	}
	var count, pending, matching int
	err = f.a.server.DB.QueryRow(ctx, `SELECT count(*),count(*) FILTER (WHERE status='pending'),count(*) FILTER (WHERE status='pending' AND payload->>'uuid'=$2) FROM "NodeCommandJob" WHERE "bindingId"=$1 AND "commandType"='ENSURE_USER'`, f.bindingID, got["panelClientId"]).Scan(&count, &pending, &matching)
	if err != nil || count != 1+wantCount || pending != wantCount || matching != wantCount {
		t.Fatalf("应为原绑定新增 %d 条使用当前 UUID 的供给，实际新增=%d pending=%d matching=%d err=%v", wantCount, count-1, pending, matching, err)
	}
}
