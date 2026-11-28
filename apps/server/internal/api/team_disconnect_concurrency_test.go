package api

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestTeamKickAndRemovalLockSubscriptionsBeforeMember(t *testing.T) {
	for _, disable := range []bool{false, true} {
		t.Run(fmt.Sprint(disable), func(t *testing.T) {
			a, team, member, sub := teamKickFixture(t)
			ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			defer cancel()
			var memberID, schema string
			if err := a.server.DB.QueryRow(ctx, `SELECT id,current_schema() FROM "TeamMember" WHERE "teamId"=$1 AND "userId"=$2`, team["id"], member["id"]).Scan(&memberID, &schema); err != nil {
				t.Fatal(err)
			}
			guard, err := a.server.DB.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer guard.Rollback(context.Background())
			if _, err = guard.Exec(ctx, `SELECT id FROM "Subscription" WHERE id=$1 FOR UPDATE`, sub["id"]); err != nil {
				t.Fatal(err)
			}
			type answer struct {
				status int
				err    error
			}
			done := make(chan answer, 2)
			for _, method := range []string{"POST", "DELETE"} {
				go func(method string) {
					url := a.http.URL + "/api/admin/teams/" + text(team, "id") + "/members/" + memberID
					if method == "POST" {
						url += "/kick"
					}
					req, err := http.NewRequestWithContext(ctx, method, url, strings.NewReader(fmt.Sprintf(`{"disableAccount":%t}`, disable)))
					if err != nil {
						done <- answer{err: err}
						return
					}
					req.Header.Set("Authorization", "Bearer "+a.token)
					req.Header.Set("Content-Type", "application/json")
					res, err := a.http.Client().Do(req)
					if err != nil {
						done <- answer{err: err}
						return
					}
					io.Copy(io.Discard, res.Body)
					res.Body.Close()
					done <- answer{status: res.StatusCode}
				}(method)
			}
			// Bounded test-only lock barrier, not application polling: both real HTTP
			// transactions must be observed waiting behind this exact schema's row lock.
			deadline := time.Now().Add(3 * time.Second)
			for {
				var waiting int
				if err = a.server.DB.QueryRow(ctx, `SELECT count(DISTINCT a.pid) FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid WHERE l.relation=to_regclass($1) AND a.wait_event_type='Lock' AND a.query LIKE '%Subscription%'`, schema+`."Subscription"`).Scan(&waiting); err != nil {
					t.Fatal(err)
				}
				if waiting >= 2 {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("两个HTTP事务没有到达订阅行锁屏障", waiting)
				}
				time.Sleep(5 * time.Millisecond)
			}
			probe, err := a.server.DB.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			_, err = probe.Exec(ctx, `SELECT id FROM "TeamMember" WHERE id=$1 FOR UPDATE NOWAIT`, memberID)
			probe.Rollback(ctx)
			if err != nil {
				t.Fatal("等待订阅锁前不应持有成员锁；否则kick/remove反序死锁", err)
			}
			if err = guard.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			for i := 0; i < 2; i++ {
				result := <-done
				if result.err != nil || (result.status != 200 && result.status != 404) {
					t.Fatal("并发断连/移出未正常收敛", result.status, result.err)
				}
			}
		})
	}
}
