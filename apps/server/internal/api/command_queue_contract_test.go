package api

import (
	"context"
	"testing"
)

func (a *testAPI) queueFixtureJob(target commandQueueFixture, overrides Object) Object {
	a.t.Helper()
	input := Object{"dedupeKey": "queue-test-" + newID(), "nodeId": target.node["id"], "agentId": target.job["agentId"], "commandType": "ENSURE_USER", "bindingId": target.binding["id"], "subscriptionId": target.binding["subscriptionId"], "userId": target.user["id"], "status": "pending", "nextRunAt": "2030-01-01T00:00:00Z", "createdAt": now()}
	for key, value := range overrides {
		input[key] = value
	}
	job, err := one(context.Background(), a.server.DB, `WITH inserted AS(INSERT INTO "NodeCommandJob"(id,"dedupeKey","nodeId","agentId","commandType","bindingId","subscriptionId","userId",payload,status,"nextRunAt","createdAt","updatedAt","lastError","resolvedAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,'{}',$9,$10,$11,now(),$12,$13) RETURNING *) SELECT to_jsonb(inserted) FROM inserted`, newID(), input["dedupeKey"], input["nodeId"], input["agentId"], input["commandType"], input["bindingId"], input["subscriptionId"], input["userId"], input["status"], input["nextRunAt"], input["createdAt"], input["lastError"], input["resolvedAt"])
	if err != nil {
		a.t.Fatal(err)
	}
	return job
}

func TestCommandQueueExcludesHistoryBeforeLimitAndKeepsLiveOrdering(t *testing.T) {
	a := newTestAPI(t)
	fixture := a.cancelledCommand()
	_, err := a.server.DB.Exec(context.Background(), `INSERT INTO "NodeCommandJob"(id,"dedupeKey","nodeId","commandType",payload,status,"resolvedAt","updatedAt") SELECT $1||i,$1||i,$2,'ENSURE_USER','{}',CASE WHEN i%2=0 THEN 'completed' ELSE 'cancelled' END::"NodeAgentJobStatus",now(),now() FROM generate_series(1,450) i`, newID(), fixture.node["id"])
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/admin/nodes/node-command-jobs?nodeId=" + text(fixture.node, "id")
	queue := a.call("GET", path, nil, 200)
	if jobs := queueJobs(t, queue); len(jobs) != 1 || jobs[0]["id"] != fixture.job["id"] {
		t.Fatal("已完成/已处理的450条历史挤占了真实待处理队列")
	}
	assertQueueOutstanding(t, queue, fixture, 1)
	if _, err = update(context.Background(), a.server.DB, "NodeCommandJob", text(fixture.job, "id"), Object{"lastError": "A newest error"}, "lastError"); err != nil {
		t.Fatal(err)
	}
	first := a.queueFixtureJob(fixture, Object{"createdAt": "2021-01-01T00:00:00Z", "resolvedAt": now()})
	second := a.queueFixtureJob(fixture, Object{"createdAt": "2020-01-01T00:00:00Z"})
	third := a.queueFixtureJob(fixture, Object{"createdAt": "2022-01-01T00:00:00Z", "nextRunAt": "2030-01-02T00:00:00Z"})
	running := a.queueFixtureJob(fixture, Object{"status": "running"})
	failed := a.queueFixtureJob(fixture, Object{"status": "failed", "createdAt": "2020-01-01T00:00:00Z", "lastError": "Z older error"})
	queue = a.call("GET", path, nil, 200)
	jobs := queueJobs(t, queue)
	expected := []Object{first, second, third, running, failed, fixture.job}
	if len(jobs) != len(expected) {
		t.Fatal("活跃队列遗漏任务或包含历史", len(jobs))
	}
	for index, job := range expected {
		if jobs[index]["id"] != job["id"] {
			t.Fatalf("任务未按 status/nextRunAt/createdAt 排序，index=%d", index)
		}
	}
	assertQueueOutstanding(t, queue, fixture, 6)
	for _, value := range queue["summaries"].(map[string]any)["nodes"].([]any) {
		row := value.(map[string]any)
		if row["key"] == fixture.node["id"] && (row["pending"] != float64(3) || row["running"] != float64(1) || row["failed"] != float64(2) || row["lastError"] != "A newest error") {
			t.Fatal("摘要应按活跃状态计数并取最新错误，而非字典序最大错误", row)
		}
	}
}

