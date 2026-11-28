package api

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

type liveEvent struct {
	id   string
	data Object
}

func (a *testAPI) eventStream(path, lastID string) (<-chan liveEvent, context.CancelFunc) {
	a.t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	request, _ := http.NewRequestWithContext(ctx, "GET", a.http.URL+path, nil)
	request.Header.Set("Authorization", "Bearer "+a.token)
	if lastID != "" {
		request.Header.Set("Last-Event-ID", lastID)
	}
	response, err := a.http.Client().Do(request)
	if err != nil {
		cancel()
		a.t.Fatal(err)
	}
	if response.StatusCode != 200 {
		response.Body.Close()
		cancel()
		a.t.Fatalf("SSE HTTP %d", response.StatusCode)
	}
	out := make(chan liveEvent, 128)
	go func() {
		defer close(out)
		defer response.Body.Close()
		scanner := bufio.NewScanner(response.Body)
		id := ""
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, "id: ") {
				id = strings.TrimPrefix(line, "id: ")
			}
			if strings.HasPrefix(line, "data: ") {
				var event Object
				if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event) == nil {
					select {
					case out <- liveEvent{id: id, data: event}:
					case <-ctx.Done():
						return
					}
				}
			}
			if line == "" {
				id = ""
			}
		}
	}()
	a.t.Cleanup(cancel)
	return out, cancel
}
func waitLiveEvent(t *testing.T, ch <-chan liveEvent, predicate func(liveEvent) bool) liveEvent {
	t.Helper()
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	for {
		select {
		case event, ok := <-ch:
			if !ok {
				t.Fatal("SSE提早关闭")
			}
			if predicate(event) {
				return event
			}
		case <-timer.C:
			t.Fatal("等待SSE事件超时")
		}
	}
}
func TestSSELiveRefreshAndLastEventReplay(t *testing.T) {
	a := newTestAPI(t)
	stream, cancel := a.eventStream("/api/admin/events/stream", "")
	waitLiveEvent(t, stream, func(e liveEvent) bool { return e.data["type"] == "presence_updated" })
	a.createUser()
	userEvent := waitLiveEvent(t, stream, func(e liveEvent) bool { return e.id != "" && e.data["type"] == "account_updated" })
	if !strings.Contains(userEvent.id, ":") {
		t.Fatal("SSE没有可重放事件ID")
	}
	a.call("POST", "/api/admin/nodes/agent-native", Object{"name": "SSE节点"}, 200)
	nodeEvent := waitLiveEvent(t, stream, func(e liveEvent) bool { return e.id != "" && e.data["type"] == "node_access_updated" })
	cancel()
	replayed, _ := a.eventStream("/api/admin/events/stream", userEvent.id)
	event := waitLiveEvent(t, replayed, func(e liveEvent) bool { return e.id == nodeEvent.id })
	if event.data["type"] != "node_access_updated" {
		t.Fatal("没有重放断线期间的节点变更")
	}
	nodes := a.array("/api/admin/nodes")
	for _, node := range nodes {
		if node["name"] == "SSE节点" {
			_, _ = a.server.DB.Exec(context.Background(), `DELETE FROM "Node" WHERE id=$1`, node["id"])
		}
	}
}
func TestEventHubSlowConsumerSignalsGapAndPreservesReplay(t *testing.T) {
	hub := newEventHub()
	slow, closeSlow := hub.subscribe("user-a")
	defer closeSlow()
	hub.publish("user-a", Object{"type": "session_revoked", "sessionId": "old-session"})
	first, ok := hub.since("user-a", "")
	if ok || len(first) != 0 {
		t.Fatal("未知游标不应报告完整重放")
	}
	hub.mu.Lock()
	firstID := hub.replay[0].id
	hub.mu.Unlock()
	for i := 0; i < 70; i++ {
		hub.publish("user-a", Object{"type": "subscription_updated"})
	}
	gap := <-slow
	if gap["_resync"] != true {
		t.Fatal("慢消费者溢出未收到明确重放信号")
	}
	events, ok := hub.since("user-a", firstID)
	if !ok || len(events) != 70 {
		t.Fatal("溢出后没有保留可恢复的事件")
	}
	for i := 0; i < 600; i++ {
		hub.publish("user-a", Object{"type": "node_access_updated"})
	}
	if _, ok = hub.since("user-a", firstID); ok {
		t.Fatal("超出重放窗口的游标不应被误认为完整")
	}
	types := map[string]bool{}
	for _, event := range fullSyncEvents(false) {
		types[text(event, "type")] = true
	}
	if !types["account_updated"] || !types["node_access_updated"] || !types["subscription_updated"] {
		t.Fatal("窗口外恢复没有请求权威状态全量同步")
	}
}
func TestEventReplayNeverLeaksOtherUsers(t *testing.T) {
	hub := newEventHub()
	hub.publish("user-a", Object{"type": "account_updated"})
	hub.mu.Lock()
	id := hub.replay[0].id
	hub.mu.Unlock()
	hub.publish("user-b", Object{"type": "session_revoked", "sessionId": "private-session"})
	hub.publish("user-a", Object{"type": "subscription_updated"})
	events, ok := hub.since("user-a", id)
	if !ok || len(events) != 1 || events[0]["sessionId"] != nil {
		t.Fatal("用户重放包含其他用户的私有事件")
	}
}

