package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *Server) queueCommand(w http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	if err = enum(input, "type", "ENSURE_USER", "ENABLE_USER", "DISABLE_USER", "REMOVE_USER", "RECONCILE_USERS", "REFRESH_QUOTA", "ENSURE_INBOUND"); err != nil {
		return nil, err
	}
	if err = requireText(input, "type"); err != nil {
		return nil, err
	}
	payload, ok := input["payload"].(map[string]any)
	if !ok {
		return nil, fail(400, "命令 payload 无效")
	}
	if input["type"] == "ENSURE_INBOUND" {
		payload, err = normalizeInbound(payload, s.Config.Production())
		if err != nil {
			return nil, err
		}
	}
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(r.Context())
	node, err := one(r.Context(), tx, `SELECT to_jsonb(n)||jsonb_build_object('inboundAppliedRevision',"inboundAppliedRevision"::text) FROM "Node" n WHERE id=$1 FOR UPDATE`, r.PathValue("nodeId"))
	if err != nil {
		return nil, err
	}
	if input["type"] == "ENSURE_INBOUND" && node["isActive"] == true {
		return nil, fail(400, "节点已激活，请先停用再校验入站")
	}
	if expected := text(input, "expectedInboundAppliedRevision"); expected != "" && expected != node["inboundAppliedRevision"] {
		return nil, fail(409, "节点入站已变化，请刷新后重试")
	}
	var agentID string
	if err = tx.QueryRow(r.Context(), `SELECT id FROM "NodeAgent" WHERE "nodeId"=$1 AND "revokedAt" IS NULL ORDER BY "createdAt" DESC LIMIT 1`, node["id"]).Scan(&agentID); err != nil {
		return nil, fail(409, "节点尚未注册有效 Agent")
	}
	if dedupe := text(input, "dedupeKey"); dedupe != "" {
		existing, e := existingCommand(r.Context(), tx, dedupe, text(node, "id"), text(input, "type"), payload)
		if e == nil {
			return existing, nil
		}
		if e != pgx.ErrNoRows {
			return nil, e
		}
	}
	var revision string
	if err = tx.QueryRow(r.Context(), `UPDATE "Node" SET "agentConfigRevision"="agentConfigRevision"+1,"updatedAt"=now() WHERE id=$1 RETURNING "agentConfigRevision"::text`, node["id"]).Scan(&revision); err != nil {
		return nil, err
	}
	dedupe := text(input, "dedupeKey")
	if dedupe == "" {
		dedupe = text(node, "id") + ":" + text(input, "type") + ":" + newID()
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	job, err := one(r.Context(), tx, `WITH inserted AS(INSERT INTO "NodeCommandJob"(id,"dedupeKey","nodeId","agentId","commandType","targetRevision",payload,"updatedAt") VALUES($1,$2,$3,$4,$5::"NodeAgentCommandType",$6::bigint,$7::jsonb,now()) ON CONFLICT("dedupeKey") DO UPDATE SET "dedupeKey"=EXCLUDED."dedupeKey" RETURNING *) SELECT jsonb_build_object('commandId',id,'type',"commandType",'targetRevision',"targetRevision"::text,'payload',payload,'createdAt',"createdAt",'nodeId',"nodeId") FROM inserted`, newID(), dedupe, node["id"], agentID, input["type"], revision, raw)
	if err != nil {
		return nil, err
	}
	if text(job, "nodeId") != text(node, "id") || text(job, "type") != text(input, "type") {
		return nil, fail(409, "dedupeKey 已用于其他命令")
	}
	actual, _ := json.Marshal(job["payload"])
	if string(actual) != string(raw) {
		return nil, fail(409, "dedupeKey 正文不一致")
	}
	delete(job, "nodeId")
	if err = notifyCommands(r.Context(), tx, text(node, "id")); err != nil {
		return nil, err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	s.events.publish("agent:"+text(node, "id"), Object{"type": "command_ready"})
	s.changed("nodes", "")
	return job, nil
}
func (s *Server) commandOutcome(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	return one(r.Context(), s.DB, `SELECT jsonb_build_object('status',status,'lastError',"lastError") FROM "NodeCommandJob" WHERE id=$1 AND "nodeId"=$2`, r.PathValue("commandId"), r.PathValue("nodeId"))
}
func (s *Server) commandResult(w http.ResponseWriter, r *http.Request, agent Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	input, err = validateCommandResultInput(input)
	if err != nil {
		return nil, err
	}
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(r.Context())
	job, err := one(r.Context(), tx, `SELECT to_jsonb(j) FROM "NodeCommandJob" j WHERE id=$1 AND "agentId"=$2 AND "nodeId"=$3`, r.PathValue("commandId"), agent["id"], agent["nodeId"])
	if err != nil {
		return nil, err
	}
	if id := text(job, "bindingId"); id != "" {
		if _, err = one(r.Context(), tx, `SELECT to_jsonb(b) FROM "PanelClientBinding" b WHERE id=$1 FOR UPDATE`, id); err != nil {
			return nil, err
		}
	}
	if _, err = one(r.Context(), tx, `SELECT to_jsonb(n) FROM "Node" n WHERE id=$1 FOR UPDATE`, agent["nodeId"]); err != nil {
		return nil, err
	}
	job, err = one(r.Context(), tx, `SELECT to_jsonb(j)||jsonb_build_object('targetRevision',"targetRevision"::text) FROM "NodeCommandJob" j WHERE id=$1 AND "agentId"=$2 AND "nodeId"=$3 FOR UPDATE`, r.PathValue("commandId"), agent["id"], agent["nodeId"])
	if err != nil {
		return nil, err
	}
	if job["status"] == "completed" {
		return Object{"accepted": true}, nil
	}
	if job["status"] == "cancelled" {
		return nil, fail(409, "该命令已取消")
	}
	result, _ := input["result"].(map[string]any)
	if result == nil {
		result = Object{}
	}
	data := Object{"status": input["status"], "result": result, "lastError": nil, "nextRunAt": now(), "completedAt": now()}
	if input["status"] == "completed" && job["commandType"] == "ENSURE_INBOUND" {
		frozen, reportErr := s.applyPanelCommandReport(r.Context(), tx, text(agent, "nodeId"), job, result)
		if reportErr != nil {
			return nil, reportErr
		}
		data["payload"], data["dedupeKey"] = frozen, text(job, "dedupeKey")+":done:"+text(job, "id")
	}
	if input["status"] == "failed" {
		data["lastError"] = input["error"]
		if data["lastError"] == nil {
			data["lastError"] = "Agent 执行失败"
		}
		data["completedAt"] = nil
		data["nextRunAt"] = time.Now().UTC().Add(commandRetryDelay(int(number(job, "attempts")))).Format(time.RFC3339Nano)
	}
	if input["status"] == "completed" && (job["commandType"] == "DISABLE_USER" || job["commandType"] == "REMOVE_USER") {
		bindingID := text(job, "bindingId")
		if bindingID != "" {
			if _, ok := result["disableWatermarks"].([]any); !ok {
				return nil, fail(400, "停用账号完成回执必须携带最终结算水位")
			}
		}
		payload, _ := job["payload"].(map[string]any)
		if marks, ok := result["disableWatermarks"].([]any); ok && text(payload, "bindingId") != "" {
			if bindingID != "" && bindingID != text(payload, "bindingId") {
				return nil, fail(409, "停用命令的绑定身份不一致")
			}
			var current bool
			// Old REMOVE_USER transactions persisted the binding as deleted before the Agent reported.
			if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM "PanelClientBinding" WHERE id=$1 AND "directRevision"=$2::bigint AND "nodeId"=$3 AND source='direct' AND (status='disabled' OR (status='deleted' AND $4)))`, payload["bindingId"], job["targetRevision"], agent["nodeId"], job["commandType"] == "REMOVE_USER").Scan(&current); err != nil {
				return nil, err
			}
			if !current {
				return nil, fail(409, "停用命令已被新的绑定代次替代")
			}
			for _, raw := range marks {
				mark, ok := raw.(map[string]any)
				if !ok || text(mark, "bootId") == "" {
					return nil, fail(400, "最终结算水位无效")
				}
				if _, e := decimal(text(mark, "sequenceThrough")); e != nil {
					return nil, e
				}
			}

			if _, err = update(r.Context(), tx, "PanelClientBinding", text(payload, "bindingId"), Object{"directDisableWatermarks": marks}, "directDisableWatermarks"); err != nil {
				return nil, err
			}
		}
	}
	if _, err = update(r.Context(), tx, "NodeCommandJob", text(job, "id"), data, "status", "result", "lastError", "nextRunAt", "completedAt", "payload", "dedupeKey"); err != nil {
		return nil, err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	if input["status"] == "failed" {
		s.scheduleEntity("command", text(job, "id"), time.Now().Add(commandRetryDelay(int(number(job, "attempts")))))
	}
	s.scheduleNodeProvisioning(text(agent, "nodeId"))
	if err = s.resumeTrafficResets(r.Context(), text(agent, "nodeId"), false); err != nil {
		return nil, err
	}
	s.changed("nodes", "")
	s.events.publish(text(job, "userId"), Object{"type": "node_access_updated", "occurredAt": now(), "nodeId": job["nodeId"]})
	return Object{"accepted": true}, nil
}
func (s *Server) agentEvents(w http.ResponseWriter, r *http.Request, agent Object) (any, error) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		return nil, fail(500, "当前连接不支持事件推送")
	}
	channel, unsubscribe := s.events.subscribe("agent:" + text(agent, "nodeId"))
	defer unsubscribe()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("X-Accel-Buffering", "no")
	fmt.Fprint(w, "retry: 3000\n\n")
	flusher.Flush()
	deliver := func() error {
		jobs, err := s.claimAgentCommands(r.Context(), text(agent, "id"))
		if err != nil {
			return err
		}
		for _, job := range jobs {
			retryAt, err := parseTimestamp(text(job, "_retryAt"))
			if err != nil {
				return err
			}
			delete(job, "_retryAt")
			raw, _ := json.Marshal(job)
			if _, err = fmt.Fprintf(w, "id: %s\nevent: command\ndata: %s\n\n", job["commandId"], raw); err != nil {
				return err
			}
			s.scheduleEntity("command", text(job, "commandId"), retryAt)
			flusher.Flush()
		}
		return nil
	}
	if err := deliver(); err != nil {
		return nil, nil
	}
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-s.resyncStop:
			return nil, nil
		case <-r.Context().Done():
			return nil, nil
		case <-channel:
			if _, err := s.authenticateAgent(r); err != nil {
				return nil, nil
			}
			if err := deliver(); err != nil {
				return nil, nil
			}
		case <-ticker.C:
			if _, err := s.authenticateAgent(r); err != nil {
				return nil, nil
			}
			if _, err := fmt.Fprint(w, "event: keepalive\ndata: {}\n\n"); err != nil {
				return nil, nil
			}
			flusher.Flush()
		}
	}
}
