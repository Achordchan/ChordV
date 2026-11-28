package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

func (s *DesktopService) testRoutingRule(_ context.Context, raw json.RawMessage) (any, error) {
	var input struct {
		Value              string          `json:"value"`
		Mode               string          `json:"mode"`
		Features           runtimeFeatures `json:"features"`
		CustomRoutingRules []routingRule   `json:"customRoutingRules"`
	}
	if err := decode(raw, &input); err != nil {
		return nil, err
	}
	started := time.Now()
	value := strings.TrimLeft(strings.ToLower(strings.TrimSpace(input.Value)), ".")
	if value == "" || len(value) > 128 || strings.ContainsAny(value, " /?:#\\\n\r\t") {
		return nil, errors.New("只支持域名或名称，不要包含协议、路径或空格")
	}
	for _, char := range value {
		if !(char >= 'a' && char <= 'z') && !(char >= '0' && char <= '9') && char != '-' && char != '.' {
			return nil, errors.New("请输入有效域名或名称")
		}
	}
	matchType, host := "domain", value
	if !strings.Contains(value, ".") {
		if len(value) > 64 {
			return nil, errors.New("名称过长")
		}
		matchType = "keyword"
		host = value + ".com"
	} else {
		for _, label := range strings.Split(value, ".") {
			if label == "" || len(label) > 63 || strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
				return nil, errors.New("请输入有效域名")
			}
		}
	}
	result := func(action string, rule any, message string) any {
		return map[string]any{"input": strings.TrimSpace(input.Value), "normalizedValue": value, "matchType": matchType, "action": action, "matchedRule": rule, "message": message, "reconnectRequired": false, "testHost": host, "elapsedMs": max(1, time.Since(started).Milliseconds())}
	}
	if input.Mode == "global" {
		return result("proxy", nil, "当前是全局代理模式，所有流量走代理。"), nil
	}
	if input.Mode == "direct" {
		return result("direct", nil, "当前是直连模式，所有流量直连。"), nil
	}
	for _, rule := range input.CustomRoutingRules {
		if !rule.Enabled || (rule.Action != "proxy" && rule.Action != "direct") {
			continue
		}
		target := strings.ToLower(strings.TrimSpace(rule.Value))
		if target == "" {
			continue
		}
		matched := rule.MatchType == "domain" && (host == target || strings.HasSuffix(host, "."+target)) || rule.MatchType == "keyword" && (strings.Contains(host, target) || strings.Contains(value, target))
		if matched {
			return result(rule.Action, rule, "命中自定义规则，覆盖内置 GEO 规则。"), nil
		}
	}
	geo, err := queryGeosite(filepath.Join(s.binDir(), "geosite.dat"), host)
	if err != nil {
		return nil, err
	}
	if input.Features.BlockAds && geo["CATEGORY-ADS-ALL"] {
		return result("direct", nil, "命中广告拦截规则；该目标会被阻断。"), nil
	}
	if input.Features.ChinaDirect && geo["CN"] {
		return result("direct", nil, "命中国内直连规则。"), nil
	}
	for _, domain := range aiServiceDomains {
		if host == domain || strings.HasSuffix(host, "."+domain) {
			action := "direct"
			if input.Features.AIServicesProxy {
				action = "proxy"
			}
			return result(action, nil, "命中 AI 服务规则。"), nil
		}
	}
	return result("proxy", nil, "按内置海外代理规则或默认代理规则连接。"), nil
}

type protoField struct {
	number  uint64
	wire    uint64
	integer uint64
	data    []byte
}

func nextProto(data []byte) (protoField, []byte, error) {
	key, n := binary.Uvarint(data)
	if n <= 0 {
		return protoField{}, nil, errors.New("GEO 数据格式无效")
	}
	data = data[n:]
	field := protoField{number: key >> 3, wire: key & 7}
	switch field.wire {
	case 0:
		value, n := binary.Uvarint(data)
		if n <= 0 {
			return field, nil, errors.New("GEO 数据格式无效")
		}
		field.integer = value
		data = data[n:]
	case 1:
		if len(data) < 8 {
			return field, nil, errors.New("GEO 数据被截断")
		}
		data = data[8:]
	case 2:
		size, n := binary.Uvarint(data)
		if n <= 0 || size > uint64(len(data)-max(n, 0)) {
			return field, nil, errors.New("GEO 数据被截断")
		}
		data = data[n:]
		field.data = data[:int(size)]
		data = data[int(size):]
	case 5:
		if len(data) < 4 {
			return field, nil, errors.New("GEO 数据被截断")
		}
		data = data[4:]
	default:
		return field, nil, errors.New("GEO 数据包含无效字段")
	}
	return field, data, nil
}
func queryGeosite(path, host string) (map[string]bool, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, errors.New("读取 geosite.dat 失败，请先更新规则组件")
	}
	if len(data) > 128<<20 {
		return nil, errors.New("GEO 文件过大")
	}
	wanted := map[string]bool{"CN": false, "CATEGORY-ADS-ALL": false, "GEOLOCATION-!CN": false}
	for len(data) > 0 {
		field, rest, err := nextProto(data)
		if err != nil {
			return nil, err
		}
		data = rest
		if field.number != 1 || field.wire != 2 {
			continue
		}
		entry := field.data
		var country string
		domains := [][]byte{}
		for len(entry) > 0 {
			f, remaining, err := nextProto(entry)
			if err != nil {
				return nil, err
			}
			entry = remaining
			if f.number == 1 && f.wire == 2 {
				country = strings.ToUpper(string(f.data))
			}
			if f.number == 2 && f.wire == 2 {
				domains = append(domains, f.data)
			}
		}
		if _, ok := wanted[country]; !ok || wanted[country] {
			continue
		}
		for _, domain := range domains {
			matched, err := geositeDomainMatches(domain, host)
			if err != nil {
				return nil, err
			}
			if matched {
				wanted[country] = true
				break
			}
		}
	}
	return wanted, nil
}
func geositeDomainMatches(data []byte, host string) (bool, error) {
	var kind uint64
	var value string
	for len(data) > 0 {
		f, rest, err := nextProto(data)
		if err != nil {
			return false, err
		}
		data = rest
		if f.number == 1 && f.wire == 0 {
			kind = f.integer
		}
		if f.number == 2 && f.wire == 2 {
			value = strings.ToLower(string(f.data))
		}
	}
	if value == "" {
		return false, nil
	}
	switch kind {
	case 0:
		return strings.Contains(host, value), nil
	case 1:
		pattern, err := regexp.Compile(value)
		if err != nil {
			return false, nil
		}
		return pattern.MatchString(host), nil
	case 2:
		return host == value || strings.HasSuffix(host, "."+value), nil
	case 3:
		return host == value, nil
	}
	return false, nil
}
