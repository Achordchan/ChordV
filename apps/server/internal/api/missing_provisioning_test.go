package api

import (
	"context"
	"fmt"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"
)

func TestInboundReadyEventProvisionsPreviouslyAssignedMissingBindingHTTP(t *testing.T) {
	f := newPanelReportFixture(t)
	a := f.a
	a.token = f.adminToken
	user, plan := a.createUser(), a.createPlan("personal")
	sub := a.call("POST", "/api/admin/subscriptions", Object{"userId": user["id"], "planId": plan["id"], "expireAt": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}, 200)
	a.call("PUT", "/api/admin/subscriptions/"+text(sub, "id")+"/nodes", Object{"nodeIds": []string{f.nodeID}}, 200)
	var count int
	if err := a.server.DB.QueryRow(context.Background(), `SELECT count(*) FROM "PanelClientBinding" WHERE "subscriptionId"=$1`, sub["id"]).Scan(&count); err != nil || count != 0 {
		t.Fatal("未就绪节点不应提前供给", count, err)
	}
	waitLiveEvent(t, f.events, func(event liveEvent) bool { return event.data["type"] == "subscription_updated" })
	fresh, unsubscribe := a.server.events.subscribe("admin")
	defer unsubscribe()
	a.token = f.agentToken
	a.call("POST", "/api/agent/v1/commands/"+f.jobID+"/result", f.input, 200)
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	observed := false
	for !observed {
		select {
		case event := <-fresh:
			observed = event["type"] == "subscription_updated"
		case <-deadline.C:
			t.Fatal("入站完成未推送缺失账号供给事件")
		}
	}
	if err := a.server.DB.QueryRow(context.Background(), `SELECT count(*) FROM "PanelClientBinding" b JOIN "NodeCommandJob" j ON j."bindingId"=b.id WHERE b."subscriptionId"=$1 AND b."userId"=$2 AND b."nodeId"=$3 AND b.status='active' AND j."commandType"='ENSURE_USER' AND j.status='pending'`, sub["id"], user["id"], f.nodeID).Scan(&count); err != nil || count != 1 {
		t.Fatal("入站完成未自动供给已分配订阅", count, err)
	}
}

func TestStartupRecoversPersistedMissingTeamMemberWithoutReensuringOwnerHTTP(t *testing.T) {
	a := newTestAPI(t)
	owner, member := a.createUser(), a.createUser()
	team := a.call("POST", "/api/admin/teams", Object{"name": "启动恢复团队", "ownerUserId": owner["id"]}, 200)
	a.call("POST", "/api/admin/teams/"+text(team, "id")+"/members", Object{"userId": member["id"]}, 200)
	plan := a.createPlan("team")
	sub := a.call("POST", "/api/admin/teams/"+text(team, "id")+"/subscriptions", Object{"planId": plan["id"], "expireAt": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}, 200)
	node, _, ownerBinding := a.readyBinding(owner, sub)
	a.http.Close()
	a.server.Close()
	// Persisted assignment/member rows survive a legacy process that never committed this member's binding.
	meteringExec(t, a, `DELETE FROM "PanelClientBinding" WHERE "subscriptionId"=$1 AND "userId"=$2`, sub["id"], member["id"])
	ownerBefore, err := one(context.Background(), a.server.DB, `SELECT to_jsonb(b) FROM "PanelClientBinding" b WHERE id=$1`, ownerBinding["id"])
	if err != nil {
		t.Fatal(err)
	}
	s := New(a.server.DB, a.server.Config)
	t.Cleanup(s.Close)
	fresh, unsubscribe := s.events.subscribe("admin")
	defer unsubscribe()
	if err = s.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	stopTestMaintenance(s)
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	observed := false
	for !observed {
		select {
		case event := <-fresh:
			observed = event["type"] == "subscription_updated"
		case <-deadline.C:
			t.Fatal("新Server启动未恢复持久成员缺口")
		}
	}
	a.server = s
	a.http = httptest.NewServer(s.Handler())
	t.Cleanup(a.http.Close)
	var count int
	if err = s.DB.QueryRow(context.Background(), `SELECT count(*) FROM "PanelClientBinding" b JOIN "NodeCommandJob" j ON j."bindingId"=b.id WHERE b."subscriptionId"=$1 AND b."userId"=$2 AND b."nodeId"=$3 AND b.status='active' AND j."commandType"='ENSURE_USER'`, sub["id"], member["id"], node["id"]).Scan(&count); err != nil || count != 1 {
		t.Fatal("持久团队成员缺口未恢复", count, err)
	}
	ownerAfter, err := one(context.Background(), s.DB, `SELECT to_jsonb(b) FROM "PanelClientBinding" b WHERE id=$1`, ownerBinding["id"])
	if err != nil || !reflect.DeepEqual(ownerBefore, ownerAfter) {
		t.Fatal("启动恢复不应重签已有正常账号或覆盖计数", err)
	}
	if got := a.array("/api/admin/subscriptions"); len(got) != 1 {
		t.Fatal("恢复后HTTP读失败", got)
	}
}

