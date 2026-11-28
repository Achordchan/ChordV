package api

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

func TestOwnerLockConversionAndUserMetadataHTTP(t *testing.T) {
	f := newLeasePolicyFixture(t, false, 1)
	a := f.a
	team := a.call("POST", "/api/admin/teams", Object{"name": "转换锁图", "ownerUserId": f.other["id"]}, 200)
	plan := a.createPlan("team")
	a.call("POST", "/api/admin/teams/"+text(team, "id")+"/subscriptions", Object{"planId": plan["id"], "expireAt": time.Now().UTC().Add(time.Hour).Format(time.RFC3339)}, 200)
	a.server.tasks.close()
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	guard, err := a.server.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer guard.Rollback(context.Background())
	var pid int
	if err = guard.QueryRow(ctx, `SELECT pg_backend_pid() FROM "Subscription" WHERE id=$1 FOR UPDATE`, f.sub["id"]).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(Object{"targetTeamId": team["id"]})
	converting := leaseAsyncRequest(ctx, a, "POST", "/api/admin/subscriptions/"+text(f.sub, "id")+"/convert-to-team", string(raw))
	ownerLockWaitChain(t, a, pid, 1)
	ownerHeld := ownerLockNoKeyHeld(t, a, "User", text(f.user, "id"))
	if !ownerHeld {
		t.Error("转换在等待Sub前必须已取得User元数据锁")
	}
	updating := leaseAsyncRequest(ctx, a, "PUT", "/api/admin/users/"+text(f.user, "id")+"/security", `{"maxConcurrentSessionsOverride":1}`)
	ownerLockWaitChain(t, a, pid, 2)
	if err = guard.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	cr, ur := <-converting, <-updating
	t.Log("convert/metadata graph", ownerHeld, "convertHTTP", cr.status, "userHTTP", ur.status)
	if cr.err != nil || ur.err != nil || cr.status != 200 || ur.status != 200 {
		t.Error("转换先Sub后User仍反序", cr.status, ur.status, cr.err, ur.err)
	}
}

func TestOwnerLockMemberAndSubscriptionHTTP(t *testing.T) {
	f := newLeasePolicyFixture(t, true, 1)
	a := f.a
	var member string
	if err := a.server.DB.QueryRow(context.Background(), `SELECT id FROM "TeamMember" WHERE "teamId"=$1 AND "userId"=$2`, f.sub["teamId"], f.user["id"]).Scan(&member); err != nil {
		t.Fatal(err)
	}
	a.server.tasks.close()
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	guard, err := a.server.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer guard.Rollback(context.Background())
	var pid int
	if err = guard.QueryRow(ctx, `SELECT pg_backend_pid() FROM "Subscription" WHERE id=$1 FOR UPDATE`, f.sub["id"]).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	kicking := leaseAsyncRequest(ctx, a, "POST", "/api/admin/teams/"+text(f.sub, "teamId")+"/members/"+member+"/kick", `{}`)
	ownerLockWaitChain(t, a, pid, 1)
	raw, _ := json.Marshal(Object{"ownerUserId": f.user["id"]})
	updating := leaseAsyncRequest(ctx, a, "PATCH", "/api/admin/teams/"+text(f.sub, "teamId"), string(raw))
	ownerLockWaitChain(t, a, pid, 2)
	if err = guard.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	kr, ur := <-kicking, <-updating
	t.Log("Member/Sub graph", "kickHTTP", kr.status, "teamHTTP", ur.status)
	if kr.err != nil || ur.err != nil || kr.status != 200 || ur.status != 200 {
		t.Error("负责人切换Member→Sub与kick Sub→Member仍反序", kr.status, ur.status, kr.err, ur.err)
	}
}

