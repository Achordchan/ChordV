package api

import (
	"bytes"
	"encoding/json"
	"io"
)

func stringArray(raw any, max int) ([]string, error) {
	values, ok := raw.([]any)
	if !ok {
		return nil, fail(400, "字段必须为字符串数组")
	}
	if len(values) > max {
		return nil, fail(400, "数组超过允许长度")
	}
	out := []string{}
	seen := map[string]bool{}
	for _, v := range values {
		s, ok := v.(string)
		if !ok || s == "" || len(s) > 128 || seen[s] {
			return nil, fail(400, "数组元素无效或重复")
		}
		out = append(out, s)
		seen[s] = true
	}
	return out, nil
}
func marshalBody(input Object) (io.ReadCloser, error) {
	raw, err := json.Marshal(input)
	return io.NopCloser(bytes.NewReader(raw)), err
}
