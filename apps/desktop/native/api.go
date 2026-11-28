package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

type apiRequest struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}
type apiResponse struct {
	Status    int    `json:"status"`
	Body      string `json:"body"`
	ElapsedMs int64  `json:"elapsedMs"`
}

func (s *DesktopService) apiURL(path string) (string, error) {
	u, err := url.Parse(path)
	if err != nil || u.IsAbs() || u.Host != "" || !strings.HasPrefix(path, "/") || strings.Contains(u.Path, "..") || strings.Contains(path, "\\") {
		return "", errors.New("API 路径无效")
	}
	if !strings.HasPrefix(path, "/api/") {
		path = "/api" + path
	}
	return s.cfg.APIBase + path, nil
}
func (s *DesktopService) apiRequest(ctx context.Context, input apiRequest) (apiResponse, error) {
	endpoint, err := s.apiURL(input.Path)
	if err != nil {
		return apiResponse{}, err
	}
	method := strings.ToUpper(strings.TrimSpace(input.Method))
	if method == "" {
		method = "GET"
	}
	switch method {
	case "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD":
	default:
		return apiResponse{}, errors.New("HTTP 方法无效")
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint, strings.NewReader(input.Body))
	if err != nil {
		return apiResponse{}, err
	}
	for key, value := range input.Headers {
		if strings.EqualFold(key, "Host") || strings.EqualFold(key, "Connection") || strings.EqualFold(key, "Content-Length") {
			continue
		}
		request.Header.Set(key, value)
	}
	started := time.Now()
	response, err := s.apiHTTPClient(30 * time.Second).Do(request)
	if err != nil {
		return apiResponse{}, errors.New("连接本地 API 失败，请确认 Go 服务已启动")
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 16<<20+1))
	if err != nil {
		return apiResponse{}, err
	}
	if len(body) > 16<<20 {
		return apiResponse{}, errors.New("API 响应超过限制")
	}
	return apiResponse{Status: response.StatusCode, Body: string(body), ElapsedMs: time.Since(started).Milliseconds()}, nil
}

type eventStreamInput struct {
	StreamID    string  `json:"streamId"`
	AccessToken string  `json:"accessToken"`
	LastEventID *string `json:"lastEventId"`
}
type eventStreamHandle struct{ cancel context.CancelFunc }

