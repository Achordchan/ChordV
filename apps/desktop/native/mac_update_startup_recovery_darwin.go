//go:build darwin

package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"time"

	"golang.org/x/sys/unix"
)

// Used by the update writer and both recovery readers. Enable only after
// separate signed-process, Keychain ACL and restart tests.
// An environment variable, ordinary journal or local build cannot enable it.
const macProtectedStartupRecoveryEnabled = false

var errMacStartupRollbackHandoff = errors.New("需独立助手等待当前候选进程退出，已保留两版应用")

func recoverMacUpdateOnStartup(ctx context.Context, cfg appConfig, health *macUpdateHealthClient, proxyRestored bool) error {
	if !macProtectedStartupRecoveryEnabled || buildMode != "release" || health != nil {
		// A candidate completing its health handshake must not compete with the
		// live update helper's locks or interpret the still-active transaction.
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	anchor, err := deriveRecoveryAnchor(ctx, cfg, executable)
	if err != nil {
		return err
	}
	store, err := openMacRecoveryKeychainSlot(anchor.bundle, anchor.bundle.Path, cfg.DataDir)
	if err != nil {
		return err
	}
	_, err = runMacStartupRecovery(ctx, anchor, store)
	var request *macStartupRollbackRequest
	if !errors.As(err, &request) {
		return err
	}
	if !proxyRestored {
		return errors.Join(err, errors.New("代理恢复未完成，不退出当前候选"))
	}
	if err = startMacStartupRollback(ctx, anchor, request.intent, store, func(helper string) *exec.Cmd {
		cmd := exec.Command(helper, macRecoveryWorkerArgument)
		cmd.Env = append(systemProcessEnvironment(), "CHORDV_MYGO_DATA_DIR="+cfg.DataDir)
		cmd.Stderr = os.Stderr
		return cmd
	}); err != nil {
		return err
	}
	return errMacRecoveryExitArmed
}

// The startup selector never swaps bundles. If exact B is running and the
// authority says to roll back, its caller needs a separate exit handoff.
func runMacStartupRecovery(ctx context.Context, anchor macRecoveryAnchor, store *macRecoverySlotAuthority) (string, error) {
	if !anchor.valid || store == nil || store.target != anchor.bundle.Path || store.dataDir != anchor.cfg.DataDir {
		return "blocked", errors.New("启动恢复缺少独立安装锚或匹配的受保护授权槽")
	}
	initial, observed, err := store.load(ctx)
	if errors.Is(err, errMacRecoverySlotMissing) {
		// An ordinary record without a protected slot is diagnostic only. An
		// empty install must not need a writable app parent or updater directory.
		present, err := macUpdateJournalPresent(anchor.cfg.DataDir)
		if err != nil {
			return "blocked", err
		}
		if present {
			return "legacy_pending", nil
		}
		return "none", nil
	}
	if err != nil {
		return "blocked", err
	}
	intent := initial.Arm.Intent
	if intent.Capability == "rollback_original" && macRecoveryPersistentBundleMatches(anchor.bundle, intent.Current, intent.Filesystem.Current) {
		// Either updater can have just reopened this exact original bundle.
		// Observe real exit before acquiring locks or removing its private copy.
		if err = waitMacRestoredHelperExit(ctx, initial.Arm); err != nil {
			return "blocked", err
		}
		if err = waitMacIndependentRecoveryExit(ctx, anchor, intent); err != nil {
			return "blocked", err
		}
	}
	state := "blocked"
	err = withMacRecoveryCleanupLocks(ctx, anchor, func() error {
		record, current, err := store.load(ctx)
		if err != nil || !bytes.Equal(current, observed) {
			return errors.Join(err, errors.New("加锁期间受保护恢复记录变化，已保留"))
		}
		intent := record.Arm.Intent
		checkpoint := macRecoveryCleanupCheckpoint{Intent: intent, JournalSHA256: record.CleanupSHA256}
		switch intent.Capability {
		case "":
			if err := resumeMacPendingAbortLocked(ctx, anchor, store); err != nil {
				return err
			}
			state = "aborted_unbound"
		case "rollback_original":
			snapshot, err := loadMacRecoveryReplay(ctx, anchor, intent)
			if err != nil {
				return err
			}
			if snapshot.helperState != "gone" {
				return errors.New("原更新助手仍在运行或身份不确定，已保留")
			}
			if snapshot.placement == "candidate_installed" {
				state = "needs_exit_handoff"
				return &macStartupRollbackRequest{intent: intent}
			}
			checkpoint, err = prepareMacRollbackCleanup(ctx, anchor, store)
			if err != nil {
				return err
			}
			fallthrough
		case "keep_original":
			if err := resumeMacRecoveryCleanupLocked(ctx, anchor, store, checkpoint); err != nil {
				return err
			}
			state = "kept_original"
		case "hold_candidate":
			if record.CleanupSHA256 == "" {
				checkpoint, err = prepareMacStartupCandidateCleanup(ctx, anchor, store, record)
				if err != nil {
					return err
				}
			}
			if err := resumeMacRecoveryCleanupLocked(ctx, anchor, store, checkpoint); err != nil {
				return err
			}
			state = "kept_candidate"
		default:
			return errors.New("启动恢复授权状态未知")
		}
		return nil
	})
	return state, err
}

func waitMacRestoredHelperExit(ctx context.Context, arm macRecoveryPendingArm) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	helper := arm.expectedTransaction()
	state := func() string { return macRecoveryHelperState(ctx, helper) }
	switch state() {
	case "gone":
		return ctx.Err()
	case "alive":
	default:
		return errors.New("恢复原版时原助手身份无法确认，已保留更新资料")
	}
	owned, err := ownMacUpdateProcess(arm.HelperPID, arm.HelperExecutable)
	if err == nil {
		defer owned.Close()
		if err = verifyMacHealthProcessCDHash(arm.HelperPID, arm.Intent.Current.CDHash); err == nil {
			err = owned.validateAlive()
		}
	}
	if latest := state(); latest == "gone" {
		return ctx.Err()
	} else if err != nil || latest != "alive" {
		return errors.Join(ctx.Err(), err, errors.New("恢复原版时原助手身份已变化，已保留更新资料"))
	}
	return waitMacRecoveryProcessExit(ctx, owned)
}

