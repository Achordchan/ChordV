package api

import (
	"context"
	"reflect"
	"testing"
	"time"
)

func subscriptionCounters(t *testing.T, a *testAPI, id string) Object {
	t.Helper()
	row, err := one(context.Background(), a.server.DB, `SELECT jsonb_build_object('used',"usedTrafficGb",'bytes',"usedTrafficBytes"::text,'remaining',"remainingTrafficGb",'total',"totalTrafficGb",'state',state,'expireAt',"expireAt",'planId',"planId") FROM "Subscription" WHERE id=$1`, id)
	if err != nil {
		t.Fatal(err)
	}
	return row
}

func TestSubscriptionActionsIgnoreAdjustmentOnlyFieldsHTTP(t *testing.T) {
	a := newTestAPI(t)
	plan := a.createPlan("personal")
	for _, action := range []string{"renew", "change-plan"} {
		for _, state := range []string{"paused", "unknown-state"} {
			t.Run(action+"/"+state, func(t *testing.T) {
				fixture := *a
				fixture.t = t
				a := &fixture
				user := a.createUser()
				expiry := time.Now().AddDate(0, 1, 0).UTC().Truncate(time.Second).Format(time.RFC3339)
				sub := a.call("POST", "/api/admin/subscriptions", Object{"userId": user["id"], "planId": plan["id"], "usedTrafficGb": 2, "expireAt": expiry}, 200)
				id := text(sub, "id")
				before := subscriptionCounters(t, a, id)
				input := Object{"resetTraffic": false, "usedTrafficGb": 0, "state": state, "totalTrafficGb": 12, "expireAt": expiry}
				if action == "change-plan" {
					input["planId"] = plan["id"]
				}
				a.call("POST", "/api/admin/subscriptions/"+id+"/"+action, input, 200)
				after := subscriptionCounters(t, a, id)
				t.Logf("%s before=%v after=%v", action, before, after)
				if after["used"] != before["used"] || after["bytes"] != before["bytes"] || after["total"] != float64(12) || after["remaining"] != float64(10) || after["state"] != "active" {
					t.Errorf("续期/换套餐只能修改各自DTO允许字段，不得通过校正字段修改用量或状态: %v", after)
				}
				var markers int
				if err := a.server.DB.QueryRow(context.Background(), `SELECT count(*) FROM "SystemSetting" WHERE key=$1`, trafficResetKey(id)).Scan(&markers); err != nil || markers != 0 {
					t.Fatal("未请求清零时不应建立重置任务", markers, err)
				}
			})
		}
	}
}

func TestSubscriptionAdjustmentAndExplicitResetRemainSupportedHTTP(t *testing.T) {
	a := newTestAPI(t)
	user := a.createUser()
	plan := a.createPlan("personal")
	expiry := time.Now().AddDate(0, 1, 0).UTC().Format(time.RFC3339)
	sub := a.call("POST", "/api/admin/subscriptions", Object{"userId": user["id"], "planId": plan["id"], "usedTrafficGb": 2, "expireAt": expiry}, 200)
	id := text(sub, "id")
	a.call("PATCH", "/api/admin/subscriptions/"+id, Object{"usedTrafficGb": 3, "state": "paused"}, 200)
	adjusted := subscriptionCounters(t, a, id)
	if adjusted["used"] != float64(3) || adjusted["bytes"] != trafficBytes(3) || adjusted["state"] != "paused" {
		t.Fatal("校正接口应保留修改已用流量和暂停状态的能力", adjusted)
	}
	a.call("POST", "/api/admin/subscriptions/"+id+"/renew", Object{"resetTraffic": true, "usedTrafficGb": 9, "state": "paused", "expireAt": expiry}, 200)
	reset := subscriptionCounters(t, a, id)
	t.Logf("PATCH=%v explicit renewal reset=%v", adjusted, reset)
	if reset["used"] != float64(0) || reset["bytes"] != "0" || reset["remaining"] != float64(10) || reset["state"] != "active" {
		t.Fatal("显式续期清零应走正常重置并恢复订阅", reset)
	}
}

func TestTeamMemberResetPreservesLegacyUsageAndOtherTeamHTTP(t *testing.T) {
	a := newTestAPI(t)
	owner, member, otherOwner := a.createUser(), a.createUser(), a.createUser()
	plan := a.createPlan("team")
	createTeam := func(user Object) (Object, Object) {
		team := a.call("POST", "/api/admin/teams", Object{"name": "流量重置隔离测试", "ownerUserId": user["id"]}, 200)
		t.Cleanup(func() { _, _ = a.server.DB.Exec(context.Background(), `DELETE FROM "Team" WHERE id=$1`, team["id"]) })
		sub := a.call("POST", "/api/admin/teams/"+text(team, "id")+"/subscriptions", Object{"planId": plan["id"], "usedTrafficGb": 4, "expireAt": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}, 200)
		return team, sub
	}
	team, sub := createTeam(owner)
	otherTeam, otherSub := createTeam(otherOwner)
	a.call("POST", "/api/admin/teams/"+text(team, "id")+"/members", Object{"userId": member["id"]}, 200)
	for _, item := range []struct {
		team, sub, user Object
		gb              float64
		bytes           string
	}{{team, sub, owner, 2, "0"}, {team, sub, owner, 99, trafficBytes(1)}, {team, sub, member, 1, trafficBytes(1)}, {otherTeam, otherSub, otherOwner, 4, trafficBytes(4)}} {
		if _, err := insert(context.Background(), a.server.DB, "TrafficLedger", Object{"teamId": item.team["id"], "subscriptionId": item.sub["id"], "userId": item.user["id"], "usedTrafficGb": item.gb, "usedTrafficBytes": item.bytes, "recordedAt": now()}); err != nil {
			t.Fatal(err)
		}
	}
	ledger := func(id string) []Object {
		rows, err := list(context.Background(), a.server.DB, `SELECT to_jsonb(l)||jsonb_build_object('usedTrafficBytes',"usedTrafficBytes"::text) FROM "TrafficLedger" l WHERE "subscriptionId"=$1 ORDER BY id`, id)
		if err != nil {
			t.Fatal(err)
		}
		return rows
	}
	id, otherID := text(sub, "id"), text(otherSub, "id")
	before, otherBefore := subscriptionCounters(t, a, id), subscriptionCounters(t, a, otherID)
	beforeLedger, otherLedger := ledger(id), ledger(otherID)
	a.call("POST", "/api/admin/subscriptions/"+id+"/reset-traffic", Object{"userId": member["id"]}, 200)
	after, otherAfter := subscriptionCounters(t, a, id), subscriptionCounters(t, a, otherID)
	afterLedger := ledger(id)
	t.Logf("member reset before=%v after=%v otherBefore=%v otherAfter=%v", before, after, otherBefore, otherAfter)
	if after["used"] != float64(3) || after["bytes"] != trafficBytes(3) || after["remaining"] != float64(7) {
		t.Errorf("保留成员必须按正bytes优先、默认0回退GB累计，不能抹掉历史或重复计算: %v", after)
	}
	retained := []Object{}
	for _, row := range beforeLedger {
		if row["userId"] != member["id"] {
			retained = append(retained, row)
		}
	}
	if !reflect.DeepEqual(afterLedger, retained) || !reflect.DeepEqual(otherBefore, otherAfter) || !reflect.DeepEqual(otherLedger, ledger(otherID)) {
		t.Fatal("成员重置修改了保留账本或另一团队的数据", afterLedger)
	}
}
