package api

import (
	"context"
	"reflect"
	"strings"
	"testing"
	"time"
)

func leaseEventsThroughBarrier(t *testing.T, a *testAPI, stream userSecurityStream, initial []Object) []Object {
	t.Helper()
	marker := newID()
	events := append([]Object{}, initial...)
	a.server.events.publish(stream.target, Object{"type": "test_lease_policy_barrier", "marker": marker})
	waitLiveEvent(t, stream.events, func(e liveEvent) bool {
		if strings.HasPrefix(text(e.data, "type"), "test_") && strings.Contains(text(e.data, "type"), "barrier") {
			return e.data["marker"] == marker
		}
		events = append(events, e.data)
		return false
	})
	return events
}

func TestLeasePolicyConcurrentHeartbeatWorkerRealSSEAndAuditOnce(t *testing.T) {
	f := newLeasePolicyFixture(t, false, 1)
	_, streams := userSecurityStreams(t, f.a, f.user, f.other)
	at := time.Now().UTC()
	lease := f.seed(t, "expired-race", 0, at.Add(-time.Hour), at.Add(-time.Hour), at.Add(-301*time.Second))
	client := &testAPI{t: t, server: f.a.server, http: f.a.http, token: f.userToken}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	done := leaseAsyncRequest(ctx, client, "POST", "/api/client/session/heartbeat", `{"sessionId":"`+text(lease, "sessionId")+`"}`)
	worker := make(chan error, 1)
	go func() { worker <- f.a.server.expireLease(ctx, text(lease, "id")) }()
	res := <-done
	if res.err != nil || res.status != 200 {
		t.Fatal("typed终态HTTP应保留200", res.status, res.err)
	}
	if err := <-worker; err != nil {
		t.Fatal(err)
	}
	if f.auditCount(t) != 1 {
		t.Fatal("并发heartbeat/worker必须只迁移和审计一次")
	}
	var disables int
	if err := f.a.server.DB.QueryRow(ctx, `SELECT count(*) FROM "NodeCommandJob" WHERE "bindingId"=$1 AND "commandType"='DISABLE_USER'`, f.bindings[0]["id"]).Scan(&disables); err != nil || disables != 1 {
		t.Fatal("最后binding必须且只能排一次DISABLE", disables, err)
	}
	adminInitial := []Object{}
	waitLiveEvent(t, streams[2].events, func(e liveEvent) bool {
		adminInitial = append(adminInitial, e.data)
		return e.data["type"] == "presence_updated"
	})
	for i, stream := range streams {
		initial := []Object{}
		if i == 2 {
			initial = adminInitial
		}
		events := leaseEventsThroughBarrier(t, f.a, stream, initial)
		counts := map[string]int{}
		for _, e := range events {
			counts[text(e, "type")]++
			if e["type"] == "session_revoked" && (e["reasonCode"] != "session_expired" || e["sessionId"] != lease["sessionId"]) {
				t.Error("撤销事件原因/对象错误", e)
			}
		}
		want := map[string]int{}
		if i == 0 {
			want["session_revoked"] = 1
		}
		if i == 2 {
			want["session_revoked"] = 1
			want["presence_updated"] = 1
		}
		if !reflect.DeepEqual(counts, want) {
			t.Error("真实三方SSE范围/去重/合并presence错误", stream.target, counts, want, events)
		}
	}
	before := policySchemaDigest(t, f.a)
	first := client.call("POST", "/api/client/session/heartbeat", Object{"sessionId": lease["sessionId"]}, 200)
	second := client.call("POST", "/api/client/session/heartbeat", Object{"sessionId": lease["sessionId"]}, 200)
	if err := f.a.server.expireLease(ctx, text(lease, "id")); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(first, second) || !reflect.DeepEqual(before, policySchemaDigest(t, f.a)) {
		t.Fatal("重复终态不得改48表或响应原因")
	}
	for _, stream := range streams {
		if events := leaseEventsThroughBarrier(t, f.a, stream, nil); len(events) != 0 {
			t.Error("重复终态SSE应为空", stream.target, events)
		}
	}
}

func TestLeasePolicyConcurrentConnectReservesOneSlotAndKeepsSharedBinding(t *testing.T) {
	f := newLeasePolicyFixture(t, false, 1)
	f.a.call("PUT", "/api/admin/users/"+text(f.user, "id")+"/security", Object{"maxConcurrentSessionsOverride": 1}, 200)
	at := time.Now().UTC()
	old := f.seed(t, "old", 0, at.Add(-time.Minute), at.Add(-time.Minute), at.Add(time.Hour))
	client := &testAPI{t: t, server: f.a.server, http: f.a.http, token: f.userToken}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	path, body := "/api/client/session/connect", `{"nodeId":"`+text(f.nodes[0], "id")+`","mode":"rule"}`
	left, right := leaseAsyncRequest(ctx, client, "POST", path, body), leaseAsyncRequest(ctx, client, "POST", path, body)
	for _, done := range []<-chan leaseHTTPResult{left, right} {
		r := <-done
		if r.err != nil || r.status != 200 {
			t.Fatal("并发连接未串行正确收敛", r.status, r.err)
		}
	}
	var active, disabled int
	if err := f.a.server.DB.QueryRow(ctx, `SELECT count(*) FROM "NodeSessionLease" WHERE "userId"=$1 AND status='active'`, f.user["id"]).Scan(&active); err != nil || active != 1 {
		t.Fatal("预留1槽后最终只能一条活跃租约", active, err)
	}
	if f.row(t, text(old, "id"))["status"] != "evicted" || f.auditCount(t) != 2 {
		t.Fatal("原租约和先到新租约各逐出一次，不得漏审计")
	}
	if err := f.a.server.DB.QueryRow(ctx, `SELECT count(*) FROM "NodeCommandJob" WHERE "bindingId"=$1 AND "commandType"='DISABLE_USER'`, f.bindings[0]["id"]).Scan(&disabled); err != nil || disabled != 0 {
		t.Fatal("同节点新租约存在前后不得误停共享UUID", disabled, err)
	}
}

func TestLeasePolicyAuditFailureRollsBackPolicyAndLease(t *testing.T) {
	f := newLeasePolicyFixture(t, false, 1)
	at := time.Now().UTC()
	f.seed(t, "a", 0, at, at, at.Add(time.Hour))
	f.seed(t, "b", 0, at.Add(-time.Second), at.Add(-time.Second), at.Add(time.Hour))
	meteringExec(t, f.a, `CREATE FUNCTION reject_lease_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'explicit private audit failure'; END$$; CREATE TRIGGER reject_lease_audit BEFORE INSERT ON "SecurityEvent" FOR EACH ROW EXECUTE FUNCTION reject_lease_audit()`)
	before, seq := policySchemaDigest(t, f.a), panelEventSequence(f.a)
	status, _ := routingContractRequest(t, f.a, "PUT", "/api/admin/users/"+text(f.user, "id")+"/security", Object{"maxConcurrentSessionsOverride": 1})
	if status != 500 || !reflect.DeepEqual(before, policySchemaDigest(t, f.a)) || seq != panelEventSequence(f.a) {
		t.Fatal("审计写失败时策略/租约/绑定同事务回滚且无提交事件", status)
	}
}
