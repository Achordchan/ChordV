package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestLeasePolicyPlanInsertPhantomRollsBackHTTP(t *testing.T) {
	for _, insertNew := range []bool{false, true} {
		t.Run(fmt.Sprintf("insert_new_%t", insertNew), func(t *testing.T) { leasePlanInsertPhantomHTTP(t, insertNew) })
	}
}

func leasePlanInsertPhantomHTTP(t *testing.T, insertNew bool) Object {
	a := newTestAPI(t)
	u, v := a.createUser(), a.createUser()
	plan, otherPlan := a.createPlan("personal"), a.createPlan("personal")
	sub := a.call("POST", "/api/admin/subscriptions", Object{"userId": u["id"], "planId": plan["id"], "expireAt": time.Now().UTC().Add(time.Hour).Format(time.RFC3339)}, 200)
	historical := a.call("POST", "/api/admin/subscriptions", Object{"userId": v["id"], "planId": otherPlan["id"], "expireAt": time.Now().UTC().Add(time.Hour).Format(time.RFC3339)}, 200)
	// Force the already-scoped subscription first: its real lease/audit writes
	// must roll back when the later unknown subscription is detected.
	originalID := text(sub, "id")
	sub["id"] = "000-plan-scope-" + newID()
	meteringExec(t, a, `UPDATE "Subscription" SET id=$2 WHERE id=$1`, originalID, sub["id"])
	node, _, binding := a.readyBinding(u, sub)
	for i := range 2 {
		at := time.Now().UTC().Add(time.Duration(-i) * time.Second)
		if _, err := insert(context.Background(), a.server.DB, "NodeSessionLease", Object{"sessionId": "phantom-" + newID(), "userId": u["id"], "subscriptionId": sub["id"], "nodeId": node["id"], "xrayUserEmail": binding["panelClientEmail"], "xrayUserUuid": binding["panelClientId"], "issuedAt": at, "lastHeartbeatAt": at, "expiresAt": at.Add(time.Hour), "connectionMode": "rule"}); err != nil {
			t.Fatal(err)
		}
	}
	a.call("PUT", "/api/admin/subscriptions/"+text(historical, "id")+"/nodes", Object{"nodeIds": []string{text(node, "id")}}, 200)
	// A normal historical subscription remains discoverable through its binding;
	// expiry lets the real admin creation contract create a replacement below.
	meteringExec(t, a, `UPDATE "Subscription" SET state='expired',"expireAt"=now()-interval '1 hour' WHERE id=$1`, historical["id"])
	beforePlan := planSecurityRecord(t, a, text(plan, "id"))
	client := &testAPI{t: t, server: a.server, http: a.http, token: a.loginUser(u)}
	stream, _ := client.eventStream("/api/client/events", "")
	waitLiveEvent(t, stream, func(e liveEvent) bool { return e.data["type"] == "ticket_updated" })
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	guard, err := a.server.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer guard.Rollback(context.Background())
	var guardPID int
	// This blocks the real updater's FOR UPDATE but permits an INSERT's FK
	// KEY SHARE, so insertion genuinely commits after scope snapshot/recheck.
	if err = guard.QueryRow(ctx, `SELECT pg_backend_pid() FROM "Plan" WHERE id=$1 FOR NO KEY UPDATE`, plan["id"]).Scan(&guardPID); err != nil {
		t.Fatal(err)
	}
	updating := leaseAsyncRequest(ctx, a, "PUT", "/api/admin/plans/"+text(plan, "id")+"/security", `{"maxConcurrentSessions":1}`)
	var planPID int
	deadline := time.Now().Add(4 * time.Second)
	for {
		err = a.server.DB.QueryRow(ctx, `SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%"Plan"%FOR UPDATE%'`, guardPID).Scan(&planPID)
		if err == nil {
			break
		}
		select {
		case result := <-updating:
			t.Fatal("Plan HTTP未到达精确Plan行锁屏障", result.status, result.err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("Plan真实HTTP未到达scope之后的Plan行锁", err)
		}
		time.Sleep(5 * time.Millisecond)
	}
	leaseNodeLockProbe(t, a, text(node, "id"), true)
	var inserted Object
	if insertNew {
		raw, _ := json.Marshal(Object{"userId": v["id"], "planId": plan["id"], "expireAt": time.Now().UTC().Add(time.Hour).Format(time.RFC3339)})
		creating := leaseAsyncRequest(ctx, a, "POST", "/api/admin/subscriptions", string(raw))
		select {
		case result := <-creating:
			if result.err != nil || result.status != 200 {
				t.Fatal("scope后真实新Sub创建未提交", result.status, result.err)
			}
		case <-ctx.Done():
			t.Fatal("Plan门闩不允许新Sub FK提交，不能据此证明phantom")
		}
		inserted, err = one(ctx, a.server.DB, `SELECT to_jsonb(s) FROM "Subscription" s WHERE "userId"=$1 AND "planId"=$2`, v["id"], plan["id"])
		if err != nil {
			t.Fatal(err)
		}
		probe, err := a.server.DB.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		_, probeErr := probe.Exec(ctx, `SELECT id FROM "Subscription" WHERE id=$1 FOR UPDATE NOWAIT`, inserted["id"])
		probe.Rollback(context.Background())
		if probeErr != nil {
			t.Fatal("晚插入Sub在scope后应尚未被Plan HTTP预锁", probeErr)
		}
	}
	enforcing := leaseAsyncRequest(ctx, a, "PUT", "/api/admin/users/"+text(v, "id")+"/security", `{"maxConcurrentSessionsOverride":1}`)
	deadline = time.Now().Add(4 * time.Second)
	for {
		var n int
		if err = a.server.DB.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%"Node"%'`, planPID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n == 1 {
			break
		}
		select {
		case result := <-enforcing:
			t.Fatal("User HTTP未等待Plan HTTP已持有Node", result.status, result.err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("User真实HTTP未到Node屏障")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if insertNew {
		probe, err := a.server.DB.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		_, probeErr := probe.Exec(ctx, `SELECT id FROM "Subscription" WHERE id=$1 FOR UPDATE NOWAIT`, inserted["id"])
		probe.Rollback(context.Background())
		var pgErr *pgconn.PgError
		if !errors.As(probeErr, &pgErr) || pgErr.Code != "55P03" {
			t.Fatal("User HTTP应已实际持有晚插入Sub，NOWAIT必须返回55P03", probeErr)
		}
	}
	beforeRelease := policySchemaDigest(t, a)
	if err = guard.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	planResult, userResult := <-updating, <-enforcing
	if planResult.err != nil || userResult.err != nil {
		t.Fatal("两真实HTTP未取终态", planResult.err, userResult.err)
	}
	if insertNew {
		if planResult.status != 409 || userResult.status != 200 {
			t.Fatal("晚插入必须明确409回滚，另一个真实请求正常完成", planResult.status, userResult.status)
		}
		if !reflect.DeepEqual(beforePlan, planSecurityRecord(t, a, text(plan, "id"))) {
			t.Fatal("409不得留下Plan写入")
		}
		afterRelease := policySchemaDigest(t, a)
		for table, digest := range beforeRelease {
			if table != "User" && !reflect.DeepEqual(afterRelease[table], digest) {
				t.Error("409整事务回滚后仅并发User安全保存可改变User表，其他表必须逐一相同", table)
			}
		}
	} else if planResult.status != 200 || userResult.status != 200 {
		t.Fatal("无插入反控应全部成功", planResult.status, userResult.status)
	}
	var active, audits int
	if err = a.server.DB.QueryRow(ctx, `SELECT (SELECT count(*) FROM "NodeSessionLease" WHERE "userId"=$1 AND status='active'),(SELECT count(*) FROM "SecurityEvent" WHERE "userId"=$1)`, u["id"]).Scan(&active, &audits); err != nil {
		t.Fatal(err)
	}
	if (insertNew && (active != 2 || audits != 0)) || (!insertNew && (active != 1 || audits != 1)) {
		t.Fatal("原scope已执行的租约/审计写入必须全部回滚；无插入则正常收敛", active, audits)
	}
	events := leaseEventsThroughBarrier(t, a, userSecurityStream{target: text(u, "id"), events: stream}, nil)
	subscriptions := 0
	for _, event := range events {
		if event["type"] == "subscription_updated" {
			subscriptions++
		}
		if insertNew && event["type"] == "session_revoked" {
			t.Fatal("回滚的租约/审计不得发布撤销事件", event)
		}
	}
	if subscriptions != 1 {
		t.Fatal("并发create或成功Plan仅各自产生一次已提交更新，409不得多发事件", subscriptions, events)
	}
	if insertNew {
		a.call("PUT", "/api/admin/plans/"+text(plan, "id")+"/security", Object{"maxConcurrentSessions": 1}, 200)
		if err = a.server.DB.QueryRow(ctx, `SELECT count(*) FROM "NodeSessionLease" WHERE "userId"=$1 AND status='active'`, u["id"]).Scan(&active); err != nil || active != 1 {
			t.Fatal("明确重提Plan后必须按包含新Sub的完整scope正常收敛", active, err)
		}
	}
	var schema string
	if err = a.server.DB.QueryRow(ctx, `SELECT current_schema()`).Scan(&schema); err != nil {
		t.Fatal(err)
	}
	t.Log("Plan phantom real HTTP result", insertNew, planResult.status, userResult.status, "schema", schema)
	return Object{"insertNewAfterScope": insertNew, "schema": schema, "scopePassedBeforePlanWait": true, "existingNodeLockObserved": true, "lateSubInitiallyUnlocked": insertNew, "userHeldLateSubBeforeRelease": insertNew, "lateSubNOWAITConflictCode": "55P03 in insertion case; no probe in no-insert control", "planHTTP": planResult.status, "userHTTP": userResult.status, "conflictRejected": insertNew}
}

func TestLeasePolicyPlanScopeRejectsLateCreateChangeAndConnectHTTP(t *testing.T) {
	for _, action := range []string{"create", "change_plan"} {
		t.Run(action, func(t *testing.T) {
			a := newTestAPI(t)
			u, v := a.createUser(), a.createUser()
			target, other := a.createPlan("personal"), a.createPlan("personal")
			subA := a.call("POST", "/api/admin/subscriptions", Object{"userId": u["id"], "planId": target["id"], "expireAt": time.Now().UTC().Add(time.Hour).Format(time.RFC3339)}, 200)
			subB := a.call("POST", "/api/admin/subscriptions", Object{"userId": v["id"], "planId": other["id"], "expireAt": time.Now().UTC().Add(time.Hour).Format(time.RFC3339)}, 200)
			a.readyBinding(u, subA)
			nodeB, tokenB, _ := a.readyBinding(v, subB)
			if action == "create" {
				meteringExec(t, a, `UPDATE "Subscription" SET state='expired',"expireAt"=now()-interval '1 hour' WHERE id=$1`, subB["id"])
			}
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			guard, err := a.server.DB.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer guard.Rollback(context.Background())
			var pid int
			if err = guard.QueryRow(ctx, `SELECT pg_backend_pid() FROM "Plan" WHERE id=$1 FOR NO KEY UPDATE`, target["id"]).Scan(&pid); err != nil {
				t.Fatal(err)
			}
			updating := leaseAsyncRequest(ctx, a, "PUT", "/api/admin/plans/"+text(target, "id")+"/security", `{"maxConcurrentSessions":1}`)
			leaseWaitNodeBlock(t, a, pid, updating)
			if action == "create" {
				subB = a.call("POST", "/api/admin/subscriptions", Object{"userId": v["id"], "planId": target["id"], "expireAt": time.Now().UTC().Add(time.Hour).Format(time.RFC3339)}, 200)
				a.call("PUT", "/api/admin/subscriptions/"+text(subB, "id")+"/nodes", Object{"nodeIds": []string{text(nodeB, "id")}}, 200)

			} else {
				a.call("POST", "/api/admin/subscriptions/"+text(subB, "id")+"/change-plan", Object{"planId": target["id"]}, 200)
			}
			jobs, err := list(ctx, a.server.DB, `SELECT to_jsonb(j) FROM "NodeCommandJob" j WHERE "subscriptionId"=$1 AND "commandType"='ENSURE_USER' AND status='pending'`, subB["id"])
			if err != nil {
				t.Fatal(err)
			}
			agent := &testAPI{t: t, server: a.server, http: a.http, token: tokenB}
			for _, job := range jobs {
				agent.call("POST", "/api/agent/v1/commands/"+text(job, "id")+"/result", Object{"status": "completed", "result": Object{}}, 200)
			}
			client := &testAPI{t: t, server: a.server, http: a.http, token: a.loginUser(v)}
			for range 2 {
				client.call("POST", "/api/client/session/connect", Object{"nodeId": nodeB["id"], "mode": "rule"}, 200)
			}
			if err = guard.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			result := <-updating
			if result.err != nil || result.status != 409 {
				t.Fatal("late create/change-plan及真实新连接不能被忽略或补锁，Plan必须409", result.status, result.err)
			}
			var active int
			if err = a.server.DB.QueryRow(ctx, `SELECT count(*) FROM "NodeSessionLease" WHERE "userId"=$1 AND status='active'`, v["id"]).Scan(&active); err != nil || active != 2 {
				t.Fatal("被拒Plan不得部分改变已提交的新连接", active, err)
			}
			if number(planSecurityRecord(t, a, text(target, "id")), "maxConcurrentSessions") != 3 {
				t.Fatal("409的Plan写入未回滚")
			}
			a.call("PUT", "/api/admin/plans/"+text(target, "id")+"/security", Object{"maxConcurrentSessions": 1}, 200)
			if err = a.server.DB.QueryRow(ctx, `SELECT count(*) FROM "NodeSessionLease" WHERE "userId"=$1 AND status='active'`, v["id"]).Scan(&active); err != nil || active != 1 {
				t.Fatal("重新提交的完整scope必须覆盖晚create/change-plan及新连接并正常收敛", active, err)
			}
		})
	}
}
