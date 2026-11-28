package api

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func leaseOrderedNodes(f *leasePolicyFixture) (int, int) {
	if text(f.nodes[0], "id") < text(f.nodes[1], "id") {
		return 0, 1
	}
	return 1, 0
}

func leaseNodeLockProbe(t *testing.T, a *testAPI, nodeID string, wantLocked bool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	tx, err := a.server.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	_, err = tx.Exec(ctx, `SELECT id FROM "Node" WHERE id=$1 FOR UPDATE NOWAIT`, nodeID)
	var pgErr *pgconn.PgError
	locked := errors.As(err, &pgErr) && pgErr.Code == "55P03"
	if (err != nil && !locked) || locked != wantLocked {
		t.Errorf("Node NOWAIT实际锁状态=%t，期望=%t：%v", locked, wantLocked, err)
	}
}

func leaseWaitNodeBlock(t *testing.T, a *testAPI, pid int, done <-chan leaseHTTPResult) {
	t.Helper()
	deadline := time.Now().Add(4 * time.Second)
	for {
		select {
		case result := <-done:
			t.Fatalf("真实请求未等待完整Node集合：%d %v", result.status, result.err)
		default:
		}
		var waiting int
		if err := a.server.DB.QueryRow(context.Background(), `SELECT count(*) FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))`, pid).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting > 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("真实请求未到达精确Node行锁屏障")
		}
		// Bounded test-only lock observation, never application polling.
		time.Sleep(5 * time.Millisecond)
	}
}

func leaseGuardLowerNode(t *testing.T, a *testAPI, lower, higher string, invoke func(context.Context) <-chan leaseHTTPResult) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	guard, err := a.server.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer guard.Rollback(context.Background())
	var pid int
	if err = guard.QueryRow(ctx, `SELECT pg_backend_pid() FROM "Node" WHERE id=$1 FOR UPDATE`, lower).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	done := invoke(ctx)
	leaseWaitNodeBlock(t, a, pid, done)
	// No later Node FK or FOR UPDATE may be held while waiting for the first Node.
	leaseNodeLockProbe(t, a, higher, false)
	if err = guard.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	result := <-done
	if result.err != nil || result.status != 200 {
		t.Fatal("释放完整Node集合屏障后请求必须完成", result.status, result.err)
	}
}

func TestLeasePolicyNodeScopeIncludesAccessAndHistoricalLeaseHTTP(t *testing.T) {
	for _, source := range []string{"access_without_binding", "lease_without_binding_or_access"} {
		t.Run(source, func(t *testing.T) {
			f := newLeasePolicyFixture(t, false, 2)
			low, high := leaseOrderedNodes(f)
			if source == "lease_without_binding_or_access" {
				at := time.Now().UTC()
				f.seed(t, "history-without-binding", low, at, at, at.Add(time.Hour))
				meteringExec(t, f.a, `DELETE FROM "SubscriptionNodeAccess" WHERE "subscriptionId"=$1 AND "nodeId"=$2`, f.sub["id"], f.nodes[low]["id"])
			}
			meteringExec(t, f.a, `DELETE FROM "PanelClientBinding" WHERE id=$1`, f.bindings[low]["id"])
			leaseGuardLowerNode(t, f.a, text(f.nodes[low], "id"), text(f.nodes[high], "id"), func(ctx context.Context) <-chan leaseHTTPResult {
				// A node mutation must prelock other nodes of every affected subscription.
				return leaseAsyncRequest(ctx, f.a, "PATCH", "/api/admin/nodes/"+text(f.nodes[high], "id"), `{"name":"节点锁顺序"}`)
			})
		})
	}
}

