package api

import (
	"context"
	"reflect"
	"testing"
	"time"
)

type userSecurityStream struct {
	target string
	events <-chan liveEvent
}

func userSecurityStreams(t *testing.T, a *testAPI, user, other Object) (string, []userSecurityStream) {
	t.Helper()
	admin := a.token
	ownerToken, otherToken := a.loginUser(user), a.loginUser(other)
	streams := []userSecurityStream{}
	for _, entry := range []struct{ token, target string }{{ownerToken, text(user, "id")}, {otherToken, text(other, "id")}} {
		a.token = entry.token
		stream, _ := a.eventStream("/api/client/events", "")
		waitLiveEvent(t, stream, func(e liveEvent) bool { return e.data["type"] == "ticket_updated" })
		streams = append(streams, userSecurityStream{entry.target, stream})
	}
	a.token = admin
	stream, _ := a.eventStream("/api/admin/events/stream", "")
	waitLiveEvent(t, stream, func(e liveEvent) bool { return e.data["type"] == "presence_updated" })
	waitLiveEvent(t, stream, func(e liveEvent) bool {
		if e.data["type"] != "presence_updated" {
			return false
		}
		a.server.events.mu.Lock()
		defer a.server.events.mu.Unlock()
		for _, record := range a.server.events.replay {
			if record.id == e.id && record.target == "admin" && record.data["type"] == "presence_updated" {
				return true
			}
		}
		return false
	})
	streams = append(streams, userSecurityStream{"admin", stream})
	return ownerToken, streams
}

func userSecurityAssertStreams(t *testing.T, a *testAPI, streams []userSecurityStream, owner string, accounts, revocations int) {
	t.Helper()
	for _, stream := range streams {
		marker, received := newID(), []Object{}
		a.server.events.publish(stream.target, Object{"type": "test_user_security_barrier", "marker": marker})
		waitLiveEvent(t, stream.events, func(e liveEvent) bool {
			if e.data["type"] == "test_user_security_barrier" {
				return e.data["marker"] == marker
			}
			received = append(received, e.data)
			return false
		})
		wantAccounts, wantRevocations := 0, 0
		if stream.target == owner || stream.target == "admin" {
			wantAccounts, wantRevocations = accounts, revocations
		}
		gotAccounts, gotRevocations := 0, 0
		for _, event := range received {
			switch event["type"] {
			case "account_updated":
				gotAccounts++
				if event["reasonCode"] != nil {
					t.Error("安全策略改变不得发送auth_invalid/account_disabled", event)
				}
			case "session_revoked":
				gotRevocations++
				if event["reasonCode"] != "connection_taken_over" {
					t.Error("并发逐出原因错误", event)
				}
			default:
				t.Error("用户安全设置不应发布无关事件", event)
			}
		}
		if gotAccounts != wantAccounts || gotRevocations != wantRevocations {
			t.Errorf("真实SSE作用域/数量错误: target=%s got=%d/%d want=%d/%d events=%v", stream.target, gotAccounts, gotRevocations, wantAccounts, wantRevocations, received)
		}
	}
}

func TestUserSecurityRealSSEMatchesSuccessAndRejectedScopesHTTP(t *testing.T) {
	a := newTestAPI(t)
	user, other := a.createUser(), a.createUser()
	_, streams := userSecurityStreams(t, a, user, other)
	for _, sample := range []struct {
		input   Object
		status  int
		missing bool
	}{
		{Object{}, 200, false},
		{Object{"maxConcurrentSessionsOverride": nil, "role": "bad", "status": "disabled", "password": "must-ignore"}, 200, false},
		{Object{"maxConcurrentSessionsOverride": "2.9", "displayName": nil}, 200, false},
		{Object{"maxConcurrentSessionsOverride": false}, 400, false},
		{Object{"maxConcurrentSessionsOverride": 2147483648}, 503, false},
		{Object{}, 404, true},
	} {
		meteringExec(t, a, `UPDATE "User" SET "maxConcurrentSessionsOverride"=7 WHERE id=$1`, user["id"])
		before, seq := policySchemaDigest(t, a), panelEventSequence(a)
		id := text(user, "id")
		if sample.missing {
			id = newID()
		}
		status, _ := routingContractRequest(t, a, "PUT", "/api/admin/users/"+id+"/security", sample.input)
		accounts := 0
		if sample.status == 200 {
			accounts = 1
		}
		if status != sample.status || panelEventSequence(a)-seq != uint64(accounts) {
			t.Error("成功/拒绝的事件总数错误", status, sample.status)
		}
		if sample.status != 200 && !reflect.DeepEqual(before, policySchemaDigest(t, a)) {
			t.Error("拒绝不得写48表")
		}
		userSecurityAssertStreams(t, a, streams, text(user, "id"), accounts, 0)
	}
}

