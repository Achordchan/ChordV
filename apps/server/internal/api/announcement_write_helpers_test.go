package api

import (
	"context"
	"encoding/json"
	"os"
	"reflect"
	"testing"
	"time"
)

type announcementWriteSample struct {
	Name    string `json:"name"`
	Op      string `json:"op"`
	Input   Object `json:"input"`
	Status  int    `json:"status"`
	Fields  Object `json:"fields"`
	Current Object `json:"current"`
}
type announcementWriteReference struct {
	Commit               string                    `json:"commit"`
	Samples              []announcementWriteSample `json:"results"`
	Transitions          []announcementWriteSample `json:"transitions"`
	ClientProjectionKeys []string                  `json:"clientProjectionKeys"`
}

func announcementWriteLegacy(t *testing.T) announcementWriteReference {
	t.Helper()
	raw, err := os.ReadFile("testdata/announcement-write-legacy.json")
	if err != nil {
		t.Fatal(err)
	}
	var ref announcementWriteReference
	if err = json.Unmarshal(raw, &ref); err != nil || ref.Commit != "397a64d" || len(ref.Samples) != 258 {
		t.Fatal("旧公告DTO/service实证无效", err)
	}
	return ref
}

type announcementWriteFixture struct {
	a, reader                 *testAPI
	id                        string
	adminEvents, clientEvents <-chan liveEvent
}

func newAnnouncementWriteFixture(t *testing.T, client bool) *announcementWriteFixture {
	t.Helper()
	a := newTestAPI(t)
	f := &announcementWriteFixture{a: a, id: newID()}
	if client {
		user := a.createUser()
		f.reader = announcementReader(a, user)
	}
	f.seed(t, nil)
	f.adminEvents, _ = a.eventStream("/api/admin/events/stream", "")
	waitLiveEvent(t, f.adminEvents, func(event liveEvent) bool { return event.data["type"] == "presence_updated" })
	if client {
		f.clientEvents, _ = f.reader.eventStream("/api/client/events/stream", "")
		waitLiveEvent(t, f.clientEvents, func(event liveEvent) bool { return event.data["type"] == "ticket_updated" })
		waitLiveEvent(t, f.adminEvents, func(event liveEvent) bool { return event.data["type"] == "presence_updated" })
	}
	return f
}
func (f *announcementWriteFixture) seed(t *testing.T, changes Object) {
	t.Helper()
	if _, err := f.a.server.DB.Exec(context.Background(), `DELETE FROM "Announcement"`); err != nil {
		t.Fatal(err)
	}
	data := Object{"title": "原标题", "body": "原正文", "level": "info", "publishedAt": "2020-01-01T00:00:00Z", "isActive": true, "displayMode": "passive", "countdownSeconds": 0}
	for key, value := range changes {
		data[key] = value
	}
	raw, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.a.server.DB.Exec(context.Background(), `INSERT INTO "Announcement" SELECT (jsonb_populate_record(NULL::"Announcement",$1::jsonb||jsonb_build_object('id',$2::text,'createdAt','2019-01-01T00:00:00Z','updatedAt','2019-01-01T00:00:00Z'))).*`, raw, f.id); err != nil {
		t.Fatal(err)
	}
}
func (f *announcementWriteFixture) request(t *testing.T, op string, input Object) (int, Object) {
	t.Helper()
	method, path := "POST", "/api/admin/announcements"
	if op == "update" {
		method, path = "PATCH", path+"/"+f.id
	}
	return routingContractRequest(t, f.a, method, path, input)
}
func (f *announcementWriteFixture) observe(t *testing.T, want int, id string, before uint64) {
	t.Helper()
	if delta := panelEventSequence(f.a) - before; delta != uint64(want) {
		t.Errorf("公告业务事件序列增量=%d want=%d", delta, want)
	}
	for _, stream := range []<-chan liveEvent{f.adminEvents, f.clientEvents} {
		if stream == nil {
			continue
		}
		marker, count := newID(), 0
		f.a.server.events.publish("", Object{"type": "test_announcement_write_barrier", "marker": marker})
		waitLiveEvent(t, stream, func(event liveEvent) bool {
			if event.data["type"] == "test_announcement_write_barrier" {
				return event.data["marker"] == marker
			}
			if event.data["type"] != "announcement_updated" {
				t.Errorf("公告出现无关事件:%v", event.data)
			} else {
				count++
				if event.data["announcementId"] != id {
					t.Errorf("公告事件缺少精确ID:got=%v want=%s", event.data, id)
				}
			}
			return false
		})
		if count != want {
			t.Errorf("真实SSE公告事件=%d want=%d", count, want)
		}
	}
}
func announcementWriteFields(t *testing.T, value Object) Object {
	t.Helper()
	fields := pick(value, "title", "body", "level", "publishedAt", "isActive", "displayMode", "countdownSeconds")
	if date, ok := fields["publishedAt"].(string); ok {
		if parsed, err := parseTimestamp(date); err == nil {
			fields["publishedAt"] = parsed.UTC().Format(time.RFC3339Nano)
		}
	}
	return fields
}

func announcementWriteExpectedFields(t *testing.T, sample announcementWriteSample) Object {
	t.Helper()
	fields := announcementWriteFields(t, sample.Fields)
	// The original 258-case oracle ran in UTC and has one ordinary, non-DST
	// unzoned datetime. Its local mapping was independently checked in four TZ
	// processes; transition cases use the separate original-Date oracle.
	if sample.Input["publishedAt"] == "2020-01-02T03:04:05" {
		date, err := time.ParseInLocation("2006-01-02T15:04:05", sample.Input["publishedAt"].(string), time.Local)
		if err != nil {
			t.Fatal(err)
		}
		fields["publishedAt"] = date.UTC().Format(time.RFC3339Nano)
	}
	return fields
}
func announcementWriteAssertOtherTables(t *testing.T, f *announcementWriteFixture, before Object, allowed ...string) {
	t.Helper()
	after := policySchemaDigest(t, f.a)
	for table, digest := range before {
		permitted := false
		for _, name := range allowed {
			permitted = permitted || name == table
		}
		if !permitted && !reflect.DeepEqual(digest, after[table]) {
			t.Errorf("公告请求改动无关表:%s", table)
		}
	}
}
