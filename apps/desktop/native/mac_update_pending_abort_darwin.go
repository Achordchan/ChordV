//go:build darwin

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

type macRecoveryPendingAbort struct {
	Phase              string
	TransactionWritten bool
}

func (a macRecoveryPendingAbort) valid() bool {
	switch a.Phase {
	case "prepared", "armed":
		return !a.TransactionWritten
	case "waiting_parent_exit":
		return true // The transaction can have landed before the next journal write.
	case "swap_pending":
		return a.TransactionWritten
	default:
		return false
	}
}

type macRecoveryPendingAuthority interface {
	pendingArm(context.Context) (macRecoveryPendingArm, *macRecoveryPendingAbort, error)
	checkpointPendingAbort(context.Context, macRecoveryPendingArm, macRecoveryPendingAbort) error
	retirePendingAbort(context.Context, macRecoveryPendingArm, macRecoveryPendingAbort) error
}

func (a macRecoveryPendingArm) expectedTransaction() macUpdateTransaction {
	i := a.Intent
	return macUpdateTransaction{Schema: 1, ID: i.Operation, PlanSHA256: i.PlanSHA256, Current: i.Current, Candidate: i.Candidate,
		HelperPID: a.HelperPID, HelperIdentity: a.HelperIdentity, HelperExecutable: a.HelperExecutable, Filesystem: &i.Filesystem}
}

func pendingAbortJournal(i macRecoveryIntent, abort macRecoveryPendingAbort, transactionDigest string) ([]byte, error) {
	if abort.Phase != "swap_pending" {
		transactionDigest = ""
	}
	return json.MarshalIndent(macUpdateJournal{Schema: 1, ID: i.Operation, Work: i.Work, Target: i.Target, Phase: abort.Phase,
		PlanSHA256: i.PlanSHA256, CandidateCDHash: i.Candidate.CDHash, TransactionSHA256: transactionDigest}, "", "  ")
}

// Rebuild the only possible pre-bind records from the authenticated arm.
// Ordinary journal fields and their self-declared digests confer no authority.
func observeMacPendingAbort(i macRecoveryIntent, expectedTransaction []byte) (macRecoveryPendingAbort, error) {
	actual, err := readMacRecoveryFile(filepath.Join(i.Work, "transaction.json"))
	transactionWritten := err == nil
	if transactionWritten && !bytes.Equal(actual, expectedTransaction) || !transactionWritten && !os.IsNotExist(err) {
		return macRecoveryPendingAbort{}, errors.Join(err, errors.New("预授权事务原文不属于本次更新"))
	}
	journal, err := readMacRecoveryFile(filepath.Join(i.DataDir, "updater", "mac-update-journal.json"))
	if err != nil {
		return macRecoveryPendingAbort{}, err
	}
	for _, phase := range []string{"prepared", "armed", "waiting_parent_exit", "swap_pending"} {
		check := macRecoveryPendingAbort{Phase: phase, TransactionWritten: transactionWritten}
		if !check.valid() {
			continue
		}
		want, err := pendingAbortJournal(i, check, macPlanDigest(expectedTransaction))
		if err != nil {
			return macRecoveryPendingAbort{}, err
		}
		if bytes.Equal(journal, want) {
			return check, nil
		}
	}
	return macRecoveryPendingAbort{}, errors.New("预授权日志不匹配绑定前的任何阶段，已保留")
}

func confirmMacPendingAbort(ctx context.Context, store macRecoveryPendingAuthority, expected macRecoveryPendingArm, checkpoint macRecoveryPendingAbort) error {
	active, actual, err := store.pendingArm(ctx)
	if err != nil || active != expected || actual == nil || *actual != checkpoint {
		return errors.Join(err, errors.New("预授权清理代次或检查点已变化"))
	}
	return ctx.Err()
}

// Only retire a verified unbound reservation. This path never starts the
// candidate, swaps app directories, or retires a bound rollback capability.
func resumeMacPendingAbort(ctx context.Context, anchor macRecoveryAnchor, store macRecoveryPendingAuthority) error {
	if store == nil {
		return errors.New("预授权清理缺少受保护存储")
	}
	return withMacRecoveryCleanupLocks(ctx, anchor, func() error {
		return resumeMacPendingAbortLocked(ctx, anchor, store)
	})
}

func resumeMacPendingAbortLocked(ctx context.Context, anchor macRecoveryAnchor, store macRecoveryPendingAuthority) error {
	arm, checkpoint, err := store.pendingArm(ctx)
	if err != nil {
		return err
	}
	i := arm.Intent
	if err := validateMacRecoveryIntentScope(anchor.bundle.Path, anchor.cfg.DataDir, i); err != nil {
		return err
	}
	if i.Capability != "" || i.TransactionSHA256 != "" || !macRecoverySlotDigest(i.PlanSHA256) ||
		arm.HelperPID <= 1 || arm.HelperIdentity == "" || arm.HelperExecutable == "" || checkpoint != nil && !checkpoint.valid() {
		return errors.New("预授权清理身份或阶段无效")
	}
	transaction := arm.expectedTransaction()
	if macRecoveryHelperState(ctx, transaction) != "gone" {
		return errors.New("预授权助手尚未确认退出")
	}
	expected, err := macUpdateTransactionBytes(transaction)
	if err != nil {
		return err
	}
	if _, err = os.Lstat(i.Work); err == nil {
		verified, err := removeMacPendingWork(ctx, anchor, store, arm, checkpoint, expected)
		if err != nil {
			return err
		}
		checkpoint = &verified
	} else if !os.IsNotExist(err) || checkpoint == nil {
		return errors.Join(err, errors.New("预授权工作目录缺失且没有可信的清理检查点"))
	}
	return finishMacPendingAbort(ctx, anchor, store, arm, *checkpoint, macPlanDigest(expected))
}

