package api

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

type retentionExecAdapter struct {
	queryer
	after  func(int)
	calls  int
	failAt int
}

func (q *retentionExecAdapter) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	q.calls++
	if q.calls == q.failAt {
		return pgconn.CommandTag{}, errors.New("explicit-test-chunk-error")
	}
	result, err := q.queryer.Exec(ctx, sql, args...)
	if q.after != nil {
		q.after(q.calls)
	}
	return result, err
}

func TestMaintenanceRetentionBoundedChunksCancellationAndErrors(t *testing.T) {
	a := newTestAPI(t)
	before := time.Now().UTC().Add(-30 * 24 * time.Hour)
	seed := func(n int) {
		meteringExec(t, a, `INSERT INTO "AchordConnectWebhookEvent"("eventId",type,"receivedAt") SELECT 'bounded-'||g,'fixture',$1::timestamp-interval '1 second' FROM generate_series(1,$2::integer) g`, before, n)
	}
	remaining := func() int {
		var n int
		if err := a.server.DB.QueryRow(context.Background(), `SELECT count(*) FROM "AchordConnectWebhookEvent"`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	seed(200001)
	q := &retentionExecAdapter{queryer: a.server.DB}
	changed, err := retentionChunks(context.Background(), q, pruneWebhookEventsSQL, before)
	if err != nil || changed != 200000 || q.calls != 40 || remaining() != 1 {
		t.Fatal("每表每轮必须限制5000×40", changed, q.calls, remaining(), err)
	}
	if n, err := retentionChunks(context.Background(), a.server.DB, pruneWebhookEventsSQL, before); err != nil || n != 1 {
		t.Fatal("下一轮未恢复剩余清理", n, err)
	}
	seed(5001)
	ctx, cancel := context.WithCancel(context.Background())
	q = &retentionExecAdapter{queryer: a.server.DB, after: func(int) { cancel() }}
	changed, err = retentionChunks(ctx, q, pruneWebhookEventsSQL, before)
	if !errors.Is(err, context.Canceled) || changed != 5000 || q.calls != 1 || remaining() != 1 {
		t.Fatal("取消必须保留已提交chunk并停止后续", changed, q.calls, remaining(), err)
	}
	meteringExec(t, a, `DELETE FROM "AchordConnectWebhookEvent"`)
	seed(5001)
	q = &retentionExecAdapter{queryer: a.server.DB, failAt: 2}
	changed, err = retentionChunks(context.Background(), q, pruneWebhookEventsSQL, before)
	if err == nil || changed != 5000 || remaining() != 1 {
		t.Fatal("错误必须保留已提交chunk", changed, remaining(), err)
	}
	if n, err := retentionChunks(context.Background(), a.server.DB, pruneWebhookEventsSQL, before); err != nil || n != 1 {
		t.Fatal("失败后重试未恢复", n, err)
	}
}

func TestMaintenanceRetentionSelectivityAndNoUnrelatedSideEffects(t *testing.T) {
	f := newMeteringStateFixture(t)
	a := f.a
	clock := time.Now().UTC().Truncate(time.Millisecond)
	payloadBefore, incidentBefore := clock.Add(-30*24*time.Hour), clock.Add(-90*24*time.Hour)
	for i, row := range []struct {
		created   time.Time
		accounted any
		payload   string
	}{
		{payloadBefore.Add(-time.Second), clock, `{"raw":"old"}`},
		{payloadBefore.Add(-time.Second), nil, `{"raw":"pending"}`},
		{payloadBefore, clock, `{"raw":"boundary"}`},
		{clock, clock, `{"raw":"fresh"}`},
		{payloadBefore.Add(-time.Second), clock, `{}`},
	} {
		meteringExec(t, a, `INSERT INTO "NodeUsageBatch"(id,"nodeId","agentId","bootId",sequence,"payloadHash",payload,"sampledAt","createdAt","accountedAt") SELECT $1,$2,id,'retention', $3,'retained-hash',$4::jsonb,$5,$5,$6 FROM "NodeAgent" WHERE "nodeId"=$2`, newID(), f.nodes["A"]["id"], i+1, row.payload, row.created, row.accounted)
	}
	for _, row := range []struct {
		id, status string
		resolved   any
		updated    time.Time
	}{
		{"old-resolved", "resolved", incidentBefore.Add(-time.Second), clock},
		{"fallback-old", "resolved", nil, incidentBefore.Add(-time.Second)},
		{"open-old", "open", incidentBefore.Add(-time.Second), incidentBefore.Add(-time.Second)},
		{"resolved-recent", "resolved", clock, incidentBefore.Add(-time.Second)},
		{"resolved-boundary", "resolved", incidentBefore, incidentBefore},
	} {
		meteringExec(t, a, `INSERT INTO "MeteringIncident"(id,"subscriptionId","nodeId",reason,status,"openedAt","resolvedAt","createdAt","updatedAt") VALUES($1,$2,$3,'retention',$4,$5,$6,$5,$7)`, row.id, f.sub["id"], f.nodes["A"]["id"], row.status, incidentBefore, row.resolved, row.updated)
	}
	meteringExec(t, a, `INSERT INTO "AchordConnectWebhookEvent"("eventId",type,"receivedAt") VALUES('old','fixture',$1::timestamp-interval '1 second'),('boundary','fixture',$1),('fresh','fixture',$2)`, payloadBefore, clock)
	events, _ := a.eventStream("/api/admin/events/stream", "")
	waitLiveEvent(t, events, func(e liveEvent) bool { return e.data["type"] == "presence_updated" })
	before, sequence := policySchemaDigest(t, a), panelEventSequence(a)
	for _, job := range []struct {
		sql    string
		cutoff time.Time
		count  int64
	}{{redactUsagePayloadsSQL, payloadBefore, 1}, {pruneMeteringIncidentsSQL, incidentBefore, 2}, {pruneWebhookEventsSQL, payloadBefore, 1}} {
		if n, err := retentionChunks(context.Background(), a.server.DB, job.sql, job.cutoff); err != nil || n != job.count {
			t.Fatal("保留条件或截止边界错误", n, job.count, err)
		}
	}
	after := policySchemaDigest(t, a)
	for table, digest := range before {
		if table != "NodeUsageBatch" && table != "MeteringIncident" && table != "AchordConnectWebhookEvent" && !reflect.DeepEqual(digest, after[table]) {
			t.Error("维护改变无关表", table)
		}
	}
	rows, err := list(context.Background(), a.server.DB, `SELECT jsonb_build_object('sequence',sequence,'payload',payload,'hash',"payloadHash",'accounted',"accountedAt" IS NOT NULL) FROM "NodeUsageBatch" ORDER BY sequence`)
	if err != nil || len(rows) != 5 || len(rows[0]["payload"].(map[string]any)) != 0 || len(rows[1]["payload"].(map[string]any)) == 0 || len(rows[2]["payload"].(map[string]any)) == 0 || rows[0]["hash"] != "retained-hash" || rows[0]["accounted"] != true {
		t.Fatal("批次/未入账载荷/哈希/序列/水位必须保留", rows, err)
	}
	panelAssertNoEvents(t, a, events, sequence)
}

func TestMaintenanceRetentionSkipsLockedRowsAndProtectsReopenedIncident(t *testing.T) {
	f := newMeteringStateFixture(t)
	a := f.a
	old := time.Now().UTC().Add(-100 * 24 * time.Hour)
	f.incident(t, "A", "retention", "resolved", old, old)
	meteringExec(t, a, `UPDATE "MeteringIncident" SET "updatedAt"=$1`, old)
	tx, err := a.server.DB.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(context.Background(), `UPDATE "MeteringIncident" SET status='open',"resolvedAt"=NULL`); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if n, err := retentionChunks(ctx, a.server.DB, pruneMeteringIncidentsSQL, time.Now().UTC().Add(-90*24*time.Hour)); err != nil || n != 0 {
		t.Fatal("热行不得等待锁或删除并发重开的open", n, err)
	}
	if err = tx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n, err := retentionChunks(context.Background(), a.server.DB, pruneMeteringIncidentsSQL, time.Now().UTC().Add(-90*24*time.Hour)); err != nil || n != 0 {
		t.Fatal("重开后open必须永久保留", n, err)
	}
	var status string
	if err = a.server.DB.QueryRow(context.Background(), `SELECT status FROM "MeteringIncident"`).Scan(&status); err != nil || status != "open" {
		t.Fatal("open incident丢失", status, err)
	}
}
