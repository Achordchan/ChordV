package main

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

type leaseHeartbeatResult struct {
	Status         string
	LeaseExpiresAt string
	ReasonCode     string
	Message        string
	Terminal       bool
}

func temporaryLeaseFailure() leaseHeartbeatResult {
	return leaseHeartbeatResult{Status: "error", ReasonCode: "heartbeat_failed", Message: "连接会话暂时无法续期"}
}

func (s *DesktopService) leaseHeartbeatOnce(ctx context.Context, sessionID string) leaseHeartbeatResult {
	result := temporaryLeaseFailure()
	stored, err := s.sessions.load(s.sessionPath())
	if err != nil || len(stored) == 0 {
		result.Message = "暂时无法读取登录凭据，请重试连接"
		return result
	}
	var session struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
	}
	if json.Unmarshal(stored, &session) != nil || session.AccessToken == "" {
		result.Message = "暂时无法读取登录凭据，请重试连接"
		return result
	}
	body, _ := json.Marshal(map[string]string{"sessionId": sessionID})
	request := apiRequest{Method: "POST", Path: "/client/session/heartbeat", Headers: map[string]string{"Authorization": "Bearer " + session.AccessToken, "Content-Type": "application/json"}, Body: string(body)}
	response, err := s.apiRequest(ctx, request)
	if err == nil && response.Status == 401 {
		rotated, refreshErr := s.refreshSession(ctx, &session.RefreshToken)
		if refreshErr != nil {
			var rejected *sessionRefreshHTTPError
			if errors.As(refreshErr, &rejected) && (rejected.Status == 401 || rejected.Status == 403) {
				result.Terminal = true
				result.ReasonCode = "auth_invalid"
				result.Message = "登录凭据已失效，请重新登录"
			}
			return result
		}
		if json.Unmarshal(rotated, &session) != nil || session.AccessToken == "" {
			return result
		}
		request.Headers["Authorization"] = "Bearer " + session.AccessToken
		response, err = s.apiRequest(ctx, request)
	}
	if err != nil {
		return result
	}
	if response.Status == 401 {
		result.Terminal, result.ReasonCode, result.Message = true, "auth_invalid", "登录凭据已失效，请重新登录"
		return result
	}
	if response.Status == 403 || response.Status == 404 || response.Status == 409 {
		result.Terminal, result.ReasonCode, result.Message = true, "session_invalid", "连接会话已失效，请重新连接"
		return result
	}
	if response.Status < 200 || response.Status >= 300 {
		return result
	}
	var reply struct {
		SessionID      string `json:"sessionId"`
		Status         string `json:"status"`
		LeaseExpiresAt string `json:"leaseExpiresAt"`
		ReasonCode     string `json:"reasonCode"`
		ReasonMessage  string `json:"reasonMessage"`
	}
	if json.Unmarshal([]byte(response.Body), &reply) != nil || reply.SessionID != sessionID {
		return result
	}
	switch reply.Status {
	case "active":
		expires, parseErr := time.Parse(time.RFC3339Nano, reply.LeaseExpiresAt)
		if parseErr != nil || expires.IsZero() {
			return result
		}
		return leaseHeartbeatResult{Status: "ok", LeaseExpiresAt: reply.LeaseExpiresAt}
	case "expired", "revoked", "evicted":
		result.Terminal = true
		result.ReasonCode, result.Message = reply.ReasonCode, reply.ReasonMessage
		if result.ReasonCode == "" {
			result.ReasonCode = "session_invalid"
		}
		if result.Message == "" {
			result.Message = "连接会话已失效，请重新连接"
		}
	}
	return result
}
