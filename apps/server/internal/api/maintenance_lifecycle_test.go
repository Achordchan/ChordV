package api

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestMaintenanceHourlyScheduleAndFailureDoesNotRapidRetry(t *testing.T) {
	for _, sample := range []struct {
		now, next string
		minute    int
	}{
		{"2026-11-18T01:16:59Z", "2026-11-18T01:17:00Z", 17},
		{"2026-11-18T01:17:00Z", "2026-11-18T02:17:00Z", 17},
		{"2026-11-18T01:43:01Z", "2026-11-18T02:43:00Z", 43},
	} {
		at, _ := time.Parse(time.RFC3339, sample.now)
		if next := nextMaintenanceTime(at, sample.minute).Format(time.RFC3339); next != sample.next {
			t.Fatal("固定小时调度错误", next, sample.next)
		}
	}
	for _, failure := range []bool{false, true} {
		a := newTestAPI(t)
		started := make(chan struct{})
		a.server.tasks.at(meteringMaintenanceKey, time.Now(), a.server.maintenanceTask(meteringMaintenanceKey, 17, func(context.Context) error {
			close(started)
			if failure {
				return errors.New("explicit-test-maintenance-error")
			}
			return nil
		}))
		select {
		case <-started:
		case <-time.After(3 * time.Second):
			t.Fatal("受控timer未执行")
		}
		a.server.tasks.wg.Wait()
		a.server.tasks.mu.Lock()
		timer, attempts := a.server.tasks.timers[meteringMaintenanceKey], a.server.tasks.failures[meteringMaintenanceKey]
		a.server.tasks.mu.Unlock()
		if timer == nil || attempts != 0 {
			t.Fatal("成功/失败均应排下个固定小时而非2秒短重试", failure, attempts)
		}
		stopTestMaintenance(a.server)
	}
}

func TestMaintenanceCloseCancelsInflightAndRestartRestoresSchedules(t *testing.T) {
	a := newTestAPI(t)
	started, stopped := make(chan struct{}), make(chan struct{})
	a.server.tasks.at(meteringMaintenanceKey, time.Now(), a.server.maintenanceTask(meteringMaintenanceKey, 17, func(ctx context.Context) error {
		close(started)
		<-ctx.Done()
		close(stopped)
		return ctx.Err()
	}))
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("维护未启动")
	}
	closed := make(chan struct{})
	go func() { a.server.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("Close未取消并等待维护结束")
	}
	select {
	case <-stopped:
	default:
		t.Fatal("Close返回时维护仍在执行")
	}
	a.server.tasks.mu.Lock()
	if !a.server.tasks.closed || len(a.server.tasks.timers) != 0 {
		t.Error("Close后仍挂维护timer")
	}
	a.server.tasks.mu.Unlock()
	restarted := New(a.server.DB, a.server.Config)
	defer restarted.Close()
	if err := restarted.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	restarted.tasks.mu.Lock()
	for _, key := range []string{meteringMaintenanceKey, webhookMaintenanceKey} {
		if restarted.tasks.timers[key] == nil {
			t.Error("重启未恢复维护调度", key)
		}
	}
	restarted.tasks.mu.Unlock()
	restarted.Config.UsagePayloadRetentionDays = 106752
	if restarted.reclaimMeteringHistory(context.Background()) == nil {
		t.Fatal("手工非法配置不可运行清理")
	}
	bad := New(a.server.DB, restarted.Config)
	defer bad.Close()
	if bad.Start(context.Background()) == nil {
		t.Fatal("非法配置不可启动worker")
	}
}
