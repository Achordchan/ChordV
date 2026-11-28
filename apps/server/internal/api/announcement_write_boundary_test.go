package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"
)

func TestAnnouncementWriteContractAuthorizationUnknownFieldsAndMissingRecord(t *testing.T) {
	f := newAnnouncementWriteFixture(t, true)
	adminToken := f.a.token
	for _, test := range []struct {
		token  string
		status int
	}{{"", 401}, {"invalid-token", 401}, {f.reader.token, 403}} {
		f.a.token = test.token
		before, sequence := policySchemaDigest(t, f.a), panelEventSequence(f.a)
		status, _ := f.request(t, "create", Object{"title": "标题", "body": "正文", "level": "info"})
		if status != test.status {
			t.Error("非管理员写公告状态错误", status, test.status)
		}
		announcementWriteAssertOtherTables(t, f, before)
		f.observe(t, 0, "", sequence)
	}
	f.a.token = adminToken
	before, sequence := policySchemaDigest(t, f.a), panelEventSequence(f.a)
	status, result := f.request(t, "update", Object{"title": "  白名单标题  ", "id": "supplied-id", "createdAt": "2099-01-01T00:00:00Z", "userId": "supplied-user", "readStates": []any{}})
	if status != 200 || result["id"] != f.id || result["title"] != "白名单标题" || result["createdAt"] != "2019-01-01T00:00:00Z" {
		t.Error("公告字段白名单失效", status, result)
	}
	announcementWriteAssertOtherTables(t, f, before, "Announcement")
	f.observe(t, 1, f.id, sequence)
	for _, method := range []string{"PATCH", "DELETE"} {
		before, sequence = policySchemaDigest(t, f.a), panelEventSequence(f.a)
		status, _ = routingContractRequest(t, f.a, method, "/api/admin/announcements/"+newID(), Object{"title": "不存在"})
		if status != 404 {
			t.Error("不存在公告应404", method, status)
		}
		announcementWriteAssertOtherTables(t, f, before)
		f.observe(t, 0, "", sequence)
	}
	for _, value := range []string{"1_0", "0x+10", "0x-10"} {
		before, sequence = policySchemaDigest(t, f.a), panelEventSequence(f.a)
		status, _ = f.request(t, "update", Object{"countdownSeconds": value})
		if status != 400 {
			t.Error("Go数字语法不得替代DTO的JS Number转换", value, status)
		}
		announcementWriteAssertOtherTables(t, f, before)
		f.observe(t, 0, "", sequence)
	}
	before, sequence = policySchemaDigest(t, f.a), panelEventSequence(f.a)
	status, _ = f.request(t, "update", Object{"publishedAt": "2020-01-02t03:04:05z"})
	if status != 400 {
		t.Error("旧ISO DTO不接受小写t分隔符", status)
	}
	announcementWriteAssertOtherTables(t, f, before)
	f.observe(t, 0, "", sequence)
	sequence = panelEventSequence(f.a)
	status, result = f.request(t, "update", Object{"countdownSeconds": "0x10000000000000000", "publishedAt": "2020-01-02T03:04:05z"})
	if status != 200 || result["countdownSeconds"] != float64(0) {
		t.Error("DTO合法大整数在passive模式应归零，且允许小写z", status)
	}
	f.observe(t, 1, f.id, sequence)
}

func TestAnnouncementWriteContractConcurrentModeAndCountdownStayConsistent(t *testing.T) {
	f := newAnnouncementWriteFixture(t, false)
	for iteration := 0; iteration < 16; iteration++ {
		f.seed(t, nil)
		before, sequence := policySchemaDigest(t, f.a), panelEventSequence(f.a)
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		start, results := make(chan struct{}), make(chan int, 2)
		for _, input := range []Object{{"displayMode": "modal_countdown"}, {"countdownSeconds": 9}} {
			raw, err := json.Marshal(input)
			if err != nil {
				t.Fatal(err)
			}
			go func(raw []byte) {
				<-start
				request, err := http.NewRequestWithContext(ctx, "PATCH", f.a.http.URL+"/api/admin/announcements/"+f.id, bytes.NewReader(raw))
				if err != nil {
					results <- 0
					return
				}
				request.Header.Set("Content-Type", "application/json")
				request.Header.Set("Authorization", "Bearer "+f.a.token)
				response, err := f.a.http.Client().Do(request)
				if err != nil {
					results <- 0
					return
				}
				io.Copy(io.Discard, response.Body)
				response.Body.Close()
				results <- response.StatusCode
			}(raw)
		}
		close(start)
		first, second := <-results, <-results
		cancel()
		if first != 200 || second != 200 {
			t.Fatal("并发公告更新失败或死锁", first, second)
		}
		row, err := one(context.Background(), f.a.server.DB, `SELECT to_jsonb(a) FROM "Announcement" a WHERE id=$1`, f.id)
		if err != nil || row["displayMode"] != "modal_countdown" || (row["countdownSeconds"] != float64(5) && row["countdownSeconds"] != float64(9)) {
			t.Fatal("mode/countdown出现非串行状态", row, err)
		}
		announcementWriteAssertOtherTables(t, f, before, "Announcement")
		f.observe(t, 2, f.id, sequence)
	}
	t.Log("16组mode/countdown真实HTTP并发：均串行等价为modal_countdown+5/9秒，无零秒倒计时；每组2次提交/2条带ID SSE")
}
