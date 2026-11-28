package api

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestTrafficResetDoesNotClearBeforeTerminalMetering(t *testing.T) {
	a := newTestAPI(t)
	node, _ := a.createNode()
	user := a.createUser()
	plan := a.createPlan("personal")
	sub := a.call("POST", "/api/admin/subscriptions", Object{"userId": user["id"], "planId": plan["id"], "usedTrafficGb": 2, "expireAt": time.Now().AddDate(0, 1, 0).UTC().Format(time.RFC3339)}, 200)
	subID := text(sub, "id")
	binding, err := insert(context.Background(), a.server.DB, "PanelClientBinding", Object{"subscriptionId": subID, "userId": user["id"], "nodeId": node["id"], "panelClientEmail": "reset-" + newID(), "panelClientId": newID(), "panelInboundId": 0, "source": "direct", "status": "active"})
	if err != nil {
		t.Fatal(err)
	}
	input := Object{}
	target, err := a.server.beginTrafficReset(context.Background(), subID, input, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = a.server.DB.Exec(context.Background(), `DELETE FROM "SystemSetting" WHERE key=$1`, trafficResetKey(subID))
	})
	if _, err = a.server.finishTrafficReset(context.Background(), subID, target, input, false); !errors.Is(err, errResetSettling) {
		t.Fatalf("最终停用水位未确认时不得清零: %v", err)
	}
	var used float64
	if err = a.server.DB.QueryRow(context.Background(), `SELECT "usedTrafficGb" FROM "Subscription" WHERE id=$1`, subID).Scan(&used); err != nil {
		t.Fatal(err)
	}
	if used != 2 {
		t.Fatal("未结算流量被提前清空")
	}
	if err = a.server.assertNoTrafficReset(context.Background(), a.server.DB, subID); err == nil {
		t.Fatal("重置结算期间未阻止重新供给账号")
	}
	if _, err = update(context.Background(), a.server.DB, "PanelClientBinding", text(binding, "id"), Object{"directDisableWatermarks": []any{}}, "directDisableWatermarks"); err != nil {
		t.Fatal(err)
	}
	if _, err = a.server.finishTrafficReset(context.Background(), subID, target, input, false); err != nil {
		t.Fatal(err)
	}
	if err = a.server.DB.QueryRow(context.Background(), `SELECT "usedTrafficGb" FROM "Subscription" WHERE id=$1`, subID).Scan(&used); err != nil || used != 0 {
		t.Fatal("最终结算后未完成重置")
	}
	if err = a.server.assertNoTrafficReset(context.Background(), a.server.DB, subID); err != nil {
		t.Fatal("已完成的重置没有释放供给门禁")
	}
}
func TestTrafficResetZeroWatermarkRequiresBootIdentity(t *testing.T) {
	for _, tc := range []struct {
		name    string
		mark    Object
		settled bool
	}{
		{"empty-boot-queue", Object{"bootId": "no-batches", "sequenceThrough": "0"}, true},
		{"missing-boot", Object{"sequenceThrough": "0"}, false},
		{"missing-sequence", Object{"bootId": "no-batches"}, false},
		{"numeric-zero", Object{"bootId": "no-batches", "sequenceThrough": 0}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := assertTerminalSettled(context.Background(), nil, Object{"directDisableWatermarks": []any{tc.mark}})
			if (err == nil) != tc.settled {
				t.Fatalf("settled=%t: %v", tc.settled, err)
			}
		})
	}
}

