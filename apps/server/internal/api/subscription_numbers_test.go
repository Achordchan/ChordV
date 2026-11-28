package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestSubscriptionTrafficNormalizationRejectsNonFiniteValues(t *testing.T) {
	for _, value := range []any{math.NaN(), math.Inf(1), math.Inf(-1), json.Number("bad"), json.Number("1e10000")} {
		if err := normalizeSubscriptionTraffic(Object{"totalTrafficGb": value}); err == nil {
			t.Errorf("不得接受非有限或解析失败数值: %v", value)
		}
	}
	missing := Object{}
	if err := normalizeSubscriptionTraffic(missing); err != nil || len(missing) != 0 {
		t.Fatal("缺省字段应保持缺省", missing, err)
	}
}

func subscriptionWriteDigest(t *testing.T, a *testAPI) Object {
	t.Helper()
	parts := []string{}
	for _, table := range []string{"Subscription", "TrafficLedger", "SystemSetting", "PanelClientBinding", "NodeCommandJob", "NodeSessionLease"} {
		parts = append(parts, `'`+table+`',(SELECT md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb)::text) FROM `+quote(table)+` r)`)
	}
	row, err := one(context.Background(), a.server.DB, `SELECT jsonb_build_object(`+strings.Join(parts, ",")+`)`)
	if err != nil {
		t.Fatal(err)
	}
	return row
}

func subscriptionNumberRequest(t *testing.T, a *testAPI, method, path string, input Object) (int, string) {
	t.Helper()
	raw, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(method, a.http.URL+path, bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+a.token)
	res, err := a.http.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	response, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return res.StatusCode, string(response)
}

func TestSubscriptionNumbersRejectInvalidHTTPWithoutWrites(t *testing.T) {
	a := newTestAPI(t)
	personalPlan, teamPlan := a.createPlan("personal"), a.createPlan("team")
	owner := a.createUser()
	team := a.call("POST", "/api/admin/teams", Object{"name": "数值校验账本", "ownerUserId": owner["id"]}, 200)
	expiry := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	sub := a.call("POST", "/api/admin/teams/"+text(team, "id")+"/subscriptions", Object{"planId": teamPlan["id"], "usedTrafficGb": 2, "expireAt": expiry}, 200)
	addUsageLedger(t, a, Object{"teamId": team["id"], "subscriptionId": sub["id"], "userId": owner["id"], "usedTrafficGb": 2, "usedTrafficBytes": trafficBytes(2), "recordedAt": now()})
	invalid := []struct {
		name  string
		value any
	}{{"text", "bad"}, {"null", nil}, {"negative", -1}, {"nan", "NaN"}, {"infinity", "Infinity"}, {"negative-infinity", "-Infinity"}, {"huge-string-exponent", "1e10000"}, {"huge-json-exponent", json.Number("1e10000")}, {"over-limit", 1000000001}, {"array", []any{1}}, {"object", Object{"value": 1}}, {"go-only-underscores", "1_0"}, {"go-only-hex-float", "0x1p2"}}
	for _, route := range []struct {
		name, field string
	}{
		{"create-personal", "totalTrafficGb"}, {"create-personal", "usedTrafficGb"},
		{"create-team", "totalTrafficGb"}, {"create-team", "usedTrafficGb"},
		{"renew", "totalTrafficGb"}, {"renew-reset", "totalTrafficGb"},
		{"change-plan", "totalTrafficGb"}, {"adjust", "totalTrafficGb"}, {"adjust", "usedTrafficGb"},
	} {
		for _, value := range invalid {
			t.Run(route.name+"/"+route.field+"/"+value.name, func(t *testing.T) {
				fixture := *a
				fixture.t = t
				a := &fixture
				method, path := "POST", "/api/admin/subscriptions/"+text(sub, "id")+"/"+route.name
				input := Object{route.field: value.value}
				switch route.name {
				case "create-personal":
					user := a.createUser()
					path = "/api/admin/subscriptions"
					input["userId"], input["planId"], input["expireAt"] = user["id"], personalPlan["id"], expiry
				case "create-team":
					user := a.createUser()
					newTeam := a.call("POST", "/api/admin/teams", Object{"name": "创建数值校验", "ownerUserId": user["id"]}, 200)
					path = "/api/admin/teams/" + text(newTeam, "id") + "/subscriptions"
					input["planId"], input["expireAt"] = teamPlan["id"], expiry
				case "renew-reset":
					path = "/api/admin/subscriptions/" + text(sub, "id") + "/renew"
					input["resetTraffic"] = true
				case "change-plan":
					input["planId"] = teamPlan["id"]
				case "adjust":
					method, path = "PATCH", "/api/admin/subscriptions/"+text(sub, "id")
				}
				before := subscriptionWriteDigest(t, a)
				status, response := subscriptionNumberRequest(t, a, method, path, input)
				after := subscriptionWriteDigest(t, a)
				t.Logf("status=%d before=%v after=%v", status, before, after)
				if status != 400 || !reflect.DeepEqual(before, after) {
					t.Errorf("非法数字必须400且订阅/账本/设置/绑定/命令/租约均不变，status=%d response=%s", status, response)
				}
			})
		}
	}
}

