//go:build darwin

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"
)

func (p *macUpdatePlan) restartEnvironment() []string {
	env := []string{"CHORDV_MYGO_DATA_DIR=" + p.DataDir}
	if buildMode == "local" {
		env = append(env, "CHORDV_API_BASE_URL="+p.APIBase, "CHORDV_GITHUB_RELEASE_REPOSITORY="+p.Repository, "CHORDV_GITHUB_RELEASE_PUBLIC_KEY="+p.PublicKey)
	}
	return append(env, p.ExtraRestartEnvironment...)
}

func (p *macUpdatePlan) apply(ctx context.Context, launchGate *os.File, store macRecoveryArmingAuthority, pending macRecoveryPendingArm) (result error) {
	if err := p.verifyBoundDirectories(); err != nil {
		return err
	}
	if err := p.verifyCurrent(ctx); err != nil {
		return err
	}
	candidate, err := p.verifyPreparedCandidate(ctx)
	if err != nil {
		return err
	}
	// The live helper's last digest already binds the waiting record and
	// candidate; the transaction required by terminal cleanup does not yet exist.
	if err = p.checkJournal("", ""); err != nil {
		return err
	}
	if err = p.beginTransaction(ctx, candidate); err != nil {
		return err
	}
	health, err := startMacUpdateHealth(p, candidate)
	if err != nil {
		return err
	}
	defer health.Close()
	if err = p.journal("swap_pending", candidate.CDHash, ""); err != nil {
		return err
	}
	var healthCommit *macRecoveryHealthCommit
	if store != nil {
		healthCommit, err = p.bindRecoveryArm(ctx, candidate, store, pending)
		if err != nil {
			return err
		}
	}
	var owned *macUpdateLaunchedProcess
	healthVerified, rollbackSafe, swapped := false, true, false
	defer func() {
		if owned != nil {
			owned.Close()
		}
	}()
	defer func() {
		if result == nil || healthVerified || errors.Is(result, errMacUpdateHealthCommitUncertain) {
			return
		}
		if !rollbackSafe {
			result = errors.Join(result, errors.New("启动结果不确定，未回滚或删除原应用备份"))
			_ = p.journal("launch_indeterminate", candidate.CDHash, result.Error())
			return
		}
		if owned != nil {
			stopCtx, stop := context.WithTimeout(context.Background(), 15*time.Second)
			stopErr := owned.StopAndWait(stopCtx)
			stop()
			if stopErr != nil {
				result = errors.Join(result, fmt.Errorf("候选退出未确认，保留原应用备份：%w", stopErr))
				_ = p.journal("rollback_deferred", candidate.CDHash, result.Error())
				return
			}
		}
		if healthCommit != nil {
			// A failed forward rename can have happened without its fsync.
			// Do not attempt a second swap on that ambiguous result.
			if !swapped {
				return
			}
			rollbackCtx, stop := context.WithTimeout(context.Background(), 30*time.Second)
			defer stop()
			if err := p.rollbackProtectedFailedUpdate(rollbackCtx, healthCommit); err != nil {
				result = errors.Join(result, err)
			} else if err := p.reopenMacOriginal(rollbackCtx, launchGate, []string{"CHORDV_MYGO_DATA_DIR=" + p.DataDir}); err != nil {
				result = errors.Join(result, fmt.Errorf("原版本已恢复，未确认重新打开，请手动打开应用：%w", err))
			} else {
				result = errors.Join(result, errors.New("原版本已恢复，已请求重新打开"))
			}
			return
		}
		result = p.rollbackFailedUpdate(candidate, result, launchGate)
	}()
	if err = p.swapWithDirectories(p.Current.Node, candidate.Node, *p.Directories); err != nil {
		return err
	}
	swapped = true
	if err = p.journal("swapped", candidate.CDHash, ""); err != nil {
		return err
	}
	installed, err := readMacBundle(ctx, p.Current.Path, true)
	if err != nil {
		return err
	}
	if installed.Node != candidate.Node || !macBundleSealMatches(installed, candidate) {
		return errors.New("交换后应用身份变化，拒绝启动")
	}
	if err = p.journal("awaiting_health", candidate.CDHash, ""); err != nil {
		return err
	}
	launchCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	owned, err = launchMacUpdateApplication(launchCtx, installed, append(p.restartEnvironment(), health.RestartEnvironment()...))
	cancel()
	if err != nil {
		rollbackSafe = macUpdateLaunchRollbackSafe(err)
		return err
	}
	p.launchedProcess = owned
	if err = p.journal("launch_requested", candidate.CDHash, "已取得候选进程，等待原生及首屏就绪确认"); err != nil {
		return err
	}
	if err = health.Wait(ctx, owned, healthCommit); err != nil {
		return err
	}
	healthVerified = true
	if err = p.journal("healthy", candidate.CDHash, "原生启动与本地首屏已确认"); err != nil {
		return fmt.Errorf("新版本已就绪，健康记录持久化失败，原应用副本已保留：%w", err)
	}
	cleanup, _ := store.(macRecoveryCleanupAuthority)
	if healthCommit != nil && cleanup == nil {
		return p.report(true, "新版本已就绪，原版本和恢复记录已保留，等待安全收尾。")
	}
	if err = p.report(true, "更新完成，新版本已启动并完成界面初始化。"); err != nil {
		return fmt.Errorf("新版本已就绪，结果记录失败，原应用副本已保留：%w", err)
	}
	if healthCommit != nil {
		return p.finishProtectedMacUpdate(ctx, installed, candidate, cleanup, healthCommit.expected)
	}
	return p.finishMacUpdate("healthy", candidate)
}

