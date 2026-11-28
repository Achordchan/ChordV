package api

import (
	"net/http"

	"github.com/jackc/pgx/v5"
)

func normalizeUserSecurityInput(input Object) (Object, error) {
	value := input["maxConcurrentSessionsOverride"]
	if value == nil {
		return Object{"maxConcurrentSessionsOverride": nil}, nil
	}
	// Both former security DTOs used Type(Number)/IsNumber/Min(1); keep one numeric parser.
	normalized, err := normalizePlanSecurityInput(Object{"maxConcurrentSessions": value})
	if err != nil {
		return nil, err
	}
	return Object{"maxConcurrentSessionsOverride": normalized["maxConcurrentSessions"]}, nil
}

func (s *Server) userSecurity(w http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	input, err = normalizeUserSecurityInput(input)
	if err != nil {
		return nil, err
	}
	id := r.PathValue("userId")
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(r.Context())
	var lockedID string
	if err = tx.QueryRow(r.Context(), `SELECT id FROM "User" WHERE id=$1 FOR NO KEY UPDATE`, id).Scan(&lockedID); err != nil {
		if err == pgx.ErrNoRows {
			return nil, fail(404, "用户不存在")
		}
		return nil, err
	}
	if input["maxConcurrentSessionsOverride"] != nil {
		value := number(input, "maxConcurrentSessionsOverride")
		if value > 2147483647 {
			return nil, fail(503, "账号安全策略保存失败，请刷新用户列表后重试。")
		}
		input["maxConcurrentSessionsOverride"] = int64(value)
	}
	if _, err = update(r.Context(), tx, "User", id, input, "maxConcurrentSessionsOverride"); err != nil {
		return nil, err
	}
	if err = s.reconcileUserConcurrency(r.Context(), tx, id); err != nil {
		return nil, err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	s.changed("users", id)
	return s.userResult(r, id)
}
