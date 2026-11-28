package api

import (
	"context"
	"errors"
	"time"
)

// Assignments and membership are durable intent even when no binding was committed.
const missingBindingsFromSQL = ` FROM "Subscription" s JOIN "SubscriptionNodeAccess" a ON a."subscriptionId"=s.id JOIN "Node" n ON n.id=a."nodeId" JOIN "User" u ON (u.id=s."userId" OR EXISTS(SELECT 1 FROM "TeamMember" m JOIN "Team" t ON t.id=m."teamId" WHERE m."userId"=u.id AND m."teamId"=s."teamId" AND t.status='active')) LEFT JOIN "PanelClientBinding" b ON b."subscriptionId"=s.id AND b."nodeId"=n.id AND b."userId"=u.id WHERE ($1='' OR s.id=$1) AND ($2='' OR n.id=$2) AND b.id IS NULL AND u.status='active' AND s.state='active' AND s."expireAt">now() AND s."remainingTrafficGb">0 AND n."isActive" AND ` + bindingNodeReadySQL + ` AND NOT EXISTS(SELECT 1 FROM "SystemSetting" reset WHERE reset.key='traffic-reset:'||s.id)`

func (s *Server) repairMissingBindingSubscription(ctx context.Context, id string) (bool, error) {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	if err = lockRuntimeScope(ctx, tx, "subscriptionId", id); err != nil {
		return false, err
	}
	if _, err = readLockedRuntimeSubscription(ctx, tx, id); err != nil {
		return false, ignoreMissing(err)
	}
	changed, err := s.createMissingBindings(ctx, tx, id)
	if err != nil {
		return false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return false, err
	}
	if changed {
		s.changed("subscriptions", "")
	}
	return changed, nil
}

// A finite cursor scan runs on startup or committed Agent events, never a periodic poll.
// Re-read eligibility under the normal subscription/binding/node locks before writing.
func (s *Server) repairMissingBindings(ctx context.Context, nodeID string) error {
	end, err := one(ctx, s.DB, `SELECT jsonb_build_object('id',max(s.id))`+missingBindingsFromSQL, "", nodeID)
	if err != nil || text(end, "id") == "" {
		return err
	}
	cursor := ""
	var failures error
	for {
		if err := ctx.Err(); err != nil {
			return errors.Join(failures, err)
		}
		rows, err := list(ctx, s.DB, `SELECT jsonb_build_object('id',s.id)`+missingBindingsFromSQL+` AND s.id>$3 AND s.id<=$4 GROUP BY s.id ORDER BY s.id LIMIT 50`, "", nodeID, cursor, end["id"])
		if err != nil {
			return errors.Join(failures, err)
		}
		for _, row := range rows {
			cursor = text(row, "id")
			if _, err = s.repairMissingBindingSubscription(ctx, cursor); err != nil {
				if failures == nil {
					failures = err
				}
			}
		}
		if len(rows) < 50 {
			return failures
		}
	}
}

func (s *Server) scheduleMissingBindingsRecovery() {
	s.tasks.at("provision-missing:startup", time.Now(), func(ctx context.Context) error { return s.repairMissingBindings(ctx, "") })
}
