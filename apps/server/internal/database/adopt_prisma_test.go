package database

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestEmbeddedPrismaContractMatchesActualSQLReplay(t *testing.T) {
	pool := isolatedSchema(t)
	replayHistoricalSchema(t, pool)
	actual := generatedContract(t, pool)
	expected, _, err := knownPrismaBaseline()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actual, expected) {
		t.Fatal("内嵌契约不是当前27份SQL真实目录结构")
	}
	t.Logf("实际重放结构吻合: %d表, %d列, %d枚举, %d约束, %d索引", len(actual.Shape["tables"]), len(actual.Shape["columns"]), len(actual.Shape["enums"]), len(actual.Shape["constraints"]), len(actual.Shape["indexes"]))
}
func TestAdoptPrismaPreservesBusinessAndHistoryThenMigratesOnlyNewGoSQL(t *testing.T) {
	pool := prismaFixture(t)
	beforeBusiness, beforePrisma := businessSnapshot(t, pool), prismaSnapshot(t, pool)
	result, err := AdoptPrismaBaseline(context.Background(), pool)
	if err != nil {
		t.Fatal(err)
	}
	if result.MigrationCount != 27 || result.AlreadyAdopted {
		t.Fatal("首次接管结果不正确", result)
	}
	beforeGo := goSnapshot(t, pool)
	// An idempotent retry must preserve the initial applied_at, not rewrite now().
	again, err := AdoptPrismaBaseline(context.Background(), pool)
	if err != nil || !again.AlreadyAdopted {
		t.Fatal(again, err)
	}
	if goSnapshot(t, pool) != beforeGo || prismaSnapshot(t, pool) != beforePrisma || businessSnapshot(t, pool) != beforeBusiness {
		t.Fatal("接管/重复接管改变了原履历时间或业务行")
	}
	var wrongDates int
	if err = pool.QueryRow(context.Background(), `SELECT count(*) FROM "_chordv_migrations" g JOIN "_prisma_migrations" p ON g.name='migrations/'||p.migration_name||'.sql' WHERE g.applied_at<>p.finished_at`).Scan(&wrongDates); err != nil || wrongDates != 0 {
		t.Fatal("首次接管没有保留原Prisma完成时间", wrongDates, err)
	}
	if err = Migrate(context.Background(), pool); err != nil {
		t.Fatal("接管后单独--migrate失败", err)
	}
	if count := scalar(t, pool, `SELECT count(*)::text FROM "_chordv_migrations"`); count != "28" {
		t.Fatal("没有只追加Go新增迁移", count)
	}
	if count := scalar(t, pool, `SELECT count(*)::text FROM "PolicyProfile" WHERE id='default'`); count != "1" {
		t.Fatal("Go新增默认策略迁移未执行")
	}
	if prismaSnapshot(t, pool) != beforePrisma || businessSnapshot(t, pool) != beforeBusiness {
		t.Fatal("Go后续迁移覆盖了旧业务数据或Prisma履历")
	}
	afterGo := goSnapshot(t, pool)
	if _, err = AdoptPrismaBaseline(context.Background(), pool); err != nil {
		t.Fatal(err)
	}
	if goSnapshot(t, pool) != afterGo {
		t.Fatal("接管已更新Go库时修改了历史")
	}
	t.Log("27条只接管履历；User/Plan/Subscription/设置原样保留；重复applied_at不变；单独Go迁移只追加第28条")
}
func TestAdoptPrismaAcceptsCRLFAndPreservesRolledBackAttempts(t *testing.T) {
	pool := prismaFixture(t)
	_, legacy, err := knownPrismaBaseline()
	if err != nil {
		t.Fatal(err)
	}
	crlf := bytes.ReplaceAll(legacy[0].SQL, []byte("\n"), []byte("\r\n"))
	hash := sha256.Sum256(crlf)
	execSQL(t, pool, `UPDATE "_prisma_migrations" SET checksum=$1 WHERE migration_name=$2`, hex.EncodeToString(hash[:]), legacy[0].PrismaName)
	execSQL(t, pool, `INSERT INTO "_prisma_migrations"(id,checksum,migration_name,started_at,rolled_back_at,logs) VALUES('old-rolled-back-attempt','old-aborted-script',$1,now()-interval '2 days',now()-interval '2 days'+interval '1 second','old failure kept for audit')`, legacy[0].PrismaName)
	before := prismaSnapshot(t, pool)
	if _, err = AdoptPrismaBaseline(context.Background(), pool); err != nil {
		t.Fatal(err)
	}
	if prismaSnapshot(t, pool) != before {
		t.Fatal("原始CRLF checksum或回滚审计记录被改写")
	}
}
func TestAdoptPrismaRejectsInvalidHistoryWithoutWrites(t *testing.T) {
	cases := map[string]struct{ sql, expected string }{
		"missing successful migration": {`DELETE FROM "_prisma_migrations" WHERE id='baseline-14'`, "缺少已成功迁移"},
		"failed unresolved migration":  {`UPDATE "_prisma_migrations" SET finished_at=NULL,logs='failed DDL' WHERE id='baseline-03'`, "尚未成功/尚未回滚"},
		"checksum tampered":            {`UPDATE "_prisma_migrations" SET checksum=repeat('0',64) WHERE id='baseline-10'`, "checksum不一致"},
		"unknown migration":            {`INSERT INTO "_prisma_migrations"(id,checksum,migration_name,started_at,finished_at) VALUES('unknown',repeat('0',64),'20261001000000_unknown',now(),now())`, "未知迁移"},
		"duplicate success":            {`INSERT INTO "_prisma_migrations" SELECT 'duplicate',checksum,finished_at,migration_name,logs,rolled_back_at,started_at,applied_steps_count FROM "_prisma_migrations" WHERE id='baseline-04'`, "重复成功记录"},
		"execution order":              {`UPDATE "_prisma_migrations" SET started_at=started_at-interval '2 hours',finished_at=finished_at-interval '2 hours' WHERE id='baseline-20'`, "执行顺序"},
		"finished before start":        {`UPDATE "_prisma_migrations" SET finished_at=started_at-interval '1 second' WHERE id='baseline-07'`, "时间顺序无效"},
		"only rolled back migration":   {`UPDATE "_prisma_migrations" SET finished_at=NULL,rolled_back_at=now() WHERE id='baseline-26'`, "缺少已成功迁移"},
	}
	for name, item := range cases {
		t.Run(name, func(t *testing.T) {
			pool := prismaFixture(t)
			execSQL(t, pool, item.sql)
			assertAdoptionRefused(t, pool, item.expected)
		})
	}
}
func TestAdoptPrismaRejectsSchemaDriftAndPartialGoLedger(t *testing.T) {
	cases := map[string]struct {
		change   func(*testing.T, *pgxpool.Pool)
		expected string
	}{
		"missing table": {func(t *testing.T, p *pgxpool.Pool) { execSQL(t, p, `DROP TABLE "RuntimeComponentFailureReport"`) }, "缺少必需表"},
		"column type": {func(t *testing.T, p *pgxpool.Pool) {
			execSQL(t, p, `ALTER TABLE "User" ALTER COLUMN "displayName" TYPE varchar(64)`)
		}, "columns结构"},
		"nullability": {func(t *testing.T, p *pgxpool.Pool) {
			execSQL(t, p, `ALTER TABLE "User" ALTER COLUMN email DROP NOT NULL`)
		}, "columns结构"},
		"default": {func(t *testing.T, p *pgxpool.Pool) {
			execSQL(t, p, `ALTER TABLE "User" ALTER COLUMN "authVersion" SET DEFAULT 2`)
		}, "columns结构"},
		"enum": {func(t *testing.T, p *pgxpool.Pool) { execSQL(t, p, `ALTER TYPE "UserRole" ADD VALUE 'unknown_role'`) }, "enums结构"},
		"foreign key": {func(t *testing.T, p *pgxpool.Pool) {
			execSQL(t, p, `ALTER TABLE "Subscription" DROP CONSTRAINT "Subscription_userId_fkey"`)
		}, "constraints结构"},
		"unique index":      {func(t *testing.T, p *pgxpool.Pool) { execSQL(t, p, `DROP INDEX "User_email_key"`) }, "indexes结构"},
		"unknown table":     {func(t *testing.T, p *pgxpool.Pool) { execSQL(t, p, `CREATE TABLE "OtherApplication"(id text)`) }, "tables结构"},
		"partial Go ledger": {func(t *testing.T, p *pgxpool.Pool) { createPartialGoLedger(t, p, false) }, "Go履历已部分写入"},
		"Go checksum tamper": {func(t *testing.T, p *pgxpool.Pool) {
			createPartialGoLedger(t, p, true)
			execSQL(t, p, `UPDATE "_chordv_migrations" SET hash=repeat('0',64) WHERE name LIKE '%_init.sql'`)
		}, "Go 迁移履历校验失败"},
		"Go ledger gap": {func(t *testing.T, p *pgxpool.Pool) {
			createPartialGoLedger(t, p, true)
			execSQL(t, p, `DELETE FROM "_chordv_migrations" WHERE name LIKE '%pending_attachment.sql'`)
		}, "Go 迁移履历存在缺口"},
		"unknown Go ledger": {func(t *testing.T, p *pgxpool.Pool) {
			createPartialGoLedger(t, p, true)
			execSQL(t, p, `INSERT INTO "_chordv_migrations"(name,hash) VALUES('migrations/unknown.sql',repeat('0',64))`)
		}, "未知记录"},
	}
	for name, item := range cases {
		t.Run(name, func(t *testing.T) {
			pool := prismaFixture(t)
			item.change(t, pool)
			assertAdoptionRefused(t, pool, item.expected)
		})
	}
}
func TestDefaultMigrationRejectsExistingUnknownOrPrismaStructures(t *testing.T) {
	t.Run("unknown schema", func(t *testing.T) {
		pool := isolatedSchema(t)
		execSQL(t, pool, `CREATE TABLE "UnrelatedData"(value text);INSERT INTO "UnrelatedData" VALUES('preserve')`)
		if err := Migrate(context.Background(), pool); err == nil {
			t.Fatal("默认迁移接管了未知现有结构")
		}
		if scalar(t, pool, `SELECT value FROM "UnrelatedData"`) != "preserve" {
			t.Fatal("未知业务行被修改")
		}
	})
	t.Run("Prisma requires explicit adoption", func(t *testing.T) {
		pool := prismaFixture(t)
		before := prismaSnapshot(t, pool)
		if err := Migrate(context.Background(), pool); err == nil {
			t.Fatal("默认迁移未拒绝旧Prisma基线")
		}
		if prismaSnapshot(t, pool) != before || goSnapshot(t, pool) != "absent" {
			t.Fatal("默认迁移在旧库写入了履历")
		}
	})
	t.Run("fresh schema", func(t *testing.T) {
		pool := isolatedSchema(t)
		if err := Migrate(context.Background(), pool); err != nil {
			t.Fatal(err)
		}
		before := goSnapshot(t, pool)
		if err := Migrate(context.Background(), pool); err != nil {
			t.Fatal(err)
		}
		if before != goSnapshot(t, pool) {
			t.Fatal("重复新库迁移修改了applied_at")
		}
	})
}
func TestAdoptionLockHonorsCancellationWithoutWrites(t *testing.T) {
	pool := prismaFixture(t)
	connection, err := pool.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Release()
	unlock, err := lockMigrationSchema(context.Background(), connection)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, err = AdoptPrismaBaseline(ctx, pool); err == nil {
		t.Fatal("接管未等待同schema迁移锁")
	}
	if goSnapshot(t, pool) != "absent" {
		t.Fatal("锁等待取消后仍写入履历")
	}
}