func TestUserSecurityClearOverrideSynchronouslyReconcilesLiveLeasesHTTP(t *testing.T) {
	a := newTestAPI(t)
	user, other := a.createUser(), a.createUser()
	plan := a.createPlan("personal")
	a.call("PATCH", "/api/admin/plans/"+text(plan, "id"), Object{"maxConcurrentSessions": 1}, 200)
	sub := a.call("POST", "/api/admin/subscriptions", Object{"userId": user["id"], "planId": plan["id"], "expireAt": time.Now().UTC().Add(time.Hour).Format(time.RFC3339)}, 200)
	node, _, binding := a.readyBinding(user, sub)
	a.call("PATCH", "/api/admin/users/"+text(user, "id"), Object{"maxConcurrentSessionsOverride": 3}, 200)
	admin := a.token
	ownerToken := a.loginUser(user)
	a.token = ownerToken
	sessions := []Object{}
	for range 3 {
		sessions = append(sessions, a.call("POST", "/api/client/session/connect", Object{"nodeId": node["id"], "mode": "rule"}, 200))
	}
	a.token = admin
	_, streams := userSecurityStreams(t, a, user, other)
	before, seq := policySchemaDigest(t, a), panelEventSequence(a)
	rowBefore := userSecurityRow(t, a, text(user, "id"))
	result := a.call("PUT", "/api/admin/users/"+text(user, "id")+"/security", Object{"password": "must-ignore-password", "role": "admin", "status": "disabled"}, 200)
	if result["maxConcurrentSessionsOverride"] != nil {
		t.Fatal("空安全策略必须恢复套餐并发限制")
	}
	for index, session := range sessions {
		var status, reason string
		if err := a.server.DB.QueryRow(context.Background(), `SELECT status::text,coalesce("revokedReason",'') FROM "NodeSessionLease" WHERE "sessionId"=$1`, session["sessionId"]).Scan(&status, &reason); err != nil {
			t.Fatal(err)
		}
		if (index < 2 && (status != "evicted" || reason != "concurrency_limit")) || (index == 2 && status != "active") {
			t.Fatal("HTTP返回前应按现有Go算法仅逐出最旧超额租约", index, status, reason)
		}
	}
	rowAfter := userSecurityRow(t, a, text(user, "id"))
	for _, field := range []string{"passwordHash", "authVersion", "role", "status"} {
		if rowBefore[field] != rowAfter[field] {
			t.Error("安全设置不得改变密码/身份/认证版本", field)
		}
	}
	after := policySchemaDigest(t, a)
	for table, digest := range before {
		if table != "User" && table != "NodeSessionLease" && table != "SecurityEvent" && !reflect.DeepEqual(digest, after[table]) {
			t.Error("保留同节点有效租约时不得写无关表/失效refreshToken", table)
		}
	}
	var audits, evictions int
	if err := a.server.DB.QueryRow(context.Background(), `SELECT count(*),count(*) FILTER(WHERE type='session_evicted' AND detail='concurrency_limit') FROM "SecurityEvent" WHERE "userId"=$1`, user["id"]).Scan(&audits, &evictions); err != nil || audits != 2 || evictions != 2 {
		t.Fatal("恢复套餐上限应为两条真实逐出各保留一条安全审计", audits, evictions, err)
	}
	var bindingStatus string
	if err := a.server.DB.QueryRow(context.Background(), `SELECT status::text FROM "PanelClientBinding" WHERE id=$1`, binding["id"]).Scan(&bindingStatus); err != nil || bindingStatus != "active" {
		t.Fatal("最新租约仍有效，不得停用同节点绑定", bindingStatus, err)
	}
	if panelEventSequence(a)-seq != 3 {
		t.Error("两条撤销和一次账号事件之外不得乱发", panelEventSequence(a)-seq)
	}
	userSecurityAssertStreams(t, a, streams, text(user, "id"), 1, 2)
}
