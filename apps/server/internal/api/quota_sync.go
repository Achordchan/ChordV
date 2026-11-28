package api

import "context"

func (s *Server) syncQuota(ctx context.Context, q queryer, subscriptionID string) error {
	bindings, err := list(ctx, q, `SELECT to_jsonb(b) FROM "PanelClientBinding" b WHERE "subscriptionId"=$1 AND source='direct' AND status='active' ORDER BY "nodeId",id FOR UPDATE`, subscriptionID)
	if err != nil {
		return err
	}
	for _, binding := range bindings {
		if _, err = s.queueBinding(ctx, q, binding, "REFRESH_QUOTA"); err != nil {
			return err
		}
	}
	return nil
}
