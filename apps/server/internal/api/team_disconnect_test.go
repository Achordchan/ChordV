package api

import (
	"context"
	"testing"
	"time"
)

func teamKickFixture(t *testing.T) (*testAPI, Object, Object, Object) {
	t.Helper()
	a := newTestAPI(t)
	owner, member := a.createUser(), a.createUser()
	team := a.call("POST", "/api/admin/teams", Object{"name": "团队断连私有schema测试", "ownerUserId": owner["id"]}, 200)
	a.call("POST", "/api/admin/teams/"+text(team, "id")+"/members", Object{"userId": member["id"]}, 200)
	plan := a.createPlan("team")
	sub := a.call("POST", "/api/admin/teams/"+text(team, "id")+"/subscriptions", Object{"planId": plan["id"], "expireAt": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}, 200)
	return a, team, member, sub
}

// Legacy/stale cross-subscription state is confined to this random test schema.
func (a *testAPI) teamKickLease(user, sub, node Object) Object {
	a.t.Helper()
	binding, err := insert(context.Background(), a.server.DB, "PanelClientBinding", Object{"subscriptionId": sub["id"], "userId": user["id"], "teamId": sub["teamId"], "nodeId": node["id"], "panelClientEmail": "kick-" + newID(), "panelClientId": newID(), "panelInboundId": 0, "source": "direct", "status": "active"})
	if err != nil {
		a.t.Fatal(err)
	}
	lease, err := insert(context.Background(), a.server.DB, "NodeSessionLease", Object{"sessionId": "session_" + newID(), "subscriptionId": sub["id"], "userId": user["id"], "nodeId": node["id"], "xrayUserEmail": binding["panelClientEmail"], "xrayUserUuid": binding["panelClientId"], "status": "active", "issuedAt": now(), "expiresAt": time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano), "lastHeartbeatAt": now(), "connectionMode": "rule"})
	if err != nil {
		a.t.Fatal(err)
	}
	lease["bindingId"] = binding["id"]
	return lease
}

func TestTeamKickPreservesMembershipAndOtherSubscriptionLeases(t *testing.T) {
	a, team, member, sub := teamKickFixture(t)
	node, _ := a.createNode()
	target := a.teamKickLease(member, sub, node)
	personalPlan := a.createPlan("personal")
	personal, err := insert(context.Background(), a.server.DB, "Subscription", Object{"userId": member["id"], "planId": personalPlan["id"], "totalTrafficGb": 10, "usedTrafficGb": 0, "remainingTrafficGb": 10, "state": "active", "lastSyncedAt": now(), "expireAt": time.Now().Add(time.Hour).UTC().Format(time.RFC3339), "renewable": true})
	if err != nil {
		t.Fatal(err)
	}
	other := a.teamKickLease(member, personal, node)
	otherMember := a.teamKickLease(Object{"id": team["ownerUserId"]}, sub, node)
	var memberID string
	if err = a.server.DB.QueryRow(context.Background(), `SELECT id FROM "TeamMember" WHERE "teamId"=$1 AND "userId"=$2`, team["id"], member["id"]).Scan(&memberID); err != nil {
		t.Fatal(err)
	}
	adminToken, userToken := a.token, a.loginUser(member)
	a.token = userToken
	events, _ := a.eventStream("/api/client/events/stream", "")
	waitLiveEvent(t, events, func(e liveEvent) bool { return e.data["type"] == "ticket_updated" })
	a.token = adminToken
	result := a.call("POST", "/api/admin/teams/"+text(team, "id")+"/members/"+memberID+"/kick", Object{"disableAccount": false}, 200)
	event := waitLiveEvent(t, events, func(e liveEvent) bool { return e.data["type"] == "session_revoked" })
	if event.data["sessionId"] != target["sessionId"] || event.data["reasonCode"] != "admin_paused_connection" {
		t.Fatal("团队断连SSE范围/原因错误", event.data)
	}
	a.token = userToken
	heartbeat := a.call("POST", "/api/client/session/heartbeat", Object{"sessionId": target["sessionId"]}, 200)
	if heartbeat["status"] != "revoked" || heartbeat["reasonCode"] != "admin_paused_connection" {
		t.Fatal("团队断连心跳原因不一致", heartbeat)
	}
	a.token = adminToken
	var count int
	if err = a.server.DB.QueryRow(context.Background(), `SELECT count(*) FROM "TeamMember" WHERE id=$1`, memberID).Scan(&count); err != nil || count != 1 {
		t.Fatal("断开连接不得移出团队", count, err)
	}
	for _, item := range []struct {
		lease Object
		want  string
	}{{target, "revoked"}, {other, "active"}, {otherMember, "active"}} {
		var status string
		if err = a.server.DB.QueryRow(context.Background(), `SELECT status FROM "NodeSessionLease" WHERE id=$1`, item.lease["id"]).Scan(&status); err != nil || status != item.want {
			t.Fatal("断连越过当前Team范围", status, item.want, err)
		}
	}
	var status string
	if err = a.server.DB.QueryRow(context.Background(), `SELECT status FROM "PanelClientBinding" WHERE id=$1`, other["bindingId"]).Scan(&status); err != nil || status != "active" {
		t.Fatal("个人绑定被停用", status, err)
	}
	if result["action"] != "disconnect_session" || result["disconnectedSessionCount"] != float64(1) || result["accountDisabled"] != false || result["team"] == nil {
		t.Fatal("断连返回值不符合现有DTO", result)
	}
	a.call("DELETE", "/api/admin/teams/"+text(team, "id")+"/members/"+memberID, nil, 200)
	if err = a.server.DB.QueryRow(context.Background(), `SELECT status FROM "NodeSessionLease" WHERE id=$1`, other["id"]).Scan(&status); err != nil || status != "active" {
		t.Fatal("真正移出团队也不应撤销个人历史租约", status, err)
	}
}

