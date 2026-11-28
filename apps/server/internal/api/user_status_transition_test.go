package api

import (
	"context"
	"reflect"
	"testing"
	"time"
)

func TestOrdinaryUserSameActiveMetadataEditDoesNotReprovisionHTTP(t *testing.T) {
	f := newLeasePolicyFixture(t, false, 1)
	a := f.a
	f.seed(t, "metadata", 0, time.Now().Add(-time.Minute), time.Now(), time.Now().Add(time.Hour))
	a.server.tasks.close()
	before := policySchemaDigest(t, a)
	old := userSecurityRow(t, a, text(f.user, "id"))
	response := a.call("PATCH", "/api/admin/users/"+text(f.user, "id"), Object{"displayName": "只修改用户名称", "status": "active"}, 200)
	after := policySchemaDigest(t, a)
	for table, value := range before {
		if table != "User" && !reflect.DeepEqual(value, after[table]) {
			t.Errorf("相同active资料编辑不应写入%s: before=%v after=%v", table, value, after[table])
		}
	}
	current := userSecurityRow(t, a, text(f.user, "id"))
	want := Object{}
	for key, value := range old {
		want[key] = value
	}
	want["displayName"], want["updatedAt"] = "只修改用户名称", current["updatedAt"]
	if !reflect.DeepEqual(want, current) {
		t.Error("普通资料保存改变凭据/认证版本/状态或并发策略")
	}
	if response["displayName"] != "只修改用户名称" || response["status"] != "active" {
		t.Error("响应未反映已保存资料", response)
	}
	for _, key := range []string{"passwordHash", "authVersion"} {
		if _, ok := response[key]; ok {
			t.Error("响应泄露内部认证字段", key)
		}
	}
}

func TestOrdinaryUserSameDisabledMetadataEditDoesNotRevokeAgainHTTP(t *testing.T) {
	a := newTestAPI(t)
	user := a.createUser()
	_ = a.loginUser(user)
	a.call("PATCH", "/api/admin/users/"+text(user, "id"), Object{"status": "disabled"}, 200)
	a.server.tasks.close()
	before := policySchemaDigest(t, a)
	old := userSecurityRow(t, a, text(user, "id"))
	a.call("PATCH", "/api/admin/users/"+text(user, "id"), Object{"status": "disabled", "displayName": "停用用户只改资料"}, 200)
	after := policySchemaDigest(t, a)
	for table, value := range before {
		if table != "User" && !reflect.DeepEqual(value, after[table]) {
			t.Error("相同disabled资料编辑再次修改无关表", table)
		}
	}
	current := userSecurityRow(t, a, text(user, "id"))
	want := Object{}
	for key, value := range old {
		want[key] = value
	}
	want["displayName"], want["updatedAt"] = "停用用户只改资料", current["updatedAt"]
	if !reflect.DeepEqual(want, current) {
		t.Errorf("相同disabled不应再次变更认证版本: before=%v after=%v", old["authVersion"], current["authVersion"])
	}
}

func TestOrdinaryUserSameStatusEditingDoesNotRefreshHealthyTeamMembersHTTP(t *testing.T) {
	f := newLeasePolicyFixture(t, true, 2)
	a := f.a
	f.seed(t, "team-metadata", 0, time.Now().Add(-time.Minute), time.Now(), time.Now().Add(time.Hour))
	a.server.tasks.close()
	for _, input := range []Object{
		{"displayName": "只改团队成员名字", "status": "active"},
		{"displayName": "省略状态编辑"},
		{"displayName": "完整表单再次保存", "status": "active", "role": "user", "maxConcurrentSessionsOverride": nil},
	} {
		before := policySchemaDigest(t, a)
		old := userSecurityRow(t, a, text(f.user, "id"))
		a.call("PATCH", "/api/admin/users/"+text(f.user, "id"), input, 200)
		after := policySchemaDigest(t, a)
		for table, value := range before {
			if table != "User" && !reflect.DeepEqual(value, after[table]) {
				t.Error("成员资料保存扩散为团队供给或其他表写入", table)
			}
		}
		current := userSecurityRow(t, a, text(f.user, "id"))
		want := Object{}
		for key, value := range old {
			want[key] = value
		}
		want["displayName"], want["updatedAt"] = input["displayName"], current["updatedAt"]
		if !reflect.DeepEqual(want, current) {
			t.Error("团队成员无敏感变更时改变了认证/策略")
		}
	}
}