func TestCommandQueueScopedDetailSurvivesGlobalPageLimit(t *testing.T) {
	a := newTestAPI(t)
	target, other := a.cancelledCommand(), a.cancelledCommand()
	_, err := a.server.DB.Exec(context.Background(), `INSERT INTO "NodeCommandJob"(id,"dedupeKey","nodeId","commandType",payload,status,"bindingId","subscriptionId","userId","nextRunAt","updatedAt") SELECT $1||i,$1||i,$2,'ENSURE_USER','{}','pending',$3,$4,$5,now()+interval '1 hour',now() FROM generate_series(1,210) i`, newID(), other.node["id"], other.binding["id"], other.binding["subscriptionId"], other.user["id"])
	if err != nil {
		t.Fatal(err)
	}
	global := a.call("GET", "/api/admin/nodes/node-command-jobs", nil, 200)
	if len(queueJobs(t, global)) != 200 {
		t.Fatal("全局详情必须保持200条上限")
	}
	assertNoQueueJob(t, global, text(target.job, "id"))
	for _, filter := range []string{"nodeId=" + text(target.node, "id"), "userId=" + text(target.user, "id"), "nodeId=" + text(target.node, "id") + "&userId=" + text(target.user, "id")} {
		queue := a.call("GET", "/api/admin/nodes/node-command-jobs?"+filter, nil, 200)
		if jobs := queueJobs(t, queue); len(jobs) != 1 || jobs[0]["id"] != target.job["id"] {
			t.Fatal("过滤必须发生于LIMIT前，目标详情不能消失", filter)
		}
		assertQueueOutstanding(t, queue, target, 1)
		assertQueueOutstanding(t, queue, other, 211)
	}
	empty := a.call("GET", "/api/admin/nodes/node-command-jobs?nodeId="+text(target.node, "id")+"&userId="+text(other.user, "id"), nil, 200)
	if len(queueJobs(t, empty)) != 0 {
		t.Fatal("nodeId和userId必须交集过滤")
	}
}

func TestCommandQueueRetryabilityUsesCurrentActiveBinding(t *testing.T) {
	a := newTestAPI(t)
	fixture := a.cancelledCommand()
	rows := []Object{fixture.job}
	for _, kind := range []string{"ENABLE_USER", "DISABLE_USER", "REMOVE_USER", "REFRESH_QUOTA", "ENSURE_INBOUND"} {
		rows = append(rows, a.queueFixtureJob(fixture, Object{"status": "cancelled", "commandType": kind}))
	}
	path := "/api/admin/nodes/node-command-jobs?nodeId=" + text(fixture.node, "id")
	queue := a.call("GET", path, nil, 200)
	for _, row := range rows {
		job := queueJob(t, queue, text(row, "id"))
		want := row["commandType"] == "ENSURE_USER" || row["commandType"] == "ENABLE_USER"
		if job["retryable"] != want || job["dismissible"] != true {
			t.Fatalf("人工重试只支持active绑定的ENSURE/ENABLE，type=%s", text(row, "commandType"))
		}
	}
	if _, err := update(context.Background(), a.server.DB, "PanelClientBinding", text(fixture.binding, "id"), Object{"status": "disabled"}, "status"); err != nil {
		t.Fatal(err)
	}
	queue = a.call("GET", path, nil, 200)
	for _, job := range queueJobs(t, queue) {
		if job["retryable"] != false || job["dismissible"] != true {
			t.Fatal("绑定停用后不可继续显示重试按钮")
		}
	}
}
