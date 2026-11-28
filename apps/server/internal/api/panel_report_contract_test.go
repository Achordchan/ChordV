package api

import (
	"context"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestPanelReportContractOriginalDTOAndStrictReportHTTP(t *testing.T) {
	f := newPanelReportFixture(t)
	accepted, rejected := 0, 0
	for i, sample := range panelReportReference(t).Samples {
		f.reset(t, nil, nil)
		input := panelReportLocal(t, sample.Input)
		if sample.Status != 200 {
			before, sequence := policySchemaDigest(t, f.a), panelEventSequence(f.a)
			status, response := f.request(t, input)
			if status != sample.Status {
				t.Errorf("sample[%d]=%.90s status=%d want=%d message=%v", i, sample.Name, status, sample.Status, response["message"])
			}
			if !reflect.DeepEqual(before, policySchemaDigest(t, f.a)) {
				t.Errorf("sample[%d]=%.90s 拒绝路径改动48表", i, sample.Name)
			}
			// A red implementation can accept a bad sample. Drain its success
			// separately so one defect does not contaminate subsequent cases.
			if status == 200 {
				f.drainSuccess(t)
			} else {
				panelAssertNoEvents(t, f.a, f.events, sequence)
			}
			rejected++
		} else {
			status, response := f.request(t, input)
			if status != 200 {
				t.Errorf("旧合法样本[%d]=%.90s status=%d message=%v", i, sample.Name, status, response["message"])
			}
			f.drainSuccess(t)
			accepted++
		}
	}
	t.Logf("真实Agent HTTP旧DTO/helper全部样本: accepted=%d rejected=%d；拒绝逐次48表摘要/事件序列/真实SSE屏障", accepted, rejected)
}

func TestPanelReportContractLifecycleTransactionHTTP(t *testing.T) {
	f := newPanelReportFixture(t)
	for _, test := range []struct {
		name      string
		node, job Object
		status    int
		active    bool
		revision  float64
	}{
		{"first-activation", nil, nil, 200, true, 1},
		{"already-active", Object{"isActive": true, "inboundAppliedRevision": 1}, Object{"targetRevision": 2}, 400, true, 1},
		{"stale-revision", Object{"inboundAppliedRevision": 5}, Object{"targetRevision": 3}, 400, false, 5},
		{"equal-revision", Object{"inboundAppliedRevision": 3}, Object{"targetRevision": 3}, 400, false, 3},
		{"pending-register", Object{"registrationStatus": "pending_register"}, nil, 200, false, 1},
		{"no-auto-activate", Object{"onboardingSpec": Object{"activateOnFirstValidation": false}}, nil, 200, false, 1},
		{"manual-inactive-later", Object{"inboundAppliedRevision": 2}, Object{"targetRevision": 3}, 200, false, 3},
		{"failed-can-complete", nil, Object{"status": "failed", "lastError": "previous failure"}, 200, true, 1},
		{"running-can-complete", nil, Object{"status": "running", "attempts": 2}, 200, true, 1},
		{"cancelled", nil, Object{"status": "cancelled"}, 409, false, 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			f.reset(t, test.node, test.job)
			if test.status != 200 {
				f.unchanged(t, f.input, test.status)
				return
			}
			before := policySchemaDigest(t, f.a)
			status, response := f.request(t, f.input)
			if status != 200 {
				t.Fatalf("回执status=%d message=%v", status, response["message"])
			}
			node, job := f.rows(t)
			if node["isActive"] != test.active || node["inboundAppliedRevision"] != test.revision || node["serverHost"] != "127.0.0.1" {
				t.Errorf("入站生命周期错误: active=%v revision=%v host=%v", node["isActive"], node["inboundAppliedRevision"], node["serverHost"])
			}
			payload := job["payload"].(map[string]any)
			if payload["inboundTag"] != "actual-runtime" || payload["tagOverrideConfirmed"] != true || job["dedupeKey"] != text(f.job, "dedupeKey")+":done:"+f.jobID || job["status"] != "completed" || job["lastError"] != nil || job["completedAt"] == nil {
				t.Errorf("完成回执没有原子冻结实际tag/释放dedupe/完成job: payload=%v status=%v dedupe=%v", payload, job["status"], job["dedupeKey"])
			}
			after := policySchemaDigest(t, f.a)
			for table, digest := range before {
				if table != "Node" && table != "NodeCommandJob" && !reflect.DeepEqual(digest, after[table]) {
					t.Errorf("成功回执改动无关表: %s", table)
				}
			}
			f.drainSuccess(t)
		})
	}
}

