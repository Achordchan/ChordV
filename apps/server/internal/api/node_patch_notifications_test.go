package api

import (
	"context"
	"crypto/md5"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func waitNodePatchCommandNotification(t *testing.T, events <-chan Object) Object {
	t.Helper()
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	for {
		select {
		case event := <-events:
			if event["type"] == "command_ready" {
				return event
			}
		case <-timer.C:
			t.Fatal("等待真实PG命令通知超时")
			return nil
		}
	}
}

func drainNodePatchCommandNotifications(events <-chan Object) []Object {
	ready := []Object{}
	for {
		select {
		case event := <-events:
			if event["type"] == "command_ready" {
				ready = append(ready, event)
			}
		default:
			return ready
		}
	}
}

func TestNodePatchCommandNotificationsIsolateSchemasWithIdenticalNodeIDs(t *testing.T) {
	a, b := newTestAPI(t), newTestAPI(t)
	node, agentToken := a.createNode()
	id := text(node, "id")
	for _, table := range []string{"Node", "NodeAgent"} {
		where := `id=$1`
		if table == "NodeAgent" {
			where = `"nodeId"=$1`
		}
		row, err := one(context.Background(), a.server.DB, `SELECT to_jsonb(r) FROM `+quote(table)+` r WHERE `+where, id)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(row)
		if _, err = b.server.DB.Exec(context.Background(), `INSERT INTO `+quote(table)+` SELECT * FROM jsonb_populate_record(NULL::`+quote(table)+`,$1::jsonb)`, raw); err != nil {
			t.Fatal(err)
		}
	}
	cfg := a.server.Config
	cfg.DataDir = t.TempDir()
	sameSchema := New(a.server.DB, cfg)
	if err := sameSchema.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(sameSchema.Close)
	peerHTTP := httptest.NewServer(sameSchema.Handler())
	t.Cleanup(peerHTTP.Close)
	peerAgent := &testAPI{t: t, server: sameSchema, http: peerHTTP, token: agentToken}
	peerCommands, _ := peerAgent.eventStream("/api/agent/v1/events", "")
	bAgent := &testAPI{t: t, server: b.server, http: b.http, token: agentToken}
	bCommands, _ := bAgent.eventStream("/api/agent/v1/events", "")
	aTarget, closeA := a.server.events.subscribe("agent:" + id)
	defer closeA()
	peerTarget, closePeer := sameSchema.events.subscribe("agent:" + id)
	defer closePeer()
	bTarget, closeB := b.server.events.subscribe("agent:" + id)
	defer closeB()
	markerA, _ := a.createNode()
	markerB, _ := b.createNode()
	aBarrier, closeABarrier := a.server.events.subscribe("agent:" + text(markerA, "id"))
	defer closeABarrier()
	peerBarrier, closePeerBarrier := sameSchema.events.subscribe("agent:" + text(markerA, "id"))
	defer closePeerBarrier()
	bBarrier, closeBBarrier := b.server.events.subscribe("agent:" + text(markerB, "id"))
	defer closeBBarrier()
	command := Object{"type": "RECONCILE_USERS", "payload": Object{"users": []any{}}}
	jobA := a.call("POST", "/api/admin/nodes/"+id+"/agent-commands", command, 200)
	peer := waitNodePatchCommandNotification(t, peerTarget)
	deliveredA := waitLiveEvent(t, peerCommands, func(event liveEvent) bool { return event.data["commandId"] != nil })
	if deliveredA.data["commandId"] != jobA["commandId"] {
		t.Fatal("同schema第二Server的真实Agent SSE未收到已提交命令", deliveredA.data, jobA)
	}
	// These barriers use only PG NOTIFY, not queueCommand's synchronous local
	// publish. Seeing each barrier proves that listener processed prior commits.
	if err := notifyCommands(context.Background(), a.server.DB, text(markerA, "id")); err != nil {
		t.Fatal(err)
	}
	waitNodePatchCommandNotification(t, aBarrier)
	waitNodePatchCommandNotification(t, peerBarrier)
	first := drainNodePatchCommandNotifications(aTarget)
	if len(first) != 2 {
		t.Errorf("A应收到本地发布和真实PG回环各一次: %v", first)
	}
	if err := notifyCommands(context.Background(), b.server.DB, text(markerB, "id")); err != nil {
		t.Fatal(err)
	}
	waitNodePatchCommandNotification(t, bBarrier)
	if leaked := drainNodePatchCommandNotifications(bTarget); len(leaked) != 0 {
		t.Errorf("相同nodeId跨schema污染: source=A target=B node=%s event=%v", id, leaked)
	}
	jobB := b.call("POST", "/api/admin/nodes/"+id+"/agent-commands", command, 200)
	deliveredB := waitLiveEvent(t, bCommands, func(event liveEvent) bool { return event.data["commandId"] != nil })
	if deliveredB.data["commandId"] != jobB["commandId"] {
		t.Fatal("不同schema的真实Agent SSE命令泄漏或未收到本域命令", deliveredB.data, jobB)
	}
	if err := notifyCommands(context.Background(), b.server.DB, text(markerB, "id")); err != nil {
		t.Fatal(err)
	}
	waitNodePatchCommandNotification(t, bBarrier)
	second := drainNodePatchCommandNotifications(bTarget)
	if len(second) != 2 {
		t.Errorf("B应收到本地发布和真实PG回环各一次: %v", second)
	}
	if err := notifyCommands(context.Background(), a.server.DB, text(markerA, "id")); err != nil {
		t.Fatal(err)
	}
	waitNodePatchCommandNotification(t, aBarrier)
	waitNodePatchCommandNotification(t, peerBarrier)
	for _, target := range []struct {
		name   string
		events <-chan Object
	}{{"A", aTarget}, {"A同schema第二实例", peerTarget}} {
		if leaked := drainNodePatchCommandNotifications(target.events); len(leaked) != 0 {
			t.Errorf("相同nodeId跨schema反向污染: source=B target=%s node=%s event=%v", target.name, id, leaked)
		}
	}
	t.Logf("同ID=%s；A→A及同schema第二实例通知=%v/%v；B→B通知=%v；双向跨schema均以真实HTTP命令/PG通知屏障验证", id, first, peer, second)
}

func TestNodePatchNotificationChannelPreservesPublicCompatibilityReadOnly(t *testing.T) {
	a := newTestAPI(t)
	var schema, channel string
	if err := a.server.DB.QueryRow(context.Background(), `SELECT current_schema(),`+commandNotificationChannelSQL).Scan(&schema, &channel); err != nil {
		t.Fatal(err)
	}
	if want := fmt.Sprintf("%s_%x", commandNotificationChannel, md5.Sum([]byte(schema))); channel != want || len(channel) >= 63 {
		t.Fatalf("私有schema频道不稳定或超长: schema=%s channel=%s want=%s", schema, channel, want)
	}
	tx, err := a.server.DB.BeginTx(context.Background(), pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(context.Background(), `SET LOCAL search_path TO public,pg_catalog`); err != nil {
		t.Fatal(err)
	}
	var public string
	if err = tx.QueryRow(context.Background(), `SELECT `+commandNotificationChannelSQL).Scan(&public); err != nil || public != commandNotificationChannel {
		t.Fatal("public必须保留原频道；本测试不向public发通知", public, err)
	}
	t.Logf("私有频道=%s bytes=%d；public只读求值=%s，未执行public NOTIFY", channel, len(channel), public)
}

func TestNodePatchNotificationReconnectRetainsSchemaAndDurableCatchup(t *testing.T) {
	a := newTestAPI(t)
	node, agentToken := a.createNode()
	application := "node_scope_reconnect_" + newID()
	poolConfig := a.server.DB.Config()
	poolConfig.ConnConfig.RuntimeParams["application_name"] = application
	pool, err := pgxpool.NewWithConfig(context.Background(), poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	cfg := a.server.Config
	cfg.DataDir = t.TempDir()
	peer := New(pool, cfg)
	if err = peer.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(peer.Close)
	peerHTTP := httptest.NewServer(peer.Handler())
	t.Cleanup(peerHTTP.Close)
	agent := &testAPI{t: t, server: peer, http: peerHTTP, token: agentToken}
	commands, _ := agent.eventStream("/api/agent/v1/events", "")
	var pid int
	if err = a.server.DB.QueryRow(context.Background(), `SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND datname=current_database() AND query LIKE 'LISTEN %' AND pid<>pg_backend_pid()`, application).Scan(&pid); err != nil {
		t.Fatal("只能定位本测试专属application_name的监听连接", err)
	}
	var terminated bool
	if err = a.server.DB.QueryRow(context.Background(), `SELECT pg_terminate_backend($1)`, pid).Scan(&terminated); err != nil || !terminated {
		t.Fatal("仅关闭本测试专属监听连接失败", pid, err)
	}
	for index := range 2 {
		job := a.call("POST", "/api/admin/nodes/"+text(node, "id")+"/agent-commands", Object{"type": "RECONCILE_USERS", "payload": Object{"users": []any{}}}, 200)
		event := waitLiveEvent(t, commands, func(event liveEvent) bool { return event.data["commandId"] != nil })
		if event.data["commandId"] != job["commandId"] {
			t.Fatal("重连catch-up或随后同schema即时通知未交付已提交命令", index, event.data, job)
		}
	}
	t.Logf("仅终止专属监听backend=%d application_name=%s；断线期间持久命令及重连后新命令均通过真实Agent SSE交付", pid, application)
}