func TestMissingProvisioningNeverRevivesIneligibleOrExistingAccounts(t *testing.T) {
	a := newTestAPI(t)
	user, plan := a.createUser(), a.createPlan("personal")
	sub := a.call("POST", "/api/admin/subscriptions", Object{"userId": user["id"], "planId": plan["id"], "expireAt": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}, 200)
	node, _, binding := a.readyBinding(user, sub)
	for _, sample := range []struct{ name, sql string }{
		{"disabled-user", `UPDATE "User" SET status='disabled' WHERE id=$1`},
		{"paused-subscription", `UPDATE "Subscription" SET state='paused' WHERE id=$2`},
		{"expired-subscription", `UPDATE "Subscription" SET "expireAt"=now()-interval '1 minute' WHERE id=$2`},
		{"exhausted-subscription", `UPDATE "Subscription" SET "remainingTrafficGb"=0 WHERE id=$2`},
		{"inactive-node", `UPDATE "Node" SET "isActive"=false WHERE id=$3`},
		{"unapplied-inbound", `UPDATE "Node" SET "inboundAppliedRevision"=0 WHERE id=$3`},
		{"pending-register", `UPDATE "Node" SET "registrationStatus"='pending_register' WHERE id=$3`},
		{"reset-in-flight", `INSERT INTO "SystemSetting"(key,value,"updatedAt") VALUES('traffic-reset:'||$2,'{}',now())`},
		{"existing-disabled", `UPDATE "PanelClientBinding" SET status='disabled' WHERE id=$4`},
		{"existing-deleted", `UPDATE "PanelClientBinding" SET status='deleted' WHERE id=$4`},
	} {
		t.Run(sample.name, func(t *testing.T) {
			meteringExec(t, a, `UPDATE "User" SET status='active' WHERE id=$1`, user["id"])
			meteringExec(t, a, `UPDATE "Subscription" SET state='active',"expireAt"=now()+interval '1 hour',"remainingTrafficGb"=10 WHERE id=$1`, sub["id"])
			meteringExec(t, a, `UPDATE "Node" SET "isActive"=true,"inboundAppliedRevision"=1,"registrationStatus"='agent_ready' WHERE id=$1`, node["id"])
			meteringExec(t, a, `DELETE FROM "SystemSetting" WHERE key=$1`, trafficResetKey(text(sub, "id")))
			if sample.name != "existing-disabled" && sample.name != "existing-deleted" {
				meteringExec(t, a, `DELETE FROM "PanelClientBinding" WHERE "subscriptionId"=$1`, sub["id"])
			} else {
				if _, err := one(context.Background(), a.server.DB, `SELECT to_jsonb(b) FROM "PanelClientBinding" b WHERE id=$1`, binding["id"]); err != nil {
					if binding, err = insert(context.Background(), a.server.DB, "PanelClientBinding", pick(binding, "id", "subscriptionId", "userId", "nodeId", "teamId", "panelClientEmail", "panelClientId", "panelInboundId", "source", "status")); err != nil {
						t.Fatal(err)
					}
				}
			}
			// Bind all setup parameters explicitly even when this single predicate uses only one.
			setup := `WITH args AS(SELECT $1::text AS uid,$2::text AS sid,$3::text AS nid,$4::text AS bid) ` + sample.sql
			meteringExec(t, a, setup, user["id"], sub["id"], node["id"], binding["id"])
			before, seq := policySchemaDigest(t, a), panelEventSequence(a)
			if err := a.server.repairMissingBindings(context.Background(), text(node, "id")); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(before, policySchemaDigest(t, a)) || seq != panelEventSequence(a) {
				t.Fatal("不合格或既有账号不得被补供给/排命令/发布成功事件")
			}
		})
	}
}

