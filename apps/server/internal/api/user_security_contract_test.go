package api

import (
	"context"
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func userSecurityRow(t *testing.T, a *testAPI, id string) Object {
	t.Helper()
	row, err := one(context.Background(), a.server.DB, `SELECT to_jsonb(u) FROM "User" u WHERE id=$1`, id)
	if err != nil {
		t.Fatal(err)
	}
	return row
}

func TestUserSecurityMatchesOriginalDTOAndStorageHTTP(t *testing.T) {
	raw, err := os.ReadFile("testdata/user-security-legacy.json")
	if err != nil {
		t.Fatal(err)
	}
	var oracle struct {
		Commit string
		Cases  []struct {
			Name    string
			Input   Object
			Status  int
			Stored  any
			Missing bool
		}
	}
	if err = json.Unmarshal(raw, &oracle); err != nil || oracle.Commit != "397a64d" || len(oracle.Cases) != 48 {
		t.Fatal("旧安全设置契约证据无效", err)
	}
	a := newTestAPI(t)
	user, other := a.createUser(), a.createUser()
	id := text(user, "id")
	original, control := userSecurityRow(t, a, id), userSecurityRow(t, a, text(other, "id"))
	for _, sample := range oracle.Cases {
		t.Run(sample.Name, func(t *testing.T) {
			meteringExec(t, a, `UPDATE "User" SET "displayName"=$2,role=$3,status=$4,"passwordHash"=$5,"authVersion"=$6,"maxConcurrentSessionsOverride"=7 WHERE id=$1`, id, original["displayName"], original["role"], original["status"], original["passwordHash"], int(number(original, "authVersion")))
			beforeRow, before, seq := userSecurityRow(t, a, id), policySchemaDigest(t, a), panelEventSequence(a)
			target := id
			if sample.Missing {
				target = newID()
			}
			status, response := routingContractRequest(t, a, "PUT", "/api/admin/users/"+target+"/security", sample.Input)
			afterRow, after := userSecurityRow(t, a, id), policySchemaDigest(t, a)
			if status != sample.Status || afterRow["maxConcurrentSessionsOverride"] != sample.Stored {
				t.Errorf("原DTO/Prisma契约差异: status=%d want=%d stored=%v want=%v response=%v", status, sample.Status, afterRow["maxConcurrentSessionsOverride"], sample.Stored, response)
			}
			expected := Object{}
			for key, value := range beforeRow {
				expected[key] = value
			}
			wantEvents := uint64(0)
			if sample.Status == 200 {
				expected["maxConcurrentSessionsOverride"], expected["updatedAt"] = sample.Stored, afterRow["updatedAt"]
				wantEvents = 1
			}
			if !reflect.DeepEqual(expected, afterRow) {
				t.Error("安全入口只可写override/updatedAt，不可写密码/角色/状态/名称或认证版本")
			}
			for table, digest := range before {
				if (table != "User" || sample.Status != 200) && !reflect.DeepEqual(digest, after[table]) {
					t.Error("安全入口改变无关表或拒绝请求落库", table)
				}
			}
			if !reflect.DeepEqual(control, userSecurityRow(t, a, text(other, "id"))) {
				t.Error("其他用户被修改")
			}
			if panelEventSequence(a)-seq != wantEvents {
				t.Error("无租约时成功仅发布账号事件，拒绝不发布", panelEventSequence(a)-seq, wantEvents)
			}
			if status == 200 {
				if response["id"] != id || response["maxConcurrentSessionsOverride"] != sample.Stored {
					t.Error("响应未投影新策略", response)
				}
				for _, key := range []string{"passwordHash", "authVersion"} {
					if _, present := response[key]; present {
						t.Error("响应暴露认证内部字段", key)
					}
				}
			}
			t.Logf("status=%d expected=%d stored=%v tables=%d events=%d", status, sample.Status, afterRow["maxConcurrentSessionsOverride"], len(before), panelEventSequence(a)-seq)
		})
	}
}

func TestUserSecurityAuthorizationAndOrdinaryEditStaySeparateHTTP(t *testing.T) {
	a := newTestAPI(t)
	user := a.createUser()
	admin := a.token
	token := a.loginUser(user)
	for _, auth := range []struct {
		token  string
		status int
	}{{"", 401}, {token, 403}} {
		a.token = auth.token
		before, seq := policySchemaDigest(t, a), panelEventSequence(a)
		status, _ := routingContractRequest(t, a, "PUT", "/api/admin/users/"+text(user, "id")+"/security", Object{})
		if status != auth.status || !reflect.DeepEqual(before, policySchemaDigest(t, a)) || seq != panelEventSequence(a) {
			t.Fatal("用户安全入口必须保持管理员鉴权且无拒绝副作用", status)
		}
	}
	a.token = admin
	before := userSecurityRow(t, a, a.adminID)
	result := a.call("PUT", "/api/admin/users/"+a.adminID+"/security", Object{"role": "user", "status": "disabled", "password": "must-ignore-password", "displayName": "must-ignore"}, 200)
	after := userSecurityRow(t, a, a.adminID)
	for _, field := range []string{"role", "status", "passwordHash", "displayName", "authVersion"} {
		if before[field] != after[field] {
			t.Error("最后管理员安全入口不得执行普通编辑字段", field)
		}
	}
	if result["maxConcurrentSessionsOverride"] != nil {
		t.Fatal("仅有额外字段也必须清override")
	}
	updated := a.call("PATCH", "/api/admin/users/"+text(user, "id"), Object{"displayName": "普通编辑仍可修改", "maxConcurrentSessionsOverride": 5}, 200)
	if updated["displayName"] != "普通编辑仍可修改" || updated["maxConcurrentSessionsOverride"] != float64(5) {
		t.Fatal("安全入口隔离误改普通编辑")
	}
	updated = a.call("PATCH", "/api/admin/users/"+text(user, "id"), Object{"maxConcurrentSessionsOverride": 101}, 200)
	if updated["maxConcurrentSessionsOverride"] != float64(101) {
		t.Fatal("普通编辑须保留原DTO允许大于100的正数")
	}
	beforeSchema := policySchemaDigest(t, a)
	a.call("PATCH", "/api/admin/users/"+text(user, "id"), Object{"maxConcurrentSessionsOverride": false}, 400)
	if !reflect.DeepEqual(beforeSchema, policySchemaDigest(t, a)) {
		t.Fatal("普通编辑拒绝值不得写入")
	}
}
