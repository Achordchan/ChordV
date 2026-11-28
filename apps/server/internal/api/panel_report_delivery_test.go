package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
)

func panelReportQueueBarrier(t *testing.T, f *panelReportFixture, want int) {
	t.Helper()
	marker, count := newID(), 0
	f.a.server.events.publish("admin", Object{"type": "test_report_queue_barrier", "marker": marker})
	waitLiveEvent(t, f.events, func(event liveEvent) bool {
		if event.data["type"] == "test_report_queue_barrier" && event.data["marker"] == marker {
			return true
		}
		if event.data["type"] != "node_access_updated" {
			t.Errorf("取消投递出现无关事件:%v", event.data)
		} else {
			count++
		}
		return false
	})
	if count != want {
		t.Errorf("队列取消事件=%d want=%d", count, want)
	}
}

func TestPanelReportContractInvalidPanelCannotBlockFollowingCommandSSE(t *testing.T) {
	for _, active := range []bool{false, true} {
		t.Run(map[bool]string{false: "stale", true: "active"}[active], func(t *testing.T) {
			f := newPanelReportFixture(t)
			f.reset(t, Object{"inboundAppliedRevision": 3, "agentConfigRevision": 3, "isActive": active}, nil)
			following, err := insert(context.Background(), f.a.server.DB, "NodeCommandJob", Object{"nodeId": f.nodeID, "agentId": f.job["agentId"], "commandType": "RECONCILE_USERS", "targetRevision": 4, "dedupeKey": "following-" + newID(), "payload": Object{"users": []any{}}})
			if err != nil {
				t.Fatal(err)
			}
			stream, cancel := f.a.eventStream("/api/agent/v1/events", "")
			first := waitLiveEvent(t, stream, func(event liveEvent) bool { return event.data["commandId"] != nil })
			cancel()
			if first.data["commandId"] != following["id"] {
				t.Errorf("失效panel任务挤占后续合法命令，首条=%v stale=%s valid=%v", first.data["commandId"], f.jobID, following["id"])
			}
			valid, err := one(context.Background(), f.a.server.DB, `SELECT to_jsonb(j) FROM "NodeCommandJob" j WHERE id=$1`, following["id"])
			if err != nil || valid["status"] != "running" || valid["attempts"] != float64(1) {
				t.Fatal("后续合法命令未正常claim", valid, err)
			}
			_, cancelled := f.rows(t)
			if cancelled["status"] != "cancelled" || !strings.Contains(text(cancelled, "lastError"), "已激活或入站修订已过期") || cancelled["dedupeKey"] != text(f.job, "dedupeKey")+":cancelled:"+f.jobID || !reflect.DeepEqual(cancelled["payload"], f.job["payload"]) || cancelled["attempts"] != float64(0) {
				t.Errorf("失效panel未保留审计并释放去重key: status=%v attempts=%v error=%v", cancelled["status"], cancelled["attempts"], cancelled["lastError"])
			}
			panelReportQueueBarrier(t, f, 1)
			before, sequence := policySchemaDigest(t, f.a), panelEventSequence(f.a)
			if jobs, err := f.a.server.claimAgentCommands(context.Background(), text(f.job, "agentId")); err != nil || len(jobs) != 0 {
				t.Fatal("重复claim不应重投取消任务", jobs, err)
			}
			if !reflect.DeepEqual(before, policySchemaDigest(t, f.a)) {
				t.Error("重复claim改动已取消审计记录")
			}
			panelAssertNoEvents(t, f.a, f.events, sequence)
			f.a.token = f.adminToken
			if active {
				before, sequence = policySchemaDigest(t, f.a), panelEventSequence(f.a)
				status, _ := routingContractRequest(t, f.a, "POST", "/api/admin/nodes/"+f.nodeID+"/agent-commands", Object{"type": "ENSURE_INBOUND", "payload": f.job["payload"], "dedupeKey": f.job["dedupeKey"], "expectedInboundAppliedRevision": "3"})
				if status != 400 || !reflect.DeepEqual(before, policySchemaDigest(t, f.a)) {
					t.Error("active节点排队应400且不耗revision/不写job", status)
				}
				panelAssertNoEvents(t, f.a, f.events, sequence)
				if _, err = f.a.server.DB.Exec(context.Background(), `UPDATE "Node" SET "isActive"=false WHERE id=$1`, f.nodeID); err != nil {
					t.Fatal(err)
				}
			}
			ready, closeReady := f.a.server.events.subscribe("agent:" + f.nodeID)
			defer closeReady()
			next := f.a.call("POST", "/api/admin/nodes/"+f.nodeID+"/agent-commands", Object{"type": "ENSURE_INBOUND", "payload": f.job["payload"], "dedupeKey": f.job["dedupeKey"], "expectedInboundAppliedRevision": "3"}, 200)
			if next["commandId"] == f.jobID || next["targetRevision"] != "4" {
				t.Error("取消释放后原key未创建新的合法部署", next)
			}
			waitNodePatchCommandNotification(t, ready)
			waitNodePatchCommandNotification(t, ready)
			f.drainSuccess(t)
			f.a.token = f.agentToken
			stream, cancel = f.a.eventStream("/api/agent/v1/events", "")
			delivered := waitLiveEvent(t, stream, func(event liveEvent) bool { return event.data["commandId"] == next["commandId"] })
			cancel()
			if delivered.data["type"] != "ENSURE_INBOUND" {
				t.Fatal("合法新panel命令未投递", delivered.data)
			}
			t.Logf("真实SSE首条=%v；取消失效panel保留审计，原key重新下发targetRevision=4；active=%v", first.data["commandId"], active)
		})
	}
}

