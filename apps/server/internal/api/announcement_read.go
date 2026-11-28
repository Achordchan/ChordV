package api

import (
	"net/http"
	"strings"
)

func announcementReadIDs(raw any) ([]string, error) {
	ids := []string{}
	if raw == nil {
		return ids, nil
	}
	values, ok := raw.([]any)
	if !ok || len(values) > 100 {
		return nil, fail(400, "公告编号必须为不超过100项的字符串数组")
	}
	seen := map[string]bool{}
	for _, value := range values {
		id, ok := value.(string)
		if !ok {
			return nil, fail(400, "公告编号必须为字符串")
		}
		if strings.TrimSpace(id) == "" || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	return ids, nil
}

func (s *Server) readAnnouncements(w http.ResponseWriter, r *http.Request, user Object) (any, error) {
	userID := text(user, "id")
	if userID == "" {
		return nil, fail(401, "请先登录")
	}
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	if err = enum(input, "action", "seen", "ack"); err != nil {
		return nil, err
	}
	ids, err := announcementReadIDs(input["announcementIds"])
	if err != nil {
		return nil, err
	}
	updatedIDs := []string{}
	if len(ids) == 0 {
		return Object{"ok": true, "updatedIds": updatedIDs}, nil
	}
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(r.Context())
	// seen只处理普通公告；强制公告由现有客户端倒计时后直接ack，无seen握手。
	rows, err := tx.Query(r.Context(), `SELECT id FROM "Announcement" WHERE id=ANY($1::text[]) AND "isActive" AND "publishedAt"<=now() AND ($2::text='ack' OR "displayMode"='passive') ORDER BY id FOR SHARE`, ids, text(input, "action"))
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		updatedIDs = append(updatedIDs, id)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, err
	}
	column := "passiveSeenAt"
	if input["action"] == "ack" {
		column = "acknowledgedAt"
	}
	for _, id := range updatedIDs {
		if _, err = tx.Exec(r.Context(), `INSERT INTO "AnnouncementReadState"(id,"announcementId","userId",`+quote(column)+`,"updatedAt") VALUES($1,$2,$3,now(),now()) ON CONFLICT("announcementId","userId") DO UPDATE SET `+quote(column)+`=EXCLUDED.`+quote(column)+`,"updatedAt"=now()`, newID(), id, userID); err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(r.Context()); err != nil {
		return nil, err
	}
	for _, id := range updatedIDs {
		s.events.publish(userID, Object{"type": "announcement_read_state_updated", "announcementId": id, "userId": userID, "occurredAt": now()})
	}
	return Object{"ok": true, "updatedIds": updatedIDs}, nil
}
