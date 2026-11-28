package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"testing"
)

func teamKickHTTPStatus(t *testing.T, a *testAPI, path string, input Object) (int, string) {
	t.Helper()
	raw, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest("POST", a.http.URL+path, bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+a.token)
	response, err := a.http.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, string(body)
}

func TestTeamKickRejectsInvalidDisableAccountWithoutWritesOrSSEHTTP(t *testing.T) {
	a, team, member, sub := teamKickFixture(t)
	var memberID string
	if err := a.server.DB.QueryRow(context.Background(), `SELECT id FROM "TeamMember" WHERE "teamId"=$1 AND "userId"=$2`, team["id"], member["id"]).Scan(&memberID); err != nil {
		t.Fatal(err)
	}
	path := "/api/admin/teams/" + text(team, "id") + "/members/" + memberID + "/kick"
	events, _ := a.eventStream("/api/admin/events/stream", "")
	waitLiveEvent(t, events, func(event liveEvent) bool { return event.data["type"] == "presence_updated" })
	for _, value := range []struct {
		name  string
		input any
	}{{"string-true", "true"}, {"string-false", "false"}, {"string-one", "1"}, {"string-zero", "0"}, {"number-one", 1}, {"number-zero", 0}, {"negative", -1}, {"fraction", 0.5}, {"object", Object{}}, {"array", []any{}}, {"empty-string", ""}} {
		t.Run(value.name, func(t *testing.T) {
			fixture := *a
			fixture.t = t
			a := &fixture
			node, _ := a.createNode()
			lease := a.teamKickLease(member, sub, node)
			otherLease := a.teamKickLease(Object{"id": team["ownerUserId"]}, sub, node)
			readyMarker := newID()
			a.server.events.publish("admin", Object{"type": "test_kick_ready", "marker": readyMarker})
			waitLiveEvent(t, events, func(event liveEvent) bool {
				return event.data["type"] == "test_kick_ready" && event.data["marker"] == readyMarker
			})
			before := policySchemaDigest(t, a)
			a.server.events.mu.Lock()
			sequence := a.server.events.sequence
			a.server.events.mu.Unlock()
			status, body := teamKickHTTPStatus(t, a, path, Object{"disableAccount": value.input, "status": "disabled", "role": "admin"})
			after := policySchemaDigest(t, a)
			a.server.events.mu.Lock()
			afterSequence := a.server.events.sequence
			a.server.events.mu.Unlock()
			marker := newID()
			a.server.events.publish("admin", Object{"type": "test_kick_barrier", "marker": marker})
			unexpected := []Object{}
			waitLiveEvent(t, events, func(event liveEvent) bool {
				if event.data["type"] == "test_kick_barrier" && event.data["marker"] == marker {
					return true
				}
				unexpected = append(unexpected, event.data)
				return false
			})
			beforeRaw, _ := json.Marshal(before)
			afterRaw, _ := json.Marshal(after)
			t.Logf("status=%d tables=%d before=%s after=%s eventSequence=%d→%d unexpectedSSE=%v activeLease=%v otherLease=%v", status, len(before), tokenHash(string(beforeRaw)), tokenHash(string(afterRaw)), sequence, afterSequence, unexpected, lease["id"], otherLease["id"])
			if status != 400 || !reflect.DeepEqual(before, after) || sequence != afterSequence || len(unexpected) != 0 {
				t.Errorf("非法disableAccount不得断开租约、创建任务、禁用账号或发布事件: %s", body)
			}
		})
	}
}

func TestTeamKickPreservesOptionalBooleanContractHTTP(t *testing.T) {
	for _, value := range []struct {
		name     string
		input    Object
		disabled bool
	}{{"missing", Object{}, false}, {"null", Object{"disableAccount": nil}, false}, {"false", Object{"disableAccount": false}, false}, {"true", Object{"disableAccount": true}, true}} {
		t.Run(value.name, func(t *testing.T) {
			a, team, member, sub := teamKickFixture(t)
			node, _ := a.createNode()
			lease := a.teamKickLease(member, sub, node)
			other := a.teamKickLease(Object{"id": team["ownerUserId"]}, sub, node)
			var memberID string
			if err := a.server.DB.QueryRow(context.Background(), `SELECT id FROM "TeamMember" WHERE "teamId"=$1 AND "userId"=$2`, team["id"], member["id"]).Scan(&memberID); err != nil {
				t.Fatal(err)
			}
			value.input["status"], value.input["role"] = "disabled", "admin"
			result := a.call("POST", "/api/admin/teams/"+text(team, "id")+"/members/"+memberID+"/kick", value.input, 200)
			var status, role, leaseStatus, otherStatus string
			if err := a.server.DB.QueryRow(context.Background(), `SELECT u.status::text,u.role::text,l.status::text,o.status::text FROM "User" u JOIN "NodeSessionLease" l ON l.id=$2 JOIN "NodeSessionLease" o ON o.id=$3 WHERE u.id=$1`, member["id"], lease["id"], other["id"]).Scan(&status, &role, &leaseStatus, &otherStatus); err != nil {
				t.Fatal(err)
			}
			wantStatus := "active"
			if value.disabled {
				wantStatus = "disabled"
			}
			var membership int
			if err := a.server.DB.QueryRow(context.Background(), `SELECT count(*) FROM "TeamMember" WHERE id=$1`, memberID).Scan(&membership); err != nil || membership != 1 {
				t.Fatal("断连或禁用不应移除成员", membership, err)
			}
			if status != wantStatus || role != "user" || leaseStatus != "revoked" || otherStatus != "active" || result["accountDisabled"] != value.disabled {
				t.Fatal("旧optional bool语义、未知字段白名单或另一成员隔离变化", result, status, role, leaseStatus, otherStatus)
			}
			t.Logf("input=%s account=%s lease=%s other=%s membership=%d", value.name, status, leaseStatus, otherStatus, membership)
		})
	}
}
