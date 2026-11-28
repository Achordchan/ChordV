//go:build darwin

package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
)

const maxMacRecoverySlotBytes = 32 << 10

var (
	errMacRecoverySlotMissing  = errors.New("没有本次安装的受保护更新授权")
	errMacRecoverySlotConflict = errors.New("受保护更新授权已经变化")
)

// A backend must protect records independently of same-UID writable files.
// nil represents an absent item. compareAndSwap must durably compare and change
// the complete value in one operation (including create and delete); an error
// may mean the change took effect. No filesystem fallback implements this.
type macRecoverySlotBackend interface {
	read(context.Context, string) ([]byte, error)
	compareAndSwap(context.Context, string, []byte, []byte) (bool, error)
}

type macRecoverySlotAuthority struct {
	backend              macRecoverySlotBackend
	target, dataDir, key string
}

var (
	_ macRecoveryArmingAuthority          = (*macRecoverySlotAuthority)(nil)
	_ macRecoveryCleanupAuthority         = (*macRecoverySlotAuthority)(nil)
	_ macRecoveryPendingAuthority         = (*macRecoverySlotAuthority)(nil)
	_ macRecoveryRollbackCleanupAuthority = (*macRecoverySlotAuthority)(nil)
)

type macRecoverySlotRecord struct {
	Schema        int
	Revision      string
	Arm           macRecoveryPendingArm
	Health        *macVerifiedUpdateHealth `json:",omitempty"`
	CleanupSHA256 string                   `json:",omitempty"`
	PendingAbort  *macRecoveryPendingAbort `json:",omitempty"`
}

// target and dataDir come from the already verified installation or helper
// plan. The slot is shared by all DataDirs for this target, like its launch
// gate; a second DataDir cannot start a new generation or use an existing one.
func newMacRecoverySlotAuthority(backend macRecoverySlotBackend, target, dataDir string) (*macRecoverySlotAuthority, error) {
	for _, path := range []string{target, dataDir} {
		if !filepath.IsAbs(path) || filepath.Clean(path) != path || strings.ContainsRune(path, 0) {
			return nil, errors.New("受保护授权需要明确的安装及数据目录")
		}
	}
	if backend == nil || !strings.HasSuffix(target, ".app") || macPathInside(target, dataDir) {
		return nil, errors.New("受保护授权的存储或安装身份无效")
	}
	key := macPlanDigest([]byte("chordv/mac-recovery-slot/v1\x00" + strings.ToLower(target)))
	return &macRecoverySlotAuthority{backend: backend, target: target, dataDir: dataDir, key: key}, nil
}

func macRecoverySlotDigest(value string) bool {
	normalized, err := normalizedSHA256(value)
	return err == nil && normalized == value
}

func macRecoverySlotHealthMatches(intent macRecoveryIntent, proof macVerifiedUpdateHealth) bool {
	return proof.Operation == intent.Operation && proof.Target == intent.Target && proof.DataDir == intent.DataDir &&
		proof.PlanSHA256 == intent.PlanSHA256 && proof.TransactionSHA256 == intent.TransactionSHA256 &&
		proof.Candidate == intent.Candidate && proof.CandidateFilesystem == intent.Filesystem.Candidate &&
		proof.PID > 1 && proof.ProcessIdentity != "" && macRecoverySlotDigest(proof.ChallengeSHA256)
}

func (s *macRecoverySlotAuthority) validate(record macRecoverySlotRecord) error {
	arm, intent := record.Arm, record.Arm.Intent
	if err := validateMacRecoveryIntentScope(s.target, s.dataDir, intent); err != nil {
		return err
	}
	revision, err := hex.DecodeString(record.Revision)
	helper := filepath.Join(intent.Work, macUpdateHelperBundleName, "Contents", "MacOS", filepath.Base(intent.Current.Executable))
	if record.Schema != 1 || err != nil || len(revision) != 16 || hex.EncodeToString(revision) != record.Revision ||
		!macRecoverySlotDigest(intent.PlanSHA256) || arm.HelperPID <= 1 || arm.HelperIdentity == "" || arm.HelperExecutable != helper ||
		filepath.Dir(intent.Current.Executable) != filepath.Join(intent.Current.Path, "Contents", "MacOS") ||
		filepath.Dir(intent.Candidate.Executable) != filepath.Join(intent.Candidate.Path, "Contents", "MacOS") {
		return errors.New("受保护授权记录的代次、摘要或助手身份无效")
	}
	switch intent.Capability {
	case "":
		if intent.TransactionSHA256 == "" && record.Health == nil && record.CleanupSHA256 == "" &&
			(record.PendingAbort == nil || record.PendingAbort.valid()) {
			return nil
		}
	case "rollback_original":
		if macRecoverySlotDigest(intent.TransactionSHA256) && record.Health == nil && record.CleanupSHA256 == "" && record.PendingAbort == nil {
			return nil
		}
	case "hold_candidate":
		if macRecoverySlotDigest(intent.TransactionSHA256) && record.Health != nil && macRecoverySlotHealthMatches(intent, *record.Health) && record.PendingAbort == nil &&
			(record.CleanupSHA256 == "" || macRecoverySlotDigest(record.CleanupSHA256)) {
			return nil
		}
	case "keep_original":
		if macRecoverySlotDigest(intent.TransactionSHA256) && record.Health == nil && record.PendingAbort == nil && macRecoverySlotDigest(record.CleanupSHA256) {
			return nil
		}
	}
	return errors.New("受保护授权的事务、健康或清理状态无效")
}

