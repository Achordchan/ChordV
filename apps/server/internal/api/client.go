package api

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"net/http"
	"time"
)

func (s *Server) clientRoutes(mux *http.ServeMux) {
	routes := []struct {
		pattern, role string
		fn            Handler
	}{
		{"GET /api/client/bootstrap", "user", s.bootstrap}, {"GET /api/client/subscription", "user", s.clientSubscription}, {"GET /api/client/nodes", "user", s.clientNodes}, {"POST /api/client/nodes/probe-results", "user", s.reportProbes}, {"POST /api/client/nodes/probe", "user", s.clientProbes},
		{"GET /api/client/policies", "user", s.policy}, {"GET /api/client/announcements", "user", s.clientAnnouncements}, {"GET /api/announcements", "user", s.clientAnnouncements}, {"POST /api/client/announcements/read", "user", s.readAnnouncements},
		{"GET /api/client/ping", "", s.ping}, {"GET /api/client/events", "user", s.stream},
		{"GET /api/client/routing-rules", "user", s.routingRules}, {"POST /api/client/routing-rules", "user", s.writeRoutingRule}, {"PATCH /api/client/routing-rules/{ruleId}", "user", s.writeRoutingRule}, {"DELETE /api/client/routing-rules/{ruleId}", "user", s.deleteRoutingRule},
		{"POST /api/client/session/connect", "user", s.connect}, {"POST /api/client/session/heartbeat", "user", s.heartbeat}, {"POST /api/client/session/disconnect", "user", s.disconnect}, {"GET /api/client/runtime", "user", s.runtime},
		{"GET /api/client/site-address", "", s.siteAddress}, {"GET /api/client/support/status", "user", s.supportStatus}, {"POST /api/client/support/launch", "user", s.supportLaunch},
		{"POST /api/client/tickets", "user", s.createTicket}, {"POST /api/client/tickets/{ticketId}/replies", "user", s.replyTicket}, {"POST /api/client/tickets/{ticketId}/attachments/upload", "user", s.uploadTicketAttachment}, {"POST /api/client/tickets/{ticketId}/attachments", "user", s.uploadTicketAttachment},
		{"GET /api/client/tickets", "user", s.tickets}, {"GET /api/client/tickets/{ticketId}", "user", s.ticket}, {"POST /api/client/tickets/{ticketId}/read", "user", s.readTicket},
		{"GET /api/client/update/tauri", "", s.tauriUpdate}, {"GET /api/client/version", "", s.clientVersion}, {"POST /api/client/update/check", "", s.checkUpdate}, {"GET /api/client/releases/history", "", s.releaseHistory}, {"GET /api/client/runtime-components/plan", "", s.componentPlan}, {"POST /api/client/runtime-components/report-failure", "user", s.reportComponentFailure},
	}
	for _, route := range routes {
		s.handle(mux, route.pattern, route.role, route.fn)
	}
}
func (s *Server) resolveSubscription(ctx context.Context, q queryer, userID string) (Object, error) {
	result, err := one(ctx, q, `SELECT to_jsonb(s)-'totalTrafficBytes'-'usedTrafficBytes'||jsonb_build_object('ownerType',CASE WHEN s."teamId" IS NULL THEN 'user' ELSE 'team' END,'planName',p.name,'maxConcurrentSessions',coalesce(u."maxConcurrentSessionsOverride",p."maxConcurrentSessions"),'teamName',t.name,'teamStatus',t.status,'memberRole',m.role,'memberUsedTrafficGb',CASE WHEN s."teamId" IS NULL THEN NULL ELSE coalesce((SELECT sum(l."usedTrafficGb") FROM "TrafficLedger" l WHERE l."subscriptionId"=s.id AND l."userId"=$1),0) END,'state',CASE WHEN s.state IN('paused','expired','exhausted') THEN s.state::text WHEN t.status='disabled' THEN 'paused' WHEN s."expireAt"<=now() THEN 'expired' WHEN s."remainingTrafficGb"<=0 THEN 'exhausted' ELSE s.state::text END) FROM "User" u LEFT JOIN "TeamMember" m ON m."userId"=u.id LEFT JOIN "Team" t ON t.id=m."teamId" JOIN "Subscription" s ON (CASE WHEN m.id IS NULL THEN s."userId"=u.id ELSE s."teamId"=t.id END) JOIN "Plan" p ON p.id=s."planId" WHERE u.id=$1 ORDER BY (s.state='active' AND s."expireAt">now() AND s."remainingTrafficGb">0) DESC,s."expireAt" DESC LIMIT 1`, userID)
	if err == pgx.ErrNoRows {
		return nil, errNoSubscription
	}
	if err != nil {
		return nil, err
	}
	state, err := subscriptionMeteringState(ctx, q, userID, text(result, "id"), time.Now().UTC())
	if err != nil {
		return nil, err
	}
	for key, value := range state {
		result[key] = value
	}
	return result, nil
}
func (s *Server) clientSubscription(_ http.ResponseWriter, r *http.Request, user Object) (any, error) {
	return s.resolveSubscription(r.Context(), s.DB, text(user, "id"))
}
func (s *Server) bootstrap(w http.ResponseWriter, r *http.Request, user Object) (any, error) {
	sub, err := s.resolveSubscription(r.Context(), s.DB, text(user, "id"))
	if err != nil {
		return nil, err
	}
	policy, err := s.policy(w, r, user)
	if err != nil {
		return nil, err
	}
	rules, err := s.routingRules(w, r, user)
	if err != nil {
		return nil, err
	}
	policy.(Object)["customRoutingRules"] = rules
	announcements, err := s.clientAnnouncements(w, r, user)
	if err != nil {
		return nil, err
	}
	var team any
	if sub["teamId"] != nil {
		team = Object{"id": sub["teamId"], "name": sub["teamName"], "status": sub["teamStatus"], "role": sub["memberRole"]}
	}
	inbox, err := one(r.Context(), s.DB, `SELECT jsonb_build_object('totalCount',(SELECT count(*) FROM "SupportTicket" WHERE "userId"=$1),'unreadCount',coalesce((SELECT "unreadCount" FROM "SupportUnreadState" WHERE "userId"=$1),0))`, user["id"])
	if err != nil {
		return nil, err
	}
	version, err := s.bootstrapVersion(r.Context(), r.URL.Query().Get("platform"), r.URL.Query().Get("architecture"))
	if err != nil {
		return nil, err
	}
	return Object{"user": pick(user, "id", "email", "displayName", "role", "status", "lastSeenAt"), "subscription": sub, "policies": policy, "announcements": announcements, "supportTickets": inbox, "version": version, "team": team}, nil
}

