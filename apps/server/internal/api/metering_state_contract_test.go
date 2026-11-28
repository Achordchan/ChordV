package api

import (
	"context"
	"encoding/json"
	"os"
	"reflect"
	"testing"
	"time"
)

type meteringStateFixture struct {
	a                *testAPI
	client           *testAPI
	user, other, sub Object
	nodes            map[string]Object
}

func newMeteringStateFixture(t *testing.T) *meteringStateFixture {
	t.Helper()
	a := newTestAPI(t)
	user, other := a.createUser(), a.createUser()
	team := a.call("POST", "/api/admin/teams", Object{"name": "计量状态契约", "ownerUserId": user["id"]}, 200)
	a.call("POST", "/api/admin/teams/"+text(team, "id")+"/members", Object{"userId": other["id"]}, 200)
	plan := a.createPlan("team")
	sub := a.call("POST", "/api/admin/teams/"+text(team, "id")+"/subscriptions", Object{"planId": plan["id"], "expireAt": time.Now().UTC().Add(time.Hour).UTC().Format(time.RFC3339)}, 200)
	nodeA, _ := a.createNode()
	nodeB, _ := a.createNode()
	client := &testAPI{t: t, server: a.server, http: a.http}
	login := client.call("POST", "/api/auth/login", Object{"email": user["email"], "password": "  exact-password  "}, 200)
	client.token = text(login, "accessToken")
	return &meteringStateFixture{a, client, user, other, sub, map[string]Object{"A": nodeA, "B": nodeB}}
}

func meteringExec(t *testing.T, a *testAPI, sql string, args ...any) {
	t.Helper()
	if _, err := a.server.DB.Exec(context.Background(), sql, args...); err != nil {
		t.Fatal(err)
	}
}

func (f *meteringStateFixture) reset(t *testing.T) {
	t.Helper()
	meteringExec(t, f.a, `DELETE FROM "MeteringIncident"`)
	meteringExec(t, f.a, `DELETE FROM "NodeSessionLease"`)
	meteringExec(t, f.a, `UPDATE "Node" SET "isActive"=true,"controlStatus"='online'`)
	meteringExec(t, f.a, `UPDATE "NodeAgent" SET status='online',"xrayStatus"='healthy',"revokedAt"=NULL,"lastSeenAt"=now()`)
}

func (f *meteringStateFixture) lease(t *testing.T, n string, other bool, at time.Time, expired bool) Object {
	t.Helper()
	user := f.user
	if other {
		user = f.other
	}
	expiry := time.Now().UTC().Add(time.Hour)
	if expired {
		expiry = time.Now().UTC().Add(-time.Hour)
	}
	row, err := insert(context.Background(), f.a.server.DB, "NodeSessionLease", Object{"sessionId": newID(), "userId": user["id"], "subscriptionId": f.sub["id"], "nodeId": f.nodes[n]["id"], "xrayUserEmail": "metering-" + newID(), "xrayUserUuid": newID(), "issuedAt": at, "expiresAt": expiry, "lastHeartbeatAt": at, "updatedAt": at, "createdAt": at})
	if err != nil {
		t.Fatal(err)
	}
	meteringExec(t, f.a, `UPDATE "NodeSessionLease" SET "createdAt"=$2,"updatedAt"=$2 WHERE id=$1`, row["id"], at)
	return row
}

func (f *meteringStateFixture) incident(t *testing.T, n, reason, status string, created, opened time.Time) {
	t.Helper()
	meteringExec(t, f.a, `INSERT INTO "MeteringIncident"(id,"subscriptionId","nodeId",reason,status,"createdAt","openedAt","updatedAt") VALUES($1,$2,$3,$4,$5,$6,$7,$6)`, newID(), f.sub["id"], f.nodes[n]["id"], reason, status, created, opened)
}

func (f *meteringStateFixture) assertHTTP(t *testing.T, status string, message any) {
	t.Helper()
	before, seq := policySchemaDigest(t, f.a), panelEventSequence(f.a)
	for _, path := range []string{"/api/client/subscription", "/api/client/bootstrap"} {
		result := f.client.call("GET", path, nil, 200)
		if path == "/api/client/bootstrap" {
			result = result["subscription"].(map[string]any)
		}
		value, exists := result["meteringMessage"]
		if result["meteringStatus"] != status || !exists || value != message {
			t.Errorf("%s: status/message=%v/%v exists=%v; want=%s/%v", path, result["meteringStatus"], value, exists, status, message)
		}
	}
	if !reflect.DeepEqual(before, policySchemaDigest(t, f.a)) || seq != panelEventSequence(f.a) {
		t.Fatal("计量状态投影不得写入任何48表或发布事件")
	}
}

