package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type supportRotationSnapshot struct {
	config, unread    string
	generation, epoch int64
}

func readSupportRotationSnapshot(t *testing.T, a *testAPI) supportRotationSnapshot {
	t.Helper()
	var snapshot supportRotationSnapshot
	err := a.server.DB.QueryRow(context.Background(), `SELECT
 md5(to_jsonb(s)::text),coalesce((s.value->>'generation')::bigint,0),coalesce((s.value->>'epoch')::bigint,0),
 md5(jsonb_build_object(
 'users',(SELECT coalesce(jsonb_agg(to_jsonb(u) ORDER BY "userId"),'[]'::jsonb) FROM "SupportUnreadState" u),
 'requests',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY "userId","requestId"),'[]'::jsonb) FROM "SupportRequestUnread" r),
 'events',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY "eventId"),'[]'::jsonb) FROM "AchordConnectWebhookEvent" e))::text)
 FROM "SystemSetting" s WHERE key='achord-connect'`).Scan(&snapshot.config, &snapshot.generation, &snapshot.epoch, &snapshot.unread)
	if err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func supportRotationFixture(t *testing.T) (*testAPI, string, string, string, string) {
	t.Helper()
	a := newTestAPI(t)
	clientSecret, webhookSecret := newID(), newID()
	provider := func(w http.ResponseWriter, r *http.Request) {
		client, secret, ok := r.BasicAuth()
		if !ok || (client != "first-client" && client != "next-client") || secret != clientSecret {
			w.WriteHeader(401)
			return
		}
		writeJSON(w, 200, Object{"data": Object{"unreadCount": 0}})
	}
	first, next := httptest.NewServer(http.HandlerFunc(provider)), httptest.NewServer(http.HandlerFunc(provider))
	t.Cleanup(first.Close)
	t.Cleanup(next.Close)
	result := a.call("PUT", "/api/admin/support-integration", Object{"baseUrl": first.URL, "clientId": "first-client", "clientSecret": clientSecret, "webhookSecret": webhookSecret, "enabled": false}, 200)
	if result["hasClientSecret"] != true || result["hasWebhookSecret"] != true || result["enabled"] != false {
		t.Fatal("首次配置应允许保存完整凭据而不启用")
	}
	user := a.createUser()
	for i, uid := range []string{a.adminID, text(user, "id")} {
		if _, err := a.server.DB.Exec(context.Background(), `INSERT INTO "SupportUnreadState"("userId","unreadCount","sourceAt","syncedAt","snapshotUntil",revision,"updatedAt")
 VALUES($1,$2,now(),now(),now(),7,now())`, uid, i*4); err != nil {
			t.Fatal(err)
		}
		if _, err := a.server.DB.Exec(context.Background(), `INSERT INTO "SupportRequestUnread"("userId","requestId","unreadCount","eventAt","updatedAt") VALUES($1,$2,$3,now(),now())`, uid, "previous-connection-request", i*4); err != nil {
			t.Fatal(err)
		}
	}
	return a, first.URL, next.URL, webhookSecret, text(user, "id")
}

func putSupportRotation(t *testing.T, a *testAPI, input Object) int {
	t.Helper()
	raw, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest("PUT", a.http.URL+"/api/admin/support-integration", bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+a.token)
	req.Header.Set("Content-Type", "application/json")
	res, err := a.http.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, res.Body)
	return res.StatusCode
}

func TestSupportConnectionSwitchRejectsRetainedWebhookSecretAtomically(t *testing.T) {
	for _, field := range []string{"clientId", "baseUrl"} {
		for _, mode := range []string{"omitted", "same", "padded-same", "null"} {
			t.Run(field+"/"+mode, func(t *testing.T) {
				a, _, next, oldSecret, _ := supportRotationFixture(t)
				input := Object{field: "next-client"}
				if field == "baseUrl" {
					input[field] = next
				}
				switch mode {
				case "same":
					input["webhookSecret"] = oldSecret
				case "padded-same":
					input["webhookSecret"] = " " + oldSecret + " "
				case "null":
					input["webhookSecret"] = nil
				}
				before := readSupportRotationSnapshot(t, a)
				if status := putSupportRotation(t, a, input); status != 400 {
					t.Errorf("更换已有连接而未轮换Webhook Secret必须400，实际%d", status)
				}
				after := readSupportRotationSnapshot(t, a)
				if after != before {
					t.Error("拒绝的配置更新不得改设置整行、未读/请求/事件行、generation或epoch")
				}
			})
		}
	}
}

