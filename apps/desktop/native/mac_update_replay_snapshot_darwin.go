//go:build darwin

package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

type macRecoveryReplaySnapshot struct {
	target, staged         macBundleInfo
	placement, helperState string
	helperPID              int
	journal                macUpdateJournal
	journalSHA256          string
	directories            macSwapDirectories
	plan                   macUpdatePlan
}

func validateMacRecoveryScope(anchor macRecoveryAnchor, intent macRecoveryIntent) error {
	if !anchor.valid || intent.Capability != "rollback_original" && !macRecoveryCleanupCapability(intent.Capability) {
		return errors.New("受保护恢复授权的范围或动作不匹配")
	}
	return validateMacRecoveryIntentScope(anchor.bundle.Path, anchor.cfg.DataDir, intent)
}

func validateMacRecoveryIntentScope(target, dataDir string, intent macRecoveryIntent) error {
	work := filepath.Join(filepath.Dir(target), ".chordv-mac-update-"+intent.Operation)
	if !validMacRecoveryID(intent.Operation) || !validMacRecoveryID(intent.Generation) || intent.UID != uint32(os.Getuid()) ||
		intent.Target != target || intent.DataDir != dataDir || intent.Work != work || macPathInside(work, dataDir) ||
		intent.Current.Path != target || intent.Candidate.Path != filepath.Join(work, "next.app") {
		return errors.New("受保护恢复授权的范围不匹配")
	}
	fs := intent.Filesystem
	for _, identity := range []macFilesystemIdentity{fs.Parent, fs.Work, fs.Current, fs.Candidate} {
		if identity.FileID == 0 || len(identity.VolumeUUID) != 32 || identity.VolumeUUID != fs.Parent.VolumeUUID || identity.BirthSec <= 0 {
			return errors.New("恢复授权缺少持久文件身份")
		}
	}
	return nil
}

// This loader consumes a previously authenticated, narrowly scoped capability.
// It does not mint one from old schema-1 files or re-authorize a new release.
// In particular, offline rollback does not ignore errors from an online verifier:
// source/floor verification belongs to the provider's original arming operation.
func loadMacRecoveryReplay(ctx context.Context, anchor macRecoveryAnchor, intent macRecoveryIntent) (macRecoveryReplaySnapshot, error) {
	var result macRecoveryReplaySnapshot
	if err := ctx.Err(); err != nil {
		return result, err
	}
	if err := validateMacRecoveryScope(anchor, intent); err != nil {
		return result, err
	}
	work, fs := intent.Work, intent.Filesystem
	plan, directories, err := loadMacRecoveryWorkPlan(anchor, intent)
	if err != nil {
		return result, err
	}
	result.directories = directories
	transactionRaw, err := readMacRecoveryFile(filepath.Join(work, "transaction.json"))
	if err != nil || macPlanDigest(transactionRaw) != intent.TransactionSHA256 {
		return result, errors.New("恢复事务不属于受保护授权")
	}
	var transaction macUpdateTransaction
	if json.Unmarshal(transactionRaw, &transaction) != nil || transaction.Schema != 1 || transaction.ID != intent.Operation ||
		transaction.PlanSHA256 != intent.PlanSHA256 || transaction.Current != intent.Current || transaction.Candidate != intent.Candidate ||
		transaction.Filesystem == nil || *transaction.Filesystem != fs || transaction.HelperPID <= 1 || transaction.HelperIdentity == "" ||
		transaction.HelperExecutable != plan.helperExecutable() {
		return result, errors.New("恢复事务身份或持久锚不一致")
	}
	journalRaw, err := readMacRecoveryFile(filepath.Join(intent.DataDir, "updater", "mac-update-journal.json"))
	if err != nil {
		return result, err
	}
	var journal macUpdateJournal
	if json.Unmarshal(journalRaw, &journal) != nil || journal.Schema != 1 || journal.ID != intent.Operation || journal.Target != intent.Target ||
		journal.Work != work || journal.PlanSHA256 != intent.PlanSHA256 || journal.TransactionSHA256 != intent.TransactionSHA256 || journal.CandidateCDHash != intent.Candidate.CDHash {
		return result, errors.New("恢复journal引用不匹配；phase不是执行许可")
	}
	target, staged, err := readMacRecoveryBundlePair(ctx, anchor, intent)
	if err != nil {
		return result, err
	}
	matchA := func(actual macBundleInfo) bool {
		return macRecoveryPersistentBundleMatches(actual, intent.Current, fs.Current)
	}
	matchB := func(actual macBundleInfo) bool {
		return macRecoveryPersistentBundleMatches(actual, intent.Candidate, fs.Candidate)
	}
	switch {
	case matchA(target) && matchB(staged):
		result.placement = "original_staged"
	case matchB(target) && matchA(staged):
		result.placement = "candidate_installed"
	default:
		return result, errors.New("应用实际角色不属于此受保护恢复授权")
	}
	result.target, result.staged = target, staged
	result.helperPID = transaction.HelperPID
	result.helperState = macRecoveryHelperState(ctx, transaction)
	result.journal, result.journalSHA256 = journal, macPlanDigest(journalRaw)
	result.plan = plan
	return result, ctx.Err()
}

func loadMacRecoveryWorkPlan(anchor macRecoveryAnchor, intent macRecoveryIntent) (macUpdatePlan, macSwapDirectories, error) {
	var plan macUpdatePlan
	var dirs macSwapDirectories
	work, fs := intent.Work, intent.Filesystem
	if err := validateMacWork(work); err != nil {
		return plan, dirs, err
	}
	for path, want := range map[string]macFilesystemIdentity{filepath.Dir(intent.Target): fs.Parent, work: fs.Work} {
		actual, node, err := readMacFilesystemNode(path)
		if err != nil || actual != want {
			return plan, dirs, errors.New("恢复授权父目录或工作目录已被替换")
		}
		if path == work {
			dirs.Work, dirs.WorkStable = node, actual
		} else {
			dirs.Parent, dirs.ParentStable = node, actual
		}
	}
	raw, err := readMacRecoveryFile(filepath.Join(work, macUpdatePlanName))
	if err != nil || macPlanDigest(raw) != intent.PlanSHA256 {
		return plan, dirs, errors.New("恢复计划不属于受保护授权")
	}
	if json.Unmarshal(raw, &plan) != nil || plan.Schema != 1 || plan.ID != intent.Operation || plan.Work != work || plan.DataDir != intent.DataDir ||
		plan.Current != intent.Current || plan.Repository != anchor.cfg.ReleaseRepository || plan.PublicKey != anchor.cfg.ReleasePublicKey {
		return macUpdatePlan{}, dirs, errors.New("恢复计划与受保护范围不一致")
	}
	return plan, dirs, nil
}

func readMacRecoveryBundlePair(ctx context.Context, anchor macRecoveryAnchor, intent macRecoveryIntent) (macBundleInfo, macBundleInfo, error) {
	target, err := readMacBundle(ctx, intent.Target, true)
	if err != nil {
		return target, macBundleInfo{}, err
	}
	if !macRecoveryBundleMatches(target, anchor.bundle) {
		return target, macBundleInfo{}, errors.New("独立启动锚对应的目标已经改变")
	}
	staged, err := readMacBundle(ctx, intent.Candidate.Path, true)
	if err != nil {
		return target, staged, err
	}
	return target, staged, validateMacSigning(target, staged, buildMode)
}
