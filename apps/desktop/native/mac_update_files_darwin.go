//go:build darwin

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const macUpdatePlanName = "plan.json"

type macUpdateJournal struct {
	Schema            int    `json:"schema"`
	ID                string `json:"id"`
	Work              string `json:"work"`
	Target            string `json:"target"`
	Phase             string `json:"phase"`
	PlanSHA256        string `json:"planSha256"`
	CandidateCDHash   string `json:"candidateCdHash,omitempty"`
	TransactionSHA256 string `json:"transactionSha256,omitempty"`
	CandidatePID      int    `json:"candidatePid,omitempty"`
	CandidateIdentity string `json:"candidateIdentity,omitempty"`
	Message           string `json:"message,omitempty"`
}

// A new installation cannot decide that an interrupted operation has finished.
// Check the directory entry itself: even a dangling link occupies this slot.
// Only check the fixed journal slot. Presence is not proof of failure or authority to recover.
func macUpdateJournalPresent(dataDir string) (bool, error) {
	_, err := os.Lstat(filepath.Join(dataDir, "updater", "mac-update-journal.json"))
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("无法确认上次更新记录：%w", err)
	}
	return true, nil
}

func requireUnusedMacUpdateJournal(dataDir string) error {
	present, err := macUpdateJournalPresent(dataDir)
	if err != nil || !present {
		return err
	}
	return errors.New("mac_update_pending: 发现未完成的应用更新，已保留原记录")
}

func (p *macUpdatePlan) checkJournal(phase, candidateHash string) error {
	data, err := readMacRecoveryFile(filepath.Join(p.DataDir, "updater", "mac-update-journal.json"))
	if err != nil {
		return err
	}
	if macPlanDigest(data) != p.lastJournalSHA256 {
		return errors.New("恢复记录与当前助手最后写入的原文不符，已保留")
	}
	var journal macUpdateJournal
	if json.Unmarshal(data, &journal) != nil || journal.Schema != 1 || journal.ID != p.ID || journal.Work != p.Work || journal.Target != p.Current.Path || journal.PlanSHA256 != p.planSHA256 || journal.TransactionSHA256 != p.transactionSHA256 {
		return errors.New("恢复记录格式未知或不属于本次更新，已保留")
	}
	if phase != "" && (p.transactionSHA256 == "" || journal.Phase != phase || candidateHash == "" || journal.CandidateCDHash != candidateHash) {
		return errors.New("更新收尾阶段或候选身份不符，已保留恢复记录")
	}
	return nil
}

func (p *macUpdatePlan) clearJournal(phase, candidateHash string) error {
	if err := p.checkJournal(phase, candidateHash); err != nil {
		if phase == "" && os.IsNotExist(err) {
			return nil
		}
		return err
	}
	path := filepath.Join(p.DataDir, "updater", "mac-update-journal.json")
	if err := os.Remove(path); err != nil {
		return err
	}
	return syncMacUpdateDirectory(filepath.Dir(path))
}

func macPlanDigest(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }

