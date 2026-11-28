package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

type commandQueueFixture struct {
	node, user, binding, job Object
	agentToken               string
}

func (a *testAPI) cancelledCommand() commandQueueFixture {
	a.t.Helper()
	user := a.createUser()
	plan := a.createPlan("personal")
	sub := a.call("POST", "/api/admin/subscriptions", Object{"userId": user["id"], "planId": plan["id"], "expireAt": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}, 200)
	node, agentToken, binding := a.readyBinding(user, sub)
	a.server.tasks.wg.Wait()
	// A retry-exhausted, already acknowledged job is the fixture; all mutations
	// and queue assertions below go through the real HTTP handlers.
	job, err := one(context.Background(), a.server.DB, `UPDATE "NodeCommandJob" SET status='cancelled',"resolvedAt"=NULL,"lastError"='local retry exhausted',attempts=8 WHERE id=(SELECT id FROM "NodeCommandJob" WHERE "bindingId"=$1 AND "commandType"='ENSURE_USER' ORDER BY "targetRevision" DESC LIMIT 1) RETURNING to_jsonb("NodeCommandJob")`, binding["id"])
	if err != nil {
		a.t.Fatal(err)
	}
	return commandQueueFixture{node: node, user: user, binding: binding, job: job, agentToken: agentToken}
}

func assertQueueOutstanding(t *testing.T, queue Object, target commandQueueFixture, expected float64) {
	t.Helper()
	queueJobs(t, queue)
	for scope, id := range map[string]string{"nodes": text(target.node, "id"), "users": text(target.user, "id"), "subscriptions": text(target.binding, "subscriptionId")} {
		count := float64(0)
		for _, value := range queue["summaries"].(map[string]any)[scope].([]any) {
			row := value.(map[string]any)
			if row["key"] == id {
				count = row["total"].(float64)
			}
		}
		if count != expected {
			t.Fatalf("%s 待处理摘要=%v，期望=%v", scope, count, expected)
		}
	}
}

func queueJobs(t *testing.T, queue Object) []Object {
	t.Helper()
	items, ok := queue["jobs"].([]any)
	if !ok {
		t.Fatalf("队列必须提供可直接 length/map 的 jobs 数组，实际类型=%T", queue["jobs"])
	}
	summaries, ok := queue["summaries"].(map[string]any)
	if !ok {
		t.Fatal("队列缺少 summaries 对象")
	}
	for _, scope := range []string{"nodes", "subscriptions", "users", "teams"} {
		if _, ok := summaries[scope].([]any); !ok {
			t.Fatalf("summaries.%s 必须为数组", scope)
		}
	}
	jobs := make([]Object, 0, len(items))
	for _, item := range items {
		job, ok := item.(map[string]any)
		if !ok {
			t.Fatal("jobs 包含非对象项目")
		}
		if _, ok := job["targetRevision"].(string); !ok {
			t.Fatal("targetRevision 必须保留字符串精度")
		}
		for _, field := range []string{"retryable", "dismissible"} {
			if _, ok := job[field].(bool); !ok {
				t.Fatalf("命令缺少 %s 状态", field)
			}
		}
		if _, exists := job["payload"]; exists {
			t.Fatal("管理队列不应返回命令凭据 payload")
		}
		if job["status"] == "completed" || (job["status"] == "cancelled" && job["resolvedAt"] != nil) {
			t.Fatal("已完成或已处理历史不应进入待处理队列")
		}
		jobs = append(jobs, job)
	}
	return jobs
}

func queueJob(t *testing.T, queue Object, id string) Object {
	t.Helper()
	for _, job := range queueJobs(t, queue) {
		if job["id"] == id {
			return job
		}
	}
	t.Fatalf("队列缺少命令 %s", id)
	return nil
}

func assertNoQueueJob(t *testing.T, queue Object, id string) {
	t.Helper()
	for _, job := range queueJobs(t, queue) {
		if job["id"] == id {
			t.Fatalf("已处理命令 %s 仍留在队列", id)
		}
	}
}

func assertCommandQueueScopes(a *testAPI, target, other commandQueueFixture, oldVisible bool) {
	a.t.Helper()
	global := a.call("GET", "/api/admin/nodes/node-command-jobs", nil, 200)
	if oldVisible {
		queueJob(a.t, global, text(target.job, "id"))
	} else {
		assertNoQueueJob(a.t, global, text(target.job, "id"))
	}
	queueJob(a.t, global, text(other.job, "id"))
	for _, scope := range []struct{ key, value, column string }{
		{"nodeId", text(target.node, "id"), "nodeId"},
		{"userId", text(target.user, "id"), "userId"},
	} {
		queue := a.call("GET", "/api/admin/nodes/node-command-jobs?"+scope.key+"="+url.QueryEscape(scope.value), nil, 200)
		if oldVisible {
			queueJob(a.t, queue, text(target.job, "id"))
		} else {
			assertNoQueueJob(a.t, queue, text(target.job, "id"))
		}
		// Scoped GET filters details only; summaries remain global as before.
		assertQueueOutstanding(a.t, queue, other, 1)
		for _, job := range queueJobs(a.t, queue) {
			if job[scope.column] != scope.value {
				a.t.Fatalf("%s 详情过滤泄入其他对象的命令", scope.key)
			}
		}
	}
}

