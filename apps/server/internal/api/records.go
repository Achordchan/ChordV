package api

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

func insert(ctx context.Context, q queryer, table string, input Object) (Object, error) {
	data := Object{}
	for key, value := range input {
		data[key] = value
	}
	data["id"] = newID()
	data["createdAt"] = now()
	if table != "SupportTicketMessage" && table != "SupportTicketAttachment" {
		data["updatedAt"] = now()
	}
	keys := make([]string, 0, len(data))
	for key := range data {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	raw, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	columns := []string{}
	for _, key := range keys {
		columns = append(columns, quote(key))
	}
	return one(ctx, q, fmt.Sprintf(`WITH result AS(INSERT INTO %s (%s) SELECT %s FROM jsonb_populate_record(NULL::%s,$1::jsonb) RETURNING *) SELECT to_jsonb(result.*) FROM result`, quote(table), strings.Join(columns, ","), strings.Join(columns, ","), quote(table)), raw)
}
func update(ctx context.Context, q queryer, table, id string, input Object, allowed ...string) (Object, error) {
	return updateKey(ctx, q, table, "id", id, input, allowed...)
}
func updateKey(ctx context.Context, q queryer, table, keyColumn, id string, input Object, allowed ...string) (Object, error) {
	data := Object{}
	for _, key := range allowed {
		if value, ok := input[key]; ok {
			data[key] = value
		}
	}
	data["updatedAt"] = now()
	raw, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	keys := []string{}
	for key := range data {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	set := []string{}
	for _, key := range keys {
		set = append(set, fmt.Sprintf(`%s=(SELECT %s FROM jsonb_populate_record(NULL::%s,$1::jsonb))`, quote(key), quote(key), quote(table)))
	}
	return one(ctx, q, fmt.Sprintf(`WITH result AS(UPDATE %s SET %s WHERE %s=$2 RETURNING *) SELECT to_jsonb(result.*) FROM result`, quote(table), strings.Join(set, ","), quote(keyColumn)), raw, id)
}
func quote(value string) string { return `"` + strings.ReplaceAll(value, `"`, `""`) + `"` }
func pick(input Object, keys ...string) Object {
	out := Object{}
	for _, key := range keys {
		if value, ok := input[key]; ok {
			out[key] = value
		}
	}
	return out
}
func requireText(input Object, keys ...string) error {
	for _, key := range keys {
		if text(input, key) == "" {
			return fail(400, key+" 不能为空")
		}
	}
	return nil
}
func enum(input Object, key string, values ...string) error {
	if _, ok := input[key]; !ok {
		return nil
	}
	value := text(input, key)
	for _, allowed := range values {
		if value == allowed {
			return nil
		}
	}
	return fail(400, key+" 的取值无效")
}
