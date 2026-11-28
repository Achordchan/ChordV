package api

import (
	"context"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"github.com/Achordchan/ChordV/apps/server/internal/config"
)

func TestLeasePolicyHardDeadlineHalfOpenAndSQLCountAgree(t *testing.T) {
	timing, err := (config.Config{}).SessionLeaseTiming()
	if err != nil {
		t.Fatal(err)
	}
	expires := time.Date(2026, 11, 18, 0, 0, 0, 0, time.UTC)
	deadline := leaseHardDeadline(expires, timing)
	for _, sample := range []struct {
		at   time.Time
		want bool
	}{{deadline.Add(-time.Millisecond), true}, {deadline, false}, {deadline.Add(time.Millisecond), false}} {
		if got := leaseValidAt(expires, sample.at, timing); got != sample.want {
			t.Fatal("hard deadline必须半开，不能复制旧边界相反比较符", sample.at, got)
		}
	}
	f := newLeasePolicyFixture(t, false, 1)
	row := f.seed(t, "boundary", 0, expires.Add(-time.Hour), expires.Add(-time.Hour), expires)
	for _, sample := range []struct {
		at   time.Time
		want bool
	}{{deadline.Add(-time.Millisecond), true}, {deadline, false}, {deadline.Add(time.Millisecond), false}} {
		cutoff, err := f.a.server.leaseCutoff(sample.at)
		if err != nil {
			t.Fatal(err)
		}
		var live bool
		if err = f.a.server.DB.QueryRow(context.Background(), `SELECT status='active' AND "expiresAt">$2 FROM "NodeSessionLease" WHERE id=$1`, row["id"], cutoff).Scan(&live); err != nil || live != sample.want {
			t.Fatal("SQL计数与同一硬截止定义不一致", live, sample.want, err)
		}
	}
}

func TestLeasePolicyRestartSchedulesHardDeadlineAndWorkerIsIdempotent(t *testing.T) {
	f := newLeasePolicyFixture(t, false, 1)
	f.a.server.Close()
	expiry := time.Now().UTC().Add(-299 * time.Second)
	lease := f.seed(t, "restart", 0, expiry.Add(-time.Hour), expiry.Add(-time.Hour), expiry)
	restarted := New(f.a.server.DB, f.a.server.Config)
	defer restarted.Close()
	ch, unsubscribe := restarted.events.subscribe(text(f.user, "id"))
	defer unsubscribe()
	if err := restarted.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	row := f.row(t, text(lease, "id"))
	if row["status"] != "active" {
		t.Fatal("重启不能在soft expiry抢先失效")
	}
	select {
	case event := <-ch:
		if event["type"] != "session_revoked" || event["reasonCode"] != "session_expired" {
			t.Fatal("恢复deadline事件错误", event)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("重启未恢复硬截止计时器")
	}
	row = f.row(t, text(lease, "id"))
	if row["status"] != "expired" || row["revokedReason"] != "session_expired" || row["revokedAt"] == nil || f.auditCount(t) != 1 {
		t.Fatal("硬截止任务未原子落终态和审计", row)
	}
	before := policySchemaDigest(t, f.a)
	if err := restarted.expireLease(context.Background(), text(lease, "id")); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, policySchemaDigest(t, f.a)) {
		t.Fatal("重复worker不得重新写终态或审计")
	}
	select {
	case event := <-ch:
		t.Fatal("重复worker不得重复撤销事件", event)
	default:
	}
}

func TestLeasePolicyCustomConfigUsedByNewConnectionAndPresenceHTTP(t *testing.T) {
	f := newLeasePolicyFixture(t, false, 1)
	f.a.server.Close()
	cfg := f.a.server.Config
	cfg.SessionLeaseTTLSeconds = 10
	cfg.SessionHeartbeatIntervalSeconds = 5
	cfg.SessionGraceSeconds = 30
	s := New(f.a.server.DB, cfg)
	defer s.Close()
	if err := s.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	stopTestMaintenance(s)
	h := httptest.NewServer(s.Handler())
	defer h.Close()
	client := &testAPI{t: t, server: s, http: h, token: f.userToken}
	at := time.Now().UTC()
	runtime := client.call("POST", "/api/client/session/connect", Object{"nodeId": f.nodes[0]["id"], "mode": "rule"}, 200)
	expires, err := parseTimestamp(text(runtime, "leaseExpiresAt"))
	if err != nil {
		t.Fatal(err)
	}
	if runtime["leaseHeartbeatIntervalSeconds"] != float64(5) || runtime["leaseGraceSeconds"] != float64(30) || expires.Sub(at) < 9*time.Second || expires.Sub(at) > 12*time.Second {
		t.Fatal("新连接未用启动时自定义策略", runtime)
	}
	meteringExec(t, f.a, `UPDATE "NodeSessionLease" SET "expiresAt"=$2 WHERE id=$1`, runtime["leaseId"], time.Now().UTC().Add(-10*time.Second))
	client.call("GET", "/api/client/ping", nil, 200)
	client.token = f.a.token
	presence := client.call("GET", "/api/admin/presence", nil, 200)
	if presence["connectedWindowSeconds"] != float64(40) || presence["onlineWindowSeconds"] != float64(150) || presence["counts"].(map[string]any)["connected"] != float64(1) {
		t.Fatal("活跃计数必须含宽限，独立用户在线150秒不可被租约TTL覆盖", presence)
	}
}