func TestPresenceExpiryPushesAuthoritativeRefresh(t *testing.T) {
	a := newTestAPI(t)
	stream, _ := a.eventStream("/api/admin/events/stream", "")
	waitLiveEvent(t, stream, func(e liveEvent) bool { return e.data["type"] == "presence_updated" })
	if err := a.server.notePresence(context.Background(), a.adminID, true); err != nil {
		t.Fatal(err)
	}
	waitLiveEvent(t, stream, func(e liveEvent) bool { return e.id != "" && e.data["type"] == "presence_updated" })
	if _, err := a.server.DB.Exec(context.Background(), `UPDATE "UserClientPresence" SET "lastSeenAt"=now()-interval '151 seconds' WHERE "userId"=$1`, a.adminID); err != nil {
		t.Fatal(err)
	}
	a.server.schedulePresenceExpiry(a.adminID, 10*time.Millisecond)
	waitLiveEvent(t, stream, func(e liveEvent) bool { return e.id != "" && e.data["type"] == "presence_updated" })
	snapshot := a.call("GET", "/api/admin/presence", nil, 200)
	for _, raw := range snapshot["users"].([]any) {
		user := raw.(map[string]any)
		if user["userId"] == a.adminID && user["state"] != "offline" {
			t.Fatal("过期推送后权威在线状态没有离线")
		}
	}
}

func TestAdminDisconnectPushesCriticalRevocationAndDisablesBinding(t *testing.T) {
	a := newTestAPI(t)
	node, _ := a.createNode()
	user := a.createUser()
	plan := a.createPlan("personal")
	sub := a.call("POST", "/api/admin/subscriptions", Object{"userId": user["id"], "planId": plan["id"], "expireAt": time.Now().AddDate(0, 1, 0).UTC().Format(time.RFC3339)}, 200)
	binding, err := insert(context.Background(), a.server.DB, "PanelClientBinding", Object{"subscriptionId": sub["id"], "userId": user["id"], "nodeId": node["id"], "panelClientEmail": "revoke-" + newID(), "panelClientId": newID(), "panelInboundId": 0, "source": "direct", "status": "active"})
	if err != nil {
		t.Fatal(err)
	}
	lease, err := insert(context.Background(), a.server.DB, "NodeSessionLease", Object{"sessionId": "session_" + newID(), "subscriptionId": sub["id"], "userId": user["id"], "nodeId": node["id"], "xrayUserEmail": binding["panelClientEmail"], "xrayUserUuid": binding["panelClientId"], "status": "active", "issuedAt": now(), "expiresAt": time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano), "lastHeartbeatAt": now(), "connectionMode": "rule"})
	if err != nil {
		t.Fatal(err)
	}
	adminToken := a.token
	a.token = ""
	session := a.call("POST", "/api/auth/login", Object{"email": user["email"], "password": "  exact-password  "}, 200)
	a.token = text(session, "accessToken")
	events, _ := a.eventStream("/api/client/events/stream", "")
	waitLiveEvent(t, events, func(e liveEvent) bool { return e.data["type"] == "ticket_updated" })
	a.token = adminToken
	a.call("POST", "/api/admin/users/"+text(user, "id")+"/disconnect", nil, 200)
	critical := waitLiveEvent(t, events, func(e liveEvent) bool { return e.data["type"] == "session_revoked" })
	if critical.id == "" || critical.data["sessionId"] != lease["sessionId"] || critical.data["reasonCode"] != "admin_paused_connection" {
		t.Fatal("关键撤销推送字段不符合旧客户端契约")
	}
	var status string
	if err = a.server.DB.QueryRow(context.Background(), `SELECT status FROM "PanelClientBinding" WHERE id=$1`, binding["id"]).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "disabled" {
		t.Fatal("撤销会话未持久停用节点账号")
	}
}

func TestSSEUnknownCursorRefreshesOnceBeforeLiveEvents(t *testing.T) {
	a := newTestAPI(t)
	stream, _ := a.eventStream("/api/admin/events/stream", "previous-instance:10")
	counts := map[string]int{}
	gap := 0
	waitLiveEvent(t, stream, func(e liveEvent) bool {
		counts[text(e.data, "type")]++
		if e.data["reason"] == "replay_gap" {
			gap++
		}
		return e.data["type"] == "presence_updated"
	})
	a.server.events.publish("", Object{"type": "announcement_updated", "announcementId": "live-after-gap"})
	waitLiveEvent(t, stream, func(e liveEvent) bool {
		if e.data["announcementId"] == "live-after-gap" {
			return true
		}
		counts[text(e.data, "type")]++
		if e.data["reason"] == "replay_gap" {
			gap++
		}
		return false
	})
	if counts["resync"] != 1 || gap != 1 {
		t.Fatalf("expected one replay-gap refresh before live delivery: %v", counts)
	}
	for _, e := range fullSyncEvents(true) {
		if k := text(e, "type"); counts[k] != 1 {
			t.Fatalf("expected one %s before live delivery: %v", k, counts)
		}
	}
}
