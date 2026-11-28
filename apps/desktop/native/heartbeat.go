package main

import (
	"context"
	"time"
)

func (s *DesktopService) leaseHeartbeatLoop(ctx context.Context, config runtimeConfig) {
	s.mu.Lock()
	owner := s.runtime.Config
	s.mu.Unlock()
	if owner == nil || owner.SessionID != config.SessionID || ctx.Err() != nil {
		return
	}
	interval := time.Duration(config.LeaseHeartbeatIntervalSeconds) * time.Second
	var failures leaseFailureWindow
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			result := s.leaseHeartbeatOnce(ctx, config.SessionID)
			if !s.completeLeaseHeartbeat(ctx, owner, &failures, result, time.Now()) {
				return
			}
			timer.Reset(interval)
		}
	}
}

func (s *DesktopService) completeLeaseHeartbeat(ctx context.Context, owner *runtimeConfig, failures *leaseFailureWindow, result leaseHeartbeatResult, now time.Time) bool {
	// Checking ownership and stopping share the operation lock, including when
	// an old HTTP response arrives after a new connection reused the session ID.
	s.operationMu.Lock()
	defer s.operationMu.Unlock()
	s.mu.Lock()
	current := s.runtime.Config == owner && s.runtime.Status == "connected" && ctx.Err() == nil
	s.mu.Unlock()
	if !current {
		return false
	}
	if failures.observe(now, time.Duration(owner.LeaseGraceSeconds)*time.Second, result.Status == "ok") && !result.Terminal {
		result.Terminal = true
		result.ReasonCode = "heartbeat_grace_exceeded"
		result.Message = "连接会话持续无法续期，正在停止连接；请检查网络后重新连接"
	}
	s.publish("chordv://native-lease-heartbeat", map[string]any{
		"sessionId": owner.SessionID, "status": result.Status, "terminal": result.Terminal,
		"leaseExpiresAt": nilString(result.LeaseExpiresAt), "reasonCode": nilString(result.ReasonCode), "message": nilString(result.Message),
	})
	if !result.Terminal {
		return true
	}
	if _, err := s.disconnectLocked(); err != nil {
		message := "租约已失效，本机连接清理未完成，请重试断开连接。原因：" + err.Error()
		s.mu.Lock()
		s.runtime.Status, s.runtime.LastError = "error", pointer(message)
		status := s.runtime
		s.mu.Unlock()
		s.publish("chordv://runtime-status", status)
		s.publish("chordv://runtime-interrupted", runtimeInterruption{Cause: "lease-ended", ProxyRestored: false, Message: message})
	}
	return false
}