func TestLeasePolicyNodeAccessPrelocksValidatedNewTargetsHTTP(t *testing.T) {
	f := newLeasePolicyFixture(t, false, 2)
	low, high := leaseOrderedNodes(f)
	meteringExec(t, f.a, `DELETE FROM "SubscriptionNodeAccess" WHERE "subscriptionId"=$1 AND "nodeId"=$2`, f.sub["id"], f.nodes[high]["id"])
	meteringExec(t, f.a, `DELETE FROM "PanelClientBinding" WHERE id=$1`, f.bindings[high]["id"])
	raw, _ := json.Marshal(Object{"nodeIds": []string{text(f.nodes[high], "id"), text(f.nodes[low], "id")}})
	leaseGuardLowerNode(t, f.a, text(f.nodes[low], "id"), text(f.nodes[high], "id"), func(ctx context.Context) <-chan leaseHTTPResult {
		return leaseAsyncRequest(ctx, f.a, "PUT", "/api/admin/subscriptions/"+text(f.sub, "id")+"/nodes", string(raw))
	})
	var accesses, bindings int
	err := f.a.server.DB.QueryRow(context.Background(), `SELECT (SELECT count(*) FROM "SubscriptionNodeAccess" WHERE "subscriptionId"=$1),(SELECT count(*) FROM "PanelClientBinding" WHERE "subscriptionId"=$1 AND status='active')`, f.sub["id"]).Scan(&accesses, &bindings)
	if err != nil || accesses != 2 || bindings != 2 {
		t.Fatal("新输入授权Node未正常创建Access和Binding", accesses, bindings, err)
	}
}

func TestLeasePolicyMeteringPrelocksBeforeIncomingNodeFKHTTP(t *testing.T) {
	f := newLeasePolicyFixture(t, false, 2)
	low, high := leaseOrderedNodes(f)
	token := f.nodeTokens[text(f.nodes[high], "id")]
	agent := &testAPI{t: t, server: f.a.server, http: f.a.http, token: token}
	raw, _ := json.Marshal(Object{"bootId": "boot-1", "sequence": "1", "sampledAt": now(), "samples": []any{Object{"bindingId": f.bindings[high]["id"], "counterGeneration": "1", "uplinkBytes": "10", "downlinkBytes": "0", "uplinkDeltaBytes": "10", "downlinkDeltaBytes": "0"}}})
	leaseGuardLowerNode(t, f.a, text(f.nodes[low], "id"), text(f.nodes[high], "id"), func(ctx context.Context) <-chan leaseHTTPResult {
		return leaseAsyncRequest(ctx, agent, "POST", "/api/agent/v1/usage-batches", string(raw))
	})
	var bytes string
	if err := f.a.server.DB.QueryRow(context.Background(), `SELECT "usedTrafficBytes"::text FROM "Subscription" WHERE id=$1`, f.sub["id"]).Scan(&bytes); err != nil || bytes != "10" {
		t.Fatal("真实计量批次未完成", bytes, err)
	}
}

func TestLeasePolicyRuntimeNodeScopeIsNotGlobal(t *testing.T) {
	a := newTestAPI(t)
	target, _ := a.createNode()
	unrelated, _ := a.createNode()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := a.server.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if err = lockRuntimeScope(ctx, tx, "nodeId", text(target, "id")); err != nil {
		t.Fatal(err)
	}
	leaseNodeLockProbe(t, a, text(target, "id"), true)
	leaseNodeLockProbe(t, a, text(unrelated, "id"), false)
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	t.Log("无订阅Node自身已锁定，独立Node仍可并行操作")
}

