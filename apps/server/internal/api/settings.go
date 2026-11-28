package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"

	"github.com/Achordchan/ChordV/apps/server/internal/config"
	"github.com/jackc/pgx/v5"
)

func (s *Server) setting(ctx context.Context, key string) (Object, error) {
	record, err := one(ctx, s.DB, `SELECT value||jsonb_build_object('updatedAt',"updatedAt") FROM "SystemSetting" WHERE key=$1`, key)
	if err == pgx.ErrNoRows {
		return Object{}, nil
	}
	return record, err
}
func (s *Server) saveSetting(ctx context.Context, key string, value Object) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = s.DB.Exec(ctx, `INSERT INTO "SystemSetting"(key,value,"updatedAt") VALUES($1,$2::jsonb,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,"updatedAt"=now()`, key, raw)
	return err
}
func localOrigin(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || !config.LoopbackHost(u.Hostname()) || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", fail(400, "本地调试仅允许回环 HTTP 地址，不能配置线上站点")
	}
	return u.Scheme + "://" + u.Host, nil
}
func (s *Server) siteAddressConfig(ctx context.Context) (Object, error) {
	value, err := s.setting(ctx, "site-address")
	if err != nil {
		return nil, err
	}
	if len(value) == 0 {
		primary, err := s.siteOrigin(s.defaultPublicOrigin())
		if err != nil {
			return nil, err
		}
		return Object{"primaryOrigin": primary, "legacyOrigins": []string{}, "updatedAt": nil}, nil
	}
	normalized, err := s.normalizeSiteAddress(value, false)
	if err != nil {
		return nil, err
	}
	normalized["updatedAt"] = value["updatedAt"]
	return normalized, nil
}

func (s *Server) publicOrigin(ctx context.Context) (string, error) {
	value, err := s.siteAddressConfig(ctx)
	return text(value, "primaryOrigin"), err
}
func (s *Server) siteAddress(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	return s.siteAddressConfig(r.Context())
}
func (s *Server) saveSiteAddress(w http.ResponseWriter, r *http.Request, u Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	normalized, err := s.normalizeSiteAddress(input, true)
	if err != nil {
		return nil, err
	}
	if err = s.saveSetting(r.Context(), "site-address", normalized); err != nil {
		return nil, err
	}
	return s.siteAddress(w, r, u)
}