func TestAdoptionWriteFailureRollsBackAllInsertedHistory(t *testing.T) {
	pool := prismaFixture(t)
	execSQL(t, pool, `CREATE TABLE "_chordv_migrations"(name text PRIMARY KEY,hash text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now());CREATE FUNCTION reject_baseline_insert() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.name LIKE '%node_agent_control_plane.sql' THEN RAISE EXCEPTION 'blocked baseline insert';END IF;RETURN NEW;END$$;CREATE TRIGGER reject_partial_adoption BEFORE INSERT ON "_chordv_migrations" FOR EACH ROW EXECUTE FUNCTION reject_baseline_insert()`)
	assertAdoptionRefused(t, pool, "blocked baseline insert")
	if count := scalar(t, pool, `SELECT count(*)::text FROM "_chordv_migrations"`); count != "0" {
		t.Fatal("中途写入失败残留了部分基线履历", count)
	}
}
func TestConcurrentAdoptionSerializesAndPreservesAppliedTimes(t *testing.T) {
	pool := prismaFixture(t)
	results := make(chan AdoptionResult, 2)
	failures := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() {
			result, err := AdoptPrismaBaseline(context.Background(), pool)
			results <- result
			failures <- err
		}()
	}
	adopted, already := 0, 0
	for i := 0; i < 2; i++ {
		result := <-results
		err := <-failures
		if err != nil {
			t.Fatal(err)
		}
		if result.AlreadyAdopted {
			already++
		} else {
			adopted++
		}
	}
	if adopted != 1 || already != 1 {
		t.Fatal("并发接管没有归一为一次写入与一次幂等", adopted, already)
	}
	if count := scalar(t, pool, `SELECT count(*)::text FROM "_chordv_migrations"`); count != "27" {
		t.Fatal("并发接管履历数量异常", count)
	}
	before := goSnapshot(t, pool)
	if _, err := AdoptPrismaBaseline(context.Background(), pool); err != nil {
		t.Fatal(err)
	}
	if goSnapshot(t, pool) != before {
		t.Fatal("并发后重复接管改变applied_at")
	}
}
func TestAdoptionRefusesMissingPrismaLedger(t *testing.T) {
	pool := isolatedSchema(t)
	if _, err := AdoptPrismaBaseline(context.Background(), pool); err == nil {
		t.Fatal("缺少Prisma履历也成功接管")
	}
	if goSnapshot(t, pool) != "absent" {
		t.Fatal("缺少Prisma履历时仍建立Go履历")
	}
}

func TestGoMigrationChecksumNormalizesOnlyLineEndings(t *testing.T) {
	lf := []byte("SELECT 1;\nSELECT 2;\n")
	crlf := bytes.ReplaceAll(lf, []byte("\n"), []byte("\r\n"))
	if migrationChecksum(lf) != migrationChecksum(crlf) {
		t.Fatal("Git检出行尾导致Go迁移履历不可移植")
	}
	if migrationChecksum(lf) == migrationChecksum([]byte("SELECT 9;\nSELECT 2;\n")) {
		t.Fatal("非行尾内容篡改未被识别")
	}
}
