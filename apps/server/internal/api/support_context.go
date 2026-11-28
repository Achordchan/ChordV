package api

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/jackc/pgx/v5"
)

var supportErrorCode = regexp.MustCompile(`^[a-z0-9_]{1,48}$`)
var supportSessionID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var supportLocale = regexp.MustCompile(`^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$`)

func truncateUnits(value string, max int) string {
	result := []rune{}
	units := 0
	for _, ch := range value {
		n := utf16.RuneLen(ch)
		if units+n > max {
			break
		}
		result = append(result, ch)
		units += n
	}
	return string(result)
}
func supportContext(input Object) Object {
	raw, ok := input["context"].(map[string]any)
	if !ok {
		return nil
	}
	encoded, err := json.Marshal(raw)
	if err != nil || len(encoded) > 4096 {
		return nil
	}
	out := Object{}
	for key, max := range map[string]int{"appVersion": 80, "os": 120, "timezone": 80, "locale": 35, "updateChannel": 60, "lineStatus": 80, "components": 160} {
		value, ok := raw[key].(string)
		if !ok || len(utf16.Encode([]rune(value))) > max {
			continue
		}
		if key == "locale" && !supportLocale.MatchString(value) {
			continue
		}
		if clean := sanitizeSupportText(value); clean != "" {
			out[key] = clean
		}
	}
	if state, ok := raw["connectionState"].(string); ok {
		switch state {
		case "connected", "connecting", "disconnecting", "disconnected", "error":
			out["connectionState"] = state
		}
	}
	if value, ok := raw["connectionErrorCode"].(string); ok && supportErrorCode.MatchString(value) {
		out["connectionErrorCode"] = value
	}
	if value, ok := raw["sessionId"].(string); ok && supportSessionID.MatchString(value) {
		out["sessionId"] = value
	}
	if errors, ok := raw["recentErrors"].([]any); ok && len(errors) <= 3 {
		valid := true
		clean := []any{}
		for _, item := range errors {
			entry, ok := item.(map[string]any)
			if !ok {
				valid = false
				break
			}
			code, ok := entry["code"].(string)
			at, atOK := entry["at"].(string)
			_, err := time.Parse(time.RFC3339, at)
			if !ok || !atOK || !supportErrorCode.MatchString(code) || len(at) > 40 || err != nil {
				valid = false
				break
			}
			clean = append(clean, Object{"code": code, "at": at})
		}
		if valid {
			out["recentErrors"] = clean
		}
	}
	return out
}
func supportDuration(duration time.Duration) string {
	minutes := int(duration.Minutes())
	if minutes < 1 {
		return "不到 1 分钟"
	}
	if minutes < 60 {
		return fmt.Sprintf("%d 分钟", minutes)
	}
	hours := minutes / 60
	if hours < 24 {
		if minutes%60 > 0 {
			return fmt.Sprintf("%d 小时 %d 分", hours, minutes%60)
		}
		return fmt.Sprintf("%d 小时", hours)
	}
	if hours%24 > 0 {
		return fmt.Sprintf("%d 天 %d 小时", hours/24, hours%24)
	}
	return fmt.Sprintf("%d 天", hours/24)
}
func supportName(value, empty, hidden string) string {
	if strings.TrimSpace(value) == "" {
		return empty
	}
	clean := sanitizeSupportText(value)
	if clean == "" {
		return hidden
	}
	return truncateUnits(clean, 40)
}
func supportNode(node Object) string {
	name := supportName(text(node, "name"), "未命名节点", "节点名称已隐藏")
	labels := []string{}
	valid := regexp.MustCompile(`^[a-zA-Z0-9-]{1,20}$`)
	if protocol := text(node, "protocol"); valid.MatchString(protocol) {
		labels = append(labels, strings.ToUpper(protocol))
	}
	if security := text(node, "security"); valid.MatchString(security) && security != "none" {
		if security == "tls" {
			security = "TLS"
		} else {
			security = strings.ToUpper(security[:1]) + strings.ToLower(security[1:])
		}
		labels = append(labels, security)
	}
	if len(labels) > 0 {
		return name + "（" + strings.Join(labels, " ") + "）"
	}
	return name
}
func supportZone(value string) *time.Location {
	candidate := strings.FieldsFunc(value, func(ch rune) bool { return ch == ' ' || ch == '(' || ch == '（' })
	if len(candidate) > 0 {
		if zone, err := time.LoadLocation(candidate[0]); err == nil {
			return zone
		}
	}
	return time.FixedZone("Asia/Shanghai", 8*60*60)
}
func supportRecentErrors(context Object) string {
	errors, ok := context["recentErrors"].([]any)
	if !ok {
		return "未知"
	}
	if len(errors) == 0 {
		return "无"
	}
	sort.SliceStable(errors, func(i, j int) bool {
		a, _ := time.Parse(time.RFC3339, text(errors[i].(map[string]any), "at"))
		b, _ := time.Parse(time.RFC3339, text(errors[j].(map[string]any), "at"))
		return a.After(b)
	})
	zone := supportZone(text(context, "timezone"))
	today := time.Now().In(zone).Format("2006-01-02")
	parts := []string{}
	for _, raw := range errors {
		item := raw.(map[string]any)
		at, _ := time.Parse(time.RFC3339, text(item, "at"))
		at = at.In(zone)
		format := "15:04"
		if at.Format("2006-01-02") != today {
			format = "01-02 15:04"
		}
		parts = append(parts, text(item, "code")+" "+at.Format(format))
	}
	return strings.Join(parts, "、")
}
func (s *Server) supportAttributes(ctx context.Context, userID string, context Object) (Object, error) {
	result := Object{}
	for target, source := range map[string]string{"app_version": "appVersion", "os": "os", "timezone": "timezone", "locale": "locale", "update_channel": "updateChannel", "line_status": "lineStatus", "components": "components"} {
		result[target] = "未知"
		if v := text(context, source); v != "" {
			result[target] = v
		}
	}
	if context == nil {
		result["app_version"] = "未知（旧版客户端）"
	}
	result["recent_errors"] = supportRecentErrors(context)
	cutoff, err := s.leaseCutoff(time.Now())
	if err != nil {
		return nil, err
	}
	lease, err := one(ctx, s.DB, `SELECT jsonb_build_object('connectionMode',l."connectionMode",'issuedAt',l."issuedAt",'name',n.name,'protocol',n.protocol,'security',n.security) FROM "NodeSessionLease" l JOIN "Node" n ON n.id=l."nodeId" WHERE l."userId"=$1 AND l.status='active' AND l."expiresAt">$3 AND ($2='' OR l."sessionId"=$2) ORDER BY l."issuedAt" DESC LIMIT 1`, userID, text(context, "sessionId"), cutoff)
	if err != nil && err != pgx.ErrNoRows {
		return nil, err
	}
	detail := ""
	if lease != nil {
		mode := map[string]string{"rule": "规则模式", "global": "全局模式", "direct": "直连模式"}[text(lease, "connectionMode")]
		if mode != "" {
			detail = mode + " · "
		}
		detail += supportNode(lease)
	}
	connection := "未知"
	switch text(context, "connectionState") {
	case "connected":
		connection = "已连接（后台没有对应的有效会话）"
		if lease != nil {
			issued, _ := parseTimestamp(text(lease, "issuedAt"))
			connection = "已连接 · " + detail + " · " + supportDuration(time.Since(issued))
		}
	case "connecting":
		connection = "正在连接"
		if detail != "" {
			connection += " · " + detail
		}
	case "disconnecting":
		connection = "正在断开"
	case "disconnected":
		connection = "未连接"
	case "error":
		connection = "连接失败"
		if code := text(context, "connectionErrorCode"); code != "" {
			connection += "（" + code + "）"
		}
	default:
		if lease != nil {
			issued, _ := parseTimestamp(text(lease, "issuedAt"))
			connection = "未知（后台有进行中的会话 · " + detail + " · " + supportDuration(time.Since(issued)) + "）"
		}
	}
	result["connection"] = connection
	result["plan"] = "无订阅"
	sub, err := s.resolveSubscription(ctx, s.DB, userID)
	if err != nil && err != pgx.ErrNoRows && !isNoSubscription(err) {
		return nil, err
	}
	if sub != nil {
		scope := "个人"
		remaining := "剩余"
		if sub["teamId"] != nil {
			scope = "团队"
			remaining = "团队剩余"
		}
		expires, _ := parseTimestamp(text(sub, "expireAt"))
		state := map[string]string{"active": "正常", "paused": "已暂停", "expired": "已到期", "exhausted": "流量已用尽"}[text(sub, "state")]
		amount := strings.TrimSuffix(fmt.Sprintf("%.1f", number(sub, "remainingTrafficGb")), ".0")
		result["plan"] = strings.Join([]string{scope, supportName(text(sub, "planName"), "未命名套餐", "套餐名称已隐藏"), state, expires.In(supportZone("")).Format("2006-01-02") + " 到期", remaining + " " + amount + " GB"}, " · ")
	}
	for key, value := range result {
		clean := truncateUnits(strings.TrimSpace(value.(string)), 500)
		if clean == "" {
			clean = "未知"
		}
		result[key] = clean
	}
	return result, nil
}
