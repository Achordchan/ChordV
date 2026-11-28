package api

import (
	"context"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
)

func leaseHistoricalScope(t *testing.T, f *leasePolicyFixture) (Object, Object) {
	t.Helper()
	ctx := context.Background()
	sub, err := insert(ctx, f.a.server.DB, "Subscription", Object{"userId": f.user["id"], "planId": f.plan["id"], "totalTrafficGb": 10, "usedTrafficGb": 0, "remainingTrafficGb": 10, "totalTrafficBytes": 10737418240, "usedTrafficBytes": 0, "expireAt": time.Now().UTC().Add(30 * time.Minute), "state": "active", "renewable": true, "lastSyncedAt": now()})
	if err != nil {
		t.Fatal(err)
	}
	id := "zz-history-" + newID()
	meteringExec(t, f.a, `UPDATE "Subscription" SET id=$2 WHERE id=$1`, sub["id"], id)
	sub["id"] = id
	b, err := insert(ctx, f.a.server.DB, "PanelClientBinding", Object{"subscriptionId": id, "userId": f.user["id"], "nodeId": f.nodes[1]["id"], "panelClientEmail": "history-" + newID(), "panelClientId": newID(), "panelInboundId": 0, "source": "direct", "status": "active"})
	if err != nil {
		t.Fatal(err)
	}
	return sub, b
}

type leaseHTTPResult struct {
	status int
	err    error
}

func leaseAsyncRequest(ctx context.Context, a *testAPI, method, path, body string) <-chan leaseHTTPResult {
	done := make(chan leaseHTTPResult, 1)
	go func() {
		req, err := http.NewRequestWithContext(ctx, method, a.http.URL+path, strings.NewReader(body))
		if err != nil {
			done <- leaseHTTPResult{err: err}
			return
		}
		req.Header.Set("Authorization", "Bearer "+a.token)
		req.Header.Set("Content-Type", "application/json")
		res, err := a.http.Client().Do(req)
		if err != nil {
			done <- leaseHTTPResult{err: err}
			return
		}
		io.Copy(io.Discard, res.Body)
		res.Body.Close()
		done <- leaseHTTPResult{status: res.StatusCode}
	}()
	return done
}

func leaseAwaitBlocked(t *testing.T, a *testAPI, pid int, done <-chan leaseHTTPResult) bool {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		select {
		case result := <-done:
			t.Errorf("真实HTTP在应等待的历史订阅行锁释放前完成: status=%d err=%v", result.status, result.err)
			return false
		default:
		}
		var n int
		if err := a.server.DB.QueryRow(context.Background(), `SELECT count(*) FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))`, pid).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n > 0 {
			return true
		}
		if time.Now().After(deadline) {
			t.Fatal("真实HTTP未到达本次精确订阅行锁屏障")
		}
		// Bounded test-only PostgreSQL row-lock observation, never application polling.
		time.Sleep(5 * time.Millisecond)
	}
}

func TestLeasePolicyUserEnforcementWaitsForHistoricalSubscriptionHTTP(t *testing.T) {
	f := newLeasePolicyFixture(t, false, 2)
	history, binding := leaseHistoricalScope(t, f)
	at := time.Now().UTC()
	f.seed(t, "current", 0, at.Add(-10*time.Second), at.Add(-10*time.Second), at.Add(time.Hour))
	old := f.seed(t, "history", 1, at.Add(-100*time.Second), at.Add(-100*time.Second), at.Add(time.Hour))
	meteringExec(t, f.a, `UPDATE "NodeSessionLease" SET "subscriptionId"=$2,"xrayUserEmail"=$3,"xrayUserUuid"=$4 WHERE id=$1`, old["id"], history["id"], binding["panelClientEmail"], binding["panelClientId"])
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	guard, err := f.a.server.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer guard.Rollback(context.Background())
	var pid int
	if err = guard.QueryRow(ctx, `SELECT pg_backend_pid() FROM "Subscription" WHERE id=$1 FOR UPDATE`, history["id"]).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	done := leaseAsyncRequest(ctx, f.a, "PUT", "/api/admin/users/"+text(f.user, "id")+"/security", `{"maxConcurrentSessionsOverride":1}`)
	blocked := leaseAwaitBlocked(t, f.a, pid, done)
	probe, err := f.a.server.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	_, probeErr := probe.Exec(ctx, `SELECT id FROM "PanelClientBinding" WHERE id=$1 FOR UPDATE NOWAIT`, binding["id"])
	probe.Rollback(ctx)
	if probeErr != nil {
		t.Error("等待历史订阅时不应已改/锁历史binding；FK等待不能代替正确scope先锁", probeErr)
	}
	if err = guard.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if blocked {
		result := <-done
		if result.err != nil || result.status != 200 {
			t.Fatal("释放历史scope后必须完成", result.status, result.err)
		}
	}
}