func TestSubscriptionNumbersNormalizeLegacyValuesHTTP(t *testing.T) {
	a := newTestAPI(t)
	plan := a.createPlan("personal")
	user := a.createUser()
	expiry := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	sub := a.call("POST", "/api/admin/subscriptions", Object{"userId": user["id"], "planId": plan["id"], "expireAt": expiry}, 200)
	path := "/api/admin/subscriptions/" + text(sub, "id")
	for _, value := range []struct {
		name  string
		input any
		want  float64
	}{{"json-number", 12.5, 12.5}, {"decimal", "12.5", 12.5}, {"scientific", " 1.25e1 ", 12.5}, {"empty", "", 0}, {"whitespace", "  ", 0}, {"hex", "0x10", 16}, {"binary", "0b10", 2}, {"octal", "0o10", 8}, {"boolean-true", true, 1}, {"boolean-false", false, 0}, {"maximum", "1e9", 1e9}} {
		t.Run(value.name, func(t *testing.T) {
			fixture := *a
			fixture.t = t
			a := &fixture
			a.call("PATCH", path, Object{"totalTrafficGb": value.input, "usedTrafficGb": value.input}, 200)
			after := subscriptionCounters(t, a, text(sub, "id"))
			if after["total"] != value.want || after["used"] != value.want || after["bytes"] != trafficBytes(value.want) {
				t.Fatal("未保留旧Type(Number)的合法转换", after)
			}
		})
	}
	a.call("POST", path+"/renew", Object{"totalTrafficGb": "12", "usedTrafficGb": "bad", "state": "bad"}, 200)
	a.call("POST", path+"/change-plan", Object{"planId": plan["id"], "totalTrafficGb": "14", "usedTrafficGb": nil, "state": "bad"}, 200)
	after := subscriptionCounters(t, a, text(sub, "id"))
	if after["total"] != float64(14) || after["used"] != float64(1e9) {
		t.Fatal("续期/换套餐允许数字字符串，额外非法校正字段仍应忽略", after)
	}
	a.call("POST", path+"/renew", Object{"totalTrafficGb": "16", "resetTraffic": true}, 200)
	after = subscriptionCounters(t, a, text(sub, "id"))
	if after["total"] != float64(16) || after["used"] != float64(0) || after["remaining"] != float64(16) {
		t.Fatal("清零续期的字符串额度未在重置前归一", after)
	}
	createdUser := a.createUser()
	created := a.call("POST", "/api/admin/subscriptions", Object{"userId": createdUser["id"], "planId": plan["id"], "expireAt": expiry, "totalTrafficGb": "12.5", "usedTrafficGb": "2.5"}, 200)
	if created["totalTrafficGb"] != float64(12.5) || created["usedTrafficGb"] != float64(2.5) {
		t.Fatal("创建订阅未归一合法字符串", created)
	}
}

func TestStandaloneResetIgnoresNonDTOFieldsHTTP(t *testing.T) {
	a := newTestAPI(t)
	user, plan := a.createUser(), a.createPlan("personal")
	expiry := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	sub := a.call("POST", "/api/admin/subscriptions", Object{"userId": user["id"], "planId": plan["id"], "expireAt": expiry, "usedTrafficGb": 2}, 200)
	for _, extra := range []any{"bad", nil} {
		a.call("POST", "/api/admin/subscriptions/"+text(sub, "id")+"/reset-traffic", Object{"totalTrafficGb": extra, "usedTrafficGb": extra, "expireAt": "bad"}, 200)
		after := subscriptionCounters(t, a, text(sub, "id"))
		if after["total"] != float64(10) || after["used"] != float64(0) || after["expireAt"] != expiry {
			t.Fatal("独立重置只能读取其DTO的userId，额外字段应忽略", after)
		}
	}
}