func TestTeamKickAllowsOwnerAndRejectsForeignMember(t *testing.T) {
	a, team, _, _ := teamKickFixture(t)
	var ownerMember string
	if err := a.server.DB.QueryRow(context.Background(), `SELECT id FROM "TeamMember" WHERE "teamId"=$1 AND role='owner'`, team["id"]).Scan(&ownerMember); err != nil {
		t.Fatal(err)
	}
	a.call("POST", "/api/admin/teams/"+text(team, "id")+"/members/"+ownerMember+"/kick", Object{}, 200)
	a.call("POST", "/api/admin/teams/"+newID()+"/members/"+ownerMember+"/kick", Object{}, 404)
}

func TestTeamKickDisableKeepsMembershipAndLastAdminProtection(t *testing.T) {
	a, team, member, sub := teamKickFixture(t)
	node, _ := a.createNode()
	teamLease := a.teamKickLease(member, sub, node)
	personalPlan := a.createPlan("personal")
	personal, err := insert(context.Background(), a.server.DB, "Subscription", Object{"userId": member["id"], "planId": personalPlan["id"], "totalTrafficGb": 10, "usedTrafficGb": 0, "remainingTrafficGb": 10, "state": "active", "lastSyncedAt": now(), "expireAt": time.Now().Add(time.Hour).UTC().Format(time.RFC3339), "renewable": true})
	if err != nil {
		t.Fatal(err)
	}
	personalLease := a.teamKickLease(member, personal, node)
	otherMember := a.teamKickLease(Object{"id": team["ownerUserId"]}, sub, node)
	oldToken := a.loginUser(member)
	var memberID string
	if err := a.server.DB.QueryRow(context.Background(), `SELECT id FROM "TeamMember" WHERE "teamId"=$1 AND "userId"=$2`, team["id"], member["id"]).Scan(&memberID); err != nil {
		t.Fatal(err)
	}
	adminEvents, _ := a.eventStream("/api/admin/events/stream", "")
	waitLiveEvent(t, adminEvents, func(e liveEvent) bool { return e.data["type"] == "presence_updated" })
	result := a.call("POST", "/api/admin/teams/"+text(team, "id")+"/members/"+memberID+"/kick", Object{"disableAccount": true}, 200)
	event := waitLiveEvent(t, adminEvents, func(e liveEvent) bool { return e.data["type"] == "session_revoked" })
	if event.data["reasonCode"] != "account_disabled" {
		t.Fatal("账号禁用SSE原因不一致", event.data)
	}
	if result["accountDisabled"] != true {
		t.Fatal("明确禁用账号未返回禁用状态")
	}
	for _, item := range []struct {
		lease Object
		want  string
	}{{teamLease, "revoked"}, {personalLease, "revoked"}, {otherMember, "active"}} {
		var status string
		if err := a.server.DB.QueryRow(context.Background(), `SELECT status FROM "NodeSessionLease" WHERE id=$1`, item.lease["id"]).Scan(&status); err != nil || status != item.want {
			t.Fatal("显式账号禁用范围错误", status, item.want, err)
		}
	}
	adminToken := a.token
	a.token = oldToken
	a.call("GET", "/api/client/bootstrap", nil, 401)
	a.token = adminToken
	var count int
	if err := a.server.DB.QueryRow(context.Background(), `SELECT count(*) FROM "TeamMember" WHERE id=$1`, memberID).Scan(&count); err != nil || count != 1 {
		t.Fatal("禁用也不得移出团队", count, err)
	}
	adminTeam := a.call("POST", "/api/admin/teams", Object{"name": "最后管理员保护", "ownerUserId": a.adminID}, 200)
	var adminMember string
	if err := a.server.DB.QueryRow(context.Background(), `SELECT id FROM "TeamMember" WHERE "teamId"=$1 AND "userId"=$2`, adminTeam["id"], a.adminID).Scan(&adminMember); err != nil {
		t.Fatal(err)
	}
	a.call("POST", "/api/admin/teams/"+text(adminTeam, "id")+"/members/"+adminMember+"/kick", Object{"disableAccount": true}, 409)
	a.call("GET", "/api/admin/me", nil, 200)
}
