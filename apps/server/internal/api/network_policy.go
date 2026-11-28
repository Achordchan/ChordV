package api

import (
	"net"
	"net/http"
	"net/netip"
	"strings"

	"github.com/Achordchan/ChordV/apps/server/internal/config"
)

func (s *Server) integrationOrigin(raw string) (string, error) {
	if !s.Config.Production() {
		return localOrigin(raw)
	}
	origin, err := config.HTTPSOrigin(raw)
	if err != nil {
		return "", fail(400, err.Error())
	}
	for _, allowed := range s.Config.OutboundOrigins {
		canonical, e := config.HTTPSOrigin(allowed)
		if e == nil && canonical == origin {
			return origin, nil
		}
	}
	return "", fail(403, "服务地址未列入 CHORDV_OUTBOUND_ORIGINS")
}
func (s *Server) siteOrigin(raw string) (string, error) {
	return normalizeSiteOrigin(raw, s.Config.Production())
}
func (s *Server) defaultPublicOrigin() string {
	if s.Config.Production() {
		return strings.TrimSuffix(strings.TrimSpace(s.Config.PublicOrigin), "/")
	}
	return "http://" + s.Config.Address
}
func nodeHostAllowed(host string, production bool) bool {
	if !production {
		return config.LoopbackHost(host)
	}
	if ip, err := netip.ParseAddr(host); err == nil {
		return !ip.IsUnspecified() && !ip.IsMulticast()
	}
	if len(host) > 253 || !strings.Contains(host, ".") || strings.ContainsAny(host, " /\\:@?%#\r\n") {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if label == "" || len(label) > 63 || strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
			return false
		}
		for _, ch := range label {
			if !(ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' || ch == '-') {
				return false
			}
		}
	}
	return true
}
func (s *Server) requestIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip, err := netip.ParseAddr(host)
	if err != nil || !s.Config.Production() {
		return host
	}
	trusted := func(ip netip.Addr) bool {
		for _, raw := range s.Config.TrustedProxies {
			prefix, e := netip.ParsePrefix(strings.TrimSpace(raw))
			if e == nil && prefix.Contains(ip.Unmap()) {
				return true
			}
		}
		return false
	}
	if !trusted(ip) {
		return host
	}
	chain := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
	if len(chain) > 32 {
		return host
	}
	for i := len(chain) - 1; i >= 0; i-- {
		next, e := netip.ParseAddr(strings.TrimSpace(chain[i]))
		if e != nil {
			return host
		}
		ip = next
		if !trusted(ip) {
			return ip.String()
		}
	}
	return ip.String()
}
