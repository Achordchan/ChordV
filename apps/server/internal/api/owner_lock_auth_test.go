package api

import (
	"context"
	"testing"
	"time"
)

func TestOwnerLockConnectRechecksAuthorizationAfterSubWaitHTTP(t *testing.T) {
	for _, sensitiveFirst := range []bool{false, true} {
		t.Run(map[bool]string{false: "connect_first", true: "sensitive_first"}[sensitiveFirst], func(t *testing.T) {
			f := newLeasePolicyFixture(t, false, 1)
			a := f.a
			// Existing legacy-source bindings are accepted by the installed=true connect
			// path but explicit direct-only disable does not mutate them. This exercises
			// the real path without suppressing any production withdrawal/ACK logic.
			meteringExec(t, a, `UPDATE "PanelClientBinding" SET source='xui' WHERE id=$1`, f.bindings[0]["id"])
			a.server.tasks.close()
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
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
			client := &testAPI{t: t, server: a.server, http: a.http, token: f.userToken}
			connectBody := `{"nodeId":"` + text(f.nodes[0], "id") + `","mode":"rule"}`
			sensitivePath := "/api/admin/users/" + text(f.user, "id")
			var connecting, changing <-chan leaseHTTPResult
			if sensitiveFirst {
				changing = leaseAsyncRequest(ctx, a, "PATCH", sensitivePath, `{"password":"replacement-password"}`)
			} else {
				connecting = leaseAsyncRequest(ctx, client, "POST", "/api/client/session/connect", connectBody)
			}
			ownerLockWaitChain(t, a, pid, 1)
			if sensitiveFirst {
				connecting = leaseAsyncRequest(ctx, client, "POST", "/api/client/session/connect", connectBody)
			} else {
				changing = leaseAsyncRequest(ctx, a, "PATCH", sensitivePath, `{"password":"replacement-password"}`)
			}
			ownerLockWaitChain(t, a, pid, 2)
			if err = guard.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			cr, ur := <-connecting, <-changing
			var active int
			if err = a.server.DB.QueryRow(ctx, `SELECT count(*) FROM "NodeSessionLease" WHERE "userId"=$1 AND status='active'`, f.user["id"]).Scan(&active); err != nil {
				t.Fatal(err)
			}
			t.Log("connect auth order", sensitiveFirst, "connectHTTP", cr.status, "sensitiveHTTP", ur.status, "finalActive", active)
			want := 200
			if sensitiveFirst {
				want = 401
			}
			if cr.err != nil || ur.err != nil || cr.status != want || ur.status != 200 || active != 0 {
				t.Error("旧connect必须在线性化Sub锁后重核撤权，不能复活active租约", cr.status, ur.status, active, cr.err, ur.err)
			}
		})
	}
}
