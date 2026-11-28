//go:build darwin

package main

import (
	"context"
	"errors"
)

type macRecoveryRollbackCleanupAuthority interface {
	macRecoveryCleanupAuthority
	checkpointRollbackCleanup(context.Context, macRecoveryIntent, string) error
}

// These are the bound phases a protected helper can leave before committing
// health. Phase only checks record consistency; physical roles authorize nothing
// without the matching protected rollback capability.
func validMacOriginalCleanupJournal(phase string) bool {
	switch phase {
	case "swap_pending", "swapped", "awaiting_health", "launch_requested", "launch_indeterminate", "rollback_deferred":
		return true
	default:
		return false
	}
}

// Start from a fresh, independently verified A anchor after observing that A
// is physically in place. This cleanup never attempts the reverse swap itself.
func resumeMacRollbackCleanup(ctx context.Context, anchor macRecoveryAnchor, store macRecoveryRollbackCleanupAuthority) error {
	if store == nil {
		return errors.New("回滚清理缺少受保护授权提供者")
	}
	return withMacRecoveryCleanupLocks(ctx, anchor, func() error {
		checkpoint, err := store.activeCleanup(ctx, anchor.bundle.Path, anchor.cfg.DataDir)
		if errors.Is(err, errMacRecoverySlotMissing) {
			checkpoint, err = prepareMacRollbackCleanup(ctx, anchor, store)
		}
		if err != nil {
			return err
		}
		if checkpoint.Intent.Capability != "keep_original" {
			return errors.New("回滚清理的检查点未授权保留原版")
		}
		return resumeMacRecoveryCleanupLocked(ctx, anchor, store, checkpoint)
	})
}

func prepareMacRollbackCleanup(ctx context.Context, anchor macRecoveryAnchor, store macRecoveryRollbackCleanupAuthority) (macRecoveryCleanupCheckpoint, error) {
	var checkpoint macRecoveryCleanupCheckpoint
	intent, err := store.active(ctx, anchor.bundle.Path, anchor.cfg.DataDir)
	if err != nil || intent.Capability != "rollback_original" {
		return checkpoint, errors.Join(err, errors.New("没有可结束的受保护回滚授权"))
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
	if err != nil || snapshot.placement != "original_staged" || snapshot.helperState != "gone" || !validMacOriginalCleanupJournal(snapshot.journal.Phase) {
		return checkpoint, errors.Join(err, errors.New("原版未恢复、受保护记录不完整或助手尚未退出，保留两份应用"))
	}
	if err = snapshot.plan.verifyRecoveryCopiesStopped(ctx, snapshot.staged); err != nil {
		return checkpoint, err
	}
	if err = store.checkpointRollbackCleanup(ctx, intent, snapshot.journalSHA256); err != nil {
		return checkpoint, errors.Join(err, errors.New("回滚清理授权未确认，保留更新资料"))
	}
	intent.Capability = "keep_original"
	return macRecoveryCleanupCheckpoint{Intent: intent, JournalSHA256: snapshot.journalSHA256}, nil
}