func TestOwnerLockRefreshAndSensitiveUserHTTP(t *testing.T) {
	a := newTestAPI(t)
	user := a.createUser()
	login := *a
	login.token = ""
	session := login.call("POST", "/api/auth/login", Object{"email": user["email"], "password": "  exact-password  "}, 200)
	token := text(session, "refreshToken")
	var tokenID string
	if err := a.server.DB.QueryRow(context.Background(), `SELECT id FROM "RefreshToken" WHERE "tokenHash"=$1`, tokenHash(token)).Scan(&tokenID); err != nil {
		t.Fatal(err)
	}
	a.server.tasks.close()
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	guard, err := a.server.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer guard.Rollback(context.Background())
	var pid int
	if err = guard.QueryRow(ctx, `SELECT pg_backend_pid() FROM "RefreshToken" WHERE id=$1 FOR UPDATE`, tokenID).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(Object{"refreshToken": token})
	refreshing := leaseAsyncRequest(ctx, &login, "POST", "/api/auth/refresh", string(raw))
	ownerLockWaitChain(t, a, pid, 1)
	refreshHeldUser := ownerLockNoKeyHeld(t, a, "User", text(user, "id"))
	if !refreshHeldUser {
		t.Error("refresh等待Token前必须先锁User元数据")
	}
	changing := leaseAsyncRequest(ctx, a, "PATCH", "/api/admin/users/"+text(user, "id"), `{"password":"replacement-password"}`)
	ownerLockWaitChain(t, a, pid, 2)
	if err = guard.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	rr, ur := <-refreshing, <-changing
	t.Log(fmt.Sprintf("refresh originally held User=%t; refreshHTTP=%d sensitiveHTTP=%d", refreshHeldUser, rr.status, ur.status))
	if rr.err != nil || ur.err != nil || rr.status != 200 || ur.status != 200 {
		t.Error("Refresh Token/User与敏感User/Token反序", rr.status, ur.status, rr.err, ur.err)
	}
}

func TestOwnerLockAdminEmailUpgradeAndTeamOwnerChangeHTTP(t *testing.T) {
	f := newLeasePolicyFixture(t, true, 1)
	a := f.a
	a.call("PATCH", "/api/admin/users/"+text(f.user, "id"), Object{"role": "admin"}, 200)
	login := *a
	login.token = ""
	session := login.call("POST", "/api/auth/admin/login", Object{"email": f.user["email"], "password": "  exact-password  "}, 200)
	admin := *a
	admin.token = text(session, "accessToken")
	a.server.tasks.close()
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	guard, err := a.server.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer guard.Rollback(context.Background())
	key := int64(time.Now().UnixNano()&0xfffffff) + (1 << 51)
	var pid int
	if err = guard.QueryRow(ctx, `SELECT pg_backend_pid() FROM pg_advisory_xact_lock($1)`, key).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	meteringExec(t, a, fmt.Sprintf(`CREATE FUNCTION gate_admin_email_statement() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_advisory_xact_lock(%d::bigint); RETURN NULL; END$$; CREATE TRIGGER gate_admin_email_statement BEFORE UPDATE ON "User" FOR EACH STATEMENT EXECUTE FUNCTION gate_admin_email_statement()`, key))
	raw, _ := json.Marshal(Object{"currentPassword": "  exact-password  ", "email": "upgraded-" + newID() + "@example.test"})
	changing := leaseAsyncRequest(ctx, &admin, "PUT", "/api/admin/me/security", string(raw))
	ownerLockWaitChain(t, a, pid, 1)
	if ownerLockKeyShareBlocked(t, a, "User", text(f.user, "id")) {
		t.Fatal("语句门闩必须位于email key升级前，不能用提前强锁伪造正控")
	}
	raw, _ = json.Marshal(Object{"ownerUserId": f.user["id"]})
	assigning := leaseAsyncRequest(ctx, a, "PATCH", "/api/admin/teams/"+text(f.sub, "teamId"), string(raw))
	ownerLockWaitChain(t, a, pid, 2)
	if err = guard.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	cr, tr := <-changing, <-assigning
	if cr.err != nil || tr.err != nil || cr.status != 200 || tr.status != 200 {
		t.Fatal("Team.ownerUserId FK必须在Sub后，不能与Admin email升级形成KS→Sub环", cr.status, tr.status, cr.err, tr.err)
	}
}

