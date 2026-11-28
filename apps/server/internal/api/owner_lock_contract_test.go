package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestOwnerLockForeignKeyCompatibilityHTTP(t *testing.T) {
	for _, kind := range []string{"user_security", "admin_security", "team_metadata"} {
		t.Run(kind, func(t *testing.T) { ownerLockForeignKey(t, kind) })
	}

}

func ownerLockForeignKey(t *testing.T, kind string) Object {
	f := newLeasePolicyFixture(t, kind == "team_metadata", 1)
	a := f.a
	actor := a
	path := "/api/admin/users/" + text(f.user, "id") + "/security"
	body := `{"maxConcurrentSessionsOverride":1}`
	ownerTable, ownerID := "User", text(f.user, "id")
	if kind == "admin_security" {
		a.call("PATCH", "/api/admin/users/"+text(f.user, "id"), Object{"role": "admin"}, 200)
		login := *a
		login.token = ""
		session := login.call("POST", "/api/auth/admin/login", Object{"email": f.user["email"], "password": "  exact-password  "}, 200)
		fresh := *a
		fresh.token = text(session, "accessToken")
		actor = &fresh
		path = "/api/admin/me/security"
		raw, _ := json.Marshal(Object{"currentPassword": "  exact-password  ", "email": "changed-" + newID() + "@example.test"})
		body = string(raw)
	}
	if kind == "team_metadata" {
		ownerTable = "Team"
		ownerID = text(f.sub, "teamId")
		path = "/api/admin/teams/" + ownerID
		body = `{"name":"并发团队资料"}`
	}
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
	if _, err = guard.Exec(ctx, `DELETE FROM "PanelClientBinding" WHERE id=$1`, f.bindings[0]["id"]); err != nil {
		t.Fatal(err)
	}
	worker := make(chan error, 1)
	go func() { _, err := a.server.repairMissingBindingSubscription(ctx, text(f.sub, "id")); worker <- err }()
	ownerLockWaitChain(t, a, pid, 1)
	method := "PUT"
	if kind == "team_metadata" {
		method = "PATCH"
	}
	updating := leaseAsyncRequest(ctx, actor, method, path, body)
	ownerLockWaitChain(t, a, pid, 2)
	keyShareBlocked := ownerLockKeyShareBlocked(t, a, ownerTable, ownerID)
	if keyShareBlocked {
		t.Error("非键Owner元数据锁必须兼容FK KEY SHARE，email应在Sub后才升级")
	}
	if err = guard.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	workerErr, result := <-worker, <-updating
	proof := Object{"kind": kind, "ownerTable": ownerTable, "ownerKeyShareBlockedBeforeRelease": keyShareBlocked, "workerError": fmt.Sprint(workerErr), "HTTP": result.status, "HTTPError": fmt.Sprint(result.err), "guardedSub": f.sub["id"]}
	t.Log("actual owner/FK result", proof)
	if workerErr != nil || result.err != nil || result.status != 200 {
		t.Error("实际Owner→Sub / Sub→Owner FK反序尚未正确处理", proof)
	}
	return proof
}

func ownerLockWaitChain(t *testing.T, a *testAPI, pid, expected int) {
	t.Helper()
	deadline := time.Now().Add(4 * time.Second)
	for {
		var count int
		// Existing database-wide admin advisory locks can attach other private
		// schemas to this chain. Count only sessions touching our exact schema.
		err := a.server.DB.QueryRow(context.Background(), `WITH RECURSIVE blocked(pid) AS(SELECT $1::int UNION SELECT p.pid FROM pg_stat_activity p JOIN blocked b ON b.pid=ANY(pg_blocking_pids(p.pid))) SELECT count(*) FROM blocked b WHERE pid<>$1 AND EXISTS(SELECT 1 FROM pg_locks l JOIN pg_class c ON c.oid=l.relation JOIN pg_namespace n ON n.oid=c.relnamespace WHERE l.pid=b.pid AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND n.nspname=current_schema())`, pid).Scan(&count)
		if err != nil {
			t.Fatal(err)
		}
		if count == expected {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("未到精确Owner/Sub阻塞链", count, expected)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func ownerLockKeyShareBlocked(t *testing.T, a *testAPI, table, id string) bool {
	t.Helper()
	ctx := context.Background()
	probe, err := a.server.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer probe.Rollback(ctx)
	_, err = probe.Exec(ctx, `SELECT id FROM `+quote(table)+` WHERE id=$1 FOR KEY SHARE NOWAIT`, id)
	if err == nil {
		return false
	}
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "55P03" {
		t.Fatal("非实际KeyShare锁冲突", err)
	}
	return true
}

func ownerLockNoKeyHeld(t *testing.T, a *testAPI, table, id string) bool {
	t.Helper()
	ctx := context.Background()
	probe, err := a.server.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer probe.Rollback(ctx)
	_, err = probe.Exec(ctx, `SELECT id FROM `+quote(table)+` WHERE id=$1 FOR NO KEY UPDATE NOWAIT`, id)
	if err == nil {
		return false
	}
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "55P03" {
		t.Fatal("非实际NO KEY行锁冲突", err)
	}
	return true
}
