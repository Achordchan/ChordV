package api

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"sort"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestLeasePolicyCrossUserNodeOrderHTTP(t *testing.T) {
	for _, reverse := range []bool{false, true} {
		t.Run(fmt.Sprintf("reverse_%t", reverse), func(t *testing.T) { leaseCrossUserNodeOrderHTTP(t, reverse) })
	}
}

func leaseCrossUserNodeOrderHTTP(t *testing.T, reverse bool) {
	a := newTestAPI(t)
	u, v := a.createUser(), a.createUser()
	plan := a.createPlan("personal")
	subs := []Object{}
	for _, user := range []Object{u, v} {
		subs = append(subs, a.call("POST", "/api/admin/subscriptions", Object{"userId": user["id"], "planId": plan["id"], "expireAt": time.Now().UTC().Add(time.Hour).Format(time.RFC3339)}, 200))
	}
	nodes := []Object{}
	tokens := map[string]string{}
	for range 2 {
		n, token := a.createNode()
		nodes = append(nodes, n)
		tokens[text(n, "id")] = token
		meteringExec(t, a, `UPDATE "Node" SET "isActive"=true,"inboundAppliedRevision"=1,"registrationStatus"='agent_ready',"serverHost"='127.0.0.1',"serverPort"=54321,"realityPublicKey"=$2,"serverName"='localhost' WHERE id=$1`, n["id"], base64.RawURLEncoding.EncodeToString(make([]byte, 32)))
	}
	sort.Slice(nodes, func(i, j int) bool { return text(nodes[i], "id") < text(nodes[j], "id") })
	if reverse {
		nodes[0], nodes[1] = nodes[1], nodes[0]
	}
	for _, sub := range subs {
		a.call("PUT", "/api/admin/subscriptions/"+text(sub, "id")+"/nodes", Object{"nodeIds": []string{text(nodes[0], "id"), text(nodes[1], "id")}}, 200)
	}
	admin := a.token
	jobs, err := list(context.Background(), a.server.DB, `SELECT to_jsonb(j) FROM "NodeCommandJob" j WHERE "commandType"='ENSURE_USER' AND status IN('pending','running','failed')`)
	if err != nil {
		t.Fatal(err)
	}
	for _, job := range jobs {
		a.token = tokens[text(job, "nodeId")]
		a.call("POST", "/api/agent/v1/commands/"+text(job, "id")+"/result", Object{"status": "completed", "result": Object{}}, 200)
	}
	a.token = admin
	for _, user := range []Object{u, v} {
		a.call("PUT", "/api/admin/users/"+text(user, "id")+"/security", Object{"maxConcurrentSessionsOverride": 1}, 200)
	}
	left := &testAPI{t: t, server: a.server, http: a.http, token: a.loginUser(u)}
	right := &testAPI{t: t, server: a.server, http: a.http, token: a.loginUser(v)}
	oldLeft := left.call("POST", "/api/client/session/connect", Object{"nodeId": nodes[1]["id"], "mode": "rule"}, 200)
	oldRight := right.call("POST", "/api/client/session/connect", Object{"nodeId": nodes[0]["id"], "mode": "rule"}, 200)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	g1, err := a.server.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer g1.Rollback(context.Background())
	g2, err := a.server.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer g2.Rollback(context.Background())
	key := int64(time.Now().UnixNano()&0xfffffff) + (1 << 50)
	var pid1, pid2 int
	if err = g1.QueryRow(ctx, `SELECT pg_backend_pid() FROM pg_advisory_xact_lock($1)`, key).Scan(&pid1); err != nil {
		t.Fatal(err)
	}
	if err = g2.QueryRow(ctx, `SELECT pg_backend_pid() FROM pg_advisory_xact_lock($1)`, key+1).Scan(&pid2); err != nil {
		t.Fatal(err)
	}
	meteringExec(t, a, fmt.Sprintf(`CREATE FUNCTION gate_lease_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.type='session_evicted' THEN IF NEW."userId"='%s' THEN PERFORM pg_advisory_xact_lock(%d::bigint); ELSIF NEW."userId"='%s' THEN PERFORM pg_advisory_xact_lock(%d::bigint); END IF; END IF; RETURN NEW; END$$; CREATE TRIGGER gate_lease_audit BEFORE INSERT ON "SecurityEvent" FOR EACH ROW EXECUTE FUNCTION gate_lease_audit()`, text(u, "id"), key, text(v, "id"), key+1))
	l := leaseAsyncRequest(ctx, left, "POST", "/api/client/session/connect", fmt.Sprintf(`{"nodeId":"%s","mode":"rule"}`, text(nodes[0], "id")))
	r := leaseAsyncRequest(ctx, right, "POST", "/api/client/session/connect", fmt.Sprintf(`{"nodeId":"%s","mode":"rule"}`, text(nodes[1], "id")))
	deadline := time.Now().Add(4 * time.Second)
	for {
		var waiting int
		if err = a.server.DB.QueryRow(ctx, `WITH RECURSIVE blocked(pid) AS (
 SELECT unnest(ARRAY[$1::int,$2::int])
 UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid))
 ) SELECT count(*) FROM blocked WHERE pid<>$1 AND pid<>$2`, pid1, pid2).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("两个真实HTTP未到达精确审计门闩或其Node阻塞链", waiting)
		}
		time.Sleep(5 * time.Millisecond)
	}
	var direct int
	if err = a.server.DB.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) OR $2=ANY(pg_blocking_pids(pid))`, pid1, pid2).Scan(&direct); err != nil {
		t.Fatal(err)
	}
	if direct != 1 {
		t.Errorf("全Node有序预锁必须使第二HTTP先等Node，不能各持新Node进入两个审计门闩：direct=%d", direct)
	}
	heldNodes := 0
	for _, node := range nodes {
		probe, err := a.server.DB.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		_, err = probe.Exec(ctx, `SELECT id FROM "Node" WHERE id=$1 FOR UPDATE NOWAIT`, node["id"])
		probe.Rollback(ctx)
		if err != nil {
			var pgErr *pgconn.PgError
			if !errors.As(err, &pgErr) || pgErr.Code != "55P03" {
				t.Fatal("Node NOWAIT必须是实际行锁冲突", err)
			}
			heldNodes++
		}
	}
	if heldNodes != 2 {
		t.Fatal("门闩时两个新Node行均应实际被持锁", heldNodes)
	}
	if err = g1.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = g2.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	lr, rr := <-l, <-r
	if lr.err != nil || rr.err != nil {
		t.Fatal("HTTP结果未取终态", lr.err, rr.err)
	}
	if lr.status != 200 || rr.status != 200 {
		t.Fatalf("互换Node必须全部完成而非死锁500：%d/%d", lr.status, rr.status)
	}
	for i, old := range []Object{oldLeft, oldRight} {
		user := []Object{u, v}[i]
		oldNode := nodes[1-i]
		newNode := nodes[i]
		lease, err := one(ctx, a.server.DB, `SELECT to_jsonb(l) FROM "NodeSessionLease" l WHERE id=$1`, old["leaseId"])
		if err != nil || lease["status"] != "evicted" || lease["revokedReason"] != "concurrency_limit" || lease["revokedAt"] == nil {
			t.Fatal("旧租约终态未原子落库", lease, err)
		}
		var audits, active, oldDisabled, newActive, disableJobs int
		err = a.server.DB.QueryRow(ctx, `SELECT
   (SELECT count(*) FROM "SecurityEvent" WHERE "userId"=$1 AND type='session_evicted' AND "nodeId"=$2),
   (SELECT count(*) FROM "NodeSessionLease" WHERE "userId"=$1 AND status='active' AND "nodeId"=$3),
   (SELECT count(*) FROM "PanelClientBinding" WHERE "userId"=$1 AND "nodeId"=$2 AND status='disabled'),
   (SELECT count(*) FROM "PanelClientBinding" WHERE "userId"=$1 AND "nodeId"=$3 AND status='active'),
   (SELECT count(*) FROM "NodeCommandJob" WHERE "userId"=$1 AND "commandType"='DISABLE_USER' AND "nodeId"=$2)`, user["id"], oldNode["id"], newNode["id"]).Scan(&audits, &active, &oldDisabled, &newActive, &disableJobs)
		if err != nil || audits != 1 || active != 1 || oldDisabled != 1 || newActive != 1 || disableJobs != 1 {
			t.Fatal("互换Node的审计/终态/命令不一致", audits, active, oldDisabled, newActive, disableJobs, err)
		}
	}
	t.Log("cross-user node order: two real HTTP 200; one direct audit gate and one ordered Node waiter; each old lease evicted, audited and DISABLE queued once")
}
