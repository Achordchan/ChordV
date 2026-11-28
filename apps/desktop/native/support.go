package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"time"

	"github.com/egoist/mygo"
)

const supportBridgePreload = `(() => {
  if (window.AchordConnectNative) return;
  Object.defineProperty(window, 'AchordConnectNative', { value: Object.freeze({
    postMessage(message) {
      if (typeof message !== 'string' || message.length > 4096) return;
      location.href = 'chordv-support-message://bridge?message=' + encodeURIComponent(message);
    }
  }), configurable: false, writable: false });
})();`

func validateSupportOrigin(value string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(value))
	if err != nil || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("工单站点地址无效")
	}
	ip := net.ParseIP(u.Hostname())
	local := u.Scheme == "http" && ip != nil && ip.IsLoopback()
	if u.Scheme != "https" && !local {
		return nil, errors.New("工单站点必须使用 HTTPS")
	}
	return u, nil
}
func supportOrigin(value *url.URL) string { return value.Scheme + "://" + value.Host }

func (s *desktopShell) focusSupport() any {
	s.mu.Lock()
	window, ready, epoch := s.support, s.supportReady, s.supportEpoch
	s.mu.Unlock()
	focused := window != nil && !window.IsDestroyed() && ready
	if focused {
		window.Show()
		window.Focus()
	}
	return map[string]any{"focused": focused, "epoch": epoch}
}

func (s *desktopShell) beginSupport(origin string, epoch uint64) (string, error) {
	u, err := validateSupportOrigin(origin)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	if epoch != s.supportEpoch {
		s.mu.Unlock()
		return "", errors.New("登录状态已变化，请重新打开工单")
	}
	existing := s.support
	s.mu.Unlock()
	if existing != nil && !existing.IsDestroyed() {
		existing.Close()
	}
	label := fmt.Sprintf("support-%d-%d", epoch, time.Now().UnixNano())
	window := mygo.NewWindow(mygo.WindowOptions{Title: "ChordV 工单", URL: "/support-loading.html", Width: 900, Height: 680, MinWidth: 720, MinHeight: 560, Page: mygo.PageOptions{Untrusted: true, PreloadScript: supportBridgePreload}})
	s.mu.Lock()
	s.support = window
	s.supportLabel = label
	s.supportOrigin = supportOrigin(u)
	s.supportReady = false
	s.mu.Unlock()
	window.OnClosed(func() {
		s.mu.Lock()
		if s.support == window {
			s.support = nil
			s.supportReady = false
		}
		s.mu.Unlock()
		s.service.publish("chordv://support-bridge-ended", map[string]any{"epoch": epoch, "window": label})
	})
	window.Page().OnWillNavigate(func(event *mygo.NavigateEvent) {
		u, err := url.Parse(event.URL)
		if err != nil {
			event.PreventDefault()
			return
		}
		if u.Scheme == "chordv-support-message" {
			event.PreventDefault()
			s.handleSupportMessage(window, label, epoch, u.Query().Get("message"))
			return
		}
		if u.Path == "/support-loading.html" && (u.Scheme == "mygo" || u.Hostname() == "mygo.localhost" || u.Hostname() == "127.0.0.1") {
			return
		}
		s.mu.Lock()
		allowed := s.supportOrigin
		s.mu.Unlock()
		if supportOrigin(u) == allowed && u.User == nil {
			return
		}
		if u.Scheme == "about" && (u.Path == "blank" || u.Path == "srcdoc") {
			return
		}
		event.PreventDefault()
		if (u.Scheme == "https" || u.Scheme == "http") && event.UserInitiated {
			go openExternalURL(context.Background(), event.URL)
		}
	})
	window.Page().SetWindowOpenHandler(func(request mygo.WindowOpenRequest) *mygo.WindowOptions {
		if request.UserInitiated {
			go openExternalURL(context.Background(), request.URL)
		}
		return nil
	})
	return label, nil
}

func (s *desktopShell) openSupport(launch, origin string, epoch uint64, prepared string) (any, error) {
	u, err := validateSupportOrigin(origin)
	if err != nil {
		return nil, err
	}
	target, err := url.Parse(launch)
	if err != nil || target.User != nil || supportOrigin(target) != supportOrigin(u) {
		return nil, errors.New("工单打开地址与站点不一致")
	}
	s.mu.Lock()
	window := s.support
	label := s.supportLabel
	current := s.supportEpoch
	s.mu.Unlock()
	if epoch != current {
		return nil, errors.New("登录状态已变化，请重新打开工单")
	}
	if prepared != "" && (prepared != label || window == nil || window.IsDestroyed()) {
		return nil, errors.New("support_window_closed")
	}
	if window == nil || window.IsDestroyed() {
		if _, err = s.beginSupport(origin, epoch); err != nil {
			return nil, err
		}
		s.mu.Lock()
		window = s.support
		s.mu.Unlock()
	}
	s.mu.Lock()
	s.supportOrigin = supportOrigin(u)
	s.mu.Unlock()
	if err = window.Page().LoadURL(launch); err != nil {
		return nil, errors.New("工单页面打开失败")
	}
	window.Show()
	window.Focus()
	return map[string]bool{"ok": true}, nil
}
func (s *desktopShell) closeSupport() {
	s.mu.Lock()
	window := s.support
	s.support = nil
	s.supportReady = false
	s.mu.Unlock()
	if window != nil && !window.IsDestroyed() {
		window.Close()
	}
}
func (s *desktopShell) resetSupport() { s.mu.Lock(); s.supportEpoch++; s.mu.Unlock(); s.closeSupport() }

func (s *desktopShell) cancelSupportLoading(epoch uint64, label string) {
	s.mu.Lock()
	window := s.support
	valid := s.supportEpoch == epoch && s.supportLabel == label && !s.supportReady
	s.mu.Unlock()
	if valid && window != nil && !window.IsDestroyed() {
		window.Close()
	}
}

func (s *desktopShell) handleSupportMessage(window *mygo.Window, label string, epoch uint64, raw string) {
	if len(raw) > 4096 {
		return
	}
	s.mu.Lock()
	valid := s.support == window && s.supportEpoch == epoch
	origin := s.supportOrigin
	s.mu.Unlock()
	if !valid {
		return
	}
	current, err := url.Parse(window.Page().URL())
	if err != nil || supportOrigin(current) != origin {
		return
	}
	var message struct {
		Source      string `json:"source"`
		Type        string `json:"type"`
		UnreadCount *int   `json:"unreadCount"`
	}
	if json.Unmarshal([]byte(raw), &message) != nil || message.Source != "achord-connect-v1" {
		return
	}
	switch message.Type {
	case "ready":
		s.mu.Lock()
		s.supportReady = true
		s.mu.Unlock()
	case "unread-changed":
		if message.UnreadCount != nil && *message.UnreadCount >= 0 && *message.UnreadCount <= 99999 {
			s.service.publish("chordv://support-unread", map[string]any{"unreadCount": *message.UnreadCount, "epoch": epoch, "window": label})
		}
	case "session-expired":
		s.mu.Lock()
		s.supportReady = false
		s.mu.Unlock()
		s.service.publish("chordv://support-bridge-ended", map[string]any{"epoch": epoch, "window": label})
	case "close-requested":
		window.Close()
	}
}
