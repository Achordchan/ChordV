package api

import (
	"context"
	"time"
)

func (s *Server) reconcileUserConcurrency(ctx context.Context, q queryer, userID string) error {

	if err := lockConcurrencyScope(ctx, q, "user", userID); err != nil {
		return err
	}
	limit, err := effectiveUserConcurrentLimit(ctx, q, userID, time.Now())
	if err != nil {
		return err
	}
	victims, err := s.evictExcessUserLeases(ctx, q, userID, limit, 0)
	if err != nil {
		return err
	}
	for _, lease := range victims {
		if err = s.disableUnusedLeaseBinding(ctx, q, lease); err != nil {
			return err
		}
	}
	return nil
}
func (s *Server) reconcileSubscriptionConcurrency(ctx context.Context, q queryer, id string) error {
	if err := lockConcurrencyScope(ctx, q, "subscription", id); err != nil {
		return err
	}
	users, err := list(ctx, q, `SELECT jsonb_build_object('userId',"userId") FROM "NodeSessionLease" WHERE "subscriptionId"=$1 AND status='active' GROUP BY "userId" ORDER BY "userId"`, id)
	if err != nil {
		return err
	}
	for _, user := range users {
		if err = s.reconcileUserConcurrency(ctx, q, text(user, "userId")); err != nil {
			return err
		}
	}
	return nil
}
