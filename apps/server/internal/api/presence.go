package api

import (
	"context"
	"sync"
	"time"
)

const presenceWindow = 150 * time.Second

type presenceDeadline struct {
	timer *time.Timer
	at    time.Time
}
type presenceTimers struct {
	mu        sync.Mutex
	users     map[string]presenceDeadline
	broadcast *time.Timer
	closed    bool
}

func (s *Server) presenceUpdated() {
	s.presenceTimers.mu.Lock()
	defer s.presenceTimers.mu.Unlock()
	if s.presenceTimers.closed || s.presenceTimers.broadcast != nil {
		return
	}
	s.presenceTimers.broadcast = time.AfterFunc(time.Second, func() {
		s.presenceTimers.mu.Lock()
		s.presenceTimers.broadcast = nil
		closed := s.presenceTimers.closed
		s.presenceTimers.mu.Unlock()
		if !closed {
			s.events.publish("admin", Object{"type": "presence_updated", "occurredAt": now()})
		}
	})
}
func (s *Server) schedulePresenceExpiry(uid string, delay time.Duration) {
	deadline := time.Now().Add(delay)
	s.presenceTimers.mu.Lock()
	defer s.presenceTimers.mu.Unlock()
	if s.presenceTimers.closed {
		return
	}
	if previous, ok := s.presenceTimers.users[uid]; ok {
		previous.timer.Stop()
	}
	timer := time.AfterFunc(delay, func() {
		s.presenceTimers.mu.Lock()
		entry, ok := s.presenceTimers.users[uid]
		if !ok || !entry.at.Equal(deadline) || s.presenceTimers.closed {
			s.presenceTimers.mu.Unlock()
			return
		}
		delete(s.presenceTimers.users, uid)
		s.presenceTimers.mu.Unlock()
		s.presenceUpdated()
	})
	s.presenceTimers.users[uid] = presenceDeadline{timer: timer, at: deadline}
}
func (s *Server) notePresence(ctx context.Context, uid string, ping bool) error {
	_, err := s.DB.Exec(ctx, `INSERT INTO "UserClientPresence"("userId","onlineSince","lastSeenAt","lastPingAt","updatedAt") VALUES($1,now(),now(),CASE WHEN $2 THEN now() ELSE NULL END,now()) ON CONFLICT("userId") DO UPDATE SET "onlineSince"=CASE WHEN "UserClientPresence"."lastSeenAt"<now()-interval '150 seconds' THEN now() ELSE coalesce("UserClientPresence"."onlineSince",now()) END,"lastSeenAt"=now(),"lastPingAt"=CASE WHEN $2 THEN now() ELSE "UserClientPresence"."lastPingAt" END,"updatedAt"=now()`, uid, ping)
	if err != nil {
		return err
	}
	s.schedulePresenceExpiry(uid, presenceWindow)
	s.presenceUpdated()
	return nil
}
func (s *Server) closePresenceTimers() {
	s.presenceTimers.mu.Lock()
	defer s.presenceTimers.mu.Unlock()
	s.presenceTimers.closed = true
	for _, entry := range s.presenceTimers.users {
		entry.timer.Stop()
	}
	if s.presenceTimers.broadcast != nil {
		s.presenceTimers.broadcast.Stop()
	}
	s.presenceTimers.users = map[string]presenceDeadline{}
}