func TestMissingProvisioningCursorAndConcurrentEventsAreIdempotent(t *testing.T) {
	a := newTestAPI(t)
	user, plan := a.createUser(), a.createPlan("personal")
	sub := a.call("POST", "/api/admin/subscriptions", Object{"userId": user["id"], "planId": plan["id"], "expireAt": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}, 200)
	node, _, _ := a.readyBinding(user, sub)
	a.server.Close()
	// Use a real fixture password hash, not a production account or a credential placeholder.
	meteringExec(t, a, `INSERT INTO "User"(id,email,"displayName",role,status,"passwordHash","lastSeenAt","updatedAt") SELECT 'missing-user-'||lpad(g::text,3,'0'),'missing-user-'||g||'@example.com','缺口用户','user','active',u."passwordHash",now(),now() FROM "User" u CROSS JOIN generate_series(1,51)g WHERE u.id=$1`, user["id"])
	meteringExec(t, a, `INSERT INTO "Subscription"(id,"userId","planId","totalTrafficGb","usedTrafficGb","remainingTrafficGb","totalTrafficBytes","usedTrafficBytes","expireAt",state,renewable,"lastSyncedAt","updatedAt") SELECT 'missing-sub-'||lpad(g::text,3,'0'),'missing-user-'||lpad(g::text,3,'0'),$1,10,0,10,10737418240,0,now()+interval '1 hour','active',true,now(),now() FROM generate_series(1,51)g`, plan["id"])
	meteringExec(t, a, `INSERT INTO "SubscriptionNodeAccess"(id,"subscriptionId","nodeId","updatedAt") SELECT 'missing-access-'||g,'missing-sub-'||lpad(g::text,3,'0'),$1,now() FROM generate_series(1,51)g`, node["id"])
	done := make(chan error, 2)
	for range 2 {
		go func() { done <- a.server.repairMissingBindings(context.Background(), text(node, "id")) }()
	}
	for range 2 {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
	var bindings, commands int
	err := a.server.DB.QueryRow(context.Background(), `SELECT (SELECT count(*) FROM "PanelClientBinding" WHERE "subscriptionId" LIKE 'missing-sub-%'),(SELECT count(*) FROM "NodeCommandJob" WHERE "subscriptionId" LIKE 'missing-sub-%' AND "commandType"='ENSURE_USER')`).Scan(&bindings, &commands)
	if err != nil || bindings != 51 || commands != 51 {
		t.Fatal("分页或并发使成员缺口漏供/重复供给", bindings, commands, err)
	}
	before, seq := policySchemaDigest(t, a), panelEventSequence(a)
	if err = a.server.repairMissingBindings(context.Background(), ""); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, policySchemaDigest(t, a)) || seq != panelEventSequence(a) {
		t.Fatal("重复启动扫描必须无写入/新命令/事件")
	}
}

func TestBadResumeMarkerDoesNotStarveReadyEventMissingBindingHTTP(t *testing.T) {
	f := newPanelReportFixture(t)
	a := f.a
	a.token = f.adminToken
	plan := a.createPlan("personal")
	missingUser, resumeUser := a.createUser(), a.createUser()
	sub := func(user Object) Object {
		return a.call("POST", "/api/admin/subscriptions", Object{"userId": user["id"], "planId": plan["id"], "expireAt": time.Now().UTC().Add(time.Hour).Format(time.RFC3339)}, 200)
	}
	missingSub, resumeSub := sub(missingUser), sub(resumeUser)
	for _, subscription := range []Object{missingSub, resumeSub} {
		a.call("PUT", "/api/admin/subscriptions/"+text(subscription, "id")+"/nodes", Object{"nodeIds": []string{f.nodeID}}, 200)
	}
	binding, err := insert(context.Background(), a.server.DB, "PanelClientBinding", Object{"subscriptionId": resumeSub["id"], "userId": resumeUser["id"], "nodeId": f.nodeID, "panelClientEmail": "resume-" + newID(), "panelClientId": newID(), "panelInboundId": 0, "source": "direct", "status": "disabled", "directDisableWatermarks": []any{}})
	if err != nil {
		t.Fatal(err)
	}
	if err = a.server.saveSetting(context.Background(), "binding-resume:"+text(binding, "id"), Object{}); err != nil {
		t.Fatal(err)
	}
	meteringExec(t, a, fmt.Sprintf(`CREATE FUNCTION reject_one_resume() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF OLD.id='%s' THEN RAISE EXCEPTION 'round28 controlled bad resume'; END IF; RETURN NEW; END$$; CREATE TRIGGER reject_one_resume BEFORE UPDATE ON "PanelClientBinding" FOR EACH ROW EXECUTE FUNCTION reject_one_resume()`, text(binding, "id")))
	a.token = f.agentToken
	a.call("POST", "/api/agent/v1/commands/"+f.jobID+"/result", f.input, 200)
	// Test-only internal scheduler state has no SSE interface; observe every 50ms, stop after 3s.
	deadline := time.Now().Add(3 * time.Second)
	for {
		a.server.tasks.mu.Lock()
		failures := a.server.tasks.failures["provision:"+f.nodeID]
		a.server.tasks.mu.Unlock()
		if failures > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("真实入站事件未进入可观察失败的节点任务")
		}
		time.Sleep(50 * time.Millisecond)
	}
	var missing int
	if err = a.server.DB.QueryRow(context.Background(), `SELECT count(*) FROM "PanelClientBinding" WHERE "subscriptionId"=$1 AND "userId"=$2`, missingSub["id"], missingUser["id"]).Scan(&missing); err != nil {
		t.Fatal(err)
	}
	if missing != 1 {
		t.Fatalf("同节点坏resume marker不得阻断正常missing恢复；真实入站HTTP已成功、节点任务已失败退避，但missing bindings=%d", missing)
	}
}
