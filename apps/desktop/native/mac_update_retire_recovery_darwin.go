//go:build darwin

package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
)

var errMacRecoveryCleanupWorkPresent = errors.New("受保护更新工作目录清理尚未完成，保留剩余资料和授权")

type macRecoveryCleanupCheckpoint struct {
	Intent        macRecoveryIntent
	JournalSHA256 string
}

type macRecoveryCleanupAuthority interface {
	macRecoveryAuthority
	// Health checkpoints belong to a matching healthy capability. Retirement
	// consumes the exact checkpoint and cleanup capability, never a later one.
	checkpointCleanup(context.Context, macRecoveryCleanupCheckpoint) error
	activeCleanup(context.Context, string, string) (macRecoveryCleanupCheckpoint, error)
	retireCleanup(context.Context, macRecoveryCleanupCheckpoint) error
}

func macRecoveryCleanupCapability(capability string) bool {
	return capability == "hold_candidate" || capability == "keep_original"
}

func validMacCandidateCleanupJournal(phase string) bool {
	return phase == "healthy" || phase == "launch_requested"
}

func (p *macUpdatePlan) finishProtectedMacUpdate(ctx context.Context, installed, candidate macBundleInfo, store macRecoveryCleanupAuthority, intent macRecoveryIntent) error {
	intent.Capability = "hold_candidate"
	anchor, err := deriveRecoveryAnchor(ctx, appConfig{DataDir: p.DataDir, ReleaseRepository: p.Repository, ReleasePublicKey: p.PublicKey}, installed.Executable)
	if err != nil || !macRecoveryBundleMatches(anchor.bundle, installed) {
		return errors.Join(err, errors.New("更新后的应用已变化，保留受保护恢复资料"))
	}
	verify := func() error {
		if err := p.checkJournal("healthy", candidate.CDHash); err != nil {
			return err
		}
		snapshot, err := loadMacRecoveryReplay(ctx, anchor, intent)
		if err != nil || snapshot.placement != "candidate_installed" {
			return errors.Join(err, errors.New("受保护更新的应用身份不一致，保留备份"))
		}
		return p.verifyHelperBundle(ctx)
	}
	if err = verify(); err != nil {
		return err
	}
	checkpoint := macRecoveryCleanupCheckpoint{Intent: intent, JournalSHA256: p.lastJournalSHA256}
	if err = store.checkpointCleanup(ctx, checkpoint); err != nil {
		return errors.Join(err, errors.New("受保护更新清理授权未确认，保留备份"))
	}
	if err = verify(); err != nil {
		return err
	}
	if err = requireMacRecoveryCleanup(ctx, store, checkpoint); err != nil {
		return err
	}
	if err = p.finishMacUpdate("healthy", candidate); err != nil {
		return err
	}
	return retireMacRecoveryCleanup(ctx, anchor, store, checkpoint)
}

func requireMacRecoveryCleanup(ctx context.Context, store macRecoveryCleanupAuthority, checkpoint macRecoveryCleanupCheckpoint) error {
	intent := checkpoint.Intent
	actual, err := store.activeCleanup(ctx, intent.Target, intent.DataDir)
	if err != nil || actual != checkpoint {
		return errors.Join(err, errors.New("受保护清理授权已变化"))
	}
	active, err := store.active(ctx, intent.Target, intent.DataDir)
	if err != nil || active != intent || !macRecoveryCleanupCapability(active.Capability) {
		return errors.Join(err, errors.New("受保护更新清理授权已变化"))
	}
	return ctx.Err()
}

// Only an intact, independently authorized workspace or the tail after its
// removal can be resumed. A partially removed workspace is kept for diagnosis.
func resumeMacRecoveryCleanup(ctx context.Context, anchor macRecoveryAnchor, store macRecoveryCleanupAuthority) error {
	if store == nil {
		return errors.New("受保护更新收尾缺少授权提供者")
	}
	return withMacRecoveryCleanupLocks(ctx, anchor, func() error {
		checkpoint, err := store.activeCleanup(ctx, anchor.bundle.Path, anchor.cfg.DataDir)
		if err != nil {
			return err
		}
		return resumeMacRecoveryCleanupLocked(ctx, anchor, store, checkpoint)
	})
}

