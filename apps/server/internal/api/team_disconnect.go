package api

import (
	"context"
	"net/http"
)

func lockTeamSubscriptions(ctx context.Context, q queryer, teamID string) error {
	rows, err := list(ctx, q, `SELECT jsonb_build_object('id',id) FROM "Subscription" WHERE "teamId"=$1 ORDER BY id`, teamID)
	if err != nil {
		return err
	}
	return lockRuntimeSubscriptionSet(ctx, q, runtimeSubscriptionIDs(rows))
}

// Callers lock team subscriptions and the member before entering bindings/nodes.
func (s *Server) revokeTeamMemberLeases(ctx context.Context, q queryer, teamID, userID, reason string) (int64, error) {
	subs, err := list(ctx, q, `SELECT jsonb_build_object('id',id) FROM "Subscription" WHERE "teamId"=$1 ORDER BY id`, teamID)
	if err != nil {
		return 0, err
	}
	if err = lockRuntimeSubscriptionSet(ctx, q, runtimeSubscriptionIDs(subs)); err != nil {
		return 0, err
	}
	if err = lockRuntimeBindingsAndNodes(ctx, q, runtimeSubscriptionIDs(subs)); err != nil {
		return 0, err
	}
	bindings, err := list(ctx, q, `SELECT to_jsonb(b) FROM "PanelClientBinding" b JOIN "Subscription" s ON s.id=b."subscriptionId" WHERE b."userId"=$1 AND s."teamId"=$2 AND b.status='active' AND b.source='direct' ORDER BY b."nodeId",b.id FOR UPDATE OF b`, userID, teamID)
	if err != nil {
		return 0, err
	}
	tag, err := q.Exec(ctx, `UPDATE "NodeSessionLease" l SET status='revoked',"revokedAt"=now(),"revokedReason"=$3,"updatedAt"=now() WHERE l."userId"=$1 AND l.status='active' AND EXISTS(SELECT 1 FROM "Subscription" s WHERE s.id=l."subscriptionId" AND s."teamId"=$2)`, userID, teamID, reason)
	if err != nil {
		return 0, err
	}
	for _, binding := range bindings {
		if _, err = update(ctx, q, "PanelClientBinding", text(binding, "id"), Object{"status": "disabled", "directDisabledAt": now(), "directDisableWatermarks": nil}, "status", "directDisabledAt", "directDisableWatermarks"); err != nil {
			return 0, err
		}
		if _, err = s.queueBinding(ctx, q, binding, "DISABLE_USER"); err != nil {
			return 0, err
		}
	}
	return tag.RowsAffected(), nil
}

func (s *Server) kickMember(w http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	if value, provided := input["disableAccount"]; provided && value != nil {
		if _, valid := value.(bool); !valid {
			return nil, fail(400, "disableAccount 必须是布尔值")
		}
	}
	disable := boolean(input, "disableAccount", false)
	ctx := r.Context()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if disable {
		if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(486912626)`); err != nil {
			return nil, err
		}
	}
	member, err := one(ctx, tx, `SELECT to_jsonb(m) FROM "TeamMember" m WHERE id=$1 AND "teamId"=$2`, r.PathValue("memberId"), r.PathValue("teamId"))
	if err != nil {
		return nil, err
	}
	userID, teamID := text(member, "userId"), text(member, "teamId")
	var disconnected int64
	var account Object
	if disable {
		account, err = one(ctx, tx, `SELECT to_jsonb(u) FROM "User" u WHERE id=$1 FOR NO KEY UPDATE`, userID)
		if err != nil {
			return nil, err
		}
		err = lockRuntimeSubscriptions(ctx, tx, "userId", userID)
	} else {
		err = lockTeamSubscriptions(ctx, tx, teamID)
	}
	if err != nil {
		return nil, err
	}
	// Keep the shared subscription -> binding -> node lock order; no team membership is removed.
	if _, err = one(ctx, tx, `SELECT to_jsonb(m) FROM "TeamMember" m WHERE id=$1 AND "teamId"=$2 AND "userId"=$3 FOR UPDATE`, member["id"], teamID, userID); err != nil {
		return nil, err
	}
	if disable {
		disconnected, err = s.disableUserAccount(ctx, tx, account)
	} else {
		disconnected, err = s.revokeTeamMemberLeases(ctx, tx, teamID, userID, "admin_disconnect")
	}
	if err != nil {
		return nil, err
	}
	var pending bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM "NodeCommandJob" j JOIN "Subscription" s ON s.id=j."subscriptionId" WHERE j."userId"=$1 AND j."commandType"='DISABLE_USER' AND j.status IN('pending','running') AND ($2 OR s."teamId"=$3))`, userID, disable, teamID).Scan(&pending); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	s.changed("teams", userID)
	if disable {
		s.changed("users", userID)
	}
	team, err := s.teamResult(r, teamID)
	if err != nil {
		return nil, err
	}
	var user any
	if disable {
		user, err = s.userResult(r, userID)
		if err != nil {
			return nil, err
		}
	}
	reason, message := "admin_paused_connection", "本团队连接已断开，成员仍保留在团队中。"
	if disable {
		reason, message = "account_disabled", "账号已禁用，本团队连接已断开，成员仍保留在团队中。"
	}
	status := "synced"
	if pending {
		status = "pending"
	}
	return Object{"ok": true, "action": "disconnect_session", "disconnectedSessionCount": disconnected, "accountDisabled": disable, "panelSyncStatus": status, "panelSyncMessage": nil, "message": message, "reasonCode": reason, "reasonMessage": message, "team": team, "user": user}, nil
}
