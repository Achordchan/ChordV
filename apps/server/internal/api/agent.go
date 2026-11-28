package api

import (
	"net/http"
	"strings"
)

func (s *Server) agentHash(token string) string { return tokenHash(s.Config.AgentPepper + ":" + token) }
func (s *Server) authenticateAgent(r *http.Request) (Object, error) {
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if token == r.Header.Get("Authorization") || !strings.HasPrefix(token, "chordv_agent_") {
		return nil, fail(401, "Agent 凭据无效")
	}
	agent, err := one(r.Context(), s.DB, `SELECT to_jsonb(a)||jsonb_build_object('configRevision',"configRevision"::text,'lastSequence',"lastSequence"::text,'lastAckSequence',"lastAckSequence"::text) FROM "NodeAgent" a WHERE "tokenHash"=$1 AND "revokedAt" IS NULL`, s.agentHash(token))
	if err != nil {
		return nil, fail(401, "Agent 凭据无效")
	}
	return agent, nil
}
func (s *Server) agentHandle(mux *http.ServeMux, pattern string, fn Handler) {
	mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
		agent, err := s.authenticateAgent(r)
		if err != nil {
			writeError(w, err)
			return
		}
		value, err := fn(w, r, agent)
		if err != nil {
			writeError(w, err)
			return
		}
		if value != nil {
			writeJSON(w, 200, value)
		}
	})
}
func (s *Server) agentRoutes(mux *http.ServeMux) {
	for _, route := range []struct {
		p string
		h Handler
	}{
		{"POST /api/admin/nodes/agent-native", s.createAgentNode}, {"GET /api/admin/nodes/{nodeId}/onboarding", s.onboarding}, {"POST /api/admin/nodes/{nodeId}/register-token", s.registerToken}, {"POST /api/admin/nodes/panel-inbound/parse", s.parseInbound}, {"GET /api/admin/nodes/{nodeId}/agents", s.listAgents}, {"POST /api/admin/nodes/{nodeId}/agents/credentials", s.agentCredential}, {"DELETE /api/admin/nodes/{nodeId}/agents/{agentId}/credentials", s.revokeAgent}, {"GET /api/admin/nodes/{nodeId}/inbound-spec", s.inboundSpec}, {"POST /api/admin/nodes/{nodeId}/agent-commands", s.queueCommand}, {"GET /api/admin/nodes/{nodeId}/agent-commands/{commandId}/outcome", s.commandOutcome}, {"GET /api/admin/nodes/node-command-jobs", s.commandQueue}, {"POST /api/admin/nodes/node-command-jobs/{jobId}/retry", s.retryCommand}, {"POST /api/admin/nodes/node-command-jobs/{jobId}/dismiss", s.dismissCommand}, {"GET /api/admin/nodes/lease-revocation-jobs", s.revocationJobs},
	} {
		s.handle(mux, route.p, "admin", route.h)
	}
	s.handle(mux, "POST /api/admin/nodes/{nodeId}/{nodeAction...}", "admin", s.nodeAction)
	s.handle(mux, "POST /api/agent-install/script.sh", "", s.installScript)
	s.handle(mux, "GET /api/agent-download/go/{version}/{arch}", "", s.agentDownload)
	s.handle(mux, "POST /api/agent/v1/register", "", s.registerAgent)
	s.agentHandle(mux, "POST /api/agent/v1/heartbeat", s.agentHeartbeat)
	s.agentHandle(mux, "GET /api/agent/v1/config", s.agentConfig)
	s.agentHandle(mux, "GET /api/agent/v1/whoami", s.whoami)
	s.agentHandle(mux, "GET /api/agent/v1/events", s.agentEvents)
	s.agentHandle(mux, "POST /api/agent/v1/commands/{commandId}/result", s.commandResult)
	s.agentHandle(mux, "POST /api/agent/v1/usage-batches", s.usageBatch)
}
func (s *Server) whoami(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	host := s.requestIP(r)
	return Object{"observedIp": host}, nil
}
func (s *Server) agentHeartbeat(w http.ResponseWriter, r *http.Request, agent Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	if err = requireText(input, "bootId", "version", "configRevision", "xrayStatus"); err != nil {
		return nil, err
	}
	if err = enum(input, "xrayStatus", "unknown", "healthy", "degraded", "offline", "awaiting_inbound"); err != nil {
		return nil, err
	}
	if _, err = decimal(text(input, "configRevision")); err != nil {
		return nil, err
	}
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(r.Context())
	current, err := one(r.Context(), tx, `SELECT to_jsonb(a)||jsonb_build_object('lastAckSequence',"lastAckSequence"::text) FROM "NodeAgent" a WHERE id=$1 AND "revokedAt" IS NULL FOR UPDATE`, agent["id"])
	if err != nil {
		return nil, err
	}
	data := Object{"bootId": input["bootId"], "version": input["version"], "configRevision": input["configRevision"], "queueDepth": input["queueDepth"], "xrayStatus": input["xrayStatus"], "lastSeenAt": now(), "status": "online"}
	if current["bootId"] != input["bootId"] {
		data["lastSequence"] = "0"
		data["lastAckSequence"] = "0"
		current["lastAckSequence"] = "0"
	}
	if _, err = update(r.Context(), tx, "NodeAgent", text(agent, "id"), data, "bootId", "version", "configRevision", "queueDepth", "xrayStatus", "lastSeenAt", "status", "lastSequence", "lastAckSequence"); err != nil {
		return nil, err
	}
	var revision string
	if err = tx.QueryRow(r.Context(), `UPDATE "Node" SET "agentLastSeenAt"=now(),"controlStatus"=$2,"updatedAt"=now() WHERE id=$1 RETURNING "agentConfigRevision"::text`, agent["nodeId"], input["xrayStatus"]).Scan(&revision); err != nil {
		return nil, err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	s.changed("nodes", "")
	return Object{"accepted": true, "serverTime": now(), "configRevision": revision, "ackThrough": current["lastAckSequence"]}, nil
}
func (s *Server) agentConfig(_ http.ResponseWriter, r *http.Request, agent Object) (any, error) {
	node, err := one(r.Context(), s.DB, `SELECT jsonb_build_object('nodeId',id,'revision',"agentConfigRevision"::text,'controlMode',"controlMode") FROM "Node" WHERE id=$1`, agent["nodeId"])
	if err != nil {
		return nil, err
	}
	users, err := list(r.Context(), s.DB, `SELECT jsonb_build_object('bindingId',b.id,'revision',b."directRevision"::text,'email',b."panelClientEmail",'uuid',b."panelClientId",'flow',n.flow,'enabled',(b.status='active' AND s.state='active' AND s."expireAt">now() AND n."isActive" AND u.status='active' AND (t.id IS NULL OR t.status='active')),'quotaRemainingBytes',greatest(0,s."totalTrafficBytes"-s."usedTrafficBytes")::text,'offlineAllowanceBytes','67108864') FROM "PanelClientBinding" b JOIN "Node" n ON n.id=b."nodeId" JOIN "Subscription" s ON s.id=b."subscriptionId" JOIN "User" u ON u.id=b."userId" LEFT JOIN "Team" t ON t.id=s."teamId" WHERE b."nodeId"=$1 AND b.source='direct' AND b.status='active' ORDER BY b.id`, agent["nodeId"])
	if err != nil {
		return nil, err
	}
	node["users"] = users
	return node, nil
}