// apply still holds the installation, data and exclusive launch locks here.
// Unlike the ordinary rollback, leave the protected records and both copies
// for the original application's normal startup to retire.
func (p *macUpdatePlan) rollbackProtectedFailedUpdate(ctx context.Context, commit *macRecoveryHealthCommit) error {
	intent := commit.expected
	active, err := commit.authority.active(ctx, p.Current.Path, p.DataDir)
	if err != nil || active != intent || intent.Capability != "rollback_original" {
		return errors.Join(err, errors.New("受保护回滚授权已变化，未恢复原版"))
	}
	installed, err := readMacBundle(ctx, p.Current.Path, true)
	if err != nil || !macRecoveryBundleMatches(installed, intent.Candidate) {
		return errors.Join(err, errors.New("安装位置已不属于本次候选，未恢复原版"))
	}
	anchor := macRecoveryAnchor{bundle: installed, valid: true,
		cfg: appConfig{DataDir: p.DataDir, ReleaseRepository: p.Repository, ReleasePublicKey: p.PublicKey}}
	snapshot, err := loadMacRecoveryReplay(ctx, anchor, intent)
	if err != nil || snapshot.placement != "candidate_installed" || snapshot.helperState != "alive" ||
		snapshot.helperPID != os.Getpid() || snapshot.journalSHA256 != p.lastJournalSHA256 || !validMacOriginalCleanupJournal(snapshot.journal.Phase) {
		return errors.Join(err, errors.New("回滚事务、日志或当前助手身份已变化，保留两份应用"))
	}
	if err := p.verifyHelperBundle(ctx); err != nil {
		return err
	}
	if err := verifyMacHealthProcessCDHash(os.Getpid(), intent.Current.CDHash); err != nil {
		return err
	}
	if _, err := reverseMacRecoverySwap(ctx, snapshot); err != nil {
		return fmt.Errorf("受保护回滚未确认，已保留更新资料：%w", err)
	}
	restored, err := readMacBundle(ctx, p.Current.Path, true)
	if err != nil || !macRecoveryPersistentBundleMatches(restored, intent.Current, intent.Filesystem.Current) {
		return errors.Join(err, errors.New("恢复后的原应用未能复验，保留更新资料"))
	}
	return nil
}

func (p *macUpdatePlan) rollbackFailedUpdate(candidate macBundleInfo, cause error, launchGate *os.File) error {
	if err := p.verifyBoundDirectories(); err != nil {
		return errors.Join(cause, err)
	}
	actual, err := macNode(p.Current.Path)
	if err != nil {
		_ = p.journal("target_changed", candidate.CDHash, cause.Error())
		return errors.Join(cause, err)
	}
	if actual == candidate.Node {
		if err = p.journal("rollback_pending", candidate.CDHash, cause.Error()); err != nil {
			return errors.Join(cause, fmt.Errorf("无法记录回滚操作，未交换应用，已保留更新资料：%w", err))
		}
		if err = p.swapWithDirectories(candidate.Node, p.Current.Node, *p.Directories); err != nil {
			cause = errors.Join(cause, fmt.Errorf("回滚结果未确认，已保留更新目录：%w", err))
			_ = p.journal("rollback_failed", candidate.CDHash, cause.Error())
			return cause
		}
	} else if actual != p.Current.Node {
		_ = p.journal("target_changed", candidate.CDHash, cause.Error())
		return errors.Join(cause, errors.New("目标已由其他操作改变，未覆盖"))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err = p.verifyCurrent(ctx); err != nil {
		return errors.Join(cause, err)
	}
	if err = p.journal("rolled_back", candidate.CDHash, cause.Error()); err != nil {
		return errors.Join(cause, err)
	}
	if err = p.reopenMacOriginal(ctx, launchGate, p.restartEnvironment()); err != nil {
		return errors.Join(cause, fmt.Errorf("原版本已恢复，重新启动未确认：%w", err))
	}
	return errors.Join(cause, p.finishMacUpdate("rolled_back", candidate))
}

func (p *macUpdatePlan) reopenMacOriginal(ctx context.Context, launchGate *os.File, environment []string) error {
	// The reverse swap is complete. The restored app must launch normally;
	// the update target and DataDir locks remain held until this helper finishes.
	if launchGate != nil {
		if err := launchGate.Close(); err != nil {
			return err
		}
	}
	restarted, restartErr := launchMacUpdateApplication(ctx, p.Current, environment)
	if restarted != nil {
		restarted.Close()
	}
	return restartErr
}
