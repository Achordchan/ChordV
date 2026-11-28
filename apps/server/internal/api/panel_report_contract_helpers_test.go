package api

import (
	"context"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

type panelReportLegacy struct {
	Commit     string              `json:"commit"`
	Spec       Object              `json:"spec"`
	BaseReport Object              `json:"baseReport"`
	Samples    []panelLegacySample `json:"helperSamples"`
}

func panelReportReference(t *testing.T) panelReportLegacy {
	t.Helper()
	raw, err := os.ReadFile("testdata/panel-report-legacy.json")
	if err != nil {
		t.Fatal(err)
	}
	var reference panelReportLegacy
	if err = json.Unmarshal(raw, &reference); err != nil || reference.Commit != "397a64d" || len(reference.Samples) != 157 {
		t.Fatal("旧回执实证testdata无效", err)
	}
	return reference
}

func panelReportLocal(t *testing.T, input Object) Object {
	t.Helper()
	value := panelCanonical(t, input)
	if result, ok := value["result"].(map[string]any); ok {
		if report, ok := result["inbound"].(map[string]any); ok {
			if host, ok := report["serverHost"].(string); ok {
				report["serverHost"] = strings.ReplaceAll(host, "node.example.com", "127.0.0.1")
			}
		}
	}
	return value
}

type panelReportFixture struct {
	a                                     *testAPI
	nodeID, jobID, agentToken, adminToken string
	node, job, input                      Object
	events                                <-chan liveEvent
}

func newPanelReportFixture(t *testing.T) *panelReportFixture {
	t.Helper()
	a := newTestAPI(t)
	node, agentToken := a.createNode()
	ref := panelReportReference(t)
	spec := panelCanonical(t, ref.Spec)
	spec["serverHost"] = "127.0.0.1"
	ready, unsubscribe := a.server.events.subscribe("agent:" + text(node, "id"))
	defer unsubscribe()
	job := a.call("POST", "/api/admin/nodes/"+text(node, "id")+"/agent-commands", Object{"type": "ENSURE_INBOUND", "payload": spec, "dedupeKey": "panel-report-" + newID(), "expectedInboundAppliedRevision": "0"}, 200)
	// Consume both the synchronous publish and committed PG NOTIFY before any
	// negative snapshot, rather than allowing a late queue event to contaminate it.
	waitNodePatchCommandNotification(t, ready)
	waitNodePatchCommandNotification(t, ready)
	f := &panelReportFixture{a: a, nodeID: text(node, "id"), jobID: text(job, "commandId"), agentToken: agentToken, adminToken: a.token, input: panelReportLocal(t, Object{"status": "completed", "result": Object{"inbound": ref.BaseReport}})}
	f.node, f.job = f.rows(t)
	f.events, _ = a.eventStream("/api/admin/events/stream", "")
	waitLiveEvent(t, f.events, func(event liveEvent) bool { return event.data["type"] == "presence_updated" })
	a.token = agentToken
	return f
}

func (f *panelReportFixture) rows(t *testing.T) (Object, Object) {
	t.Helper()
	node, err := one(context.Background(), f.a.server.DB, `SELECT to_jsonb(n) FROM "Node" n WHERE id=$1`, f.nodeID)
	if err != nil {
		t.Fatal(err)
	}
	job, err := one(context.Background(), f.a.server.DB, `SELECT to_jsonb(j) FROM "NodeCommandJob" j WHERE id=$1`, f.jobID)
	if err != nil {
		t.Fatal(err)
	}
	return node, job
}

func (f *panelReportFixture) reset(t *testing.T, nodeChanges, jobChanges Object) {
	t.Helper()
	for _, item := range []struct {
		table, id         string
		baseline, changes Object
	}{{"Node", f.nodeID, f.node, nodeChanges}, {"NodeCommandJob", f.jobID, f.job, jobChanges}} {
		value := panelCanonical(t, item.baseline)
		for key, field := range item.changes {
			value[key] = field
		}
		fields := []string{}
		for key := range value {
			if key != "id" && key != "createdAt" {
				fields = append(fields, key)
			}
		}
		if _, err := update(context.Background(), f.a.server.DB, item.table, item.id, value, fields...); err != nil {
			t.Fatal(err)
		}
	}
	f.a.token = f.agentToken
}

func (f *panelReportFixture) request(t *testing.T, input Object) (int, Object) {
	t.Helper()
	return routingContractRequest(t, f.a, "POST", "/api/agent/v1/commands/"+f.jobID+"/result", input)
}

func (f *panelReportFixture) unchanged(t *testing.T, input Object, want int) {
	t.Helper()
	before, sequence := policySchemaDigest(t, f.a), panelEventSequence(f.a)
	status, response := f.request(t, input)
	if status != want {
		t.Errorf("回执状态=%d want=%d message=%v", status, want, response["message"])
	}
	if !reflect.DeepEqual(before, policySchemaDigest(t, f.a)) {
		t.Error("拒绝/重放回执改动了私有schema业务表")
	}
	panelAssertNoEvents(t, f.a, f.events, sequence)
}

func (f *panelReportFixture) drainSuccess(t *testing.T) {
	t.Helper()
	marker := newID()
	f.a.server.events.publish("admin", Object{"type": "test_report_success_barrier", "marker": marker})
	waitLiveEvent(t, f.events, func(event liveEvent) bool {
		if event.data["type"] == "test_report_success_barrier" && event.data["marker"] == marker {
			return true
		}
		if event.data["type"] != "node_access_updated" {
			t.Errorf("回执出现非节点事件: %v", event.data)
		}
		return false
	})
}
