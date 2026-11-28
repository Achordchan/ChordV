package database

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/Achordchan/ChordV/apps/server/internal/config"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func isolatedSchema(t *testing.T) *pgxpool.Pool {
	t.Helper()
	raw := os.Getenv("CHORDV_LOCAL_DATABASE_URL")
	if raw == "" {
		t.Skip("需要显式本地隔离数据库；不读取旧 DATABASE_URL")
	}
	if err := config.ValidateDatabaseURL(raw); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	base, err := pgxpool.New(ctx, raw)
	if err != nil {
		t.Fatal(err)
	}
	bytes := make([]byte, 12)
	if _, err = rand.Read(bytes); err != nil {
		base.Close()
		t.Fatal(err)
	}
	schema := "go_adopt_test_" + hex.EncodeToString(bytes)
	if _, err = base.Exec(ctx, `CREATE SCHEMA `+pgx.Identifier{schema}.Sanitize()); err != nil {
		base.Close()
		t.Fatal(err)
	}
	cfg, err := pgxpool.ParseConfig(raw)
	if err != nil {
		t.Fatal(err)
	}
	cfg.MaxConns = 3
	cfg.ConnConfig.RuntimeParams["search_path"] = schema + ",pg_catalog"
	cfg.ConnConfig.RuntimeParams["timezone"] = "UTC"
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, err := base.Exec(context.Background(), `DROP SCHEMA `+pgx.Identifier{schema}.Sanitize()+` CASCADE`)
		base.Close()
		if err != nil {
			t.Error("只清理本测试独立schema失败", err)
		}
	})
	return pool
}
func historicalScripts(t *testing.T) []string {
	t.Helper()
	names, err := fs.Glob(migrations, "migrations/*.sql")
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(names)
	result := []string{}
	for _, name := range names {
		if filepath.Base(name) <= "20260928150000_achord_connect_support.sql" {
			result = append(result, name)
		}
	}
	if len(result) != 27 {
		t.Fatal("已知Prisma基线必须为27份内嵌历史SQL", len(result))
	}
	return result
}
func replayHistoricalSchema(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	for _, name := range historicalScripts(t) {
		raw, err := migrations.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = pool.Exec(context.Background(), string(raw)); err != nil {
			t.Fatalf("独立schema重放 %s: %v", name, err)
		}
	}
}
func generatedContract(t *testing.T, pool *pgxpool.Pool) legacySchemaContract {
	t.Helper()
	var schema string
	if err := pool.QueryRow(context.Background(), `SELECT current_schema()`).Scan(&schema); err != nil {
		t.Fatal(err)
	}
	shape, err := readSchemaShape(context.Background(), pool, schema)
	if err != nil {
		t.Fatal(err)
	}
	contract := legacySchemaContract{Format: 1, Migrations: map[string]string{}, Shape: shape}
	for _, name := range historicalScripts(t) {
		raw, _ := migrations.ReadFile(name)
		contract.Migrations[strings.TrimSuffix(filepath.Base(name), ".sql")] = migrationChecksum(raw)
	}
	return contract
}
func TestGenerateLegacyPrismaContract(t *testing.T) {
	if os.Getenv("CHORDV_GENERATE_LEGACY_CONTRACT") != "1" {
		t.Skip("仅显式生成审计契约；正常测试不写源码")
	}
	pool := isolatedSchema(t)
	replayHistoricalSchema(t, pool)
	contract := generatedContract(t, pool)
	raw, err := json.MarshalIndent(contract, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll("contracts", 0755); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile("contracts/legacy-prisma.json", append(raw, '\n'), 0644); err != nil {
		t.Fatal(err)
	}
	t.Log("结构契约由独立临时schema中的27份内嵌SQL真实重放生成；业务schema未更改")
}
