package config

import "testing"

func TestDatabaseIsolation(t *testing.T) {
	good := []string{"postgres://u:p@127.0.0.1:55437/chordv_mygo_local?sslmode=disable", "postgresql://u:p@localhost/chordv_mygo_local", "postgres://u:p@[::1]/chordv_mygo_local"}
	for _, value := range good {
		if err := ValidateDatabaseURL(value); err != nil {
			t.Errorf("本地数据库被拒绝: %v", err)
		}
	}
	bad := []string{"", "postgres://u:p@db.example.com/chordv_mygo_local", "postgres://u:p@127.0.0.1/chordv", "postgres://u:p@127.0.0.1/chordv_mygo_local?host=remote", "postgres://u:p@127.0.0.1/chordv_mygo_local?service=production", "postgres://u:p@127.0.0.1/chordv_mygo_local?options=-csearch_path=public"}
	for _, value := range bad {
		if ValidateDatabaseURL(value) == nil {
			t.Error("非隔离数据库参数未被拒绝")
		}
	}
}
func TestNoImplicitProductionRepository(t *testing.T) {
	t.Setenv("CHORDV_LOCAL_DATABASE_URL", "postgres://u:p@127.0.0.1/chordv_mygo_local")
	t.Setenv("CHORDV_LOCAL_JWT_SECRET", "12345678901234567890123456789012")
	t.Setenv("CHORDV_LOCAL_AGENT_PEPPER", "12345678901234567890123456789012")
	t.Setenv("CHORDV_GITHUB_REPOSITORY", "")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.GitHubRepository != "" {
		t.Fatal("不应默认连接线上发布仓库")
	}
}
func TestListenIsolation(t *testing.T) {
	cfg := Config{Address: "0.0.0.0:3100", DatabaseURL: "postgres://u:p@127.0.0.1/chordv_mygo_local", JWTSecret: "12345678901234567890123456789012", AgentPepper: "12345678901234567890123456789012"}
	if cfg.Validate() == nil {
		t.Fatal("禁止监听所有网络接口")
	}
}

func TestReleaseRepositoryConfiguration(t *testing.T) {
	local := productionConfig()
	local.Mode, local.DatabaseURL, local.AllowedOrigins = "local", "postgres://chordv_local@127.0.0.1/chordv_mygo_local", nil
	for _, cfg := range []Config{local, productionConfig()} {
		for value, valid := range map[string]bool{"": true, "Team-1/.releases": true, "Team-1/Client": true, "bad_owner/releases": false, "owner/..": false} {
			cfg.GitHubRepository = value
			if err := cfg.Validate(); (err == nil) != valid {
				t.Errorf("%s repository %q: %v", cfg.Mode, value, err)
			}
		}
	}
}
