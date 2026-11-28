package api

import (
	"strings"
	"unicode"
	"unicode/utf16"
)

func routingInputLength(value string) int {
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

func routingInputTrim(value string) string {
	return strings.TrimFunc(value, func(r rune) bool {
		return unicode.Is(unicode.Zs, r) || strings.ContainsRune("\t\n\v\f\r\u2028\u2029\ufeff", r)
	})
}

func validateRoutingInput(input Object, create bool) (Object, error) {
	input = pick(input, "name", "value", "action", "enabled")
	for _, field := range []string{"name", "value", "action"} {
		raw, provided := input[field]
		required := create && field != "name"
		if (!provided || raw == nil) && !required {
			continue
		}
		value, valid := raw.(string)
		if !valid || (required && value == "") {
			return nil, fail(400, field+" 必须是有效字符串")
		}
		if field == "action" && value != "proxy" && value != "direct" {
			return nil, fail(400, "分流动作只能是强制代理或强制直连。")
		}
		if field == "name" && routingInputLength(value) > 80 || field == "value" && routingInputLength(value) > 128 {
			return nil, fail(400, field+" 超过允许长度")
		}
	}
	if raw := input["enabled"]; raw != nil {
		if _, valid := raw.(bool); !valid {
			return nil, fail(400, "enabled 必须是JSON布尔值")
		}
	}
	return input, nil
}

func normalizeRoutingInput(input Object, create bool) (Object, error) {
	data := Object{}
	// The original service normalized value before evaluating the save object.
	if raw, provided := input["value"]; provided {
		value, _ := raw.(string)
		normalized, kind, err := normalizeRouting(value)
		if err != nil {
			return nil, err
		}
		data["value"], data["matchType"] = normalized, kind
	}
	if raw, provided := input["name"]; provided || create {
		data["name"] = nil
		if name, valid := raw.(string); valid {
			name = routingInputTrim(name)
			if name != "" {
				units := utf16.Encode([]rune(name))
				if len(units) > 80 {
					units = units[:80]
				}
				// The former JS slice could end on a lone high surrogate; the real
				// Prisma writer then failed without saving or publishing an event.
				if len(units) > 0 && units[len(units)-1] >= 0xd800 && units[len(units)-1] <= 0xdbff {
					return nil, fail(500, "Internal server error")
				}
				data["name"] = string(utf16.Decode(units))
			}
		}
	}
	if action, provided := input["action"]; provided {
		if action != "proxy" && action != "direct" {
			return nil, fail(400, "分流动作只能是强制代理或强制直连。")
		}
		data["action"] = action
	}
	if enabled, provided := input["enabled"]; provided {
		if enabled == nil {
			if !create {
				return nil, fail(500, "Internal server error")
			}
			enabled = true
		}
		data["enabled"] = enabled
	} else if create {
		data["enabled"] = true
	}
	return data, nil
}
