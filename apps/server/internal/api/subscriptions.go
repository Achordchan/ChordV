package api

import (
	"context"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const subscriptionListSQL = `SELECT to_jsonb(s)-'totalTrafficBytes'-'usedTrafficBytes'||jsonb_build_object('ownerType',CASE WHEN s."teamId" IS NULL THEN 'user' ELSE 'team' END,'userEmail',u.email,'userDisplayName',u."displayName",'teamName',t.name,'planName',p.name,'nodeCount',(SELECT count(*) FROM "SubscriptionNodeAccess" a WHERE a."subscriptionId"=s.id),'hasNodeAccess',EXISTS(SELECT 1 FROM "SubscriptionNodeAccess" a WHERE a."subscriptionId"=s.id),'state',CASE WHEN s.state IN('paused','expired','exhausted') THEN s.state::text WHEN s."expireAt"<=now() THEN 'expired' WHEN s."remainingTrafficGb"<=0 THEN 'exhausted' ELSE s.state::text END) FROM "Subscription" s JOIN "Plan" p ON p.id=s."planId" LEFT JOIN "User" u ON u.id=s."userId" LEFT JOIN "Team" t ON t.id=s."teamId"`
const bytesPerGB = 1073741824.0

func trafficBytes(gb float64) string { return strconv.FormatInt(int64(math.Round(gb*bytesPerGB)), 10) }
func resolveState(state string, total, used float64, expires time.Time) string {
	if state == "paused" || state == "expired" || state == "exhausted" {
		return state
	}
	if !expires.After(time.Now()) {
		return "expired"
	}
	if total-used <= 0 {
		return "exhausted"
	}
	return "active"
}
func (s *Server) subscriptions(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	return list(r.Context(), s.DB, subscriptionListSQL+` ORDER BY s."expireAt" DESC`)
}
func (s *Server) subscriptionResult(r *http.Request, id string) (Object, error) {
	return one(r.Context(), s.DB, subscriptionListSQL+` WHERE s.id=$1`, id)
}
func (s *Server) createSubscription(w http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	if err = normalizeSubscriptionTraffic(input); err != nil {
		return nil, err
	}
	if err = requireText(input, "planId", "expireAt"); err != nil {
		return nil, err
	}
	expires, err := time.Parse(time.RFC3339, text(input, "expireAt"))
	if err != nil {
		return nil, fail(400, "到期时间无效")
	}
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(r.Context())
	teamID := r.PathValue("teamId")
	ownerID := text(input, "userId")
	scope := "personal"
	ownerColumn := "userId"
	if teamID != "" {
		scope = "team"
		ownerID = teamID
		ownerColumn = "teamId"
	}
	if ownerID == "" {
		return nil, fail(400, "订阅归属不能为空")
	}
	if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, scope+":"+ownerID); err != nil {
		return nil, err
	}
	var available bool
	if scope == "personal" {
		err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM "User" u WHERE u.id=$1 AND u.status='active' AND NOT EXISTS(SELECT 1 FROM "TeamMember" m WHERE m."userId"=u.id))`, ownerID).Scan(&available)
	} else {
		err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM "Team" WHERE id=$1 AND status='active')`, ownerID).Scan(&available)
	}
	if err != nil {
		return nil, err
	}
	if !available {
		return nil, fail(400, "归属账号或团队不可用；团队成员不能创建个人订阅")
	}
	if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM "Subscription" WHERE `+quote(ownerColumn)+`=$1 AND state='active' AND "expireAt">now() AND "remainingTrafficGb">0)`, ownerID).Scan(&available); err != nil {
		return nil, err
	}
	if available {
		return nil, fail(409, "已有有效订阅，请使用续期或变更套餐")
	}
	plan, err := one(r.Context(), tx, `SELECT to_jsonb(p) FROM "Plan" p WHERE id=$1 AND "isActive" AND scope::text=$2`, input["planId"], scope)
	if err != nil {
		return nil, err
	}
	total := number(plan, "totalTrafficGb")
	if _, ok := input["totalTrafficGb"]; ok {
		total = number(input, "totalTrafficGb")
	}
	used := number(input, "usedTrafficGb")
	if !validSubscriptionTraffic(total) || !validSubscriptionTraffic(used) {
		return nil, fail(400, "流量值无效")
	}
	data := Object{ownerColumn: ownerID, "planId": plan["id"], "totalTrafficGb": total, "usedTrafficGb": used, "remainingTrafficGb": math.Max(0, total-used), "totalTrafficBytes": trafficBytes(total), "usedTrafficBytes": trafficBytes(used), "expireAt": expires.Format(time.RFC3339Nano), "state": resolveState(text(input, "state"), total, used, expires), "renewable": plan["renewable"], "sourceAction": "created", "lastSyncedAt": now()}
	result, err := insert(r.Context(), tx, "Subscription", data)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	s.scheduleEntity("subscription", text(result, "id"), expires)
	s.changed("subscriptions", "")
	return s.subscriptionResult(r, text(result, "id"))
}
func (s *Server) updateSubscription(w http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	if strings.HasSuffix(r.URL.Path, "/renew") {
		input = pick(input, "expireAt", "resetTraffic", "totalTrafficGb")
	} else if strings.HasSuffix(r.URL.Path, "/change-plan") {
		input = pick(input, "planId", "totalTrafficGb", "expireAt")
	}
	if err = normalizeSubscriptionTraffic(input); err != nil {
		return nil, err
	}
	if err = enum(input, "state", "active", "expired", "exhausted", "paused"); err != nil {
		return nil, err
	}
	id := r.PathValue("subscriptionId")
	if strings.HasSuffix(r.URL.Path, "/renew") && boolean(input, "resetTraffic", false) {
		result, err := s.performTrafficReset(w, r, nil, input, true)
		if err != nil {
			return nil, err
		}
		return result.(Object)["subscription"], nil
	}
	if err = s.assertNoTrafficReset(r.Context(), s.DB, id); err != nil {
		return nil, err
	}
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(r.Context())
	if err = lockConcurrencyScope(r.Context(), tx, "subscription", id); err != nil {
		return nil, err
	}
	old, err := readLockedRuntimeSubscription(r.Context(), tx, id)
	if err != nil {
		return nil, err
	}
	if err = s.assertNoTrafficReset(r.Context(), tx, id); err != nil {
		return nil, err
	}
	data := pick(input, "totalTrafficGb", "usedTrafficGb", "expireAt", "state")
	action := "adjusted"
	if strings.HasSuffix(r.URL.Path, "/renew") {
		action = "renewed"
		data["state"] = "active"
	}
	if strings.HasSuffix(r.URL.Path, "/change-plan") {
		plan, err := one(r.Context(), tx, `SELECT to_jsonb(p) FROM "Plan" p WHERE id=$1 AND "isActive"`, text(input, "planId"))
		if err != nil {
			return nil, err
		}
		expected := "personal"
		if old["teamId"] != nil {
			expected = "team"
		}
		if plan["scope"] != expected {
			return nil, fail(400, "套餐类型与订阅归属不一致")
		}
		data["planId"] = plan["id"]
		data["renewable"] = plan["renewable"]
		if _, ok := input["totalTrafficGb"]; !ok {
			data["totalTrafficGb"] = plan["totalTrafficGb"]
		}
		action = "plan_changed"
		data["state"] = "active"
	}
	merged := Object{}
	for key, value := range old {
		merged[key] = value
	}
	for key, value := range data {
		merged[key] = value
	}
	total := number(merged, "totalTrafficGb")
	used := number(merged, "usedTrafficGb")
	if !validSubscriptionTraffic(total) || !validSubscriptionTraffic(used) {
		return nil, fail(400, "流量值无效")
	}
	expires, err := time.Parse(time.RFC3339, text(merged, "expireAt"))
	if err != nil {
		return nil, fail(400, "到期时间无效")
	}
	data["state"] = resolveState(text(merged, "state"), total, used, expires)
	data["remainingTrafficGb"] = math.Max(0, total-used)
	data["totalTrafficBytes"] = trafficBytes(total)
	data["usedTrafficBytes"] = trafficBytes(used)
	data["sourceAction"] = action
	data["lastSyncedAt"] = now()
	if _, err = update(r.Context(), tx, "Subscription", id, data, "planId", "renewable", "totalTrafficGb", "usedTrafficGb", "remainingTrafficGb", "totalTrafficBytes", "usedTrafficBytes", "expireAt", "state", "sourceAction", "lastSyncedAt"); err != nil {
		return nil, err
	}
	if err = s.reconcileSubscriptionConcurrency(r.Context(), tx, id); err != nil {
		return nil, err
	}
	if err = s.syncSubscriptionBindings(r.Context(), tx, id); err != nil {
		return nil, err
	}
	if data["state"] != "active" {
		if _, err = s.revokeLeases(r.Context(), tx, "subscriptionId", id, "subscription_"+text(data, "state")); err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	s.scheduleEntity("subscription", id, expires)
	s.changed("subscriptions", "")
	return s.subscriptionResult(r, id)
}
func (s *Server) subscriptionNodes(w http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	id := r.PathValue("subscriptionId")
	if r.Method == "PUT" {
		input, err := body(w, r)
		if err != nil {
			return nil, err
		}
		ids, err := stringArray(input["nodeIds"], 100)
		if err != nil {
			return nil, err
		}
		tx, err := s.DB.Begin(r.Context())
		if err != nil {
			return nil, err
		}
		defer tx.Rollback(r.Context())
		if _, err = one(r.Context(), tx, `SELECT to_jsonb(s) FROM "Subscription" s WHERE id=$1 FOR UPDATE`, id); err != nil {
			return nil, err
		}
		var count int
		if err = tx.QueryRow(r.Context(), `SELECT count(*) FROM "Node" WHERE id=ANY($1::text[])`, ids).Scan(&count); err != nil {
			return nil, err
		}
		if count != len(ids) {
			return nil, fail(400, "部分节点不存在")
		}
		if err = lockRuntimeBindingsAndNodes(r.Context(), tx, []string{id}, ids...); err != nil {
			return nil, err
		}
		if _, err = tx.Exec(r.Context(), `DELETE FROM "SubscriptionNodeAccess" WHERE "subscriptionId"=$1 AND NOT("nodeId"=ANY($2::text[]))`, id, ids); err != nil {
			return nil, err
		}
		for _, nodeID := range ids {
			if _, err = tx.Exec(r.Context(), `INSERT INTO "SubscriptionNodeAccess"(id,"subscriptionId","nodeId","updatedAt") VALUES($1,$2,$3,now()) ON CONFLICT("subscriptionId","nodeId") DO NOTHING`, newID(), id, nodeID); err != nil {
				return nil, err
			}
		}
		if _, err = tx.Exec(r.Context(), `UPDATE "NodeSessionLease" SET status='revoked',"revokedAt"=now(),"revokedReason"='node_access_revoked',"updatedAt"=now() WHERE "subscriptionId"=$1 AND status='active' AND NOT("nodeId"=ANY($2::text[]))`, id, ids); err != nil {
			return nil, err
		}
		if err = s.syncSubscriptionBindings(r.Context(), tx, id); err != nil {
			return nil, err
		}
		if err = tx.Commit(r.Context()); err != nil {
			return nil, err
		}
		s.changed("subscriptions", "")
	}
	nodes, err := list(r.Context(), s.DB, `SELECT to_jsonb(n)-'uuid' FROM "Node" n JOIN "SubscriptionNodeAccess" a ON a."nodeId"=n.id WHERE a."subscriptionId"=$1 ORDER BY n.name`, id)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for _, node := range nodes {
		ids = append(ids, text(node, "id"))
	}
	return Object{"subscriptionId": id, "nodeIds": ids, "nodes": nodes}, nil
}
func (s *Server) syncSubscriptionBindings(ctx context.Context, q queryer, id string, onlyBinding ...string) error {
	filter := ""
	if len(onlyBinding) > 0 {
		filter = onlyBinding[0]
	}
	var resetting bool
	if err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM "SystemSetting" WHERE key=$1)`, trafficResetKey(id)).Scan(&resetting); err != nil {
		return err
	}
	if resetting {
		return nil
	}
	bindings, err := list(ctx, q, `SELECT to_jsonb(b) FROM "PanelClientBinding" b WHERE b."subscriptionId"=$1 AND b.source='direct' AND ($2='' OR (b.id=$2 AND `+pendingBindingSQL+`)) ORDER BY b."nodeId",b.id FOR UPDATE`, id, filter)
	if err != nil {
		return err
	}
	for _, binding := range bindings {
		var usable bool
		err = q.QueryRow(ctx, `SELECT `+bindingUsableSQL+` FROM "PanelClientBinding" b WHERE b.id=$1`, binding["id"]).Scan(&usable)
		if err != nil {
			return err
		}
		deleted := binding["status"] == "deleted"
		if deleted && !usable {
			continue
		}
		if usable && binding["status"] != "active" {
			if err := assertTerminalSettled(ctx, q, binding); err == errResetSettling {
				if deleted {
					continue // The deleted row itself survives restart; no marker needed.
				}
				if _, err = q.Exec(ctx, `INSERT INTO "SystemSetting"(key,value,"updatedAt") VALUES($1,'{}',now()) ON CONFLICT(key) DO NOTHING`, "binding-resume:"+text(binding, "id")); err != nil {
					return err
				}
				continue
			} else if err != nil {
				return err
			}
		}
		if _, err = q.Exec(ctx, `DELETE FROM "SystemSetting" WHERE key=$1`, "binding-resume:"+text(binding, "id")); err != nil {
			return err
		}
		command := "DISABLE_USER"
		status := "disabled"
		if usable {
			command = "ENSURE_USER"
			status = "active"
		}
		if deleted {
			binding, err = restoreDeletedBinding(ctx, q, binding)
		} else {
			_, err = update(ctx, q, "PanelClientBinding", text(binding, "id"), Object{"status": status}, "status")
		}
		if err != nil {
			return err
		}
		if !usable && binding["status"] != "active" {
			continue
		}
		if _, err = s.queueBinding(ctx, q, binding, command); err != nil {
			return err
		}
	}
	if filter != "" {
		return nil
	}
	return s.provisionMissingBindings(ctx, q, id)
}
