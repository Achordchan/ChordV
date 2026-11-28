package config

import (
	"errors"
	"net"
	"net/netip"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
)

func (c Config) Production() bool { return c.Mode == "production" }
func (c Config) RuntimeMode() string {
	if c.Production() {
		return "production"
	}
	return "local"
}
func HTTPSOrigin(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || LoopbackHost(u.Hostname()) {
		return "", errors.New("生产地址必须是不含路径、凭据或参数的 HTTPS origin")
	}
	if port := u.Port(); port != "" {
		n, e := strconv.Atoi(port)
		if e != nil || n < 1 || n > 65535 {
			return "", errors.New("HTTPS 端口无效")
		}
	}
	return "https://" + u.Host, nil
}
func (c Config) validateProduction() error {
	host, port, err := net.SplitHostPort(c.Address)
	if err != nil || host == "" {
		return errors.New("CHORDV_LISTEN 必须显式指定监听 IP 和端口")
	}
	if _, err = netip.ParseAddr(host); err != nil {
		return errors.New("CHORDV_LISTEN 必须使用 IP 地址")
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return errors.New("监听端口无效")
	}
	if err = ValidateProductionDatabaseURL(c.DatabaseURL); err != nil {
		return err
	}
	if len(c.JWTSecret) < 48 || len(c.AgentPepper) < 48 || c.JWTSecret == c.AgentPepper || len(uniqueBytes(c.JWTSecret)) < 12 || len(uniqueBytes(c.AgentPepper)) < 12 {
		return errors.New("生产 JWT secret 与 Agent pepper 必须各为至少48字节的独立随机密钥")
	}
	if !filepath.IsAbs(c.DataDir) {
		return errors.New("CHORDV_DATA_DIR 必须显式设置绝对路径")
	}
	origin, err := HTTPSOrigin(c.PublicOrigin)
	if err != nil {
		return err
	}
	found := false
	for _, raw := range c.AllowedOrigins {
		v, e := HTTPSOrigin(raw)
		if e != nil {
			return e
		}
		found = found || v == origin
	}
	if !found {
		return errors.New("CHORDV_ALLOWED_ORIGINS 必须包含 CHORDV_PUBLIC_ORIGIN")
	}
	if len(c.TrustedProxies) == 0 {
		return errors.New("必须显式配置 CHORDV_TRUSTED_PROXIES，未使用代理请设置 none")
	}
	for _, raw := range c.TrustedProxies {
		raw = strings.TrimSpace(raw)
		if raw == "none" && len(c.TrustedProxies) == 1 {
			continue
		}
		prefix, e := netip.ParsePrefix(raw)
		if e != nil || prefix.Bits() == 0 {
			return errors.New("受信代理必须是明确 CIDR，禁止信任整个互联网")
		}
	}
	for _, raw := range c.OutboundOrigins {
		if _, e := HTTPSOrigin(raw); e != nil {
			return e
		}
	}

	return nil
}
func uniqueBytes(s string) map[byte]bool {
	m := map[byte]bool{}
	for i := range s {
		m[s[i]] = true
	}
	return m
}
func ValidateProductionDatabaseURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") || u.Hostname() == "" || u.Path == "" || u.Path == "/" || u.User == nil || u.User.Username() == "" || u.Fragment != "" {
		return errors.New("必须显式配置 CHORDV_DATABASE_URL")
	}
	for key := range u.Query() {
		if key != "sslmode" && key != "sslrootcert" && key != "connect_timeout" {
			return errors.New("生产数据库 URL 包含未授权连接参数")
		}
	}
	mode := u.Query().Get("sslmode")
	if !LoopbackHost(u.Hostname()) && mode != "verify-full" {
		return errors.New("远程生产数据库必须使用 sslmode=verify-full")
	}
	if LoopbackHost(u.Hostname()) && mode != "disable" && mode != "require" && mode != "verify-full" {
		return errors.New("本机生产数据库也必须显式指定 sslmode")
	}
	return nil
}