func TestPanelReportContractCompletedACKReplayNoWritesHTTP(t *testing.T) {
	f := newPanelReportFixture(t)
	status, _ := f.request(t, f.input)
	if status != 200 {
		t.Fatal("初次合法回执失败", status)
	}
	f.drainSuccess(t)
	for _, test := range []struct {
		name   string
		input  Object
		status int
	}{
		{"same-cached-result", f.input, 200},
		{"conflicting-report", Object{"status": "completed", "result": Object{"inbound": Object{"serverPort": 444, "inboundTag": "different"}}}, 200},
		{"late-failed-result", Object{"status": "failed", "error": "late report", "result": Object{}}, 200},
		{"malformed-result", Object{"status": "completed", "result": "not-an-object"}, 400},
		{"malformed-error", Object{"status": "completed", "result": Object{}, "error": true}, 400},
		{"malformed-status", Object{"status": " completed ", "result": Object{}}, 400},
	} {
		t.Run(test.name, func(t *testing.T) { f.unchanged(t, test.input, test.status) })
	}
	t.Log("明确保留Go Agent ACK重放协议：旧completed→404，新completed+合法DTO→200且不覆盖原结果、不改48表、不发SSE")
}

func TestPanelReportContractFailedErrorPreservationAndRetryHTTP(t *testing.T) {
	f := newPanelReportFixture(t)
	for _, test := range []struct {
		name   string
		error  any
		omit   bool
		want   string
		status int
	}{
		{"missing", nil, true, "Agent 执行失败", 200}, {"null", nil, false, "Agent 执行失败", 200},
		{"empty", "", false, "", 200}, {"whitespace", "  raw error  ", false, "  raw error  ", 200},
		{"unicode-4000", strings.Repeat("中", 4000), false, strings.Repeat("中", 4000), 200},
		{"astral-4000", strings.Repeat("\U00020000", 4000), false, strings.Repeat("\U00020000", 4000), 200},
		{"selector-4000", strings.Repeat("x\ufe0f", 4000), false, strings.Repeat("x\ufe0f", 4000), 200},
		{"unicode-4001", strings.Repeat("中", 4001), false, "", 400},
		{"astral-4001", strings.Repeat("\U00020000", 4001), false, "", 400},
	} {
		t.Run(test.name, func(t *testing.T) {
			f.reset(t, nil, Object{"attempts": 3})
			input := Object{"status": "failed", "result": nil}
			if !test.omit {
				input["error"] = test.error
			}
			if test.status != 200 {
				f.unchanged(t, input, test.status)
				return
			}
			before, started := policySchemaDigest(t, f.a), time.Now()
			status, _ := f.request(t, input)
			if status != 200 {
				t.Fatal("合法失败回执被拒", status)
			}
			_, job := f.rows(t)
			if job["lastError"] != test.want || job["completedAt"] != nil || job["status"] != "failed" || job["dedupeKey"] != f.job["dedupeKey"] || !reflect.DeepEqual(job["payload"], f.job["payload"]) {
				t.Errorf("失败回执错误文本/状态/保留命令错误: lastError长度=%d", len(text(job, "lastError")))
			}
			next, err := parseTimestamp(text(job, "nextRunAt"))
			// TIMESTAMP(3) 会舍入到毫秒，读回值的时间边界也必须使用同一精度。
			finished := time.Now()
			earliest := started.UTC().Round(time.Millisecond).Add(120 * time.Second)
			latest := finished.UTC().Round(time.Millisecond).Add(120 * time.Second)
			if err != nil || next.Before(earliest) || next.After(latest) {
				t.Errorf("不得改变既有指数退避：attempts3应为120s next=%s earliest=%s latest=%s err=%v", next.Format(time.RFC3339Nano), earliest.Format(time.RFC3339Nano), latest.Format(time.RFC3339Nano), err)
			}
			after := policySchemaDigest(t, f.a)
			for table, digest := range before {
				if table != "NodeCommandJob" && !reflect.DeepEqual(digest, after[table]) {
					t.Errorf("失败回执改动无关表: %s", table)
				}
			}
			f.drainSuccess(t)
		})
	}
}

func TestPanelReportContractRollbackIfDedupeCompletionConflictsHTTP(t *testing.T) {
	f := newPanelReportFixture(t)
	_, err := f.a.server.DB.Exec(context.Background(), `INSERT INTO "NodeCommandJob"(id,"dedupeKey","nodeId","agentId","commandType","targetRevision",payload,"updatedAt") VALUES($1,$2,$3,$4,'RECONCILE_USERS',99,'{}',now())`, newID(), text(f.job, "dedupeKey")+":done:"+f.jobID, f.nodeID, f.job["agentId"])
	if err != nil {
		t.Fatal(err)
	}
	f.unchanged(t, f.input, 409)
	t.Log("真实PostgreSQL dedupe唯一约束在完成job时失败，Node字段/激活/revision与全48表完全回滚，SSE为0")
}
