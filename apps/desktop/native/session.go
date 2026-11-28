package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"sync"
)

type sessionStore struct {
	mu        sync.Mutex
	epoch     uint64
	retired   map[string]bool
	refreshMu sync.Mutex
	hidden    bool
}

type sessionRefreshHTTPError struct{ Status int }

func (e *sessionRefreshHTTPError) Error() string { return "登录状态刷新失败，请重新登录" }

func tokenIdentity(data json.RawMessage) string {
	var p struct {
		RefreshToken string `json:"refreshToken"`
	}
	_ = json.Unmarshal(data, &p)
	h := sha256.Sum256([]byte(p.RefreshToken))
	return hex.EncodeToString(h[:])
}
func validateSession(data json.RawMessage) error {
	var p struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
		User         struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	if json.Unmarshal(data, &p) != nil || p.AccessToken == "" || p.RefreshToken == "" || p.User.ID == "" {
		return errors.New("登录凭据格式无效")
	}
	return nil
}
func (ss *sessionStore) load(path string) (json.RawMessage, error) {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	if ss.hidden {
		return nil, nil
	}
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := validateSession(data); err != nil {
		return nil, err
	}
	return data, nil
}
func (ss *sessionStore) save(path string, data json.RawMessage) error {
	if err := validateSession(data); err != nil {
		return err
	}
	ss.mu.Lock()
	defer ss.mu.Unlock()
	if ss.retired[tokenIdentity(data)] {
		return errors.New("登录凭据已经更新，忽略过期会话")
	}
	if err := atomicFile(path, data, 0600); err != nil {
		return err
	}
	ss.hidden = false
	return nil
}
func (ss *sessionStore) clear(path string) error {
	return ss.clearWith(path, func() error { return nil })
}
func (ss *sessionStore) clearWith(path string, cleanup func() error) error {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	ss.hidden = true
	ss.epoch++
	if ss.retired == nil {
		ss.retired = map[string]bool{}
	}
	if data, err := os.ReadFile(path); err == nil {
		ss.retired[tokenIdentity(data)] = true
	}
	if err := cleanup(); err != nil {
		return err
	}
	err := os.Remove(path)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}
func (s *DesktopService) refreshSession(ctx context.Context, requested *string) (json.RawMessage, error) {
	s.sessions.refreshMu.Lock()
	defer s.sessions.refreshMu.Unlock()
	s.sessions.mu.Lock()
	if s.sessions.hidden {
		s.sessions.mu.Unlock()
		return nil, errors.New("登录状态已失效，请重新登录")
	}
	before, err := os.ReadFile(s.sessionPath())
	epoch := s.sessions.epoch
	s.sessions.mu.Unlock()
	if err != nil {
		return nil, errors.New("登录状态已失效，请重新登录")
	}
	var previous struct {
		RefreshToken string `json:"refreshToken"`
	}
	if err := json.Unmarshal(before, &previous); err != nil {
		return nil, err
	}
	if requested != nil && *requested != "" && *requested != previous.RefreshToken {
		return nil, errors.New("登录状态已变化，忽略过期刷新")
	}
	body, _ := json.Marshal(map[string]string{"refreshToken": previous.RefreshToken})
	result, err := s.apiRequest(ctx, apiRequest{Method: "POST", Path: "/auth/refresh", Headers: map[string]string{"Content-Type": "application/json"}, Body: string(body)})
	if err != nil {
		return nil, err
	}
	if result.Status < 200 || result.Status >= 300 {
		return nil, &sessionRefreshHTTPError{Status: result.Status}
	}
	data := json.RawMessage(result.Body)
	if err := validateSession(data); err != nil {
		return nil, err
	}
	s.sessions.mu.Lock()
	defer s.sessions.mu.Unlock()
	current, err := os.ReadFile(s.sessionPath())
	if err != nil || s.sessions.epoch != epoch || tokenIdentity(current) != tokenIdentity(before) {
		return nil, errors.New("登录状态已变化，忽略过期刷新")
	}
	if err := atomicFile(s.sessionPath(), data, 0600); err != nil {
		return nil, err
	}
	if tokenIdentity(before) != tokenIdentity(data) {
		s.sessions.retired[tokenIdentity(before)] = true
	}
	s.sessions.epoch++
	var event map[string]any
	_ = json.Unmarshal(data, &event)
	event["previousRefreshToken"] = previous.RefreshToken
	s.publish("chordv://native-session-refreshed", event)
	return data, nil
}
