package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *Server) queueBinding(ctx context.Context, q queryer, binding Object, command string) (Object, error) {
	if command == "DISABLE_USER" || command == "REMOVE_USER" {
		if _, err := q.Exec(ctx, `DELETE FROM "SystemSetting" WHERE key=$1`, "binding-resume:"+text(binding, "id")); err != nil {
			return nil, err
		}
	}
	if command == "ENSURE_USER" || command == "ENABLE_USER" {
		if err := s.ensureBindingBaseline(ctx, q, binding); err != nil {
			return nil, err
		}
	}
	node, err := one(ctx, q, `SELECT to_jsonb(n)||jsonb_build_object('agentConfigRevision',n."agentConfigRevision"::text) FROM "Node" n WHERE id=$1 FOR UPDATE`, binding["nodeId"])
	if err != nil {
		return nil, err
	}
	if err = s.supersedeBindingCommands(ctx, q, binding, command); err != nil {
		return nil, err
	}
	var revision string
	if err = q.QueryRow(ctx, `UPDATE "Node" SET "agentConfigRevision"="agentConfigRevision"+1,"updatedAt"=now() WHERE id=$1 RETURNING "agentConfigRevision"::text`, binding["nodeId"]).Scan(&revision); err != nil {
		return nil, err
	}
	quota, err := one(ctx, q, `SELECT jsonb_build_object('remaining',greatest(0,"totalTrafficBytes"-"usedTrafficBytes")::text,'expiresAt',"expireAt") FROM "Subscription" WHERE id=$1`, binding["subscriptionId"])
	if err != nil {
		return nil, err
	}
	payload := Object{"bindingId": binding["id"], "userKey": binding["panelClientEmail"], "email": binding["panelClientEmail"], "uuid": binding["panelClientId"], "flow": node["flow"], "expiresAt": quota["expiresAt"], "quotaRemainingBytes": quota["remaining"], "offlineAllowanceBytes": "67108864"}
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	jobID := newID()
	dedupe := fmt.Sprintf("%v:%s:%s", binding["id"], command, revision)
	job, err := one(ctx, q, `WITH inserted AS(INSERT INTO "NodeCommandJob"(id,"dedupeKey","nodeId","agentId","commandType","targetRevision",payload,"bindingId","subscriptionId","userId","teamId","updatedAt") VALUES($1,$2,$3,(SELECT id FROM "NodeAgent" WHERE "nodeId"=$3 AND "revokedAt" IS NULL ORDER BY "createdAt" DESC LIMIT 1),$4::"NodeAgentCommandType",$5::bigint,$6::jsonb,$7,$8,$9,$10,now()) RETURNING *) SELECT to_jsonb(inserted)||jsonb_build_object('targetRevision',"targetRevision"::text) FROM inserted`, jobID, dedupe, binding["nodeId"], command, revision, raw, binding["id"], binding["subscriptionId"], binding["userId"], binding["teamId"])
	if err != nil {
		return nil, err
	}
	if _, err = q.Exec(ctx, `UPDATE "PanelClientBinding" SET "directRevision"=$2::bigint,"updatedAt"=now() WHERE id=$1`, binding["id"], revision); err != nil {
		return nil, err
	}
	if err = notifyCommands(ctx, q, text(binding, "nodeId")); err != nil {
		return nil, err
	}
	return job, nil
}
func (s *Server) revokeLeases(ctx context.Context, q queryer, column, id, reason string) (int64, error) {
	if column != "userId" && column != "subscriptionId" && column != "nodeId" {
		return 0, fail(400, "撤销条件无效")
	}
	if err := lockRuntimeScope(ctx, q, column, id); err != nil {
		return 0, err
	}
	tag, err := q.Exec(ctx, `UPDATE "NodeSessionLease" SET status='revoked',"revokedAt"=now(),"revokedReason"=$2,"updatedAt"=now() WHERE `+quote(column)+`=$1 AND status='active'`, id, reason)
	if err != nil {
		return 0, err
	}
	bindings, err := list(ctx, q, `SELECT to_jsonb(b) FROM "PanelClientBinding" b WHERE `+quote(column)+`=$1 AND status='active' AND source='direct' ORDER BY "nodeId",id FOR UPDATE`, id)
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
func (s *Server) connect(w http.ResponseWriter, r *http.Request, user Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	channel, unsubscribe := s.events.subscribe(text(user, "id"))
	defer unsubscribe()
	return s.connectAttempt(w, r, user, input, channel, true)
}
func (s *Server) connectAttempt(w http.ResponseWriter, r *http.Request, user, input Object, channel <-chan Object, allowWait bool) (any, error) {
	var err error
	if err = requireText(input, "nodeId", "mode"); err != nil {
		return nil, err
	}
	if err = enum(input, "mode", "rule", "global", "direct"); err != nil {
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
	if err = lockConcurrencyScope(r.Context(), tx, "user", text(user, "id")); err != nil {
		return nil, err
	}
	currentUser, err := s.authenticateQuery(r, tx)
	if err != nil {
		return nil, err
	}
	user = currentUser
	sub, err := s.resolveSubscription(r.Context(), tx, text(user, "id"))
	if err != nil {
		return nil, err
	}
	if err = requireFrozenRuntimeSubscriptions(r.Context(), tx, []string{text(sub, "id")}); err != nil {
		return nil, err
	}
	sub, err = s.resolveSubscription(r.Context(), tx, text(user, "id"))
	if err != nil {
		return nil, err
	}
	if err = requireFrozenRuntimeSubscriptions(r.Context(), tx, []string{text(sub, "id")}); err != nil {
		return nil, err
	}
	if err = s.assertNoTrafficReset(r.Context(), tx, text(sub, "id")); err != nil {
		return nil, err
	}
	if sub["state"] != "active" {
		return nil, fail(409, "当前订阅不可用")
	}
	node, err := one(r.Context(), tx, `SELECT to_jsonb(n) FROM "Node" n JOIN "SubscriptionNodeAccess" a ON a."nodeId"=n.id WHERE n.id=$1 AND a."subscriptionId"=$2 AND n."isActive" AND `+bindingNodeReadySQL, input["nodeId"], sub["id"])
	if err != nil {
		return nil, err
	}
	if !nodeHostAllowed(text(node, "serverHost"), s.Config.Production()) {
		return nil, fail(403, "本地调试不建立线上节点会话，请使用本地测试节点")
	}
	policy, err := s.policy(w, r, user)
	if err != nil {
		return nil, err
	}
	modes := policy.(Object)["modes"].([]any)
	allowed := false
	for _, mode := range modes {
		allowed = allowed || mode == input["mode"]
	}
	if !allowed {
		return nil, fail(400, "该连接模式未启用")
	}
	binding, err := one(r.Context(), tx, `SELECT to_jsonb(b) FROM "PanelClientBinding" b WHERE "subscriptionId"=$1 AND "userId"=$2 AND "nodeId"=$3 FOR UPDATE`, sub["id"], user["id"], node["id"])
	if err == pgx.ErrNoRows {
		binding, err = insert(r.Context(), tx, "PanelClientBinding", Object{"subscriptionId": sub["id"], "userId": user["id"], "teamId": sub["teamId"], "nodeId": node["id"], "panelClientEmail": "chordv_" + newID(), "panelClientId": newID(), "panelInboundId": 0, "source": "direct", "status": "active"})
	}
	if err != nil {
		return nil, err
	}
	node, err = one(r.Context(), tx, `SELECT to_jsonb(n) FROM "Node" n WHERE id=$1 AND "isActive" FOR UPDATE`, node["id"])
	if err != nil {
		return nil, err
	}
	if binding["status"] == "disabled" || binding["status"] == "deleted" {
		if err := assertTerminalSettled(r.Context(), tx, binding); err != nil {
			if err != errResetSettling {
				return nil, err
			}
			if err = tx.Commit(r.Context()); err != nil {
				return nil, err
			}
			if err = s.waitBindingSettled(r.Context(), text(binding, "id"), channel); err != nil {
				return nil, err
			}
			currentUser, err := s.authenticate(r)
			if err != nil {
				return nil, err
			}
			return s.connectAttempt(w, r, currentUser, input, channel, allowWait)
		}
	}
	var installed bool
	err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM "NodeCommandJob" WHERE "bindingId"=$1 AND "commandType" IN('ENSURE_USER','ENABLE_USER') AND status='completed' AND "targetRevision"=(SELECT max("targetRevision") FROM "NodeCommandJob" WHERE "bindingId"=$1 AND "commandType" IN('ENSURE_USER','ENABLE_USER')))`, binding["id"]).Scan(&installed)
	if err != nil {
		return nil, err
	}
	if binding["status"] != "active" {
		installed = false
	}
	if !installed {
		var outstanding bool
		deleted := binding["status"] == "deleted"
		if !deleted {
			if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM "NodeCommandJob" WHERE "bindingId"=$1 AND "commandType"='ENSURE_USER' AND status IN('pending','running','failed'))`, binding["id"]).Scan(&outstanding); err != nil {
				return nil, err
			}
		}
		if !outstanding {
			if deleted {
				binding, err = restoreDeletedBinding(r.Context(), tx, binding)
			} else {
				_, err = update(r.Context(), tx, "PanelClientBinding", text(binding, "id"), Object{"status": "active", "directDisabledAt": nil}, "status", "directDisabledAt")
			}
			if err != nil {
				return nil, err
			}
			if _, err = s.queueBinding(r.Context(), tx, binding, "ENSURE_USER"); err != nil {
				return nil, err
			}
		}
		if err = tx.Commit(r.Context()); err != nil {
			return nil, err
		}
		s.events.publish("agent:"+text(node, "id"), Object{"type": "config_updated", "occurredAt": now()})
		if !allowWait {
			return nil, fail(409, "节点账号状态发生变化，请重新连接")
		}
		if err = s.waitBindingInstalled(r.Context(), text(binding, "id"), channel); err != nil {
			return nil, err
		}
		currentUser, err := s.authenticate(r)
		if err != nil {
			return nil, err
		}
		return s.connectAttempt(w, r, currentUser, input, channel, false)
	}

	limit, err := effectiveUserConcurrentLimit(r.Context(), tx, text(user, "id"), time.Now())
	if err != nil {
		return nil, err
	}
	evicted, err := s.evictExcessUserLeases(r.Context(), tx, text(user, "id"), limit, 1)
	if err != nil {
		return nil, err
	}
	timing, err := s.Config.SessionLeaseTiming()
	if err != nil {
		return nil, err
	}
	expires := time.Now().UTC().Add(timing.TTL())

	lease, err := insert(r.Context(), tx, "NodeSessionLease", Object{"sessionId": "session_" + newID(), "userId": user["id"], "subscriptionId": sub["id"], "nodeId": node["id"], "xrayUserEmail": binding["panelClientEmail"], "xrayUserUuid": binding["panelClientId"], "status": "active", "issuedAt": now(), "expiresAt": expires.Format(time.RFC3339Nano), "lastHeartbeatAt": now(), "connectionMode": input["mode"]})
	if err != nil {
		return nil, err
	}
	for _, old := range evicted {
		if err = s.disableUnusedLeaseBinding(r.Context(), tx, old); err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	if err = s.scheduleLease(text(lease, "id"), expires); err != nil {
		return nil, err
	}
	s.presenceUpdated()
	s.changed("users", text(user, "id"))
	return s.runtimeConfig(r.Context(), lease, node, policy.(Object))
}
func (s *Server) runtimeConfig(ctx context.Context, lease, node, policy Object) (Object, error) {
	timing, err := s.Config.SessionLeaseTiming()
	if err != nil {
		return nil, err
	}
	rules, err := list(ctx, s.DB, `SELECT to_jsonb(r) FROM "ClientRoutingRule" r WHERE "userId"=$1 AND enabled ORDER BY "updatedAt" DESC`, lease["userId"])
	if err != nil {
		return nil, err
	}
	return Object{"sessionId": lease["sessionId"], "leaseId": lease["id"], "leaseExpiresAt": lease["expiresAt"], "leaseHeartbeatIntervalSeconds": timing.HeartbeatIntervalSeconds, "leaseGraceSeconds": timing.GraceSeconds, "node": pick(node, "id", "name", "countryCode", "region", "provider", "tags", "recommended", "latencyMs", "protocol", "security", "serverHost", "serverPort"), "mode": lease["connectionMode"], "localHttpPort": 17890, "localSocksPort": 17891, "routingProfile": "managed-rule-default", "generatedAt": now(), "features": policy["features"], "customRoutingRules": rules, "outbound": Object{"protocol": "vless", "server": node["serverHost"], "port": node["serverPort"], "uuid": lease["xrayUserUuid"], "flow": node["flow"], "realityPublicKey": node["realityPublicKey"], "shortId": node["shortId"], "serverName": node["serverName"], "fingerprint": node["fingerprint"], "spiderX": node["spiderX"], "mldsa65Verify": node["mldsa65Verify"]}}, nil
}
func (s *Server) runtime(w http.ResponseWriter, r *http.Request, user Object) (any, error) {
	cutoff, err := s.leaseCutoff(time.Now())
	if err != nil {
		return nil, err
	}
	lease, err := one(r.Context(), s.DB, `SELECT to_jsonb(l) FROM "NodeSessionLease" l WHERE "userId"=$1 AND status='active' AND "expiresAt">$3 AND ($2='' OR "sessionId"=$2) ORDER BY "issuedAt" DESC LIMIT 1`, user["id"], r.URL.Query().Get("sessionId"), cutoff)
	if err == pgx.ErrNoRows {
		return json.RawMessage("null"), nil
	}
	if err != nil {
		return nil, err
	}
	node, err := one(r.Context(), s.DB, `SELECT to_jsonb(n) FROM "Node" n WHERE id=$1`, lease["nodeId"])
	if err != nil {
		return nil, err
	}
	policy, err := s.policy(w, r, user)
	if err != nil {
		return nil, err
	}
	return s.runtimeConfig(r.Context(), lease, node, policy.(Object))
}
func (s *Server) heartbeat(w http.ResponseWriter, r *http.Request, user Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(r.Context())
	if err = lockLeaseSubscription(r.Context(), tx, text(input, "sessionId"), text(user, "id")); err != nil {
		return nil, err
	}
	lease, err := one(r.Context(), tx, `SELECT to_jsonb(l) FROM "NodeSessionLease" l WHERE "sessionId"=$1 AND "userId"=$2 FOR UPDATE`, text(input, "sessionId"), user["id"])
	if err != nil {
		return nil, err
	}

	timing, err := s.Config.SessionLeaseTiming()
	if err != nil {
		return nil, err
	}
	expires, err := parseTimestamp(text(lease, "expiresAt"))
	if err != nil {
		return nil, err
	}
	if lease["status"] != "active" || !leaseValidAt(expires, time.Now(), timing) {
		changed := false
		if lease["status"] == "active" {
			lease, changed, err = transitionLease(r.Context(), tx, lease, "expired", "session_expired")
			if err != nil {
				return nil, err
			}
			if changed {
				if err = s.disableUnusedLeaseBinding(r.Context(), tx, lease); err != nil {
					return nil, err
				}
			}
		}
		if err = tx.Commit(r.Context()); err != nil {
			return nil, err
		}
		if changed {
			s.publishLeaseRevocation(lease, leaseTerminalReason(lease))
		}
		return leaseHeartbeatResult(lease), nil
	}

	sub, err := s.resolveSubscription(r.Context(), tx, text(user, "id"))
	if err != nil {
		return nil, err
	}
	if sub["id"] != lease["subscriptionId"] || sub["state"] != "active" {
		return nil, fail(409, "订阅状态已变化，请重新连接")
	}
	next := time.Now().UTC().Add(timing.TTL())
	if _, err = update(r.Context(), tx, "NodeSessionLease", text(lease, "id"), Object{"expiresAt": next.Format(time.RFC3339Nano), "lastHeartbeatAt": now()}, "expiresAt", "lastHeartbeatAt"); err != nil {
		return nil, err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	if err = s.scheduleLease(text(lease, "id"), next); err != nil {
		return nil, err
	}
	return Object{"sessionId": lease["sessionId"], "status": "active", "leaseExpiresAt": next.Format(time.RFC3339Nano)}, nil
}
