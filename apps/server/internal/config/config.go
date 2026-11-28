package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	releaseprotocol "github.com/Achordchan/ChordV/packages/releaseprotocol"
)

type Config struct {
	Mode                            string
	PublicOrigin                    string
	TrustedProxies                  []string
	OutboundOrigins                 []string
	Address                         string
	DatabaseURL                     string
	JWTSecret                       string
	JWTIssuer                       string
	AgentPepper                     string
	DataDir                         string
	GitHubRepository                string
	GitHubPublicKey                 string
	AllowedOrigins                  []string
	UsagePayloadRetentionDays       int
	MeteringIncidentRetentionDays   int
	SessionLeaseTTLSeconds          int
	SessionHeartbeatIntervalSeconds int
	SessionGraceSeconds             int
}

func (c Config) AccessTokenIssuer() string {
	if c.JWTIssuer == "" {
		return "chordv-api"
	}
	return c.JWTIssuer
}

func Load() (Config, error) {
	cfg := Config{
		Mode:             env("CHORDV_MODE", "local"),
		Address:          env("CHORDV_LOCAL_LISTEN", "127.0.0.1:3100"),
		DatabaseURL:      os.Getenv("CHORDV_LOCAL_DATABASE_URL"),
		JWTSecret:        os.Getenv("CHORDV_LOCAL_JWT_SECRET"),
		JWTIssuer:        env("CHORDV_LOCAL_JWT_ISSUER", ""),
		AgentPepper:      os.Getenv("CHORDV_LOCAL_AGENT_PEPPER"),
		DataDir:          env("CHORDV_LOCAL_DATA_DIR", ".data/mygo-server"),
		GitHubRepository: env("CHORDV_GITHUB_REPOSITORY", ""),
		GitHubPublicKey:  os.Getenv("CHORDV_GITHUB_RELEASE_PUBLIC_KEY"),
		AllowedOrigins:   strings.Split(env("CHORDV_LOCAL_ORIGINS", "http://127.0.0.1:5174,http://localhost:5174,http://127.0.0.1:5173,http://localhost:5173"), ","),
	}
	if cfg.Mode == "production" {
		cfg.Address = os.Getenv("CHORDV_LISTEN")
		cfg.DatabaseURL = os.Getenv("CHORDV_DATABASE_URL")
		cfg.JWTSecret = os.Getenv("CHORDV_JWT_SECRET")
		cfg.JWTIssuer = env("CHORDV_JWT_ISSUER", "")
		cfg.AgentPepper = os.Getenv("CHORDV_AGENT_PEPPER")
		cfg.DataDir = os.Getenv("CHORDV_DATA_DIR")
		cfg.PublicOrigin = os.Getenv("CHORDV_PUBLIC_ORIGIN")
		cfg.AllowedOrigins = strings.Split(os.Getenv("CHORDV_ALLOWED_ORIGINS"), ",")
		cfg.TrustedProxies = strings.Split(os.Getenv("CHORDV_TRUSTED_PROXIES"), ",")
		cfg.OutboundOrigins = nil
		if raw := strings.TrimSpace(os.Getenv("CHORDV_OUTBOUND_ORIGINS")); raw != "" {
			cfg.OutboundOrigins = strings.Split(raw, ",")
		}
	}
	if err := cfg.loadMeteringRetention(); err != nil {
		return cfg, err
	}
	if err := cfg.loadSessionLeaseTiming(); err != nil {
		return cfg, err
	}
	if err := cfg.Validate(); err != nil {
		return cfg, err
	}
	var err error
	cfg.DataDir, err = filepath.Abs(cfg.DataDir)
	return cfg, err
}

func (c Config) Validate() error {
	if _, err := c.SessionLeaseTiming(); err != nil {
		return err
	}
	if _, _, err := c.MeteringRetentionDurations(); err != nil {
		return err
	}
	if c.GitHubRepository != "" {
		if _, err := releaseprotocol.CanonicalRepository(c.GitHubRepository); err != nil {
			return err
		}
	}
	if c.Mode == "production" {
		return c.validateProduction()
	}
	if c.Mode != "" && c.Mode != "local" {
		return errors.New("CHORDV_MODE 必须是 local 或 production")
	}
	host, _, err := net.SplitHostPort(c.Address)
	if err != nil || !LoopbackHost(host) {
		return errors.New("本地服务只能监听回环地址")
	}
	if err := ValidateDatabaseURL(c.DatabaseURL); err != nil {
		return err
	}
	if len(c.JWTSecret) < 32 || len(c.AgentPepper) < 32 {
		return errors.New("CHORDV_LOCAL_JWT_SECRET 和 CHORDV_LOCAL_AGENT_PEPPER 均需至少 32 字符")
	}

	for _, origin := range c.AllowedOrigins {
		u, err := url.Parse(strings.TrimSpace(origin))
		if err != nil || u.Scheme != "http" || !LoopbackHost(u.Hostname()) || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
			return errors.New("本地 CORS 来源只能是回环 HTTP origin")
		}
	}
	return nil
}

func ValidateDatabaseURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") || !LoopbackHost(u.Hostname()) || u.Path != "/chordv_mygo_local" {
		return errors.New("必须显式设置 CHORDV_LOCAL_DATABASE_URL，且只能连接本机 chordv_mygo_local 数据库")
	}
	for key := range u.Query() {
		if key != "sslmode" {
			return fmt.Errorf("本地数据库连接不接受参数 %s", key)
		}
	}
	if mode := u.Query().Get("sslmode"); mode != "" && mode != "disable" && mode != "require" {
		return errors.New("不支持的 sslmode")
	}
	return nil
}

func LoopbackHost(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}
func env(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}
