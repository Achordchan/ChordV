package api

import "net/http"

func (s *Server) adminRoutes(mux *http.ServeMux) {
	routes := []struct {
		pattern string
		fn      Handler
	}{
		{"GET /api/admin/storage", s.storageList}, {"POST /api/admin/storage/scan", s.storageScan}, {"POST /api/admin/storage/cleanup", s.storageCleanup}, {"POST /api/admin/storage/cleanup/{id}/retry", s.retryStorageCleanup},
		{"GET /api/admin/image-bed/config", s.imageConfig}, {"PATCH /api/admin/image-bed/config", s.saveImageConfig}, {"GET /api/admin/image-bed/files", s.imageFiles}, {"DELETE /api/admin/image-bed/files", s.imageFiles}, {"GET /api/admin/upload-limits", s.uploadLimits},
		{"GET /api/admin/dashboard", s.dashboard}, {"GET /api/admin/snapshot", s.snapshot},
		{"GET /api/admin/me", s.me}, {"PUT /api/admin/me/security", s.adminSecurity},
		{"GET /api/admin/users", s.users}, {"POST /api/admin/users", s.createUser}, {"PATCH /api/admin/users/{userId}", s.updateUser}, {"PUT /api/admin/users/{userId}/security", s.userSecurity}, {"POST /api/admin/users/{userId}/disconnect", s.disconnectUser},
		{"GET /api/admin/plans", s.plans}, {"POST /api/admin/plans", s.createPlan}, {"PATCH /api/admin/plans/{planId}", s.updatePlan}, {"PUT /api/admin/plans/{planId}/security", s.updatePlan},
		{"GET /api/admin/subscriptions", s.subscriptions}, {"POST /api/admin/subscriptions", s.createSubscription}, {"PATCH /api/admin/subscriptions/{subscriptionId}", s.updateSubscription}, {"POST /api/admin/subscriptions/{subscriptionId}/renew", s.updateSubscription}, {"POST /api/admin/subscriptions/{subscriptionId}/change-plan", s.updateSubscription}, {"POST /api/admin/subscriptions/{subscriptionId}/reset-traffic", s.resetTraffic}, {"GET /api/admin/subscriptions/{subscriptionId}/nodes", s.subscriptionNodes}, {"PUT /api/admin/subscriptions/{subscriptionId}/nodes", s.subscriptionNodes}, {"POST /api/admin/subscriptions/{subscriptionId}/convert-to-team", s.convertSubscription},
		{"GET /api/admin/teams", s.teams}, {"POST /api/admin/teams", s.createTeam}, {"PATCH /api/admin/teams/{teamId}", s.updateTeam}, {"POST /api/admin/teams/{teamId}/members", s.addMember}, {"PATCH /api/admin/teams/{teamId}/members/{memberId}", s.updateMember}, {"DELETE /api/admin/teams/{teamId}/members/{memberId}", s.removeMember}, {"POST /api/admin/teams/{teamId}/members/{memberId}/kick", s.kickMember}, {"POST /api/admin/teams/{teamId}/subscriptions", s.createSubscription}, {"GET /api/admin/teams/{teamId}/usage", s.teamUsage},
		{"GET /api/admin/nodes", s.nodes}, {"PATCH /api/admin/nodes/{nodeId}", s.updateNode}, {"DELETE /api/admin/nodes/{nodeId}", s.deleteNode}, {"POST /api/admin/nodes/{nodeId}/probe", s.probeNode}, {"POST /api/admin/nodes/probe-all", s.probeNodes},
		{"GET /api/admin/announcements", s.adminAnnouncements}, {"POST /api/admin/announcements", s.writeAnnouncement}, {"PATCH /api/admin/announcements/{announcementId}", s.writeAnnouncement}, {"DELETE /api/admin/announcements/{announcementId}", s.deleteAnnouncement},
		{"GET /api/admin/policies", s.policy}, {"PATCH /api/admin/policies", s.savePolicy},
		{"GET /api/admin/site-address", s.siteAddress}, {"PUT /api/admin/site-address", s.saveSiteAddress},
		{"GET /api/admin/presence", s.presence},
		{"POST /api/admin/nodes/lease-revocation-jobs/{jobId}/retry", s.retryRevocationJob},
		{"GET /api/admin/users/{userId}/routing-rules", s.routingRules},
		{"GET /api/admin/support-integration", s.supportConfig}, {"PUT /api/admin/support-integration", s.saveSupportConfig}, {"POST /api/admin/support-integration/test", s.testSupport},
		{"POST /api/admin/tickets/{ticketId}/replies", s.replyTicket}, {"POST /api/admin/tickets/{ticketId}/attachments", s.uploadTicketAttachment},
		{"GET /api/admin/tickets", s.tickets}, {"GET /api/admin/tickets/{ticketId}", s.ticket}, {"POST /api/admin/tickets/{ticketId}/read", s.readTicket}, {"POST /api/admin/tickets/{ticketId}/close", s.closeTicket}, {"POST /api/admin/tickets/{ticketId}/reopen", s.closeTicket},
	}
	for _, route := range routes {
		s.handle(mux, route.pattern, "admin", route.fn)
	}
	s.agentRoutes(mux)
}
func (s *Server) me(_ http.ResponseWriter, _ *http.Request, user Object) (any, error) {
	return pick(user, "id", "email", "displayName", "role", "status", "lastSeenAt"), nil
}
func (s *Server) dashboard(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	result, err := one(r.Context(), s.DB, `SELECT jsonb_build_object('users',(SELECT count(*) FROM "User"),'teams',(SELECT count(*) FROM "Team"),'activeSubscriptions',(SELECT count(*) FROM "Subscription" WHERE state='active' AND "expireAt">now() AND "remainingTrafficGb">0),'activeNodes',(SELECT count(*) FROM "Node" WHERE "isActive"),'announcements',(SELECT count(*) FROM "Announcement" WHERE "isActive"),'activePlans',(SELECT count(*) FROM "Plan" WHERE "isActive"),'openTickets',(SELECT count(*) FROM "SupportTicket" WHERE status<>'closed'),'waitingAdminTickets',(SELECT count(*) FROM "SupportTicket" WHERE status='waiting_admin'),'closedTickets',(SELECT count(*) FROM "SupportTicket" WHERE status='closed'),'legacyTicketsReadOnly',true)`)
	if err != nil {
		return nil, err
	}
	cfg, err := s.setting(r.Context(), "achord-connect")
	if err != nil {
		return nil, err
	}
	result["legacyTicketsReadOnly"] = supportEnabled(cfg)
	return result, nil

}
func (s *Server) snapshot(w http.ResponseWriter, r *http.Request, u Object) (any, error) {
	out := Object{}
	for key, fn := range map[string]Handler{"leaseRevocationJobs": s.revocationJobs, "nodeCommandQueue": s.commandQueue, "dashboard": s.dashboard, "users": s.users, "plans": s.plans, "subscriptions": s.subscriptions, "teams": s.teams, "nodes": s.nodes, "announcements": s.adminAnnouncements, "policy": s.policy} {
		v, err := fn(w, r, u)
		if err != nil {
			return nil, err
		}
		out[key] = v
	}
	return out, nil
}
