package api

import "context"

func runtimeSubscriptionIDs(rows []Object) []string {
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, text(row, "id"))
	}
	return ids
}

// Call only after the entire subscription set is locked. Prelock every existing
// binding before nodes; access and historical leases also cover missing bindings.
// A node-scoped mutation includes its target even when it has no subscriptions.
func lockRuntimeBindingsAndNodes(ctx context.Context, q queryer, subscriptionIDs []string, extraNodeIDs ...string) error {
	if err := requireRuntimeSubscriptions(ctx, q, subscriptionIDs); err != nil {
		return err
	}
	if _, err := list(ctx, q, `SELECT jsonb_build_object('id',id) FROM "PanelClientBinding" WHERE "subscriptionId"=ANY($1::text[]) ORDER BY "nodeId",id FOR UPDATE`, subscriptionIDs); err != nil {
		return err
	}
	if err := freezeRuntimeSubscriptions(ctx, q, subscriptionIDs); err != nil {
		return err
	}
	_, err := list(ctx, q, `SELECT jsonb_build_object('id',n.id) FROM "Node" n WHERE n.id IN(
 SELECT "nodeId" FROM "PanelClientBinding" WHERE "subscriptionId"=ANY($1::text[])
 UNION SELECT "nodeId" FROM "NodeSessionLease" WHERE "subscriptionId"=ANY($1::text[])
 UNION SELECT "nodeId" FROM "SubscriptionNodeAccess" WHERE "subscriptionId"=ANY($1::text[])
 UNION SELECT unnest($2::text[])
 ) ORDER BY n.id FOR UPDATE OF n`, subscriptionIDs, extraNodeIDs)
	return err
}