func TestLeasePolicySubscriptionLocksHistoricalScopeInStableOrderHTTP(t *testing.T) {
	f := newLeasePolicyFixture(t, false, 2)
	history, _ := leaseHistoricalScope(t, f)
	at := time.Now().UTC()
	f.seed(t, "current", 0, at, at, at.Add(time.Hour))
	old := f.seed(t, "history", 1, at.Add(-time.Second), at.Add(-time.Second), at.Add(time.Hour))
	meteringExec(t, f.a, `UPDATE "NodeSessionLease" SET "subscriptionId"=$2 WHERE id=$1`, old["id"], history["id"])
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	guard, err := f.a.server.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer guard.Rollback(context.Background())
	var pid int
	if err = guard.QueryRow(ctx, `SELECT pg_backend_pid() FROM "Subscription" WHERE id=$1 FOR UPDATE`, f.sub["id"]).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	done := leaseAsyncRequest(ctx, f.a, "PATCH", "/api/admin/subscriptions/"+text(history, "id"), `{}`)
	blocked := leaseAwaitBlocked(t, f.a, pid, done)
	probe, err := f.a.server.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	_, probeErr := probe.Exec(ctx, `SELECT id FROM "Subscription" WHERE id=$1 FOR UPDATE NOWAIT`, history["id"])
	probe.Rollback(ctx)
	if probeErr != nil {
		t.Error("等待更早scope时不应已持有较晚历史订阅锁，否则两请求反序", probeErr)
	}
	if err = guard.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if blocked {
		result := <-done
		if result.err != nil || result.status != 200 {
			t.Fatal("释放有序scope后必须完成", result.status, result.err)
		}
	}
}

func TestLeasePolicyRechecksOwnershipAndPlanAfterScopeLockWait(t *testing.T) {
	for _, change := range []string{"membership", "plan"} {
		t.Run(change, func(t *testing.T) {
			f := newLeasePolicyFixture(t, change == "membership", 1)
			var replacement Object
			if change == "membership" {
				owner := f.a.createUser()
				replacement = f.a.call("POST", "/api/admin/teams", Object{"name": "并发归属目标", "ownerUserId": owner["id"]}, 200)
			} else {
				replacement = f.a.createPlan("personal")
			}
			at := time.Now().UTC()
			f.seed(t, "a", 0, at, at, at.Add(time.Hour))
			f.seed(t, "b", 0, at, at, at.Add(time.Hour))
			ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			defer cancel()
			guard, err := f.a.server.DB.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer guard.Rollback(context.Background())
			var pid int
			if err = guard.QueryRow(ctx, `SELECT pg_backend_pid() FROM "Subscription" WHERE id=$1 FOR UPDATE`, f.sub["id"]).Scan(&pid); err != nil {
				t.Fatal(err)
			}
			before := policySchemaDigest(t, f.a)
			done := leaseAsyncRequest(ctx, f.a, "PUT", "/api/admin/users/"+text(f.user, "id")+"/security", `{"maxConcurrentSessionsOverride":1}`)
			blocked := leaseAwaitBlocked(t, f.a, pid, done)
			if change == "membership" {
				meteringExec(t, f.a, `UPDATE "TeamMember" SET "teamId"=$2 WHERE "userId"=$1`, f.user["id"], replacement["id"])
			} else {
				if _, err = guard.Exec(ctx, `UPDATE "Subscription" SET "planId"=$2 WHERE id=$1`, f.sub["id"], replacement["id"]); err != nil {
					t.Fatal(err)
				}
			}
			if err = guard.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if blocked {
				res := <-done
				if res.err != nil || res.status != 409 {
					t.Fatal("加锁前后scope/归属变化必须409回滚而非用旧候选", res.status, res.err)
				}
			}
			after := policySchemaDigest(t, f.a)
			changedTable := "Subscription"
			if change == "membership" {
				changedTable = "TeamMember"
			}
			for table, digest := range before {
				if table != changedTable && !reflect.DeepEqual(digest, after[table]) {
					t.Error("等待时归属变化后只保留测试并发者修改，策略/租约/审计应回滚", table)
				}
			}
		})
	}
}