// Protocol acknowledgements isolate API state; the physical Agent/Xray chain is tested separately.
func ackUserStatusCommands(t *testing.T, f *leasePolicyFixture) {
	t.Helper()
	a := f.a
	jobs, err := list(context.Background(), a.server.DB, `SELECT to_jsonb(j) FROM "NodeCommandJob" j WHERE status='pending' AND "commandType" IN('ENSURE_USER','DISABLE_USER') ORDER BY "nodeId","targetRevision"`)
	if err != nil {
		t.Fatal(err)
	}
	admin := a.token
	defer func() { a.token = admin }()
	for _, job := range jobs {
		a.token = f.nodeTokens[text(job, "nodeId")]
		result := Object{}
		if job["commandType"] == "DISABLE_USER" {
			result["disableWatermarks"] = []any{}
		}
		a.call("POST", "/api/agent/v1/commands/"+text(job, "id")+"/result", Object{"status": "completed", "result": result}, 200)
	}
}

func userStatusEnsureCount(t *testing.T, a *testAPI) int {
	t.Helper()
	var count int
	if err := a.server.DB.QueryRow(context.Background(), `SELECT count(*) FROM "NodeCommandJob" WHERE "commandType"='ENSURE_USER'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func TestOrdinaryUserRealReactivationStillRefreshesAccessHTTP(t *testing.T) {
	f := newLeasePolicyFixture(t, false, 1)
	a := f.a
	lease := f.seed(t, "before-disable", 0, time.Now().Add(-time.Minute), time.Now(), time.Now().Add(time.Hour))
	a.server.tasks.close()
	version := number(userSecurityRow(t, a, text(f.user, "id")), "authVersion")
	a.call("PATCH", "/api/admin/users/"+text(f.user, "id"), Object{"status": "disabled"}, 200)
	ackUserStatusCommands(t, f)
	if row := f.row(t, text(lease, "id")); row["status"] != "revoked" || row["revokedReason"] != "account_disabled" {
		t.Fatal("真停用必须撤销原租约", row["status"], row["revokedReason"])
	}
	count := userStatusEnsureCount(t, a)
	a.call("PATCH", "/api/admin/users/"+text(f.user, "id"), Object{"status": "active"}, 200)
	if got := userStatusEnsureCount(t, a); got != count+1 {
		t.Fatal("真启用必须保留供给刷新", count, got)
	}
	ackUserStatusCommands(t, f)
	before := policySchemaDigest(t, a)
	a.call("PATCH", "/api/admin/users/"+text(f.user, "id"), Object{"status": "active"}, 200)
	after := policySchemaDigest(t, a)
	for table, value := range before {
		if table != "User" && !reflect.DeepEqual(value, after[table]) {
			t.Error("启用后的重复保存再次同步", table)
		}
	}
	if row := userSecurityRow(t, a, text(f.user, "id")); number(row, "authVersion") != version+1 {
		t.Fatal("启用不能复活旧认证版本")
	}
	actor := *a
	actor.token = f.userToken
	actor.call("GET", "/api/client/subscription", nil, 401)
	actor.token = a.loginUser(f.user)
	actor.call("GET", "/api/client/subscription", nil, 200)
	if f.row(t, text(lease, "id"))["status"] != "revoked" {
		t.Fatal("启用不得复活旧租约")
	}
}
