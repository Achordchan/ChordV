package api

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

func ignoreMissing(err error) error {
	if err == pgx.ErrNoRows || errors.Is(err, errNoSubscription) {
		return nil
	}
	return err
}
func sessionReason(raw string) string {
	switch raw {
	case "concurrency_limit":
		return "connection_taken_over"
	case "admin_disconnect":
		return "admin_paused_connection"
	case "node_disabled", "node_deleted":
		return "node_access_revoked"
	case "account_changed":
		return "auth_invalid"
	case "team_member_removed":
		return "team_access_revoked"
	case "subscription_expired", "subscription_exhausted", "subscription_paused", "node_access_revoked", "team_access_revoked", "runtime_credentials_rotated", "session_expired", "account_disabled", "auth_invalid":
		return raw
	}
	return "session_invalid"
}
func (s *Server) publishLeaseRevocation(lease Object, reason string) {
	message := "连接会话已失效，请重新连接"
	if reason == "admin_paused_connection" {
		message = "管理员已暂停当前连接"
	}
	if s.events.publishOnce("lease-terminal:"+text(lease, "id"), text(lease, "userId"), Object{"type": "session_revoked", "occurredAt": now(), "sessionId": lease["sessionId"], "nodeId": lease["nodeId"], "subscriptionId": lease["subscriptionId"], "reasonCode": reason, "reasonMessage": message}) {
		s.presenceUpdated()
	}
}
func (s *Server) disableUnusedLeaseBinding(ctx context.Context, q queryer, lease Object) error {
	cutoff, err := s.leaseCutoff(time.Now())
	if err != nil {
		return err
	}
	var active bool
	if err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM "NodeSessionLease" WHERE "userId"=$1 AND "subscriptionId"=$2 AND "nodeId"=$3 AND status='active' AND "expiresAt">$4)`, lease["userId"], lease["subscriptionId"], lease["nodeId"], cutoff).Scan(&active); err != nil {
		return err
	}
	if active {
		return nil
	}
	binding, err := one(ctx, q, `SELECT to_jsonb(b) FROM "PanelClientBinding" b WHERE "userId"=$1 AND "subscriptionId"=$2 AND "nodeId"=$3 AND status='active' AND source='direct' FOR UPDATE`, lease["userId"], lease["subscriptionId"], lease["nodeId"])
	if err != nil {
		return ignoreMissing(err)
	}
	if _, err = update(ctx, q, "PanelClientBinding", text(binding, "id"), Object{"status": "disabled", "directDisabledAt": now(), "directDisableWatermarks": nil}, "status", "directDisabledAt", "directDisableWatermarks"); err != nil {
		return err
	}
	_, err = s.queueBinding(ctx, q, binding, "DISABLE_USER")
	return err
}
func (s *Server) disconnect(w http.ResponseWriter, r *http.Request, user Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(r.Context())
	if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, text(user, "id")+":connect"); err != nil {
		return nil, err
	}
	if err = lockLeaseSubscription(r.Context(), tx, text(input, "sessionId"), text(user, "id")); err != nil {
		if err == pgx.ErrNoRows {
			return Object{"ok": true, "revokedSessionCount": 0}, nil
		}
		return nil, err
	}
	lease, err := one(r.Context(), tx, `SELECT to_jsonb(l) FROM "NodeSessionLease" l WHERE "sessionId"=$1 AND "userId"=$2 FOR UPDATE`, text(input, "sessionId"), user["id"])
	if err == pgx.ErrNoRows {
		return Object{"ok": true, "revokedSessionCount": 0}, nil
	}
	if err != nil {
		return nil, err
	}
	if lease["status"] == "active" {
		if _, err = update(r.Context(), tx, "NodeSessionLease", text(lease, "id"), Object{"status": "revoked", "revokedAt": now(), "revokedReason": "client_disconnect"}, "status", "revokedAt", "revokedReason"); err != nil {
			return nil, err
		}
		if err = s.disableUnusedLeaseBinding(r.Context(), tx, lease); err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	s.changed("users", text(user, "id"))
	s.presenceUpdated()
	s.events.publish("agent:"+text(lease, "nodeId"), Object{"type": "command_ready"})
	return Object{"ok": true, "revokedSessionCount": 1}, nil
}