func TestSupportSameConnectionPreservesWebhookSecretAndUnread(t *testing.T) {
	a, origin, _, oldSecret, _ := supportRotationFixture(t)
	before := readSupportRotationSnapshot(t, a)
	a.call("PUT", "/api/admin/support-integration", Object{"baseUrl": origin + "/", "clientId": "first-client", "clientSecret": newID()}, 200)
	after := readSupportRotationSnapshot(t, a)
	if before.generation != after.generation || before.epoch != after.epoch || before.unread != after.unread {
		t.Fatal("同连接更新不得推进连接代次或清空未读")
	}
	cfg, err := a.server.setting(context.Background(), "achord-connect")
	if err != nil || text(cfg, "webhookSecret") != oldSecret {
		t.Fatal("同连接留空Webhook Secret必须保留", err)
	}
}

func TestSupportConnectionSwitchRotatesSignatureAndClearsPreviousUnread(t *testing.T) {
	a, _, next, oldSecret, uid := supportRotationFixture(t)
	newSecret := newID()
	before := readSupportRotationSnapshot(t, a)
	result := a.call("PUT", "/api/admin/support-integration", Object{"baseUrl": next, "clientId": "next-client", "webhookSecret": newSecret}, 200)
	if result["clientSecret"] != nil || result["webhookSecret"] != nil || result["hasWebhookSecret"] != true {
		t.Fatal("轮换后的配置不应回显密钥")
	}
	after := readSupportRotationSnapshot(t, a)
	if after.generation != before.generation+1 || after.epoch != before.epoch+1 {
		t.Fatal("连接切换必须恰好推进一个generation和epoch")
	}
	var uncleared, requests int
	if err := a.server.DB.QueryRow(context.Background(), `SELECT count(*) FROM "SupportUnreadState" WHERE "unreadCount"<>0 OR "sourceAt" IS NOT NULL OR "snapshotUntil" IS NOT NULL OR "syncedAt" IS NOT NULL OR revision<>8 OR NOT "requestsComplete"`).Scan(&uncleared); err != nil || uncleared != 0 {
		t.Fatal("成功切换必须原子清空旧未读状态并推进revision", err)
	}
	if err := a.server.DB.QueryRow(context.Background(), `SELECT count(*) FROM "SupportRequestUnread"`).Scan(&requests); err != nil || requests != 0 {
		t.Fatal("成功切换必须清理旧连接的逐请求未读", err)
	}
	a.call("PUT", "/api/admin/support-integration", Object{"enabled": true}, 200)
	a.server.resyncWG.Wait()
	event := func() Object {
		return Object{"id": newID(), "type": "request.unread.changed", "createdAt": time.Now().UTC().Truncate(time.Second).Add(2 * time.Second).Format(time.RFC3339Nano),
			"data": Object{"externalUserId": uid, "request": Object{"id": "new-connection-request"}, "unreadCount": 5, "contactUnreadCount": 5}}
	}
	before = readSupportRotationSnapshot(t, a)
	a.sendWebhook(oldSecret, event(), 401)
	if after = readSupportRotationSnapshot(t, a); after != before {
		t.Fatal("旧密钥事件不得改变新连接未读或事件去重记录")
	}
	if result := a.sendWebhook(newSecret, event(), 200); result["result"] != "accepted" {
		t.Fatal("新密钥合法事件没有正常接受")
	}
	var count int
	if err := a.server.DB.QueryRow(context.Background(), `SELECT "unreadCount" FROM "SupportUnreadState" WHERE "userId"=$1`, uid).Scan(&count); err != nil || count != 5 {
		t.Fatal("新连接事件未更新未读", err)
	}
	cfg, err := a.server.setting(context.Background(), "achord-connect")
	if err != nil || text(cfg, "baseUrl") != next || text(cfg, "clientId") != "next-client" || strings.TrimSpace(text(cfg, "webhookSecret")) != newSecret {
		t.Fatal("轮换后的设置未保存正确连接", err)
	}
}
