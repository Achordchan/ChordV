package api

import (
	"context"
	"testing"
	"time"
)

type leasePolicyFixture struct {
	a                      *testAPI
	user, other, plan, sub Object
	nodes, bindings        []Object
	userToken              string
	nodeTokens             map[string]string
}

func newLeasePolicyFixture(t *testing.T, team bool, nodeCount int) *leasePolicyFixture {
	t.Helper()
	a := newTestAPI(t)
	u, other := a.createUser(), a.createUser()
	scope := "personal"
	if team {
		scope = "team"
	}
	p := a.createPlan(scope)
	var sub Object
	if team {
		group := a.call("POST", "/api/admin/teams", Object{"name": "租约策略", "ownerUserId": other["id"]}, 200)
		a.call("POST", "/api/admin/teams/"+text(group, "id")+"/members", Object{"userId": u["id"]}, 200)
		sub = a.call("POST", "/api/admin/teams/"+text(group, "id")+"/subscriptions", Object{"planId": p["id"], "expireAt": time.Now().UTC().Add(time.Hour).Format(time.RFC3339)}, 200)
	} else {
		sub = a.call("POST", "/api/admin/subscriptions", Object{"userId": u["id"], "planId": p["id"], "expireAt": time.Now().UTC().Add(time.Hour).Format(time.RFC3339)}, 200)
	}
	f := &leasePolicyFixture{a: a, user: u, other: other, plan: p, sub: sub, userToken: a.loginUser(u), nodeTokens: map[string]string{}}
	tokens := f.nodeTokens
	for range nodeCount {
		node, token, binding := a.readyBinding(u, sub)
		f.nodes = append(f.nodes, node)
		f.bindings = append(f.bindings, binding)
		tokens[text(node, "id")] = token
	}
	jobs, err := list(context.Background(), a.server.DB, `SELECT to_jsonb(j) FROM "NodeCommandJob" j WHERE "commandType"='ENSURE_USER' AND status IN('pending','running','failed')`)
	if err != nil {
		t.Fatal(err)
	}
	admin := a.token
	for _, job := range jobs {
		a.token = tokens[text(job, "nodeId")]
		a.call("POST", "/api/agent/v1/commands/"+text(job, "id")+"/result", Object{"status": "completed", "result": Object{}}, 200)
	}
	a.token = admin
	return f
}

func (f *leasePolicyFixture) seed(t *testing.T, key string, node int, issued, heartbeat, expiry time.Time) Object {
	t.Helper()
	b := f.bindings[node]
	row, err := insert(context.Background(), f.a.server.DB, "NodeSessionLease", Object{"sessionId": "policy-" + key + "-" + newID(), "userId": f.user["id"], "subscriptionId": f.sub["id"], "nodeId": b["nodeId"], "xrayUserEmail": b["panelClientEmail"], "xrayUserUuid": b["panelClientId"], "issuedAt": issued.UTC(), "lastHeartbeatAt": heartbeat.UTC(), "expiresAt": expiry.UTC(), "connectionMode": "rule"})
	if err != nil {
		t.Fatal(err)
	}
	return row
}

func (f *leasePolicyFixture) row(t *testing.T, id string) Object {
	t.Helper()
	row, err := one(context.Background(), f.a.server.DB, `SELECT to_jsonb(l) FROM "NodeSessionLease" l WHERE id=$1`, id)
	if err != nil {
		t.Fatal(err)
	}
	return row
}

func (f *leasePolicyFixture) auditCount(t *testing.T) int {
	t.Helper()
	var n int
	if err := f.a.server.DB.QueryRow(context.Background(), `SELECT count(*) FROM "SecurityEvent" WHERE "userId"=$1`, f.user["id"]).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}
