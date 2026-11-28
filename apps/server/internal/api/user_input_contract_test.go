package api

import (
	"encoding/json"
	"fmt"
	"golang.org/x/crypto/bcrypt"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestUserEditRejectsEmptyPasswordBeforeAnyMutationHTTP(t *testing.T) {
	a := newTestAPI(t)
	user := a.createUser()
	before, seq := policySchemaDigest(t, a), panelEventSequence(a)
	status, result := routingContractRequest(t, a, "PATCH", "/api/admin/users/"+text(user, "id"), Object{"displayName": "不应保存", "password": ""})
	if status != 400 || !reflect.DeepEqual(before, policySchemaDigest(t, a)) || seq != panelEventSequence(a) {
		t.Fatalf("显式空密码必须拒绝且全部表和事件不变: status=%d result=%v", status, result)
	}
}

func TestUserCreateAndEditMatchOriginalInputStorageHTTP(t *testing.T) {
	raw, err := os.ReadFile("testdata/user-input-legacy.json")
	if err != nil {
		t.Fatal(err)
	}
	var oracle struct {
		Commit string
		Cases  []struct {
			Operation, Name string
			Input           Object
			Status          int
			Stored          Object
		}
	}
	if err = json.Unmarshal(raw, &oracle); err != nil || oracle.Commit != "397a64d" || len(oracle.Cases) != 87 {
		t.Fatal("原用户输入与存储证据无效", err)
	}
	a := newTestAPI(t)
	user := a.createUser()
	id := text(user, "id")
	original := userSecurityRow(t, a, id)
	for i, sample := range oracle.Cases {
		t.Run(fmt.Sprintf("%02d-%s-%s", i, sample.Operation, sample.Name), func(t *testing.T) {
			meteringExec(t, a, `UPDATE "User" SET "displayName"='原名称',role='user',status='active',"maxConcurrentSessionsOverride"=7,"passwordHash"=$2 WHERE id=$1`, id, original["passwordHash"])
			input := Object{}
			if sample.Operation == "create" {
				input = Object{"email": fmt.Sprintf("original-contract-%d@example.com", i), "displayName": "原名称", "password": "  exact-password  ", "role": "user"}
			}
			for k, v := range sample.Input {
				input[k] = v
			}
			method, path := "PATCH", "/api/admin/users/"+id
			if sample.Operation == "create" {
				method, path = "POST", "/api/admin/users"
			}
			before, seq := policySchemaDigest(t, a), panelEventSequence(a)
			status, result := routingContractRequest(t, a, method, path, input)
			if status != sample.Status {
				t.Errorf("原DTO/Prisma契约差异: status=%d want=%d result=%v", status, sample.Status, result)
			}
			if sample.Status != 200 {
				if !reflect.DeepEqual(before, policySchemaDigest(t, a)) || seq != panelEventSequence(a) {
					t.Error("拒绝不得修改任何表或发布事件")
				}
				return
			}
			if status != 200 {
				return
			}
			for _, field := range []string{"displayName", "role", "status", "maxConcurrentSessionsOverride"} {
				if !reflect.DeepEqual(result[field], sample.Stored[field]) {
					t.Errorf("%s=%v want=%v", field, result[field], sample.Stored[field])
				}
			}
			if sample.Operation == "create" && result["email"] != strings.ToLower(stringValue(input, "email")) {
				t.Error("创建邮箱未正确保存", result["email"])
			}
			for _, field := range []string{"passwordHash", "authVersion"} {
				if _, present := result[field]; present {
					t.Error("响应暴露认证内部字段", field)
				}
			}
			row := userSecurityRow(t, a, text(result, "id"))
			if password, ok := input["password"].(string); ok && bcrypt.CompareHashAndPassword([]byte(text(row, "passwordHash")), []byte(password)) != nil {
				t.Error("密码原始空格未保留或哈希不匹配")
			}
			if sample.Operation == "update" && row["email"] != original["email"] {
				t.Error("编辑入口写入未声明字段email")
			}
		})
	}
}

func TestUserEditValidPasswordInvalidatesOnlyItsExistingCredentialsHTTP(t *testing.T) {
	a := newTestAPI(t)
	user, control := a.createUser(), a.createUser()
	admin := a.token
	a.token = ""
	login := a.call("POST", "/api/auth/login", Object{"email": user["email"], "password": "  exact-password  "}, 200)
	controlToken := a.loginUser(control)
	a.token = admin
	a.call("PATCH", "/api/admin/users/"+text(user, "id"), Object{"displayName": " 名称修改不撤销登录 "}, 200)
	a.token = text(login, "accessToken")
	a.call("GET", "/api/client/ping", nil, 200)
	a.token = admin
	a.call("PATCH", "/api/admin/users/"+text(user, "id"), Object{"password": "  changed-password  "}, 200)
	a.token = text(login, "accessToken")
	a.call("GET", "/api/client/ping", nil, 401)
	a.call("POST", "/api/auth/refresh", Object{"refreshToken": login["refreshToken"]}, 401)
	a.token = controlToken
	a.call("GET", "/api/client/ping", nil, 200)
	a.token = ""
	a.call("POST", "/api/auth/login", Object{"email": user["email"], "password": "  exact-password  "}, 401)
	a.call("POST", "/api/auth/login", Object{"email": user["email"], "password": "changed-password"}, 401)
	a.call("POST", "/api/auth/login", Object{"email": user["email"], "password": "  changed-password  "}, 200)
}

func TestUserInputMissingFieldsDuplicateAndStorageOverflowPrecedenceHTTP(t *testing.T) {
	a := newTestAPI(t)
	user := a.createUser()
	for _, sample := range []struct {
		method, path string
		input        Object
		status       int
	}{
		{"PATCH", "/api/admin/users/" + newID(), Object{"displayName": ""}, 400},
		{"PATCH", "/api/admin/users/" + newID(), Object{"maxConcurrentSessionsOverride": 2147483648}, 404},
		{"POST", "/api/admin/users", Object{"email": user["email"], "displayName": "有效名称", "password": "valid-password", "role": "user", "maxConcurrentSessionsOverride": 2147483648}, 409},
		{"POST", "/api/admin/users", Object{"email": "missing-fields@example.com", "displayName": "有效名称", "password": "valid-password"}, 400},
		{"PATCH", "/api/admin/users/" + text(user, "id"), Object{"password": strings.Repeat("a", 73)}, 400},
	} {
		before, seq := policySchemaDigest(t, a), panelEventSequence(a)
		status, result := routingContractRequest(t, a, sample.method, sample.path, sample.input)
		if status != sample.status || !reflect.DeepEqual(before, policySchemaDigest(t, a)) || seq != panelEventSequence(a) {
			t.Errorf("拒绝优先级/副作用错误: got=%d want=%d result=%v", status, sample.status, result)
		}
	}
}
