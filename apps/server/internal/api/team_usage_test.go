package api

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"
)

func addUsageLedger(t *testing.T, a *testAPI, data Object) {
	t.Helper()
	if _, err := insert(context.Background(), a.server.DB, "TrafficLedger", data); err != nil {
		t.Fatal(err)
	}
}

func assertEmbeddedTeamUsage(t *testing.T, team Object, usage []Object) {
	t.Helper()
	raw, err := json.Marshal(team["usage"])
	if err != nil {
		t.Fatal(err)
	}
	var embedded []Object
	if err = json.Unmarshal(raw, &embedded); err != nil || !reflect.DeepEqual(embedded, usage) {
		t.Fatal("团队记录内嵌usage与专用接口没有复用同一归纳契约", err)
	}
	byUser := map[string]float64{}
	for _, item := range usage {
		byUser[text(item, "userId")] = number(item, "memberTotalUsedTrafficGb")
	}
	for _, raw := range team["members"].([]any) {
		member := raw.(map[string]any)
		if number(member, "usedTrafficGb") != byUser[text(member, "userId")] {
			t.Error("成员用量没有使用同一团队聚合", text(member, "userId"))
		}
	}
}

func TestTeamUsageAggregatesRealLedgerRowsAcrossNodes(t *testing.T) {
	a := newTestAPI(t)
	owner, member := a.createUser(), a.createUser()
	team := a.call("POST", "/api/admin/teams", Object{"name": "多节点用量契约", "ownerUserId": owner["id"]}, 200)
	id := text(team, "id")
	a.call("POST", "/api/admin/teams/"+id+"/members", Object{"userId": member["id"]}, 200)
	plan := a.createPlan("team")
	sub := a.call("POST", "/api/admin/teams/"+id+"/subscriptions", Object{"planId": plan["id"], "expireAt": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}, 200)
	nodeA, _ := a.createNode()
	nodeB, _ := a.createNode()
	for _, row := range []struct {
		user, node Object
		bytes      int64
		gb         float64
		at         string
	}{
		{owner, nodeA, 4194304, 999, "2026-11-17T01:00:00Z"},
		{owner, nodeA, 4194304, .00390625, "2026-11-17T01:01:00Z"},
		{owner, nodeB, 2097152, .001953125, "2026-11-17T01:04:00Z"},
		{member, nodeA, 16777216, .015625, "2026-11-17T01:02:00Z"},
		{member, nodeB, 4194304, .00390625, "2026-11-17T01:03:00Z"},
	} {
		addUsageLedger(t, a, Object{"teamId": id, "userId": row.user["id"], "subscriptionId": sub["id"], "nodeId": row.node["id"],
			"usedTrafficBytes": row.bytes, "usedTrafficGb": row.gb, "recordedAt": row.at})
	}
	usage := a.array("/api/admin/teams/" + id + "/usage")
	if len(usage) != 2 {
		t.Fatalf("同一成员多条计量应归纳成单条DTO，得到%d条", len(usage))
	}
	for i, expected := range []struct {
		user  Object
		gb    float64
		count float64
	}{{owner, .010, 3}, {member, .020, 2}} {
		entry := usage[i]
		if entry["userId"] != expected.user["id"] || entry["teamId"] != id || entry["subscriptionId"] != sub["id"] || entry["usedTrafficGb"] != expected.gb || entry["memberTotalUsedTrafficGb"] != expected.gb || entry["recordCount"] != expected.count {
			t.Fatal("聚合总量、真实字节优先或实际账本计数不符合契约", entry)
		}
		if entry["userDisplayName"] != expected.user["displayName"] || entry["userEmail"] != expected.user["email"] {
			t.Fatal("归纳DTO缺少成员显示信息")
		}
		nodes, ok := entry["nodeBreakdown"].([]any)
		if !ok || len(nodes) != 2 || nodes[0].(map[string]any)["nodeId"] != nodeB["id"] || nodes[1].(map[string]any)["nodeId"] != nodeA["id"] {
			t.Fatal("节点归纳缺失或没有按最近计量排序")
		}
		if i == 0 && (nodes[1].(map[string]any)["recordCount"] != float64(2) || nodes[1].(map[string]any)["usedTrafficGb"] != .0078125 || nodes[1].(map[string]any)["lastRecordedAt"] != "2026-11-17T01:01:00Z") {
			t.Fatal("同node/sub的多次计量没有准确计数与累加")
		}
		if _, exposed := entry["usedTrafficBytes"]; exposed {
			t.Fatal("公共DTO不应暴露内部字节账本字段")
		}
	}
	assertEmbeddedTeamUsage(t, a.array("/api/admin/teams")[0], usage)
	updated := a.call("PATCH", "/api/admin/teams/"+id, Object{"name": "归纳后保持一致"}, 200)
	assertEmbeddedTeamUsage(t, updated, usage)
}

