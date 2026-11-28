package api

import (
	"context"
	"errors"
	"time"
)

// A request timeout releases HTTP resources, not the persisted settlement gate.
// Only detached operations run here; an active request remains its sole finisher.
func (s *Server) resumeTrafficResets(ctx context.Context, nodeID string, restart bool) error {
	rows, err := list(ctx, s.DB, `SELECT jsonb_build_object('id',substring(key from 15),'operation',value) FROM "SystemSetting" WHERE key LIKE 'traffic-reset:%' AND ($1='' OR EXISTS(SELECT 1 FROM "PanelClientBinding" WHERE "subscriptionId"=substring(key from 15) AND "nodeId"=$1))`, nodeID)
	if err != nil {
		return err
	}
	for _, row := range rows {
		id := text(row, "id")
		operation, _ := row["operation"].(map[string]any)
		if !restart && !boolean(operation, "detached", false) {
			continue
		}
		s.tasks.at("reset:"+id, time.Now(), func(ctx context.Context) error {
			marker, e := one(ctx, s.DB, `SELECT value FROM "SystemSetting" WHERE key=$1`, trafficResetKey(id))
			if e != nil {
				return ignoreMissing(e)
			}
			input, _ := marker["request"].(map[string]any)
			if input == nil {
				input = Object{}
			}
			_, e = s.finishTrafficReset(ctx, id, text(marker, "userId"), input, boolean(marker, "renewal", false))
			if errors.Is(e, errResetSettling) {
				return nil
			}
			if e != nil {
				return ignoreMissing(e)
			}
			if e == nil {
				s.changed("subscriptions", "")
				s.events.publish(trafficResetKey(id), Object{"type": "traffic_reset_completed"})
			}
			return e
		})
	}
	return nil
}
func (s *Server) detachTrafficReset(id string) error {
	ctx, cancel := context.WithTimeout(s.resyncContext, 3*time.Second)
	defer cancel()
	_, err := s.DB.Exec(ctx, `UPDATE "SystemSetting" SET value=value||'{"detached":true}'::jsonb,"updatedAt"=now() WHERE key=$1`, trafficResetKey(id))
	if err != nil {
		return err
	}
	return s.resumeTrafficResets(ctx, "", false)
}
