package api

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

var errResetSettling = errors.New("traffic reset awaiting final metering")

func trafficResetKey(id string) string { return "traffic-reset:" + id }
func (s *Server) assertNoTrafficReset(ctx context.Context, q queryer, id string) error {
	var active bool
	if err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM "SystemSetting" WHERE key=$1)`, trafficResetKey(id)).Scan(&active); err != nil {
		return err
	}
	if active {
		return fail(409, "流量重置正在停用并结算节点账号，请等待结算完成")
	}
	return nil
}
func (s *Server) resetTraffic(w http.ResponseWriter, r *http.Request, u Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	return s.performTrafficReset(w, r, u, pick(input, "userId"), false)
}
func (s *Server) performTrafficReset(w http.ResponseWriter, r *http.Request, _ Object, input Object, renewal bool) (any, error) {
	id := r.PathValue("subscriptionId")
	channel, unsubscribe := s.events.subscribe(trafficResetKey(id))
	defer unsubscribe()
	target, err := s.beginTrafficReset(r.Context(), id, input, renewal)
	if err != nil {
		return nil, err
	}
	s.events.publish("", Object{"type": "sync_queue_updated", "occurredAt": now()})
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	for {
		result, err := s.finishTrafficReset(ctx, id, target, input, renewal)
		if err == nil {
			s.changed("subscriptions", "")
			subscription, err := s.subscriptionResult(r, id)
			if err != nil {
				return nil, err
			}
			var user any
			if target != "" {
				user, err = s.userResult(r, target)
				if err != nil {
					return nil, err
				}
			}
			return Object{"ok": true, "subscriptionId": id, "userId": nullableString(target), "clearedBindingCount": result, "subscription": subscription, "user": user, "panelSyncStatus": func() string {
				if result > 0 {
					return "pending"
				}
				return "synced"
			}(), "message": "流量已按节点最终结算边界重置。"}, nil
		}
		if !errors.Is(err, errResetSettling) {
			return nil, err
		}
		select {
		case <-ctx.Done():
			if err = s.detachTrafficReset(id); err != nil {
				return nil, err
			}
			return nil, fail(409, "节点账号已停用，最终流量尚未结清；结算完成后会自动继续本次操作，不会提前清零")
		case <-s.resyncStop:
			return nil, fail(503, "本地服务正在退出，重置状态已保存")
		case <-channel:
		}
	}
}
func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}
func (s *Server) beginTrafficReset(ctx context.Context, id string, input Object, renewal bool) (string, error) {
	if err := normalizeSubscriptionTraffic(input); err != nil {
		return "", err
	}
	if expiry := text(input, "expireAt"); expiry != "" {
		if _, e := time.Parse(time.RFC3339, expiry); e != nil {
			return "", fail(400, "到期时间无效")
		}
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	if err = lockRuntimeScope(ctx, tx, "subscriptionId", id); err != nil {
		return "", err
	}
	sub, err := readLockedRuntimeSubscription(ctx, tx, id)
	if err != nil {
		return "", err
	}
	target := text(input, "userId")
	if sub["teamId"] != nil {
		if target == "" && !renewal {
			return "", fail(400, "团队订阅重置流量时必须指定成员账号")
		}
		if target != "" {
			var member bool
			if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM "TeamMember" WHERE "teamId"=$1 AND "userId"=$2)`, sub["teamId"], target).Scan(&member); err != nil {
				return "", err
			}
			if !member {
				return "", fail(400, "指定账号不属于当前团队")
			}
		}
	} else {
		if target != "" && target != sub["userId"] {
			return "", fail(400, "个人订阅不能重置其他用户流量")
		}
		target = text(sub, "userId")
	}
	marker, err := one(ctx, tx, `SELECT value FROM "SystemSetting" WHERE key=$1 FOR UPDATE`, trafficResetKey(id))
	if err == nil {
		expectedJSON, _ := json.Marshal(pick(input, "userId", "expireAt", "totalTrafficGb", "resetTraffic"))
		if text(marker, "requestHash") != tokenHash(string(expectedJSON)) || text(marker, "userId") != target || boolean(marker, "renewal", false) != renewal {
			return "", fail(409, "该订阅已有其他流量重置在进行")
		}
		return target, tx.Commit(ctx)
	}
	if err != pgx.ErrNoRows {
		return "", err
	}
	requestJSON, _ := json.Marshal(pick(input, "userId", "expireAt", "totalTrafficGb", "resetTraffic"))
	raw, _ := json.Marshal(Object{"userId": target, "renewal": renewal, "requestedAt": now(), "requestHash": tokenHash(string(requestJSON)), "request": pick(input, "userId", "expireAt", "totalTrafficGb", "resetTraffic")})
	if _, err = tx.Exec(ctx, `INSERT INTO "SystemSetting"(key,value,"updatedAt") VALUES($1,$2::jsonb,now())`, trafficResetKey(id), raw); err != nil {
		return "", err
	}
	bindings, err := list(ctx, tx, `SELECT to_jsonb(b) FROM "PanelClientBinding" b WHERE "subscriptionId"=$1 AND ($2='' OR "userId"=$2) AND status='active' AND source='direct' ORDER BY "nodeId",id FOR UPDATE`, id, target)
	if err != nil {
		return "", err
	}
	for _, binding := range bindings {
		if _, err = update(ctx, tx, "PanelClientBinding", text(binding, "id"), Object{"status": "disabled", "directDisabledAt": now(), "directDisableWatermarks": nil}, "status", "directDisabledAt", "directDisableWatermarks"); err != nil {
			return "", err
		}
		if _, err = s.queueBinding(ctx, tx, binding, "DISABLE_USER"); err != nil {
			return "", err
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE "NodeSessionLease" SET status='revoked',"revokedAt"=now(),"revokedReason"='runtime_credentials_rotated',"updatedAt"=now() WHERE "subscriptionId"=$1 AND ($2='' OR "userId"=$2) AND status='active'`, id, target); err != nil {
		return "", err
	}
	if err = tx.Commit(ctx); err != nil {
		return "", err
	}
	s.publishRecentRevocations("")
	return target, nil
}
func (s *Server) finishTrafficReset(ctx context.Context, id, target string, input Object, renewal bool) (int, error) {
	if err := normalizeSubscriptionTraffic(input); err != nil {
		return 0, err
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	if err = lockRuntimeScope(ctx, tx, "subscriptionId", id); err != nil {
		return 0, err
	}
	sub, err := readLockedRuntimeSubscription(ctx, tx, id)
	if err != nil {
		return 0, err
	}
	marker, err := one(ctx, tx, `SELECT value FROM "SystemSetting" WHERE key=$1 FOR UPDATE`, trafficResetKey(id))
	if err != nil {
		return 0, err
	}
	if text(marker, "userId") != target {
		return 0, fail(409, "流量重置归属已变化")
	}
	bindings, err := list(ctx, tx, `SELECT to_jsonb(b)||jsonb_build_object('lastUplinkBytes',"lastUplinkBytes"::text,'lastDownlinkBytes',"lastDownlinkBytes"::text) FROM "PanelClientBinding" b WHERE "subscriptionId"=$1 AND ($2='' OR "userId"=$2) AND status IN('active','disabled') AND source='direct' ORDER BY "nodeId",id FOR UPDATE`, id, target)
	if err != nil {
		return 0, err
	}
	for _, binding := range bindings {
		if binding["status"] != "disabled" {
			return 0, errResetSettling
		}
		if err = assertTerminalSettled(ctx, tx, binding); err != nil {
			return 0, err
		}
	}
	if sub["teamId"] != nil {
		if _, err = tx.Exec(ctx, `DELETE FROM "TrafficLedger" WHERE "subscriptionId"=$1 AND ($2='' OR "userId"=$2)`, id, target); err != nil {
			return 0, err
		}
	}
	var usedBytes int64
	if sub["teamId"] != nil && target != "" {
		if err = tx.QueryRow(ctx, `SELECT coalesce(round(sum(`+ledgerTrafficBytesSQL+`)),0)::bigint FROM "TrafficLedger" l WHERE "subscriptionId"=$1`, id).Scan(&usedBytes); err != nil {
			return 0, err
		}
	}
	total := number(sub, "totalTrafficGb")
	if renewal {
		if _, ok := input["totalTrafficGb"]; ok {
			total = number(input, "totalTrafficGb")
		}
	}
	if !validSubscriptionTraffic(total) {
		return 0, fail(400, "流量值无效")
	}
	expires, err := parseTimestamp(text(sub, "expireAt"))
	if err != nil {
		return 0, err
	}
	if renewal && text(input, "expireAt") != "" {
		expires, err = time.Parse(time.RFC3339, text(input, "expireAt"))
		if err != nil {
			return 0, fail(400, "到期时间无效")
		}
	}
	state := "active"
	if !renewal && sub["state"] == "paused" {
		state = "paused"
	}
	data := Object{"totalTrafficGb": total, "totalTrafficBytes": trafficBytes(total), "usedTrafficBytes": strconv.FormatInt(usedBytes, 10), "usedTrafficGb": float64(usedBytes) / bytesPerGB, "remainingTrafficGb": math.Max(0, total-float64(usedBytes)/bytesPerGB), "expireAt": expires.UTC().Format(time.RFC3339Nano), "state": resolveState(state, total, float64(usedBytes)/bytesPerGB, expires), "lastSyncedAt": now()}
	if renewal {
		data["sourceAction"] = "renewed"
	}
	if _, err = update(ctx, tx, "Subscription", id, data, "totalTrafficGb", "totalTrafficBytes", "usedTrafficBytes", "usedTrafficGb", "remainingTrafficGb", "expireAt", "state", "sourceAction", "lastSyncedAt"); err != nil {
		return 0, err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM "SystemSetting" WHERE key=$1`, trafficResetKey(id)); err != nil {
		return 0, err
	}
	if err = s.syncSubscriptionBindings(ctx, tx, id); err != nil {
		return 0, err
	}
	if err = tx.Commit(ctx); err != nil {
		return 0, err
	}
	s.scheduleEntity("subscription", id, expires)
	return len(bindings), nil
}
func assertTerminalSettled(ctx context.Context, q queryer, binding Object) error {
	marks, ok := binding["directDisableWatermarks"].([]any)
	if !ok {
		return errResetSettling
	}
	for _, raw := range marks {
		mark, ok := raw.(map[string]any)
		if !ok || text(mark, "bootId") == "" {
			return fail(409, "节点最终结算水位格式无效")
		}
		sequence, err := decimal(text(mark, "sequenceThrough"))
		if err != nil {
			return err
		}
		// Usage batches start at one. A zero watermark has no batch to wait for.
		if sequence == 0 {
			continue
		}
		var settled bool
		if err = q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM "NodeUsageBatch" WHERE "nodeId"=$1 AND "bootId"=$2 AND sequence=$3 AND "accountedAt" IS NOT NULL)`, binding["nodeId"], mark["bootId"], sequence).Scan(&settled); err != nil {
			return err
		}
		if !settled {
			return errResetSettling
		}
	}
	return nil
}
