//go:build darwin

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/unix"
)

func runMacProtectedRecoveryWorker() error {
	if !macProtectedStartupRecoveryEnabled || buildMode != "release" {
		return errors.New("当前构建未启用正式恢复助手")
	}
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	state, err := executeMacRecoveryWorker(ctx, cfg, func(anchor macRecoveryAnchor, helper macBundleInfo) (macRecoveryAuthority, error) {
		return openMacRecoveryKeychainSlot(helper, anchor.bundle.Path, anchor.cfg.DataDir)
	})
	if err != nil {
		return err
	}
	if state != "rolled_back_retained" {
		return fmt.Errorf("恢复助手未执行回滚：%s", state)
	}
	return nil
}

type macRecoveryWorkerAuthority struct {
	inner  macRecoveryAuthority
	anchor macRecoveryAnchor
	helper macBundleInfo
}

func (a macRecoveryWorkerAuthority) active(ctx context.Context, target, dataDir string) (macRecoveryIntent, error) {
	var zero macRecoveryIntent
	if a.anchor.bundle.Path != target || a.anchor.cfg.DataDir != dataDir {
		return zero, errors.New("恢复助手请求超出父应用范围")
	}
	intent, err := a.inner.active(ctx, target, dataDir)
	if err != nil || intent.Capability != "rollback_original" {
		return zero, errors.Join(err, errors.New("恢复助手未取得本次回滚授权"))
	}
	if err = validateMacRecoveryScope(a.anchor, intent); err != nil {
		return zero, err
	}
	plan, _, err := loadMacRecoveryWorkPlan(a.anchor, intent)
	if err != nil {
		return zero, err
	}
	if plan.HelperBundle == nil || a.helper.Executable != plan.helperExecutable() || !macBundleSealMatches(a.helper, intent.Current) {
		return zero, errors.New("运行中的独立助手不是授权计划中的原版副本")
	}
	if err = plan.verifyHelperBundle(ctx); err != nil {
		return zero, err
	}
	if actual, err := macHealthProcessPath(os.Getpid()); err != nil || actual != a.helper.Executable {
		return zero, errors.Join(err, errors.New("运行中的独立助手执行路径已变化"))
	}
	if err = verifyMacHealthProcessCDHash(os.Getpid(), intent.Current.CDHash); err != nil {
		return zero, err
	}
	return intent, nil
}

func executeMacRecoveryWorker(ctx context.Context, cfg appConfig, open func(macRecoveryAnchor, macBundleInfo) (macRecoveryAuthority, error)) (string, error) {
	if err := ctx.Err(); err != nil {
		return "deferred", err
	}
	if open == nil {
		return "needs_authority", errors.New("恢复助手缺少受保护授权入口")
	}
	for _, file := range []*os.File{os.Stdin, os.Stdout} {
		info, err := file.Stat()
		if err != nil || info.Mode()&os.ModeNamedPipe == 0 {
			return "deferred", errors.Join(err, errors.New("恢复助手只接受继承的私有管道"))
		}
	}
	pid := os.Getppid()
	if pid <= 1 {
		return "deferred", errors.New("恢复助手没有活跃候选父进程")
	}
	parent, err := macHealthProcessPath(pid)
	if err != nil {
		return "deferred", err
	}
	anchor, err := deriveRecoveryAnchor(ctx, cfg, parent)
	if err != nil {
		return "deferred", err
	}
	if err = verifyMacHealthProcessCDHash(pid, anchor.bundle.CDHash); err != nil {
		return "deferred", err
	}
	self, err := macHealthProcessPath(os.Getpid())
	if err != nil {
		return "deferred", err
	}
	helper, err := readMacBundle(ctx, filepath.Dir(filepath.Dir(filepath.Dir(self))), true)
	if err != nil || helper.Executable != self || filepath.Base(helper.Path) != macUpdateHelperBundleName {
		return "deferred", errors.Join(err, errors.New("恢复助手未从独立签名副本启动"))
	}
	if err = validateMacSigning(anchor.bundle, helper, buildMode); err != nil {
		return "deferred", err
	}
	if err = verifyMacHealthProcessCDHash(os.Getpid(), helper.CDHash); err != nil {
		return "deferred", err
	}
	inner, err := open(anchor, helper)
	if err != nil || inner == nil {
		return "needs_authority", errors.Join(err, errors.New("恢复助手无法打开受保护授权"))
	}
	for _, fd := range []int{0, 1} {
		if err = unix.SetNonblock(fd, true); err != nil {
			return "deferred", err
		}
	}
	input, output := os.NewFile(0, "recovery-private-input"), os.NewFile(1, "recovery-private-output")
	defer input.Close()
	defer output.Close()
	authority := macRecoveryWorkerAuthority{inner: inner, anchor: anchor, helper: helper}
	handoff := &macRecoveryHandoff{input: input, output: output, armedAck: true, restartOriginal: true}
	return replayMacUpdateRecovery(ctx, anchor, authority, handoff)
}

func restartMacRestoredOriginal(ctx context.Context, snapshot macRecoveryReplaySnapshot, intent macRecoveryIntent, launchGate *os.File) error {
	plan := snapshot.plan
	restored, err := readMacBundle(ctx, intent.Target, true)
	if err != nil || restored.Node != snapshot.staged.Node || !macRecoveryPersistentBundleMatches(restored, intent.Current, intent.Filesystem.Current) {
		return errors.Join(err, errors.New("反向交换已完成，但恢复后的原版身份未确认；没有请求启动，已保留恢复资料"))
	}
	plan.Current = restored
	if err = plan.reopenMacOriginal(ctx, launchGate, []string{"CHORDV_MYGO_DATA_DIR=" + intent.DataDir}); err != nil {
		summary := "原版本已恢复，未确认重新打开，请手动打开应用。"
		return errors.Join(fmt.Errorf("%s %w", summary, err), plan.report(false, summary))
	}
	return plan.report(false, "原版本已恢复，已请求重新打开。")
}
