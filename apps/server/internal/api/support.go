package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

func (s *Server) supportConfig(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	cfg, err := s.setting(r.Context(), "achord-connect")
	if err != nil {
		return nil, err
	}
	origin, err := s.publicOrigin(r.Context())
	if err != nil {
		return nil, err
	}
	return Object{"baseUrl": cfg["baseUrl"], "clientId": cfg["clientId"], "hasClientSecret": text(cfg, "clientSecret") != "", "hasWebhookSecret": text(cfg, "webhookSecret") != "", "enabled": supportEnabled(cfg), "webhookUrl": origin + "/api/integrations/achord-connect/webhook", "updatedAt": cfg["updatedAt"], "contactAttributes": s.contactAttributeStatus(number(cfg, "generation"))}, nil
}
func (s *Server) supportRequest(ctx context.Context, cfg Object, method, path string, input any) (Object, error) {
	base, err := s.integrationOrigin(text(cfg, "baseUrl"))
	if err != nil {
		return nil, err
	}
	var reader io.Reader
	if input != nil {
		raw, err := json.Marshal(input)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(raw)
	}
	request, err := http.NewRequestWithContext(ctx, method, base+path, reader)
	if err != nil {
		return nil, err
	}
	request.SetBasicAuth(text(cfg, "clientId"), text(cfg, "clientSecret"))
	request.Header.Set("Content-Type", "application/json")
	client := *s.HTTP
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return fail(502, "工单请求拒绝重定向") }
	response, err := client.Do(request)
	if err != nil {
		return nil, fail(502, "本地工单系统连接失败")
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 256*1024+1))
	if err != nil || len(raw) > 256*1024 {
		return nil, fail(502, "工单系统响应超出限制")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var problem Object
		_ = json.Unmarshal(raw, &problem)
		code := text(problem, "code")
		if nested, ok := problem["error"].(map[string]any); ok && code == "" {
			code = text(nested, "code")
		}
		return nil, supportProviderError{Status: response.StatusCode, Code: code}
	}
	var payload Object
	if err = json.Unmarshal(raw, &payload); err != nil {
		return nil, fail(502, "工单系统响应格式无效")
	}
	data, _ := payload["data"].(map[string]any)
	if data == nil {
		return nil, fail(502, "工单系统缺少响应数据")
	}
	data["_responseDate"] = response.Header.Get("Date")
	return data, nil
}

const ticketListSQL = `SELECT to_jsonb(t)||jsonb_build_object('ownerType',CASE WHEN t."teamId" IS NULL THEN 'personal' ELSE 'team' END,'userEmail',u.email,'userDisplayName',u."displayName",'teamName',tm.name,'lastMessagePreview',(SELECT left(body,200) FROM "SupportTicketMessage" m WHERE m."ticketId"=t.id ORDER BY "createdAt" DESC LIMIT 1),'unreadCount',(SELECT count(*) FROM "SupportTicketMessage" m WHERE m."ticketId"=t.id AND m."authorRole"<>$2 AND m."createdAt">coalesce(rs."lastReadMessageAt",'epoch'::timestamp)),'hasUnreadMessages',EXISTS(SELECT 1 FROM "SupportTicketMessage" m WHERE m."ticketId"=t.id AND m."authorRole"<>$2 AND m."createdAt">coalesce(rs."lastReadMessageAt",'epoch'::timestamp)),'lastReadAt',rs."lastReadAt") FROM "SupportTicket" t JOIN "User" u ON u.id=t."userId" LEFT JOIN "Team" tm ON tm.id=t."teamId" LEFT JOIN "SupportTicketReadState" rs ON rs."ticketId"=t.id AND rs."userId"=$1`

func (s *Server) tickets(_ http.ResponseWriter, r *http.Request, user Object) (any, error) {
	role := "user"
	where := ` WHERE t."userId"=$1`
	if user["role"] == "admin" && strings.HasPrefix(r.URL.Path, "/api/admin/") {
		role = "admin"
		where = ""
	}
	return list(r.Context(), s.DB, ticketListSQL+where+` ORDER BY t."lastMessageAt" DESC`, user["id"], role)
}
func (s *Server) ticket(_ http.ResponseWriter, r *http.Request, user Object) (any, error) {
	role := "user"
	where := ` WHERE t.id=$3 AND t."userId"=$1`
	if user["role"] == "admin" && strings.HasPrefix(r.URL.Path, "/api/admin/") {
		role = "admin"
		where = ` WHERE t.id=$3`
	}
	ticket, err := one(r.Context(), s.DB, ticketListSQL+where, user["id"], role, r.PathValue("ticketId"))
	if err != nil {
		return nil, err
	}
	messages, err := list(r.Context(), s.DB, `SELECT to_jsonb(m)||jsonb_build_object('authorDisplayName',u."displayName",'authorEmail',u.email,'attachments',coalesce((SELECT jsonb_agg(to_jsonb(a)||jsonb_build_object('fileSizeBytes',a."fileSizeBytes"::text)) FROM "SupportTicketAttachment" a WHERE a."messageId"=m.id),'[]'::jsonb)) FROM "SupportTicketMessage" m LEFT JOIN "User" u ON u.id=m."authorUserId" WHERE m."ticketId"=$1 ORDER BY m."createdAt" ASC`, ticket["id"])
	if err != nil {
		return nil, err
	}
	ticket["messages"] = messages
	return ticket, nil
}
func (s *Server) readTicket(w http.ResponseWriter, r *http.Request, user Object) (any, error) {
	ticket, err := s.ticket(w, r, user)
	if err != nil {
		return nil, err
	}
	id := ticket.(Object)["id"]
	_, err = s.DB.Exec(r.Context(), `INSERT INTO "SupportTicketReadState"(id,"ticketId","userId","lastReadAt","lastReadMessageAt","updatedAt") VALUES($1,$2,$3,now(),now(),now()) ON CONFLICT("ticketId","userId") DO UPDATE SET "lastReadAt"=now(),"lastReadMessageAt"=now(),"updatedAt"=now()`, newID(), id, user["id"])
	if err != nil {
		return nil, err
	}
	return Object{"ok": true}, nil
}
func (s *Server) closeTicket(w http.ResponseWriter, r *http.Request, user Object) (any, error) {
	cfg, err := s.setting(r.Context(), "achord-connect")
	if err != nil {
		return nil, err
	}
	if supportEnabled(cfg) {
		return nil, fail(410, "历史工单只读，请前往已接入的工单系统处理")
	}
	state := "closed"
	var closed any = now()
	if strings.HasSuffix(r.URL.Path, "/reopen") {
		state = "waiting_admin"
		closed = nil
	}
	if _, err = update(r.Context(), s.DB, "SupportTicket", r.PathValue("ticketId"), Object{"status": state, "closedAt": closed}, "status", "closedAt"); err != nil {
		return nil, err
	}
	s.changed("tickets", "")
	return s.ticket(w, r, user)
}
