package database

import (
	"context"
	"embed"
	"fmt"

	"github.com/Achordchan/ChordV/apps/server/internal/config"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrations embed.FS

func Open(ctx context.Context, connection string, mode ...string) (*pgxpool.Pool, error) {
	validate := config.ValidateDatabaseURL
	if len(mode) > 0 && mode[0] == "production" {
		validate = config.ValidateProductionDatabaseURL
	}
	if err := validate(connection); err != nil {
		return nil, err
	}
	cfg, err := pgxpool.ParseConfig(connection)
	if err != nil {
		return nil, err
	}
	cfg.MaxConns = 10
	cfg.ConnConfig.RuntimeParams["timezone"] = "UTC"
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if err = pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return pool, nil
}

func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	connection, err := pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer connection.Release()
	unlock, err := lockMigrationSchema(ctx, connection)
	if err != nil {
		return err
	}
	defer unlock()
	scripts, err := embeddedScripts()
	if err != nil {
		return err
	}
	if err = prepareFreshMigration(ctx, connection, scripts); err != nil {
		return err
	}
	if _, err = connection.Exec(ctx, `CREATE TABLE IF NOT EXISTS "_chordv_migrations" (name text PRIMARY KEY, hash text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		return err
	}
	for _, script := range scripts {
		var old string
		err = connection.QueryRow(ctx, `SELECT hash FROM "_chordv_migrations" WHERE name=$1`, script.Name).Scan(&old)
		if err == nil {
			if old != script.Hash {
				return fmt.Errorf("迁移校验失败: %s", script.Name)
			}
			continue
		}
		if err != pgx.ErrNoRows {
			return err
		}
		// Enum values and CREATE INDEX CONCURRENTLY require file-level commits.
		if _, err = connection.Exec(ctx, string(script.SQL)); err != nil {
			return fmt.Errorf("迁移 %s: %w", script.Name, err)
		}
		if _, err = connection.Exec(ctx, `INSERT INTO "_chordv_migrations" (name,hash) VALUES($1,$2)`, script.Name, script.Hash); err != nil {
			return err
		}
	}
	return nil
}
