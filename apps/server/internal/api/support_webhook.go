package api

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func webhookSignature(secret, timestamp, signature string, raw []byte) bool {
	seconds, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil || math.Abs(float64(time.Now().Unix()-seconds)) > 300 || secret == "" || !strings.HasPrefix(signature, "v1=") {
		return false
	}
	actual, err := hex.DecodeString(strings.TrimPrefix(signature, "v1="))
	if err != nil || len(actual) != 32 {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestamp + "."))
	mac.Write(raw)
	return hmac.Equal(mac.Sum(nil), actual)
}
func validUnread(v any) (int, bool) {
	value, ok := v.(float64)
	if !ok || value < 0 || value > 1000000 || math.Trunc(value) != value {
		return 0, false
	}
	return int(value), true
}
func (s *Server) supportWebhook(w http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	cfg, err := s.setting(r.Context(), "achord-connect")
	if err != nil {
		return nil, err
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		return nil, fail(400, "Webhook 正文超过限制")
	}
	if !webhookSignature(text(cfg, "webhookSecret"), r.Header.Get("X-Achord-Timestamp"), r.Header.Get("X-Achord-Signature"), raw) {
		return nil, fail(401, "Webhook 验证失败")
	}
	eventID := r.Header.Get("X-Achord-Event-Id")
	var event Object
	if err = json.Unmarshal(raw, &event); err != nil || eventID == "" || len(eventID) > 191 || (event["id"] != nil && event["id"] != eventID) {
		return nil, fail(400, "Webhook 事件格式无效")
	}
	accepted := func(result string) Object { return Object{"ok": true, "result": result} }
	if event["type"] != "request.unread.changed" {
		return accepted("ignored"), nil
	}
	data, _ := event["data"].(map[string]any)
	request, _ := data["request"].(map[string]any)
	uid := text(data, "externalUserId")
	requestID := text(request, "id")
	count, ok := validUnread(data["unreadCount"])
	if uid == "" || len(uid) > 191 || requestID == "" || len(requestID) > 191 || !ok {
		return accepted("ignored"), nil
	}
	var total *int
	if value, present := data["contactUnreadCount"]; present && value != nil {
		parsed, ok := validUnread(value)
		if !ok {
			return accepted("ignored"), nil
		}
		total = &parsed
	}
	date, dateErr := parseTimestamp(text(event, "createdAt"))
	needsResync, duplicate, err := s.applySupportUnread(r.Context(), cfg, eventID, uid, requestID, count, total, date, dateErr == nil)
	if err != nil {
		return nil, err
	}
	if duplicate {
		return accepted("duplicate"), nil
	}
	s.publishCurrentUnread(uid)
	if needsResync {
		s.scheduleSupportResync(uid)
	}
	return accepted("accepted"), nil
}
func (s *Server) applySupportUnread(ctx context.Context, before Object, eventID, uid, requestID string, count int, total *int, eventAt time.Time, hasDate bool) (bool, bool, error) {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return false, false, err
	}
	defer tx.Rollback(ctx)
	cfg, err := one(ctx, tx, `SELECT value FROM "SystemSetting" WHERE key='achord-connect' FOR SHARE`)
	if err != nil {
		return false, false, err
	}
	if number(cfg, "generation") != number(before, "generation") {
		return false, false, nil
	}
	var exists bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM "User" WHERE id=$1)`, uid).Scan(&exists); err != nil {
		return false, false, err
	}
	if !exists {
		return false, false, nil
	}
	tag, err := tx.Exec(ctx, `INSERT INTO "AchordConnectWebhookEvent"("eventId",type) VALUES($1,'request.unread.changed') ON CONFLICT("eventId") DO NOTHING`, eventID)
	if err != nil {
		return false, false, err
	}
	if tag.RowsAffected() == 0 {
		return false, true, nil
	}
	if _, err = tx.Exec(ctx, `INSERT INTO "SupportUnreadState"("userId","updatedAt") VALUES($1,now()) ON CONFLICT("userId") DO NOTHING`, uid); err != nil {
		return false, false, err
	}
	state, err := one(ctx, tx, `SELECT to_jsonb(s) FROM "SupportUnreadState" s WHERE "userId"=$1 FOR UPDATE`, uid)
	if err != nil {
		return false, false, err
	}
	source, _ := parseTimestamp(text(state, "sourceAt"))
	if hasDate && !source.IsZero() && eventAt.Before(source) {
		return false, false, tx.Commit(ctx)
	}
	updateData := Object{"syncedAt": nil, "revision": number(state, "revision") + 1}
	needsResync := true
	if hasDate {
		existing, existingErr := one(ctx, tx, `SELECT to_jsonb(u) FROM "SupportRequestUnread" u WHERE "userId"=$1 AND "requestId"=$2`, uid, requestID)
		if existingErr != nil && existingErr != pgx.ErrNoRows {
			return false, false, existingErr
		}
		previous, _ := parseTimestamp(text(existing, "eventAt"))
		requestConflict := existingErr == nil && previous.Equal(eventAt) && number(existing, "unreadCount") != float64(count)
		if existingErr == pgx.ErrNoRows || previous.Before(eventAt) {
			if _, err = tx.Exec(ctx, `INSERT INTO "SupportRequestUnread"("userId","requestId","unreadCount","eventAt","updatedAt") VALUES($1,$2,$3,$4,now()) ON CONFLICT("userId","requestId") DO UPDATE SET "unreadCount"=EXCLUDED."unreadCount","eventAt"=EXCLUDED."eventAt","updatedAt"=now()`, uid, requestID, count, eventAt); err != nil {
				return false, false, err
			}
		}
		window, _ := parseTimestamp(text(state, "snapshotUntil"))
		if !requestConflict && (window.IsZero() || !eventAt.Before(window)) {
			if total != nil {
				var concurrent int
				if err = tx.QueryRow(ctx, `SELECT count(*) FROM "SupportRequestUnread" WHERE "userId"=$1 AND ("requestId"<>$2 AND "eventAt">=$3 OR "requestId"=$2 AND "eventAt">$3)`, uid, requestID, eventAt).Scan(&concurrent); err != nil {
					return false, false, err
				}
				if concurrent == 0 && !(source.Equal(eventAt) && number(state, "unreadCount") != float64(*total)) {
					updateData["unreadCount"] = *total
					updateData["sourceAt"] = eventAt.Format(time.RFC3339Nano)
					updateData["syncedAt"] = now()
					updateData["requestsComplete"] = false
					needsResync = false
				}
			} else if boolean(state, "requestsComplete", true) {
				var sum int
				if err = tx.QueryRow(ctx, `SELECT coalesce(sum("unreadCount"),0) FROM "SupportRequestUnread" WHERE "userId"=$1`, uid).Scan(&sum); err != nil {
					return false, false, err
				}
				updateData["unreadCount"] = sum
			}
		}
	}
	if _, err = updateKey(ctx, tx, "SupportUnreadState", "userId", uid, updateData, "unreadCount", "sourceAt", "syncedAt", "requestsComplete", "revision"); err != nil {
		return false, false, err
	}
	return needsResync, false, tx.Commit(ctx)
}
