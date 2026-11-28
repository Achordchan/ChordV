package config

import (
	"strings"
	"testing"
)

func productionConfig() Config {
	return Config{Mode: "production", Address: "127.0.0.1:3100", DatabaseURL: "postgres://app:secret@db.example.test/chordv?sslmode=verify-full", JWTSecret: "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0iL3oR6uX9bD2eG5hJ8", AgentPepper: "9z8Y7x6W5v4U3t2S1r0QpOnMlKjIhGfEdCbA9876543210abcdef", DataDir: "/var/lib/chordv", PublicOrigin: "https://api.example.test", AllowedOrigins: []string{"https://api.example.test", "https://admin.example.test"}, TrustedProxies: []string{"127.0.0.1/32", "::1/128"}, OutboundOrigins: []string{"https://support.example.test"}}
}
func TestProductionConfigRequiresExplicitSecureSettings(t *testing.T) {
	cfg := productionConfig()
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	cases := map[string]func(*Config){
		"mode":               func(c *Config) { c.Mode = "prod" },
		"database transport": func(c *Config) { c.DatabaseURL = "postgres://u:p@db.example.test/chordv?sslmode=require" },
		"database override":  func(c *Config) { c.DatabaseURL += "&host=other.example.test" },
		"jwt":                func(c *Config) { c.JWTSecret = strings.Repeat("a", 64) },
		"shared keys":        func(c *Config) { c.AgentPepper = c.JWTSecret },
		"data":               func(c *Config) { c.DataDir = "relative" },
		"public http":        func(c *Config) { c.PublicOrigin = "http://api.example.test" },
		"origin mismatch":    func(c *Config) { c.AllowedOrigins = []string{"https://elsewhere.example.test"} },
		"wildcard origin":    func(c *Config) { c.AllowedOrigins = []string{"*"} },
		"all proxies":        func(c *Config) { c.TrustedProxies = []string{"0.0.0.0/0"} },
		"implicit proxies":   func(c *Config) { c.TrustedProxies = nil },
		"outbound insecure":  func(c *Config) { c.OutboundOrigins = []string{"http://support.example.test"} },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			bad := productionConfig()
			change(&bad)
			if bad.Validate() == nil {
				t.Fatal("缺失或不明确的生产配置被接受")
			}
		})
	}
	cfg.TrustedProxies = []string{"none"}
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
}
func TestProductionLoadNeverFallsBackToLocalOrLegacySecrets(t *testing.T) {
	t.Setenv("CHORDV_MODE", "production")
	t.Setenv("DATABASE_URL", "postgres://u:p@localhost/legacy")
	t.Setenv("CHORDV_DATABASE_URL", "")
	t.Setenv("CHORDV_LOCAL_DATABASE_URL", "postgres://u:p@localhost/chordv_mygo_local")
	if _, err := Load(); err == nil {
		t.Fatal("生产模式不应读取本地或旧数据库配置")
	}
}

func TestProductionLoadsOnlyProductionTokenIssuer(t *testing.T) {
	c := productionConfig()
	for k, v := range map[string]string{"CHORDV_MODE": "production", "CHORDV_LISTEN": c.Address, "CHORDV_PUBLIC_ORIGIN": c.PublicOrigin, "CHORDV_DATA_DIR": c.DataDir, "CHORDV_DATABASE_URL": c.DatabaseURL, "CHORDV_TRUSTED_PROXIES": "none", "CHORDV_ALLOWED_ORIGINS": c.PublicOrigin, "CHORDV_JWT_SECRET": c.JWTSecret, "CHORDV_AGENT_PEPPER": c.AgentPepper, "CHORDV_LOCAL_JWT_ISSUER": "local-only"} {
		t.Setenv(k, v)
	}
	for raw, want := range map[string]string{"  ": "chordv-api", " Custom-API ": "Custom-API"} {
		t.Setenv("CHORDV_JWT_ISSUER", raw)
		cfg, err := Load()
		if err != nil || cfg.AccessTokenIssuer() != want {
			t.Fatalf("issuer=%q want=%q err=%v", cfg.AccessTokenIssuer(), want, err)
		}
	}
}
