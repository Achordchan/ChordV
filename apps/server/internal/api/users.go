package api

import (
	"net/http"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

const userListSQL = `SELECT (to_jsonb(u)-'passwordHash'-'authVersion') || jsonb_build_object('accountType',CASE WHEN m.id IS NULL THEN 'personal' ELSE 'team' END,'teamId',t.id,'teamName',t.name,'subscriptionCount',(SELECT count(*) FROM "Subscription" z WHERE z."userId"=u.id OR z."teamId"=t.id),'activeSubscriptionCount',(SELECT count(*) FROM "Subscription" z WHERE (z."userId"=u.id OR z."teamId"=t.id) AND z.state='active' AND z."expireAt">now() AND z."remainingTrafficGb">0),'currentSubscription',(SELECT jsonb_build_object('id',z.id,'ownerType',CASE WHEN z."teamId" IS NULL THEN 'user' ELSE 'team' END,'planId',p.id,'planName',p.name,'remainingTrafficGb',z."remainingTrafficGb",'expireAt',z."expireAt",'state',z.state,'teamId',z."teamId",'teamName',t.name) FROM "Subscription" z JOIN "Plan" p ON p.id=z."planId" WHERE z."userId"=u.id OR z."teamId"=t.id ORDER BY z."expireAt" DESC LIMIT 1),'clientVersions',coalesce((SELECT jsonb_agg(to_jsonb(v)-'userId'-'createdAt'-'updatedAt' ORDER BY v."lastSeenAt" DESC) FROM "UserClientVersion" v WHERE v."userId"=u.id),'[]'::jsonb)) FROM "User" u LEFT JOIN "TeamMember" m ON m."userId"=u.id LEFT JOIN "Team" t ON t.id=m."teamId"`

func (s *Server) users(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	return list(r.Context(), s.DB, userListSQL+` ORDER BY u."createdAt" DESC`)
}
func (s *Server) userResult(r *http.Request, id string) (Object, error) {
	return one(r.Context(), s.DB, userListSQL+` WHERE u.id=$1`, id)
}
func (s *Server) createUser(w http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	input, err = normalizeUserInput(input, true)
	if err != nil {
		return nil, err
	}
	var exists bool
	if err = s.DB.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM "User" WHERE email=$1)`, input["email"]).Scan(&exists); err != nil {
		return nil, err
	}
	if exists {
		return nil, fail(409, "邮箱已存在")
	}
	if err = userConcurrentStorageInput(input); err != nil {
		return nil, err
	}
	password := stringValue(input, "password")
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, err
	}
	data := pick(input, "displayName", "role", "maxConcurrentSessionsOverride")
	data["email"] = input["email"]
	data["passwordHash"] = string(hash)
	data["status"] = "active"
	data["lastSeenAt"] = now()
	result, err := insert(r.Context(), s.DB, "User", data)
	if err != nil {
		return nil, err
	}
	s.changed("users", "")
	return s.userResult(r, text(result, "id"))
}
func (s *Server) updateUser(w http.ResponseWriter, r *http.Request, current Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	input, err = normalizeUserInput(input, false)
	if err != nil {
		return nil, err
	}
	id := r.PathValue("userId")
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(r.Context())
	if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(486912626)`); err != nil {
		return nil, err
	}
	old, err := one(r.Context(), tx, `SELECT to_jsonb(u) FROM "User" u WHERE id=$1 FOR NO KEY UPDATE`, id)
	if err != nil {
		return nil, err
	}
	if err = lockConcurrencyScope(r.Context(), tx, "user", id); err != nil {
		return nil, err
	}
	if old["role"] == "admin" && old["status"] == "active" && input["role"] == "user" && input["status"] != "disabled" {
		var count int
		if err = tx.QueryRow(r.Context(), `SELECT count(*) FROM "User" WHERE role='admin' AND status='active'`).Scan(&count); err != nil {
			return nil, err
		}
		if count <= 1 {
			return nil, fail(409, "至少保留一名启用的管理员")
		}
	}
	data := pick(input, "displayName", "role", "status", "maxConcurrentSessionsOverride")
	if err = userConcurrentStorageInput(data); err != nil {
		return nil, err
	}

	statusChanged := input["status"] != nil && input["status"] != old["status"]
	sensitive := statusChanged && input["status"] == "disabled" || input["role"] != nil && input["role"] != old["role"]
	if password, present := input["password"].(string); present {
		hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
		if err != nil {
			return nil, err
		}
		data["passwordHash"] = string(hash)
		sensitive = true
	}
	if statusChanged && input["status"] == "disabled" {
		if _, err = s.disableUserAccount(r.Context(), tx, old); err != nil {
			return nil, err
		}
	} else if sensitive {
		data["authVersion"] = number(old, "authVersion") + 1
		if _, err = tx.Exec(r.Context(), `UPDATE "RefreshToken" SET "revokedAt"=now(),"updatedAt"=now() WHERE "userId"=$1 AND "revokedAt" IS NULL`, id); err != nil {
			return nil, err
		}
		if _, err = s.revokeLeases(r.Context(), tx, "userId", id, "auth_invalid"); err != nil {
			return nil, err
		}
	}
	if _, err = update(r.Context(), tx, "User", id, data, "displayName", "role", "status", "maxConcurrentSessionsOverride", "passwordHash", "authVersion"); err != nil {
		return nil, err
	}
	if statusChanged && input["status"] == "active" {
		if err = s.syncUserSubscriptions(r.Context(), tx, id); err != nil {
			return nil, err
		}
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
func (s *Server) disconnectUser(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(r.Context())
	count, err := s.revokeLeases(r.Context(), tx, "userId", r.PathValue("userId"), "admin_disconnect")
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	s.changed("users", r.PathValue("userId"))
	return Object{"ok": true, "revokedSessionCount": count}, nil
}
func (s *Server) adminSecurity(w http.ResponseWriter, r *http.Request, user Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	if err = requireText(input, "currentPassword", "email"); err != nil {
		return nil, err
	}
	email := strings.ToLower(text(input, "email"))
	if !strings.Contains(email, "@") || len(email) > 320 {
		return nil, fail(400, "邮箱格式无效")
	}
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(r.Context())
	old, err := one(r.Context(), tx, `SELECT to_jsonb(u) FROM "User" u WHERE id=$1 FOR NO KEY UPDATE`, user["id"])
	if err != nil {
		return nil, err
	}
	if old["status"] != "active" || old["role"] != "admin" || number(old, "authVersion") != number(user, "authVersion") {
		return nil, fail(401, "账号状态已变化，请重新登录")
	}
	if bcrypt.CompareHashAndPassword([]byte(text(old, "passwordHash")), []byte(stringValue(input, "currentPassword"))) != nil {
		return nil, fail(403, "当前密码不正确")
	}
	data := Object{"email": email, "authVersion": number(old, "authVersion") + 1}
	if pass := stringValue(input, "newPassword"); pass != "" {
		if len(pass) < 8 || len(pass) > 72 {
			return nil, fail(400, "密码需8至72字节")
		}
		hash, e := bcrypt.GenerateFromPassword([]byte(pass), bcrypt.DefaultCost)
		if e != nil {
			return nil, e
		}
		data["passwordHash"] = string(hash)
	}
	if err = lockConcurrencyScope(r.Context(), tx, "user", text(user, "id")); err != nil {
		return nil, err
	}
	updated, err := update(r.Context(), tx, "User", text(user, "id"), data, "email", "authVersion", "passwordHash")
	if err != nil {
		return nil, err
	}
	if _, err = tx.Exec(r.Context(), `UPDATE "RefreshToken" SET "revokedAt"=now(),"updatedAt"=now() WHERE "userId"=$1 AND "revokedAt" IS NULL`, user["id"]); err != nil {
		return nil, err
	}
	if _, err = s.revokeLeases(r.Context(), tx, "userId", text(user, "id"), "auth_invalid"); err != nil {
		return nil, err
	}
	session, err := s.issueSession(r.Context(), tx, updated)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	s.setSessionCookie(w, session)
	s.changed("users", text(user, "id"))
	return session, nil
}