func TestTeamUsageKeepsHistoricalSubscriptionsUnknownNodesAndFormerMembers(t *testing.T) {
	a := newTestAPI(t)
	owner, former, unused, otherOwner := a.createUser(), a.createUser(), a.createUser(), a.createUser()
	team := a.call("POST", "/api/admin/teams", Object{"name": "历史用量团队", "ownerUserId": owner["id"]}, 200)
	id := text(team, "id")
	for _, user := range []Object{former, unused} {
		a.call("POST", "/api/admin/teams/"+id+"/members", Object{"userId": user["id"]}, 200)
	}
	plan := a.createPlan("team")
	old := a.call("POST", "/api/admin/teams/"+id+"/subscriptions", Object{"planId": plan["id"], "expireAt": time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)}, 200)
	current := a.call("POST", "/api/admin/teams/"+id+"/subscriptions", Object{"planId": plan["id"], "expireAt": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}, 200)
	other := a.call("POST", "/api/admin/teams", Object{"name": "隔离对照团队", "ownerUserId": otherOwner["id"]}, 200)
	otherSub := a.call("POST", "/api/admin/teams/"+text(other, "id")+"/subscriptions", Object{"planId": plan["id"], "expireAt": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}, 200)
	node, _ := a.createNode()
	for _, row := range []struct {
		team, user, sub Object
		gb              float64
		bytes           any
		node            any
		at              string
	}{
		{team, owner, old, 1, nil, nil, "2026-10-01T01:00:00Z"},
		{team, owner, old, .125, nil, node["id"], "2026-10-01T01:30:00Z"},
		{team, owner, current, .25, 268435456, node["id"], "2026-11-17T01:00:00Z"},
		{team, former, old, 1, nil, nil, "2026-10-01T02:00:00Z"},
		{team, former, current, .5, 536870912, node["id"], "2026-11-17T02:00:00Z"},
		{other, owner, otherSub, 99, nil, node["id"], "2026-11-17T03:00:00Z"},
	} {
		data := Object{"teamId": row.team["id"], "userId": row.user["id"], "subscriptionId": row.sub["id"], "usedTrafficGb": row.gb, "nodeId": row.node, "recordedAt": row.at}
		if row.bytes != nil {
			data["usedTrafficBytes"] = row.bytes
		}
		addUsageLedger(t, a, data)
	}
	for _, raw := range a.array("/api/admin/teams") {
		if raw["id"] == id {
			for _, member := range raw["members"].([]any) {
				entry := member.(map[string]any)
				if entry["userId"] == former["id"] {
					a.call("DELETE", "/api/admin/teams/"+id+"/members/"+text(entry, "id"), nil, 200)
				}
			}
		}
	}
	usage := a.array("/api/admin/teams/" + id + "/usage")
	if len(usage) != 2 {
		t.Fatalf("历史及离队成员仍应按成员合并，得到%d条", len(usage))
	}
	for _, item := range usage {
		expected := 1.375
		count := float64(3)
		if item["userId"] == former["id"] {
			expected = 1.5
			count = 2
		}
		if item["memberTotalUsedTrafficGb"] != expected || item["recordCount"] != count || item["subscriptionId"] != current["id"] {
			t.Fatal("默认0字节历史、跨期记录或跨团队隔离错误", item)
		}
		nodes := item["nodeBreakdown"].([]any)
		unknown := nodes[1].(map[string]any)
		if unknown["nodeId"] != "unknown" || unknown["nodeName"] != "未知节点" || unknown["nodeRegion"] != "未知" {
			t.Fatal("无node历史必须保留为未知节点分项")
		}
		if item["userId"] == owner["id"] && (nodes[0].(map[string]any)["usedTrafficGb"] != .375 || nodes[0].(map[string]any)["recordCount"] != float64(2)) {
			t.Fatal("同一节点跨历史与当前订阅的用量应合并")
		}
	}
	for _, item := range a.array("/api/admin/teams") {
		if item["id"] == id {
			assertEmbeddedTeamUsage(t, item, usage)
			if item["memberCount"] != float64(2) || item["currentSubscription"].(map[string]any)["id"] != current["id"] {
				t.Fatal("历史聚合不应改变当前成员和当前订阅")
			}
		}
	}
	otherUsage := a.array("/api/admin/teams/" + text(other, "id") + "/usage")
	if len(otherUsage) != 1 || otherUsage[0]["memberTotalUsedTrafficGb"] != float64(99) {
		t.Fatal("相同user跨团队历史不应合并")
	}
}

func TestTeamUsageRequiresExistingTeamAndAdmin(t *testing.T) {
	a := newTestAPI(t)
	user := a.createUser()
	team := a.call("POST", "/api/admin/teams", Object{"name": "空团队用量", "ownerUserId": user["id"]}, 200)
	if usage := a.array("/api/admin/teams/" + text(team, "id") + "/usage"); len(usage) != 0 {
		t.Fatal("无账本应返回空数组")
	}
	a.call("GET", "/api/admin/teams/missing-team/usage", nil, 404)
	a.token = ""
	a.call("GET", "/api/admin/teams/"+text(team, "id")+"/usage", nil, 401)
	a.token = a.loginUser(user)
	a.call("GET", "/api/admin/teams/"+text(team, "id")+"/usage", nil, 403)
}
