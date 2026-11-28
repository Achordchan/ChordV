package api

import (
	"context"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/Achordchan/ChordV/apps/server/internal/config"
	"github.com/Achordchan/ChordV/apps/server/internal/database"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type testAPI struct {
	t       *testing.T
	server  *Server
	http    *httptest.Server
	token   string
	adminID string
}

func newTestAPI(t *testing.T) *testAPI {
	t.Helper()
	if os.Getenv("CHORDV_LOCAL_DATABASE_URL") == "" {
		t.Skip("需要显式本地隔离数据库；API测试仅写随机私有schema")
	}
	cfg, err := config.Load()
	if err != nil || cfg.Mode != "local" {
		t.Fatal("API测试只允许本地配置", err)
	}
	ctx := context.Background()
	base, err := database.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	schema := "api_test_" + strings.ReplaceAll(newID(), "-", "")
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err = base.Exec(ctx, `CREATE SCHEMA `+identifier); err != nil {
		base.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := base.Exec(context.Background(), `DROP SCHEMA `+identifier+` CASCADE`); err != nil {
			t.Error("清理本次API测试schema失败", err)
		}
		base.Close()
	})
	// Copy the validated local pool's 10-connection/UTC configuration. Only
	// this test pool gets a private search_path, with no public fallback.
	poolConfig := base.Config()
	poolConfig.ConnConfig.RuntimeParams["search_path"] = schema + ",pg_catalog"
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	var actual string
	if err = pool.QueryRow(ctx, `SELECT current_schema()`).Scan(&actual); err != nil || actual != schema {
		t.Fatal("API测试必须运行于本次私有schema", actual, err)
	}
	var firstHistory string
	for pass := 0; pass < 2; pass++ {
		if err = database.Migrate(ctx, pool); err != nil {
			t.Fatal("私有schema迁移失败", pass, err)
		}
		var history string
		if err = pool.QueryRow(ctx, `SELECT md5(jsonb_agg(to_jsonb(m) ORDER BY name)::text) FROM "_chordv_migrations" m`).Scan(&history); err != nil {
			t.Fatal(err)
		}
		if pass == 1 && history != firstHistory {
			t.Fatal("第二次迁移改变了私有schema履历")
		}
		firstHistory = history
	}
	cfg.DataDir = t.TempDir()
	s := New(pool, cfg)
	t.Cleanup(s.Close)
	if err = s.Start(ctx); err != nil {
		t.Fatal(err)
	}
	stopTestMaintenance(s)
	email := "integration-" + newID() + "@local.test"
	if err = s.CreateAdmin(ctx, email, "integration-secret-123"); err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(s.Handler())
	t.Cleanup(httpServer.Close)
	a := &testAPI{t: t, server: s, http: httpServer}
	if err = pool.QueryRow(ctx, `SELECT id FROM "User" WHERE email=$1`, email).Scan(&a.adminID); err != nil {
		t.Fatal(err)
	}
	login := a.call("POST", "/api/auth/admin/login", Object{"email": email, "password": "integration-secret-123"}, 200)
	a.token = text(login, "accessToken")
	if a.token == "" {
		t.Fatal("真实管理员鉴权未返回访问凭据")
	}
	t.Log("独立API测试schema:", schema)
	return a
}

func TestAPIHarnessIsolatesSchemasSettingsAndAuthentication(t *testing.T) {
	a, b := newTestAPI(t), newTestAPI(t)
	schemas := map[string]bool{}
	for _, fixture := range []*testAPI{a, b} {
		var schema, timezone string
		var search []string
		if err := fixture.server.DB.QueryRow(context.Background(), `SELECT current_schema(),current_schemas(false),current_setting('timezone')`).Scan(&schema, &search, &timezone); err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(schema, "api_test_") || schemas[schema] || len(search) != 2 || search[0] != schema || search[1] != "pg_catalog" || timezone != "UTC" || fixture.server.DB.Config().MaxConns != 10 {
			t.Fatal("夹具必须使用独立schema、无public回退、UTC和10连接池", schema, search)
		}
		schemas[schema] = true
		if len(fixture.array("/api/admin/users")) != 1 || len(fixture.array("/api/admin/nodes")) != 0 || len(fixture.array("/api/admin/plans")) != 0 || len(fixture.array("/api/admin/subscriptions")) != 0 {
			t.Fatal("新夹具不应读取其他测试或QA业务记录")
		}
	}
	a.call("PATCH", "/api/admin/image-bed/config", Object{"baseUrl": "http://127.0.0.1:12345", "apiToken": "private-schema-only-token"}, 200)
	if a.call("GET", "/api/admin/image-bed/config", nil, 200)["hasToken"] != true || b.call("GET", "/api/admin/image-bed/config", nil, 200)["hasToken"] != false {
		t.Fatal("设置写入泄漏到其他私有schema")
	}
	foreign := &testAPI{t: t, http: b.http, token: a.token}
	foreign.call("GET", "/api/admin/users", nil, 401)
}

// Ordinary fixtures keep real runtime workers, but never run hourly maintenance against case data.
func stopTestMaintenance(s *Server) {
	stop := func() {
		s.tasks.mu.Lock()
		defer s.tasks.mu.Unlock()
		for _, key := range []string{meteringMaintenanceKey, webhookMaintenanceKey} {
			if timer := s.tasks.timers[key]; timer != nil {
				timer.Stop()
				delete(s.tasks.timers, key)
			}
		}
	}
	stop()
	s.tasks.wg.Wait()
	stop()
}
