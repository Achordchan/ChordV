package api

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestOwnerLockRefreshRechecksRevocationAndExpiryHTTP(t *testing.T) {
	for _, change := range []string{"revoked", "expires_while_waiting"} {
		t.Run(change, func(t *testing.T) {
			a := newTestAPI(t)
			user := a.createUser()
			public := *a
			public.token = ""
			session := public.call("POST", "/api/auth/login", Object{"email": user["email"], "password": "  exact-password  "}, 200)
			token := text(session, "refreshToken")
			var id string
			if err := a.server.DB.QueryRow(context.Background(), `SELECT id FROM "RefreshToken" WHERE "tokenHash"=$1`, tokenHash(token)).Scan(&id); err != nil {
				t.Fatal(err)
			}
			a.server.tasks.close()
			expires := time.Now().UTC().Add(3 * time.Second)
			if change == "expires_while_waiting" {
				meteringExec(t, a, `UPDATE "RefreshToken" SET "expiresAt"=$2 WHERE id=$1`, id, expires)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
			defer cancel()
			guard, err := a.server.DB.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer guard.Rollback(context.Background())
			var pid int
			if err = guard.QueryRow(ctx, `SELECT pg_backend_pid() FROM "RefreshToken" WHERE id=$1 FOR UPDATE`, id).Scan(&pid); err != nil {
				t.Fatal(err)
			}
			raw, _ := json.Marshal(Object{"refreshToken": token})
			refreshing := leaseAsyncRequest(ctx, &public, "POST", "/api/auth/refresh", string(raw))
			ownerLockWaitChain(t, a, pid, 1)
			if change == "revoked" {
				if _, err = guard.Exec(ctx, `UPDATE "RefreshToken" SET "revokedAt"=now() WHERE id=$1`, id); err != nil {
					t.Fatal(err)
				}
			} else {
				if !time.Now().Before(expires) {
					t.Fatal("夹具未在真实到期前到达Token行锁")
				}
				timer := time.NewTimer(time.Until(expires) + 20*time.Millisecond)
				defer timer.Stop()
				select {
				case <-timer.C:
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
			}
			if err = guard.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			result := <-refreshing
			if result.err != nil || result.status != 401 {
				t.Fatal("等待Token锁后必须重新检查撤销/真实到期，不能签发新会话", result.status, result.err)
			}
			var tokens int
			if err = a.server.DB.QueryRow(ctx, `SELECT count(*) FROM "RefreshToken" WHERE "userId"=$1`, user["id"]).Scan(&tokens); err != nil || tokens != 1 {
				t.Fatal("被拒刷新不得创建额外Token", tokens, err)
			}
		})
	}
}

func TestOwnerLockConversionRejectsChangedEffectiveTeamSubscriptionHTTP(t *testing.T) {
	f := newLeasePolicyFixture(t, false, 1)
	a := f.a
	team := a.call("POST", "/api/admin/teams", Object{"name": "目标重查", "ownerUserId": f.other["id"]}, 200)
	plan := a.createPlan("team")
	target := a.call("POST", "/api/admin/teams/"+text(team, "id")+"/subscriptions", Object{"planId": plan["id"], "expireAt": time.Now().UTC().Add(time.Hour).Format(time.RFC3339)}, 200)
	a.server.tasks.close()
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	guard, err := a.server.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer guard.Rollback(context.Background())
	var pid int
	if err = guard.QueryRow(ctx, `SELECT pg_backend_pid() FROM "Subscription" WHERE id=$1 FOR UPDATE`, target["id"]).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(Object{"targetTeamId": team["id"]})
	converting := leaseAsyncRequest(ctx, a, "POST", "/api/admin/subscriptions/"+text(f.sub, "id")+"/convert-to-team", string(raw))
	ownerLockWaitChain(t, a, pid, 1)
	if _, err = guard.Exec(ctx, `UPDATE "Subscription" SET state='paused' WHERE id=$1`, target["id"]); err != nil {
		t.Fatal(err)
	}
	replacement := "zz-conversion-new-" + newID()
	if _, err = guard.Exec(ctx, `INSERT INTO "Subscription"(id,"teamId","planId","totalTrafficGb","usedTrafficGb","remainingTrafficGb","totalTrafficBytes","usedTrafficBytes","expireAt",state,renewable,"lastSyncedAt","updatedAt") SELECT $2,"teamId","planId","totalTrafficGb","usedTrafficGb","remainingTrafficGb","totalTrafficBytes","usedTrafficBytes","expireAt",'active',renewable,now(),now() FROM "Subscription" WHERE id=$1`, target["id"], replacement); err != nil {
		t.Fatal(err)
	}
	if err = guard.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	result := <-converting
	if result.err != nil || result.status != 409 {
		t.Fatal("等待后有效目标变更必须409，不能补锁/使用未预锁的新Sub", result.status, result.err)
	}
	var state string
	var members int
	if err = a.server.DB.QueryRow(ctx, `SELECT state,(SELECT count(*) FROM "TeamMember" WHERE "userId"=$2) FROM "Subscription" WHERE id=$1`, f.sub["id"], f.user["id"]).Scan(&state, &members); err != nil || state != "active" || members != 0 {
		t.Fatal("目标变更409不得留下Member/个人订阅终态", state, members, err)
	}
	retried := a.call("POST", "/api/admin/subscriptions/"+text(f.sub, "id")+"/convert-to-team", Object{"targetTeamId": team["id"]}, 200)
	if retried["teamSubscriptionId"] != replacement {
		t.Fatal("明确重提必须锁定并使用当前目标", retried)
	}
}