const clientNodeSQL = `SELECT jsonb_build_object('id',n.id,'name',n.name,'countryCode',n."countryCode",'region',n.region,'provider',n.provider,'tags',n.tags,'isActive',n."isActive",'recommended',n.recommended,'latencyMs',n."latencyMs",'protocol',n.protocol,'security',n.security,'serverHost',n."serverHost",'serverPort',n."serverPort") FROM "Node" n JOIN "SubscriptionNodeAccess" a ON a."nodeId"=n.id WHERE a."subscriptionId"=$1 AND n."isActive" AND n."controlMode"='direct_primary' AND (n."registrationStatus" IS NULL OR(n."registrationStatus"='agent_ready' AND n."inboundAppliedRevision">0))`

func (s *Server) clientNodes(_ http.ResponseWriter, r *http.Request, user Object) (any, error) {
	sub, err := s.resolveSubscription(r.Context(), s.DB, text(user, "id"))
	if errors.Is(err, errNoSubscription) {
		return []Object{}, nil
	}
	if err != nil {
		return nil, err
	}
	if sub["state"] != "active" {
		return []Object{}, nil
	}
	return list(r.Context(), s.DB, clientNodeSQL+` ORDER BY n.recommended DESC,n."latencyMs" ASC`, sub["id"])
}
func (s *Server) ping(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	if r.Header.Get("Authorization") == "" {
		if err := s.DB.Ping(r.Context()); err != nil {
			return nil, fail(503, "本地数据库不可用")
		}
		return Object{"ok": true, "serverTime": now()}, nil
	}
	user, err := s.authenticate(r)
	if err != nil {
		return nil, err
	}
	query := r.URL.Query()
	if query.Get("version") != "" || query.Get("platform") != "" {
		if err = s.recordClientVersion(r.Context(), user, Object{"platform": query.Get("platform"), "version": query.Get("version"), "build": query.Get("build"), "channel": query.Get("channel")}); err != nil {
			return nil, err
		}
	}
	if err = s.notePresence(r.Context(), text(user, "id"), true); err != nil {
		return nil, err
	}
	return Object{"ok": true, "serverTime": now()}, nil
}

var errNoSubscription = HTTPError{Status: 404, Message: "当前没有可用订阅"}
