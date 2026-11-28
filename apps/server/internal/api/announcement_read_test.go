package api

import (
	"context"
	"reflect"
	"sort"
	"testing"
	"time"
)

func announcementReadFixture(a *testAPI, mode string, active bool, published time.Time) string {
	a.t.Helper()
	id := newID()
	_, err := a.server.DB.Exec(context.Background(), `INSERT INTO "Announcement"(id,title,body,level,"publishedAt","isActive","displayMode","countdownSeconds","updatedAt") VALUES($1,$2,'仅本次契约测试','info',$3,$4,$5,5,now())`, id, "announcement-contract-"+id, published.UTC(), active, mode)
	if err != nil {
		a.t.Fatal(err)
	}
	a.t.Cleanup(func() { _, _ = a.server.DB.Exec(context.Background(), `DELETE FROM "Announcement" WHERE id=$1`, id) })
	return id
}
func announcementReader(a *testAPI, user Object) *testAPI {
	a.t.Helper()
	login := a.call("POST", "/api/auth/login", Object{"email": user["email"], "password": "  exact-password  "}, 200)
	return &testAPI{t: a.t, server: a.server, http: a.http, token: text(login, "accessToken"), adminID: a.adminID}
}
func assertAnnouncementUpdatedIDs(t *testing.T, result Object, expected ...string) {
	t.Helper()
	if result["ok"] != true {
		t.Fatalf("公告读状态响应失败: %#v", result)
	}
	raw, ok := result["updatedIds"].([]any)
	if !ok {
		t.Fatalf("updatedIds必须为数组而非缺失/null: %#v", result)
	}
	actual := []string{}
	for _, id := range raw {
		value, ok := id.(string)
		if !ok {
			t.Fatalf("updatedIds包含非字符串: %#v", raw)
		}
		actual = append(actual, value)
	}
	sort.Strings(actual)
	sort.Strings(expected)
	if len(actual) != len(expected) || (len(expected) > 0 && !reflect.DeepEqual(actual, expected)) {
		t.Fatalf("updatedIds=%v want=%v", actual, expected)
	}
}
func announcementReadCount(a *testAPI, userID string, ids []string) int {
	a.t.Helper()
	var count int
	if err := a.server.DB.QueryRow(context.Background(), `SELECT count(*) FROM "AnnouncementReadState" WHERE "userId"=$1 AND "announcementId"=ANY($2::text[])`, userID, ids).Scan(&count); err != nil {
		a.t.Fatal(err)
	}
	return count
}
func announcementReadEventsUntilMarker(a *testAPI, stream <-chan liveEvent, userID string) []Object {
	a.t.Helper()
	marker := newID()
	a.server.events.publish(userID, Object{"type": "policy_updated", "marker": marker, "occurredAt": now()})
	events := []Object{}
	waitLiveEvent(a.t, stream, func(event liveEvent) bool {
		if event.data["type"] == "announcement_read_state_updated" {
			events = append(events, event.data)
		}
		return event.data["marker"] == marker
	})
	return events
}

func TestAnnouncementReadCountdownDirectAck(t *testing.T) {
	a := newTestAPI(t)
	user, other := a.createUser(), a.createUser()
	reader := announcementReader(a, user)
	id := announcementReadFixture(a, "modal_countdown", true, time.Now().Add(-time.Minute))
	if _, err := a.server.DB.Exec(context.Background(), `INSERT INTO "AnnouncementReadState"(id,"announcementId","userId","acknowledgedAt","updatedAt") VALUES($1,$2,$3,now()-interval '1 hour',now()-interval '1 hour')`, newID(), id, other["id"]); err != nil {
		t.Fatal(err)
	}
	var before, after string
	readOther := func(target *string) {
		t.Helper()
		if err := a.server.DB.QueryRow(context.Background(), `SELECT to_jsonb(s)::text FROM "AnnouncementReadState" s WHERE "announcementId"=$1 AND "userId"=$2`, id, other["id"]).Scan(target); err != nil {
			t.Fatal(err)
		}
	}
	readOther(&before)
	result := reader.call("POST", "/api/client/announcements/read", Object{"announcementIds": []string{id}, "action": "ack"}, 200)
	assertAnnouncementUpdatedIDs(t, result, id)
	var seen, ack *time.Time
	if err := a.server.DB.QueryRow(context.Background(), `SELECT "passiveSeenAt","acknowledgedAt" FROM "AnnouncementReadState" WHERE "announcementId"=$1 AND "userId"=$2`, id, user["id"]).Scan(&seen, &ack); err != nil {
		t.Fatal(err)
	}
	if seen != nil || ack == nil {
		t.Fatalf("直接ack必须成功且不得伪造seen: seen=%v ack=%v", seen, ack)
	}
	readOther(&after)
	if after != before || announcementReadCount(a, text(other, "id"), []string{id}) != 1 {
		t.Fatal("确认公告修改了其他用户已有的已读状态")
	}
	for _, item := range reader.array("/api/client/announcements") {
		if item["id"] == id && item["isUnread"] != false {
			t.Fatal("直接ack后公告仍为未读")
		}
	}
}

