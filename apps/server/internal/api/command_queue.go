package api

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5"
)

const outstandingCommand = `(j.status IN('pending','running','failed') OR(j.status='cancelled' AND j."resolvedAt" IS NULL))`

func (s *Server) commandQueue(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	jobs, err := list(r.Context(), s.DB, `SELECT to_jsonb(j)-'payload'-'result'||jsonb_build_object(
		'targetRevision',j."targetRevision"::text,'nodeName',n.name,
		'retryable',(j.status='cancelled' AND j."resolvedAt" IS NULL AND j."commandType" IN('ENSURE_USER','ENABLE_USER') AND EXISTS(SELECT 1 FROM "PanelClientBinding" b WHERE b.id=j."bindingId" AND b.status='active')),
		'dismissible',(j.status='cancelled' AND j."resolvedAt" IS NULL))
		FROM "NodeCommandJob" j JOIN "Node" n ON n.id=j."nodeId" WHERE `+outstandingCommand+`
		AND ($1='' OR j."nodeId"=$1) AND ($2='' OR j."subscriptionId"=$2) AND ($3='' OR j."userId"=$3) AND ($4='' OR j."teamId"=$4)
		ORDER BY j.status,j."nextRunAt",j."createdAt" DESC LIMIT 200`, r.URL.Query().Get("nodeId"), r.URL.Query().Get("subscriptionId"), r.URL.Query().Get("userId"), r.URL.Query().Get("teamId"))
	if err != nil {
		return nil, err
	}
	summaries := Object{}
	for key, column := range map[string]string{"nodes": "nodeId", "subscriptions": "subscriptionId", "users": "userId", "teams": "teamId"} {
		summary, err := list(r.Context(), s.DB, `SELECT jsonb_build_object('key',j.`+quote(column)+`,'pending',count(*) FILTER(WHERE j.status='pending'),'running',count(*) FILTER(WHERE j.status='running'),'failed',count(*) FILTER(WHERE j.status IN('failed','cancelled')),'total',count(*),'lastError',(array_agg(j."lastError" ORDER BY j."createdAt" DESC) FILTER(WHERE j."lastError" IS NOT NULL))[1]) FROM "NodeCommandJob" j WHERE `+outstandingCommand+` AND j.`+quote(column)+` IS NOT NULL GROUP BY j.`+quote(column)+` ORDER BY j.`+quote(column))
		if err != nil {
			return nil, err
		}
		summaries[key] = summary
	}
	return Object{"jobs": jobs, "summaries": summaries}, nil
}
func (s *Server) retryCommand(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(r.Context())
	job, err := one(r.Context(), tx, `SELECT to_jsonb(j) FROM "NodeCommandJob" j WHERE id=$1 AND status='cancelled' AND "resolvedAt" IS NULL`, r.PathValue("jobId"))
	if err != nil {
		return nil, err
	}
	if text(job, "bindingId") == "" || text(job, "subscriptionId") == "" || (job["commandType"] != "ENSURE_USER" && job["commandType"] != "ENABLE_USER") {
		return nil, fail(409, "该类命令不支持重试，请标记已处理")
	}
	if err = lockRuntimeScope(r.Context(), tx, "subscriptionId", text(job, "subscriptionId")); err != nil {
		return nil, err
	}
	binding, err := one(r.Context(), tx, `SELECT to_jsonb(b) FROM "PanelClientBinding" b WHERE id=$1 FOR UPDATE`, job["bindingId"])
	if err != nil {
		return nil, err
	}
	node, err := one(r.Context(), tx, `SELECT to_jsonb(n)||jsonb_build_object('retryReady',
		n."isActive" AND n."controlMode"='direct_primary' AND btrim(n."serverHost")<>'' AND lower(btrim(n."serverHost"))<>'pending-agent' AND n."serverPort" BETWEEN 1 AND 65535
		AND (n."registrationStatus" IS NULL OR(n."registrationStatus"='agent_ready' AND n."inboundAppliedRevision">0 AND n.protocol='vless' AND n.security='reality' AND btrim(n.uuid)<>'' AND btrim(n."realityPublicKey")<>'' AND btrim(n."serverName")<>'' AND btrim(n.fingerprint)<>''))
		AND EXISTS(SELECT 1 FROM "NodeAgent" a WHERE a."nodeId"=n.id AND a."revokedAt" IS NULL)) FROM "Node" n WHERE n.id=$1 FOR UPDATE`, job["nodeId"])
	if err != nil {
		return nil, err
	}
	// Keep subscription -> binding -> node -> command ordering. A second
	// concurrent retry must re-read the first one's committed resolution.
	job, err = one(r.Context(), tx, `SELECT to_jsonb(j) FROM "NodeCommandJob" j WHERE id=$1 AND status='cancelled' AND "resolvedAt" IS NULL FOR UPDATE`, r.PathValue("jobId"))
	if err != nil {
		return nil, err
	}
	if binding["status"] != "active" || binding["nodeId"] != job["nodeId"] || binding["subscriptionId"] != job["subscriptionId"] {
		return nil, fail(409, "该用户在此节点已停用或移除，请标记已处理")
	}
	if node["retryReady"] != true {
		return nil, fail(409, "节点未启用或尚未就绪，暂时无法重试")
	}
	sub, e := s.resolveSubscription(r.Context(), tx, text(binding, "userId"))
	if e != nil || sub["id"] != binding["subscriptionId"] || sub["state"] != "active" {
		return nil, fail(409, "订阅或团队授权已变化")
	}
	if err = s.assertNoTrafficReset(r.Context(), tx, text(sub, "id")); err != nil {
		return nil, err
	}
	var usable bool
	if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM "SubscriptionNodeAccess" a JOIN "User" u ON u.id=$3 WHERE a."subscriptionId"=$1 AND a."nodeId"=$2 AND u.status='active')`, binding["subscriptionId"], binding["nodeId"], binding["userId"]).Scan(&usable); err != nil {
		return nil, err
	}
	if !usable {
		return nil, fail(409, "账号或节点授权已变化")
	}
	if _, err = s.queueBinding(r.Context(), tx, binding, "ENSURE_USER"); err != nil {
		return nil, err
	}
	if _, err = update(r.Context(), tx, "NodeCommandJob", text(job, "id"), Object{"resolvedAt": now()}, "resolvedAt"); err != nil {
		return nil, err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	s.events.publish("agent:"+text(job, "nodeId"), Object{"type": "command_ready"})
	return s.commandQueueAfterMutation(r, "retry")
}

func (s *Server) commandQueueAfterMutation(r *http.Request, action string) (any, error) {
	s.events.publish("admin", Object{"type": "sync_queue_updated", "occurredAt": now()})
	// Action responses replace the global queue; scoped details use GET.
	read := r.Clone(r.Context())
	read.URL.RawQuery = ""
	queue, err := s.commandQueue(nil, read, nil)
	if err != nil {
		// The write already committed. Preserve the old null/reload contract
		// instead of reporting a mutation failure that invites duplicate retry.
		slog.Warn("节点命令已保存，但队列刷新失败", "action", action, "error", err)
		return json.RawMessage("null"), nil
	}
	return queue, nil
}
func (s *Server) dismissCommand(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	tag, err := s.DB.Exec(r.Context(), `UPDATE "NodeCommandJob" SET "resolvedAt"=now(),"updatedAt"=now() WHERE id=$1 AND status='cancelled' AND "resolvedAt" IS NULL`, r.PathValue("jobId"))
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, pgx.ErrNoRows
	}
	return s.commandQueueAfterMutation(r, "dismiss")
}
func (s *Server) revocationJobs(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	return list(r.Context(), s.DB, `SELECT to_jsonb(j)||jsonb_build_object('nodeName',n.name) FROM "LeaseRevocationJob" j LEFT JOIN "Node" n ON n.id=j."nodeId" ORDER BY j."createdAt" DESC LIMIT 200`)
}
