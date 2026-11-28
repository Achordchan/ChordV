package api

import (
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
)

func validatePanelLinkInput(input Object) (Object, error) {
	input = pick(input, "link", "panelVersion", "inboundTag", "tagOverrideConfirmed")
	for _, field := range []string{"link", "panelVersion", "inboundTag"} {
		if field == "inboundTag" && input[field] == nil {
			continue
		}
		value, valid := input[field].(string)
		limit := 32
		if field == "link" {
			limit = 4096
		}
		length, previousNonSelector := 0, false
		for _, r := range value {
			selector := r == '\ufe0e' || r == '\ufe0f'
			length++
			if selector && previousNonSelector {
				length--
			}
			previousNonSelector = !selector
		}
		if !valid || length > limit {
			return nil, fail(400, field+" 类型或长度无效")
		}
	}
	if raw := input["tagOverrideConfirmed"]; raw != nil {
		if _, valid := raw.(bool); !valid {
			return nil, fail(400, "tagOverrideConfirmed 必须是JSON布尔值")
		}
	}
	return input, nil
}

// URLSearchParams preserves malformed escapes and treats semicolons as data.
// url.Values silently drops those pairs, which can hide unknown parameters.
func panelQueryDecode(value string) string {
	var bytes []byte
	for index := 0; index < len(value); index++ {
		switch value[index] {
		case '+':
			bytes = append(bytes, ' ')
		case '%':
			if index+2 < len(value) && strings.ContainsRune("0123456789abcdefABCDEF", rune(value[index+1])) && strings.ContainsRune("0123456789abcdefABCDEF", rune(value[index+2])) {
				if decoded, err := strconv.ParseUint(value[index+1:index+3], 16, 8); err == nil {
					bytes = append(bytes, byte(decoded))
					index += 2
					continue
				}
			}
			bytes = append(bytes, '%')
		default:
			bytes = append(bytes, value[index])
		}
	}
	return string([]rune(string(bytes)))
}

func panelRootURLPath(path string) bool {
	if path == "" {
		return true
	}
	if !strings.HasPrefix(path, "/") {
		return false
	}
	parts, stack := strings.Split(path[1:], "/"), []string{}
	for index, part := range parts {
		dots := strings.ReplaceAll(strings.ToLower(part), "%2e", ".")
		switch dots {
		case ".":
			if index == len(parts)-1 {
				stack = append(stack, "")
			}
		case "..":
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
			if index == len(parts)-1 {
				stack = append(stack, "")
			}
		default:
			stack = append(stack, part)
		}
	}
	return len(stack) == 1 && stack[0] == ""
}

func parsePanelLink(input Object, production bool) (Object, error) {
	link := panelTrim(input["link"].(string))
	link = strings.TrimFunc(link, func(r rune) bool { return r <= 0x20 })
	link = strings.NewReplacer("\t", "", "\n", "", "\r", "").Replace(link)
	link, _, _ = strings.Cut(link, "#")
	u, err := url.Parse(link)
	if err != nil || strings.ToLower(u.Scheme) != "vless" || u.User == nil || u.User.Username() == "" {
		return nil, fail(400, "请输入有效 VLESS 链接")
	}
	if password, _ := u.User.Password(); password != "" {
		return nil, fail(400, "分享链接不接受密码")
	}
	host := u.Hostname()
	if strings.HasPrefix(u.Host, "[") {
		ip, parseErr := netip.ParseAddr(host)
		if parseErr != nil || !ip.Is6() || ip.Zone() != "" {
			return nil, fail(400, "分享链接IPv6地址无效")
		}
		host = ip.String()
		if ip.Is4In6() {
			bytes := ip.As16()
			host = "::ffff:" + strconv.FormatUint(uint64(bytes[12])<<8|uint64(bytes[13]), 16) + ":" + strconv.FormatUint(uint64(bytes[14])<<8|uint64(bytes[15]), 16)
		}
	} else if strings.Contains(host, ":") {
		return nil, fail(400, "分享链接IPv6地址必须使用方括号")
	}
	if !panelRootURLPath(u.EscapedPath()) {
		return nil, fail(400, "分享链接不应携带路径")
	}
	allowed := map[string]bool{"security": true, "type": true, "encryption": true, "pbk": true, "sid": true, "sni": true, "flow": true, "fp": true, "spx": true}
	query := map[string]string{}
	for _, pair := range strings.Split(u.RawQuery, "&") {
		if pair == "" {
			continue
		}
		name, raw, _ := strings.Cut(pair, "=")
		name = panelQueryDecode(name)
		if _, duplicate := query[name]; duplicate || !allowed[name] {
			return nil, fail(400, "分享链接包含不支持或重复参数")
		}
		query[name] = panelQueryDecode(raw)
	}
	kind, specified := query["type"]
	if query["security"] != "reality" || specified && kind != "tcp" && kind != "raw" {
		return nil, fail(400, "只支持 TCP/RAW Reality 入站")
	}
	if encryption, specified := query["encryption"]; specified && encryption != "none" {
		return nil, fail(400, "不支持额外 VLESS encryption")
	}
	port, _ := strconv.Atoi(u.Port())
	spec := Object{"mode": "validate_panel", "serverHost": host, "listenPort": port, "realityPublicKey": query["pbk"], "shortId": query["sid"], "serverNames": []any{query["sni"]}, "flow": query["flow"], "panelVersion": input["panelVersion"], "tagOverrideConfirmed": input["tagOverrideConfirmed"]}
	for field, key := range map[string]string{"fingerprint": "fp", "spiderX": "spx"} {
		if value, specified := query[key]; specified {
			spec[field] = value
		}
	}
	if override, _ := input["inboundTag"].(string); override != "" {
		spec["inboundTag"] = override
	}
	return normalizeInbound(spec, production)
}

func (s *Server) parseInbound(w http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	input, err = validatePanelLinkInput(input)
	if err != nil {
		return nil, err
	}
	return parsePanelLink(input, s.Config.Production())
}