func TestRenewDoesNotInventMonthOrResetTraffic(t *testing.T) {
	a := newTestAPI(t)
	user := a.createUser()
	plan := a.createPlan("personal")
	expiry := time.Now().AddDate(0, 2, 0).UTC().Truncate(time.Second).Format(time.RFC3339)
	sub := a.call("POST", "/api/admin/subscriptions", Object{"userId": user["id"], "planId": plan["id"], "usedTrafficGb": 2, "expireAt": expiry}, 200)
	renewed := a.call("POST", "/api/admin/subscriptions/"+text(sub, "id")+"/renew", Object{}, 200)
	if renewed["expireAt"] != expiry || renewed["usedTrafficGb"] != float64(2) {
		t.Fatal("续期未指定时间/清零时擅自改变了原值")
	}
	a.call("PATCH", "/api/admin/subscriptions/"+text(sub, "id"), Object{"state": "paused"}, 200)
	paused := a.array("/api/admin/subscriptions")
	found := false
	for _, s := range paused {
		if s["id"] == sub["id"] {
			found = s["state"] == "paused"
		}
	}
	if !found {
		t.Fatal("明确暂停状态被自动覆盖")
	}
}
func TestPersonalConversionJoinsExistingTeamAndKeepsHistory(t *testing.T) {
	a := newTestAPI(t)
	owner := a.createUser()
	member := a.createUser()
	team := a.call("POST", "/api/admin/teams", Object{"name": "转换目标团队", "ownerUserId": owner["id"]}, 200)
	t.Cleanup(func() { _, _ = a.server.DB.Exec(context.Background(), `DELETE FROM "Team" WHERE id=$1`, team["id"]) })
	teamPlan := a.createPlan("team")
	teamSub := a.call("POST", "/api/admin/teams/"+text(team, "id")+"/subscriptions", Object{"planId": teamPlan["id"], "expireAt": time.Now().AddDate(0, 1, 0).UTC().Format(time.RFC3339)}, 200)
	personalPlan := a.createPlan("personal")
	personal := a.call("POST", "/api/admin/subscriptions", Object{"userId": member["id"], "planId": personalPlan["id"], "expireAt": time.Now().AddDate(0, 1, 0).UTC().Format(time.RFC3339)}, 200)
	result := a.call("POST", "/api/admin/subscriptions/"+text(personal, "id")+"/convert-to-team", Object{"targetTeamId": team["id"]}, 200)
	if result["teamSubscriptionId"] != teamSub["id"] || result["deletedSubscriptionId"] != personal["id"] {
		t.Fatal("转换结果不符合旧DTO")
	}
	var state, userID string
	var teamID *string
	if err := a.server.DB.QueryRow(context.Background(), `SELECT state,"userId","teamId" FROM "Subscription" WHERE id=$1`, personal["id"]).Scan(&state, &userID, &teamID); err != nil {
		t.Fatal(err)
	}
	if state != "expired" || userID != member["id"] || teamID != nil {
		t.Fatal("个人历史订阅应保留原归属并停用，不能移动到团队")
	}
}

