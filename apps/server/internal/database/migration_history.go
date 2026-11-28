package database

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"sort"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type migrationScript struct {
	Name, PrismaName, Hash string
	SQL                    []byte
}

func migrationChecksum(raw []byte) string {
	hash := sha256.Sum256(bytes.ReplaceAll(raw, []byte("\r\n"), []byte("\n")))
	return hex.EncodeToString(hash[:])
}
func embeddedScripts() ([]migrationScript, error) {
	names, err := fs.Glob(migrations, "migrations/*.sql")
	if err != nil {
		return nil, err
	}
	sort.Strings(names)
	scripts := []migrationScript{}
	for _, name := range names {
		raw, err := migrations.ReadFile(name)
		if err != nil {
			return nil, err
		}
		scripts = append(scripts, migrationScript{Name: name, Hash: migrationChecksum(raw), SQL: raw})
	}
	return scripts, nil
}
func lockMigrationSchema(ctx context.Context, connection *pgxpool.Conn) (func(), error) {
	var key int64
	if err := connection.QueryRow(ctx, `SELECT hashtextextended(current_database()||chr(31)||current_schema(),486912625)`).Scan(&key); err != nil {
		return nil, err
	}
	if _, err := connection.Exec(ctx, `SELECT pg_advisory_lock($1)`, key); err != nil {
		return nil, err
	}
	return func() { _, _ = connection.Exec(context.Background(), `SELECT pg_advisory_unlock($1)`, key) }, nil
}
func relationExists(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, schema, table string) (bool, error) {
	var exists bool
	err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind='r')`, schema, table).Scan(&exists)
	return exists, err
}
func validateGoHistory(ctx context.Context, q interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, scripts []migrationScript) (map[string]string, error) {
	rows, err := q.Query(ctx, `SELECT name,hash FROM "_chordv_migrations" ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	existing := map[string]string{}
	for rows.Next() {
		var name, hash string
		if err = rows.Scan(&name, &hash); err != nil {
			return nil, err
		}
		existing[name] = hash
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	missing := false
	known := map[string]bool{}
	for _, script := range scripts {
		known[script.Name] = true
		hash, found := existing[script.Name]
		if !found {
			missing = true
			continue
		}
		if missing {
			return nil, fmt.Errorf("Go 迁移履历存在缺口: %s", script.Name)
		}
		if hash != script.Hash {
			return nil, fmt.Errorf("Go 迁移履历校验失败: %s", script.Name)
		}
	}
	for name := range existing {
		if !known[name] {
			return nil, fmt.Errorf("Go 迁移履历包含当前版本未知记录: %s", name)
		}
	}
	return existing, nil
}
func prepareFreshMigration(ctx context.Context, connection *pgxpool.Conn, scripts []migrationScript) error {
	var schema string
	if err := connection.QueryRow(ctx, `SELECT current_schema()`).Scan(&schema); err != nil {
		return err
	}
	exists, err := relationExists(ctx, connection, schema, "_chordv_migrations")
	if err != nil {
		return err
	}
	count := 0
	if exists {
		history, err := validateGoHistory(ctx, connection, scripts)
		if err != nil {
			return err
		}
		count = len(history)
	}
	if count == 0 {
		var occupied bool
		if err = connection.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN('r','p','v','m') AND c.relname<>'_chordv_migrations') OR EXISTS(SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=$1 AND t.typtype='e')`, schema).Scan(&occupied); err != nil {
			return err
		}
		if occupied {
			return fmt.Errorf("当前 schema 已有未知业务结构或 Prisma 履历；未重放初始化。仅完整已知的27份Prisma基线可显式 --adopt-prisma-baseline 接管")
		}
	}
	return nil
}
