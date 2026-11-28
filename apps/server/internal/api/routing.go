package api

import (
	"net/http"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
)

var domainLabel = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
var routingKeyword = regexp.MustCompile(`^[a-z0-9-]{1,64}$`)

func normalizeRouting(value string) (string, string, error) {
	value = strings.TrimLeft(strings.ToLower(strings.ReplaceAll(routingInputTrim(value), "\u0130", "i\u0307")), ".")
	if value == "" || len(value) > 128 || strings.ContainsAny(value, "/?#:\\ \t\n") {
		return "", "", fail(400, "只支持有效域名或关键词，不要包含协议、路径或空格")
	}
	if !strings.Contains(value, ".") {
		if !routingKeyword.MatchString(value) {
			return "", "", fail(400, "关键词只能包含小写字母、数字和短横线。")
		}
		return value, "keyword", nil
	}
	for _, part := range strings.Split(value, ".") {
		if !domainLabel.MatchString(part) {
			return "", "", fail(400, "域名或关键词格式无效")
		}
	}
	return value, "domain", nil
}
func (s *Server) routingRules(_ http.ResponseWriter, r *http.Request, user Object) (any, error) {
	id := text(user, "id")
	if r.PathValue("userId") != "" {
		id = r.PathValue("userId")
	}
	return list(r.Context(), s.DB, `SELECT to_jsonb(r) FROM "ClientRoutingRule" r WHERE "userId"=$1 ORDER BY enabled DESC,"updatedAt" DESC`, id)
}
func (s *Server) writeRoutingRule(w http.ResponseWriter, r *http.Request, user Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	input, err = validateRoutingInput(input, r.Method == http.MethodPost)
	if err != nil {
		return nil, err
	}
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(r.Context())
	if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, text(user, "id")+":rules"); err != nil {
		return nil, err
	}
	var result Object
	if r.Method == "POST" {
		var count int
		if err = tx.QueryRow(r.Context(), `SELECT count(*) FROM "ClientRoutingRule" WHERE "userId"=$1`, user["id"]).Scan(&count); err != nil {
			return nil, err
		}
		if count >= 100 {
			return nil, fail(400, "每个账号最多保存 100 条自定义分流规则。")
		}
	} else {
		if result, err = one(r.Context(), tx, `SELECT to_jsonb(r) FROM "ClientRoutingRule" r WHERE id=$1 AND "userId"=$2 FOR UPDATE`, r.PathValue("ruleId"), user["id"]); err != nil {
			return nil, err
		}
	}
	data, err := normalizeRoutingInput(input, r.Method == http.MethodPost)
	if err != nil {
		return nil, err
	}
	if r.Method == http.MethodPost {
		data["userId"] = user["id"]
		result, err = insert(r.Context(), tx, "ClientRoutingRule", data)
	} else if len(data) > 0 {
		result, err = update(r.Context(), tx, "ClientRoutingRule", r.PathValue("ruleId"), data, "name", "value", "matchType", "action", "enabled")
	}
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	s.changed("policies", text(user, "id"))
	return result, nil
}
func (s *Server) deleteRoutingRule(_ http.ResponseWriter, r *http.Request, user Object) (any, error) {
	tag, err := s.DB.Exec(r.Context(), `DELETE FROM "ClientRoutingRule" WHERE id=$1 AND "userId"=$2`, r.PathValue("ruleId"), user["id"])
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, pgx.ErrNoRows
	}
	s.changed("policies", text(user, "id"))
	return Object{"ok": true, "deletedId": r.PathValue("ruleId")}, nil
}
