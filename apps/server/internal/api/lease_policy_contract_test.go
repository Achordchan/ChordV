package api

import (
	"context"
	"reflect"
	"testing"
	"time"
)

func TestLeasePolicyDefaultsAndSoftExpiryHeartbeatHTTP(t *testing.T) {
	f := newLeasePolicyFixture(t, false, 1)
	admin := f.a.token
	f.a.token = f.userToken
	start := time.Now().UTC()
	runtime := f.a.call("POST", "/api/client/session/connect", Object{"nodeId": f.nodes[0]["id"], "mode": "rule"}, 200)
	expires, err := parseTimestamp(text(runtime, "leaseExpiresAt"))
	if err != nil {
		t.Fatal(err)
	}
	if runtime["leaseHeartbeatIntervalSeconds"] != float64(30) || runtime["leaseGraceSeconds"] != float64(300) || expires.Sub(start) < 1799*time.Second || expires.Sub(start) > 1802*time.Second {
		t.Error("默认创建/返回应统一1800/30/300", runtime["leaseHeartbeatIntervalSeconds"], runtime["leaseGraceSeconds"], expires.Sub(start))
	}
	soft := time.Now().UTC().Add(-60 * time.Second)
	meteringExec(t, f.a, `UPDATE "NodeSessionLease" SET "expiresAt"=$2 WHERE id=$1`, runtime["leaseId"], soft)
	before := policySchemaDigest(t, f.a)
	heartbeat := f.a.call("POST", "/api/client/session/heartbeat", Object{"sessionId": runtime["sessionId"]}, 200)
	if heartbeat["status"] != "active" {
		t.Error("软过期但未越过300秒宽限仍可续租", heartbeat)
	}
	after := policySchemaDigest(t, f.a)
	for table, digest := range before {
		if table != "NodeSessionLease" && !reflect.DeepEqual(digest, after[table]) {
			t.Error("正常宽限续租不得停用binding/写审计或命令", table)
		}
	}
	row := f.row(t, text(runtime, "leaseId"))
	if row["revokedAt"] != nil || row["revokedReason"] != nil {
		t.Error("有效续租不可留下撤销信息", row)
	}
	f.a.token = admin
}

func TestLeasePolicyHeartbeatOrderedEvictionAndAuditHTTP(t *testing.T) {
	f := newLeasePolicyFixture(t, false, 2)
	at := time.Now().UTC()
	a := f.seed(t, "A", 0, at.Add(-200*time.Second), at.Add(-10*time.Second), at.Add(time.Hour))
	b := f.seed(t, "B", 1, at.Add(-100*time.Second), at.Add(-100*time.Second), at.Add(time.Hour))
	f.a.call("PUT", "/api/admin/users/"+text(f.user, "id")+"/security", Object{"maxConcurrentSessionsOverride": 1}, 200)
	if f.row(t, text(a, "id"))["status"] != "active" || f.row(t, text(b, "id"))["status"] != "evicted" {
		t.Error("必须优先保留最近心跳而不是最晚issued的租约")
	}
	if f.auditCount(t) != 1 {
		t.Error("每条实际逐出必须写1条原SecurityEvent")
	}
	var bindingA, bindingB string
	if err := f.a.server.DB.QueryRow(context.Background(), `SELECT status FROM "PanelClientBinding" WHERE id=$1`, f.bindings[0]["id"]).Scan(&bindingA); err != nil {
		t.Fatal(err)
	}
	if err := f.a.server.DB.QueryRow(context.Background(), `SELECT status FROM "PanelClientBinding" WHERE id=$1`, f.bindings[1]["id"]).Scan(&bindingB); err != nil {
		t.Fatal(err)
	}
	if bindingA != "active" || bindingB != "disabled" {
		t.Error("只停最后有效租约离开的节点，不误停保留节点", bindingA, bindingB)
	}
}

func TestLeasePolicyNoEffectiveSubscriptionUsesOverrideOrDefaultHTTP(t *testing.T) {
	for _, sample := range []struct {
		name     string
		team     bool
		override any
		want     int
	}{{"expired-default3", false, nil, 3}, {"former-team-override2", true, 2, 2}} {
		t.Run(sample.name, func(t *testing.T) {
			f := newLeasePolicyFixture(t, sample.team, 1)
			meteringExec(t, f.a, `UPDATE "Plan" SET "maxConcurrentSessions"=1 WHERE id=$1`, f.plan["id"])
			if sample.team {
				meteringExec(t, f.a, `DELETE FROM "TeamMember" WHERE "userId"=$1`, f.user["id"])
			} else {
				meteringExec(t, f.a, `UPDATE "Subscription" SET "expireAt"=$2 WHERE id=$1`, f.sub["id"], time.Now().UTC().Add(-time.Hour))
			}
			at := time.Now().UTC()
			for i := range 4 {
				f.seed(t, newID(), 0, at.Add(time.Duration(i-10)*time.Second), at.Add(time.Duration(i-10)*time.Second), at.Add(time.Hour))
			}
			f.a.call("PUT", "/api/admin/users/"+text(f.user, "id")+"/security", Object{"maxConcurrentSessionsOverride": sample.override}, 200)
			var n int
			if err := f.a.server.DB.QueryRow(context.Background(), `SELECT count(*) FROM "NodeSessionLease" WHERE "userId"=$1 AND status='active'`, f.user["id"]).Scan(&n); err != nil {
				t.Fatal(err)
			}
			if n != sample.want {
				t.Error("没有有效订阅时仍需应用正override或默认3，不读历史套餐/早返", n, sample.want)
			}
		})
	}
}

func TestLeasePolicyTerminalHeartbeatPersistsReasonAndIsIdempotentHTTP(t *testing.T) {
	f := newLeasePolicyFixture(t, false, 1)
	at := time.Now().UTC()
	lease := f.seed(t, "hard-expired", 0, at.Add(-time.Hour), at.Add(-time.Hour), at.Add(-301*time.Second))
	f.a.token = f.userToken
	first := f.a.call("POST", "/api/client/session/heartbeat", Object{"sessionId": lease["sessionId"]}, 200)
	row := f.row(t, text(lease, "id"))
	if first["status"] != "expired" || first["reasonCode"] != "session_expired" || row["revokedReason"] != "session_expired" || row["revokedAt"] == nil || f.auditCount(t) != 1 {
		t.Error("首次硬过期必须同事务持久状态/原因/时间和单条审计", first, row)
	}
	seq := panelEventSequence(f.a)
	second := f.a.call("POST", "/api/client/session/heartbeat", Object{"sessionId": lease["sessionId"]}, 200)
	if !reflect.DeepEqual(first, second) || seq != panelEventSequence(f.a) || f.auditCount(t) != 1 {
		t.Error("重复终态必须响应原因一致且无重复事件/审计", first, second)
	}
}
