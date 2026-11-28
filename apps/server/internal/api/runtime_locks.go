package api

import "context"

// All mutation paths order subscription -> binding -> node -> command. Lease
// mutations hold their subscription first, so reset/metering cannot invert it.
func lockRuntimeScope(ctx context.Context, q queryer, column, id string) error {
	ids, err := lockRuntimeSubscriptionIDs(ctx, q, column, id)
	if err != nil {
		return err
	}
	if column == "nodeId" {
		return lockRuntimeBindingsAndNodes(ctx, q, ids, id)
	}
	return lockRuntimeBindingsAndNodes(ctx, q, ids)
}
func lockRuntimeSubscriptions(ctx context.Context, q queryer, column, id string) error {
	_, err := lockRuntimeSubscriptionIDs(ctx, q, column, id)
	return err
}
func lockRuntimeSubscriptionIDs(ctx context.Context, q queryer, column, id string) ([]string, error) {
	predicate, err := runtimeSubscriptionPredicate(column, "=$1")
	if err != nil {
		return nil, err
	}
	rows, err := list(ctx, q, `SELECT jsonb_build_object('id',s.id) FROM "Subscription" s WHERE `+predicate+` ORDER BY s.id`, id)
	if err != nil {
		return nil, err
	}
	ids := runtimeSubscriptionIDs(rows)
	return ids, lockRuntimeSubscriptionSet(ctx, q, ids)
}

func runtimeSubscriptionPredicate(column, comparison string) (string, error) {
	if column != "subscriptionId" && column != "userId" && column != "nodeId" {
		return "", fail(400, "锁定条件无效")
	}
	owner := `s.id` + comparison
	if column == "userId" {
		owner = `(s."userId"` + comparison + ` OR s."teamId" IN(SELECT "teamId" FROM "TeamMember" WHERE "userId"` + comparison + `))`
	}
	if column == "nodeId" {
		owner = `EXISTS(SELECT 1 FROM "SubscriptionNodeAccess" a WHERE a."subscriptionId"=s.id AND a."nodeId"` + comparison + `)`
	}
	return owner + ` OR EXISTS(SELECT 1 FROM "PanelClientBinding" b WHERE b."subscriptionId"=s.id AND b.` + quote(column) + comparison + `) OR EXISTS(SELECT 1 FROM "NodeSessionLease" l WHERE l."subscriptionId"=s.id AND l.` + quote(column) + comparison + `)`, nil
}
func lockLeaseSubscription(ctx context.Context, q queryer, sessionID, userID string) error {
	row, err := one(ctx, q, `SELECT jsonb_build_object('id',"subscriptionId") FROM "NodeSessionLease" WHERE "sessionId"=$1 AND "userId"=$2`, sessionID, userID)
	if err != nil {
		return err
	}
	return lockRuntimeScope(ctx, q, "subscriptionId", text(row, "id"))
}
