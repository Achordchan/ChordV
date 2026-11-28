package api

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"time"
)

type supportProviderError struct {
	Status int
	Code   string
}

func (supportProviderError) Error() string { return "工单系统返回异常状态" }

type supportAttributeState struct {
	Generation              float64
	Status, Code, CheckedAt string
	RejectedUntil           time.Time
}

func (s *Server) contactAttributeStatus(generation float64) Object {
	s.attributesMu.Lock()
	defer s.attributesMu.Unlock()
	state := s.contactAttributes
	if state.Generation != generation || state.Status == "" {
		return Object{"status": "unknown", "code": nil, "checkedAt": nil}
	}
	return Object{"status": state.Status, "code": nullableString(state.Code), "checkedAt": state.CheckedAt}
}
func (s *Server) noteContactAttributes(generation float64, status, code string) {
	state := supportAttributeState{Generation: generation, Status: status, Code: code, CheckedAt: now()}
	if status == "rejected" {
		state.RejectedUntil = time.Now().Add(10 * time.Minute)
	}
	s.attributesMu.Lock()
	s.contactAttributes = state
	s.attributesMu.Unlock()
}
func (s *Server) createSupportLaunch(ctx context.Context, cfg, user, attributes Object, forceAttributes bool) (Object, error) {
	s.attributesMu.Lock()
	state := s.contactAttributes
	suppressed := state.Generation == number(cfg, "generation") && state.Status == "rejected" && time.Now().Before(state.RejectedUntil)
	s.attributesMu.Unlock()
	profile := Object{"id": user["id"], "name": truncateUnits(text(user, "displayName"), 200), "email": user["email"]}
	if text(profile, "name") == "" {
		profile["name"] = "ChordV 用户"
	}
	send := attributes != nil && (!suppressed || forceAttributes)
	if send {
		profile["attributes"] = attributes
	}
	input := Object{"user": profile, "context": Object{"theme": "system", "locale": "zh-CN", "launchMode": "native"}}
	data, err := s.supportRequest(ctx, cfg, "POST", "/api/v1/integrations/universal/launch-tickets", input)
	if err == nil && send {
		s.noteContactAttributes(number(cfg, "generation"), "accepted", "")
	}
	var provider supportProviderError
	if send && errors.As(err, &provider) && provider.Status == 422 && (provider.Code == "UNDECLARED_PROFILE_ATTRIBUTE" || provider.Code == "INVALID_PROFILE_ATTRIBUTE") {
		s.noteContactAttributes(number(cfg, "generation"), "rejected", provider.Code)
		delete(profile, "attributes")
		return s.supportRequest(ctx, cfg, "POST", "/api/v1/integrations/universal/launch-tickets", input)
	}
	return data, err
}
func (s *Server) supportLaunch(w http.ResponseWriter, r *http.Request, user Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	context := supportContext(input)
	var prepared Object
	preparedOnce := false
	for attempt := 0; attempt < 2; attempt++ {
		cfg, err := s.setting(r.Context(), "achord-connect")
		if err != nil {
			return nil, err
		}
		if !supportEnabled(cfg) {
			return nil, fail(409, "工单系统暂未开放")
		}
		if !preparedOnce {
			prepared, _ = s.supportAttributes(r.Context(), text(user, "id"), context)
			preparedOnce = true
		}
		data, err := s.createSupportLaunch(r.Context(), cfg, user, prepared, false)
		if err != nil {
			var provider supportProviderError
			if errors.As(err, &provider) && provider.Status == 429 {
				return nil, fail(429, "打开工单次数过多，请稍后重试")
			}
			return nil, fail(502, "工单系统暂时无法连接，请稍后重试")
		}
		latest, err := s.setting(r.Context(), "achord-connect")
		if err != nil {
			return nil, err
		}
		if !supportEnabled(latest) {
			return nil, fail(409, "工单系统暂未开放")
		}
		if number(latest, "generation") != number(cfg, "generation") || number(latest, "epoch") != number(cfg, "epoch") {
			continue
		}
		return validatedSupportLaunch(cfg, data)
	}
	return nil, fail(409, "工单接入设置在请求期间发生变化，请重新打开")
}

func validatedSupportLaunch(cfg, data Object) (Object, error) {
	launch, err := url.Parse(text(data, "launchUrl"))
	base, baseErr := url.Parse(text(cfg, "baseUrl"))
	expires, expiryErr := time.Parse(time.RFC3339, text(data, "expiresAt"))
	if err != nil || baseErr != nil || launch.Scheme != base.Scheme || launch.Host != base.Host || launch.User != nil || expiryErr != nil || !expires.After(time.Now()) {
		return nil, fail(502, "工单系统返回的打开地址或有效期无效")
	}
	return Object{"launchUrl": data["launchUrl"], "expiresAt": data["expiresAt"], "supportOrigin": cfg["baseUrl"]}, nil
}
