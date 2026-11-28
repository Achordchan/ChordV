package api

import (
	"context"
	"net/http"
	"net/url"
	"time"
)

func (s *Server) Close() {
	s.resyncClose.Do(func() {
		s.closePresenceTimers()
		s.resyncMu.Lock()
		s.resyncClosed = true
		close(s.resyncStop)
		s.resyncCancel()
		s.resyncMu.Unlock()
		s.tasks.close()
		s.listenerWG.Wait()
		s.resyncWG.Wait()
	})
}
func (s *Server) publishCurrentUnread(uid string) {
	s.supportPublishMu.Lock()
	defer s.supportPublishMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	state, err := one(ctx, s.DB, `SELECT jsonb_build_object('count',CASE WHEN coalesce((SELECT (value->>'enabled')::boolean FROM "SystemSetting" WHERE key='achord-connect'),false) THEN s."unreadCount" ELSE 0 END,'revision',s.revision) FROM "SupportUnreadState" s WHERE "userId"=$1`, uid)
	if err != nil {
		return
	}
	s.events.publish(uid, Object{"type": "support_unread_updated", "occurredAt": now(), "supportUnreadCount": state["count"]})
}
func (s *Server) scheduleSupportResync(uid string) {
	s.resyncMu.Lock()
	if s.resyncClosed || s.resyncPending[uid] || len(s.resyncPending) >= 100 {
		s.resyncMu.Unlock()
		return
	}
	s.resyncPending[uid] = true
	s.resyncWG.Add(1)
	s.resyncMu.Unlock()
	go func() {
		defer s.resyncWG.Done()
		defer func() { s.resyncMu.Lock(); delete(s.resyncPending, uid); s.resyncMu.Unlock() }()
		for attempt := 0; attempt < 3; attempt++ {
			if attempt > 0 {
				timer := time.NewTimer(time.Duration(1<<attempt) * time.Second)
				select {
				case <-s.resyncStop:
					timer.Stop()
					return
				case <-timer.C:
				}
			}
			cfg, err := s.setting(s.resyncContext, "achord-connect")
			if err != nil || !supportEnabled(cfg) {
				return
			}
			if s.resyncSupportUnread(s.resyncContext, uid, cfg) == nil {
				return
			}
		}
	}()
}
func (s *Server) resyncSupportUnread(ctx context.Context, uid string, cfg Object) error {
	state, err := one(ctx, s.DB, `SELECT to_jsonb(s) FROM "SupportUnreadState" s WHERE "userId"=$1`, uid)
	if err != nil {
		return err
	}
	response, err := s.supportRequest(ctx, cfg, "GET", "/api/v1/integrations/universal/contacts/"+url.PathEscape(uid)+"/unread", nil)
	if err != nil {
		return err
	}
	count, ok := validUnread(response["unreadCount"])
	if !ok {
		return fail(502, "工单未读总数无效")
	}
	serverTime, err := http.ParseTime(text(response, "_responseDate"))
	if err != nil {
		return fail(502, "工单响应缺少可排序的 Date 头")
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	currentCfg, err := one(ctx, tx, `SELECT value FROM "SystemSetting" WHERE key='achord-connect' FOR SHARE`)
	if err != nil {
		return err
	}
	if number(currentCfg, "generation") != number(cfg, "generation") || number(currentCfg, "epoch") != number(cfg, "epoch") || !supportEnabled(currentCfg) {
		return nil
	}
	current, err := one(ctx, tx, `SELECT to_jsonb(s) FROM "SupportUnreadState" s WHERE "userId"=$1 FOR UPDATE`, uid)
	if err != nil {
		return err
	}
	if current["revision"] != state["revision"] {
		return fail(409, "工单查询期间有新事件，保留较新的未读状态")
	}
	source := serverTime.Add(-21 * time.Second)
	previous, _ := parseTimestamp(text(current, "sourceAt"))
	if previous.After(source) {
		source = previous
	}
	_, err = updateKey(ctx, tx, "SupportUnreadState", "userId", uid, Object{"unreadCount": count, "sourceAt": source.UTC().Format(time.RFC3339Nano), "snapshotUntil": serverTime.Add(time.Second).UTC().Format(time.RFC3339Nano), "syncedAt": now(), "requestsComplete": false, "revision": number(current, "revision") + 1}, "unreadCount", "sourceAt", "snapshotUntil", "syncedAt", "requestsComplete", "revision")
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.publishCurrentUnread(uid)
	return nil
}
func (s *Server) supportStatus(_ http.ResponseWriter, r *http.Request, user Object) (any, error) {
	cfg, err := s.setting(r.Context(), "achord-connect")
	if err != nil {
		return nil, err
	}
	if _, err = s.DB.Exec(r.Context(), `INSERT INTO "SupportUnreadState"("userId","updatedAt") VALUES($1,now()) ON CONFLICT("userId") DO NOTHING`, user["id"]); err != nil {
		return nil, err
	}
	state, err := one(r.Context(), s.DB, `SELECT to_jsonb(s) FROM "SupportUnreadState" s WHERE "userId"=$1`, user["id"])
	if err != nil {
		return nil, err
	}
	if !supportEnabled(cfg) {
		return Object{"enabled": false, "unreadCount": 0, "supportOrigin": nil}, nil
	}
	synced, _ := parseTimestamp(text(state, "syncedAt"))
	if time.Since(synced) >= 2*time.Minute {
		if err = s.resyncSupportUnread(r.Context(), text(user, "id"), cfg); err != nil {
			s.scheduleSupportResync(text(user, "id"))
		}
		state, err = one(r.Context(), s.DB, `SELECT to_jsonb(s) FROM "SupportUnreadState" s WHERE "userId"=$1`, user["id"])
		if err != nil {
			return nil, err
		}
	}
	latest, err := s.setting(r.Context(), "achord-connect")
	if err != nil {
		return nil, err
	}
	if !supportEnabled(latest) {
		return Object{"enabled": false, "unreadCount": 0, "supportOrigin": nil}, nil
	}
	return Object{"enabled": true, "unreadCount": state["unreadCount"], "supportOrigin": latest["baseUrl"]}, nil
}
