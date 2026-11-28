package api

import (
	"encoding/json"
	"math"
	"math/big"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

var announcementDecimal = regexp.MustCompile(`^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)

func announcementTrim(value string) string {
	return strings.TrimFunc(value, func(r rune) bool {
		return unicode.Is(unicode.Zs, r) || strings.ContainsRune("\t\n\v\f\r\u2028\u2029\ufeff", r)
	})
}

func announcementTextLength(value string) int {
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

// Only this DTO used @Type(() => Number); keep that conversion local rather
// than weakening strict numeric inputs on other endpoints.
func announcementCountdownInput(raw any) (float64, error) {
	var value float64
	var err error
	switch raw := raw.(type) {
	case json.Number:
		value, err = raw.Float64()
	case float64:
		value = raw
	case bool:
		if raw {
			value = 1
		}
	case string:
		text := announcementTrim(raw)
		if text != "" {
			if len(text) > 2 && text[0] == '0' && strings.ContainsRune("xXbBoO", rune(text[1])) {
				integer, valid := new(big.Int).SetString(text[2:], map[byte]int{'x': 16, 'X': 16, 'b': 2, 'B': 2, 'o': 8, 'O': 8}[text[1]])
				if !valid || text[2] == '+' || text[2] == '-' {
					return 0, fail(400, "倒计时必须是非负整数")
				}
				value, _ = new(big.Float).SetInt(integer).Float64()
			} else {
				if !announcementDecimal.MatchString(text) {
					return 0, fail(400, "倒计时必须是非负整数")
				}
				value, err = strconv.ParseFloat(text, 64)
			}
		}
	default:
		return 0, fail(400, "倒计时必须是非负整数")
	}
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || math.Trunc(value) != value {
		return 0, fail(400, "倒计时必须是非负整数")
	}
	return value, nil
}

func validateAnnouncementInput(input Object, create bool) (Object, error) {
	input = pick(input, "title", "body", "level", "publishedAt", "isActive", "displayMode", "countdownSeconds")
	for field, limit := range map[string]int{"title": 120, "body": 4000} {
		raw, provided := input[field]
		if !provided && !create {
			continue
		}
		value, valid := raw.(string)
		value = announcementTrim(value)
		if !valid || value == "" || announcementTextLength(value) > limit {
			return nil, fail(400, field+" 必须是不超过 "+strconv.Itoa(limit)+" 字符的非空文本")
		}
		input[field] = value
	}
	for field, allowed := range map[string][]string{"level": {"info", "warning", "success"}, "displayMode": {"passive", "modal_confirm", "modal_countdown"}} {
		raw, provided := input[field]
		if !provided && (!create || field != "level") {
			continue
		}
		value, valid := raw.(string)
		matched := false
		for _, candidate := range allowed {
			matched = matched || value == candidate
		}
		if !valid || !matched {
			return nil, fail(400, field+" 取值无效")
		}
	}
	if raw, provided := input["isActive"]; provided {
		if _, valid := raw.(bool); !valid {
			return nil, fail(400, "isActive 必须是布尔值")
		}
	}
	if raw, provided := input["countdownSeconds"]; provided {
		value, err := announcementCountdownInput(raw)
		if err != nil {
			return nil, err
		}
		input["countdownSeconds"] = value
	}
	if raw, provided := input["publishedAt"]; provided {
		date, err := announcementDate(raw)
		if err != nil {
			return nil, err
		}
		input["publishedAt"] = date
	}
	return input, nil
}

func announcementWriteData(input, current Object, create bool) (Object, error) {
	data := pick(input, "title", "body", "level", "publishedAt", "isActive", "displayMode", "countdownSeconds")
	mode := current["displayMode"]
	if mode == nil {
		mode = "passive"
	}
	if value, provided := input["displayMode"]; provided {
		mode = value
	}
	countdown := number(current, "countdownSeconds")
	if mode == "modal_countdown" && countdown < 1 {
		countdown = 5
	}
	if value, provided := input["countdownSeconds"]; provided {
		countdown = value.(float64)
	}
	if mode == "modal_countdown" {
		if countdown < 1 {
			return nil, fail(400, "倒计时确认必须至少等待 1 秒")
		}
	} else {
		countdown = 0
	}
	if create {
		data["displayMode"], data["countdownSeconds"] = mode, countdown
		if _, provided := data["publishedAt"]; !provided {
			data["publishedAt"] = now()
		}
	} else if _, provided := input["displayMode"]; provided {
		data["countdownSeconds"] = countdown
	} else if _, provided := input["countdownSeconds"]; provided {
		data["countdownSeconds"] = countdown
	}
	return data, nil
}