func waitMacIndependentRecoveryExit(ctx context.Context, anchor macRecoveryAnchor, intent macRecoveryIntent) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err := validateMacRecoveryScope(anchor, intent); err != nil {
		return err
	}
	plan, _, err := loadMacRecoveryWorkPlan(anchor, intent)
	if err != nil {
		return err
	}
	if err = plan.verifyHelperBundle(ctx); err != nil {
		return err
	}
	helper := macBundleInfo{Executable: plan.helperExecutable(), CDHash: intent.Current.CDHash}
	return visitMacRecoveryBundleProcesses(helper, func(initial unix.KinfoProc) error {
		pid := int(initial.Proc.P_pid)
		owned, err := ownMacUpdateProcess(pid, helper.Executable)
		if owned != nil {
			defer owned.Close()
			if err = verifyMacHealthProcessCDHash(pid, helper.CDHash); err == nil {
				err = owned.validateAlive()
			}
		}
		current, lookupErr := unix.SysctlKinfoProcSlice("kern.proc.pid", pid)
		if lookupErr == nil && (len(current) == 0 || len(current) == 1 && current[0].Proc.P_stat == 5) {
			return ctx.Err()
		}
		if err != nil || lookupErr != nil || len(current) != 1 || current[0].Proc.P_starttime != initial.Proc.P_starttime || current[0].Eproc.Ucred.Uid != uint32(os.Getuid()) {
			return errors.Join(err, lookupErr, errors.New("独立恢复助手进程身份不确定，已保留更新资料"))
		}
		return waitMacRecoveryProcessExit(ctx, owned)
	})
}

func waitMacRecoveryProcessExit(ctx context.Context, owned *macUpdateLaunchedProcess) error {
	select {
	case <-owned.exited:
		return ctx.Err()
	case <-owned.stopped:
		select {
		case <-owned.exited:
			return ctx.Err()
		default:
			return errors.New("未观察到恢复助手退出，已保留更新资料")
		}
	case <-ctx.Done():
		return ctx.Err()
	}
}

func prepareMacStartupCandidateCleanup(ctx context.Context, anchor macRecoveryAnchor, store macRecoveryCleanupAuthority, record macRecoverySlotRecord) (macRecoveryCleanupCheckpoint, error) {
	var checkpoint macRecoveryCleanupCheckpoint
	intent, proof := record.Arm.Intent, record.Health
	if intent.Capability != "hold_candidate" || proof == nil || !macRecoverySlotHealthMatches(intent, *proof) {
		return checkpoint, errors.New("启动恢复没有匹配的受保护健康证明")
	}
	if err := validateMacRecoveryScope(anchor, intent); err != nil {
		return checkpoint, err
	}
	unlock, err := lockMacRecoveryCopies(intent)
	if err != nil {
		return checkpoint, err
	}
	defer unlock()
	snapshot, err := loadMacRecoveryReplay(ctx, anchor, intent)
	if err != nil || snapshot.placement != "candidate_installed" || snapshot.helperState != "gone" ||
		!validMacCandidateCleanupJournal(snapshot.journal.Phase) || snapshot.journal.CandidatePID != proof.PID || snapshot.journal.CandidateIdentity != proof.ProcessIdentity {
		return checkpoint, errors.Join(err, errors.New("受保护健康证明与候选或日志不符，保留原版备份"))
	}
	if err = snapshot.plan.verifyRecoveryCopiesStopped(ctx, snapshot.staged); err != nil {
		return checkpoint, err
	}
	checkpoint = macRecoveryCleanupCheckpoint{Intent: intent, JournalSHA256: snapshot.journalSHA256}
	if err = store.checkpointCleanup(ctx, checkpoint); err != nil {
		return checkpoint, errors.Join(err, errors.New("启动恢复清理授权未确认，保留原版备份"))
	}
	return checkpoint, nil
}
