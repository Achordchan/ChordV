package api

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

func TestOrdinaryUserSameStatusSensitiveChangesStillRevokeHTTP(t *testing.T) {
	for _, state := range []string{"active", "disabled"} {
		for _, field := range []string{"role", "password"} {
			t.Run(state+"/"+field, func(t *testing.T) {
				f := newLeasePolicyFixture(t, false, 1)
				a := f.a
				lease := f.seed(t, "sensitive", 0, time.Now().Add(-time.Minute), time.Now(), time.Now().Add(time.Hour))
				a.server.tasks.close()
				if state == "disabled" {
					a.call("PATCH", "/api/admin/users/"+text(f.user, "id"), Object{"status": "disabled"}, 200)
					ackUserStatusCommands(t, f)
				}
				before := userSecurityRow(t, a, text(f.user, "id"))
				ensures := userStatusEnsureCount(t, a)
				input := Object{"status": state}
				if field == "role" {
					input[field] = "admin"
				} else {
					input[field] = "  exact-new-password  "
				}
				a.call("PATCH", "/api/admin/users/"+text(f.user, "id"), input, 200)
				after := userSecurityRow(t, a, text(f.user, "id"))
				if number(after, "authVersion") != number(before, "authVersion")+1 || after["status"] != state {
					t.Fatal("相同状态的真实敏感修改仍须独立撤权")
				}
				if field == "role" && after["role"] != "admin" {
					t.Fatal("角色未保存")
				}
				if field == "password" && bcrypt.CompareHashAndPassword([]byte(text(after, "passwordHash")), []byte(input[field].(string))) != nil {
					t.Fatal("新密码未按原始空格保存")
				}
				var active int
				if err := a.server.DB.QueryRow(context.Background(), `SELECT count(*) FROM "RefreshToken" WHERE "userId"=$1 AND "revokedAt" IS NULL`, f.user["id"]).Scan(&active); err != nil || active != 0 {
					t.Fatal("敏感修改遗留可刷新凭据", active, err)
				}
				if state == "active" {
					row := f.row(t, text(lease, "id"))
					if row["status"] != "revoked" || row["revokedReason"] != "auth_invalid" {
						t.Fatal("敏感修改未撤销原租约", row["status"], row["revokedReason"])
					}
				}
				if got := userStatusEnsureCount(t, a); got != ensures {
					t.Fatal("敏感修改不能被同状态字段额外触发ENSURE", ensures, got)
				}
			})
		}
	}
}

func TestOrdinaryUserTrueDisableWithPasswordRevokesOnceAndKeepsAdminGuardHTTP(t *testing.T) {
	f := newLeasePolicyFixture(t, false, 1)
	a := f.a
	f.seed(t, "disable-password", 0, time.Now().Add(-time.Minute), time.Now(), time.Now().Add(time.Hour))
	a.server.tasks.close()
	before := userSecurityRow(t, a, text(f.user, "id"))
	a.call("PATCH", "/api/admin/users/"+text(f.user, "id"), Object{"status": "disabled", "password": "new-disabled-password"}, 200)
	after := userSecurityRow(t, a, text(f.user, "id"))
	if number(after, "authVersion") != number(before, "authVersion")+1 {
		t.Fatal("真停用加密码不能双重递增认证版本")
	}
	if bcrypt.CompareHashAndPassword([]byte(text(after, "passwordHash")), []byte("new-disabled-password")) != nil {
		t.Fatal("停用请求密码未持久化")
	}
	for _, input := range []Object{{"status": "active", "role": "user"}, {"status": "disabled"}, {"status": "disabled", "role": "user", "password": "new-admin-password"}} {
		snapshot := policySchemaDigest(t, a)
		a.call("PATCH", "/api/admin/users/"+a.adminID, input, 409)
		if !reflect.DeepEqual(snapshot, policySchemaDigest(t, a)) {
			t.Fatal("最后管理员拒绝请求发生副作用")
		}
	}
}

