package api

import (
	"context"
	"reflect"
	"sort"
	"testing"
	"time"
)

func TestAnnouncementWriteContractMatchesOriginalDTOAndServiceHTTP(t *testing.T) {
	f := newAnnouncementWriteFixture(t, false)
	accepted, rejected, dateFailures := 0, 0, 0
	for _, sample := range announcementWriteLegacy(t).Samples {
		f.seed(t, nil)
		if sample.Op == "create" {
			if _, err := f.a.server.DB.Exec(context.Background(), `DELETE FROM "Announcement"`); err != nil {
				t.Fatal(err)
			}
		}
		before, sequence, started := policySchemaDigest(t, f.a), panelEventSequence(f.a), time.Now()
		status, response := f.request(t, sample.Op, sample.Input)
		want := sample.Status
		if want == 503 {
			want = 400
			dateFailures++
		}
		if status != want {
			t.Errorf("sample=%s status=%d want=%d message=%v", sample.Name, status, want, response["message"])
		}
		if sample.Status == 200 && status == 200 {
			actual, expected := announcementWriteFields(t, response), announcementWriteExpectedFields(t, sample)
			if sample.Op == "create" && sample.Input["publishedAt"] == nil {
				date, err := parseTimestamp(text(actual, "publishedAt"))
				if err != nil || date.Before(started.Add(-time.Second)) || date.After(time.Now().Add(time.Second)) {
					t.Error("缺省公告发布时间未使用本次保存时间", err)
				}
				delete(actual, "publishedAt")
				delete(expected, "publishedAt")
			}
			if !reflect.DeepEqual(actual, expected) {
				t.Errorf("sample=%s 公告写入旧契约差异:got=%v want=%v", sample.Name, actual, expected)
			}
			announcementWriteAssertOtherTables(t, f, before, "Announcement")
			accepted++
		} else if sample.Status != 200 {
			announcementWriteAssertOtherTables(t, f, before)
			rejected++
		}
		if status == 200 {
			f.observe(t, 1, text(response, "id"), sequence)
		} else {
			f.observe(t, 0, "", sequence)
		}
	}
	t.Logf("原DTO+真实旧Prisma全部258样本：合法=%d 拒绝=%d；其中旧JS Date失败503改前置400=%d，负控全表/SSE零副作用", accepted, rejected, dateFailures)
}

func TestAnnouncementWriteContractModeTransitionsHTTP(t *testing.T) {
	f := newAnnouncementWriteFixture(t, true)
	for _, sample := range announcementWriteLegacy(t).Transitions {
		t.Run(sample.Name, func(t *testing.T) {
			f.seed(t, sample.Current)
			before, sequence := policySchemaDigest(t, f.a), panelEventSequence(f.a)
			status, result := f.request(t, "update", sample.Input)
			if status != 200 || !reflect.DeepEqual(announcementWriteFields(t, result), announcementWriteFields(t, sample.Fields)) {
				t.Errorf("模式转换差异:status=%d got=%v want=%v", status, announcementWriteFields(t, result), sample.Fields)
			}
			announcementWriteAssertOtherTables(t, f, before, "Announcement")
			f.observe(t, 1, f.id, sequence)
		})
	}
}

