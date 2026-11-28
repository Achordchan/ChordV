package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

var decimalPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)

func decimal(value string) (int64, error) {
	if !decimalPattern.MatchString(value) {
		return 0, fail(400, "流量和序号必须是非负十进制整数字符串")
	}
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, fail(400, "流量或序号超过数据库整数范围")
	}
	return n, nil
}
func (s *Server) usageBatch(w http.ResponseWriter, r *http.Request, agent Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	if err = requireText(input, "bootId", "sequence", "sampledAt"); err != nil {
		return nil, err
	}
	sequence, err := decimal(text(input, "sequence"))
	if err != nil || sequence < 1 {
		return nil, fail(400, "批次序号必须大于0")
	}
	sampled, err := time.Parse(time.RFC3339, text(input, "sampledAt"))
	if err != nil {
		return nil, fail(400, "采样时间无效")
	}
	if sampled.After(time.Now().Add(5 * time.Minute)) {
		return nil, fail(400, "采样时间超前")
	}
	samples, ok := input["samples"].([]any)
	if !ok || len(samples) > 5000 {
		return nil, fail(400, "流量样本格式无效或超过5000项")
	}
	seen := map[string]bool{}
	for _, raw := range samples {
		sample, ok := raw.(map[string]any)
		if !ok {
			return nil, fail(400, "流量样本无效")
		}
		id := text(sample, "bindingId")
		if id == "" || seen[id] {
			return nil, fail(409, "绑定为空或同一批次包含重复绑定")
		}
		seen[id] = true
		for _, key := range []string{"counterGeneration", "uplinkBytes", "downlinkBytes", "uplinkDeltaBytes", "downlinkDeltaBytes"} {
			if _, err = decimal(text(sample, key)); err != nil {
				return nil, err
			}
		}
	}
	raw, err := canonicalUsageJSON(input)
	if err != nil {
		return nil, err
	}
	hash := tokenHash(string(raw))
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(r.Context())
	if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, text(agent, "nodeId")+":usage"); err != nil {
		return nil, err
	}
	current, err := one(r.Context(), tx, `SELECT to_jsonb(a)||jsonb_build_object('lastAckSequence',"lastAckSequence"::text) FROM "NodeAgent" a WHERE id=$1 AND "revokedAt" IS NULL FOR UPDATE`, agent["id"])
	if err != nil {
		return nil, err
	}
	ack, _ := decimal(text(current, "lastAckSequence"))
	if current["bootId"] != input["bootId"] {
		ack = 0
	}
	existing, err := one(r.Context(), tx, `SELECT to_jsonb(b) FROM "NodeUsageBatch" b WHERE "nodeId"=$1 AND "bootId"=$2 AND sequence=$3`, agent["nodeId"], input["bootId"], sequence)
	duplicate := err == nil
	if duplicate && existing["payloadHash"] != hash {
		payload, _ := existing["payload"].(map[string]any)
		stored, err := canonicalUsageJSON(payload)
		if err != nil || !bytes.Equal(raw, stored) {
			return nil, fail(409, "相同批次序号对应不同内容")
		}
	}

	if err != nil && err != pgx.ErrNoRows {
		return nil, err
	}
	// Include the incoming batch before its Node FK is written, and lock the
	// complete settlement set before any binding, snapshot or node is touched.
	subs, err := list(r.Context(), tx, `SELECT jsonb_build_object('id',s.id) FROM "Subscription" s WHERE EXISTS(
 SELECT 1 FROM "PanelClientBinding" b WHERE b."subscriptionId"=s.id AND b."nodeId"=$1 AND b.id IN(
 SELECT sample->>'bindingId' FROM "NodeUsageBatch" ub CROSS JOIN LATERAL jsonb_array_elements(ub.payload->'samples') sample WHERE ub."nodeId"=$1 AND ub."bootId"=$2 AND ub.sequence>$3 AND ub.sequence<=$3+32
 UNION SELECT sample->>'bindingId' FROM jsonb_array_elements($4::jsonb->'samples') sample WHERE $5::bigint>$3 AND $5::bigint<=$3+32
 )) ORDER BY s.id FOR UPDATE`, agent["nodeId"], input["bootId"], ack, raw, sequence)
	if err != nil {
		return nil, err
	}
	if err = lockRuntimeBindingsAndNodes(r.Context(), tx, runtimeSubscriptionIDs(subs), text(agent, "nodeId")); err != nil {
		return nil, err
	}
	if !duplicate {
		if _, err = tx.Exec(r.Context(), `INSERT INTO "NodeUsageBatch"(id,"nodeId","agentId","bootId",sequence,"payloadHash",payload,"sampledAt") VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`, newID(), agent["nodeId"], agent["id"], input["bootId"], sequence, hash, raw, sampled); err != nil {
			return nil, err
		}
	}
	for i := 0; i < 32; i++ {
		batch, err := one(r.Context(), tx, `SELECT to_jsonb(b)||jsonb_build_object('sequence',sequence::text) FROM "NodeUsageBatch" b WHERE "nodeId"=$1 AND "bootId"=$2 AND sequence=$3 FOR UPDATE`, agent["nodeId"], input["bootId"], ack+1)
		if err == pgx.ErrNoRows {
			break
		}
		if err != nil {
			return nil, err
		}
		if batch["accountedAt"] == nil {
			payload, _ := batch["payload"].(map[string]any)
			entries, _ := payload["samples"].([]any)
			if err = s.accountBatch(r.Context(), tx, agent, batch, entries); err != nil {
				return nil, err
			}
			if _, err = tx.Exec(r.Context(), `UPDATE "NodeUsageBatch" SET "accountedAt"=now() WHERE id=$1`, batch["id"]); err != nil {
				return nil, err
			}
		}
		ack++
	}
	if _, err = tx.Exec(r.Context(), `UPDATE "NodeAgent" SET "bootId"=$2,"lastSequence"=greatest(CASE WHEN "bootId"=$2 THEN "lastSequence" ELSE 0 END,$3),"lastAckSequence"=$4,"lastSeenAt"=now(),status='online',"updatedAt"=now() WHERE id=$1`, agent["id"], input["bootId"], sequence, ack); err != nil {
		return nil, err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	s.scheduleNodeProvisioning(text(agent, "nodeId"))
	if err = s.resumeTrafficResets(r.Context(), text(agent, "nodeId"), false); err != nil {
		return nil, err
	}
	s.changed("subscriptions", "")
	s.events.publish("agent:"+text(agent, "nodeId"), Object{"type": "command_ready"})
	return Object{"accepted": true, "duplicate": duplicate, "ackThrough": strconv.FormatInt(ack, 10)}, nil
}
func (s *Server) accountBatch(ctx context.Context, q queryer, agent, batch Object, samples []any) error {
	touched := map[string]bool{}
	for _, raw := range samples {
		sample := raw.(map[string]any)
		binding, err := one(ctx, q, `SELECT to_jsonb(b) FROM "PanelClientBinding" b WHERE id=$1 AND "nodeId"=$2 AND source='direct' FOR UPDATE`, sample["bindingId"], agent["nodeId"])
		if err == pgx.ErrNoRows {
			return fail(409, "流量样本包含其他节点或未知绑定")
		}
		if err != nil {
			return err
		}
		if binding["status"] == "disabled" || binding["status"] == "deleted" {
			if marks, ok := binding["directDisableWatermarks"].([]any); ok {
				allowed := false
				seq, _ := decimal(text(batch, "sequence"))
				for _, raw := range marks {
					mark, ok := raw.(map[string]any)
					if !ok {
						return fail(409, "停用结算水位格式无效")
					}
					through, err := decimal(text(mark, "sequenceThrough"))
					if err != nil {
						return err
					}
					allowed = allowed || (mark["bootId"] == batch["bootId"] && seq <= through)
				}
				if !allowed {
					continue
				}
			}
		} else if binding["status"] != "active" {
			return fail(409, "流量绑定状态无效")
		}
		up, _ := decimal(text(sample, "uplinkBytes"))
		down, _ := decimal(text(sample, "downlinkBytes"))
		if up > math.MaxInt64-down {
			return fail(400, "流量总量超过数据库整数范围")
		}
		key := fmt.Sprintf("%v:%v:%v", agent["nodeId"], binding["subscriptionId"], binding["userId"])
		snapshot, err := one(ctx, q, `SELECT to_jsonb(s)||jsonb_build_object('uplinkBytes',"uplinkBytes"::text,'downlinkBytes',"downlinkBytes"::text) FROM "TrafficSnapshot" s WHERE "snapshotKey"=$1 FOR UPDATE`, key)
		delta := int64(0)
		if err == nil {
			oldUp, _ := decimal(text(snapshot, "uplinkBytes"))
			oldDown, _ := decimal(text(snapshot, "downlinkBytes"))
			if snapshot["counterGeneration"] == sample["counterGeneration"] {
				if up < oldUp || down < oldDown {
					return fail(409, "同一计数代发生回退")
				}
				delta = up - oldUp + down - oldDown
			} else {
				delta = up + down
			}
		} else if err != pgx.ErrNoRows {
			return err
		}
		if _, err = q.Exec(ctx, `INSERT INTO "TrafficSnapshot"(id,"snapshotKey","nodeId","subscriptionId","userId","teamId","uplinkBytes","downlinkBytes","totalBytes",source,"counterGeneration","sampledAt","updatedAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'direct',$10,$11::timestamptz,now()) ON CONFLICT("snapshotKey") DO UPDATE SET "uplinkBytes"=EXCLUDED."uplinkBytes","downlinkBytes"=EXCLUDED."downlinkBytes","totalBytes"=EXCLUDED."totalBytes","counterGeneration"=EXCLUDED."counterGeneration","sampledAt"=EXCLUDED."sampledAt",source='direct',"updatedAt"=now()`, newID(), key, agent["nodeId"], binding["subscriptionId"], binding["userId"], binding["teamId"], up, down, up+down, sample["counterGeneration"], batch["sampledAt"]); err != nil {
			return err
		}
		if _, err = q.Exec(ctx, `UPDATE "PanelClientBinding" SET "lastUplinkBytes"=$2,"lastDownlinkBytes"=$3,"lastSyncedAt"=$4::timestamptz,"updatedAt"=now() WHERE id=$1`, binding["id"], up, down, batch["sampledAt"]); err != nil {
			return err
		}
		if delta == 0 {
			continue
		}
		sub, err := one(ctx, q, `WITH changed AS(UPDATE "Subscription" SET "usedTrafficBytes"="usedTrafficBytes"+$2,"usedTrafficGb"=("usedTrafficBytes"+$2)::float8/1073741824.0,"remainingTrafficGb"=greatest(0,"totalTrafficBytes"-"usedTrafficBytes"-$2)::float8/1073741824.0,state=CASE WHEN state<>'active' THEN state WHEN "expireAt"<=$3::timestamptz THEN 'expired'::"SubscriptionState" WHEN "totalTrafficBytes"<="usedTrafficBytes"+$2 THEN 'exhausted'::"SubscriptionState" ELSE 'active'::"SubscriptionState" END,"lastSyncedAt"=$3::timestamptz,"updatedAt"=now() WHERE id=$1 RETURNING *) SELECT to_jsonb(changed) FROM changed`, binding["subscriptionId"], delta, batch["sampledAt"])
		if err != nil {
			return err
		}
		if binding["teamId"] != nil && binding["userId"] != nil {
			if _, err = insert(ctx, q, "TrafficLedger", Object{"teamId": binding["teamId"], "userId": binding["userId"], "subscriptionId": binding["subscriptionId"], "nodeId": binding["nodeId"], "usedTrafficBytes": strconv.FormatInt(delta, 10), "usedTrafficGb": float64(delta) / bytesPerGB, "recordedAt": batch["sampledAt"]}); err != nil {
				return err
			}
		}
		touched[text(sub, "id")] = sub["state"] == "active"
		if sub["state"] != "active" {
			if _, err = s.revokeLeases(ctx, q, "subscriptionId", text(sub, "id"), "subscription_"+text(sub, "state")); err != nil {
				return err
			}
			if err = s.syncSubscriptionBindings(ctx, q, text(sub, "id")); err != nil {
				return err
			}
		}
	}
	ids := []string{}
	for id, active := range touched {
		if active {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	for _, id := range ids {
		if err := s.syncQuota(ctx, q, id); err != nil {
			return err
		}
	}

	return nil
}

type canonicalUsageSample struct {
	BindingID          string `json:"bindingId"`
	CounterGeneration  string `json:"counterGeneration"`
	UplinkBytes        string `json:"uplinkBytes"`
	DownlinkBytes      string `json:"downlinkBytes"`
	UplinkDeltaBytes   string `json:"uplinkDeltaBytes"`
	DownlinkDeltaBytes string `json:"downlinkDeltaBytes"`
}
type canonicalUsageBatch struct {
	BootID    string                 `json:"bootId"`
	Sequence  string                 `json:"sequence"`
	SampledAt string                 `json:"sampledAt"`
	Samples   []canonicalUsageSample `json:"samples"`
}

func canonicalUsageJSON(input Object) ([]byte, error) {
	batch := canonicalUsageBatch{BootID: stringValue(input, "bootId"), Sequence: stringValue(input, "sequence"), SampledAt: stringValue(input, "sampledAt"), Samples: []canonicalUsageSample{}}
	samples, ok := input["samples"].([]any)
	if !ok {
		return nil, fail(400, "流量样本格式无效")
	}
	for _, raw := range samples {
		sample, ok := raw.(map[string]any)
		if !ok {
			return nil, fail(400, "流量样本格式无效")
		}
		batch.Samples = append(batch.Samples, canonicalUsageSample{BindingID: stringValue(sample, "bindingId"), CounterGeneration: stringValue(sample, "counterGeneration"), UplinkBytes: stringValue(sample, "uplinkBytes"), DownlinkBytes: stringValue(sample, "downlinkBytes"), UplinkDeltaBytes: stringValue(sample, "uplinkDeltaBytes"), DownlinkDeltaBytes: stringValue(sample, "downlinkDeltaBytes")})
	}
	return json.Marshal(batch)
}
