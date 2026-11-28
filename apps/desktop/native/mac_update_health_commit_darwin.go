//go:build darwin

package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
)

var errMacUpdateHealthCommitUncertain = errors.New("受保护健康确认或最终回执未能确认，已保留两个应用和恢复记录")

type macRecoveryHealthAuthority interface {
	macRecoveryAuthority
	// Atomically compare the entire expected intent, including generation and
	// capability, and durably change rollback_original to hold_candidate.
	// A read followed by an unconditional write does not meet this contract.
	markHealthy(context.Context, macRecoveryIntent, macVerifiedUpdateHealth) error
}

type macRecoveryHealthCommit struct {
	authority macRecoveryHealthAuthority
	expected  macRecoveryIntent
}

type macVerifiedUpdateHealth struct {
	Operation, Target, DataDir, PlanSHA256, TransactionSHA256, ProcessIdentity, ChallengeSHA256 string
	Candidate                                                                                   macBundleInfo
	CandidateFilesystem                                                                         macFilesystemIdentity
	PID                                                                                         int
}

// Only the owned peer's verified dual-ready handshake may call this method.
// The helper holds the target and data locks; only the provider can grant or
// transition capabilities. Ordinary update files are not an authority.
func (s *macUpdateHealthSupervisor) commitRecoveryHealth(ctx context.Context, owned *macUpdateLaunchedProcess, commit *macRecoveryHealthCommit) error {
	p, intent := s.plan, commit.expected
	if commit.authority == nil || !validMacRecoveryID(intent.Generation) || intent.Capability != "rollback_original" || intent.UID != uint32(os.Getuid()) ||
		intent.Operation != p.ID || intent.Target != p.Current.Path || intent.DataDir != p.DataDir || intent.Work != p.Work ||
		intent.Current != p.Current || intent.Candidate != s.candidate || intent.PlanSHA256 != p.planSHA256 ||
		intent.TransactionSHA256 == "" || intent.TransactionSHA256 != p.transactionSHA256 {
		return errors.New("受保护健康确认不属于当前更新事务")
	}
	if err := p.verifyBoundDirectories(); err != nil {
		return err
	}
	if p.Directories.ParentStable != intent.Filesystem.Parent || p.Directories.WorkStable != intent.Filesystem.Work {
		return errors.New("受保护健康确认的目录身份不符")
	}
	if err := p.verifyPlanBytes(); err != nil {
		return err
	}
	transaction, err := readMacRecoveryFile(filepath.Join(p.Work, "transaction.json"))
	if err != nil || macPlanDigest(transaction) != intent.TransactionSHA256 {
		return errors.Join(err, errors.New("受保护健康确认的事务原文不符"))
	}
	stable, node, err := readMacFilesystemNode(intent.Target)
	if err != nil || stable != intent.Filesystem.Candidate || node != s.candidate.Node {
		return errors.Join(err, errors.New("受保护健康确认的候选文件身份不符"))
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if err = owned.validateAlive(); err != nil {
		return err
	}
	proof := macVerifiedUpdateHealth{
		Operation: p.ID, Target: p.Current.Path, DataDir: p.DataDir, PlanSHA256: p.planSHA256, TransactionSHA256: p.transactionSHA256,
		Candidate: s.candidate, CandidateFilesystem: stable, PID: owned.PID, ProcessIdentity: owned.identity, ChallengeSHA256: macPlanDigest([]byte(s.challenge)),
	}
	if err = commit.authority.markHealthy(ctx, intent, proof); err != nil {
		// The provider could have persisted before returning an error, or the
		// authorization could have changed. The live helper must preserve both.
		return errors.Join(errMacUpdateHealthCommitUncertain, err)
	}
	return nil
}