func removeMacPendingWork(ctx context.Context, anchor macRecoveryAnchor, store macRecoveryPendingAuthority, arm macRecoveryPendingArm, checkpoint *macRecoveryPendingAbort, expected []byte) (macRecoveryPendingAbort, error) {
	i := arm.Intent
	unlock, err := lockMacRecoveryCopies(i)
	if err != nil {
		return macRecoveryPendingAbort{}, err
	}
	defer unlock()
	plan, _, err := loadMacRecoveryWorkPlan(anchor, i)
	if err != nil {
		return macRecoveryPendingAbort{}, err
	}
	if arm.HelperExecutable != plan.helperExecutable() {
		return macRecoveryPendingAbort{}, errors.New("预授权的助手与计划不符")
	}
	target, staged, err := readMacRecoveryBundlePair(ctx, anchor, i)
	if err != nil || !macRecoveryPersistentBundleMatches(target, i.Current, i.Filesystem.Current) ||
		!macRecoveryPersistentBundleMatches(staged, i.Candidate, i.Filesystem.Candidate) {
		return macRecoveryPendingAbort{}, errors.Join(err, errors.New("原版未在安装位或候选副本身份不符"))
	}
	if err = plan.verifyRecoveryCopiesStopped(ctx, staged); err != nil {
		return macRecoveryPendingAbort{}, err
	}
	observed, err := observeMacPendingAbort(i, expected)
	if err != nil {
		return observed, err
	}
	if checkpoint == nil {
		if err = store.checkpointPendingAbort(ctx, arm, observed); err != nil {
			return observed, err
		}
	} else if observed != *checkpoint {
		return observed, errors.New("预授权日志阶段与原清理检查点不同")
	}
	if err = confirmMacPendingAbort(ctx, store, arm, observed); err != nil {
		return observed, err
	}
	plan.planSHA256 = i.PlanSHA256
	if err = plan.verifyPlanBytes(); err != nil {
		return observed, err
	}
	if again, err := observeMacPendingAbort(i, expected); err != nil || again != observed {
		return observed, errors.Join(err, errors.New("预授权文件在清理前已变化"))
	}
	return observed, cleanupVerifiedMacRecoveryWork(ctx, &plan, i, target, staged)
}

func finishMacPendingAbort(ctx context.Context, anchor macRecoveryAnchor, store macRecoveryPendingAuthority, arm macRecoveryPendingArm, checkpoint macRecoveryPendingAbort, transactionDigest string) error {
	i := arm.Intent
	verify := func() error {
		original, err := readMacBundle(ctx, i.Target, true)
		if err != nil || !macRecoveryBundleMatches(original, anchor.bundle) || !macRecoveryPersistentBundleMatches(original, i.Current, i.Filesystem.Current) {
			return errors.Join(err, errors.New("原安装应用已变化，保留预授权"))
		}
		parent, _, err := readMacFilesystemNode(filepath.Dir(i.Target))
		if err != nil || parent != i.Filesystem.Parent {
			return errors.Join(err, errors.New("原安装父目录已变化，保留预授权"))
		}
		if _, err = os.Lstat(i.Work); !os.IsNotExist(err) {
			return errors.Join(err, errMacRecoveryCleanupWorkPresent)
		}
		return assertMacWorkImageAbsent(i.Work)
	}
	if err := verify(); err != nil {
		return err
	}
	if err := syncMacUpdateDirectory(filepath.Dir(i.Target)); err != nil {
		return err
	}
	if err := confirmMacPendingAbort(ctx, store, arm, checkpoint); err != nil {
		return err
	}
	journal, err := pendingAbortJournal(i, checkpoint, transactionDigest)
	if err != nil {
		return err
	}
	if checkpoint.Phase != "swap_pending" {
		transactionDigest = ""
	}
	p := macUpdatePlan{ID: i.Operation, Current: i.Current, DataDir: i.DataDir, Work: i.Work,
		planSHA256: i.PlanSHA256, transactionSHA256: transactionDigest, lastJournalSHA256: macPlanDigest(journal)}
	if err = p.clearJournal("", ""); err != nil {
		return err
	}
	if err = syncMacUpdateDirectory(filepath.Join(i.DataDir, "updater")); err != nil {
		return err
	}
	if err = verify(); err != nil {
		return err
	}
	if err = requireUnusedMacUpdateJournal(i.DataDir); err != nil {
		return err
	}
	return store.retirePendingAbort(ctx, arm, checkpoint)
}