func TestLeasePolicyConcurrencyNodeScopeLeavesUnrelatedNodesConcurrent(t *testing.T) {
	f := newLeasePolicyFixture(t, false, 2)
	otherSub := f.a.call("POST", "/api/admin/subscriptions", Object{"userId": f.other["id"], "planId": f.plan["id"], "expireAt": time.Now().UTC().Add(time.Hour).Format(time.RFC3339)}, 200)
	otherNode, _, _ := f.a.readyBinding(f.other, otherSub)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := f.a.server.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if err = lockConcurrencyScope(ctx, tx, "user", text(f.user, "id")); err != nil {
		t.Fatal(err)
	}
	for _, node := range f.nodes {
		leaseNodeLockProbe(t, f.a, text(node, "id"), true)
	}
	leaseNodeLockProbe(t, f.a, text(otherNode, "id"), false)
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestLeasePolicyTeamSyncPrelocksAllSubscriptionsBeforeNodesHTTP(t *testing.T) {
	f := newLeasePolicyFixture(t, true, 2)
	low, high := leaseOrderedNodes(f)
	meteringExec(t, f.a, `DELETE FROM "SubscriptionNodeAccess" WHERE "subscriptionId"=$1 AND "nodeId"=$2`, f.sub["id"], f.nodes[low]["id"])
	meteringExec(t, f.a, `DELETE FROM "PanelClientBinding" WHERE "subscriptionId"=$1 AND "nodeId"=$2`, f.sub["id"], f.nodes[low]["id"])
	later, err := insert(context.Background(), f.a.server.DB, "Subscription", Object{"id": "zz-node-scope-" + newID(), "teamId": f.sub["teamId"], "planId": f.plan["id"], "totalTrafficGb": 10, "usedTrafficGb": 0, "remainingTrafficGb": 10, "totalTrafficBytes": 10737418240, "usedTrafficBytes": 0, "expireAt": time.Now().UTC().Add(time.Hour), "state": "active", "renewable": true, "lastSyncedAt": now()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = insert(context.Background(), f.a.server.DB, "SubscriptionNodeAccess", Object{"subscriptionId": later["id"], "nodeId": f.nodes[low]["id"]}); err != nil {
		t.Fatal(err)
	}
	if _, err = insert(context.Background(), f.a.server.DB, "PanelClientBinding", Object{"subscriptionId": later["id"], "teamId": f.sub["teamId"], "userId": f.user["id"], "nodeId": f.nodes[low]["id"], "panelClientEmail": "scope-" + newID(), "panelClientId": newID(), "panelInboundId": 0, "source": "direct", "status": "active"}); err != nil {
		t.Fatal(err)
	}
	leaseGuardLowerNode(t, f.a, text(f.nodes[low], "id"), text(f.nodes[high], "id"), func(ctx context.Context) <-chan leaseHTTPResult {
		return leaseAsyncRequest(ctx, f.a, "PATCH", "/api/admin/teams/"+text(f.sub, "teamId"), `{"name":"完整订阅Node锁"}`)
	})
	var nodes int
	err = f.a.server.DB.QueryRow(context.Background(), `SELECT count(DISTINCT "nodeId") FROM "NodeCommandJob" WHERE "subscriptionId"=ANY($1::text[]) AND "commandType"='ENSURE_USER' AND status='pending'`, []string{text(f.sub, "id"), text(later, "id")}).Scan(&nodes)
	if err != nil || nodes != 2 {
		t.Fatal("多订阅同步必须正常为两个Node排命令", nodes, err)
	}
}

func TestLeasePolicyConversionPrelocksPersonalAndTeamNodesHTTP(t *testing.T) {
	f := newLeasePolicyFixture(t, false, 2)
	low, high := leaseOrderedNodes(f)
	meteringExec(t, f.a, `DELETE FROM "SubscriptionNodeAccess" WHERE "subscriptionId"=$1 AND "nodeId"=$2`, f.sub["id"], f.nodes[low]["id"])
	meteringExec(t, f.a, `DELETE FROM "PanelClientBinding" WHERE "subscriptionId"=$1 AND "nodeId"=$2`, f.sub["id"], f.nodes[low]["id"])
	team := f.a.call("POST", "/api/admin/teams", Object{"name": "Node锁转换", "ownerUserId": f.other["id"]}, 200)
	plan := f.a.createPlan("team")
	sub := f.a.call("POST", "/api/admin/teams/"+text(team, "id")+"/subscriptions", Object{"planId": plan["id"], "expireAt": time.Now().UTC().Add(time.Hour).Format(time.RFC3339)}, 200)
	f.a.call("PUT", "/api/admin/subscriptions/"+text(sub, "id")+"/nodes", Object{"nodeIds": []string{text(f.nodes[low], "id")}}, 200)
	at := time.Now().UTC()
	old := f.seed(t, "conversion", high, at, at, at.Add(time.Hour))
	raw, _ := json.Marshal(Object{"targetTeamId": team["id"]})
	leaseGuardLowerNode(t, f.a, text(f.nodes[low], "id"), text(f.nodes[high], "id"), func(ctx context.Context) <-chan leaseHTTPResult {
		return leaseAsyncRequest(ctx, f.a, "POST", "/api/admin/subscriptions/"+text(f.sub, "id")+"/convert-to-team", string(raw))
	})
	if f.row(t, text(old, "id"))["status"] != "revoked" {
		t.Fatal("转换未撤销个人旧租约")
	}
	var teamBinding int
	err := f.a.server.DB.QueryRow(context.Background(), `SELECT count(*) FROM "PanelClientBinding" WHERE "subscriptionId"=$1 AND "userId"=$2 AND "nodeId"=$3 AND status='active'`, sub["id"], f.user["id"], f.nodes[low]["id"]).Scan(&teamBinding)
	if err != nil || teamBinding != 1 {
		t.Fatal("转换未正常供给团队目标Node", teamBinding, err)
	}
}