func (s *macRecoverySlotAuthority) load(ctx context.Context) (macRecoverySlotRecord, []byte, error) {
	var record macRecoverySlotRecord
	if err := ctx.Err(); err != nil {
		return record, nil, err
	}
	raw, err := s.backend.read(ctx, s.key)
	if err != nil {
		return record, nil, err
	}
	if raw == nil {
		return record, nil, errMacRecoverySlotMissing
	}
	if len(raw) > maxMacRecoverySlotBytes || json.Unmarshal(raw, &record) != nil {
		return record, nil, errors.New("受保护授权记录格式无效")
	}
	encoded, err := json.Marshal(record)
	if err != nil || !bytes.Equal(raw, encoded) {
		return record, nil, errors.New("受保护授权记录不是规范原文")
	}
	if err = s.validate(record); err != nil {
		return record, nil, err
	}
	return record, raw, ctx.Err()
}

func (s *macRecoverySlotAuthority) requireEmptyForUpdate(ctx context.Context) error {
	_, _, err := s.load(ctx)
	if errors.Is(err, errMacRecoverySlotMissing) {
		return ctx.Err()
	}
	if err != nil {
		return err
	}
	return errors.New("已有未完成的受保护更新，未预留新的恢复授权")
}

func (s *macRecoverySlotAuthority) replace(ctx context.Context, before []byte, next *macRecoverySlotRecord) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	var after []byte
	if next != nil {
		// The revision distinguishes even a recreated record with identical fields.
		var revision [16]byte
		if _, err := rand.Read(revision[:]); err != nil {
			return err
		}
		next.Schema, next.Revision = 1, hex.EncodeToString(revision[:])
		if err := s.validate(*next); err != nil {
			return err
		}
		var err error
		after, err = json.Marshal(next)
		if err != nil || len(after) > maxMacRecoverySlotBytes {
			return errors.Join(err, errors.New("受保护授权无法编码或超出长度限制"))
		}
	}
	ok, err := s.backend.compareAndSwap(ctx, s.key, before, after)
	if err != nil {
		return err
	}
	if !ok {
		return errMacRecoverySlotConflict
	}
	return ctx.Err()
}

func (s *macRecoverySlotAuthority) reserve(ctx context.Context, arm macRecoveryPendingArm) error {
	if arm.Intent.Capability != "" || arm.Intent.TransactionSHA256 != "" {
		return errMacRecoverySlotConflict
	}
	return s.replace(ctx, nil, &macRecoverySlotRecord{Arm: arm})
}

func (s *macRecoverySlotAuthority) bind(ctx context.Context, arm macRecoveryPendingArm, transaction string) error {
	record, before, err := s.load(ctx)
	if err != nil {
		return err
	}
	if record.Arm != arm || arm.Intent.Capability != "" || record.PendingAbort != nil {
		return errMacRecoverySlotConflict
	}
	record.Arm.Intent.TransactionSHA256, record.Arm.Intent.Capability = transaction, "rollback_original"
	return s.replace(ctx, before, &record)
}

func (s *macRecoverySlotAuthority) pendingArm(ctx context.Context) (macRecoveryPendingArm, *macRecoveryPendingAbort, error) {
	record, _, err := s.load(ctx)
	if err != nil {
		return macRecoveryPendingArm{}, nil, err
	}
	if record.Arm.Intent.Capability != "" {
		return macRecoveryPendingArm{}, nil, errMacRecoverySlotConflict
	}
	return record.Arm, record.PendingAbort, nil
}

