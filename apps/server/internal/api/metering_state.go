package api

import (
	"context"
	"time"
)

func subscriptionMeteringState(ctx context.Context, q queryer, userID, subscriptionID string, at time.Time) (Object, error) {
	return one(ctx, q, `WITH current_node AS (
 SELECT n.* FROM "NodeSessionLease" l JOIN "Node" n ON n.id=l."nodeId"
 WHERE l."userId"=$1 AND l."subscriptionId"=$2 AND l.status='active' AND l."expiresAt">$3
 ORDER BY l."lastHeartbeatAt" DESC,l."updatedAt" DESC,l."createdAt" DESC,l.id DESC LIMIT 1
), online_node AS (
 SELECT n.id FROM current_node n LEFT JOIN LATERAL (
  SELECT a.status,a."xrayStatus" FROM "NodeAgent" a WHERE a."nodeId"=n.id AND a."revokedAt" IS NULL
  ORDER BY a."lastSeenAt" DESC NULLS LAST,a."createdAt" DESC,a.id DESC LIMIT 1
 ) agent ON true
 WHERE n."isActive" AND (
  (agent.status='online' AND agent."xrayStatus"='healthy') OR
  (n."registrationStatus" IS NULL AND n."controlStatus"='online' AND NOT EXISTS(SELECT 1 FROM "NodeAgent" a WHERE a."nodeId"=n.id))
 )
), visible AS (
 SELECT i.reason FROM "MeteringIncident" i JOIN online_node n ON n.id=i."nodeId"
 WHERE i."subscriptionId"=$2 AND i.status='open' AND (
  i.reason<>'NODE_METERING_UNAVAILABLE' OR greatest(i."createdAt",i."openedAt")<=$3-interval '90 seconds'
 )
), state AS (
 SELECT CASE WHEN EXISTS(SELECT 1 FROM visible WHERE reason<>'NODE_METERING_UNAVAILABLE') THEN '流量统计正在校准，请稍后查看'
 WHEN EXISTS(SELECT 1 FROM visible) THEN '计量同步延迟，后台正在重试，请稍后查看' END AS message
)
SELECT jsonb_build_object('meteringStatus',CASE WHEN message IS NULL THEN 'ok' ELSE 'degraded' END,'meteringMessage',message) FROM state`, userID, subscriptionID, at)
}
