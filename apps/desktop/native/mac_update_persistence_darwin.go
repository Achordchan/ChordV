//go:build darwin

package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

func syncMacUpdateDirectory(path string) error {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	return unix.Fsync(fd)
}

func durableMacUpdateJSON(path string, value any) error {
	if err := atomicJSON(path, value); err != nil {
		return err
	}
	return syncMacUpdateDirectory(filepath.Dir(path))
}

func macUpdateTransactionBytes(transaction macUpdateTransaction) ([]byte, error) {
	data, err := json.MarshalIndent(transaction, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(data, '\n'), nil
}

func (p *macUpdatePlan) beginTransaction(ctx context.Context, candidate macBundleInfo) error {
	if err := p.verifyBoundDirectories(); err != nil {
		return err
	}
	helper, err := os.Executable()
	if err != nil {
		return err
	}
	helper, err = macCanonical(helper)
	if err != nil || p.HelperBundle == nil || helper != p.helperExecutable() {
		return errors.New("更新事务不属于当前独立助手")
	}
	identity, err := processIdentity(ctx, os.Getpid())
	if err != nil {
		return err
	}
	if err := p.verifyPlanBytes(); err != nil {
		return err
	}
	if err := p.verifyHelperBundle(ctx); err != nil {
		return err
	}
	transaction := macUpdateTransaction{Schema: 1, ID: p.ID, PlanSHA256: p.planSHA256, Current: p.Current, Candidate: candidate, HelperPID: os.Getpid(), HelperIdentity: identity, HelperExecutable: helper}
	transaction.Filesystem, err = captureMacUpdateFilesystem(p, candidate)
	if err != nil {
		return err
	}
	if transaction.Filesystem.Parent != p.Directories.ParentStable || transaction.Filesystem.Work != p.Directories.WorkStable {
		return errors.New("建立更新事务时父目录或工作目录已变化")
	}
	path := filepath.Join(p.Work, "transaction.json")
	data, err := macUpdateTransactionBytes(transaction)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(data)
	if err := errors.Join(writeErr, file.Sync(), file.Close()); err != nil {
		return err
	}
	if err := syncMacUpdateDirectory(p.Work); err != nil {
		return err
	}
	p.transactionSHA256 = macPlanDigest(data)
	return nil
}

// Serialize connection startup and component mutations with the update helper.
// Do not hold this lock during downloads or for the lifetime of a connection.
func lockRuntimeMutation(dataDir string) (func(), error) {
	dir, err := macCanonical(dataDir)
	if err != nil {
		return nil, err
	}
	if err = os.Mkdir(filepath.Join(dir, "updater"), 0700); err != nil && !os.IsExist(err) {
		return nil, err
	}
	lock, err := lockMacUpdateData(dir)
	if errors.Is(err, unix.EWOULDBLOCK) {
		return nil, errors.New("mac_update_pending: 数据目录正在使用，请稍后重试")
	}
	if err != nil {
		return nil, err
	}
	if err := requireUnusedMacUpdateJournal(dir); err != nil {
		lock.Close()
		return nil, err
	}
	return func() { _ = lock.Close() }, nil
}
