package api

import (
	"context"
	"log/slog"
	"time"
)

const (
	meteringMaintenanceKey = "maintenance:metering"
	webhookMaintenanceKey  = "maintenance:webhooks"
	retentionChunkRows     = 5000
	retentionMaxChunks     = 40
)

const redactUsagePayloadsSQL = `WITH candidates AS (
 SELECT id FROM "NodeUsageBatch"
 WHERE "accountedAt" IS NOT NULL AND "createdAt"<$1 AND payload<>'{}'::jsonb
 ORDER BY "createdAt",id LIMIT $2 FOR UPDATE SKIP LOCKED
) UPDATE "NodeUsageBatch" b SET payload='{}'::jsonb FROM candidates c
 WHERE b.id=c.id AND b."accountedAt" IS NOT NULL AND b."createdAt"<$1 AND b.payload<>'{}'::jsonb`

const pruneMeteringIncidentsSQL = `WITH candidates AS (
 SELECT id FROM "MeteringIncident"
 WHERE status='resolved' AND coalesce("resolvedAt","updatedAt")<$1
 ORDER BY coalesce("resolvedAt","updatedAt"),id LIMIT $2 FOR UPDATE SKIP LOCKED
) DELETE FROM "MeteringIncident" i USING candidates c
 WHERE i.id=c.id AND i.status='resolved' AND coalesce(i."resolvedAt",i."updatedAt")<$1`

const pruneWebhookEventsSQL = `WITH candidates AS (
 SELECT "eventId" FROM "AchordConnectWebhookEvent" WHERE "receivedAt"<$1
 ORDER BY "receivedAt","eventId" LIMIT $2 FOR UPDATE SKIP LOCKED
) DELETE FROM "AchordConnectWebhookEvent" e USING candidates c
 WHERE e."eventId"=c."eventId" AND e."receivedAt"<$1`

// Each statement commits separately; cancellation preserves completed chunks and stops subsequent work.
func retentionChunks(ctx context.Context, q queryer, sql string, before time.Time) (int64, error) {
	var total int64
	for chunk := 0; chunk < retentionMaxChunks; chunk++ {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		result, err := q.Exec(ctx, sql, before, retentionChunkRows)
		if err != nil {
			return total, err
		}
		changed := result.RowsAffected()
		total += changed
		if changed < retentionChunkRows {
			break
		}
	}
	return total, nil
}

func (s *Server) reclaimMeteringHistory(ctx context.Context) error {
	payloadRetention, incidentRetention, err := s.Config.MeteringRetentionDurations()
	if err != nil {
		return err
	}
	at := time.Now().UTC()
	payloads, err := retentionChunks(ctx, s.DB, redactUsagePayloadsSQL, at.Add(-payloadRetention))
	if err != nil {
		return err
	}
	incidents, err := retentionChunks(ctx, s.DB, pruneMeteringIncidentsSQL, at.Add(-incidentRetention))
	if payloads > 0 || incidents > 0 {
		slog.Info("计量历史回收", "payloads", payloads, "incidents", incidents)
	}
	return err
}

func (s *Server) pruneWebhookEvents(ctx context.Context) error {
	_, err := retentionChunks(ctx, s.DB, pruneWebhookEventsSQL, time.Now().UTC().Add(-30*24*time.Hour))
	return err
}

func nextMaintenanceTime(at time.Time, minute int) time.Time {
	next := at.UTC().Truncate(time.Hour).Add(time.Duration(minute) * time.Minute)
	if !next.After(at) {
		next = next.Add(time.Hour)
	}
	return next
}

func (s *Server) scheduleMaintenance(key string, minute int, run func(context.Context) error) {
	s.tasks.at(key, nextMaintenanceTime(time.Now(), minute), s.maintenanceTask(key, minute, run))
}

func (s *Server) maintenanceTask(key string, minute int, run func(context.Context) error) func(context.Context) error {
	return func(ctx context.Context) error {
		if err := run(ctx); err != nil && ctx.Err() == nil {
			slog.Error("后台保留任务失败", "task", key, "error", err)
		}
		if ctx.Err() == nil {
			s.scheduleMaintenance(key, minute, run)
		}
		// Maintenance retries on the next fixed hour, never the general short retry loop.
		return nil
	}
}
