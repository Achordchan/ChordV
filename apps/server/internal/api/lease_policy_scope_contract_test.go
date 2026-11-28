package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"
	"time"
)

func leaseWantHTTPError(t *testing.T, err error, status int) {
	t.Helper()
	var httpErr HTTPError
	if !errors.As(err, &httpErr) || httpErr.Status != status {
		t.Fatalf("期望HTTP错误%d，实际%v", status, err)
	}
}

func TestLeasePolicyFrozenScopeRequiresRealTransactionAndKeepsFullSet(t *testing.T) {
	a := newTestAPI(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	leaseWantHTTPError(t, freezeRuntimeSubscriptions(ctx, a.server.DB, []string{}), 500)
	leaseWantHTTPError(t, requireRuntimeSubscriptions(ctx, a.server.DB, []string{}), 500)
	conn, err := a.server.DB.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	leaseWantHTTPError(t, freezeRuntimeSubscriptions(ctx, conn, []string{}), 500)
	for _, finish := range []string{"commit", "rollback"} {
		tx, err := conn.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, frozen, err := runtimeSubscriptionContract(ctx, tx); err != nil || frozen {
			t.Fatal("新事务或连接复用不得继承清单", frozen, err)
		}
		if err = freezeRuntimeSubscriptions(ctx, tx, []string{"b", "a"}); err != nil {
			t.Fatal(err)
		}
		if err = freezeRuntimeSubscriptions(ctx, tx, []string{"a"}); err != nil {
			t.Fatal(err)
		}
		ids, frozen, err := runtimeSubscriptionContract(ctx, tx)
		if err != nil || !frozen || len(ids) != 2 || ids[0] != "a" || ids[1] != "b" {
			t.Fatal("较窄nested不得覆盖首次完整清单", ids, frozen, err)
		}
		leaseWantHTTPError(t, freezeRuntimeSubscriptions(ctx, tx, []string{"c"}), 409)
		leaseWantHTTPError(t, lockRuntimeSubscriptionSet(ctx, tx, []string{"c"}), 409)
		ids, _, err = runtimeSubscriptionContract(ctx, tx)
		if err != nil || len(ids) != 2 {
			t.Fatal("失败扩张不得覆盖清单", ids, err)
		}
		if finish == "commit" {
			err = tx.Commit(ctx)
		} else {
			err = tx.Rollback(ctx)
		}
		if err != nil {
			t.Fatal(err)
		}
		leaseWantHTTPError(t, freezeRuntimeSubscriptions(ctx, tx, []string{}), 500)
	}
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, frozen, err := runtimeSubscriptionContract(ctx, tx); err != nil || frozen {
		t.Fatal("同一连接结束事务后清单没有自动清除", frozen, err)
	}
	if err = freezeRuntimeSubscriptions(ctx, tx, []string{}); err != nil {
		t.Fatal(err)
	}
	ids, frozen, err := runtimeSubscriptionContract(ctx, tx)
	if err != nil || !frozen || len(ids) != 0 {
		t.Fatal("冻结空[]必须区别未冻结", ids, frozen, err)
	}
	leaseWantHTTPError(t, requireRuntimeSubscriptions(ctx, tx, []string{"new-sub"}), 409)
}

func TestLeasePolicyFrozenScopeCorruptionFailsClosed(t *testing.T) {
	a := newTestAPI(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, raw := range []string{"not-json", "null", "{}", "[1]", `["b","a"]`, `["a","a"]`, `[""]`} {
		t.Run(raw, func(t *testing.T) {
			tx, err := a.server.DB.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(context.Background())
			hash := sha256.Sum256([]byte(raw))
			if _, err = tx.Exec(ctx, `SELECT set_config($1,$2,true),set_config($3,$4,true)`, runtimeSubscriptionsSetting, raw, runtimeSubscriptionsHashSetting, hex.EncodeToString(hash[:])); err != nil {
				t.Fatal(err)
			}
			leaseWantHTTPError(t, freezeRuntimeSubscriptions(ctx, tx, []string{}), 500)
			leaseWantHTTPError(t, lockRuntimeSubscriptionSet(ctx, tx, []string{}), 500)
		})
	}
	tx, err := a.server.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if err = freezeRuntimeSubscriptions(ctx, tx, []string{"original"}); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `SELECT set_config($1,'[]',true)`, runtimeSubscriptionsSetting); err != nil {
		t.Fatal(err)
	}
	leaseWantHTTPError(t, requireFrozenRuntimeSubscriptions(ctx, tx, []string{}), 500)
}

func TestLeasePolicyConnectRejectsNewResolvedSubscriptionAfterNodeWaitHTTP(t *testing.T) {
	f := newLeasePolicyFixture(t, false, 1)
	meteringExec(t, f.a, `UPDATE "Subscription" SET state='paused' WHERE id=$1`, f.sub["id"])
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	nodeGuard, err := f.a.server.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer nodeGuard.Rollback(context.Background())
	var pid int
	if err = nodeGuard.QueryRow(ctx, `SELECT pg_backend_pid() FROM "Node" WHERE id=$1 FOR NO KEY UPDATE`, f.nodes[0]["id"]).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	client := &testAPI{t: t, server: f.a.server, http: f.a.http, token: f.userToken}
	raw := `{"nodeId":"` + text(f.nodes[0], "id") + `","mode":"rule"}`
	connecting := leaseAsyncRequest(ctx, client, "POST", "/api/client/session/connect", raw)
	leaseWaitNodeBlock(t, f.a, pid, connecting)
	sub := f.a.call("POST", "/api/admin/subscriptions", Object{"userId": f.user["id"], "planId": f.plan["id"], "expireAt": time.Now().UTC().Add(time.Hour).Format(time.RFC3339)}, 200)
	subGuard, err := f.a.server.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer subGuard.Rollback(context.Background())
	var subPID int
	if err = subGuard.QueryRow(ctx, `SELECT pg_backend_pid() FROM "Subscription" WHERE id=$1 FOR UPDATE`, sub["id"]).Scan(&subPID); err != nil {
		t.Fatal(err)
	}
	if err = nodeGuard.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	var result leaseHTTPResult
	for {
		select {
		case result = <-connecting:
			if err = subGuard.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if result.err != nil || result.status != 409 {
				t.Fatal("connect两次resolve的未知Sub必须在补锁前409", result.status, result.err)
			}
			return
		default:
		}
		var waiting int
		if err = f.a.server.DB.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))`, subPID).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting > 0 {
			t.Error("connect已持Node后仍补拿未预锁的新resolved Sub")
			if err = subGuard.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			result = <-connecting
			t.Fatalf("补锁释放后真实HTTP=%d err=%v", result.status, result.err)
		}
		if time.Now().After(deadline) {
			t.Fatal("connect未明确409或到达补锁负控")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
