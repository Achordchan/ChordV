package api

import (
	"context"
	"encoding/json"
	"time"
)

func (s *Server) supersedeBindingCommands(ctx context.Context, q queryer, binding Object, command string) error {
	types := []string{command}
	if command == "ENSURE_USER" || command == "ENABLE_USER" {
		types = []string{"ENSURE_USER", "ENABLE_USER", "REFRESH_QUOTA"}
	}
	if command == "DISABLE_USER" || command == "REMOVE_USER" {
		types = []string{"ENSURE_USER", "ENABLE_USER", "REFRESH_QUOTA", command}
	}
	_, err := q.Exec(ctx, `UPDATE "NodeCommandJob" SET status='cancelled',"resolvedAt"=now(),"lastError"='已由更新命令替代',"updatedAt"=now() WHERE "bindingId"=$1 AND "commandType"::text=ANY($2::text[]) AND (status IN('pending','running','failed') OR(status='cancelled' AND "resolvedAt" IS NULL))`, binding["id"], types)
	return err
}
func (s *Server) claimAgentCommands(ctx context.Context, agentID string) ([]Object, error) {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	// Read Node through MVCC only: commandResult and queueCommand already lock
	// Node before Job, so taking a Node lock here after Job would reverse order.
	const invalidPanel = `j."commandType"='ENSURE_INBOUND' AND EXISTS(SELECT 1 FROM "Node" n WHERE n.id=j."nodeId" AND (n."isActive" OR j."targetRevision"<=n."inboundAppliedRevision"))`
	cancelled, err := tx.Exec(ctx, `UPDATE "NodeCommandJob" j SET status='cancelled',"lastError"='节点已激活或入站修订已过期，已取消投递',"dedupeKey"=j."dedupeKey"||':cancelled:'||j.id,"updatedAt"=now() WHERE j."agentId"=$1 AND j.status IN('pending','running','failed') AND `+invalidPanel, agentID)
	if err != nil {
		return nil, err
	}
	jobs, err := list(ctx, tx, `WITH due AS (SELECT j.id FROM "NodeCommandJob" j WHERE j."agentId"=$1 AND j.status IN('pending','running','failed') AND j."nextRunAt"<=now() AND j.attempts<8 AND NOT (`+invalidPanel+`) ORDER BY j."targetRevision" LIMIT 200 FOR UPDATE OF j SKIP LOCKED), claimed AS (UPDATE "NodeCommandJob" j SET status='running',attempts=attempts+1,"lockedAt"=now(),"nextRunAt"=now()+least(300,30*power(2,least(attempts,4)))::int*interval '1 second',"updatedAt"=now() FROM due WHERE j.id=due.id RETURNING j.*) SELECT jsonb_build_object('commandId',id,'type',"commandType",'targetRevision',"targetRevision"::text,'payload',payload,'createdAt',"createdAt",'_retryAt',"nextRunAt") FROM claimed ORDER BY "targetRevision"`, agentID)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	if cancelled.RowsAffected() > 0 {
		s.changed("nodes", "")
	}
	return jobs, nil
}
func existingCommand(ctx context.Context, q queryer, dedupe, node, kind string, payload Object) (Object, error) {
	job, err := one(ctx, q, `SELECT to_jsonb(j)||jsonb_build_object('commandId',id,'type',"commandType",'targetRevision',"targetRevision"::text) FROM "NodeCommandJob" j WHERE "dedupeKey"=$1`, dedupe)
	if err != nil {
		return nil, err
	}
	actual, _ := json.Marshal(job["payload"])
	expected, _ := json.Marshal(payload)
	if text(job, "nodeId") != node || text(job, "commandType") != kind || string(actual) != string(expected) {
		return nil, fail(409, "dedupeKey 已用于其他节点、命令类型或正文")
	}
	return pick(job, "commandId", "type", "targetRevision", "payload", "createdAt"), nil
}

func commandRetryDelay(attempts int) time.Duration {
	if attempts < 1 {
		attempts = 1
	}
	if attempts > 5 {
		attempts = 5
	}
	delay := 30 * time.Second * time.Duration(1<<uint(attempts-1))
	if delay > 5*time.Minute {
		return 5 * time.Minute
	}
	return delay
}
