//go:build darwin

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

type macCleanupScope struct {
	target            string
	parent, workspace macFilesystemIdentity
	installed, staged macNodeIdentity
	helper            *macFilesystemIdentity
	detachedOnly      bool
}

func (d macSwapDirectories) cleanupScope(current macBundleInfo) macCleanupScope {
	return macCleanupScope{target: current.Path, parent: d.ParentStable, workspace: d.WorkStable, installed: current.Node}
}

func (scope *macCleanupScope) verifyDirectories(work *os.Root) error {
	if scope == nil {
		return nil
	}
	parent, _, err := readMacFilesystemNode(filepath.Dir(scope.target))
	if err != nil || parent != scope.parent {
		return errors.New("更新的应用父目录已变化，保留更新目录")
	}
	identity, live, err := readMacFilesystemNode(work.Name())
	if err != nil || identity != scope.workspace {
		return errors.New("更新工作目录不属于原事务，保留更新目录")
	}
	info, err := work.Stat(".")
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || info.Mode().Perm() != 0700 || stat.Uid != uint32(os.Getuid()) ||
		(macNodeIdentity{Device: uint64(stat.Dev), Inode: stat.Ino}) != live ||
		stat.Birthtimespec.Sec != identity.BirthSec || stat.Birthtimespec.Nsec != identity.BirthNsec {
		return errors.New("清理所用目录与更新事务工作目录不一致")
	}
	return nil
}

