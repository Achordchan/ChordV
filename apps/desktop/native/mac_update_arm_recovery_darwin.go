//go:build darwin

package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

type macRecoveryPendingArm struct {
	Intent           macRecoveryIntent
	HelperPID        int
	HelperIdentity   string
	HelperExecutable string
}

type macRecoveryArmingAuthority interface {
	macRecoveryHealthAuthority
	// Both transitions are durable and atomic with respect to this installation:
	// reserve only an empty slot; bind only the entire exact pending reservation.
	// Pending reservations are not capabilities returned by active().
	reserve(context.Context, macRecoveryPendingArm) error
	bind(context.Context, macRecoveryPendingArm, string) error
}

func (p *macUpdatePlan) pendingRecoveryArm(ctx context.Context, candidate macBundleInfo) (macRecoveryPendingArm, error) {
	var pending macRecoveryPendingArm
	if err := p.verifyBoundDirectories(); err != nil {
		return pending, err
	}
	if err := p.verifyPlanBytes(); err != nil {
		return pending, err
	}
	if err := p.checkJournal("", ""); err != nil {
		return pending, err
	}
	if err := p.requirePreparedCandidate(candidate); err != nil {
		return pending, err
	}
	if err := p.verifyHelperBundle(ctx); err != nil {
		return pending, err
	}
	helper := p.helperExecutable()
	pid := os.Getpid()
	identity, err := processIdentity(ctx, pid)
	if err != nil {
		return pending, err
	}
	if path, err := macHealthProcessPath(pid); err != nil || path != helper {
		return pending, errors.Join(err, errors.New("恢复预授权必须由本次签名助手建立"))
	}
	if err = verifyMacHealthProcessCDHash(pid, p.Current.CDHash); err != nil {
		return pending, err
	}
	filesystem, err := captureMacUpdateFilesystem(p, candidate)
	if err != nil {
		return pending, err
	}
	if filesystem.Parent != p.Directories.ParentStable || filesystem.Work != p.Directories.WorkStable {
		return pending, errors.New("恢复预授权目录已变化")
	}
	var generation [16]byte
	if _, err := rand.Read(generation[:]); err != nil {
		return pending, err
	}
	intent := macRecoveryIntent{Generation: hex.EncodeToString(generation[:]), Operation: p.ID, UID: uint32(os.Getuid()),
		Target: p.Current.Path, DataDir: p.DataDir, Work: p.Work, PlanSHA256: p.planSHA256, Filesystem: *filesystem,
		Current: p.Current, Candidate: candidate}
	return macRecoveryPendingArm{Intent: intent, HelperPID: pid, HelperIdentity: identity, HelperExecutable: helper}, ctx.Err()
}

func (p *macUpdatePlan) bindRecoveryArm(ctx context.Context, candidate macBundleInfo, store macRecoveryArmingAuthority, pending macRecoveryPendingArm) (*macRecoveryHealthCommit, error) {
	if err := p.checkJournal("swap_pending", candidate.CDHash); err != nil {
		return nil, err
	}
	if err := p.verifyPlanBytes(); err != nil {
		return nil, err
	}
	raw, err := readMacRecoveryFile(filepath.Join(p.Work, "transaction.json"))
	if err != nil || macPlanDigest(raw) != p.transactionSHA256 {
		return nil, errors.Join(err, errors.New("受保护恢复绑定的事务原文不符"))
	}
	intent := pending.Intent
	var transaction macUpdateTransaction
	if json.Unmarshal(raw, &transaction) != nil || transaction.Schema != 1 || transaction.ID != intent.Operation ||
		!validMacRecoveryID(intent.Generation) || intent.UID != uint32(os.Getuid()) || intent.Capability != "" || intent.TransactionSHA256 != "" ||
		intent.Operation != p.ID || intent.Target != p.Current.Path || intent.DataDir != p.DataDir || intent.Work != p.Work ||
		intent.PlanSHA256 != transaction.PlanSHA256 || intent.Current != transaction.Current || intent.Candidate != transaction.Candidate ||
		transaction.HelperPID != pending.HelperPID || transaction.HelperIdentity != pending.HelperIdentity || transaction.HelperExecutable != pending.HelperExecutable ||
		transaction.Filesystem == nil || *transaction.Filesystem != intent.Filesystem {
		return nil, errors.New("已落盘的更新事务与原预授权不匹配，未交换应用")
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	if err = store.bind(ctx, pending, p.transactionSHA256); err != nil {
		return nil, errors.Join(err, errors.New("受保护恢复事务绑定未确认，未交换应用"))
	}
	intent.TransactionSHA256 = p.transactionSHA256
	intent.Capability = "rollback_original"
	active, err := store.active(ctx, intent.Target, intent.DataDir)
	if err != nil || active != intent {
		return nil, errors.Join(err, errors.New("受保护恢复授权代次或事务已变化，未交换应用"))
	}
	if err = p.checkJournal("swap_pending", candidate.CDHash); err != nil {
		return nil, err
	}
	if err = p.verifyPlanBytes(); err != nil {
		return nil, err
	}
	raw, err = readMacRecoveryFile(filepath.Join(p.Work, "transaction.json"))
	if err != nil || macPlanDigest(raw) != intent.TransactionSHA256 {
		return nil, errors.Join(err, errors.New("受保护恢复绑定后事务原文变化，未交换应用"))
	}
	if err = p.verifyCurrent(ctx); err != nil {
		return nil, err
	}
	if actual, err := p.verifyPreparedCandidate(ctx); err != nil || actual != candidate {
		return nil, errors.Join(err, errMacUpdateCandidateIdentity)
	}
	return &macRecoveryHealthCommit{authority: store, expected: intent}, ctx.Err()
}
