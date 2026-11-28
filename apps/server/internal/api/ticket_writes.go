package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *Server) assertLegacyWritable(r *http.Request) error {
	cfg, err := s.setting(r.Context(), "achord-connect")
	if err != nil {
		return err
	}
	if supportEnabled(cfg) {
		return fail(410, "工单系统已迁移到 Achord Connect，这里仅保留历史记录，只读。")
	}
	return nil
}
func (s *Server) createTicket(w http.ResponseWriter, r *http.Request, user Object) (any, error) {
	if err := s.assertLegacyWritable(r); err != nil {
		return nil, err
	}
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	if err = requireText(input, "title", "body"); err != nil {
		return nil, err
	}
	if len(text(input, "title")) > 360 || len(text(input, "body")) > 12000 {
		return nil, fail(400, "工单标题或正文过长")
	}
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(r.Context())
	data := Object{"userId": user["id"], "title": text(input, "title"), "status": "waiting_admin", "source": "desktop", "lastMessageAt": now()}
	if sub, subErr := s.resolveSubscription(r.Context(), tx, text(user, "id")); subErr == nil {
		data["subscriptionId"] = sub["id"]
		data["teamId"] = sub["teamId"]
	} else if subErr != pgx.ErrNoRows && !errors.Is(subErr, errNoSubscription) {
		return nil, subErr
	}
	ticket, err := insert(r.Context(), tx, "SupportTicket", data)
	if err != nil {
		return nil, err
	}
	if _, err = insert(r.Context(), tx, "SupportTicketMessage", Object{"ticketId": ticket["id"], "authorRole": "user", "authorUserId": user["id"], "body": text(input, "body")}); err != nil {
		return nil, err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	r.SetPathValue("ticketId", text(ticket, "id"))
	s.changed("tickets", text(user, "id"))
	return s.ticket(w, r, user)
}
func (s *Server) replyTicket(w http.ResponseWriter, r *http.Request, user Object) (any, error) {
	return s.writeTicketReply(w, r, user, "")
}
func (s *Server) writeTicketReply(w http.ResponseWriter, r *http.Request, user Object, notice string) (any, error) {
	if err := s.assertLegacyWritable(r); err != nil {
		return nil, err
	}
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	ticketID := r.PathValue("ticketId")
	if _, err = s.ticket(w, r, user); err != nil {
		return nil, err
	}
	content := text(input, "body")
	attachment, _ := input["attachment"].(map[string]any)
	if content == "" && attachment == nil {
		return nil, fail(400, "回复内容或图片至少填写一项")
	}
	if len(content) > 12000 {
		return nil, fail(400, "回复内容过长")
	}
	content += notice
	role := "user"
	state := "waiting_admin"
	if user["role"] == "admin" && strings.HasPrefix(r.URL.Path, "/api/admin/") {
		role = "admin"
		state = "waiting_user"
	}
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(r.Context())
	ticket, err := one(r.Context(), tx, `SELECT to_jsonb(t) FROM "SupportTicket" t WHERE id=$1 FOR UPDATE`, ticketID)
	if err != nil {
		return nil, err
	}
	if ticket["status"] == "closed" {
		return nil, fail(409, "工单已关闭，请先重新打开")
	}
	var uploaded Object
	if attachment != nil {
		uploaded, err = one(r.Context(), tx, `SELECT to_jsonb(a)||jsonb_build_object('fileSizeBytes',"fileSizeBytes"::text) FROM "SupportTicketPendingAttachment" a WHERE "tokenId"=$1 AND "userId"=$2 AND "ticketId"=$3 AND NOT consumed AND "expiresAt">now() FOR UPDATE`, tokenHash(text(attachment, "uploadToken")), user["id"], ticketID)
		if err != nil {
			return nil, fail(409, "附件上传凭据已失效或不属于当前工单")
		}
		for _, key := range []string{"url", "fileName", "mimeType", "fileSizeBytes"} {
			if attachment[key] != uploaded[key] {
				return nil, fail(400, "附件信息与已上传记录不一致")
			}
		}
	}
	message, err := insert(r.Context(), tx, "SupportTicketMessage", Object{"ticketId": ticketID, "authorRole": role, "authorUserId": user["id"], "body": content})
	if err != nil {
		return nil, err
	}
	if uploaded != nil {
		if _, err = insert(r.Context(), tx, "SupportTicketAttachment", Object{"ticketId": ticketID, "messageId": message["id"], "provider": "image-bed", "url": uploaded["url"], "fileName": uploaded["fileName"], "mimeType": uploaded["mimeType"], "fileSizeBytes": uploaded["fileSizeBytes"]}); err != nil {
			return nil, err
		}
		if _, err = tx.Exec(r.Context(), `UPDATE "SupportTicketPendingAttachment" SET consumed=true WHERE "tokenId"=$1`, uploaded["tokenId"]); err != nil {
			return nil, err
		}
	}
	if _, err = update(r.Context(), tx, "SupportTicket", ticketID, Object{"lastMessageAt": now(), "status": state}, "lastMessageAt", "status"); err != nil {
		return nil, err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	s.changed("tickets", text(ticket, "userId"))
	return s.ticket(w, r, user)
}
func (s *Server) uploadTicketAttachment(w http.ResponseWriter, r *http.Request, user Object) (any, error) {
	if err := s.assertLegacyWritable(r); err != nil {
		return nil, err
	}
	ticket, err := s.ticket(w, r, user)
	if err != nil {
		return nil, err
	}
	if record, ok := ticket.(map[string]any); ok && record["status"] == "closed" {
		return nil, fail(409, "工单已关闭，请先重新打开")
	}
	r.Body = http.MaxBytesReader(w, r.Body, attachmentMaxBytes+(64<<10))
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		return nil, fail(400, "图片上传格式无效或超过10MiB")
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	combined := !strings.HasSuffix(r.URL.Path, "/attachments/upload")
	content := strings.TrimSpace(r.FormValue("body"))
	if combined && len(content) > 12000 {
		return nil, fail(400, "回复内容过长")
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		if combined && errors.Is(err, http.ErrMissingFile) && content != "" {
			return s.saveMultipartTicketReply(w, r, user, content, nil, nil)
		}
		return nil, fail(400, "请选择图片附件")
	}
	defer file.Close()
	data, mime, err := readTicketImage(file)
	if err != nil {
		return nil, err
	}
	cfg, err := s.setting(r.Context(), "image-bed")
	if err != nil {
		return nil, err
	}
	uploaded, err := s.uploadValidatedTicketImage(r.Context(), data, mime, header.Filename, cfg)
	if err != nil {
		if combined && content != "" {
			return s.saveMultipartTicketReply(w, r, user, content, nil, err)
		}
		return nil, err
	}
	token := randomToken()
	expires := time.Now().UTC().Add(15 * time.Minute)
	err = s.persistAttachment(r.Context(), tokenHash(token), r.PathValue("ticketId"), text(user, "id"), uploaded, expires)
	if err != nil {
		cleanup, cancel := context.WithTimeout(s.resyncContext, 3*time.Second)
		defer cancel()
		if cleanupErr := s.deleteUploadedImage(cleanup, cfg, uploaded); cleanupErr != nil {
			slog.Error("附件记录写入失败且图床清理失败", "error", cleanupErr)
		}
		return nil, err
	}
	s.scheduleEntity("attachment", tokenHash(token), expires)
	uploaded["uploadToken"] = token
	if !combined {
		return uploaded, nil
	}
	return s.saveMultipartTicketReply(w, r, user, content, uploaded, nil)
}
