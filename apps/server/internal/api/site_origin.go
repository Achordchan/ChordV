package api

import (
	"fmt"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/Achordchan/ChordV/apps/server/internal/config"
	"golang.org/x/net/idna"
)

var siteIDNA = idna.New(idna.MapForLookup(), idna.StrictDomainName(false), idna.CheckHyphens(false), idna.Transitional(false), idna.VerifyDNSLength(false), idna.BidiRule())

func (s *Server) normalizeSiteAddress(value Object, enforceInputLimits bool) (Object, error) {
	primary, ok := value["primaryOrigin"].(string)
	if !ok || (enforceInputLimits && utf8.RuneCountInString(primary) > 2048) {
		return nil, fail(400, "主站点地址必须是不超过2048字符的字符串")
	}
	aliases, ok := value["legacyOrigins"].([]any)
	if !ok || len(aliases) > 10 {
		return nil, fail(400, "历史地址必须是最多10项的字符串数组")
	}
	origin, err := s.siteOrigin(primary)
	if err != nil {
		return nil, err
	}
	legacy := []string{}
	seen := map[string]bool{origin: true}
	for _, raw := range aliases {
		text, ok := raw.(string)
		if !ok || (enforceInputLimits && utf8.RuneCountInString(text) > 2048) {
			return nil, fail(400, "历史地址必须是不超过2048字符的字符串")
		}
		canonical, err := s.siteOrigin(text)
		if err != nil {
			return nil, err
		}
		if !seen[canonical] {
			legacy = append(legacy, canonical)
			seen[canonical] = true
		}
	}
	return Object{"primaryOrigin": origin, "legacyOrigins": legacy}, nil
}

func normalizeSiteOrigin(raw string, production bool) (string, error) {
	u, err := parseSiteURL(strings.TrimFunc(raw, siteSpace))
	if err != nil || u.Hostname() == "" || u.Opaque != "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return "", fail(400, "站点地址不得包含账号、路径、查询参数或片段")
	}
	host, err := canonicalSiteHost(u.Hostname())
	if err != nil {
		return "", err
	}
	if production {
		ip, ipErr := netip.ParseAddr(host)
		if u.Scheme != "https" || strings.TrimSuffix(host, ".") == "localhost" || (ipErr == nil && ip.Unmap().IsLoopback()) {
			return "", fail(400, "生产站点必须使用非回环HTTPS地址")
		}
	} else if u.Scheme != "http" || !config.LoopbackHost(host) {
		return "", fail(400, "本地调试仅允许回环HTTP站点地址")
	}
	port := ""
	if rawPort := u.Port(); rawPort != "" {
		number, err := strconv.ParseUint(rawPort, 10, 16)
		if err != nil || (production && number == 0) {
			return "", fail(400, "站点端口无效")
		}
		if !(u.Scheme == "https" && number == 443) && !(u.Scheme == "http" && number == 80) {
			port = ":" + strconv.FormatUint(number, 10)
		}
	}
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	return u.Scheme + "://" + host + port, nil
}

func canonicalSiteHost(host string) (string, error) {
	if ip, err := netip.ParseAddr(host); err == nil {
		if ip.Zone() != "" {
			return "", fail(400, "站点地址不能包含IPv6区域标识")
		}
		if ip.Is4In6() {
			bytes := ip.As16()
			return fmt.Sprintf("::ffff:%x:%x", uint16(bytes[12])<<8|uint16(bytes[13]), uint16(bytes[14])<<8|uint16(bytes[15])), nil
		}
		return ip.String(), nil
	}
	ascii, err := siteIDNA.ToASCII(host)
	if err != nil || ascii == "" {
		return "", fail(400, "站点域名无效")
	}
	ascii = strings.ToLower(ascii)
	if siteHostForbidden(ascii) {
		return "", fail(400, "站点域名无效")
	}
	return canonicalSiteIPv4(ascii)
}

// Browser numeric IPv4 forms must be canonicalized before loopback checks.
func canonicalSiteIPv4(host string) (string, error) {
	parts := strings.Split(host, ".")
	if parts[len(parts)-1] == "" && len(parts) > 1 {
		parts = parts[:len(parts)-1]
	}
	last := parts[len(parts)-1]
	numeric := siteDigits(last, 10)
	if strings.HasPrefix(last, "0x") {
		numeric = siteDigits(last[2:], 16) || len(last) == 2
	}
	if !numeric {
		return host, nil
	}
	if len(parts) > 4 {
		return "", fail(400, "站点IPv4地址无效")
	}
	numbers := []uint64{}
	for _, part := range parts {
		if part == "" {
			return "", fail(400, "站点IPv4地址无效")
		}
		base := 10
		if strings.HasPrefix(part, "0x") {
			base = 16
			part = part[2:]
		} else if len(part) > 1 && part[0] == '0' {
			base = 8
			part = part[1:]
		}
		if part == "" {
			part = "0"
		}
		if !siteDigits(part, base) {
			return "", fail(400, "站点IPv4地址无效")
		}
		n, err := strconv.ParseUint(part, base, 32)
		if err != nil {
			return "", fail(400, "站点IPv4地址无效")
		}
		numbers = append(numbers, n)
	}
	number := numbers[len(numbers)-1]
	if number >= uint64(1)<<uint(8*(5-len(numbers))) {
		return "", fail(400, "站点IPv4地址无效")
	}
	for i, n := range numbers[:len(numbers)-1] {
		if n > 255 {
			return "", fail(400, "站点IPv4地址无效")
		}
		number += n << uint(24-8*i)
	}
	ip := netip.AddrFrom4([4]byte{byte(number >> 24), byte(number >> 16), byte(number >> 8), byte(number)})
	return ip.String(), nil
}

func siteDigits(value string, base int) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		digit := -1
		if r >= '0' && r <= '9' {
			digit = int(r - '0')
		} else if r >= 'a' && r <= 'f' {
			digit = int(r-'a') + 10
		}
		if digit < 0 || digit >= base {
			return false
		}
	}
	return true
}

func siteSpace(r rune) bool {
	return (r >= '\t' && r <= '\r') || r == ' ' || r == '\u00a0' || r == '\u1680' || (r >= '\u2000' && r <= '\u200a') || r == '\u2028' || r == '\u2029' || r == '\u202f' || r == '\u205f' || r == '\u3000' || r == '\ufeff'
}

func parseSiteURL(raw string) (*url.URL, error) {
	// net/url rejects escapes in hosts before IDNA; browsers first percent-decode
	// DNS host bytes, without allowing an escaped delimiter to change URL structure.
	schemeEnd := strings.Index(raw, "://")
	if schemeEnd >= 0 {
		start := schemeEnd + 3
		end := len(raw)
		if tail := strings.IndexAny(raw[start:], "/?#"); tail >= 0 {
			end = start + tail
		}
		authority := raw[start:end]
		if strings.Contains(authority, "%") && !strings.HasPrefix(authority, "[") && !strings.Contains(authority, "@") {
			host, port, hasPort := strings.Cut(authority, ":")
			decoded, err := url.PathUnescape(host)
			if err != nil || siteHostForbidden(decoded) {
				return nil, fail(400, "站点域名无效")
			}
			authority = decoded
			if hasPort {
				authority += ":" + port
			}
			raw = raw[:start] + authority + raw[end:]
		}
	}
	return url.Parse(raw)
}

func siteHostForbidden(host string) bool {
	for _, r := range host {
		if r <= 0x20 || r == 0x7f || strings.ContainsRune("#%/:<>?@[\\]^|", r) {
			return true
		}
	}
	return false
}
