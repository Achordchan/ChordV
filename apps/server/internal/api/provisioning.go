package api

import (
	"context"
	"errors"
	"fmt"
	"time"
)

const bindingNodeReadySQL = `n."controlMode"='direct_primary' AND (n."registrationStatus" IS NULL OR(n."registrationStatus"='agent_ready' AND n."inboundAppliedRevision">0))`

const bindingUsableSQL = `EXISTS(SELECT 1 FROM "Subscription" s JOIN "SubscriptionNodeAccess" a ON a."subscriptionId"=s.id AND a."nodeId"=b."nodeId" JOIN "Node" n ON n.id=a."nodeId" JOIN "User" u ON u.id=b."userId" LEFT JOIN "Team" t ON t.id=s."teamId" WHERE s.id=b."subscriptionId" AND s.state='active' AND s."expireAt">now() AND s."remainingTrafficGb">0 AND n."isActive" AND u.status='active' AND ((s."teamId" IS NULL AND s."userId"=u.id) OR (t.status='active' AND EXISTS(SELECT 1 FROM "TeamMember" m WHERE m."teamId"=t.id AND m."userId"=u.id))) AND (b.status<>'deleted' OR (` + bindingNodeReadySQL + `)))`

// A deleted legacy row plus a current assignment is durable restore intent.
// An ordinary disabled row still needs an explicit marker: it may be idle on purpose.
const pendingBindingSQL = `(b.status='deleted' AND ` + bindingUsableSQL + ` OR b.status='disabled' AND EXISTS(SELECT 1 FROM "SystemSetting" p WHERE p.key='binding-resume:'||b.id))`

func (s *Server) ensureBindingBaseline(ctx context.Context, q queryer, binding Object) error {
	key := fmt.Sprintf("%v:%v:%v", binding["nodeId"], binding["subscriptionId"], binding["userId"])
	_, err := q.Exec(ctx, `INSERT INTO "TrafficSnapshot"(id,"snapshotKey","nodeId","subscriptionId","userId","teamId","uplinkBytes","downlinkBytes","totalBytes",source,"counterGeneration","sampledAt","updatedAt") SELECT $1,$2,b."nodeId",b."subscriptionId",b."userId",b."teamId",b."lastUplinkBytes",b."lastDownlinkBytes",b."lastUplinkBytes"+b."lastDownlinkBytes",'direct','0',now(),now() FROM "PanelClientBinding" b WHERE b.id=$3 ON CONFLICT("snapshotKey") DO NOTHING`, newID(), key, binding["id"])
	return err
}

// Only call after the previous removal and all its final traffic are settled.
// The account gets a fresh credential; previously billed traffic is not reset.
func restoreDeletedBinding(ctx context.Context, q queryer, binding Object) (Object, error) {
	key := fmt.Sprintf("%v:%v:%v", binding["nodeId"], binding["subscriptionId"], binding["userId"])
	if _, err := q.Exec(ctx, `UPDATE "TrafficSnapshot" SET "uplinkBytes"=0,"downlinkBytes"=0,"totalBytes"=0,"counterGeneration"='0',"sampledAt"=now(),"updatedAt"=now() WHERE "snapshotKey"=$1`, key); err != nil {
		return nil, err
	}
	return update(ctx, q, "PanelClientBinding", text(binding, "id"), Object{
		"status": "active", "source": "direct", "panelClientId": newID(), "panelInboundId": 0,
		"lastUplinkBytes": 0, "lastDownlinkBytes": 0, "directDisabledAt": nil, "directDisableWatermarks": nil,
	}, "status", "source", "panelClientId", "panelInboundId", "lastUplinkBytes", "lastDownlinkBytes", "directDisabledAt", "directDisableWatermarks")
}
func (s *Server) provisionMissingBindings(ctx context.Context, q queryer, id string) error {
	_, err := s.createMissingBindings(ctx, q, id)
	return err
}
func (s *Server) createMissingBindings(ctx context.Context, q queryer, id string) (bool, error) {
	pairs, err := list(ctx, q, `SELECT jsonb_build_object('userId',u.id,'teamId',s."teamId",'nodeId',n.id,'subscriptionId',s.id)`+missingBindingsFromSQL+` ORDER BY n.id,u.id`, id, "")
	if err != nil {
		return false, err
	}
	for _, pair := range pairs {
		data := pick(pair, "subscriptionId", "userId", "teamId", "nodeId")
		data["panelClientEmail"] = "chordv_" + newID()
		data["panelClientId"] = newID()
		data["panelInboundId"] = 0
		data["source"] = "direct"
		data["status"] = "active"
		binding, err := insert(ctx, q, "PanelClientBinding", data)
		if err != nil {
			return false, err
		}
		if _, err = s.queueBinding(ctx, q, binding, "ENSURE_USER"); err != nil {
			return false, err
		}
	}
	return len(pairs) > 0, nil
}
func (s *Server) scheduleNodeProvisioning(nodeID string) {
	s.tasks.at("provision:"+nodeID, time.Now(), func(ctx context.Context) error {
		return errors.Join(s.restorePendingNodeBindings(ctx, nodeID), s.repairMissingBindings(ctx, nodeID))
	})
}

