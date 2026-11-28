package api

import (
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *Server) createAgentNode(w http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	input, err = normalizeAgentNodeCreateInput(input)
	if err != nil {
		return nil, err
	}
	spec := Object{"mode": "awaiting_panel", "activateOnFirstValidation": true}
	if raw, ok := input["panelInbound"].(map[string]any); ok {
		spec, err = normalizeInbound(raw, s.Config.Production())
		if err != nil {
			return nil, err
		}
		spec["activateOnFirstValidation"] = true
	}
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(r.Context())
	data := pick(input, "name", "countryCode", "region", "provider", "tags", "recommended")
	for key, value := range (Object{"onboardingSpec": spec, "isActive": false, "latencyMs": 0, "protocol": "vless", "security": "reality", "serverHost": "pending-agent", "serverPort": 0, "uuid": newID(), "flow": "", "realityPublicKey": "", "shortId": "", "serverName": "", "fingerprint": "chrome", "spiderX": "/", "mldsa65Verify": "", "controlMode": "direct_primary", "controlStatus": "pending_register", "registrationStatus": "pending_register"}) {
		data[key] = value
	}
	node, err := insert(r.Context(), tx, "Node", data)
	if err != nil {
		return nil, err
	}
	token := "chordv_register_" + randomToken()
	expires := time.Now().UTC().Add(24 * time.Hour)
	if _, err = tx.Exec(r.Context(), `INSERT INTO "AgentRegisterToken"(id,"nodeId","tokenHash","tokenPrefix","expiresAt") VALUES($1,$2,$3,$4,$5)`, newID(), node["id"], s.agentHash(token), token[:24], expires); err != nil {
		return nil, err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	delete(node, "uuid")
	s.changed("nodes", "")
	return Object{"node": node, "registerToken": token, "registerTokenExpiresAt": expires.Format(time.RFC3339Nano)}, nil
}
func (s *Server) registerToken(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(r.Context())
	node, err := one(r.Context(), tx, `SELECT to_jsonb(n) FROM "Node" n WHERE id=$1 FOR UPDATE`, r.PathValue("nodeId"))
	if err != nil {
		return nil, err
	}
	if node["registrationStatus"] != "pending_register" {
		return nil, fail(409, "仅待注册节点可重新生成令牌")
	}
	token := "chordv_register_" + randomToken()
	expires := time.Now().UTC().Add(24 * time.Hour)
	if _, err = tx.Exec(r.Context(), `UPDATE "AgentRegisterToken" SET "usedAt"=now() WHERE "nodeId"=$1 AND "usedAt" IS NULL`, node["id"]); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(r.Context(), `INSERT INTO "AgentRegisterToken"(id,"nodeId","tokenHash","tokenPrefix","expiresAt") VALUES($1,$2,$3,$4,$5)`, newID(), node["id"], s.agentHash(token), token[:24], expires); err != nil {
		return nil, err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	return Object{"token": token, "expiresAt": expires.Format(time.RFC3339Nano)}, nil
}
func (s *Server) registerAgent(w http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	if err = requireText(input, "registerToken", "agentToken", "bootId", "agentVersion", "hostname", "arch"); err != nil {
		return nil, err
	}
	if err = enum(input, "arch", "linux-x64", "linux-arm64"); err != nil {
		return nil, err
	}
	if !strings.HasPrefix(text(input, "agentVersion"), "go-") {
		return nil, fail(400, "新节点必须使用 Go Agent")
	}
	if !regexp.MustCompile(`^chordv_agent_[A-Za-z0-9_-]{43,128}$`).MatchString(text(input, "agentToken")) {
		return nil, fail(400, "Agent 凭据格式无效")
	}
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(r.Context())
	record, err := one(r.Context(), tx, `SELECT to_jsonb(t) FROM "AgentRegisterToken" t WHERE "tokenHash"=$1 FOR UPDATE`, s.agentHash(text(input, "registerToken")))
	if err == pgx.ErrNoRows {
		return nil, fail(401, "注册令牌无效")
	}
	if err != nil {
		return nil, err
	}
	existing, err := one(r.Context(), tx, `SELECT to_jsonb(a) FROM "NodeAgent" a WHERE "tokenHash"=$1 AND "revokedAt" IS NULL`, s.agentHash(text(input, "agentToken")))
	if err == nil {
		if existing["nodeId"] != record["nodeId"] {
			return nil, fail(401, "Agent 凭据已绑定其他节点")
		}
		return Object{"accepted": true, "agentId": existing["agentId"], "nodeId": existing["nodeId"]}, nil
	}
	if err != pgx.ErrNoRows {
		return nil, err
	}
	expires, _ := time.Parse(time.RFC3339, text(record, "expiresAt"))
	if record["usedAt"] != nil || !expires.After(time.Now()) {
		return nil, fail(401, "注册令牌已使用或已过期")
	}
	node, err := one(r.Context(), tx, `SELECT to_jsonb(n) FROM "Node" n WHERE id=$1 AND "registrationStatus"='pending_register' FOR UPDATE`, record["nodeId"])
	if err != nil {
		return nil, fail(401, "节点不处于待注册状态")
	}
	storedSpec, _ := node["onboardingSpec"].(map[string]any)
	if storedSpec["mode"] == "validate_panel" {
		if !tagPattern.MatchString(text(input, "xrayInboundTag")) {
			return nil, fail(400, "缺少安装器核实的实际入站标签")
		}
		if storedSpec["tagOverrideConfirmed"] == true && storedSpec["inboundTag"] != input["xrayInboundTag"] {
			return nil, fail(400, "Agent 实际标签与确认目标不一致")
		}
		storedSpec["inboundTag"] = input["xrayInboundTag"]
		storedSpec["tagOverrideConfirmed"] = true
		if _, err = update(r.Context(), tx, "Node", text(node, "id"), Object{"onboardingSpec": storedSpec}, "onboardingSpec"); err != nil {
			return nil, err
		}
	}
	agent, err := insert(r.Context(), tx, "NodeAgent", Object{"agentId": "agent-" + newID(), "nodeId": node["id"], "tokenHash": s.agentHash(text(input, "agentToken")), "tokenPrefix": text(input, "agentToken")[:20], "version": input["agentVersion"], "bootId": input["bootId"], "status": "online", "lastSeenAt": now()})
	if err != nil {
		return nil, err
	}
	if _, err = tx.Exec(r.Context(), `UPDATE "AgentRegisterToken" SET "usedAt"=now() WHERE id=$1`, record["id"]); err != nil {
		return nil, err
	}
	if _, err = update(r.Context(), tx, "Node", text(node, "id"), Object{"registrationStatus": "agent_ready", "agentLastSeenAt": now()}, "registrationStatus", "agentLastSeenAt"); err != nil {
		return nil, err
	}
	if storedSpec["mode"] == "validate_panel" {
		if err = s.queueInitialValidation(r.Context(), tx, node, agent, storedSpec); err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	s.changed("nodes", "")
	return Object{"accepted": true, "agentId": agent["agentId"], "nodeId": node["id"]}, nil
}
func (s *Server) listAgents(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	return list(r.Context(), s.DB, `SELECT to_jsonb(a)-'tokenHash'||jsonb_build_object('lastSequence',"lastSequence"::text,'lastAckSequence',"lastAckSequence"::text,'configRevision',"configRevision"::text) FROM "NodeAgent" a WHERE "nodeId"=$1 ORDER BY "createdAt" DESC`, r.PathValue("nodeId"))
}
func (s *Server) agentCredential(w http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(r.Context())
	if _, err = one(r.Context(), tx, `SELECT to_jsonb(n) FROM "Node" n WHERE id=$1 FOR UPDATE`, r.PathValue("nodeId")); err != nil {
		return nil, err
	}
	token := "chordv_agent_" + randomToken()
	agentID := text(input, "agentId")
	if agentID == "" {
		agentID = "agent-" + newID()
	}
	if _, err = tx.Exec(r.Context(), `UPDATE "NodeAgent" SET "revokedAt"=now(),status='revoked',"updatedAt"=now() WHERE "nodeId"=$1 AND "revokedAt" IS NULL`, r.PathValue("nodeId")); err != nil {
		return nil, err
	}
	record, err := insert(r.Context(), tx, "NodeAgent", Object{"nodeId": r.PathValue("nodeId"), "agentId": agentID, "tokenHash": s.agentHash(token), "tokenPrefix": token[:20]})
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	delete(record, "tokenHash")
	record["token"] = token
	return record, nil
}
func (s *Server) revokeAgent(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	tag, err := s.DB.Exec(r.Context(), `UPDATE "NodeAgent" SET "revokedAt"=now(),status='revoked',"updatedAt"=now() WHERE id=$1 AND "nodeId"=$2 AND "revokedAt" IS NULL`, r.PathValue("agentId"), r.PathValue("nodeId"))
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, pgx.ErrNoRows
	}
	return Object{"revoked": true}, nil
}
func (s *Server) onboarding(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	node, err := one(r.Context(), s.DB, nodeListSQL+` WHERE n.id=$1`, r.PathValue("nodeId"))
	if err != nil {
		return nil, err
	}
	job, err := one(r.Context(), s.DB, `SELECT to_jsonb(j)||jsonb_build_object('targetRevision',"targetRevision"::text) FROM "NodeCommandJob" j WHERE "nodeId"=$1 AND "commandType"='ENSURE_INBOUND' ORDER BY "targetRevision" DESC LIMIT 1`, node["id"])
	if err != nil && err != pgx.ErrNoRows {
		return nil, err
	}
	mode := "environment"
	spec, _ := node["onboardingSpec"].(map[string]any)
	if spec["mode"] == "validate_panel" {
		mode = "panel"
	}
	var ready bool
	if agent, ok := node["agent"].(map[string]any); ok {
		last, _ := time.Parse(time.RFC3339, text(agent, "lastSeenAt"))
		ready = time.Since(last) < time.Minute && (agent["xrayStatus"] == "healthy" || agent["xrayStatus"] == "awaiting_inbound")
	}
	return Object{"node": node, "mode": mode, "environmentReady": ready, "spec": spec, "command": job}, nil
}
func (s *Server) inboundSpec(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	record, err := one(r.Context(), s.DB, `SELECT jsonb_build_object('spec',j.payload) FROM "NodeCommandJob" j JOIN "Node" n ON n.id=j."nodeId" AND n."inboundAppliedRevision"=j."targetRevision" WHERE n.id=$1 AND j."commandType"='ENSURE_INBOUND' AND j.status='completed' ORDER BY j."createdAt" DESC LIMIT 1`, r.PathValue("nodeId"))
	if err == pgx.ErrNoRows {
		return Object{"spec": nil}, nil
	}
	return record, err
}
