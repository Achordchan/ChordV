package api

import (
	"context"
	"net/url"
	"time"
)

func (s *Server) deleteUploadedImage(ctx context.Context, cfg, uploaded Object) error {
	address, err := url.Parse(text(uploaded, "url"))
	if err != nil {
		return err
	}
	base, err := url.Parse(text(cfg, "baseUrl"))
	if err != nil {
		return err
	}
	if address.Scheme != base.Scheme || address.Host != base.Host || address.User != nil {
		return fail(409, "图床配置已变化，保留附件清理记录")
	}
	relative, err := imagePath(text(uploaded, "providerFileId"))
	if err != nil {
		return err
	}
	_, err = s.imageRequest(ctx, cfg, "/api/manage/delete/"+relative, "", nil, true)
	return err
}
func (s *Server) expireAttachment(ctx context.Context, tokenID string) error {
	operation, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.DB.Begin(operation)
	if err != nil {
		return err
	}
	defer tx.Rollback(operation)
	pending, err := one(operation, tx, `SELECT to_jsonb(a) FROM "SupportTicketPendingAttachment" a WHERE "tokenId"=$1 FOR UPDATE`, tokenID)
	if err != nil {
		return ignoreMissing(err)
	}
	expiry, err := parseTimestamp(text(pending, "expiresAt"))
	if err != nil {
		return err
	}
	if expiry.After(time.Now()) {
		s.scheduleEntity("attachment", tokenID, expiry)
		return nil
	}
	if !boolean(pending, "consumed", false) {
		cfg, err := s.setting(operation, "image-bed")
		if err != nil {
			return err
		}
		if err = s.deleteUploadedImage(operation, cfg, pending); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(operation, `DELETE FROM "SupportTicketPendingAttachment" WHERE "tokenId"=$1`, tokenID); err != nil {
		return err
	}
	return tx.Commit(operation)
}

func (s *Server) persistAttachment(ctx context.Context, tokenID, ticketID, userID string, uploaded Object, expires time.Time) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	ticket, err := one(ctx, tx, `SELECT to_jsonb(t) FROM "SupportTicket" t WHERE id=$1 FOR UPDATE`, ticketID)
	if err != nil {
		return fail(409, "工单已删除或状态已变化，未保存附件")
	}
	if ticket["status"] == "closed" {
		return fail(409, "工单已关闭，未保存附件")
	}
	_, err = tx.Exec(ctx, `INSERT INTO "SupportTicketPendingAttachment"("tokenId","userId","ticketId",url,"providerFileId","fileName","mimeType","fileSizeBytes","expiresAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8::bigint,$9)`, tokenID, userID, ticketID, uploaded["url"], uploaded["providerFileId"], uploaded["fileName"], uploaded["mimeType"], uploaded["fileSizeBytes"], expires)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
