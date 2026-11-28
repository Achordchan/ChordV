package api

import (
	"context"
	"testing"
	"time"
)

func TestLegacyRevocationRetryKeepsNodeAndUserScope(t *testing.T) {
	a := newTestAPI(t)
	user := a.createUser()
	plan := a.createPlan("personal")
	sub := a.call("POST", "/api/admin/subscriptions", Object{"userId": user["id"], "planId": plan["id"], "expireAt": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}, 200)
	nodeA, _, bindingA := a.readyBinding(user, sub)
	nodeB, _, bindingB := a.readyBinding(user, sub)
	leases := []Object{}
	for _, pair := range []struct{ node, binding Object }{{nodeA, bindingA}, {nodeB, bindingB}} {
		lease, err := insert(context.Background(), a.server.DB, "NodeSessionLease", Object{"sessionId": "session_" + newID(), "userId": user["id"], "subscriptionId": sub["id"], "nodeId": pair.node["id"], "xrayUserEmail": pair.binding["panelClientEmail"], "xrayUserUuid": pair.binding["panelClientId"], "status": "active", "issuedAt": now(), "expiresAt": time.Now().Add(time.Minute).UTC().Format(time.RFC3339), "lastHeartbeatAt": now(), "connectionMode": "rule"})
		if err != nil {
			t.Fatal(err)
		}
		leases = append(leases, lease)
	}
	job, err := insert(context.Background(), a.server.DB, "LeaseRevocationJob", Object{"dedupeKey": "revocation-test-" + newID(), "reason": "admin_disconnect", "subscriptionId": sub["id"], "userId": user["id"], "nodeId": nodeA["id"], "status": "failed", "nextRunAt": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = a.server.DB.Exec(context.Background(), `DELETE FROM "LeaseRevocationJob" WHERE id=$1`, job["id"])
	})
	events, _ := a.eventStream("/api/admin/events/stream", "")
	result := a.call("POST", "/api/admin/nodes/lease-revocation-jobs/"+text(job, "id")+"/retry", Object{}, 200)
	if result["queuedCount"] != float64(1) {
		t.Fatal("历史撤销任务没有被排入队列")
	}
	waitLiveEvent(t, events, func(event liveEvent) bool {
		return event.data["type"] == "session_revoked" && event.data["sessionId"] == leases[0]["sessionId"]
	})
	for index, lease := range leases {
		var status string
		if err = a.server.DB.QueryRow(context.Background(), `SELECT status FROM "NodeSessionLease" WHERE id=$1`, lease["id"]).Scan(&status); err != nil {
			t.Fatal(err)
		}
		expected := "active"
		if index == 0 {
			expected = "revoked"
		}
		if status != expected {
			t.Fatal("撤销任务越过了指定节点范围", index, status)
		}
	}
	retry := a.call("POST", "/api/admin/nodes/"+text(nodeA, "id")+"/lease-revocation-jobs/retry", Object{}, 200)
	if retry["queuedCount"] != float64(0) {
		t.Fatal("已完成的撤销意图不应重复排入")
	}
}
