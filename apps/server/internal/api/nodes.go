package api

import (
	"context"
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

const nodeListSQL = `SELECT to_jsonb(n)-'uuid'||jsonb_build_object('agentConfigRevision',n."agentConfigRevision"::text,'inboundAppliedRevision',n."inboundAppliedRevision"::text,'agent',(SELECT to_jsonb(a)-'tokenHash'||jsonb_build_object('lastSequence',a."lastSequence"::text,'lastAckSequence',a."lastAckSequence"::text,'configRevision',a."configRevision"::text) FROM "NodeAgent" a WHERE a."nodeId"=n.id AND a."revokedAt" IS NULL ORDER BY a."lastSeenAt" DESC NULLS LAST,a."createdAt" DESC,a.id DESC LIMIT 1),'clientProbeSummary',(SELECT jsonb_build_object('samples',count(*),'healthy',count(*) FILTER(WHERE p.status='healthy'),'averageLatencyMs',round(avg(p."latencyMs") FILTER(WHERE p.status='healthy')),'checkedAt',max(p."checkedAt")) FROM "ClientNodeProbe" p WHERE p."nodeId"=n.id AND p."checkedAt">now()-interval '15 minutes')) FROM "Node" n`

func (s *Server) nodes(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	return list(r.Context(), s.DB, nodeListSQL+` ORDER BY n."createdAt" DESC`)
}
func (s *Server) updateNode(w http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	input, err = validateNodePatchInput(input)
	if err != nil {
		return nil, err
	}
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(r.Context())
	if err = lockRuntimeScope(r.Context(), tx, "nodeId", r.PathValue("nodeId")); err != nil {
		return nil, err
	}
	node, err := one(r.Context(), tx, `SELECT to_jsonb(n) FROM "Node" n WHERE id=$1 FOR UPDATE`, r.PathValue("nodeId"))
	if err != nil {
		return nil, err
	}
	active := node["isActive"] == true
	nextActive, activeProvided := input["isActive"].(bool)
	if !activeProvided {
		nextActive = active
	}
	if nextActive && !nodePatchOnboardingReady(node) {
		return nil, fail(400, "节点尚未完成 Agent 注册或入站配置，不能启用。")
	}
	activeChanged := activeProvided && active != nextActive
	metadataProvided := len(pick(input, "name", "countryCode", "region", "provider", "tags", "recommended")) > 0
	normalizeNodePatchMetadata(input, node)
	if len(input) > 0 {
		if _, err = update(r.Context(), tx, "Node", r.PathValue("nodeId"), input, "name", "countryCode", "region", "provider", "tags", "isActive", "recommended"); err != nil {
			return nil, err
		}
	}
	if activeChanged && !nextActive {
		if _, err = s.revokeLeases(r.Context(), tx, "nodeId", r.PathValue("nodeId"), "node_disabled"); err != nil {
			return nil, err
		}
	}
	if activeChanged && nextActive {
		if err = s.syncNodeSubscriptions(r.Context(), tx, r.PathValue("nodeId")); err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	if activeChanged || metadataProvided {
		s.changed("nodes", "")
	}
	return one(r.Context(), s.DB, nodeListSQL+` WHERE n.id=$1`, r.PathValue("nodeId"))
}
func (s *Server) deleteNode(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(r.Context())
	if err = lockRuntimeScope(r.Context(), tx, "nodeId", r.PathValue("nodeId")); err != nil {
		return nil, err
	}
	id := r.PathValue("nodeId")
	if _, err = one(r.Context(), tx, `SELECT to_jsonb(n) FROM "Node" n WHERE id=$1 FOR UPDATE`, id); err != nil {
		return nil, err
	}
	if _, err = update(r.Context(), tx, "Node", id, Object{"isActive": false}, "isActive"); err != nil {
		return nil, err
	}
	if _, err = s.revokeLeases(r.Context(), tx, "nodeId", id, "node_deleted"); err != nil {
		return nil, err
	}
	bindings, err := list(r.Context(), tx, `SELECT to_jsonb(b) FROM "PanelClientBinding" b WHERE "nodeId"=$1 AND source='direct' AND status IN('active','disabled') FOR UPDATE`, id)
	if err != nil {
		return nil, err
	}
	for _, binding := range bindings {
		if err = assertTerminalSettled(r.Context(), tx, binding); err != nil {
			if err != errResetSettling {
				return nil, err
			}
			if err = tx.Commit(r.Context()); err != nil {
				return nil, err
			}
			s.changed("nodes", "")
			return nil, fail(409, "节点账号正在停用并结算最终流量，完成后可再次删除")
		}
	}
	tag, err := tx.Exec(r.Context(), `DELETE FROM "Node" WHERE id=$1`, id)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, pgx.ErrNoRows
	}
	if err = tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	s.changed("nodes", "")
	return Object{"ok": true}, nil
}
func probeLocal(ctx context.Context, node Object, production ...bool) (Object, error) {
	host := text(node, "serverHost")
	if !nodeHostAllowed(host, len(production) > 0 && production[0]) {
		return nil, fail(403, "本地调试只允许检测回环地址节点，不连接线上节点")
	}
	started := time.Now()
	dialer := net.Dialer{Timeout: 3 * time.Second}
	connection, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(int(number(node, "serverPort")))))
	out := Object{"nodeId": node["id"], "checkedAt": now(), "status": "healthy", "latencyMs": float64(time.Since(started).Milliseconds() + 1), "error": nil}
	if err != nil {
		out["status"] = "offline"
		out["latencyMs"] = nil
		out["error"] = "节点 TCP 连接失败"
	} else {
		connection.Close()
	}
	return out, nil
}
func (s *Server) probeNode(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	node, err := one(r.Context(), s.DB, `SELECT to_jsonb(n) FROM "Node" n WHERE id=$1`, r.PathValue("nodeId"))
	if err != nil {
		return nil, err
	}
	result, err := probeLocal(r.Context(), node, s.Config.Production())
	if err != nil {
		return nil, err
	}
	if _, err = s.DB.Exec(r.Context(), `UPDATE "Node" SET "probeStatus"=$2::"NodeProbeStatus","probeLatencyMs"=$3,"probeCheckedAt"=now(),"probeError"=$4,"updatedAt"=now() WHERE id=$1`, node["id"], result["status"], result["latencyMs"], result["error"]); err != nil {
		return nil, err
	}
	s.changed("nodes", "")
	return one(r.Context(), s.DB, nodeListSQL+` WHERE n.id=$1`, node["id"])
}
func (s *Server) probeNodes(w http.ResponseWriter, r *http.Request, u Object) (any, error) {
	nodes, err := list(r.Context(), s.DB, `SELECT to_jsonb(n) FROM "Node" n WHERE "isActive"`)
	if err != nil {
		return nil, err
	}
	for _, node := range nodes {
		if !nodeHostAllowed(text(node, "serverHost"), s.Config.Production()) {
			return nil, fail(403, "存在非本地节点，拒绝批量检测")
		}
	}
	out := []Object{}
	for _, node := range nodes {
		r.SetPathValue("nodeId", text(node, "id"))
		value, err := s.probeNode(w, r, u)
		if err != nil {
			return nil, err
		}
		out = append(out, value.(Object))
	}
	return out, nil
}
func (s *Server) clientProbes(w http.ResponseWriter, r *http.Request, user Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	ids, err := stringArray(input["nodeIds"], 32)
	if err != nil {
		return nil, err
	}
	allowed, err := s.clientNodes(w, r, user)
	if err != nil {
		return nil, err
	}
	byID := map[string]Object{}
	for _, node := range allowed.([]Object) {
		byID[text(node, "id")] = node
	}
	out := []Object{}
	for _, id := range ids {
		node, ok := byID[id]
		if !ok {
			return nil, fail(403, "节点未授权")
		}
		result, err := probeLocal(r.Context(), node, s.Config.Production())
		if err != nil {
			return nil, err
		}
		out = append(out, result)
	}
	return out, nil
}
func (s *Server) reportProbes(w http.ResponseWriter, r *http.Request, user Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	results, ok := input["results"].([]any)
	if !ok || len(results) > 32 {
		return nil, fail(400, "检测结果格式无效")
	}
	allowed, err := s.clientNodes(w, r, user)
	if err != nil {
		return nil, err
	}
	ids := map[string]bool{}
	for _, node := range allowed.([]Object) {
		ids[text(node, "id")] = true
	}
	seen := map[string]bool{}
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(r.Context())
	for _, raw := range results {
		result, ok := raw.(map[string]any)
		if !ok {
			return nil, fail(400, "检测结果格式无效")
		}
		id := text(result, "nodeId")
		if !ids[id] || seen[id] {
			return nil, fail(403, "检测结果包含未授权或重复节点")
		}
		seen[id] = true
		var latency any
		if result["status"] == "healthy" {
			latency = number(result, "latencyMs")
			if latency.(float64) < 1 || latency.(float64) > 60000 {
				return nil, fail(400, "延迟值无效")
			}
		} else if result["status"] != "offline" {
			return nil, fail(400, "检测状态无效")
		}
		if _, err = tx.Exec(r.Context(), `INSERT INTO "ClientNodeProbe"("userId","nodeId",status,"latencyMs","checkedAt") VALUES($1,$2,$3,$4,now()) ON CONFLICT("userId","nodeId") DO UPDATE SET status=EXCLUDED.status,"latencyMs"=EXCLUDED."latencyMs","checkedAt"=now()`, user["id"], id, result["status"], latency); err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	s.changed("nodes", "")
	return Object{"ok": true}, nil
}
func (s *Server) presence(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	timing, err := s.Config.SessionLeaseTiming()
	if err != nil {
		return nil, err
	}
	cutoff, err := s.leaseCutoff(time.Now())
	if err != nil {
		return nil, err
	}
	users, err := list(r.Context(), s.DB, `SELECT jsonb_build_object('userId',u.id,'displayName',u."displayName",'email',u.email,'teamId',t.id,'teamName',t.name,'state',CASE WHEN EXISTS(SELECT 1 FROM "NodeSessionLease" l WHERE l."userId"=u.id AND l.status='active' AND l."expiresAt">$1) THEN 'connected' WHEN p."lastSeenAt">now()-interval '150 seconds' THEN 'online' ELSE 'offline' END,'onlineSince',p."onlineSince",'lastOnlineAt',p."lastSeenAt",'client',(SELECT to_jsonb(v)-'userId'-'createdAt'-'updatedAt' FROM "UserClientVersion" v WHERE v."userId"=u.id ORDER BY v."lastSeenAt" DESC LIMIT 1),'sessions',coalesce((SELECT jsonb_agg(jsonb_build_object('sessionId',l."sessionId",'connectedAt',l."issuedAt",'lastHeartbeatAt',l."lastHeartbeatAt",'connectionMode',l."connectionMode",'node',jsonb_build_object('id',n.id,'name',n.name,'region',n.region,'countryCode',n."countryCode",'provider',n.provider,'protocol',n.protocol,'security',n.security),'subscription',to_jsonb(s)||jsonb_build_object('ownerType',CASE WHEN s."teamId" IS NULL THEN 'user' ELSE 'team' END,'teamName',t.name,'planName',pl.name))) FROM "NodeSessionLease" l JOIN "Node" n ON n.id=l."nodeId" JOIN "Subscription" s ON s.id=l."subscriptionId" JOIN "Plan" pl ON pl.id=s."planId" WHERE l."userId"=u.id AND l.status='active' AND l."expiresAt">$1),'[]'::jsonb)) FROM "User" u JOIN "UserClientPresence" p ON p."userId"=u.id LEFT JOIN "TeamMember" m ON m."userId"=u.id LEFT JOIN "Team" t ON t.id=m."teamId" ORDER BY p."lastSeenAt" DESC`, cutoff)
	if err != nil {
		return nil, err
	}
	online, connected := 0, 0
	for _, user := range users {
		if user["state"] != "offline" {
			online++
		}
		if user["state"] == "connected" {
			connected++
		}
	}
	return Object{"generatedAt": now(), "connectedWindowSeconds": timing.TTLSeconds + timing.GraceSeconds, "onlineWindowSeconds": 150, "counts": Object{"online": online, "connected": connected, "idle": online - connected}, "users": users}, nil
}
