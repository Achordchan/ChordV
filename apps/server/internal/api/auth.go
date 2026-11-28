package api

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
)

func (s *Server) authenticate(r *http.Request) (Object, error) {
	return s.authenticateQuery(r, s.DB)
}

func (s *Server) authenticateQuery(r *http.Request, q queryer) (Object, error) {
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if token == r.Header.Get("Authorization") {
		return nil, fail(401, "缺少登录凭证，请重新登录。")
	}
	claims, err := s.verifyJWT(token)
	if err != nil {
		return nil, fail(401, "登录凭证无效，请重新登录。")
	}
	user, err := one(r.Context(), q, `SELECT to_jsonb(u)-'passwordHash' FROM "User" u JOIN "RefreshToken" t ON t."userId"=u.id WHERE u.id=$1 AND t.id=$2 AND t."revokedAt" IS NULL AND t."expiresAt">clock_timestamp() AND u.status='active' AND u."authVersion"=$3`, text(claims, "sub"), text(claims, "sid"), int(number(claims, "ver")))
	if err == pgx.ErrNoRows {
		return nil, fail(401, "登录已失效，请重新登录。")
	}
	return user, err
}
func (s *Server) login(w http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	email := strings.ToLower(text(input, "email"))
	password := stringValue(input, "password")
	if len(email) > 320 || len(password) < 8 || len(password) > 256 || !strings.Contains(email, "@") {
		return nil, fail(400, "请输入有效邮箱及至少8位密码")
	}
	keys := loginRateKeys(email, s.requestIP(r))
	if err = s.admitLogin(r.Context(), keys); err != nil {
		return nil, err
	}
	user, err := one(r.Context(), s.DB, `SELECT to_jsonb(u) FROM "User" u WHERE lower(email)=$1`, email)
	if err == pgx.ErrNoRows {
		return nil, fail(401, "邮箱或密码错误。")
	}
	if err != nil {
		return nil, err
	}
	if bcrypt.CompareHashAndPassword([]byte(text(user, "passwordHash")), []byte(password)) != nil {
		return nil, fail(401, "邮箱或密码错误。")
	}
	if user["status"] != "active" {
		return nil, fail(403, "当前账号已禁用。")
	}
	if strings.Contains(r.URL.Path, "/admin/") && user["role"] != "admin" {
		return nil, fail(403, "需要管理员权限")
	}
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(r.Context())
	if _, err = tx.Exec(r.Context(), `UPDATE "User" SET "lastSeenAt"=now(),"updatedAt"=now() WHERE id=$1`, user["id"]); err != nil {
		return nil, err
	}
	user["lastSeenAt"] = now()
	session, err := s.issueSession(r.Context(), tx, user)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	if err = s.clearLoginLimit(r.Context(), keys); err != nil {
		return nil, err
	}
	s.setSessionCookie(w, session)
	return session, nil
}
func (s *Server) issueSession(ctx context.Context, q queryer, user Object) (Object, error) {
	issued := time.Now().UTC()
	accessExpires := issued.Add(15 * time.Minute)
	refreshExpires := issued.Add(30 * 24 * time.Hour)
	id := newID()
	refresh := randomToken()
	_, err := q.Exec(ctx, `INSERT INTO "RefreshToken" (id,"userId","tokenHash","expiresAt","updatedAt") VALUES($1,$2,$3,$4,now())`, id, user["id"], tokenHash(refresh), refreshExpires)
	if err != nil {
		return nil, err
	}
	access, err := s.signJWT(Object{"sub": user["id"], "email": user["email"], "role": user["role"], "ver": user["authVersion"], "sid": id, "iss": s.Config.AccessTokenIssuer(), "iat": issued.Unix(), "exp": accessExpires.Unix()})
	if err != nil {
		return nil, err
	}
	profile := Object{}
	for _, key := range []string{"id", "email", "displayName", "role", "status", "lastSeenAt"} {
		profile[key] = user[key]
	}
	return Object{"accessToken": access, "refreshToken": refresh, "accessTokenExpiresAt": accessExpires.Format(time.RFC3339Nano), "refreshTokenExpiresAt": refreshExpires.Format(time.RFC3339Nano), "user": profile}, nil
}
func refreshFromRequest(r *http.Request, input Object) string {
	if token := text(input, "refreshToken"); token != "" {
		return token
	}
	if cookie, err := r.Cookie("chordv_admin_refresh"); err == nil {
		return cookie.Value
	}
	return ""
}
func (s *Server) setSessionCookie(w http.ResponseWriter, session Object) {
	expires, _ := time.Parse(time.RFC3339Nano, text(session, "refreshTokenExpiresAt"))
	http.SetCookie(w, &http.Cookie{Name: "chordv_admin_refresh", Value: text(session, "refreshToken"), Path: "/api/auth", HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: s.Config.Production(), Expires: expires})
}
func (s *Server) refresh(w http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	token := refreshFromRequest(r, input)
	if token == "" {
		return nil, fail(401, "登录已失效，请重新登录。")
	}
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(r.Context())
	discovered, err := one(r.Context(), tx, `SELECT jsonb_build_object('id',id,'userId',"userId") FROM "RefreshToken" WHERE "tokenHash"=$1`, tokenHash(token))
	if err == pgx.ErrNoRows {
		return nil, fail(401, "登录已失效，请重新登录。")
	}
	if err != nil {
		return nil, err
	}
	user, err := one(r.Context(), tx, `SELECT to_jsonb(u) FROM "User" u WHERE id=$1 AND status='active' FOR NO KEY UPDATE`, discovered["userId"])
	if err == pgx.ErrNoRows {
		return nil, fail(401, "登录已失效，请重新登录。")
	}
	if err != nil {
		return nil, err
	}
	record, err := one(r.Context(), tx, `SELECT jsonb_build_object('id',id,'expiresAt',"expiresAt") FROM "RefreshToken" WHERE id=$1 AND "userId"=$2 AND "tokenHash"=$3 AND "revokedAt" IS NULL FOR UPDATE`, discovered["id"], user["id"], tokenHash(token))
	if err == pgx.ErrNoRows {
		return nil, fail(401, "登录已失效，请重新登录。")
	}
	if err != nil {
		return nil, err
	}
	expires, err := parseTimestamp(text(record, "expiresAt"))
	if err != nil {
		return nil, err
	}
	if !expires.After(time.Now()) {
		return nil, fail(401, "登录已失效，请重新登录。")
	}
	if _, err = tx.Exec(r.Context(), `UPDATE "RefreshToken" SET "revokedAt"=now(),"updatedAt"=now() WHERE id=$1`, record["id"]); err != nil {
		return nil, err
	}
	session, err := s.issueSession(r.Context(), tx, user)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	s.setSessionCookie(w, session)
	return session, nil
}
func (s *Server) logout(w http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	token := refreshFromRequest(r, input)
	if token != "" {
		_, err = s.DB.Exec(r.Context(), `UPDATE "RefreshToken" SET "revokedAt"=now(),"updatedAt"=now() WHERE "tokenHash"=$1 AND "revokedAt" IS NULL`, tokenHash(token))
		if err != nil {
			return nil, err
		}
	} else if claims, verifyErr := s.verifyJWT(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")); verifyErr == nil {
		_, err = s.DB.Exec(r.Context(), `UPDATE "RefreshToken" SET "revokedAt"=now(),"updatedAt"=now() WHERE id=$1 AND "userId"=$2 AND "revokedAt" IS NULL`, claims["sid"], claims["sub"])
		if err != nil {
			return nil, err
		}
	}
	http.SetCookie(w, &http.Cookie{Name: "chordv_admin_refresh", Path: "/api/auth", HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: s.Config.Production(), MaxAge: -1})
	return Object{"ok": true}, nil
}
func (s *Server) CreateAdmin(ctx context.Context, email, password string) error {
	if !strings.Contains(email, "@") || len(password) < 12 || len(password) > 72 || len(email) > 320 {
		return fail(400, "管理员邮箱无效或密码不在12至72字节范围")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	_, err = s.DB.Exec(ctx, `INSERT INTO "User"(id,email,"displayName",role,status,"passwordHash","lastSeenAt","updatedAt") VALUES($1,$2,'本地管理员','admin','active',$3,now(),now())`, newID(), strings.ToLower(strings.TrimSpace(email)), string(hash))
	return err
}
