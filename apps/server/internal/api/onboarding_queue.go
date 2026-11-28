package api

import (
	"context"
	"encoding/json"
	"net/http"
)

func (s *Server) queueInitialValidation(ctx context.Context, q queryer, node, agent, spec Object) error {
	var revision string
	if err := q.QueryRow(ctx, `UPDATE "Node" SET "agentConfigRevision"="agentConfigRevision"+1,"updatedAt"=now() WHERE id=$1 RETURNING "agentConfigRevision"::text`, node["id"]).Scan(&revision); err != nil {
		return err
	}
	raw, err := json.Marshal(spec)
	if err != nil {
		return err
	}
	_, err = q.Exec(ctx, `INSERT INTO "NodeCommandJob"(id,"dedupeKey","nodeId","agentId","commandType","targetRevision",payload,"updatedAt") VALUES($1,$2,$3,$4,'ENSURE_INBOUND',$5::bigint,$6::jsonb,now())`, newID(), "onboarding:"+text(node, "id"), node["id"], agent["id"], revision, raw)
	if err != nil {
		return err
	}
	return notifyCommands(ctx, q, text(node, "id"))
}
func (s *Server) retryOnboarding(w http.ResponseWriter, r *http.Request, user Object) (any, error) {
	result, err := s.onboarding(w, r, user)
	if err != nil {
		return nil, err
	}
	record := result.(Object)
	spec, ok := record["spec"].(map[string]any)
	if !ok || spec["mode"] != "validate_panel" {
		return nil, fail(400, "该节点尚未导入面板入站参数")
	}
	node := record["node"].(Object)
	r.Body, err = marshalBody(Object{"type": "ENSURE_INBOUND", "payload": spec, "expectedInboundAppliedRevision": node["inboundAppliedRevision"]})
	if err != nil {
		return nil, err
	}
	return s.queueCommand(w, r, user)
}

func (s *Server) nodeAction(w http.ResponseWriter, r *http.Request, user Object) (any, error) {
	switch r.PathValue("nodeAction") {
	case "lease-revocation-jobs/retry":
		return s.retryRevocationJob(w, r, user)
	case "onboarding/retry":
		return s.retryOnboarding(w, r, user)
	default:
		return nil, fail(404, "节点操作不存在")
	}
}
