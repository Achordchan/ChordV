package api

import "context"

func (s *Server) publishRecentRevocations(userID string) {
	ctx, cancel := context.WithTimeout(s.resyncContext, 3_000_000_000)
	defer cancel()
	leases, err := list(ctx, s.DB, `SELECT to_jsonb(l) FROM "NodeSessionLease" l WHERE status IN('revoked','evicted') AND "updatedAt">now()-interval '10 minutes' AND ($1='' OR "userId"=$1) ORDER BY "updatedAt",id LIMIT 1000`, userID)
	if err != nil {
		return
	}
	for _, lease := range leases {
		s.publishLeaseRevocation(lease, leaseTerminalReason(lease))
	}
}
func (h *eventHub) publishOnce(key, target string, event Object) bool {
	h.mu.Lock()
	if h.sent[key] {
		h.mu.Unlock()
		return false
	}
	if len(h.sent) > 4096 {
		h.sent = map[string]bool{}
	}
	h.sent[key] = true
	h.mu.Unlock()
	h.publish(target, event)
	return true
}
