package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestInstallReportRequiresTypedResultBeforeConsumption(t *testing.T) {
	s := testService(t, "http://127.0.0.1:1")
	path := filepath.Join(s.cfg.DataDir, "updater", "install-report.json")
	for _, raw := range []string{`null`, `[]`, `{}`, `{"ok":"false","platform":"macos","mode":"installer"}`, `{"ok":false,"platform":"macos","mode":"installer","summary":123}`, `{"ok":true,"mode":"installer"}`, `{"ok":true,"platform":"windows","mode":""}`} {
		if err := atomicFile(path, []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
		if report, err := s.consumeInstallReport(); err == nil || report != nil {
			t.Fatalf("invalid report consumed: %s", raw)
		}
		if kept, err := os.ReadFile(path); err != nil || string(kept) != raw {
			t.Fatal("invalid report not retained", err)
		}
	}
	for _, ok := range []bool{false, true} {
		if err := atomicJSON(path, map[string]any{"ok": ok, "platform": "macos", "mode": "automatic_bundle_swap", "summary": nil, "candidatePid": 123}); err != nil {
			t.Fatal(err)
		}
		report, err := s.consumeInstallReport()
		if err != nil {
			t.Fatal(err)
		}
		fields := report.(map[string]any)
		if fields["ok"] != ok || fields["candidatePid"] != float64(123) {
			t.Fatal("report changed", report)
		}
		if next, err := s.consumeInstallReport(); err != nil || next != nil {
			t.Fatal("valid report not consumed once", next, err)
		}
	}
}

func TestInstallReportRefusesOversizedFile(t *testing.T) {
	s := testService(t, "http://127.0.0.1:1")
	path := filepath.Join(s.cfg.DataDir, "updater", "install-report.json")
	raw := `{"ok":false,"platform":"macos","mode":"replace","summary":"` + strings.Repeat("x", 65<<10) + `"}`
	if err := atomicFile(path, []byte(raw), 0600); err != nil {
		t.Fatal(err)
	}
	if report, err := s.consumeInstallReport(); err == nil || report != nil {
		t.Fatal("oversized report was accepted")
	}
	if kept, err := os.ReadFile(path); err != nil || string(kept) != raw {
		t.Fatal("oversized report was not kept", err)
	}
}

func TestStartupReportCannotSupplyRecoveryGate(t *testing.T) {
	s := testService(t, "http://127.0.0.1:1")
	path := filepath.Join(s.cfg.DataDir, "updater", "install-report.json")
	if err := atomicJSON(path, map[string]any{"ok": false, "platform": "macos", "mode": "replace", "recoveryPending": true}); err != nil {
		t.Fatal(err)
	}
	value, err := s.startupInstallStatus(context.Background())
	fields, ok := value.(map[string]any)
	if err != nil || !ok || fields["ok"] != false || fields["recoveryPending"] != nil {
		t.Fatal("on-disk report asserted a recovery gate that was not present", value, err)
	}
}

type installReportWaitContext struct {
	context.Context
	waiting chan struct{}
	once    sync.Once
}

func (c *installReportWaitContext) Done() <-chan struct{} {
	c.once.Do(func() { close(c.waiting) })
	return c.Context.Done()
}

func TestStartupReportCancellationDoesNotConsume(t *testing.T) {
	s := testService(t, "http://127.0.0.1:1")
	s.startupDone = make(chan struct{})
	path := filepath.Join(s.cfg.DataDir, "updater", installReportName)
	if err := atomicJSON(path, map[string]any{"ok": false, "platform": "macos", "mode": "replace"}); err != nil {
		t.Fatal(err)
	}
	base, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	ctx := &installReportWaitContext{Context: base, waiting: make(chan struct{})}
	done := make(chan error, 1)
	go func() { _, err := s.Invoke(ctx, "consume_desktop_update_install_report", nil); done <- err }()
	select {
	case <-ctx.waiting:
		cancel()
		if err := <-done; !errors.Is(err, context.Canceled) {
			t.Fatal("cancel did not stop a waiting report reader", err)
		}
	case err := <-done:
		t.Fatal("read report before native startup finished", err)
	case <-base.Done():
		t.Fatal("report command did not reach the startup barrier")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal("canceled report command must retain the report", err)
	}
}

func TestStartupReportLeavesOutcomeForTheNextOrdinaryLaunch(t *testing.T) {
	for _, mode := range []string{"updating-candidate", "armed-recovery-exit"} {
		t.Run(mode, func(t *testing.T) {
			s := testService(t, "http://127.0.0.1:1")
			s.startupDone = make(chan struct{})
			if mode == "updating-candidate" {
				s.updateHealth = &macUpdateHealthClient{}
			} else {
				s.startupErr = errMacRecoveryExitArmed
			}
			close(s.startupDone)
			path := filepath.Join(s.cfg.DataDir, "updater", installReportName)
			if err := atomicJSON(path, map[string]any{"ok": false, "platform": "macos", "mode": "replace", "summary": "previous update result"}); err != nil {
				t.Fatal(err)
			}
			before, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			value, err := s.Invoke(context.Background(), "consume_desktop_update_install_report", nil)
			if err != nil || value != nil {
				t.Fatal("transient candidate exposed the previous outcome", value, err)
			}
			if after, err := os.ReadFile(path); err != nil || string(after) != string(before) {
				t.Fatal("transient candidate consumed the previous outcome", err)
			}
			ordinary := newDesktopService(s.cfg)
			defer ordinary.cancel()
			value, err = ordinary.Invoke(context.Background(), "consume_desktop_update_install_report", nil)
			fields, ok := value.(map[string]any)
			if err != nil || !ok || fields["summary"] != "previous update result" {
				t.Fatal("next ordinary launch did not receive the retained outcome", value, err)
			}
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Fatal("ordinary launch did not consume the report once", err)
			}
		})
	}
}
