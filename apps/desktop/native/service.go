package main

import (
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Invoke exposes the native operations used by the existing React interface.
func (s *DesktopService) Invoke(ctx context.Context, command string, payload json.RawMessage) (any, error) {
	var p struct {
		Input         json.RawMessage `json:"input"`
		Request       apiRequest      `json:"request"`
		Config        runtimeConfig   `json:"config"`
		ForceTakeover bool            `json:"forceTakeover"`
		Nodes         []nodeSummary   `json:"nodes"`
		Session       json.RawMessage `json:"session"`
		RefreshToken  *string         `json:"refreshToken"`
		StreamID      string          `json:"streamId"`
		URL           string          `json:"url"`
		URLs          []string        `json:"urls"`
		Component     json.RawMessage `json:"component"`
		Kind          string          `json:"kind"`
		Path          string          `json:"path"`
		Summary       shellSummary    `json:"summary"`
		SignedIn      bool            `json:"signedIn"`
		Animate       bool            `json:"animate"`
		Epoch         uint64          `json:"epoch"`
		LaunchURL     string          `json:"launchUrl"`
		SupportOrigin string          `json:"supportOrigin"`
		Manifest      string          `json:"manifest"`
		Signature     string          `json:"signature"`
		PublicKey     string          `json:"publicKey"`
		Prepared      string          `json:"prepared"`
		Label         string          `json:"label"`
	}
	if err := decode(payload, &p); err != nil {
		return nil, fmt.Errorf("原生请求格式无效：%w", err)
	}
	switch command {
	case "api_request":
		return s.apiRequest(ctx, p.Request)
	case "probe_nodes":
		return probeNodes(ctx, p.Nodes)
	case "runtime_status":
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.runtime, nil
	case "runtime_snapshot":
		s.mu.Lock()
		defer s.mu.Unlock()
		return map[string]any{"runtime": s.runtime.Config}, nil
	case "runtime_logs":
		return s.runtimeLogs()
	case "connect_runtime":
		return s.connect(ctx, p.Config, p.ForceTakeover)
	case "disconnect_runtime":
		return s.disconnect()
	case "check_network_conflict":
		return nil, s.checkNetworkConflict(ctx, p.ForceTakeover)
	case "load_session":
		return s.sessions.load(s.sessionPath())
	case "save_session":
		return map[string]bool{"ok": true}, s.sessions.save(s.sessionPath(), p.Session)
	case "clear_session":
		return s.clearSession()
	case "refresh_session_native":
		return s.refreshSession(ctx, p.RefreshToken)
	case "start_client_event_stream":
		return s.startEventStream(p.Input)
	case "stop_client_event_stream":
		s.stopEventStream(p.StreamID)
		return map[string]bool{"ok": true}, nil
	case "nudge_client_presence":
		return nil, s.nudgePresence(ctx)
	case "record_client_diagnostic":
		return nil, s.recordDiagnostic(p.Input)
	case "desktop_runtime_environment":
		return map[string]any{"platform": platformName(), "architecture": architectureName(), "runtimeBinDir": s.binDir()}, nil
	case "desktop_os_label":
		return desktopOSLabel(ctx), nil
	case "check_runtime_component_file":
		var item componentItem
		if err := decode(p.Component, &item); err != nil {
			return nil, err
		}
		return s.checkComponent(item)
	case "get_runtime_component_local_info":
		var kind string
		if err := decode(p.Component, &kind); err != nil {
			return nil, err
		}
		return s.componentLocalInfo(kind)
	case "ensure_bundled_runtime_components":
		return s.ensureComponents()
	case "download_runtime_component":
		return s.downloadComponent(ctx, p.Input)
	case "cancel_runtime_component_download":
		s.cancelDownload()
		return nil, nil
	case "probe_download_candidates":
		for _, address := range p.URLs {
			if err := s.authorizedProbe(address); err != nil {
				return nil, err
			}
		}
		return probeDownloads(ctx, p.URLs)
	case "fetch_remote_text":
		if err := s.validateReleaseTextURL(p.URL); err != nil {
			return nil, err
		}
		return fetchRemoteText(ctx, p.URL)
	case "list_local_file_locations":
		return s.listLocalFiles(), nil
	case "reveal_local_file":
		return nil, s.revealLocalFile(ctx, p.Kind)
	case "download_desktop_installer":
		return s.downloadInstaller(ctx, p.Input)
	case "open_desktop_installer":
		return s.openInstaller(ctx, p.Path)
	case "cancel_desktop_update_install":
		if err := s.abortMacUpdate(); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	case "install_windows_update":
		return s.installWindowsUpdate(ctx)
	case "consume_desktop_update_install_report":
		return s.startupInstallStatus(ctx)
	case "verify_release_manifest_signature":
		return verifyManifestSignature(p.Manifest, p.Signature, p.PublicKey)
	case "authorize_release_manifest":
		return s.authorizeReleaseManifest(ctx, payload)
	case "release_configuration":
		return map[string]any{"repository": s.cfg.ReleaseRepository, "publicKey": s.cfg.ReleasePublicKey, "buildMode": buildMode, "apiBase": s.cfg.APIBase}, nil
	case "test_routing_rule":
		return s.testRoutingRule(ctx, p.Input)
	case "app_ready":
		if err := s.confirmAppReady(ctx, p.Input); err != nil {
			return nil, err
		}
		s.shell.show()
		return map[string]bool{"ok": true}, nil
	case "show_main_window":
		if s.shell != nil {
			s.shell.show()
		}
		return map[string]bool{"ok": true}, nil
	case "hide_main_window":
		if s.shell != nil {
			s.shell.hide()
		}
		return map[string]bool{"ok": true}, nil
	case "transition_main_window":
		if s.shell != nil {
			s.shell.resize(p.SignedIn, p.Animate)
		}
		return nil, nil
	case "update_shell_summary":
		if s.shell != nil {
			s.shell.update(p.Summary)
		}
		return nil, nil
	case "quit_for_update":
		if runtime.GOOS == "darwin" {
			return s.installPreparedMacUpdate(ctx)
		}
		fallthrough
	case "quit_application":
		if err := s.shutdown(); err != nil {
			return nil, err
		}
		if s.shell != nil {
			s.shell.quit()
		}
		return map[string]bool{"ok": true}, nil
	case "open_external_url":
		return map[string]bool{"ok": true}, openExternalURL(ctx, p.URL)
	case "focus_support_window":
		return s.shell.focusSupport(), nil
	case "begin_support_window":
		return s.shell.beginSupport(p.SupportOrigin, p.Epoch)
	case "open_support_window":
		return s.shell.openSupport(p.LaunchURL, p.SupportOrigin, p.Epoch, p.Prepared)
	case "close_support_window":
		s.shell.closeSupport()
		return nil, nil
	case "cancel_support_loading_window":
		s.shell.cancelSupportLoading(p.Epoch, p.Label)
		return nil, nil
	default:
		return nil, fmt.Errorf("未知原生命令：%s", command)
	}
}

func (s *DesktopService) binDir() string      { return filepath.Join(s.cfg.DataDir, "bin") }
func (s *DesktopService) sessionPath() string { return filepath.Join(s.cfg.DataDir, "session.json") }

var errMacRecoveryExitArmed = errors.New("独立恢复助手已确认，等待当前候选退出")

func (s *DesktopService) startup() error {
	if err := os.MkdirAll(s.binDir(), 0700); err != nil {
		return err
	}
	// An application or component transaction must not prevent proxy recovery.
	proxyErr := recoverProxyJournal(s.cfg.DataDir)
	updateErr := recoverMacUpdateOnStartup(s.ctx, s.cfg, s.updateHealth, proxyErr == nil)
	if updateErr != nil {
		return errors.Join(updateErr, proxyErr)
	}
	return errors.Join(proxyErr, s.recoverComponentInstalls())
}
func (s *DesktopService) shutdown() error {
	if _, err := s.disconnect(); err != nil {
		s.publish("chordv://exit-cleanup-failed", err.Error())
		return err
	}
	s.cancelDownload()
	s.streamsMu.Lock()
	for _, handle := range s.streams {
		handle.cancel()
	}
	s.streams = map[string]*eventStreamHandle{}
	s.streamsMu.Unlock()
	s.cancel()
	s.apiTransport.CloseIdleConnections()
	return nil
}
func (s *DesktopService) clearSession() (any, error) {
	if s.shell != nil {
		s.shell.resetSupport()
	}
	if err := s.sessions.clearWith(s.sessionPath(), func() error { _, err := s.disconnect(); return err }); err != nil {
		return nil, err
	}
	s.streamsMu.Lock()
	for _, handle := range s.streams {
		handle.cancel()
	}
	s.streams = map[string]*eventStreamHandle{}
	s.streamsMu.Unlock()
	return map[string]bool{"ok": true}, nil
}

func verifyManifestSignature(manifest, signature, publicKey string) (bool, error) {
	keyBytes, err := base64.StdEncoding.DecodeString(strings.TrimSpace(publicKey))
	if err == nil && len(keyBytes) != ed25519.PublicKeySize {
		if parsed, parseErr := x509.ParsePKIXPublicKey(keyBytes); parseErr == nil {
			if key, ok := parsed.(ed25519.PublicKey); ok {
				keyBytes = key
			}
		}
	}
	if block, _ := pem.Decode([]byte(publicKey)); block != nil {
		parsed, parseErr := x509.ParsePKIXPublicKey(block.Bytes)
		if parseErr != nil {
			return false, errors.New("发布签名公钥格式无效")
		}
		key, ok := parsed.(ed25519.PublicKey)
		if !ok {
			return false, errors.New("发布签名公钥不是 Ed25519")
		}
		keyBytes = key
		err = nil
	}
	if err != nil || len(keyBytes) != ed25519.PublicKeySize {
		return false, errors.New("发布签名公钥格式无效")
	}
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(signature))
	if err != nil {
		return false, errors.New("发布签名格式无效")
	}
	return ed25519.Verify(ed25519.PublicKey(keyBytes), []byte(manifest), sig), nil
}

