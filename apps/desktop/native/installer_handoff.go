package main

import (
	"context"
	"errors"
	"path/filepath"
	"time"
)

type installerHandoffOps struct {
	platform    string
	mode        string
	summary     string
	start       func(string) error
	quit        func()
	writeReport func(string, any) error
}

func (s *DesktopService) handoffInstaller(ctx context.Context, p *pendingInstaller, ops installerHandoffOps) (any, error) {
	if p == nil || ops.start == nil || ops.quit == nil {
		return nil, errors.New("安装交接参数不完整，未启动安装程序")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.operationMu.Lock()
	if err := ctx.Err(); err != nil {
		s.operationMu.Unlock()
		return nil, err
	}
	if s.installing {
		s.operationMu.Unlock()
		return nil, errors.New("安装程序正在交接，请勿重复操作")
	}
	s.installing = true
	s.operationMu.Unlock()
	started := false
	defer func() {
		if !started {
			s.operationMu.Lock()
			s.installing = false
			s.operationMu.Unlock()
		}
	}()
	verified, err := s.validatedInstaller(p.Path)
	if err != nil {
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	if _, err = s.disconnect(); err != nil {
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	if err = ops.start(verified.Path); err != nil {
		return nil, err
	}
	started = true
	// Once the installer owns the handoff, report errors must not strand the app.
	defer ops.quit()
	writeReport := ops.writeReport
	if writeReport == nil {
		writeReport = atomicJSON
	}
	if ops.platform == "" {
		ops.platform = platformName()
	}
	if ops.mode == "" {
		ops.mode = "installer"
	}
	if ops.summary == "" {
		ops.summary = "安装程序已启动"
	}
	report := map[string]any{"ok": true, "platform": ops.platform, "mode": ops.mode, "summary": ops.summary, "detail": nil, "logPath": nil, "createdAt": time.Now().UTC().Format(time.RFC3339)}
	if err = writeReport(filepath.Join(s.cfg.DataDir, "updater", "install-report.json"), report); err != nil {
		s.publish("chordv://update-install-report-failed", "更新安装已交接，但启动记录写入失败")
	}
	return map[string]bool{"ok": true}, nil
}
