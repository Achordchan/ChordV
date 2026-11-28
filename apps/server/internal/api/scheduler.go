package api

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

type scheduledTasks struct {
	mu       sync.Mutex
	timers   map[string]*time.Timer
	failures map[string]int
	closed   bool
	wg       sync.WaitGroup
	ctx      context.Context
}

func newScheduledTasks(ctx context.Context) *scheduledTasks {
	return &scheduledTasks{timers: map[string]*time.Timer{}, failures: map[string]int{}, ctx: ctx}
}
func (t *scheduledTasks) at(key string, at time.Time, run func(context.Context) error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return
	}
	if previous := t.timers[key]; previous != nil {
		previous.Stop()
	}
	var timer *time.Timer
	timer = time.AfterFunc(time.Until(at), func() {
		t.mu.Lock()
		if t.closed || t.timers[key] != timer {
			t.mu.Unlock()
			return
		}
		delete(t.timers, key)
		t.wg.Add(1)
		t.mu.Unlock()
		defer t.wg.Done()
		if err := run(t.ctx); err != nil && t.ctx.Err() == nil {
			slog.Error("本地后台任务失败", "task", key, "error", err)
			t.mu.Lock()
			attempt := t.failures[key]
			if attempt < 5 {
				attempt++
			}
			t.failures[key] = attempt
			t.mu.Unlock()
			t.at(key, time.Now().Add(time.Duration(1<<attempt)*time.Second), run)
		} else {
			t.mu.Lock()
			delete(t.failures, key)
			t.mu.Unlock()
		}
	})
	t.timers[key] = timer
}
func (t *scheduledTasks) close() {
	t.mu.Lock()
	t.closed = true
	for _, timer := range t.timers {
		timer.Stop()
	}
	t.timers = map[string]*time.Timer{}
	t.mu.Unlock()
	t.wg.Wait()
}
func (s *Server) Start(ctx context.Context) error {
	if _, err := s.Config.SessionLeaseTiming(); err != nil {
		return err
	}
	if _, _, err := s.Config.MeteringRetentionDurations(); err != nil {
		return err
	}
	if err := s.startCommandNotifications(ctx); err != nil {
		return err
	}
	for _, entry := range []struct{ table, where, kind, date string }{{"LeaseRevocationJob", "status IN('pending','running','failed')", "revocation", "nextRunAt"}, {"NodeSessionLease", "status='active'", "lease", "expiresAt"}, {"Subscription", "state='active'", "subscription", "expireAt"}, {"NodeCommandJob", "status IN('pending','running','failed')", "command", "nextRunAt"}} {
		rows, err := list(ctx, s.DB, `SELECT jsonb_build_object('id',id,'at',`+quote(entry.date)+`) FROM `+quote(entry.table)+` WHERE `+entry.where)
		if err != nil {
			return err
		}
		for _, row := range rows {
			at, err := parseTimestamp(text(row, "at"))
			if err != nil {
				return err
			}
			if entry.kind == "lease" {
				if err = s.scheduleLease(text(row, "id"), at); err != nil {
					return err
				}
			} else {
				s.scheduleEntity(entry.kind, text(row, "id"), at)
			}
		}
	}
	if err := s.resumeTrafficResets(ctx, "", true); err != nil {
		return err
	}
	pending, err := list(ctx, s.DB, `SELECT jsonb_build_object('nodeId',b."nodeId") FROM "PanelClientBinding" b WHERE b.source='direct' AND `+pendingBindingSQL+` GROUP BY b."nodeId"`)
	if err != nil {
		return err
	}
	for _, row := range pending {
		s.scheduleNodeProvisioning(text(row, "nodeId"))
	}
	attachments, err := list(ctx, s.DB, `SELECT jsonb_build_object('id',"tokenId",'at',"expiresAt") FROM "SupportTicketPendingAttachment"`)
	if err != nil {
		return err
	}
	for _, row := range attachments {
		at, e := parseTimestamp(text(row, "at"))
		if e != nil {
			return e
		}
		s.scheduleEntity("attachment", text(row, "id"), at)
	}
	if err := s.resumeFileCleanups(ctx); err != nil {
		return err
	}
	s.scheduleMaintenance(meteringMaintenanceKey, 17, s.reclaimMeteringHistory)
	s.scheduleMaintenance(webhookMaintenanceKey, 43, s.pruneWebhookEvents)
	s.scheduleMissingBindingsRecovery()
	return nil
}
func (s *Server) scheduleEntity(kind, id string, at time.Time) {
	s.tasks.at(kind+":"+id, at, func(ctx context.Context) error {
		switch kind {
		case "lease":
			return s.expireLease(ctx, id)
		case "subscription":
			return s.expireSubscription(ctx, id)
		case "command":
			return s.retryDueCommand(ctx, id)
		case "revocation":
			return s.runRevocationJob(ctx, id)
		case "attachment":
			return s.expireAttachment(ctx, id)
		case "file-cleanup":
			_, err := s.executeFileCleanup(ctx, id, false)
			return err
		}
		return nil
	})
}
func (s *Server) expireLease(ctx context.Context, id string) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	initial, e := one(ctx, tx, `SELECT to_jsonb(l) FROM "NodeSessionLease" l WHERE id=$1`, id)
	if e != nil {
		return ignoreMissing(e)
	}
	if err = lockRuntimeScope(ctx, tx, "subscriptionId", text(initial, "subscriptionId")); err != nil {
		return err
	}
	lease, err := one(ctx, tx, `SELECT to_jsonb(l) FROM "NodeSessionLease" l WHERE id=$1 FOR UPDATE`, id)
	if err != nil {
		return ignoreMissing(err)
	}
	if lease["status"] != "active" {
		return nil
	}

	expiry, err := parseTimestamp(text(lease, "expiresAt"))
	if err != nil {
		return err
	}
	timing, err := s.Config.SessionLeaseTiming()
	if err != nil {
		return err
	}
	if leaseValidAt(expiry, time.Now(), timing) {
		return s.scheduleLease(id, expiry)
	}
	var changed bool
	lease, changed, err = transitionLease(ctx, tx, lease, "expired", "session_expired")
	if err != nil {
		return err
	}
	if !changed {
		return nil
	}

	if err = s.disableUnusedLeaseBinding(ctx, tx, lease); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.publishLeaseRevocation(lease, "session_expired")
	return nil
}
func (s *Server) expireSubscription(ctx context.Context, id string) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	sub, err := one(ctx, tx, `SELECT to_jsonb(s) FROM "Subscription" s WHERE id=$1 FOR UPDATE`, id)
	if err != nil {
		return ignoreMissing(err)
	}
	if sub["state"] != "active" {
		return nil
	}
	expiry, _ := parseTimestamp(text(sub, "expireAt"))
	if expiry.After(time.Now()) {
		s.scheduleEntity("subscription", id, expiry)
		return nil
	}
	if _, err = update(ctx, tx, "Subscription", id, Object{"state": "expired"}, "state"); err != nil {
		return err
	}
	if _, err = s.revokeLeases(ctx, tx, "subscriptionId", id, "subscription_expired"); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.changed("subscriptions", "")
	return nil
}
func (s *Server) retryDueCommand(ctx context.Context, id string) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	job, err := one(ctx, tx, `SELECT to_jsonb(j) FROM "NodeCommandJob" j WHERE id=$1 FOR UPDATE`, id)
	if err != nil {
		return ignoreMissing(err)
	}
	if job["status"] == "completed" || job["status"] == "cancelled" {
		return nil
	}
	next, _ := parseTimestamp(text(job, "nextRunAt"))
	if next.After(time.Now()) {
		s.scheduleEntity("command", id, next)
		return nil
	}
	if number(job, "attempts") >= 8 {
		if _, err = update(ctx, tx, "NodeCommandJob", id, Object{"status": "cancelled", "lastError": "Agent 命令重试已达到8次上限"}, "status", "lastError"); err != nil {
			return err
		}
		if err = tx.Commit(ctx); err != nil {
			return err
		}
		s.changed("nodes", "")
		return nil
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.events.publish("agent:"+text(job, "nodeId"), Object{"type": "command_ready"})
	return nil
}
