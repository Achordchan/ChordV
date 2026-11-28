package api

import (
	"strings"
	"unicode"
	"unicode/utf16"
)

// Match the previous JavaScript String.trim contract for copied credentials:
// BOM is whitespace there, while NEXT LINE (U+0085) is not.
func trimSupportCredential(value string) string {
	return strings.TrimFunc(value, func(r rune) bool { return r == '\uFEFF' || (r != '\u0085' && unicode.IsSpace(r)) })
}

func normalizedSupportCredentials(input Object) (Object, error) {
	out := pick(input, "enabled")
	for _, field := range []string{"baseUrl", "clientId", "clientSecret", "webhookSecret"} {
		raw, supplied := input[field]
		if !supplied {
			continue
		}
		if raw == nil {
			out[field] = nil
			continue
		}
		value, ok := raw.(string)
		if !ok {
			return nil, fail(400, "工单接入地址及凭据必须为字符串或 null")
		}
		maxInput := 1024
		if field == "baseUrl" {
			maxInput = 2048
		}
		if field == "clientId" {
			maxInput = 256
		}
		if len(utf16.Encode([]rune(value))) > maxInput {
			return nil, fail(400, "工单接入地址或凭据超过允许长度")
		}
		value = trimSupportCredential(value)
		if field == "baseUrl" || field == "clientId" {
			if value == "" {
				out[field] = nil
				continue
			}
		}
		if field != "baseUrl" {
			maxLength := 512
			if field == "clientId" {
				maxLength = 191
			}
			if value == "" || len(value) > maxLength || (field == "clientId" && strings.Contains(value, ":")) {
				return nil, fail(400, "工单凭据格式无效，请从工单系统完整复制")
			}
			for _, character := range value {
				if character < 0x21 || character > 0x7e {
					return nil, fail(400, "工单凭据只能包含可打印 ASCII 字符，不能包含空白或控制字符")
				}
			}
		}
		out[field] = value
	}
	return out, nil
}