func (s *DesktopService) startEventStream(raw json.RawMessage) (any, error) {
	var input eventStreamInput
	if err := decode(raw, &input); err != nil {
		return nil, err
	}
	if strings.TrimSpace(input.StreamID) == "" || input.AccessToken == "" {
		return nil, errors.New("事件流参数不完整")
	}
	s.streamsMu.Lock()
	defer s.streamsMu.Unlock()
	if _, exists := s.streams[input.StreamID]; exists {
		return nil, errors.New("事件流已经存在")
	}
	ctx, cancel := context.WithCancel(s.ctx)
	handle := &eventStreamHandle{cancel: cancel}
	s.streams[input.StreamID] = handle
	go s.runEventStream(ctx, input, handle)
	return map[string]string{"streamId": input.StreamID}, nil
}
func (s *DesktopService) stopEventStream(id string) {
	s.streamsMu.Lock()
	defer s.streamsMu.Unlock()
	if handle, exists := s.streams[id]; exists {
		handle.cancel()
		delete(s.streams, id)
	}
}
func (s *DesktopService) runEventStream(ctx context.Context, input eventStreamInput, handle *eventStreamHandle) {
	defer func() {
		s.streamsMu.Lock()
		if s.streams[input.StreamID] == handle {
			delete(s.streams, input.StreamID)
		}
		s.streamsMu.Unlock()
	}()
	fail := func(message string, status any) {
		if ctx.Err() == nil {
			s.publish("chordv://client-runtime-event-error", map[string]any{"streamId": input.StreamID, "message": message, "status": status, "authError": status == 401 || status == 403})
		}
	}
	endpoint, _ := s.apiURL("/client/events/stream?presence=ping")
	request, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		fail("事件流地址无效", nil)
		return
	}
	request.Header.Set("Authorization", "Bearer "+input.AccessToken)
	request.Header.Set("Accept", "text/event-stream")
	request.Header.Set("Cache-Control", "no-cache")
	if input.LastEventID != nil {
		request.Header.Set("Last-Event-ID", *input.LastEventID)
	}
	response, err := s.apiHTTPClient(0).Do(request)
	if err != nil {
		fail("本地事件流连接失败", nil)
		return
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		fail("事件流连接被拒绝", response.StatusCode)
		return
	}
	if !strings.Contains(response.Header.Get("Content-Type"), "text/event-stream") {
		fail("服务器未返回事件流", response.StatusCode)
		return
	}
	s.publish("chordv://client-runtime-event-open", map[string]string{"streamId": input.StreamID})
	idle := time.AfterFunc(75*time.Second, func() { response.Body.Close() })
	defer idle.Stop()
	presenceCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go s.presenceLoop(presenceCtx, input.AccessToken)
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 4096), 2<<20)
	var data bytes.Buffer
	var eventID string
	flush := func() {
		if data.Len() > 0 {
			var event any
			if json.Unmarshal(bytes.TrimSpace(data.Bytes()), &event) == nil {
				s.publish("chordv://client-runtime-event", map[string]any{"streamId": input.StreamID, "eventId": nilString(eventID), "event": event})
			}
		}
		data.Reset()
		eventID = ""
	}
	for scanner.Scan() {
		idle.Reset(75 * time.Second)
		line := scanner.Text()
		if line == "" {
			flush()
			continue
		}
		if strings.HasPrefix(line, "data:") {
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
		if strings.HasPrefix(line, "id:") {
			eventID = strings.TrimSpace(strings.TrimPrefix(line, "id:"))
		}
	}
	if ctx.Err() == nil {
		fail("事件流已断开，请重新连接", nil)
	}
}
func (s *DesktopService) presenceLoop(ctx context.Context, token string) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_ = s.sendPresence(ctx, token)
		}
	}
}
func (s *DesktopService) sendPresence(ctx context.Context, token string) error {
	response, err := s.apiRequest(ctx, apiRequest{Method: http.MethodGet, Path: "/client/ping", Headers: map[string]string{"Authorization": "Bearer " + token}})
	if err != nil {
		return err
	}
	if response.Status < 200 || response.Status >= 300 {
		return fmt.Errorf("在线状态上报失败（HTTP %d）", response.Status)
	}
	return nil
}
func (s *DesktopService) nudgePresence(ctx context.Context) error {
	s.mu.Lock()
	if time.Since(s.lastNudge) < 20*time.Second {
		s.mu.Unlock()
		return nil
	}
	s.lastNudge = time.Now()
	s.mu.Unlock()
	stored, err := s.sessions.load(s.sessionPath())
	if err != nil || len(stored) == 0 {
		return err
	}
	var session struct {
		AccessToken string `json:"accessToken"`
	}
	if err = json.Unmarshal(stored, &session); err != nil {
		return err
	}
	return s.sendPresence(ctx, session.AccessToken)
}

func fetchRemoteText(ctx context.Context, address string) (any, error) {
	if err := validateDownloadURL(address); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, "GET", address, nil)
	if err != nil {
		return nil, err
	}
	client := downloadHTTPClient(30 * time.Second)
	defer client.CloseIdleConnections()
	response, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return map[string]any{"url": address, "status": response.StatusCode, "body": ""}, nil
	}
	limit := int64(1 << 20)
	if req.URL.Hostname() == "api.github.com" {
		limit = 8 << 20 // Release history contains many descriptions rather than one signed manifest.
	} else if strings.HasSuffix(req.URL.Path, ".sig") {
		limit = 1024
	}
	if response.ContentLength > limit {
		return nil, errors.New("远程文本过大")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		return nil, errors.New("远程文本过大")
	}
	if !utf8.Valid(body) {
		return nil, errors.New("发布内容不是有效的 UTF-8 文本")
	}
	return map[string]any{"url": address, "status": response.StatusCode, "body": string(body), "link": strings.Join(response.Header.Values("Link"), ", ")}, nil
}