func desktopOSLabel(ctx context.Context) string {
	if runtime.GOOS == "darwin" {
		if v, err := commandOutput(ctx, "/usr/bin/sw_vers", "-productVersion"); err == nil {
			return "macOS " + v + "（" + architectureName() + "）"
		}
	}
	return runtime.GOOS + "（" + architectureName() + "）"
}

func (s *DesktopService) recordDiagnostic(input json.RawMessage) error {
	var p struct {
		Category string `json:"category"`
		Message  string `json:"message"`
	}
	if err := decode(input, &p); err != nil {
		return err
	}
	if strings.TrimSpace(p.Category) == "" || strings.TrimSpace(p.Message) == "" {
		return nil
	}
	// Never persist tokens, one-time ticket URLs or arbitrary remote response bodies.
	message := p.Message
	if len(message) > 2048 {
		message = message[:2048]
	}
	for _, word := range []string{"Bearer ", "accessToken", "refreshToken", "launchUrl", "ticket="} {
		if strings.Contains(message, word) {
			message = "[凭据内容已移除]"
			break
		}
	}
	path := filepath.Join(s.cfg.DataDir, "diagnostic.log")
	if info, err := os.Stat(path); err == nil && info.Size() > 2<<20 {
		_ = os.Rename(path, path+".1")
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = fmt.Fprintf(f, "%s [%s] %s\n", time.Now().UTC().Format(time.RFC3339), strings.ReplaceAll(p.Category, "\n", " "), strings.ReplaceAll(message, "\n", " "))
	return err
}
