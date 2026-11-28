package api

import (
	"context"
	"testing"
	"time"
)

func TestClientPingVersionReportIsAuthenticatedAndIdempotent(t *testing.T) {
	a := newTestAPI(t)
	path := "/api/client/ping?platform=macos&version=2.0.0-beta.1&build=42&channel=beta"
	a.call("GET", path, nil, 200)
	var first time.Time
	var version, channel string
	var build int
	if err := a.server.DB.QueryRow(context.Background(), `SELECT version,channel,build,"lastSeenAt" FROM "UserClientVersion" WHERE "userId"=$1 AND platform='macos'`, a.adminID).Scan(&version, &channel, &build, &first); err != nil {
		t.Fatal(err)
	}
	if version != "2.0.0-beta.1" || channel != "beta" || build != 42 {
		t.Fatal("版本上报未保存原值")
	}
	a.call("GET", path, nil, 200)
	var second time.Time
	if err := a.server.DB.QueryRow(context.Background(), `SELECT "lastSeenAt" FROM "UserClientVersion" WHERE "userId"=$1 AND platform='macos'`, a.adminID).Scan(&second); err != nil {
		t.Fatal(err)
	}
	if !first.Equal(second) {
		t.Fatal("同版本上报未按10分钟节流")
	}
	a.token = "invalid-token"
	a.call("GET", path, nil, 401)
	a.token = ""
	a.call("GET", path, nil, 200)
	var count int
	if err := a.server.DB.QueryRow(context.Background(), `SELECT count(*) FROM "UserClientVersion" WHERE "userId"=$1`, a.adminID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatal("匿名Ping不应写入版本")
	}
}
