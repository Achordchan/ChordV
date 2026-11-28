package api

import (
	"context"
	"net/http"
	"time"
)

func (s *Server) runRevocationJob(ctx context.Context, id string) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	initial, err := one(ctx, tx, `SELECT to_jsonb(j) FROM "LeaseRevocationJob" j WHERE id=$1`, id)
	if err != nil {
		return ignoreMissing(err)
	}
	if initial["status"] == "completed" {
		return nil
	}
	scope := "subscriptionId"
	key := text(initial, scope)
	if key == "" {
		scope = "userId"
		key = text(initial, scope)
	}
	if key == "" {
		scope = "nodeId"
		key = text(initial, scope)
	}
	if key == "" {
		return fail(409, "撤销任务缺少归属范围")
	}
	if err = lockRuntimeScope(ctx, tx, scope, key); err != nil {
		return err
	}
	job, err := one(ctx, tx, `SELECT to_jsonb(j) FROM "LeaseRevocationJob" j WHERE id=$1 FOR UPDATE`, id)
	if err != nil {
		return err
	}
	if job["status"] == "completed" {
		return nil
	}
	leases, err := list(ctx, tx, `SELECT to_jsonb(l) FROM "NodeSessionLease" l WHERE status='active' AND ($1='' OR "subscriptionId"=$1) AND ($2='' OR "userId"=$2) AND ($3='' OR "nodeId"=$3) ORDER BY id FOR UPDATE`, text(job, "subscriptionId"), text(job, "userId"), text(job, "nodeId"))
	if err != nil {
		return err
	}
	for _, lease := range leases {
		if _, err = update(ctx, tx, "NodeSessionLease", text(lease, "id"), Object{"status": "revoked", "revokedAt": now(), "revokedReason": text(job, "reason")}, "status", "revokedAt", "revokedReason"); err != nil {
			return err
		}
	}
	bindings, err := list(ctx, tx, `SELECT to_jsonb(b) FROM "PanelClientBinding" b WHERE status='active' AND source='direct' AND ($1='' OR "subscriptionId"=$1) AND ($2='' OR "userId"=$2) AND ($3='' OR "nodeId"=$3) ORDER BY "nodeId",id FOR UPDATE`, text(job, "subscriptionId"), text(job, "userId"), text(job, "nodeId"))
	if err != nil {
		return err
	}
	for _, binding := range bindings {
		if _, err = update(ctx, tx, "PanelClientBinding", text(binding, "id"), Object{"status": "disabled", "directDisabledAt": now(), "directDisableWatermarks": nil}, "status", "directDisabledAt", "directDisableWatermarks"); err != nil {
			return err
		}
		if _, err = s.queueBinding(ctx, tx, binding, "DISABLE_USER"); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE "LeaseRevocationJob" SET status='completed',attempts=attempts+1,"completedAt"=now(),"lastError"=NULL,"updatedAt"=now() WHERE id=$1`, id); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	for _, lease := range leases {
		s.publishLeaseRevocation(lease, sessionReason(text(job, "reason")))
	}
	s.changed("nodes", text(job, "userId"))
	s.presenceUpdated()
	return nil
}
func (s *Server) retryRevocationJob(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	rows, err := list(r.Context(), s.DB, `UPDATE "LeaseRevocationJob" SET status='pending',"nextRunAt"=now(),"lastError"=NULL,"updatedAt"=now() WHERE status<>'completed' AND ($1='' OR id=$1) AND ($2='' OR "nodeId"=$2) RETURNING jsonb_build_object('id',id)`, r.PathValue("jobId"), r.PathValue("nodeId"))
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		s.scheduleEntity("revocation", text(row, "id"), time.Now())
	}
	return Object{"ok": true, "queuedCount": len(rows)}, nil
}
