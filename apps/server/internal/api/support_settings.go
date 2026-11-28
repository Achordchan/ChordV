package api

import (
	"encoding/json"
	"net/http"
	"strings"
)

func (s *Server) saveSupportConfig(w http.ResponseWriter, r *http.Request, user Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	input, err = normalizedSupportCredentials(input)
	if err != nil {
		return nil, err
	}
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(r.Context())
	if _, err = tx.Exec(r.Context(), `INSERT INTO "SystemSetting"(key,value,"updatedAt") VALUES('achord-connect','{}',now()) ON CONFLICT(key) DO NOTHING`); err != nil {
		return nil, err
	}
	cfg, err := one(r.Context(), tx, `SELECT value FROM "SystemSetting" WHERE key='achord-connect' FOR UPDATE`)
	if err != nil {
		return nil, err
	}
	next := Object{}
	for key, value := range cfg {
		next[key] = value
	}
	for key, value := range pick(input, "baseUrl", "clientId", "clientSecret", "webhookSecret", "enabled") {
		next[key] = value
	}
	if text(next, "baseUrl") != "" {
		origin, err := s.integrationOrigin(text(next, "baseUrl"))
		if err != nil {
			return nil, err
		}
		next["baseUrl"] = origin
	}
	if boolean(next, "enabled", false) && (text(next, "baseUrl") == "" || text(next, "clientId") == "" || text(next, "clientSecret") == "" || text(next, "webhookSecret") == "") {
		return nil, fail(400, "启用工单接入前需填写地址和全部凭据")
	}
	changed := cfg["baseUrl"] != next["baseUrl"] || cfg["clientId"] != next["clientId"]
	if changed && text(cfg, "baseUrl") != "" && text(cfg, "clientId") != "" {
		secret, supplied := input["webhookSecret"].(string)
		if !supplied || strings.TrimSpace(secret) == "" || text(next, "webhookSecret") == text(cfg, "webhookSecret") {
			return nil, fail(400, "更换工单系统地址或 Client ID 时，请同时填写新连接的 Webhook Secret（不能与当前的相同）")
		}
	}
	enabledChanged := boolean(cfg, "enabled", false) != boolean(next, "enabled", false)
	next["generation"] = number(cfg, "generation")
	next["epoch"] = number(cfg, "epoch")
	if changed {
		next["generation"] = number(cfg, "generation") + 1
	}
	if changed || enabledChanged {
		next["epoch"] = number(cfg, "epoch") + 1
	}
	raw, err := json.Marshal(next)
	if err != nil {
		return nil, err
	}
	if _, err = tx.Exec(r.Context(), `UPDATE "SystemSetting" SET value=$1::jsonb,"updatedAt"=now() WHERE key='achord-connect'`, raw); err != nil {
		return nil, err
	}
	if changed {
		if _, err = tx.Exec(r.Context(), `UPDATE "SupportUnreadState" SET "unreadCount"=0,"sourceAt"=NULL,"snapshotUntil"=NULL,"syncedAt"=NULL,"requestsComplete"=true,revision=revision+1,"updatedAt"=now()`); err != nil {
			return nil, err
		}
		if _, err = tx.Exec(r.Context(), `DELETE FROM "SupportRequestUnread"`); err != nil {
			return nil, err
		}
	} else if enabledChanged && boolean(next, "enabled", false) {
		if _, err = tx.Exec(r.Context(), `UPDATE "SupportUnreadState" SET "syncedAt"=NULL,revision=revision+1,"updatedAt"=now()`); err != nil {
			return nil, err
		}
	}
	users, err := list(r.Context(), tx, `SELECT jsonb_build_object('id',"userId") FROM "SupportUnreadState"`)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	if changed || enabledChanged {
		for _, u := range users {
			s.publishCurrentUnread(text(u, "id"))
			if boolean(next, "enabled", false) {
				s.scheduleSupportResync(text(u, "id"))
			}
		}
	}
	return s.supportConfig(w, r, user)
}

func supportEnabled(cfg Object) bool {
	return boolean(cfg, "enabled", false) && text(cfg, "baseUrl") != "" && text(cfg, "clientId") != "" && text(cfg, "clientSecret") != "" && text(cfg, "webhookSecret") != ""
}