func TestAnnouncementReadSeenIgnoresForced(t *testing.T) {
	a := newTestAPI(t)
	user := a.createUser()
	reader := announcementReader(a, user)
	passive := announcementReadFixture(a, "passive", true, time.Now().Add(-time.Minute))
	confirm := announcementReadFixture(a, "modal_confirm", true, time.Now().Add(-time.Minute))
	countdown := announcementReadFixture(a, "modal_countdown", true, time.Now().Add(-time.Minute))
	stream, _ := reader.eventStream("/api/client/events", "")
	waitLiveEvent(t, stream, func(event liveEvent) bool { return event.data["type"] == "ticket_updated" && event.id != "" })
	result := reader.call("POST", "/api/client/announcements/read", Object{"announcementIds": []string{confirm, countdown}, "action": "seen"}, 200)
	if count := announcementReadCount(a, text(user, "id"), []string{confirm, countdown}); count != 0 {
		t.Fatalf("seen不得给强制公告落库，实际%d条", count)
	}
	assertAnnouncementUpdatedIDs(t, result)
	if events := announcementReadEventsUntilMarker(reader, stream, text(user, "id")); len(events) != 0 {
		t.Fatal("seen被忽略的强制公告不应发布已读事件", events)
	}
	result = reader.call("POST", "/api/client/announcements/read", Object{"announcementIds": []string{passive, confirm, countdown}, "action": "seen"}, 200)
	assertAnnouncementUpdatedIDs(t, result, passive)
	if announcementReadCount(a, text(user, "id"), []string{passive, confirm, countdown}) != 1 {
		t.Fatal("seen必须只写普通公告")
	}
}