func (s *Server) restorePendingNodeBindings(ctx context.Context, nodeID string) error {
	rows, err := list(ctx, s.DB, `SELECT jsonb_build_object('id',b."subscriptionId",'bindingId',b.id) FROM "PanelClientBinding" b WHERE b."nodeId"=$1 AND b.source='direct' AND `+pendingBindingSQL+` ORDER BY b."subscriptionId",b.id`, nodeID)
	if err != nil {
		return err
	}
	var firstError error
	for _, row := range rows {
		if err = s.restorePendingBinding(ctx, row); err != nil && firstError == nil {
			firstError = err
		}
	}
	return firstError
}

func (s *Server) restorePendingBinding(ctx context.Context, row Object) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = lockRuntimeScope(ctx, tx, "subscriptionId", text(row, "id")); err != nil {
		return err
	}
	if _, err = readLockedRuntimeSubscription(ctx, tx, text(row, "id")); err != nil {
		return ignoreMissing(err)
	}
	if err = s.syncSubscriptionBindings(ctx, tx, text(row, "id"), text(row, "bindingId")); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s *Server) waitBindingSettled(ctx context.Context, id string, events <-chan Object) error {
	deadline, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	for {
		binding, err := one(deadline, s.DB, `SELECT to_jsonb(b) FROM "PanelClientBinding" b WHERE id=$1`, id)
		if err != nil {
			return err
		}
		if binding["status"] == "active" {
			return nil
		}
		if err = assertTerminalSettled(deadline, s.DB, binding); err == nil {
			return nil
		}
		if !errors.Is(err, errResetSettling) {
			return err
		}
		select {
		case <-deadline.Done():
			return fail(409, "节点停用后的最终流量尚未结清，未重新启用账号")
		case <-s.resyncStop:
			return fail(503, "本地服务正在退出")
		case <-events:
		}
	}
}

func (s *Server) syncNodeSubscriptions(ctx context.Context, q queryer, nodeID string) error {
	subs, err := list(ctx, q, `SELECT to_jsonb(s) FROM "Subscription" s JOIN "SubscriptionNodeAccess" a ON a."subscriptionId"=s.id WHERE a."nodeId"=$1 ORDER BY s.id`, nodeID)
	if err != nil {
		return err
	}
	if err = requireFrozenRuntimeSubscriptions(ctx, q, runtimeSubscriptionIDs(subs)); err != nil {
		return err
	}
	for _, sub := range subs {
		if err = s.syncSubscriptionBindings(ctx, q, text(sub, "id")); err != nil {
			return err
		}
	}
	return nil
}
func (s *Server) syncUserSubscriptions(ctx context.Context, q queryer, userID string) error {
	if err := lockRuntimeScope(ctx, q, "userId", userID); err != nil {
		return err
	}
	subs, err := list(ctx, q, `SELECT to_jsonb(s) FROM "Subscription" s WHERE "userId"=$1 OR "teamId" IN(SELECT "teamId" FROM "TeamMember" WHERE "userId"=$1) ORDER BY s.id`, userID)
	if err != nil {
		return err
	}
	if err = requireFrozenRuntimeSubscriptions(ctx, q, runtimeSubscriptionIDs(subs)); err != nil {
		return err
	}
	for _, sub := range subs {
		if err = s.syncSubscriptionBindings(ctx, q, text(sub, "id")); err != nil {
			return err
		}
	}
	return nil
}
