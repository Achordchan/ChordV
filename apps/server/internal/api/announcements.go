package api

import (
	"net/http"

	"github.com/jackc/pgx/v5"
)

func (s *Server) adminAnnouncements(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	return list(r.Context(), s.DB, `SELECT to_jsonb(a) FROM "Announcement" a ORDER BY "publishedAt" DESC,"createdAt" DESC`)
}

func (s *Server) clientAnnouncements(_ http.ResponseWriter, r *http.Request, user Object) (any, error) {
	return list(r.Context(), s.DB, `SELECT jsonb_build_object('id',a.id,'title',a.title,'body',a.body,'level',a.level,'publishedAt',a."publishedAt",'displayMode',a."displayMode",'countdownSeconds',a."countdownSeconds",'passiveSeenAt',s."passiveSeenAt",'acknowledgedAt',s."acknowledgedAt",'isUnread',CASE WHEN a."displayMode"='passive' THEN s."passiveSeenAt" IS NULL ELSE s."acknowledgedAt" IS NULL END) FROM "Announcement" a LEFT JOIN "AnnouncementReadState" s ON s."announcementId"=a.id AND s."userId"=$1 WHERE a."isActive" AND a."publishedAt"<=now() ORDER BY a."publishedAt" DESC,a."createdAt" DESC`, user["id"])
}

func (s *Server) writeAnnouncement(w http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	create := r.Method == "POST"
	input, err = validateAnnouncementInput(input, create)
	if err != nil {
		return nil, err
	}
	var result Object
	if create {
		data, dataErr := announcementWriteData(input, nil, true)
		if dataErr != nil {
			return nil, dataErr
		}
		result, err = insert(r.Context(), s.DB, "Announcement", data)
	} else {
		tx, beginErr := s.DB.Begin(r.Context())
		if beginErr != nil {
			return nil, beginErr
		}
		defer tx.Rollback(r.Context())
		current, readErr := one(r.Context(), tx, `SELECT to_jsonb(a) FROM "Announcement" a WHERE id=$1 FOR UPDATE`, r.PathValue("announcementId"))
		if readErr != nil {
			return nil, readErr
		}
		data, dataErr := announcementWriteData(input, current, false)
		if dataErr != nil {
			return nil, dataErr
		}
		result, err = update(r.Context(), tx, "Announcement", r.PathValue("announcementId"), data, "title", "body", "level", "publishedAt", "isActive", "displayMode", "countdownSeconds")
		if err == nil {
			err = tx.Commit(r.Context())
		}
	}
	if err != nil {
		return nil, err
	}
	s.announcementUpdated(text(result, "id"))
	return result, nil
}

func (s *Server) announcementUpdated(id string) {
	s.events.publish("", Object{"type": "announcement_updated", "announcementId": id, "occurredAt": now()})
}

func (s *Server) deleteAnnouncement(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	id := r.PathValue("announcementId")
	tag, err := s.DB.Exec(r.Context(), `DELETE FROM "Announcement" WHERE id=$1`, id)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, pgx.ErrNoRows
	}
	s.announcementUpdated(id)
	return Object{"ok": true, "announcementId": id}, nil
}