func TestOrdinaryUserSameActiveStillEnforcesChangedConcurrencyHTTP(t *testing.T) {
	for _, nodeCount := range []int{1, 2} {
		t.Run(fmt.Sprintf("nodes=%d", nodeCount), func(t *testing.T) {
			f := newLeasePolicyFixture(t, false, nodeCount)
			a := f.a
			old := f.seed(t, "old-session", 0, time.Now().Add(-time.Hour), time.Now(), time.Now().Add(time.Hour))
			fresh := f.seed(t, "new-session", nodeCount-1, time.Now().Add(-time.Minute), time.Now(), time.Now().Add(time.Hour))
			a.server.tasks.close()
			count := userStatusEnsureCount(t, a)
			version := number(userSecurityRow(t, a, text(f.user, "id")), "authVersion")
			jobs, err := list(context.Background(), a.server.DB, `SELECT to_jsonb(j) FROM "NodeCommandJob" j ORDER BY id`)
			if err != nil {
				t.Fatal(err)
			}
			a.call("PATCH", "/api/admin/users/"+text(f.user, "id"), Object{"status": "active", "maxConcurrentSessionsOverride": 1}, 200)
			if f.row(t, text(old, "id"))["status"] != "evicted" || f.row(t, text(fresh, "id"))["status"] != "active" {
				t.Fatal("状态去重不能取消真实降并发")
			}
			if userStatusEnsureCount(t, a) != count {
				t.Fatal("降并发不应因同active额外ENSURE所有账号")
			}
			if number(userSecurityRow(t, a, text(f.user, "id")), "authVersion") != version {
				t.Fatal("降并发不应撤销全部登录凭据")
			}
			if nodeCount == 1 {
				after, err := list(context.Background(), a.server.DB, `SELECT to_jsonb(j) FROM "NodeCommandJob" j ORDER BY id`)
				if err != nil || !reflect.DeepEqual(jobs, after) {
					t.Fatal("同节点尚有有效租约时不得重建或停用账号", err)
				}
			} else {
				var disabled int
				if err := a.server.DB.QueryRow(context.Background(), `SELECT count(*) FROM "NodeCommandJob" WHERE "commandType"='DISABLE_USER' AND status='pending'`).Scan(&disabled); err != nil || disabled != 1 {
					t.Fatal("最后一个旧节点租约被逐出仍须停用该节点", disabled, err)
				}
			}
		})
	}
}

func TestOrdinaryUserConcurrentReactivationQueuesOneRefreshHTTP(t *testing.T) {
	f := newLeasePolicyFixture(t, false, 1)
	a := f.a
	f.seed(t, "concurrent-enable", 0, time.Now().Add(-time.Minute), time.Now(), time.Now().Add(time.Hour))
	a.server.tasks.close()
	a.call("PATCH", "/api/admin/users/"+text(f.user, "id"), Object{"status": "disabled"}, 200)
	ackUserStatusCommands(t, f)
	count := userStatusEnsureCount(t, a)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	gate := make(chan struct{})
	arrived := make(chan struct{}, 2)
	var once sync.Once
	target := "/api/admin/users/" + text(f.user, "id")
	handler := a.server.Handler()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "PATCH" && r.URL.Path == target {
			arrived <- struct{}{}
			select {
			case <-gate:
			case <-ctx.Done():
				http.Error(w, "owned test barrier timeout", 503)
				return
			}
		}
		handler.ServeHTTP(w, r)
	}))
	defer server.Close()
	defer once.Do(func() { close(gate) })
	actor := *a
	actor.http = server
	first := leaseAsyncRequest(ctx, &actor, "PATCH", target, `{"status":"active"}`)
	second := leaseAsyncRequest(ctx, &actor, "PATCH", target, `{"status":"active"}`)
	for range 2 {
		select {
		case <-arrived:
		case <-ctx.Done():
			t.Fatal("两个真实请求未同时到达HTTP屏障")
		}
	}
	once.Do(func() { close(gate) })
	for _, done := range []<-chan leaseHTTPResult{first, second} {
		result := <-done
		if result.err != nil || result.status != 200 {
			t.Fatal("并发启用失败", result.status, result.err)
		}
	}
	if got := userStatusEnsureCount(t, a); got != count+1 {
		t.Fatal("已锁事务中并发启用只应有一次状态迁移供给", count, got)
	}
}

func TestSubscriptionQuotaAndExpiryStillRefreshHealthyBindingHTTP(t *testing.T) {
	f := newLeasePolicyFixture(t, false, 1)
	a := f.a
	a.server.tasks.close()
	for _, input := range []Object{{"totalTrafficGb": 11}, {"expireAt": time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339)}} {
		count := userStatusEnsureCount(t, a)
		a.call("PATCH", "/api/admin/subscriptions/"+text(f.sub, "id"), input, 200)
		if got := userStatusEnsureCount(t, a); got != count+1 {
			t.Fatal("不得用全局跳过active兜底，配额/有效期变更仍须刷新", count, got)
		}
		ackUserStatusCommands(t, f)
	}
}
