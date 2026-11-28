package main

import (
	"errors"
	"fmt"
	"net"
	"strings"
)

func validateRuntimeConfig(config runtimeConfig) error {
	if config.SessionID == "" || config.Outbound.UUID == "" || config.Outbound.Server == "" || config.Outbound.Port < 1 || config.Outbound.Port > 65535 {
		return errors.New("连接配置不完整")
	}
	if config.Mode != "rule" && config.Mode != "global" && config.Mode != "direct" {
		return errors.New("连接模式无效")
	}
	if config.LocalHTTPPort < 1024 || config.LocalHTTPPort > 65535 || config.LocalSocksPort < 1024 || config.LocalSocksPort > 65535 || config.LocalHTTPPort == config.LocalSocksPort {
		return errors.New("本地代理端口无效")
	}
	if config.LeaseHeartbeatIntervalSeconds < 5 || config.LeaseHeartbeatIntervalSeconds > 2147483 || config.LeaseGraceSeconds < 30 || config.LeaseGraceSeconds > 2147483 {
		return errors.New("租约心跳须为5至2147483秒，宽限须为30至2147483秒")
	}
	return nil
}

func buildXrayConfig(config runtimeConfig, logPath string) map[string]any {
	reality := map[string]any{"serverName": config.Outbound.ServerName, "fingerprint": config.Outbound.Fingerprint, "publicKey": config.Outbound.RealityPublicKey, "shortId": config.Outbound.ShortID, "spiderX": config.Outbound.SpiderX}
	if config.Outbound.MLDSA65Verify != "" {
		reality["mldsa65Verify"] = config.Outbound.MLDSA65Verify
	}
	inbounds := []any{}
	for _, entry := range []struct {
		tag, protocol string
		port          int
	}{{"http-in", "http", config.LocalHTTPPort}, {"socks-in", "socks", config.LocalSocksPort}} {
		settings := map[string]any{}
		if entry.protocol == "socks" {
			settings["auth"] = "noauth"
			settings["udp"] = true
		}
		inbounds = append(inbounds, map[string]any{"tag": entry.tag, "listen": "127.0.0.1", "port": entry.port, "protocol": entry.protocol, "sniffing": map[string]any{"enabled": true, "destOverride": []string{"http", "tls", "quic"}}, "settings": settings})
	}
	return map[string]any{
		"log":      map[string]any{"loglevel": "warning", "access": logPath, "error": logPath},
		"dns":      map[string]any{"disableCache": false, "queryStrategy": "UseIPv4", "servers": []any{map[string]any{"address": "223.5.5.5", "domains": []string{"geosite:cn"}, "expectIPs": []string{"geoip:cn"}}, map[string]any{"address": "1.1.1.1", "domains": []string{"geosite:geolocation-!cn"}}, "localhost"}},
		"inbounds": inbounds,
		"outbounds": []any{
			map[string]any{"tag": "proxy", "protocol": "vless", "settings": map[string]any{"vnext": []any{map[string]any{"address": config.Outbound.Server, "port": config.Outbound.Port, "users": []any{map[string]any{"id": config.Outbound.UUID, "encryption": "none", "flow": config.Outbound.Flow}}}}}, "streamSettings": map[string]any{"network": "tcp", "security": "reality", "realitySettings": reality}},
			map[string]any{"tag": "direct", "protocol": "freedom"}, map[string]any{"tag": "block", "protocol": "blackhole"},
		},
		"routing": map[string]any{"domainMatcher": "hybrid", "domainStrategy": "AsIs", "rules": routingRules(config)},
	}
}

var aiServiceDomains = []string{"openai.com", "chatgpt.com", "oaistatic.com", "oaiusercontent.com", "anthropic.com", "claude.ai", "perplexity.ai", "x.ai", "grok.com", "ai.google.dev", "gemini.google.com", "makersuite.google.com"}
var builtInProxyDomains = []string{"google.com", "youtube.com", "github.com", "telegram.org", "t.me", "twitter.com", "x.com", "discord.com", "discord.gg", "netflix.com"}

func routingRules(config runtimeConfig) []any {
	if config.Mode == "global" {
		return []any{map[string]any{"type": "field", "network": "tcp,udp", "outboundTag": "proxy"}}
	}
	if config.Mode == "direct" {
		return []any{map[string]any{"type": "field", "network": "tcp,udp", "outboundTag": "direct"}}
	}
	rules := []any{}
	for _, rule := range config.CustomRoutingRules {
		if !rule.Enabled || (rule.Action != "proxy" && rule.Action != "direct") || strings.TrimSpace(rule.Value) == "" || (rule.MatchType != "domain" && rule.MatchType != "keyword") {
			continue
		}
		rules = append(rules, map[string]any{"type": "field", "domain": []string{rule.MatchType + ":" + strings.TrimSpace(rule.Value)}, "outboundTag": rule.Action})
	}
	rules = append(rules, map[string]any{"type": "field", "ip": []string{"geoip:private"}, "outboundTag": "direct"})
	if config.Features.BlockAds {
		rules = append(rules, map[string]any{"type": "field", "domain": []string{"geosite:category-ads-all"}, "outboundTag": "block"})
	}
	if config.Features.ChinaDirect {
		rules = append(rules, map[string]any{"type": "field", "domain": []string{"geosite:cn"}, "outboundTag": "direct"}, map[string]any{"type": "field", "ip": []string{"geoip:cn"}, "outboundTag": "direct"})
	}
	domains := []string{}
	for _, domain := range aiServiceDomains {
		domains = append(domains, "domain:"+domain)
	}
	action := "direct"
	if config.Features.AIServicesProxy {
		action = "proxy"
	}
	rules = append(rules, map[string]any{"type": "field", "domain": domains, "outboundTag": action})
	domains = []string{}
	for _, domain := range builtInProxyDomains {
		domains = append(domains, "domain:"+domain)
	}
	domains = append(domains, "geosite:geolocation-!cn")
	return append(rules, map[string]any{"type": "field", "domain": domains, "outboundTag": "proxy"}, map[string]any{"type": "field", "network": "tcp,udp", "outboundTag": "proxy"})
}

func localPortAvailable(port int) error {
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return errors.New("本地代理端口已被占用，请先关闭其他代理")
	}
	return listener.Close()
}