func withMacRecoveryCleanupLocks(ctx context.Context, anchor macRecoveryAnchor, run func() error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !anchor.valid {
		return errors.New("受保护更新收尾缺少独立启动锚")
	}
	p := macUpdatePlan{Current: anchor.bundle, DataDir: anchor.cfg.DataDir}
	targetLock, err := p.targetLock()
	if err != nil {
		return err
	}
	defer targetLock.Close()
	dataLock, err := lockMacUpdateData(anchor.cfg.DataDir)
	if err != nil {
		return err
	}
	defer dataLock.Close()
	return run()
}

func resumeMacRecoveryCleanupLocked(ctx context.Context, anchor macRecoveryAnchor, store macRecoveryCleanupAuthority, checkpoint macRecoveryCleanupCheckpoint) error {
	if err := validateMacRecoveryCleanup(anchor, checkpoint); err != nil {
		return err
	}
	if _, err := os.Lstat(checkpoint.Intent.Work); err == nil {
		if err := resumeMacRecoveryWorkspace(ctx, anchor, store, checkpoint); err != nil {
			return errors.Join(errMacRecoveryCleanupWorkPresent, err)
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	return retireMacRecoveryCleanup(ctx, anchor, store, checkpoint)
}

func resumeMacRecoveryWorkspace(ctx context.Context, anchor macRecoveryAnchor, store macRecoveryCleanupAuthority, checkpoint macRecoveryCleanupCheckpoint) error {
	intent := checkpoint.Intent
	if err := requireMacRecoveryCleanup(ctx, store, checkpoint); err != nil {
		return err
	}
	unlock, err := lockMacRecoveryCopies(intent)
	if err != nil {
		return err
	}
	defer unlock()
	snapshot, err := loadMacRecoveryReplay(ctx, anchor, intent)
	placement, validPhase := "candidate_installed", validMacCandidateCleanupJournal
	if intent.Capability == "keep_original" {
		placement, validPhase = "original_staged", validMacOriginalCleanupJournal
	}
	if err != nil || snapshot.placement != placement || snapshot.helperState != "gone" || !validPhase(snapshot.journal.Phase) {
		return errors.Join(err, errors.New("备份身份不符或原更新助手尚未确认退出"))
	}
	p := snapshot.plan
	if err = p.verifyRecoveryCopiesStopped(ctx, snapshot.staged); err != nil {
		return err
	}
	p.planSHA256, p.transactionSHA256, p.lastJournalSHA256 = intent.PlanSHA256, intent.TransactionSHA256, checkpoint.JournalSHA256
	if err = p.verifyPlanBytes(); err != nil {
		return err
	}
	transaction, err := readMacRecoveryFile(filepath.Join(intent.Work, "transaction.json"))
	if err != nil || macPlanDigest(transaction) != intent.TransactionSHA256 {
		return errors.Join(err, errors.New("更新事务原文已变化"))
	}
	if err = p.checkJournal(snapshot.journal.Phase, intent.Candidate.CDHash); err != nil {
		return err
	}
	if err = requireMacRecoveryCleanup(ctx, store, checkpoint); err != nil {
		return err
	}
	return cleanupVerifiedMacRecoveryWork(ctx, &p, intent, snapshot.target, snapshot.staged)
}

// Exclude ordinary starts of only the two copies being removed. The app at
// the installation path is not being replaced and may remain running.
func lockMacRecoveryCopies(intent macRecoveryIntent) (func(), error) {
	staged, err := lockMacTargetLaunch(intent.Candidate.Path, true)
	if err != nil {
		return nil, err
	}
	helper, err := lockMacTargetLaunch(filepath.Join(intent.Work, macUpdateHelperBundleName), true)
	if err != nil {
		staged.Close()
		return nil, err
	}
	return func() { helper.Close(); staged.Close() }, nil
}

func (p *macUpdatePlan) verifyRecoveryCopiesStopped(ctx context.Context, staged macBundleInfo) error {
	if err := p.verifyHelperBundle(ctx); err != nil {
		return err
	}
	if err := macRecoveryCandidateQuiescent(staged); err != nil {
		return err
	}
	return macRecoveryCandidateQuiescent(macBundleInfo{Executable: p.helperExecutable(), CDHash: p.Current.CDHash})
}

func cleanupVerifiedMacRecoveryWork(ctx context.Context, plan *macUpdatePlan, intent macRecoveryIntent, target, staged macBundleInfo) error {
	// A storage round-trip can span an in-place edit that keeps the directory
	// inode. Revalidate both seals before asking the scoped cleaner to remove it.
	for _, expected := range []macBundleInfo{target, staged} {
		actual, err := readMacBundle(ctx, expected.Path, true)
		if err != nil || !macRecoveryBundleMatches(actual, expected) {
			return errors.Join(err, errors.New("清理前应用签名或文件身份已变化，已保留"))
		}
	}
	if err := plan.verifyRecoveryCopiesStopped(ctx, staged); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	scope := macCleanupScope{target: intent.Target, parent: intent.Filesystem.Parent, workspace: intent.Filesystem.Work,
		installed: target.Node, staged: staged.Node, helper: plan.HelperBundle, detachedOnly: true}
	return cleanupMacUpdateWorkWithScope(intent.Work, &scope)
}

func validateMacRecoveryCleanup(anchor macRecoveryAnchor, checkpoint macRecoveryCleanupCheckpoint) error {
	intent := checkpoint.Intent
	if !macRecoveryCleanupCapability(intent.Capability) {
		return errors.New("受保护更新缺少清理能力")
	}
	if err := validateMacRecoveryScope(anchor, intent); err != nil {
		return err
	}
	for _, digest := range []string{intent.PlanSHA256, intent.TransactionSHA256, checkpoint.JournalSHA256} {
		if value, err := normalizedSHA256(digest); err != nil || value != digest {
			return errors.New("受保护清理缺少精确原文摘要")
		}
	}
	return nil
}

// The normal helper and the resumed worker both hold target and DataDir locks.
func retireMacRecoveryCleanup(ctx context.Context, anchor macRecoveryAnchor, store macRecoveryCleanupAuthority, checkpoint macRecoveryCleanupCheckpoint) error {
	intent := checkpoint.Intent
	if err := validateMacRecoveryCleanup(anchor, checkpoint); err != nil {
		return err
	}
	if err := requireMacRecoveryCleanup(ctx, store, checkpoint); err != nil {
		return err
	}
	kept, stable := intent.Candidate, intent.Filesystem.Candidate
	if intent.Capability == "keep_original" {
		kept, stable = intent.Current, intent.Filesystem.Current
	}
	verify := func() error {
		installed, err := readMacBundle(ctx, intent.Target, true)
		if err != nil || !macRecoveryBundleMatches(installed, anchor.bundle) || !macRecoveryPersistentBundleMatches(installed, kept, stable) {
			return errors.Join(err, errors.New("已安装应用不属于本次清理授权"))
		}
		parent, _, err := readMacFilesystemNode(filepath.Dir(intent.Target))
		if err != nil || parent != intent.Filesystem.Parent {
			return errors.Join(err, errors.New("清理授权的安装父目录已变化"))
		}
		if _, err = os.Lstat(intent.Work); !os.IsNotExist(err) {
			return errors.Join(err, errMacRecoveryCleanupWorkPresent)
		}
		return assertMacWorkImageAbsent(intent.Work)
	}
	if err := verify(); err != nil {
		return err
	}
	if err := syncMacUpdateDirectory(filepath.Dir(intent.Target)); err != nil {
		return err
	}
	if err := requireMacRecoveryCleanup(ctx, store, checkpoint); err != nil {
		return err
	}
	p := macUpdatePlan{ID: intent.Operation, Current: intent.Current, DataDir: intent.DataDir, Work: intent.Work,
		planSHA256: intent.PlanSHA256, transactionSHA256: intent.TransactionSHA256, lastJournalSHA256: checkpoint.JournalSHA256}
	// The exact raw journal was pinned only by a role-aware protected checkpoint.
	// Work may already be gone, so do not infer a terminal phase from disk.
	if err := p.clearJournal("", ""); err != nil {
		return err
	}
	if err := syncMacUpdateDirectory(filepath.Join(intent.DataDir, "updater")); err != nil {
		return err
	}
	if err := verify(); err != nil {
		return err
	}
	if err := requireUnusedMacUpdateJournal(intent.DataDir); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return store.retireCleanup(ctx, checkpoint)
}
