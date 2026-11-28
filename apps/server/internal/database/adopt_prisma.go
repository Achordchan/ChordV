package database

import (
	"bytes"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path"
	"reflect"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed contracts/legacy-prisma.json
var legacyPrismaContract []byte

const legacyPrismaLast = "20260928150000_achord_connect_support"

type AdoptionResult struct {
	Schema         string `json:"schema"`
	MigrationCount int    `json:"migrationCount"`
	AlreadyAdopted bool   `json:"alreadyAdopted"`
}
type prismaRecord struct {
	Name, Checksum       string
	Started              time.Time
	Finished, RolledBack *time.Time
}

func knownPrismaBaseline() (legacySchemaContract, []migrationScript, error) {
	var contract legacySchemaContract
	if err := json.Unmarshal(legacyPrismaContract, &contract); err != nil {
		return contract, nil, err
	}
	if contract.Format != 1 || len(contract.Migrations) != 27 || len(contract.Shape) != 5 {
		return contract, nil, fmt.Errorf("内嵌旧库结构契约无效")
	}
	scripts, err := embeddedScripts()
	if err != nil {
		return contract, nil, err
	}
	legacy := []migrationScript{}
	for _, script := range scripts {
		script.PrismaName = strings.TrimSuffix(path.Base(script.Name), ".sql")
		if script.PrismaName > legacyPrismaLast {
			continue
		}
		if contract.Migrations[script.PrismaName] != script.Hash {
			return contract, nil, fmt.Errorf("内嵌SQL与旧库结构契约checksum不一致: %s", script.PrismaName)
		}
		legacy = append(legacy, script)
	}
	if len(legacy) != 27 {
		return contract, nil, fmt.Errorf("仅支持完整已知27份Prisma历史基线")
	}
	return contract, legacy, nil
}
func prismaChecksumMatches(raw []byte, checksum string) bool {
	if len(checksum) != 64 {
		return false
	}
	lf := bytes.ReplaceAll(raw, []byte("\r\n"), []byte("\n"))
	crlf := bytes.ReplaceAll(lf, []byte("\n"), []byte("\r\n"))
	for _, variant := range [][]byte{raw, lf, crlf} {
		hash := sha256.Sum256(variant)
		if hex.EncodeToString(hash[:]) == checksum {
			return true
		}
	}
	return false
}
func readPrismaHistory(ctx context.Context, tx pgx.Tx, legacy []migrationScript) (map[string]prismaRecord, error) {
	rows, err := tx.Query(ctx, `SELECT migration_name,checksum,started_at,finished_at,rolled_back_at FROM "_prisma_migrations" ORDER BY started_at,migration_name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	scripts := map[string]migrationScript{}
	for _, script := range legacy {
		scripts[script.PrismaName] = script
	}
	success := map[string]prismaRecord{}
	for rows.Next() {
		var record prismaRecord
		if err = rows.Scan(&record.Name, &record.Checksum, &record.Started, &record.Finished, &record.RolledBack); err != nil {
			return nil, err
		}
		script, known := scripts[record.Name]
		if !known {
			return nil, fmt.Errorf("Prisma履历存在未知迁移: %s", record.Name)
		}
		if record.RolledBack != nil {
			continue
		}
		if record.Finished == nil {
			return nil, fmt.Errorf("Prisma存在尚未成功/尚未回滚的迁移: %s", record.Name)
		}
		if _, duplicate := success[record.Name]; duplicate {
			return nil, fmt.Errorf("Prisma迁移存在重复成功记录: %s", record.Name)
		}
		if !prismaChecksumMatches(script.SQL, record.Checksum) {
			return nil, fmt.Errorf("Prisma历史SQL checksum不一致: %s", record.Name)
		}
		if record.Finished.Before(record.Started) {
			return nil, fmt.Errorf("Prisma迁移时间顺序无效: %s", record.Name)
		}
		success[record.Name] = record
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	var previous *time.Time
	for _, script := range legacy {
		record, ok := success[script.PrismaName]
		if !ok {
			return nil, fmt.Errorf("Prisma基线缺少已成功迁移: %s", script.PrismaName)
		}
		if previous != nil && record.Started.Before(*previous) {
			return nil, fmt.Errorf("Prisma历史迁移执行顺序与已知基线不一致: %s", record.Name)
		}
		previous = record.Finished
	}
	return success, nil
}

// AdoptPrismaBaseline never executes business DDL or repairs unknown drift. It
// accepts only the complete known legacy baseline, then records Go checksums.
func AdoptPrismaBaseline(ctx context.Context, pool *pgxpool.Pool) (AdoptionResult, error) {
	result := AdoptionResult{}
	contract, legacy, err := knownPrismaBaseline()
	if err != nil {
		return result, err
	}
	connection, err := pool.Acquire(ctx)
	if err != nil {
		return result, err
	}
	defer connection.Release()
	unlock, err := lockMigrationSchema(ctx, connection)
	if err != nil {
		return result, err
	}
	defer unlock()
	tx, err := connection.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer tx.Rollback(context.Background())
	if err = tx.QueryRow(ctx, `SELECT current_schema()`).Scan(&result.Schema); err != nil {
		return result, err
	}
	// Pin every subsequent name to the schema that was validated; never fall
	// through a caller's search_path to another application's migration ledger.
	if _, err = tx.Exec(ctx, `SELECT set_config('search_path',$1,true)`, pgx.Identifier{result.Schema}.Sanitize()+",pg_catalog"); err != nil {
		return result, err
	}
	exists, err := relationExists(ctx, tx, result.Schema, "_prisma_migrations")
	if err != nil {
		return result, err
	}
	if !exists {
		return result, fmt.Errorf("当前schema没有Prisma履历，拒绝推测接管")
	}
	if _, err = tx.Exec(ctx, `LOCK TABLE "_prisma_migrations" IN SHARE MODE`); err != nil {
		return result, err
	}
	history, err := readPrismaHistory(ctx, tx, legacy)
	if err != nil {
		return result, err
	}
	// Take short-lived SHARE locks to keep writes and schema/index changes out
	// while validating the catalog and atomically establishing the Go ledger.
	tables := []string{}
	for _, value := range contract.Shape["tables"] {
		name, ok := value.(string)
		if !ok {
			return result, fmt.Errorf("内嵌表结构契约无效")
		}
		found, e := relationExists(ctx, tx, result.Schema, name)
		if e != nil {
			return result, e
		}
		if !found {
			return result, fmt.Errorf("旧库结构缺少必需表: %s", name)
		}
		tables = append(tables, pgx.Identifier{result.Schema, name}.Sanitize())
	}
	if _, err = tx.Exec(ctx, `LOCK TABLE `+strings.Join(tables, ",")+` IN SHARE MODE`); err != nil {
		return result, err
	}
	actual, err := readSchemaShape(ctx, tx, result.Schema)
	if err != nil {
		return result, err
	}
	for _, kind := range []string{"tables", "columns", "enums", "constraints", "indexes"} {
		if !reflect.DeepEqual(contract.Shape[kind], actual[kind]) {
			return result, fmt.Errorf("旧库%s结构与27份历史SQL契约不一致，未写入Go履历", kind)
		}
	}
	scripts, err := embeddedScripts()
	if err != nil {
		return result, err
	}
	goLedger, err := relationExists(ctx, tx, result.Schema, "_chordv_migrations")
	if err != nil {
		return result, err
	}
	if goLedger {
		if _, err = tx.Exec(ctx, `LOCK TABLE "_chordv_migrations" IN SHARE ROW EXCLUSIVE MODE`); err != nil {
			return result, err
		}
		existing, e := validateGoHistory(ctx, tx, scripts)
		if e != nil {
			return result, e
		}
		if len(existing) > 0 {
			for _, script := range legacy {
				if existing[script.Name] != script.Hash {
					return result, fmt.Errorf("Go履历已部分写入或不一致，拒绝覆盖: %s", script.Name)
				}
			}
			result.MigrationCount = len(legacy)
			result.AlreadyAdopted = true
			return result, tx.Commit(ctx)
		}
	}
	if _, err = tx.Exec(ctx, `CREATE TABLE IF NOT EXISTS "_chordv_migrations" (name text PRIMARY KEY,hash text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		return result, err
	}
	for _, script := range legacy {
		if _, err = tx.Exec(ctx, `INSERT INTO "_chordv_migrations"(name,hash,applied_at) VALUES($1,$2,$3)`, script.Name, script.Hash, history[script.PrismaName].Finished); err != nil {
			return result, err
		}
	}
	result.MigrationCount = len(legacy)
	return result, tx.Commit(ctx)
}
