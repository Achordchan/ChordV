package api

import "net/http"

func (s *Server) testSupport(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	cfg, err := s.setting(r.Context(), "achord-connect")
	if err != nil {
		return nil, err
	}
	if text(cfg, "baseUrl") == "" || text(cfg, "clientId") == "" || text(cfg, "clientSecret") == "" {
		return Object{"ok": false, "launch": Object{"ok": false, "message": "请先填写并保存工单系统地址、Client ID 和 Client Secret"}, "unread": Object{"ok": false, "message": "未测试"}, "attributes": Object{"ok": false, "message": "未测试"}}, nil
	}
	// A preflight uses the provider's dedicated test contact, never an administrator's identity.
	user := Object{"id": "chordv-connection-test", "email": "", "displayName": "ChordV 连接测试"}
	profile := Object{}
	for _, key := range []string{"app_version", "os", "timezone", "locale", "update_channel", "connection", "line_status", "recent_errors", "components", "plan"} {
		profile[key] = "连接测试"
	}
	data, launchErr := s.createSupportLaunch(r.Context(), cfg, user, profile, true)
	if launchErr == nil {
		_, launchErr = validatedSupportLaunch(cfg, data)
	}
	_, unreadErr := s.supportRequest(r.Context(), cfg, "GET", "/api/v1/integrations/universal/contacts/chordv-connection-test/unread", nil)
	latest, err := s.setting(r.Context(), "achord-connect")
	if err != nil {
		return nil, err
	}
	if number(latest, "generation") != number(cfg, "generation") || number(latest, "epoch") != number(cfg, "epoch") {
		return nil, fail(409, "工单接入设置在测试期间发生变化，请重新测试")
	}
	item := func(err error) Object {
		if err == nil {
			return Object{"ok": true, "message": "连接正常"}
		}
		return Object{"ok": false, "message": err.Error()}
	}
	attributes := s.contactAttributeStatus(number(cfg, "generation"))
	attributeItem := Object{"ok": attributes["status"] == "accepted", "message": "联系人资料字段尚未验证"}
	if attributes["status"] == "accepted" {
		attributeItem["message"] = "联系人资料字段已接受"
	} else if attributes["status"] == "rejected" {
		attributeItem["message"] = "工单系统拒绝联系人资料字段，已临时不附带资料打开"
	}
	return Object{"ok": launchErr == nil && unreadErr == nil, "launch": item(launchErr), "unread": item(unreadErr), "attributes": attributeItem}, nil
}