func TestMeteringStateMatchesOriginalCasesHTTP(t *testing.T) {
	raw, err := os.ReadFile("testdata/metering-state-legacy.json")
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		Commit  string
		Results []struct {
			Name              string
			Node              Object
			Leases, Incidents []Object
			Output            Object
		}
	}
	if err = json.Unmarshal(raw, &contract); err != nil || contract.Commit != "397a64d" {
		t.Fatal("原始计量实证无效", err)
	}
	f := newMeteringStateFixture(t)
	events, _ := f.a.eventStream("/api/admin/events/stream", "")
	waitLiveEvent(t, events, func(e liveEvent) bool { return e.data["type"] == "presence_updated" })
	for _, sample := range contract.Results {
		t.Run(sample.Name, func(t *testing.T) {
			f.reset(t)
			clock := time.Now().UTC().Truncate(time.Millisecond)
			if sample.Node["isActive"] == false {
				meteringExec(t, f.a, `UPDATE "Node" SET "isActive"=false WHERE id=$1`, f.nodes["A"]["id"])
			}
			// Original rows used Node.controlStatus; registered Go nodes use authoritative Agent health.
			if sample.Node["controlStatus"] == "offline" {
				meteringExec(t, f.a, `UPDATE "NodeAgent" SET status='offline' WHERE "nodeId"=$1`, f.nodes["A"]["id"])
			}
			for _, lease := range sample.Leases {
				n := text(lease, "node")
				if n == "" {
					n = "A"
				}
				f.lease(t, n, lease["other"] == true, clock.Add(-time.Duration(number(lease, "age"))*time.Second), lease["expired"] == true)
			}
			for _, incident := range sample.Incidents {
				n := text(incident, "node")
				if n == "" {
					n = "A"
				}
				status := text(incident, "status")
				if status == "" {
					status = "open"
				}
				age := number(incident, "age")
				if age == 0 {
					age = 240
				}
				created := age
				if _, ok := incident["createdAge"]; ok {
					created = number(incident, "createdAge")
				}
				f.incident(t, n, text(incident, "reason"), status, clock.Add(-time.Duration(created)*time.Second), clock.Add(-time.Duration(age)*time.Second))
			}
			sequence := panelEventSequence(f.a)
			f.assertHTTP(t, text(sample.Output, "meteringStatus"), sample.Output["meteringMessage"])
			panelAssertNoEvents(t, f.a, events, sequence)
		})
	}
}

func TestMeteringStateAgentAuthorityAndLeaseOrderingHTTP(t *testing.T) {
	f := newMeteringStateFixture(t)
	for _, sample := range []struct {
		name, sql, status string
		args              []any
	}{
		{"unhealthy-agent", `UPDATE "NodeAgent" SET "xrayStatus"='failed'`, "ok", nil},
		{"revoked-agent-no-node-fallback", `UPDATE "NodeAgent" SET "revokedAt"=now()`, "ok", nil},
		{"healthy-agent-overrides-node", `UPDATE "Node" SET "controlStatus"='offline'`, "degraded", nil},
		{"inactive-lease", `UPDATE "NodeSessionLease" SET status='revoked'`, "ok", nil},
		{"registered-without-agent", `DELETE FROM "NodeAgent"`, "ok", nil},
	} {
		t.Run(sample.name, func(t *testing.T) {
			// Separate fixture for destructive Agent cases; normal fixture is reset otherwise.
			g := f
			if sample.name == "registered-without-agent" {
				g = newMeteringStateFixture(t)
			}
			g.reset(t)
			clock := time.Now().UTC()
			g.lease(t, "A", false, clock, false)
			g.incident(t, "A", "NODE_USER_SAMPLE_MISSING", "open", clock, clock)
			meteringExec(t, g.a, sample.sql, sample.args...)
			var message any
			if sample.status == "degraded" {
				message = "流量统计正在校准，请稍后查看"
			}
			g.assertHTTP(t, sample.status, message)
		})
	}
}
