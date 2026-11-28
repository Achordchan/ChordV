package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"
)

func TestCommandRetryRejectsStaleOrUnsupportedTargets(t *testing.T) {
	for _, test := range []struct {
		name, table, column string
		value               any
		status              int
	}{
		{"failed-not-exhausted", "NodeCommandJob", "status", "failed", 404},
		{"disable-is-dismiss-only", "NodeCommandJob", "commandType", "DISABLE_USER", 409},
		{"remove-is-dismiss-only", "NodeCommandJob", "commandType", "REMOVE_USER", 409},
		{"quota-is-dismiss-only", "NodeCommandJob", "commandType", "REFRESH_QUOTA", 409},
		{"disabled-binding", "PanelClientBinding", "status", "disabled", 409},
		{"inactive-node", "Node", "isActive", false, 409},
		{"unregistered-node", "Node", "registrationStatus", "pending_register", 409},
		{"unapplied-inbound", "Node", "inboundAppliedRevision", 0, 409},
		{"placeholder-host", "Node", "serverHost", "pending-agent", 409},
		{"non-direct-node", "Node", "controlMode", "shadow_direct", 409},
		{"revoked-agent", "NodeAgent", "revokedAt", now(), 409},
		{"expired-subscription", "Subscription", "expireAt", time.Now().Add(-time.Hour).UTC().Format(time.RFC3339), 409},
		{"exhausted-subscription", "Subscription", "remainingTrafficGb", 0, 409},
	} {
		t.Run(test.name, func(t *testing.T) {
			a := newTestAPI(t)
			fixture := a.cancelledCommand()
			id := map[string]string{"NodeCommandJob": text(fixture.job, "id"), "PanelClientBinding": text(fixture.binding, "id"), "Node": text(fixture.node, "id"), "Subscription": text(fixture.binding, "subscriptionId"), "NodeAgent": text(fixture.job, "agentId")}[test.table]
			if _, err := update(context.Background(), a.server.DB, test.table, id, Object{test.column: test.value}, test.column); err != nil {
				t.Fatal(err)
			}
			if test.value == "DISABLE_USER" || test.value == "REMOVE_USER" {
				if _, err := update(context.Background(), a.server.DB, "PanelClientBinding", text(fixture.binding, "id"), Object{"status": "disabled"}, "status"); err != nil {
					t.Fatal(err)
				}
			}
			a.call("POST", "/api/admin/nodes/node-command-jobs/"+text(fixture.job, "id")+"/retry", Object{}, test.status)
			var count int
			if err := a.server.DB.QueryRow(context.Background(), `SELECT count(*) FROM "NodeCommandJob" WHERE "bindingId"=$1`, fixture.binding["id"]).Scan(&count); err != nil || count != 1 {
				t.Fatal("拒绝的重试产生了额外命令", count, err)
			}
			queue := a.call("GET", "/api/admin/nodes/node-command-jobs?nodeId="+text(fixture.node, "id"), nil, 200)
			queueJob(t, queue, text(fixture.job, "id"))
			assertQueueOutstanding(t, queue, fixture, 1)
		})
	}
}

func TestConcurrentCommandRetryOnlyQueuesOneReplacement(t *testing.T) {
	a := newTestAPI(t)
	fixture := a.cancelledCommand()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	gate, err := a.server.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer gate.Rollback(context.Background())
	var gatePID int
	if err = gate.QueryRow(ctx, `SELECT pg_backend_pid() FROM "Subscription" WHERE id=$1 FOR UPDATE`, fixture.binding["subscriptionId"]).Scan(&gatePID); err != nil {
		t.Fatal(err)
	}
	type result struct {
		status int
		queue  Object
		err    error
	}
	results := make(chan result, 2)
	for i := 0; i < 2; i++ {
		go func() {
			req, _ := http.NewRequestWithContext(ctx, "POST", a.http.URL+"/api/admin/nodes/node-command-jobs/"+text(fixture.job, "id")+"/retry", nil)
			req.Header.Set("Authorization", "Bearer "+a.token)
			response, err := a.http.Client().Do(req)
			if err != nil {
				results <- result{err: err}
				return
			}
			defer response.Body.Close()
			raw, err := io.ReadAll(response.Body)
			queue := Object{}
			if err == nil {
				err = json.Unmarshal(raw, &queue)
			}
			results <- result{status: response.StatusCode, queue: queue, err: err}
		}()
	}
	// Bounded test-only lock observation makes both requests reach the same
	// subscription gate before release; no sleep-based concurrency guess.
	tick := time.NewTicker(5 * time.Millisecond)
	defer tick.Stop()
	for {
		var blocked int
		if err = a.server.DB.QueryRow(ctx, `WITH RECURSIVE blocked(pid) AS(SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) UNION SELECT p.pid FROM pg_stat_activity p JOIN blocked b ON b.pid=ANY(pg_blocking_pids(p.pid))) SELECT count(*) FROM blocked`, gatePID).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked >= 2 {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("两个重试请求没有同时到达数据库锁门禁")
		case <-tick.C:
		}
	}
	if err = gate.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	counts := map[int]int{}
	for i := 0; i < 2; i++ {
		response := <-results
		if response.err != nil {
			t.Fatal(response.err)
		}
		counts[response.status]++
		if response.status == 200 {
			queueJobs(t, response.queue)
		}
	}
	if counts[200] != 1 || counts[404] != 1 {
		t.Fatal("同一失败任务只能有一个请求成功", counts)
	}
	queue := a.call("GET", "/api/admin/nodes/node-command-jobs?nodeId="+text(fixture.node, "id"), nil, 200)
	assertNoQueueJob(t, queue, text(fixture.job, "id"))
	if len(queueJobs(t, queue)) != 1 {
		t.Fatal("并发重试生成了多个待处理替代任务")
	}
	assertQueueOutstanding(t, queue, fixture, 1)
}