func TestAnnouncementReadFiltersDeduplicatesAndAcceptsEmpty(t *testing.T) {
	a := newTestAPI(t)
	user := a.createUser()
	reader := announcementReader(a, user)
	passive := announcementReadFixture(a, "passive", true, time.Now().Add(-time.Minute))
	confirm := announcementReadFixture(a, "modal_confirm", true, time.Now().Add(-time.Minute))
	inactive := announcementReadFixture(a, "passive", false, time.Now().Add(-time.Minute))
	future := announcementReadFixture(a, "modal_confirm", true, time.Now().Add(time.Hour))
	stream, _ := reader.eventStream("/api/client/events", "")
	waitLiveEvent(t, stream, func(event liveEvent) bool { return event.data["type"] == "ticket_updated" && event.id != "" })
	assertAnnouncementUpdatedIDs(t, reader.call("POST", "/api/client/announcements/read", Object{"announcementIds": []string{}, "action": "ack"}, 200))
	assertAnnouncementUpdatedIDs(t, reader.call("POST", "/api/client/announcements/read", Object{"announcementIds": []string{newID(), inactive, future, "", "  "}, "action": "seen"}, 200))
	if events := announcementReadEventsUntilMarker(reader, stream, text(user, "id")); len(events) != 0 {
		t.Fatal("空数组或全部无效的编号不应产生已读事件", events)
	}
	result := reader.call("POST", "/api/client/announcements/read", Object{"announcementIds": []string{newID(), inactive, confirm, passive, confirm, future, passive}, "action": "ack"}, 200)
	assertAnnouncementUpdatedIDs(t, result, passive, confirm)
	events := announcementReadEventsUntilMarker(reader, stream, text(user, "id"))
	counts := map[string]int{}
	for _, event := range events {
		counts[text(event, "announcementId")]++
	}
	if len(events) != 2 || counts[passive] != 1 || counts[confirm] != 1 {
		t.Fatal("同一请求的重复编号必须只写入和发布一次", events)
	}
	if announcementReadCount(a, text(user, "id"), []string{passive, confirm, inactive, future}) != 2 {
		t.Fatal("必须仅对实际有效且去重的公告写入")
	}
	assertAnnouncementUpdatedIDs(t, reader.call("POST", "/api/client/announcements/read", Object{"announcementIds": []string{newID(), inactive, future}, "action": "seen"}, 200))
	assertAnnouncementUpdatedIDs(t, reader.call("POST", "/api/client/announcements/read", Object{"announcementIds": []string{confirm, confirm}, "action": "ack"}, 200), confirm)
	if events := announcementReadEventsUntilMarker(reader, stream, text(user, "id")); len(events) != 1 || events[0]["announcementId"] != confirm {
		t.Fatal("再次确认已有状态必须仍返回实际有效编号且单次发布", events)
	}
	reader.call("POST", "/api/client/announcements/read", Object{"announcementIds": []any{1}, "action": "ack"}, 400)
	reader.call("POST", "/api/client/announcements/read", Object{"announcementIds": "not-an-array", "action": "ack"}, 400)
	reader.call("POST", "/api/client/announcements/read", Object{"announcementIds": []string{}, "action": "invalid"}, 400)
}

func TestAnnouncementReadUserScopedLiveEventsAndReplay(t *testing.T) {
	a := newTestAPI(t)
	user, other := a.createUser(), a.createUser()
	reader, sameUser, otherUser := announcementReader(a, user), announcementReader(a, user), announcementReader(a, other)
	id := announcementReadFixture(a, "passive", true, time.Now().Add(-time.Minute))
	live, _ := reader.eventStream("/api/client/events", "")
	second, stopSecond := sameUser.eventStream("/api/client/events", "")
	foreign, _ := otherUser.eventStream("/api/client/events", "")
	for _, stream := range []<-chan liveEvent{live, second, foreign} {
		waitLiveEvent(t, stream, func(event liveEvent) bool { return event.data["type"] == "ticket_updated" && event.id != "" })
	}
	cursor := a.server.events.cursor()
	reader.call("POST", "/api/client/announcements/read", Object{"announcementIds": []string{id}, "action": "ack"}, 200)
	match := func(event liveEvent) bool {
		return event.data["type"] == "announcement_read_state_updated" && event.data["announcementId"] == id
	}
	first := waitLiveEvent(t, live, match)
	if first.data["userId"] != user["id"] || first.id == "" {
		t.Fatalf("已读事件缺少正确归属或游标: %#v", first)
	}
	if _, err := time.Parse(time.RFC3339Nano, text(first.data, "occurredAt")); err != nil {
		t.Fatal("已读事件时间无效", err)
	}
	if event := waitLiveEvent(t, second, match); event.id != first.id {
		t.Fatal("同一用户的其他会话未收到相同事件")
	}
	stopSecond()
	replay, _ := sameUser.eventStream("/api/client/events", cursor)
	if event := waitLiveEvent(t, replay, match); event.id != first.id {
		t.Fatal("已读状态事件无法按游标重放")
	}
	marker := newID()
	a.server.events.publish(text(other, "id"), Object{"type": "policy_updated", "marker": marker, "occurredAt": now()})
	assertForeign := func(event liveEvent) bool {
		if match(event) {
			t.Fatal("当前用户已读事件泄露到其他普通用户")
		}
		return event.data["marker"] == marker
	}
	waitLiveEvent(t, foreign, assertForeign)
	foreignReplay, _ := otherUser.eventStream("/api/client/events", cursor)
	waitLiveEvent(t, foreignReplay, assertForeign)
	if announcementReadCount(a, text(other, "id"), []string{id}) != 0 {
		t.Fatal("其他用户的数据库已读状态被修改")
	}
}
