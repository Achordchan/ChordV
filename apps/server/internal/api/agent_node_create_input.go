package api

import (
	"strings"
	"unicode"
)

// The former DTO used validator.js isLength: presentation selectors following
// a non-selector do not add a character. The service then checked UTF-16 name length.
func agentNodeCreateLength(value string) int {
	length, previousNonSelector := 0, false
	for _, r := range value {
		selector := r == '\ufe0e' || r == '\ufe0f'
		length++
		if selector && previousNonSelector {
			length--
		}
		previousNonSelector = !selector
	}
	return length
}

func agentNodeCreateTrim(value string) string {
	return strings.TrimFunc(value, func(r rune) bool {
		return unicode.Is(unicode.Zs, r) || strings.ContainsRune("\t\n\v\f\r\u2028\u2029\ufeff", r)
	})
}

func normalizeAgentNodeCreateInput(input Object) (Object, error) {
	name, ok := input["name"].(string)
	if !ok || agentNodeCreateLength(name) > 120 {
		return nil, fail(400, "节点名称必须是最多120字符的字符串")
	}
	for _, field := range []string{"countryCode", "region", "provider"} {
		if raw := input[field]; raw != nil {
			value, valid := raw.(string)
			limit := 120
			if field == "countryCode" {
				limit = 64
			}
			if !valid || agentNodeCreateLength(value) > limit {
				return nil, fail(400, field+" 类型或长度无效")
			}
		}
	}
	for _, field := range []string{"isActive", "recommended"} {
		if raw := input[field]; raw != nil {
			if _, valid := raw.(bool); !valid {
				return nil, fail(400, field+" 必须是JSON布尔值")
			}
		}
	}
	tags := []string{}
	if raw := input["tags"]; raw != nil {
		values, valid := raw.([]any)
		if !valid {
			return nil, fail(400, "tags 必须是字符串数组")
		}
		for _, rawTag := range values {
			tag, valid := rawTag.(string)
			if !valid || agentNodeCreateLength(tag) > 64 {
				return nil, fail(400, "每个标签必须是最多64字符的字符串")
			}
			tags = append(tags, tag)
		}
	}
	if raw := input["panelInbound"]; raw != nil {
		if _, valid := raw.(map[string]any); !valid {
			return nil, fail(400, "panelInbound 必须是JSON对象")
		}
	}
	name = agentNodeCreateTrim(name)
	if name == "" {
		return nil, fail(400, "节点名称不能为空")
	}
	utf16Length := 0
	for _, r := range name {
		utf16Length++
		if r > 0xffff {
			utf16Length++
		}
	}
	if utf16Length > 120 {
		return nil, fail(400, "节点名称过长")
	}
	data := Object{"name": name, "countryCode": nil, "region": "未指定", "provider": "未指定", "tags": tags, "recommended": false}
	for _, field := range []string{"countryCode", "region", "provider"} {
		if value, valid := input[field].(string); valid {
			if trimmed := agentNodeCreateTrim(value); trimmed != "" {
				data[field] = trimmed
			}
		}
	}
	if recommended, valid := input["recommended"].(bool); valid {
		data["recommended"] = recommended
	}
	if panel, valid := input["panelInbound"].(map[string]any); valid {
		if panel["rotateKeys"] == true {
			return nil, fail(400, "面板入站校验不会轮换密钥")
		}
		data["panelInbound"] = panel
	}
	return data, nil
}
