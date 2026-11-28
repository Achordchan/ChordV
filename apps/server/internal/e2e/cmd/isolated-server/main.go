//go:build e2e

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"syscall"
	"time"

	"github.com/Achordchan/ChordV/apps/server/internal/api"
	"github.com/Achordchan/ChordV/apps/server/internal/config"
	"github.com/Achordchan/ChordV/apps/server/internal/database"
	"github.com/Achordchan/ChordV/apps/server/internal/httplifecycle"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "isolated acceptance server:", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil || cfg.Mode != "local" || cfg.Address != "127.0.0.1:0" {
		return errors.New("验收服务只接受本地配置和随机回环端口")
	}
	schema, nonce := os.Getenv("CHORDV_AGENT_E2E_SCHEMA"), os.Getenv("CHORDV_AGENT_E2E_SCHEMA_NONCE")
	if !regexp.MustCompile(`^chordv_agent_e2e_[a-f0-9]{32}$`).MatchString(schema) || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(nonce) {
		return errors.New("验收服务必须使用本次私有schema身份")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	pc, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return errors.New("本地数据库配置无效")
	}
	pc.MaxConns = 10
	pc.ConnConfig.RuntimeParams["timezone"] = "UTC"
	pc.ConnConfig.RuntimeParams["search_path"] = schema + ",pg_catalog"
	pc.ConnConfig.RuntimeParams["application_name"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, pc)
	if err != nil {
		return errors.New("创建验收数据库连接失败")
	}
	defer pool.Close()
	var actual, marker, owner string
	var search []string
	if err := pool.QueryRow(ctx, `SELECT current_schema(),current_schemas(false),coalesce(obj_description(oid,'pg_namespace'),''),pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname=$1`, schema).Scan(&actual, &search, &marker, &owner); err != nil || actual != schema || len(search) != 2 || search[0] != schema || search[1] != "pg_catalog" || marker != nonce || owner != pc.ConnConfig.User || owner != "chordv_local" {
		return errors.New("验收数据库schema归属或search_path不匹配")
	}
	if err := database.Migrate(ctx, pool); err != nil {
		return fmt.Errorf("私有schema迁移失败: %w", err)
	}
	if err := os.MkdirAll(cfg.DataDir, 0700); err != nil {
		return err
	}
	service := api.New(pool, cfg)
	defer service.Close()
	if err := service.CreateAdmin(ctx, os.Getenv("CHORDV_AGENT_E2E_ADMIN_EMAIL"), os.Getenv("CHORDV_LOCAL_ADMIN_PASSWORD")); err != nil {
		return err
	}
	if err := service.Start(ctx); err != nil {
		return err
	}
	listener, err := net.Listen("tcp4", cfg.Address)
	if err != nil {
		return err
	}
	defer listener.Close()
	server := &http.Server{Handler: service.Handler(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 32 << 10}
	if err := json.NewEncoder(os.Stdout).Encode(map[string]any{"event": "ready", "node": map[string]any{"base": "http://" + listener.Addr().String(), "schema": actual, "searchPath": search, "pid": os.Getpid()}}); err != nil {
		return err
	}
	return httplifecycle.Serve(ctx, server, listener, 10*time.Second, service.Close)
}
