package api

import (
	"context"
	"net"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

func loginRateKeys(email, remote string) []string {
	ip, _, err := net.SplitHostPort(remote)
	if err != nil {
		ip = remote
	}
	keys := []string{"login:account:" + tokenHash(email), "login:ip:" + tokenHash(ip)}
	sort.Strings(keys)
	return keys
}
func (s *Server) admitLogin(ctx context.Context, keys []string) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for _, key := range keys {
		if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, key); err != nil {
			return err
		}
		record, err := one(ctx, tx, `SELECT to_jsonb(b) FROM "RateLimitBucket" b WHERE key=$1 FOR UPDATE`, key)
		count := 1
		if err == nil {
			blocked, _ := parseTimestamp(text(record, "blockedUntil"))
			if blocked.After(time.Now()) {
				return fail(429, "登录失败次数过多，请稍后重试。")
			}
			updated, _ := parseTimestamp(text(record, "updatedAt"))
			if time.Since(updated) < time.Hour {
				count = int(number(record, "count")) + 1
			}
		} else if err != pgx.ErrNoRows {
			return err
		}
		var blocked any
		if count >= 5 {
			delay := 30 * time.Second
			for i := 5; i < count && delay < 15*time.Minute; i++ {
				delay *= 2
			}
			if delay > 15*time.Minute {
				delay = 15 * time.Minute
			}
			blocked = time.Now().UTC().Add(delay)
		}
		if _, err = tx.Exec(ctx, `INSERT INTO "RateLimitBucket"(key,count,"blockedUntil","updatedAt") VALUES($1,$2,$3,now()) ON CONFLICT(key) DO UPDATE SET count=EXCLUDED.count,"blockedUntil"=EXCLUDED."blockedUntil","updatedAt"=now()`, key, count, blocked); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
func (s *Server) clearLoginLimit(ctx context.Context, keys []string) error {
	_, err := s.DB.Exec(ctx, `DELETE FROM "RateLimitBucket" WHERE key=ANY($1::text[])`, keys)
	return err
}