func validateMacWork(dir string) error {
	canonical, err := macCanonical(dir)
	if err != nil {
		return err
	}
	if canonical != dir || !strings.HasPrefix(filepath.Base(dir), ".chordv-mac-update-") {
		return errors.New("独立更新工作目录无效")
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode().Perm() != 0700 {
		return errors.New("独立更新目录必须为0700")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != os.Getuid() {
		return errors.New("独立更新目录不属于当前用户")
	}
	return nil
}

func readMacPlan(dir string) (*macUpdatePlan, []byte, error) {
	if err := validateMacWork(dir); err != nil {
		return nil, nil, err
	}
	path := filepath.Join(dir, macUpdatePlanName)
	data, err := readMacRecoveryFile(path)
	if err != nil {
		return nil, nil, err
	}
	var p macUpdatePlan
	if json.Unmarshal(data, &p) != nil || p.Schema != 1 || p.Work != dir || p.ID != strings.TrimPrefix(filepath.Base(dir), ".chordv-mac-update-") || filepath.Dir(p.Current.Path) != filepath.Dir(dir) || p.ParentPID <= 1 || p.ParentExecutable != p.Current.Executable {
		return nil, nil, errors.New("独立更新计划身份不一致")
	}
	dataDir, err := macCanonical(p.DataDir)
	if err != nil || dataDir != p.DataDir {
		return nil, nil, errors.New("更新数据目录无效")
	}
	if err := validateAPIBase(p.APIBase); err != nil {
		return nil, nil, err
	}
	if err := validateMacUpdateRestartExtra(&p); err != nil {
		return nil, nil, err
	}
	return &p, data, nil
}

func (p *macUpdatePlan) verifyPlanBytes() error {
	data, err := readMacRecoveryFile(filepath.Join(p.Work, macUpdatePlanName))
	if err != nil {
		return err
	}
	if macPlanDigest(data) != p.planSHA256 {
		return errors.New("更新计划已偏离准备时的原文")
	}
	return nil
}

func (p *macUpdatePlan) journal(phase, cdhash, message string) error {
	if err := p.verifyPlanBytes(); err != nil {
		return err
	}
	if p.transactionSHA256 != "" {
		if err := verifyFile(filepath.Join(p.Work, "transaction.json"), p.transactionSHA256, 0); err != nil {
			return err
		}
	}
	j := macUpdateJournal{Schema: 1, ID: p.ID, Work: p.Work, Target: p.Current.Path, Phase: phase, PlanSHA256: p.planSHA256, CandidateCDHash: cdhash, TransactionSHA256: p.transactionSHA256, Message: message}
	if p.launchedProcess != nil {
		j.CandidatePID, j.CandidateIdentity = p.launchedProcess.PID, p.launchedProcess.identity
	}
	path := filepath.Join(p.DataDir, "updater", "mac-update-journal.json")
	data, err := json.MarshalIndent(j, "", "  ")
	if err != nil {
		return err
	}
	if p.lastJournalSHA256 == "" {
		if err := requireUnusedMacUpdateJournal(p.DataDir); err != nil {
			return err
		}
		// The slot can become occupied after the preflight check.
		if err := publishAtomicFile(path, data, 0600, func(from, to string) error {
			return unix.RenameatxNp(unix.AT_FDCWD, from, unix.AT_FDCWD, to, unix.RENAME_EXCL)
		}); err != nil {
			return err
		}
	} else {
		previous, err := readMacRecoveryFile(path)
		if err != nil {
			return err
		}
		if macPlanDigest(previous) != p.lastJournalSHA256 {
			return errors.New("恢复记录与当前助手最后写入的原文不符，未推进更新")
		}
		if err := atomicFile(path, data, 0600); err != nil {
			return err
		}
	}
	if err := syncMacUpdateDirectory(filepath.Dir(path)); err != nil {
		return err
	}
	p.lastJournalSHA256 = macPlanDigest(data)
	return nil
}

func (p *macUpdatePlan) report(ok bool, summary string) error {
	report := map[string]any{"ok": ok, "platform": "macos", "mode": "automatic_bundle_swap", "summary": summary, "detail": nil, "logPath": nil, "createdAt": time.Now().UTC().Format(time.RFC3339)}
	if p.launchedProcess != nil {
		report["candidatePid"], report["candidateIdentity"] = p.launchedProcess.PID, p.launchedProcess.identity
	}
	return durableMacUpdateJSON(filepath.Join(p.DataDir, "updater", "install-report.json"), report)
}

func (p *macUpdatePlan) stage(ctx context.Context) error {
	if err := p.verifyReceipt(); err != nil {
		return err
	}
	mount := filepath.Join(p.Work, "mount")
	if err := os.Mkdir(mount, 0700); err != nil {
		return err
	}
	if err := p.mountImage(ctx); err != nil {
		return err
	}
	entries, err := os.ReadDir(mount)
	if err != nil {
		return err
	}
	source := ""
	for _, entry := range entries {
		if entry.IsDir() && strings.HasSuffix(entry.Name(), ".app") {
			if source != "" {
				return errors.New("安装镜像包含多个应用")
			}
			source = filepath.Join(mount, entry.Name())
		}
	}
	if source == "" {
		return errors.New("安装镜像没有应用bundle")
	}
	mounted, err := readMacBundle(ctx, source, true)
	if err != nil {
		return err
	}
	if _, err := runMacUpdateCommand(ctx, 120*time.Second, "/usr/bin/ditto", source, filepath.Join(p.Work, "next.app")); err != nil {
		return err
	}
	if err := detachMacUpdateMount(p.Work); err != nil {
		return err
	}
	candidate, err := p.verifyCandidate(ctx)
	if err != nil {
		return err
	}
	if !macBundleSealMatches(candidate, mounted) {
		return errMacUpdateCandidateIdentity
	}
	p.preparedCandidate = candidate
	return p.journal("prepared", candidate.CDHash, "")
}

func (p *macUpdatePlan) targetLock() (*os.File, error) {
	parent := filepath.Dir(p.Current.Path)
	fd, err := unix.Open(parent, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	defer unix.Close(fd)
	name := ".chordv-update-" + macPlanDigest([]byte(strings.ToLower(p.Current.Path)))[:24] + ".lock"
	lockFD, err := unix.Openat(fd, name, unix.O_CREAT|unix.O_RDWR|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(lockFD), filepath.Join(parent, name))
	var stat unix.Stat_t
	if err = unix.Fstat(lockFD, &stat); err != nil {
		file.Close()
		return nil, err
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFREG || stat.Mode&0777 != 0600 || int(stat.Uid) != os.Getuid() || stat.Nlink != 1 {
		file.Close()
		return nil, errors.New("目标更新锁身份无效")
	}
	if err = unix.Flock(lockFD, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		file.Close()
		return nil, errors.New("同一应用已有更新交接")
	}
	return file, nil
}

func lockMacUpdateData(dataDir string) (*os.File, error) {
	updater := filepath.Join(dataDir, "updater")
	canonical, err := macCanonical(updater)
	if err != nil || canonical != updater {
		return nil, errors.New("更新锁目录不是规范路径")
	}
	fd, err := unix.Open(updater, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	defer unix.Close(fd)
	lockFD, err := unix.Openat(fd, "mac-update.lock", unix.O_CREAT|unix.O_RDWR|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0600)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(lockFD), filepath.Join(updater, "mac-update.lock"))
	var stat unix.Stat_t
	err = unix.Fstat(lockFD, &stat)
	if err == nil && (stat.Mode&unix.S_IFMT != unix.S_IFREG || stat.Mode&0777 != 0600 || stat.Uid != uint32(os.Getuid()) || stat.Nlink != 1) {
		err = errors.New("更新数据锁类型、权限、所有者或链接数无效")
	}
	if err == nil {
		err = unix.Flock(lockFD, unix.LOCK_EX|unix.LOCK_NB)
	}
	if err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
}

type macSwapDirectories struct {
	Parent       macNodeIdentity       `json:"parentNode"`
	Work         macNodeIdentity       `json:"workNode"`
	ParentStable macFilesystemIdentity `json:"parentIdentity"`
	WorkStable   macFilesystemIdentity `json:"workIdentity"`
}

func (p *macUpdatePlan) swapWithDirectories(expected, staged macNodeIdentity, directories macSwapDirectories) error {
	return p.swapDirectories(expected, staged, directories, unix.Fsync)
}

func (p *macUpdatePlan) swapDirectories(expected, staged macNodeIdentity, directories macSwapDirectories, syncDirectory func(int) error) error {
	if err := validateMacWork(p.Work); err != nil {
		return err
	}
	current, err := macNode(p.Current.Path)
	if err != nil || current != expected {
		return errors.New("目标应用已被其他安装操作替换")
	}
	parent := filepath.Dir(p.Current.Path)
	canonical, err := macCanonical(parent)
	if err != nil || canonical != parent {
		return errors.New("目标应用父目录已变化")
	}
	parentFD, err := unix.Open(parent, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer unix.Close(parentFD)
	workFD, err := unix.Open(p.Work, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer unix.Close(workFD)
	for _, item := range []struct {
		fd     int
		path   string
		node   macNodeIdentity
		stable macFilesystemIdentity
	}{{parentFD, parent, directories.Parent, directories.ParentStable}, {workFD, p.Work, directories.Work, directories.WorkStable}} {
		var stat unix.Stat_t
		if err = unix.Fstat(item.fd, &stat); err != nil {
			return err
		}
		actual := macNodeIdentity{uint64(stat.Dev), stat.Ino}
		if stat.Mode&unix.S_IFMT != unix.S_IFDIR || actual != item.node || item.stable.FileID != stat.Ino ||
			item.stable.BirthSec != stat.Btim.Sec || item.stable.BirthNsec != stat.Btim.Nsec {
			return errors.New("交换目录FD不属于已授权的父目录或工作目录")
		}
		linked, err := macNode(item.path)
		if err != nil || linked != actual {
			return errors.New("交换目录路径与已授权FD的关联已改变")
		}
	}
	var targetStat, stagedStat unix.Stat_t
	if err = unix.Fstatat(parentFD, filepath.Base(p.Current.Path), &targetStat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return err
	}
	if err = unix.Fstatat(workFD, "next.app", &stagedStat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return err
	}
	targetID := macNodeIdentity{uint64(targetStat.Dev), targetStat.Ino}
	stagedID := macNodeIdentity{uint64(stagedStat.Dev), stagedStat.Ino}
	if targetStat.Mode&unix.S_IFMT != unix.S_IFDIR || stagedStat.Mode&unix.S_IFMT != unix.S_IFDIR || targetID != expected || stagedID != staged || targetStat.Dev != stagedStat.Dev {
		return errors.New("交换前目录FD身份、类型或卷已变化")
	}
	if err := unix.RenameatxNp(workFD, "next.app", parentFD, filepath.Base(p.Current.Path), unix.RENAME_SWAP|unix.RENAME_NOFOLLOW_ANY); err != nil {
		return fmt.Errorf("原子交换应用失败：%w", err)
	}
	// The rename already happened. Attempt both directory flushes even when the first fails.
	return errors.Join(syncDirectory(parentFD), syncDirectory(workFD))
}