func (scope *macCleanupScope) verify(work *os.Root) error {
	if err := scope.verifyDirectories(work); err != nil {
		return err
	}
	if err := scope.verifyInstalled(); err != nil {
		return err
	}
	if err := scope.verifyHelper(work); err != nil || scope == nil || scope.staged == (macNodeIdentity{}) {
		return err
	}
	info, err := work.Lstat("next.app")
	if err != nil || !info.IsDir() {
		return errors.New("更新副本缺失或类型已变化，保留更新目录")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || (macNodeIdentity{Device: uint64(stat.Dev), Inode: stat.Ino}) != scope.staged {
		return errors.New("更新副本身份已变化，保留更新目录")
	}
	return nil
}

func (scope *macCleanupScope) verifyInstalled() error {
	if scope == nil || scope.installed == (macNodeIdentity{}) {
		return nil
	}
	if actual, err := macNode(scope.target); err != nil || actual != scope.installed {
		return errors.New("安装位置已变化，保留更新目录")
	}
	return nil
}

func (scope *macCleanupScope) verifyHelper(work *os.Root) error {
	if scope == nil || scope.helper == nil {
		return nil
	}
	identity, node, err := readMacFilesystemNode(filepath.Join(work.Name(), macUpdateHelperBundleName))
	if err != nil || identity != *scope.helper {
		return errors.New("更新助手副本已缺失或身份变化，保留更新目录")
	}
	info, err := work.Lstat(macUpdateHelperBundleName)
	if err != nil || !info.IsDir() {
		return errors.New("清理所用更新助手目录无效")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || (macNodeIdentity{Device: uint64(stat.Dev), Inode: stat.Ino}) != node {
		return errors.New("清理所用更新助手与原事务不一致")
	}
	return nil
}

func (scope *macCleanupScope) ownsHelperBundle(entry fs.DirEntry) bool {
	return scope != nil && scope.helper != nil && entry.Name() == macUpdateHelperBundleName && entry.IsDir()
}

func (scope *macCleanupScope) removeUpdateEntry(work *os.Root, name string) error {
	if name != macUpdateHelperBundleName {
		return work.Remove(name)
	}
	if scope == nil || scope.helper == nil {
		return errors.New("拒绝清理未记录归属的更新助手")
	}
	if err := scope.verifyDirectories(work); err != nil {
		return err
	}
	if err := scope.verifyInstalled(); err != nil {
		return err
	}
	if err := scope.verifyHelper(work); err != nil {
		return err
	}
	return work.RemoveAll(name)
}

func (p *macUpdatePlan) finishMacUpdate(phase string, candidate macBundleInfo) error {
	installed, staged := candidate.Node, p.Current.Node
	switch phase {
	case "healthy":
	case "rolled_back":
		installed, staged = p.Current.Node, candidate.Node
	default:
		return errors.New("不能清理未完成的更新")
	}
	if err := p.checkJournal(phase, candidate.CDHash); err != nil {
		return err
	}
	if err := p.verifyPlanBytes(); err != nil {
		return err
	}
	raw, err := readMacRecoveryFile(filepath.Join(p.Work, "transaction.json"))
	if err != nil || macPlanDigest(raw) != p.transactionSHA256 {
		return errors.New("更新事务已偏离准备时的原文，保留更新目录")
	}
	var transaction macUpdateTransaction
	if json.Unmarshal(raw, &transaction) != nil || transaction.Schema != 1 || transaction.ID != p.ID ||
		transaction.PlanSHA256 != p.planSHA256 || transaction.Current != p.Current || transaction.Candidate != candidate || transaction.Filesystem == nil {
		return errors.New("更新收尾事务的应用或文件身份不完整，保留更新目录")
	}
	scope := macCleanupScope{target: p.Current.Path, parent: transaction.Filesystem.Parent, workspace: transaction.Filesystem.Work, installed: installed, staged: staged, helper: p.HelperBundle}
	if err := cleanupMacUpdateWorkWithScope(p.Work, &scope); err != nil {
		return err
	}
	if err := syncMacUpdateDirectory(filepath.Dir(p.Work)); err != nil {
		return err
	}
	return p.clearJournal(phase, candidate.CDHash)
}

// Only the helper knows which journal revision and staged bundle it owns.
// The parent can discard its launch files and owned helper copy, never the staged candidate or image.
func cleanupMacParentWork(dir string, scope *macCleanupScope) error {
	if err := validateMacWork(dir); os.IsNotExist(err) {
		return assertMacWorkImageAbsent(dir)
	} else if err != nil {
		return err
	}
	work, err := os.OpenRoot(dir)
	if err != nil {
		return err
	}
	defer work.Close()
	if err := scope.verify(work); err != nil {
		return err
	}
	entries, err := fs.ReadDir(work.FS(), ".")
	if err != nil {
		return err
	}
	for _, e := range entries {
		if scope.ownsHelperBundle(e) {
			continue
		}
		if !e.Type().IsRegular() || (e.Name() != macUpdatePlanName && e.Name() != "helper" && e.Name() != "helper.log") {
			return errors.New("独立助手仍留有更新资料，未清理工作目录")
		}
		if e.Name() == "helper" && scope != nil && scope.helper != nil {
			return errors.New("更新目录中出现不属于本次操作的裸助手，已保留")
		}
	}
	if err := assertMacWorkImageAbsent(dir); err != nil {
		return err
	}
	if err := scope.verify(work); err != nil {
		return err
	}
	for _, e := range entries {
		if err := scope.removeUpdateEntry(work, e.Name()); err != nil {
			return err
		}
	}
	if err := scope.verifyDirectories(work); err != nil {
		return err
	}
	return os.Remove(dir)
}

func (p *macUpdatePlan) cancelPreparedWork() error {
	if p.Directories == nil {
		return errors.New("更新交接计划缺少清理所需的原始目录身份")
	}
	if p.lastJournalSHA256 != "" {
		if err := p.checkJournal("", ""); err != nil {
			return err
		}
	} else if err := requireUnusedMacUpdateJournal(p.DataDir); err != nil {
		return err
	}
	scope := p.Directories.cleanupScope(p.Current)
	scope.helper = p.HelperBundle
	if prepared := p.preparedCandidate; prepared.CDHash != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		actual, err := readMacBundle(ctx, prepared.Path, true)
		if err != nil {
			return errors.Join(errMacUpdateCandidateIdentity, err)
		}
		if err := p.requirePreparedCandidate(actual); err != nil {
			return err
		}
		scope.staged = prepared.Node
	}
	if err := cleanupMacUpdateWorkWithScope(p.Work, &scope); err != nil {
		return err
	}
	return p.clearJournal("", "")
}

func cleanupMacUpdateWorkWithScope(dir string, scope *macCleanupScope) error {
	if err := validateMacWork(dir); os.IsNotExist(err) {
		if scope != nil && scope.staged != (macNodeIdentity{}) {
			return err
		}
		return assertMacWorkImageAbsent(dir)
	} else if err != nil {
		return err
	}
	work, err := os.OpenRoot(dir)
	if err != nil {
		return err
	}
	defer work.Close()
	if err := scope.verify(work); err != nil {
		return err
	}
	if scope != nil && scope.detachedOnly {
		err = assertMacWorkImageAbsent(dir)
	} else {
		err = detachMacUpdateMount(dir)
	}
	if err != nil {
		return err
	}
	entries, err := fs.ReadDir(work.FS(), ".")
	if err != nil {
		return err
	}
	for _, entry := range entries {
		switch entry.Name() {
		case macUpdateHelperBundleName:
			if scope.ownsHelperBundle(entry) {
				continue
			}
		case "mount", "next.app":
			if entry.IsDir() {
				continue
			}
		case "helper":
			if (scope == nil || scope.helper == nil) && entry.Type().IsRegular() {
				continue
			}
		case macUpdatePlanName, "transaction.json", "helper.log", "image.dmg":
			if entry.Type().IsRegular() {
				continue
			}
		}
		return fmt.Errorf("更新工作目录含未知条目或类型，已保留：%s", entry.Name())
	}
	if err := scope.verify(work); err != nil {
		return err
	}
	// Never recursively remove the mountpoint, even after a verified detach.
	if err := work.Remove("mount"); err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := scope.verify(work); err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() == "next.app" {
			if err := work.RemoveAll("next.app"); err != nil {
				return err
			}
			break
		}
	}
	if err := scope.verifyDirectories(work); err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() == "mount" || entry.Name() == "next.app" {
			continue
		}
		if err := scope.removeUpdateEntry(work, entry.Name()); err != nil {
			return err
		}
	}
	if err := scope.verifyDirectories(work); err != nil {
		return err
	}
	return os.Remove(dir)
}
