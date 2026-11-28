package api

import (
	"context"
	"time"

	"github.com/Achordchan/ChordV/apps/server/internal/config"
	"github.com/jackc/pgx/v5"
)

func leaseHardDeadline(expires time.Time, timing config.LeaseTiming) time.Time {
	return expires.Add(timing.Grace())
}
func leaseValidAt(expires, at time.Time, timing config.LeaseTiming) bool {
	return at.Before(leaseHardDeadline(expires, timing))
}

func (s *Server) leaseCutoff(at time.Time) (time.Time, error) {
	timing, err := s.Config.SessionLeaseTiming()
	if err != nil {
		return time.Time{}, err
	}
	return at.UTC().Add(-timing.Grace()), nil
}

func (s *Server) scheduleLease(id string, expires time.Time) error {
	timing, err := s.Config.SessionLeaseTiming()
	if err != nil {
		return err
	}
	s.scheduleEntity("lease", id, leaseHardDeadline(expires, timing))
	return nil
}

func transitionLease(ctx context.Context, q queryer, lease Object, status, reason string) (Object, bool, error) {
	updated, err := one(ctx, q, `WITH changed AS(UPDATE "NodeSessionLease" SET status=$2::"NodeSessionLeaseStatus","revokedAt"=now(),"revokedReason"=$3,"updatedAt"=now() WHERE id=$1 AND status='active' RETURNING *) SELECT to_jsonb(changed) FROM changed`, lease["id"], status, reason)
	if err == pgx.ErrNoRows {
		return lease, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	kind := "session_revoked"
	if status == "evicted" {
		kind = "session_evicted"
	}
	_, err = q.Exec(ctx, `INSERT INTO "SecurityEvent"(id,type,"userId","subscriptionId","nodeId","leaseId",detail) VALUES($1,$2::"SecurityEventType",$3,$4,$5,$6,$7)`, newID(), kind, updated["userId"], updated["subscriptionId"], updated["nodeId"], updated["id"], reason)
	return updated, true, err
}

func leaseTerminalReason(lease Object) string {
	if reason := text(lease, "revokedReason"); reason != "" {
		return sessionReason(reason)
	}
	if lease["status"] == "expired" {
		return "session_expired"
	}
	if lease["status"] == "evicted" {
		return "connection_taken_over"
	}
	return "session_invalid"
}

func leaseHeartbeatResult(lease Object) Object {
	return Object{"sessionId": lease["sessionId"], "status": lease["status"], "leaseExpiresAt": lease["expiresAt"], "reasonCode": leaseTerminalReason(lease), "reasonMessage": "连接会话已失效"}
}

func effectiveUserConcurrentLimit(ctx context.Context, q queryer, userID string, at time.Time) (int, error) {
	row, err := one(ctx, q, `SELECT jsonb_build_object('limit',CASE WHEN u."maxConcurrentSessionsOverride">0 THEN u."maxConcurrentSessionsOverride" ELSE coalesce((
 SELECT p."maxConcurrentSessions" FROM "Subscription" s JOIN "Plan" p ON p.id=s."planId"
 WHERE (CASE WHEN m.id IS NULL THEN s."userId"=u.id ELSE s."teamId"=m."teamId" END)
 AND s.state IN('active','paused') AND s."expireAt">$2 AND s."remainingTrafficGb">0 AND p."maxConcurrentSessions">0
 ORDER BY (s.state='active') DESC,s."expireAt" DESC,s."createdAt" DESC,s.id DESC LIMIT 1),3) END)
 FROM "User" u LEFT JOIN "TeamMember" m ON m."userId"=u.id WHERE u.id=$1`, userID, at.UTC())
	if err != nil {
		return 0, err
	}
	return int(number(row, "limit")), nil
}

func (s *Server) evictExcessUserLeases(ctx context.Context, q queryer, userID string, limit, reserved int) ([]Object, error) {
	cutoff, err := s.leaseCutoff(time.Now())
	if err != nil {
		return nil, err
	}
	leases, err := list(ctx, q, `SELECT to_jsonb(l) FROM "NodeSessionLease" l WHERE "userId"=$1 AND status='active' AND "expiresAt">$2 ORDER BY "lastHeartbeatAt","issuedAt",id FOR UPDATE`, userID, cutoff)
	if err != nil {
		return nil, err
	}
	victims := []Object{}
	for len(leases)+reserved > limit {
		row := leases[0]
		leases = leases[1:]
		updated, changed, err := transitionLease(ctx, q, row, "evicted", "concurrency_limit")
		if err != nil {
			return nil, err
		}
		if changed {
			victims = append(victims, updated)
		}
	}
	return victims, nil
}