func TestAnnouncementWriteContractClientProjectionOrderingAndReadState(t *testing.T) {
	f := newAnnouncementWriteFixture(t, true)
	id := f.id
	if _, err := f.a.server.DB.Exec(context.Background(), `UPDATE "Announcement" SET "displayMode"='modal_countdown',"countdownSeconds"=5 WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	if _, err := f.a.server.DB.Exec(context.Background(), `INSERT INTO "AnnouncementReadState"(id,"announcementId","userId","acknowledgedAt","updatedAt") VALUES($1,$2,(SELECT id FROM "User" WHERE role='user' LIMIT 1),now(),now())`, newID(), id); err != nil {
		t.Fatal(err)
	}
	items := f.reader.array("/api/client/announcements")
	if len(items) != 1 || items[0]["isUnread"] != false {
		t.Fatal("客户端已确认状态丢失", items)
	}
	keys := []string{}
	for key := range items[0] {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	want := announcementWriteLegacy(t).ClientProjectionKeys
	sort.Strings(want)
	if !reflect.DeepEqual(keys, want) {
		t.Errorf("客户端混入后台字段或缺失公共字段:got=%v want=%v", keys, want)
	}
	sequence := panelEventSequence(f.a)
	reads := policySchemaDigest(t, f.a)["AnnouncementReadState"]
	_, result := f.request(t, "update", Object{"title": "  新标题  ", "displayMode": "passive"})
	if result["title"] != "新标题" || result["countdownSeconds"] != float64(0) {
		t.Error("标题/mode更新未规范化", result)
	}
	if !reflect.DeepEqual(reads, policySchemaDigest(t, f.a)["AnnouncementReadState"]) {
		t.Error("修改公告不得擅自清理用户已读状态")
	}
	f.observe(t, 1, id, sequence)
	for _, row := range []struct {
		id, created string
		active      bool
		published   string
	}{{"older", "2020-01-01T00:00:00Z", true, "2020-01-01T00:00:00Z"}, {"newer", "2021-01-01T00:00:00Z", true, "2020-01-01T00:00:00Z"}, {"disabled", "2023-01-01T00:00:00Z", false, "2020-01-01T00:00:00Z"}, {"future", "2024-01-01T00:00:00Z", true, "2099-01-01T00:00:00Z"}} {
		if _, err := f.a.server.DB.Exec(context.Background(), `INSERT INTO "Announcement"(id,title,body,level,"publishedAt","createdAt","updatedAt","isActive") VALUES($1,$1,'正文','info',$2,$3,now(),$4)`, row.id, row.published, row.created, row.active); err != nil {
			t.Fatal(err)
		}
	}
	items = f.reader.array("/api/client/announcements")
	if len(items) != 3 || items[0]["id"] != "newer" || items[1]["id"] != "older" {
		t.Error("客户端应仅列已生效公告并按publishedAt/createdAt双降序", items)
	}
	admin := f.a.array("/api/admin/announcements")
	if len(admin) != 5 || admin[0]["id"] != "future" || admin[1]["id"] != "disabled" || admin[2]["id"] != "newer" {
		t.Error("后台双降序或草稿/未来公告列表错误", admin)
	}
}

func TestAnnouncementWriteContractDeleteResponseCascadeAndRollback(t *testing.T) {
	f := newAnnouncementWriteFixture(t, true)
	if _, err := f.a.server.DB.Exec(context.Background(), `INSERT INTO "AnnouncementReadState"(id,"announcementId","userId","passiveSeenAt","updatedAt") VALUES($1,$2,(SELECT id FROM "User" WHERE role='user' LIMIT 1),now(),now())`, newID(), f.id); err != nil {
		t.Fatal(err)
	}
	before, sequence := policySchemaDigest(t, f.a), panelEventSequence(f.a)
	status, result := routingContractRequest(t, f.a, "DELETE", "/api/admin/announcements/"+f.id, nil)
	if status != 200 || result["ok"] != true || result["announcementId"] != f.id {
		t.Error("删除响应未保留公告ID", status, result)
	}
	announcementWriteAssertOtherTables(t, f, before, "Announcement", "AnnouncementReadState")
	var count int
	if err := f.a.server.DB.QueryRow(context.Background(), `SELECT count(*) FROM "AnnouncementReadState" WHERE "announcementId"=$1`, f.id).Scan(&count); err != nil || count != 0 {
		t.Fatal("删除未级联读状态", count, err)
	}
	f.observe(t, 1, f.id, sequence)
	before, sequence = policySchemaDigest(t, f.a), panelEventSequence(f.a)
	status, _ = routingContractRequest(t, f.a, "DELETE", "/api/admin/announcements/"+f.id, nil)
	if status != 404 {
		t.Error("重复删除不存在公告应404", status)
	}
	announcementWriteAssertOtherTables(t, f, before)
	f.observe(t, 0, "", sequence)
	f.seed(t, nil)
	if _, err := f.a.server.DB.Exec(context.Background(), `CREATE FUNCTION reject_announcement_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test private deferred rejection' USING ERRCODE='23514'; END $$; CREATE CONSTRAINT TRIGGER reject_announcement_commit AFTER UPDATE ON "Announcement" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_announcement_commit()`); err != nil {
		t.Fatal(err)
	}
	before, sequence = policySchemaDigest(t, f.a), panelEventSequence(f.a)
	status, _ = f.request(t, "update", Object{"displayMode": "modal_countdown", "countdownSeconds": 7, "title": "不应持久化"})
	if status != 400 {
		t.Error("提交阶段约束失败必须拒绝", status)
	}
	announcementWriteAssertOtherTables(t, f, before)
	f.observe(t, 0, "", sequence)
}
