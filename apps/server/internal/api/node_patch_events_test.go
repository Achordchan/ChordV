package api

import (
	"strconv"
	"strings"
	"testing"
)

// The fixture's connect/client-SSE notePresence calls coalesce into at most one
// pending admin presence broadcast. All other events remain forbidden.
type nodePatchPresenceControl struct{ id string }

func (control *nodePatchPresenceControl) accepts(t *testing.T, a *testAPI, id string, data Object) bool {
	t.Helper()
	if data["type"] != "presence_updated" || id == "" {
		return false
	}
	if control.id != "" {
		return control.id == id
	}
	a.server.events.mu.Lock()
	defer a.server.events.mu.Unlock()
	for _, event := range a.server.events.replay {
		if event.id == id && event.target == "admin" && event.data["type"] == "presence_updated" {
			control.id = id
			t.Logf("已核对唯一夹具presence控制通知: id=%s scope=admin source=connect/client-SSE notePresence debounce", id)
			return true
		}
	}
	return false
}

func (control *nodePatchPresenceControl) since(t *testing.T, a *testAPI, before uint64) (uint64, []Object) {
	t.Helper()
	a.server.events.mu.Lock()
	after := a.server.events.sequence
	records := []replayEvent{}
	for _, event := range a.server.events.replay {
		sequence, err := strconv.ParseUint(event.id[strings.LastIndexByte(event.id, ':')+1:], 10, 64)
		if err != nil {
			a.server.events.mu.Unlock()
			t.Fatal("事件序列无效", err)
		}
		if sequence > before && sequence <= after {
			records = append(records, event)
		}
	}
	a.server.events.mu.Unlock()
	if uint64(len(records)) != after-before {
		t.Fatal("请求区间全作用域replay记录不完整", before, after, len(records))
	}
	unwanted := []Object{}
	for _, event := range records {
		if event.target == "admin" && control.accepts(t, a, event.id, event.data) {
			continue
		}
		t.Logf("请求区间未获豁免事件: before=%d after=%d controlID=%q id=%s scope=%s data=%v", before, after, control.id, event.id, event.target, event.data)
		unwanted = append(unwanted, Object{"id": event.id, "scope": event.target, "event": event.data})
	}
	return after, unwanted
}

func assertNodePatchObserverNegativeControls(t *testing.T, a *testAPI, control *nodePatchPresenceControl, admin, client <-chan liveEvent, userID string) {
	t.Helper()
	a.server.events.mu.Lock()
	sequence := a.server.events.sequence
	a.server.events.mu.Unlock()
	for _, field := range []string{"isActive", "recommended"} {
		for _, sample := range []struct{ target, kind string }{{"", "node_access_updated"}, {userID, "session_revoked"}, {"admin", "sync_queue_updated"}, {"agent:negative-control", "command_available"}} {
			a.server.events.publish(sample.target, Object{"type": sample.kind, "contractField": field, "phase": "observer_negative_control"})
		}
	}
	_, rejected := control.since(t, a, sequence)
	if len(rejected) != 8 {
		t.Fatal("presence窄过滤吞掉了撤销/同步负控", rejected)
	}
	for _, stream := range []struct {
		target string
		events <-chan liveEvent
		want   int
	}{{"admin", admin, 6}, {userID, client, 4}} {
		marker, observed := newID(), []Object{}
		a.server.events.publish(stream.target, Object{"type": "test_node_patch_negative_barrier", "marker": marker})
		waitLiveEvent(t, stream.events, func(event liveEvent) bool {
			if strings.HasPrefix(text(event.data, "type"), "test_node_patch_") {
				return event.data["marker"] == marker
			}
			if stream.target == "admin" && control.accepts(t, a, event.id, event.data) {
				return false
			}
			observed = append(observed, event.data)
			return false
		})
		if len(observed) != stream.want {
			t.Fatalf("真实SSE遗漏撤销/同步负控: scope=%s want=%d got=%v", stream.target, stream.want, observed)
		}
	}
	t.Log("isActive/recommended观测负控通过：全作用域replay拒绝8个业务事件，真实admin/client SSE分别收到6/4个；生产请求的零业务事件断言未放宽。")
}
