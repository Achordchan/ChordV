package api

import (
	"context"
	"encoding/json"
	"strconv"
)

func panelReportPort(value any) (float64, bool) {
	switch value := value.(type) {
	case json.Number:
		port, err := value.Float64()
		return port, err == nil
	case float64:
		return value, true
	case int:
		return float64(value), true
	case int64:
		return float64(value), true
	default:
		return 0, false
	}
}

func parsePanelReport(result, spec Object) (Object, error) {
	report, valid := result["inbound"].(map[string]any)
	if !valid || report["mode"] != "validate_panel" || report["validated"] != true {
		return nil, fail(400, "缺少已验证的面板入站结果")
	}
	tag, valid := report["inboundTag"].(string)
	if !valid || !tagPattern.MatchString(tag) || spec["tagOverrideConfirmed"] == true && tag != spec["inboundTag"] {
		return nil, fail(400, "入站标签与确认目标不一致")
	}
	names, valid := spec["serverNames"].([]string)
	if !valid || len(names) != 1 {
		return nil, fail(400, "命令缺少SNI")
	}
	port, valid := panelReportPort(report["serverPort"])
	if !valid || port != number(spec, "listenPort") {
		return nil, fail(400, "入站校验结果与导入规格不一致：serverPort")
	}
	fields := Object{"serverHost": spec["serverHost"], "realityPublicKey": spec["realityPublicKey"], "shortId": spec["shortId"], "serverName": names[0], "flow": spec["flow"], "fingerprint": spec["fingerprint"], "spiderX": spec["spiderX"]}
	for key, expected := range fields {
		value, valid := report[key].(string)
		if !valid || value != expected {
			return nil, fail(400, "入站校验结果与导入规格不一致："+key)
		}
	}
	fields["serverPort"] = spec["listenPort"]
	return fields, nil
}

func (s *Server) applyPanelCommandReport(ctx context.Context, tx queryer, nodeID string, job, result Object) (Object, error) {
	payload, _ := job["payload"].(map[string]any)
	spec, err := normalizeInbound(payload, s.Config.Production())
	if err != nil {
		return nil, err
	}
	fields, err := parsePanelReport(result, spec)
	if err != nil {
		return nil, err
	}
	// commandResult already holds the Node lock before the job lock. Read its
	// revision as text so delayed bigint revisions are not rounded through JSON.
	node, err := one(ctx, tx, `SELECT to_jsonb(n)||jsonb_build_object('inboundAppliedRevision',"inboundAppliedRevision"::text) FROM "Node" n WHERE id=$1`, nodeID)
	if err != nil {
		return nil, err
	}
	old, err := strconv.ParseInt(text(node, "inboundAppliedRevision"), 10, 64)
	if err != nil {
		return nil, err
	}
	next, err := strconv.ParseInt(text(job, "targetRevision"), 10, 64)
	if err != nil {
		return nil, err
	}
	onboarding, _ := node["onboardingSpec"].(map[string]any)
	activate := old == 0 && node["registrationStatus"] == "agent_ready" && node["isActive"] == false && onboarding["activateOnFirstValidation"] == true
	if node["isActive"] != false || !activate && next <= old {
		return nil, fail(400, "节点已激活或校验结果已过期，请停用并基于当前 revision 重新校验")
	}
	fields["inboundAppliedRevision"], fields["isActive"] = job["targetRevision"], activate
	if _, err = update(ctx, tx, "Node", nodeID, fields, "serverHost", "serverPort", "realityPublicKey", "shortId", "serverName", "flow", "fingerprint", "spiderX", "inboundAppliedRevision", "isActive"); err != nil {
		return nil, err
	}
	frozen := Object{}
	for key, value := range payload {
		frozen[key] = value
	}
	report := result["inbound"].(map[string]any)
	frozen["inboundTag"], frozen["tagOverrideConfirmed"] = report["inboundTag"], true
	return frozen, nil
}
