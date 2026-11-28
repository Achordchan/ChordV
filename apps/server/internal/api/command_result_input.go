package api

// Match the command-result DTO's validator.js character count, including
// presentation selectors, without changing other endpoints' string rules.
func commandResultErrorLength(value string) int {
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

func validateCommandResultInput(input Object) (Object, error) {
	input = pick(input, "status", "result", "error")
	status, valid := input["status"].(string)
	if !valid || status != "completed" && status != "failed" {
		return nil, fail(400, "status 必须为 completed 或 failed")
	}
	if input["result"] != nil {
		if _, valid := input["result"].(map[string]any); !valid {
			return nil, fail(400, "result 必须是对象")
		}
	}
	if input["error"] != nil {
		value, valid := input["error"].(string)
		if !valid || commandResultErrorLength(value) > 4000 {
			return nil, fail(400, "error 必须是不超过 4000 字符的字符串")
		}
	}
	return input, nil
}