func TestPanelReportContractClaimCancelsOnlyInvalidPanelStates(t *testing.T) {
	f := newPanelReportFixture(t)
	for _, status := range []string{"pending", "running", "failed"} {
		f.reset(t, Object{"inboundAppliedRevision": 1}, Object{"status": status, "nextRunAt": "2030-01-01T00:00:00Z"})
		if jobs, err := f.a.server.claimAgentCommands(context.Background(), text(f.job, "agentId")); err != nil || len(jobs) != 0 {
			t.Fatal("equal panel应取消而不是交付", status, jobs, err)
		}
		_, job := f.rows(t)
		if job["status"] != "cancelled" {
			t.Error("未取消失效状态", status)
		}
		panelReportQueueBarrier(t, f, 1)
	}
	for _, status := range []string{"completed", "cancelled"} {
		f.reset(t, Object{"isActive": true}, Object{"status": status})
		before, sequence := policySchemaDigest(t, f.a), panelEventSequence(f.a)
		if jobs, err := f.a.server.claimAgentCommands(context.Background(), text(f.job, "agentId")); err != nil || len(jobs) != 0 {
			t.Fatal("终态不应再交付", status, jobs, err)
		}
		if !reflect.DeepEqual(before, policySchemaDigest(t, f.a)) {
			t.Error("不应改已有终态", status)
		}
		panelAssertNoEvents(t, f.a, f.events, sequence)
	}
}

func TestPanelReportContractClaimNodeReadDoesNotReverseLockOrder(t *testing.T) {
	f := newPanelReportFixture(t)
	f.reset(t, Object{"inboundAppliedRevision": 3}, nil)
	tx, err := f.a.server.DB.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(context.Background(), `SELECT id FROM "Node" WHERE id=$1 FOR UPDATE`, f.nodeID); err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() {
		_, err := f.a.server.claimAgentCommands(context.Background(), text(f.job, "agentId"))
		finished <- err
	}()
	select {
	case err := <-finished:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		tx.Rollback(context.Background())
		err = <-finished
		t.Fatal("claim在job锁后等待Node锁，存在与回执反序死锁", err)
	}
	if err = tx.Rollback(context.Background()); err != nil {
		t.Fatal(err)
	}
	panelReportQueueBarrier(t, f, 1)
	f.unchanged(t, f.input, 409)
}

func TestPanelReportContractConcurrentClaimAndReportDoNotDeadlock(t *testing.T) {
	f := newPanelReportFixture(t)
	raw, err := json.Marshal(f.input)
	if err != nil {
		t.Fatal(err)
	}
	for _, stale := range []bool{false, true} {
		for iteration := 0; iteration < 16; iteration++ {
			changes := Object{}
			if stale {
				changes["inboundAppliedRevision"] = 3
			}
			f.reset(t, changes, nil)
			before := policySchemaDigest(t, f.a)
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			start, claims, reports := make(chan struct{}), make(chan error, 1), make(chan int, 1)
			go func() { <-start; _, err := f.a.server.claimAgentCommands(ctx, text(f.job, "agentId")); claims <- err }()
			go func() {
				<-start
				request, err := http.NewRequestWithContext(ctx, "POST", f.a.http.URL+"/api/agent/v1/commands/"+f.jobID+"/result", bytes.NewReader(raw))
				if err != nil {
					reports <- 0
					return
				}
				request.Header.Set("Content-Type", "application/json")
				request.Header.Set("Authorization", "Bearer "+f.agentToken)
				response, err := f.a.http.Client().Do(request)
				if err != nil {
					reports <- 0
					return
				}
				io.Copy(io.Discard, response.Body)
				response.Body.Close()
				reports <- response.StatusCode
			}()
			close(start)
			claimErr, reportStatus := <-claims, <-reports
			cancel()
			if claimErr != nil || reportStatus == 0 {
				t.Fatalf("并发claim/真实HTTP回执失败或死锁: stale=%v iteration=%d status=%d err=%v", stale, iteration, reportStatus, claimErr)
			}
			node, job := f.rows(t)
			if stale {
				if reportStatus != 400 && reportStatus != 409 || job["status"] != "cancelled" || node["inboundAppliedRevision"] != float64(3) || node["isActive"] != false {
					t.Fatal("并发过时回执被应用或取消丢失", reportStatus, job["status"])
				}
				after := policySchemaDigest(t, f.a)
				for table, digest := range before {
					if table != "NodeCommandJob" && !reflect.DeepEqual(digest, after[table]) {
						t.Errorf("取消/拒绝并发写入无关表:%s", table)
					}
				}
				panelReportQueueBarrier(t, f, 1)
			} else {
				if reportStatus != 200 || job["status"] != "completed" || node["isActive"] != true {
					t.Fatal("有效回执被并发claim误取消", reportStatus, job["status"])
				}
				f.drainSuccess(t)
				f.unchanged(t, f.input, 200)
			}
		}
	}
	t.Log("32组并发claim/真实HTTP回执终态；16合法完成后cached ACK重放200零写，16stale最终取消且Node/其余47表未写")
}
