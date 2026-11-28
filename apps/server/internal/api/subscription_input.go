package api

import (
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

var subscriptionDecimalNumber = regexp.MustCompile(`^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)

func validSubscriptionTraffic(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0 && value <= 1e9
}

// Match the former DTO's Type(Number), then validate before any database writes.
// Missing fields retain their defaults; explicit null was never optional.
func normalizeSubscriptionTraffic(input Object) error {
	for _, field := range []string{"totalTrafficGb", "usedTrafficGb"} {
		raw, exists := input[field]
		if !exists {
			continue
		}
		var value float64
		var err error
		switch number := raw.(type) {
		case float64:
			value = number
		case int:
			value = float64(number)
		case int64:
			value = float64(number)
		case json.Number:
			value, err = number.Float64()
		case bool:
			if number {
				value = 1
			}
		case string:
			text := strings.TrimFunc(number, func(r rune) bool {
				return unicode.Is(unicode.Zs, r) || strings.ContainsRune("\t\n\v\f\r\u2028\u2029\ufeff", r)
			})
			if text == "" {
				break
			}
			base := 0
			if len(text) > 2 && text[0] == '0' {
				switch text[1] {
				case 'x', 'X':
					base = 16
				case 'b', 'B':
					base = 2
				case 'o', 'O':
					base = 8
				}
			}
			if base != 0 {
				var integer uint64
				integer, err = strconv.ParseUint(text[2:], base, 64)
				value = float64(integer)
			} else if subscriptionDecimalNumber.MatchString(text) {
				value, err = strconv.ParseFloat(text, 64)
			} else {
				return fail(400, field+" 必须是有效流量数值")
			}
		default:
			return fail(400, field+" 必须是有效流量数值")
		}
		if err != nil || !validSubscriptionTraffic(value) {
			return fail(400, field+" 必须是 0 到 1000000000 之间的有限数值")
		}
		input[field] = value
	}
	return nil
}