func (s *macRecoverySlotAuthority) checkpointPendingAbort(ctx context.Context, arm macRecoveryPendingArm, abort macRecoveryPendingAbort) error {
	record, before, err := s.load(ctx)
	if err != nil {
		return err
	}
	if record.Arm != arm || arm.Intent.Capability != "" || record.PendingAbort != nil || !abort.valid() {
		return errMacRecoverySlotConflict
	}
	record.PendingAbort = &abort
	return s.replace(ctx, before, &record)
}

func (s *macRecoverySlotAuthority) retirePendingAbort(ctx context.Context, arm macRecoveryPendingArm, abort macRecoveryPendingAbort) error {
	record, before, err := s.load(ctx)
	if err != nil {
		return err
	}
	if record.Arm != arm || arm.Intent.Capability != "" || record.PendingAbort == nil || *record.PendingAbort != abort {
		return errMacRecoverySlotConflict
	}
	return s.replace(ctx, before, nil)
}

func (s *macRecoverySlotAuthority) active(ctx context.Context, target, dataDir string) (macRecoveryIntent, error) {
	if target != s.target || dataDir != s.dataDir {
		return macRecoveryIntent{}, errMacRecoverySlotMissing
	}
	record, _, err := s.load(ctx)
	if err != nil {
		return macRecoveryIntent{}, err
	}
	if record.Arm.Intent.Capability == "" {
		return macRecoveryIntent{}, errMacRecoverySlotMissing
	}
	return record.Arm.Intent, nil
}

func (s *macRecoverySlotAuthority) markHealthy(ctx context.Context, expected macRecoveryIntent, proof macVerifiedUpdateHealth) error {
	record, before, err := s.load(ctx)
	if err != nil {
		return err
	}
	if record.Arm.Intent != expected || expected.Capability != "rollback_original" || !macRecoverySlotHealthMatches(expected, proof) {
		return errMacRecoverySlotConflict
	}
	record.Arm.Intent.Capability, record.Health = "hold_candidate", &proof
	return s.replace(ctx, before, &record)
}

func (s *macRecoverySlotAuthority) checkpointCleanup(ctx context.Context, checkpoint macRecoveryCleanupCheckpoint) error {
	record, before, err := s.load(ctx)
	if err != nil {
		return err
	}
	if record.Arm.Intent != checkpoint.Intent || checkpoint.Intent.Capability != "hold_candidate" ||
		record.CleanupSHA256 != "" || !macRecoverySlotDigest(checkpoint.JournalSHA256) {
		return errMacRecoverySlotConflict
	}
	record.CleanupSHA256 = checkpoint.JournalSHA256
	return s.replace(ctx, before, &record)
}

func (s *macRecoverySlotAuthority) checkpointRollbackCleanup(ctx context.Context, expected macRecoveryIntent, journalSHA256 string) error {
	record, before, err := s.load(ctx)
	if err != nil {
		return err
	}
	if record.Arm.Intent != expected || expected.Capability != "rollback_original" || !macRecoverySlotDigest(journalSHA256) {
		return errMacRecoverySlotConflict
	}
	// Freeze the original-app decision and checkpoint together. Once saved,
	// neither this generation's reverse swap nor its late health can apply.
	record.Arm.Intent.Capability, record.CleanupSHA256 = "keep_original", journalSHA256
	return s.replace(ctx, before, &record)
}

func (s *macRecoverySlotAuthority) activeCleanup(ctx context.Context, target, dataDir string) (macRecoveryCleanupCheckpoint, error) {
	if target != s.target || dataDir != s.dataDir {
		return macRecoveryCleanupCheckpoint{}, errMacRecoverySlotMissing
	}
	record, _, err := s.load(ctx)
	if err != nil {
		return macRecoveryCleanupCheckpoint{}, err
	}
	if record.CleanupSHA256 == "" {
		return macRecoveryCleanupCheckpoint{}, errMacRecoverySlotMissing
	}
	return macRecoveryCleanupCheckpoint{Intent: record.Arm.Intent, JournalSHA256: record.CleanupSHA256}, nil
}

func (s *macRecoverySlotAuthority) retireCleanup(ctx context.Context, checkpoint macRecoveryCleanupCheckpoint) error {
	record, before, err := s.load(ctx)
	if err != nil {
		return err
	}
	if record.Arm.Intent != checkpoint.Intent || record.CleanupSHA256 == "" || record.CleanupSHA256 != checkpoint.JournalSHA256 {
		return errMacRecoverySlotConflict
	}
	return s.replace(ctx, before, nil)
}