func TestDetachedTrafficResetCompletesFromRealHTTPMeteringEvents(t *testing.T) {
	a := newTestAPI(t)
	user := a.createUser()
	plan := a.createPlan("personal")
	sub := a.call("POST", "/api/admin/subscriptions", Object{"userId": user["id"], "planId": plan["id"], "usedTrafficGb": 2, "expireAt": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}, 200)
	_, agentToken, binding := a.readyBinding(user, sub)
	id := text(sub, "id")
	if _, err := a.server.beginTrafficReset(context.Background(), id, Object{}, false); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = a.server.DB.Exec(context.Background(), `DELETE FROM "SystemSetting" WHERE key=$1`, trafficResetKey(id))
	})
	if err := a.server.detachTrafficReset(id); err != nil {
		t.Fatal(err)
	}
	var commandID string
	if err := a.server.DB.QueryRow(context.Background(), `SELECT id FROM "NodeCommandJob" WHERE "bindingId"=$1 AND "commandType"='DISABLE_USER' AND status='pending'`, binding["id"]).Scan(&commandID); err != nil {
		t.Fatal(err)
	}
	channel, unsubscribe := a.server.events.subscribe(trafficResetKey(id))
	defer unsubscribe()
	a.token = agentToken
	a.call("POST", "/api/agent/v1/commands/"+commandID+"/result", Object{"status": "completed", "result": Object{"disableWatermarks": []Object{{"bootId": "empty-boot", "sequenceThrough": "0"}, {"bootId": "reset-e2e", "sequenceThrough": "1"}}}}, 200)
	var used float64
	if err := a.server.DB.QueryRow(context.Background(), `SELECT "usedTrafficGb" FROM "Subscription" WHERE id=$1`, id).Scan(&used); err != nil || used != 2 {
		t.Fatal("最终计量未到达就清零", used, err)
	}
	a.call("POST", "/api/agent/v1/usage-batches", Object{"bootId": "reset-e2e", "sequence": "1", "sampledAt": now(), "samples": []Object{{"bindingId": binding["id"], "counterGeneration": "1", "uplinkBytes": "100", "downlinkBytes": "0", "uplinkDeltaBytes": "100", "downlinkDeltaBytes": "0"}}}, 200)
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	completed := false
	for !completed {
		select {
		case event := <-channel:
			completed = event["type"] == "traffic_reset_completed"
		case <-deadline.C:
			t.Fatal("最终水位已结算但后台未通过事件自动完成重置")
		}
	}
	if err := a.server.DB.QueryRow(context.Background(), `SELECT "usedTrafficGb" FROM "Subscription" WHERE id=$1`, id).Scan(&used); err != nil || used != 0 {
		t.Fatal("后台自动重置结果不正确", used, err)
	}
	if err := a.server.assertNoTrafficReset(context.Background(), a.server.DB, id); err != nil {
		t.Fatal("后台完成后仍未释放供给门禁", err)
	}
}
func TestTeamMemberTrafficResetPreservesOtherMembersLedger(t *testing.T) {
	a := newTestAPI(t)
	owner := a.createUser()
	member := a.createUser()
	team := a.call("POST", "/api/admin/teams", Object{"name": "成员重置测试", "ownerUserId": owner["id"]}, 200)
	t.Cleanup(func() { _, _ = a.server.DB.Exec(context.Background(), `DELETE FROM "Team" WHERE id=$1`, team["id"]) })
	a.call("POST", "/api/admin/teams/"+text(team, "id")+"/members", Object{"userId": member["id"]}, 200)
	plan := a.createPlan("team")
	sub := a.call("POST", "/api/admin/teams/"+text(team, "id")+"/subscriptions", Object{"planId": plan["id"], "usedTrafficGb": 3, "expireAt": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}, 200)
	for _, item := range []struct {
		user Object
		gb   float64
	}{{owner, 1}, {member, 2}} {
		if _, err := insert(context.Background(), a.server.DB, "TrafficLedger", Object{"teamId": team["id"], "userId": item.user["id"], "subscriptionId": sub["id"], "usedTrafficBytes": trafficBytes(item.gb), "usedTrafficGb": item.gb, "recordedAt": now()}); err != nil {
			t.Fatal(err)
		}
	}
	a.call("POST", "/api/admin/subscriptions/"+text(sub, "id")+"/reset-traffic", Object{}, 400)
	a.call("POST", "/api/admin/subscriptions/"+text(sub, "id")+"/reset-traffic", Object{"userId": member["id"]}, 200)
	var used float64
	if err := a.server.DB.QueryRow(context.Background(), `SELECT "usedTrafficGb" FROM "Subscription" WHERE id=$1`, sub["id"]).Scan(&used); err != nil || used != 1 {
		t.Fatal("单成员重置影响了其他成员的流量", used, err)
	}
	var count int
	if err := a.server.DB.QueryRow(context.Background(), `SELECT count(*) FROM "TrafficLedger" WHERE "subscriptionId"=$1 AND "userId"=$2`, sub["id"], owner["id"]).Scan(&count); err != nil || count != 1 {
		t.Fatal("其他成员账本被删除", count, err)
	}
}
