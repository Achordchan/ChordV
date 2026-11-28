package api

import (
	"encoding/base64"
	"math"
	"net/netip"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

var tagPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)
var panelVersionPattern = regexp.MustCompile(`^([0-9]+)\.([0-9]+)\.([0-9]+)$`)
var panelHostPattern = regexp.MustCompile(`^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$`)
var panelShortIDPattern = regexp.MustCompile(`^(?:[0-9a-f]{2}){0,8}$`)

func panelWhitespace(r rune) bool {
	return unicode.Is(unicode.Zs, r) || strings.ContainsRune("\t\n\v\f\r\u2028\u2029\ufeff", r)
}

func panelTrim(value string) string { return strings.TrimFunc(value, panelWhitespace) }

func panelString(input Object, field, fallback string) (string, error) {
	if input[field] == nil {
		return fallback, nil
	}
	value, valid := input[field].(string)
	if !valid {
		return "", fail(400, "入站参数 "+field+" 必须是字符串")
	}
	return panelTrim(value), nil
}

func panelHost(value string) string {
	return strings.TrimSuffix(strings.TrimPrefix(panelTrim(value), "["), "]")
}

// This is the former panel helper's pure SNI/IP predicate. The separate
// serverHost local/production outbound policy remains nodeHostAllowed.
func panelPublicSNI(value string) bool {
	if ip, err := netip.ParseAddr(value); err == nil {
		if ip.Is4() || ip.Is4In6() {
			v := ip.Unmap().As4()
			return v[0] != 0 && v[0] != 10 && v[0] != 127 && v[0] < 224 && !(v[0] == 172 && v[1] >= 16 && v[1] <= 31) && !(v[0] == 192 && v[1] == 168) && !(v[0] == 169 && v[1] == 254) && !(v[0] == 100 && v[1] >= 64 && v[1] <= 127)
		}
		v := ip.As16()
		return !ip.IsUnspecified() && !ip.IsLoopback() && v[0]&0xfe != 0xfc && !(v[0] == 0xfe && v[1]&0xc0 == 0x80) && v[0] != 0xff
	}
	return len(value) <= 253 && panelHostPattern.MatchString(value)
}

func normalizeInbound(input Object, production ...bool) (Object, error) {
	if input["mode"] != "validate_panel" {
		return nil, fail(400, "必须显式选择面板入站校验模式")
	}
	if input["rotateKeys"] == true {
		return nil, fail(400, "面板入站校验不会轮换密钥")
	}
	port := number(input, "listenPort")
	if math.IsNaN(port) || math.IsInf(port, 0) || port < 1 || port > 65535 || math.Trunc(port) != port {
		return nil, fail(400, "入站端口必须是 1-65535")
	}
	derived := "inbound-" + strconv.Itoa(int(port))
	tag, err := panelString(input, "inboundTag", derived)
	if err != nil {
		return nil, err
	}
	if !tagPattern.MatchString(tag) || tag != derived && input["tagOverrideConfirmed"] != true {
		return nil, fail(400, "入站tag无效或自定义tag尚未确认")
	}
	version, err := panelString(input, "panelVersion", "")
	if err != nil {
		return nil, err
	}
	version = strings.TrimPrefix(version, "v")
	parts := panelVersionPattern.FindStringSubmatch(version)
	if version != "auto" && (parts == nil || strings.TrimLeft(parts[1], "0") != "3" || strings.TrimLeft(parts[2], "0") == "") {
		return nil, fail(400, "面板版本必须为 3.1.0 或以上的 3.x 稳定版")
	}
	publicKey, err := panelString(input, "realityPublicKey", "")
	if err != nil {
		return nil, err
	}
	key, err := base64.RawURLEncoding.DecodeString(publicKey)
	if err != nil || len(key) != 32 || base64.RawURLEncoding.EncodeToString(key) != publicKey {
		return nil, fail(400, "Reality 公钥必须是规范的 32 字节 base64url")
	}
	shortID, err := panelString(input, "shortId", "")
	if err != nil {
		return nil, err
	}
	if !panelShortIDPattern.MatchString(shortID) {
		return nil, fail(400, "shortId 必须是 0-8 字节十六进制")
	}
	names, valid := input["serverNames"].([]any)
	if !valid || len(names) != 1 {
		return nil, fail(400, "面板导入必须指定一个客户端 SNI")
	}
	name, valid := names[0].(string)
	if !valid || !panelPublicSNI(panelHost(name)) {
		return nil, fail(400, "SNI不是合法公网地址或域名")
	}
	flow, err := panelString(input, "flow", "")
	if err != nil {
		return nil, err
	}
	if flow != "" && flow != "xtls-rprx-vision" {
		return nil, fail(400, "不支持的 flow")
	}
	fingerprint, err := panelString(input, "fingerprint", "chrome")
	if err != nil {
		return nil, err
	}
	supported := map[string]bool{"chrome": true, "firefox": true, "safari": true, "ios": true, "android": true, "edge": true, "360": true, "qq": true, "random": true, "randomized": true}
	if !supported[fingerprint] {
		return nil, fail(400, "不支持的 fingerprint")
	}
	spider, err := panelString(input, "spiderX", "/")
	if err != nil {
		return nil, err
	}
	units := 0
	for _, r := range spider {
		if panelWhitespace(r) || strings.ContainsRune("\"'\\", r) {
			return nil, fail(400, "spiderX 格式错误")
		}
		units++
		if r > 0xffff {
			units++
		}
	}
	if !strings.HasPrefix(spider, "/") || units > 64 {
		return nil, fail(400, "spiderX 格式错误")
	}
	host, err := panelString(input, "serverHost", "")
	if err != nil {
		return nil, err
	}
	host = panelHost(host)
	if !nodeHostAllowed(host, len(production) > 0 && production[0]) {
		return nil, fail(403, "节点地址不符合当前本地或生产网络策略")
	}
	return Object{"mode": "validate_panel", "listenPort": int(port), "inboundTag": tag, "serverHost": host, "realityPublicKey": publicKey, "shortId": shortID, "serverNames": []string{panelHost(name)}, "flow": flow, "fingerprint": fingerprint, "spiderX": spider, "panelVersion": version, "tagOverrideConfirmed": input["tagOverrideConfirmed"] == true}, nil
}
