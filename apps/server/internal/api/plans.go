package api

import (
	"encoding/json"
	"math"
	"math/big"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

const planListSQL = `SELECT to_jsonb(p)||jsonb_build_object('subscriptionCount',(SELECT count(*) FROM "Subscription" s WHERE s."planId"=p.id)) FROM "Plan" p`

var planSecurityDecimalNumber = regexp.MustCompile(`^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)
var planSecurityRadixNumber = regexp.MustCompile(`^0(?:[xX][0-9a-fA-F]+|[bB][01]+|[oO][0-7]+)$`)

// This PUT formerly used its own Type(Number)/Min(1) DTO, not the plan-edit DTO.
func normalizePlanSecurityInput(input Object) (Object, error) {
	var value float64
	var err error
	switch raw := input["maxConcurrentSessions"].(type) {
	case json.Number:
		value, err = raw.Float64()
	case float64:
		value = raw
	case int:
		value = float64(raw)
	case int64:
		value = float64(raw)
	case bool:
		if raw {
			value = 1
		}
	case string:
		raw = strings.TrimFunc(raw, func(r rune) bool {
			return unicode.Is(unicode.Zs, r) || strings.ContainsRune("\t\n\v\f\r\u2028\u2029\ufeff", r)
		})
		if planSecurityRadixNumber.MatchString(raw) {
			base := 16
			if raw[1] == 'b' || raw[1] == 'B' {
				base = 2
			} else if raw[1] == 'o' || raw[1] == 'O' {
				base = 8
			}
			integer, _ := new(big.Int).SetString(raw[2:], base)
			value, _ = integer.Float64()
		} else if planSecurityDecimalNumber.MatchString(raw) {
			value, err = strconv.ParseFloat(raw, 64)
		}
	}
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < 1 {
		return nil, fail(400, "并发连接数必须是不小于1的有限数值")
	}
	// Prisma's former Int writer truncated positive fractions before storage.
	return Object{"maxConcurrentSessions": math.Trunc(value)}, nil
}

func (s *Server) plans(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	return list(r.Context(), s.DB, planListSQL+` ORDER BY p."createdAt" DESC`)
}
func validatePlan(input Object) error {
	if err := enum(input, "scope", "personal", "team"); err != nil {
		return err
	}
	if _, ok := input["totalTrafficGb"]; ok && (number(input, "totalTrafficGb") < 0 || number(input, "totalTrafficGb") > 1e9) {
		return fail(400, "套餐流量无效")
	}
	if _, ok := input["maxConcurrentSessions"]; ok && (number(input, "maxConcurrentSessions") < 1 || number(input, "maxConcurrentSessions") > 100) {
		return fail(400, "并发连接数需在1至100之间")
	}
	return nil
}
func (s *Server) createPlan(w http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	if err = requireText(input, "name", "scope"); err != nil {
		return nil, err
	}
	if err = validatePlan(input); err != nil {
		return nil, err
	}
	data := pick(input, "name", "scope", "totalTrafficGb", "renewable", "maxConcurrentSessions", "isActive")
	if _, ok := data["totalTrafficGb"]; !ok {
		return nil, fail(400, "套餐流量不能为空")
	}
	if _, ok := data["renewable"]; !ok {
		return nil, fail(400, "renewable 不能为空")
	}
	result, err := insert(r.Context(), s.DB, "Plan", data)
	if err != nil {
		return nil, err
	}
	s.changed("plans", "")
	return one(r.Context(), s.DB, planListSQL+` WHERE p.id=$1`, result["id"])
}
func (s *Server) updatePlan(w http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	if r.Method == http.MethodPut {
		input, err = normalizePlanSecurityInput(input)
	} else {
		err = validatePlan(input)
	}
	if err != nil {
		return nil, err
	}
	id := r.PathValue("planId")
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(r.Context())
	if err = lockConcurrencyScope(r.Context(), tx, "plan", id); err != nil {
		return nil, err
	}
	old, err := one(r.Context(), tx, `SELECT to_jsonb(p) FROM "Plan" p WHERE id=$1 FOR UPDATE`, id)
	if err != nil {
		return nil, err
	}
	if r.Method == http.MethodPut {
		value := number(input, "maxConcurrentSessions")
		if value > 2147483647 {
			return nil, fail(503, "套餐安全策略保存失败，请刷新套餐列表后重试。")
		}
		input["maxConcurrentSessions"] = int64(value)
	}
	if scope := text(input, "scope"); scope != "" && scope != old["scope"] {
		var used bool
		if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM "Subscription" WHERE "planId"=$1)`, id).Scan(&used); err != nil {
			return nil, err
		}
		if used {
			return nil, fail(409, "套餐已有订阅使用，不能修改类型")
		}
	}
	if _, err = update(r.Context(), tx, "Plan", id, input, "name", "scope", "totalTrafficGb", "renewable", "maxConcurrentSessions", "isActive"); err != nil {
		return nil, err
	}
	if _, ok := input["maxConcurrentSessions"]; ok {
		subscriptions, err := list(r.Context(), tx, `SELECT jsonb_build_object('id',id) FROM "Subscription" WHERE "planId"=$1 ORDER BY id`, id)
		if err != nil {
			return nil, err
		}
		for _, sub := range subscriptions {
			if err = s.reconcileSubscriptionConcurrency(r.Context(), tx, text(sub, "id")); err != nil {
				return nil, err
			}
		}
	}
	if err = tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	s.changed("plans", "")
	return one(r.Context(), s.DB, planListSQL+` WHERE p.id=$1`, id)
}
