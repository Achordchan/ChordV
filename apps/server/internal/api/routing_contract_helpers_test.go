package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

type routingContractFixture struct {
	a          *testAPI
	owner      Object
	other      Object
	rule       Object
	ownerToken string
	otherToken string
	streams    []routingContractStream
}

type routingContractStream struct {
	target string
	events <-chan liveEvent
}

func newRoutingContractFixture(t *testing.T) *routingContractFixture {
	t.Helper()
	a := newTestAPI(t)
	owner, other := a.createUser(), a.createUser()
	admin := a.token
	ownerToken, otherToken := a.loginUser(owner), a.loginUser(other)
	a.token = ownerToken
	rule := a.call("POST", "/api/client/routing-rules", Object{"name": "原规则", "value": "original.example", "action": "proxy"}, 200)
	f := &routingContractFixture{a: a, owner: owner, other: other, rule: rule, ownerToken: ownerToken, otherToken: otherToken}
	for _, entry := range []struct{ token, target string }{{ownerToken, text(owner, "id")}, {otherToken, text(other, "id")}} {
		a.token = entry.token
		stream, _ := a.eventStream("/api/client/events/stream?presence=ping", "")
		waitLiveEvent(t, stream, func(event liveEvent) bool { return event.data["type"] == "ticket_updated" })
		f.streams = append(f.streams, routingContractStream{entry.target, stream})
	}
	a.token = admin
	stream, _ := a.eventStream("/api/admin/events/stream", "")
	waitLiveEvent(t, stream, func(event liveEvent) bool { return event.data["type"] == "presence_updated" })
	// Consume the actual setup-only presence debounce, distinguished from the
	// initial full-sync event by its entry in replay. No timer is changed.
	waitLiveEvent(t, stream, func(event liveEvent) bool {
		if event.data["type"] != "presence_updated" {
			return false
		}
		a.server.events.mu.Lock()
		defer a.server.events.mu.Unlock()
		for _, record := range a.server.events.replay {
			if record.id == event.id && record.target == "admin" && record.data["type"] == "presence_updated" {
				return true
			}
		}
		return false
	})
	f.streams = append(f.streams, routingContractStream{"admin", stream})
	a.token = ownerToken
	return f
}

func routingContractRequest(t *testing.T, a *testAPI, method, path string, input Object) (int, Object) {
	t.Helper()
	raw, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(method, a.http.URL+path, bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	if a.token != "" {
		request.Header.Set("Authorization", "Bearer "+a.token)
	}
	response, err := a.http.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var result Object
	if err = json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal("规则响应不是JSON对象", err)
	}
	return response.StatusCode, result
}

func (f *routingContractFixture) sequence() uint64 {
	f.a.server.events.mu.Lock()
	defer f.a.server.events.mu.Unlock()
	return f.a.server.events.sequence
}

func (f *routingContractFixture) observe(t *testing.T, before uint64, policy bool) {
	t.Helper()
	f.a.server.events.mu.Lock()
	after := f.a.server.events.sequence
	records := []Object{}
	for _, event := range f.a.server.events.replay {
		sequence, err := strconv.ParseUint(event.id[strings.LastIndexByte(event.id, ':')+1:], 10, 64)
		if err != nil {
			f.a.server.events.mu.Unlock()
			t.Fatal(err)
		}
		if sequence > before && sequence <= after {
			records = append(records, Object{"id": event.id, "scope": event.target, "event": event.data})
		}
	}
	f.a.server.events.mu.Unlock()
	want := uint64(0)
	if policy {
		want = 1
	}
	if after-before != want {
		t.Errorf("规则请求事件数错误: sequence=%d→%d want=%d replay=%v", before, after, want, records)
	}
	if uint64(len(records)) != after-before {
		t.Fatal("规则请求全作用域replay不完整", before, after, records)
	}
	if policy && len(records) == 1 {
		record := records[0]
		if record["scope"] != text(f.owner, "id") || record["event"].(Object)["type"] != "policy_updated" {
			t.Errorf("规则事件作用域错误: %v", record)
		}
	}
	for _, stream := range f.streams {
		marker, events := newID(), []Object{}
		f.a.server.events.publish(stream.target, Object{"type": "test_routing_contract_barrier", "marker": marker})
		waitLiveEvent(t, stream.events, func(event liveEvent) bool {
			if event.data["type"] == "test_routing_contract_barrier" {
				return event.data["marker"] == marker
			}
			events = append(events, event.data)
			return false
		})
		wanted := []Object{}
		if policy && stream.target != text(f.other, "id") {
			if len(events) != 1 || events[0]["type"] != "policy_updated" {
				t.Errorf("仅本人及管理员应收到一次policy_updated: target=%s events=%v", stream.target, events)
			}
		} else if !reflect.DeepEqual(wanted, events) {
			t.Errorf("被拒请求或其他用户不应收到事件: target=%s events=%v", stream.target, events)
		}
	}
}
