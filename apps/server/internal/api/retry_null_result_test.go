package api

import (
	"context"
	"testing"
)

func TestRetryCancelledCommandWithoutAcknowledgementResult(t *testing.T) {
	a := newTestAPI(t)
	fixture := a.cancelledCommand()
	// A genuinely unacknowledged command has SQL NULL, not a completed result {}.
	// This mutation is confined to newTestAPI's random private schema.
	if _, err := a.server.DB.Exec(context.Background(), `UPDATE "NodeCommandJob" SET result=NULL WHERE id=$1`, fixture.job["id"]); err != nil {
		t.Fatal(err)
	}
	queue := a.call("POST", "/api/admin/nodes/node-command-jobs/"+text(fixture.job, "id")+"/retry", Object{}, 200)
	assertNoQueueJob(t, queue, text(fixture.job, "id"))
	jobs := queueJobs(t, queue)
	if len(jobs) != 1 || jobs[0]["status"] != "pending" || jobs[0]["commandType"] != "ENSURE_USER" {
		t.Fatal("未确认的失败任务应生成真实待处理替代命令", jobs)
	}
}
