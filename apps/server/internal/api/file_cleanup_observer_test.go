package api

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Test-only SQL notifications observe real committed worker writes, without
// polling database state or replacing the filesystem/delete implementation.
func cleanupObserver(a *testAPI) func(string, string) Object {
	a.t.Helper()
	channel := "cleanup_test_" + strings.ReplaceAll(newID(), "-", "")
	listener, err := a.server.DB.Acquire(context.Background())
	if err != nil {
		a.t.Fatal(err)
	}
	if _, err = listener.Exec(context.Background(), `LISTEN `+pgx.Identifier{channel}.Sanitize()); err != nil {
		listener.Release()
		a.t.Fatal(err)
	}
	a.t.Cleanup(func() {
		_, _ = listener.Exec(context.Background(), `UNLISTEN *`)
		listener.Release()
	})
	_, err = a.server.DB.Exec(context.Background(), `CREATE FUNCTION cleanup_test_notify() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_notify('`+channel+`',json_build_object('operation',TG_OP,'id',OLD.id,'at',clock_timestamp())::text); RETURN NULL; END $$; CREATE TRIGGER cleanup_test_notify AFTER UPDATE OR DELETE ON "FileCleanupJob" FOR EACH ROW EXECUTE FUNCTION cleanup_test_notify()`)
	if err != nil {
		a.t.Fatal(err)
	}
	return func(id, operation string) Object {
		a.t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		for {
			event, err := listener.Conn().WaitForNotification(ctx)
			if err != nil {
				a.t.Fatal("未收到实际清理任务提交事件", operation, err)
			}
			value := Object{}
			if err = json.Unmarshal([]byte(event.Payload), &value); err != nil {
				a.t.Fatal(err)
			}
			if value["id"] == id && value["operation"] == operation {
				return value
			}
		}
	}
}

func waitCleanupLockGate(t *testing.T, pool *pgxpool.Pool, ctx context.Context, pid int) {
	t.Helper()
	tick := time.NewTicker(5 * time.Millisecond)
	defer tick.Stop()
	for {
		var count int
		if err := pool.QueryRow(ctx, `WITH RECURSIVE blocked(pid) AS(SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) UNION SELECT p.pid FROM pg_stat_activity p JOIN blocked b ON b.pid=ANY(pg_blocking_pids(p.pid))) SELECT count(*) FROM blocked`, pid).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count >= 2 {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal("并发请求未同时到达清理任务行锁")
		case <-tick.C:
		}
	}
}