func TestOwnerLockJoinNewTeamAndFormerTeamTerminalMeteringHTTP(t *testing.T) {
	f := newLeasePolicyFixture(t, true, 1)
	a := f.a
	var memberID string
	if err := a.server.DB.QueryRow(context.Background(), `SELECT id FROM "TeamMember" WHERE "teamId"=$1 AND "userId"=$2`, f.sub["teamId"], f.user["id"]).Scan(&memberID); err != nil {
		t.Fatal(err)
	}
	a.call("DELETE", "/api/admin/teams/"+text(f.sub, "teamId")+"/members/"+memberID, nil, 200)
	var commandID string
	if err := a.server.DB.QueryRow(context.Background(), `SELECT id FROM "NodeCommandJob" WHERE "bindingId"=$1 AND "commandType"='DISABLE_USER' AND status='pending' ORDER BY "targetRevision" DESC LIMIT 1`, f.bindings[0]["id"]).Scan(&commandID); err != nil {
		t.Fatal(err)
	}
	agent := &testAPI{t: t, server: a.server, http: a.http, token: f.nodeTokens[text(f.nodes[0], "id")]}
	agent.call("POST", "/api/agent/v1/commands/"+commandID+"/result", Object{"status": "completed", "result": Object{"disableWatermarks": []Object{{"bootId": "former-team-final", "sequenceThrough": "1"}}}}, 200)
	binding, err := one(context.Background(), a.server.DB, `SELECT to_jsonb(b) FROM "PanelClientBinding" b WHERE id=$1`, f.bindings[0]["id"])
	if err != nil || binding["status"] != "disabled" || assertTerminalSettled(context.Background(), a.server.DB, binding) == nil {
		t.Fatal("夹具必须是已移出旧团队且真实停用水位仍待结算的绑定", binding["status"], err)
	}
	newOwner := a.createUser()
	team := a.call("POST", "/api/admin/teams", Object{"name": "新归属团队", "ownerUserId": newOwner["id"]}, 200)
	a.call("POST", "/api/admin/teams/"+text(team, "id")+"/subscriptions", Object{"planId": f.plan["id"], "expireAt": time.Now().UTC().Add(time.Hour).Format(time.RFC3339)}, 200)
	a.server.tasks.close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	guard, err := a.server.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer guard.Rollback(context.Background())
	key := int64(time.Now().UnixNano()&0xfffffff) + (1 << 52)
	var pid int
	if err = guard.QueryRow(ctx, `SELECT pg_backend_pid() FROM pg_advisory_xact_lock($1)`, key).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	// The real metering request already owns its Sub/binding/node scope here,
	// before inserting the incoming batch or touching any User FK.
	meteringExec(t, a, fmt.Sprintf(`CREATE FUNCTION gate_former_team_batch() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_advisory_xact_lock(%d::bigint); RETURN NULL; END$$; CREATE TRIGGER gate_former_team_batch BEFORE INSERT ON "NodeUsageBatch" FOR EACH STATEMENT EXECUTE FUNCTION gate_former_team_batch()`, key))
	raw, _ := json.Marshal(Object{"bootId": "former-team-final", "sequence": "1", "sampledAt": now(), "samples": []Object{{"bindingId": f.bindings[0]["id"], "counterGeneration": "1", "uplinkBytes": "10", "downlinkBytes": "0", "uplinkDeltaBytes": "10", "downlinkDeltaBytes": "0"}}})
	accounting := leaseAsyncRequest(ctx, agent, "POST", "/api/agent/v1/usage-batches", string(raw))
	ownerLockWaitChain(t, a, pid, 1)
	raw, _ = json.Marshal(Object{"userId": f.user["id"]})
	joining := leaseAsyncRequest(ctx, a, "POST", "/api/admin/teams/"+text(team, "id")+"/members", string(raw))
	ownerLockWaitChain(t, a, pid, 2)
	keyShareBlocked := ownerLockKeyShareBlocked(t, a, "User", text(f.user, "id"))
	if keyShareBlocked {
		t.Error("入组User元数据锁必须兼容旧团队最终计量的User FK")
	}
	if err = guard.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	mr, jr := <-accounting, <-joining
	t.Log("former-team settlement/new-team join", "UserKeyShareBlocked", keyShareBlocked, "meterHTTP", mr.status, "joinHTTP", jr.status)
	if mr.err != nil || jr.err != nil || mr.status != 200 || jr.status != 200 {
		t.Fatal("加入新团队User→历史Sub与旧团队计量Sub→User FK反序", mr.status, jr.status, mr.err, jr.err)
	}
	var members, ledgerBytes int
	if err = a.server.DB.QueryRow(ctx, `SELECT (SELECT count(*) FROM "TeamMember" WHERE "userId"=$1 AND "teamId"=$2),(SELECT coalesce(sum("usedTrafficBytes"),0) FROM "TrafficLedger" WHERE "userId"=$1 AND "teamId"=$3 AND "subscriptionId"=$4)`, f.user["id"], team["id"], f.sub["teamId"], f.sub["id"]).Scan(&members, &ledgerBytes); err != nil || members != 1 || ledgerBytes != 10 {
		t.Fatal("新归属或旧团队最终账本错误", members, ledgerBytes, err)
	}
}
