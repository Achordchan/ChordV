package api

import (
	"net/mail"
	"strings"
	"unicode"
	"unicode/utf8"
)

func trimUserText(value string) string {
	return strings.TrimFunc(value, func(r rune) bool {
		return unicode.Is(unicode.Zs, r) || strings.ContainsRune("\t\n\v\f\r\u2028\u2029\ufeff", r)
	})
}

func validateUserPassword(input Object) error {
	if raw, present := input["password"]; present {
		password, valid := raw.(string)
		if !valid || utf8.RuneCountInString(password) < 8 || len(password) > 72 {
			return fail(400, "密码至少8个字符，且不超过72字节")
		}
	}
	return nil
}

func validUserEmail(value string) bool {
	if len(value) > 254 || trimUserText(value) != value {
		return false
	}
	address, err := mail.ParseAddress(value)
	if err != nil || address.Name != "" {
		return false
	}
	at := strings.LastIndexByte(value, '@')
	if at < 1 || len(value[:at]) > 64 {
		return false
	}
	quotedLocal := value[0] == '"' && value[at-1] == '"'
	if address.Address != value && !quotedLocal {
		return false
	}
	labels := strings.Split(value[at+1:], ".")
	if len(labels) < 2 {
		return false
	}
	for _, label := range labels {
		if label == "" || len(label) > 63 || strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
			return false
		}
		for _, r := range label {
			if r != '-' && !unicode.IsLetter(r) && !unicode.IsDigit(r) {
				return false
			}
		}
	}
	tld := labels[len(labels)-1]
	if strings.HasPrefix(tld, "xn--") {
		return len(tld) > 4
	}
	if utf8.RuneCountInString(tld) < 2 {
		return false
	}
	for _, r := range tld {
		if !unicode.IsLetter(r) {
			return false
		}
	}
	return true
}

func normalizeUserInput(input Object, creating bool) (Object, error) {
	output := pick(input, "displayName", "role", "password", "maxConcurrentSessionsOverride")
	if !creating {
		if value, present := input["status"]; present {
			output["status"] = value
		}
	}
	if creating {
		email, ok := input["email"].(string)
		if !ok || !validUserEmail(email) {
			return nil, fail(400, "邮箱格式无效")
		}
		output["email"] = strings.ToLower(email)
		for _, field := range []string{"displayName", "password", "role"} {
			if _, present := input[field]; !present {
				return nil, fail(400, field+" 不能为空")
			}
		}
	}
	if raw, present := output["displayName"]; present {
		value, valid := raw.(string)
		if !valid || value == "" {
			return nil, fail(400, "名称必须是非空字符串")
		}
		output["displayName"] = trimUserText(value)
	}
	for field, allowed := range map[string][]string{"role": {"user", "admin"}, "status": {"active", "disabled"}} {
		if raw, present := output[field]; present {
			value, valid := raw.(string)
			if !valid || (value != allowed[0] && value != allowed[1]) {
				return nil, fail(400, field+" 的取值无效")
			}
		}
	}
	if err := validateUserPassword(output); err != nil {
		return nil, err
	}
	if value, present := output["maxConcurrentSessionsOverride"]; present {
		normalized, err := normalizeUserSecurityInput(Object{"maxConcurrentSessionsOverride": value})
		if err != nil {
			return nil, err
		}
		output["maxConcurrentSessionsOverride"] = normalized["maxConcurrentSessionsOverride"]
	}
	return output, nil
}

func userConcurrentStorageInput(input Object) error {
	if input["maxConcurrentSessionsOverride"] != nil {
		value := number(input, "maxConcurrentSessionsOverride")
		if value > 2147483647 {
			return fail(503, "账号保存失败，请刷新用户列表后重试。")
		}
		input["maxConcurrentSessionsOverride"] = int64(value)
	}
	return nil
}