func TestRetryCommandReturnsCommittedGlobalQueueAndPublishesSSE(t *testing.T) {
	a := newTestAPI(t)
	target, other := a.cancelledCommand(), a.cancelledCommand()
	currentUUID := newID()
	if _, err := update(context.Background(), a.server.DB, "NodeCommandJob", text(target.job, "id"), Object{"commandType": "ENABLE_USER", "payload": Object{"uuid": "retired-command-uuid"}}, "commandType", "payload"); err != nil {
		t.Fatal(err)
	}
	if _, err := update(context.Background(), a.server.DB, "PanelClientBinding", text(target.binding, "id"), Object{"panelClientId": currentUUID}, "panelClientId"); err != nil {
		t.Fatal(err)
	}
	assertCommandQueueScopes(a, target, other, true)
	events, _ := a.eventStream("/api/admin/events/stream", "")
	// Consume the initial full-sync boundary, not a mutation notification.
	waitLiveEvent(t, events, func(e liveEvent) bool { return e.data["type"] == "presence_updated" })
	agent := &testAPI{t: t, server: a.server, http: a.http, token: target.agentToken}
	commands, _ := agent.eventStream("/api/agent/v1/events", "")
	queue := a.call("POST", "/api/admin/nodes/node-command-jobs/"+text(target.job, "id")+"/retry?nodeId="+text(target.node, "id"), Object{}, 200)
	queueJob(t, queue, text(other.job, "id"))
	assertNoQueueJob(t, queue, text(target.job, "id"))
	var fresh Object
	for _, job := range queueJobs(t, queue) {
		if job["bindingId"] == target.binding["id"] && job["id"] != target.job["id"] && (job["status"] == "pending" || job["status"] == "running") {
			fresh = job
		}
	}
	if fresh == nil {
		t.Fatal("重试响应缺少新下发的命令")
	}
	assertQueueOutstanding(t, queue, target, 1)
	waitLiveEvent(t, events, func(e liveEvent) bool { return e.data["type"] == "sync_queue_updated" })
	delivered := waitLiveEvent(t, commands, func(e liveEvent) bool { return e.data["commandId"] == fresh["id"] })
	if delivered.data["type"] != "ENSURE_USER" || delivered.data["targetRevision"] != fresh["targetRevision"] {
		t.Fatal("Agent SSE 收到的命令与提交后响应不一致")
	}
	if payload, ok := delivered.data["payload"].(map[string]any); !ok || payload["uuid"] != currentUUID {
		t.Fatal("重试应按当前绑定重建ENSURE_USER，不能重放旧ENABLE_USER载荷")
	}
	read := a.call("GET", "/api/admin/nodes/node-command-jobs", nil, 200)
	queueJob(t, read, text(fresh, "id"))
	assertCommandQueueScopes(a, target, other, false)
	// Repeating a handled retry must not enqueue another replacement.
	a.call("POST", "/api/admin/nodes/node-command-jobs/"+text(target.job, "id")+"/retry", Object{}, 404)
}

func TestDismissCommandReturnsCommittedGlobalQueueAndPublishesSSE(t *testing.T) {
	a := newTestAPI(t)
	target, other := a.cancelledCommand(), a.cancelledCommand()
	assertCommandQueueScopes(a, target, other, true)
	events, _ := a.eventStream("/api/admin/events/stream", "")
	waitLiveEvent(t, events, func(e liveEvent) bool { return e.data["type"] == "presence_updated" })
	queue := a.call("POST", "/api/admin/nodes/node-command-jobs/"+text(target.job, "id")+"/dismiss?userId="+text(target.user, "id"), Object{}, 200)
	queueJob(t, queue, text(other.job, "id"))
	assertNoQueueJob(t, queue, text(target.job, "id"))
	assertQueueOutstanding(t, queue, target, 0)
	for _, job := range queueJobs(t, queue) {
		if job["bindingId"] == target.binding["id"] && job["id"] != target.job["id"] {
			t.Fatal("标记处理不应向 Agent 新下发命令")
		}
	}
	waitLiveEvent(t, events, func(e liveEvent) bool { return e.data["type"] == "sync_queue_updated" })
	read := a.call("GET", "/api/admin/nodes/node-command-jobs", nil, 200)
	assertNoQueueJob(t, read, text(target.job, "id"))
	assertCommandQueueScopes(a, target, other, false)
	a.call("POST", "/api/admin/nodes/node-command-jobs/"+text(target.job, "id")+"/dismiss", Object{}, 404)
}

func TestCommandQueueRefreshFailureReturnsJSONNull(t *testing.T) {
	a := newTestAPI(t)
	mux := http.NewServeMux()
	// Isolate the post-commit refresh branch: a cancelled read must still
	// serialize JSON null through the real route writer, never an empty body.
	a.server.handle(mux, "GET /queue-after-commit", "admin", func(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
		ctx, cancel := context.WithCancel(r.Context())
		cancel()
		return a.server.commandQueueAfterMutation(r.WithContext(ctx), "test-refresh")
	})
	httpServer := httptest.NewServer(mux)
	t.Cleanup(httpServer.Close)
	reader := &testAPI{t: t, http: httpServer, token: a.token}
	if raw := string(reader.request("GET", "/queue-after-commit", nil, 200)); raw != "null\n" {
		t.Fatalf("写入成功但刷新失败必须返回 JSON null，实际=%q", raw)
	}
}
