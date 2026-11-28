package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

func (s *DesktopService) startupInstallStatus(ctx context.Context) (any, error) {
	// A candidate still running its health handshake is not the consumer of a
	// previous installer's result, even if its native startup has completed.
	if s.updateHealth != nil {
		return nil, ctx.Err()
	}
	startupErr := s.waitStartup(ctx)
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if errors.Is(startupErr, errMacRecoveryExitArmed) {
		return nil, nil // The installed original may need this report on its next launch.
	}
	// Other startup errors do not hide diagnostics. Inspect the fixed journal
	// only after startup has either retired it or decided to retain it.
	report, reportErr := s.consumeInstallReport()
	fields, _ := report.(map[string]any)
	delete(fields, "recoveryPending") // This flag can only come from the fixed journal slot.
	present, err := macUpdateJournalPresent(s.cfg.DataDir)
	if err != nil {
		return nil, errors.Join(reportErr, err)
	}
	if !present {
		return report, reportErr
	}
	if fields["ok"] == false && fields["platform"] == "macos" {
		fields["recoveryPending"] = true
		return fields, nil
	}
	// A missing, damaged or successful report does not settle the recovery slot.
	return map[string]string{"state": "pending_recovery"}, nil
}

const (
	installReportName = "install-report.json"
	installReportMax  = 64 << 10
)

func sameInstallReport(a, b os.FileInfo) bool {
	return b.Mode().IsRegular() && os.SameFile(a, b) && a.Size() == b.Size() && a.ModTime().Equal(b.ModTime())
}

func (s *DesktopService) consumeInstallReport() (any, error) {
	dataDir, err := os.OpenRoot(s.cfg.DataDir)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer dataDir.Close()
	namedDir, err := dataDir.Lstat("updater")
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !namedDir.IsDir() {
		return nil, errors.New("更新报告目录必须是普通目录")
	}
	updater, err := dataDir.OpenRoot("updater")
	if err != nil {
		return nil, err
	}
	defer updater.Close()
	if openedDir, err := updater.Stat("."); err != nil || !os.SameFile(namedDir, openedDir) {
		return nil, errors.New("读取前更新目录已变化")
	}
	entry, err := updater.Lstat(installReportName)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !entry.Mode().IsRegular() || entry.Size() > installReportMax {
		return nil, errors.New("安装结果必须是大小不超过 64 KiB 的普通文件")
	}
	file, err := updater.OpenFile(installReportName, installReportOpenFlags, 0)
	if err != nil {
		return nil, err
	}
	opened, err := file.Stat()
	if err != nil || !sameInstallReport(entry, opened) {
		_ = file.Close()
		return nil, errors.New("读取前安装结果已变化")
	}
	data, err := io.ReadAll(io.LimitReader(file, installReportMax+1))
	if err := errors.Join(err, file.Close()); err != nil {
		return nil, err
	}
	if int64(len(data)) != entry.Size() {
		return nil, errors.New("安装结果大小已变化")
	}
	var report map[string]any
	if err = json.Unmarshal(data, &report); err != nil {
		return nil, err
	}
	if _, ok := report["ok"].(bool); !ok {
		return nil, errors.New("安装结果缺少有效的成功或失败标记")
	}
	for _, field := range []string{"platform", "mode"} {
		if value, ok := report[field].(string); !ok || strings.TrimSpace(value) == "" {
			return nil, fmt.Errorf("安装结果字段 %s 无效", field)
		}
	}
	for _, field := range []string{"summary", "detail", "logPath", "createdAt"} {
		if _, ok := report[field].(string); !ok && report[field] != nil {
			return nil, fmt.Errorf("安装结果字段 %s 无效", field)
		}
	}
	if currentDir, err := dataDir.Lstat("updater"); err != nil || !os.SameFile(namedDir, currentDir) {
		return nil, errors.New("读取期间更新目录已变化")
	}
	if current, err := updater.Lstat(installReportName); err != nil || !sameInstallReport(entry, current) {
		return nil, errors.New("读取期间安装结果已变化")
	}
	if err = updater.Remove(installReportName); err != nil {
		return nil, err
	}
	return report, nil
}
