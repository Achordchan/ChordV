package database

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func prismaFixture(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool := isolatedSchema(t)
	replayHistoricalSchema(t, pool)
	execSQL(t, pool, `CREATE TABLE "_prisma_migrations"(id varchar(36) PRIMARY KEY,checksum varchar(64) NOT NULL,finished_at timestamptz,migration_name varchar(255) NOT NULL,logs text,rolled_back_at timestamptz,started_at timestamptz NOT NULL DEFAULT now(),applied_steps_count integer NOT NULL DEFAULT 0)`)
	_, legacy, err := knownPrismaBaseline()
	if err != nil {
		t.Fatal(err)
	}
	base := time.Now().UTC().Add(-24 * time.Hour).Truncate(time.Second)
	for index, script := range legacy {
		started := base.Add(time.Duration(index) * time.Minute)
		execSQL(t, pool, `INSERT INTO "_prisma_migrations"(id,checksum,finished_at,migration_name,started_at,applied_steps_count) VALUES($1,$2,$3,$4,$5,0)`, fmt.Sprintf("baseline-%02d", index), script.Hash, started.Add(time.Second), script.PrismaName, started)
	}
	execSQL(t, pool, `INSERT INTO "User"(id,email,"displayName",role,status,"passwordHash","lastSeenAt","updatedAt") VALUES('legacy-user','legacy@local.test','保留旧账号','user','active','unchanged-old-hash',now(),now())`)
	execSQL(t, pool, `INSERT INTO "Plan"(id,name,"totalTrafficGb",renewable,"updatedAt") VALUES('legacy-plan','旧套餐',10,true,now())`)
	execSQL(t, pool, `INSERT INTO "Subscription"(id,"userId","planId","totalTrafficGb","usedTrafficGb","remainingTrafficGb","totalTrafficBytes","usedTrafficBytes","expireAt",state,renewable,"lastSyncedAt","updatedAt") VALUES('legacy-sub','legacy-user','legacy-plan',10,2,8,10737418240,2147483648,now()+interval '30 days','active',true,now(),now())`)
	execSQL(t, pool, `INSERT INTO "SystemSetting"(key,value,"updatedAt") VALUES('legacy-sentinel','{"preserve":true,"value":1729}',now())`)
	return pool
}
func execSQL(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatal(err)
	}
}
func scalar(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) string {
	t.Helper()
	var value string
	if err := pool.QueryRow(context.Background(), sql, args...).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return value
}
func prismaSnapshot(t *testing.T, pool *pgxpool.Pool) string {
	return scalar(t, pool, `SELECT jsonb_agg(to_jsonb(m) ORDER BY migration_name,id)::text FROM "_prisma_migrations" m`)
}
func goSnapshot(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	schema := scalar(t, pool, `SELECT current_schema()`)
	exists, err := relationExists(context.Background(), pool, schema, "_chordv_migrations")
	if err != nil {
		t.Fatal(err)
	}
	if !exists {
		return "absent"
	}
	return scalar(t, pool, `SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY name),'[]')::text FROM "_chordv_migrations" m`)
}
func businessSnapshot(t *testing.T, pool *pgxpool.Pool) string {
	return scalar(t, pool, `SELECT jsonb_build_object('users',(SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM "User" u),'plans',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM "Plan" p),'subscriptions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM "Subscription" s),'sentinel',(SELECT value FROM "SystemSetting" WHERE key='legacy-sentinel'))::text`)
}
func createPartialGoLedger(t *testing.T, pool *pgxpool.Pool, all bool) {
	t.Helper()
	execSQL(t, pool, `CREATE TABLE "_chordv_migrations"(name text PRIMARY KEY,hash text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`)
	_, legacy, err := knownPrismaBaseline()
	if err != nil {
		t.Fatal(err)
	}
	for index, script := range legacy {
		if !all && index > 0 {
			break
		}
		execSQL(t, pool, `INSERT INTO "_chordv_migrations"(name,hash) VALUES($1,$2)`, script.Name, script.Hash)
	}
}
func assertAdoptionRefused(t *testing.T, pool *pgxpool.Pool, expected string) {
	t.Helper()
	beforePrisma, beforeGo, beforeBusiness := prismaSnapshot(t, pool), goSnapshot(t, pool), businessSnapshot(t, pool)
	_, err := AdoptPrismaBaseline(context.Background(), pool)
	if err == nil || !strings.Contains(err.Error(), expected) {
		t.Fatalf("应拒绝 %q，实际 %v", expected, err)
	}
	if prismaSnapshot(t, pool) != beforePrisma || goSnapshot(t, pool) != beforeGo || businessSnapshot(t, pool) != beforeBusiness {
		t.Fatal("拒绝接管时修改了旧履历、Go履历或业务行")
	}
	t.Log("已拒绝且无持久化写入:", err)
}
