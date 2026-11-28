package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"github.com/Achordchan/ChordV/apps/server/internal/buildinfo"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Achordchan/ChordV/apps/server/internal/api"
	"github.com/Achordchan/ChordV/apps/server/internal/config"
	"github.com/Achordchan/ChordV/apps/server/internal/database"
	"github.com/Achordchan/ChordV/apps/server/internal/httplifecycle"
)

func main() {
	if err := run(); err != nil {
		slog.Error("本地服务启动失败", "error", err)
		os.Exit(1)
	}
}
func run() error {
	version := flag.Bool("version", false, "输出当前服务端构建版本后退出")
	migrate := flag.Bool("migrate", false, "在显式配置的数据库执行Go迁移后退出")
	adoptPrisma := flag.Bool("adopt-prisma-baseline", false, "显式校验并接管已完成27份历史迁移的Prisma基线，仅写Go履历后退出")
	createAdmin := flag.String("create-admin", "", "创建本地管理员；密码从 CHORDV_LOCAL_ADMIN_PASSWORD 读取")
	flag.Parse()
	actions := 0
	for _, active := range []bool{*version, *migrate, *adoptPrisma, *createAdmin != ""} {
		if active {
			actions++
		}
	}
	if actions > 1 {
		return errors.New("version、migrate、adopt-prisma-baseline、create-admin必须分别执行")
	}
	if *version {
		return json.NewEncoder(os.Stdout).Encode(map[string]string{"version": buildinfo.Version, "commit": buildinfo.Commit, "builtAt": buildinfo.BuiltAt})
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	pool, err := database.Open(ctx, cfg.DatabaseURL, cfg.Mode)
	if err != nil {
		return err
	}
	defer pool.Close()
	if *adoptPrisma {
		result, err := database.AdoptPrismaBaseline(ctx, pool)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(result)
	}
	if *migrate {
		return database.Migrate(ctx, pool)
	}
	service := api.New(pool, cfg)
	defer service.Close()
	if *createAdmin != "" {
		return service.CreateAdmin(ctx, *createAdmin, func() string {
			if cfg.Production() {
				return os.Getenv("CHORDV_ADMIN_PASSWORD")
			}
			return os.Getenv("CHORDV_LOCAL_ADMIN_PASSWORD")
		}())
	}
	if err = service.Start(ctx); err != nil {
		return err
	}
	server := &http.Server{Addr: cfg.Address, Handler: service.Handler(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 32 << 10}
	listener, err := net.Listen("tcp", server.Addr)
	if err != nil {
		return err
	}
	slog.Info("本地 Go 服务启动", "address", listener.Addr().String(), "mode", cfg.RuntimeMode())
	return httplifecycle.Serve(ctx, server, listener, 15*time.Second, service.Close)
}
