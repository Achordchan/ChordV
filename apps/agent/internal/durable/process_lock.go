package durable

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// AcquireProcessLock holds one writer for the complete identity/database
// lifecycle. SQLite transactions alone cannot stop two agents from sampling
// the same Xray counters under competing boot IDs.
func AcquireProcessLock(databasePath string) (func(), error) {
	if err := EnsureDir(filepath.Dir(databasePath)); err != nil {
		return nil, err
	}
	path := databasePath + ".lock"
	flags := syscall.O_NOFOLLOW | syscall.O_NONBLOCK
	legacyReadOnly := false
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_RDWR|flags, SecretMode)
	if err == nil {
		// Only adjust a file we just created. The service's umask may remove owner-write.
		if err = file.Chmod(SecretMode); err != nil {
			file.Close()
			return nil, err
		}
	} else if errors.Is(err, os.ErrExist) {
		file, err = os.OpenFile(path, os.O_RDWR|flags, 0)
		if errors.Is(err, os.ErrPermission) {
			// Old installations can have a 0400 lock. Local flock needs no write to its contents.
			file, err = os.OpenFile(path, os.O_RDONLY|flags, 0)
			legacyReadOnly = true
		}
	}
	if err != nil {
		return nil, fmt.Errorf("无法打开 Agent 进程锁：%w", err)
	}
	stat, err := file.Stat()
	if err != nil || !stat.Mode().IsRegular() {
		file.Close()
		return nil, fmt.Errorf("Agent 进程锁必须是普通文件")
	}
	if legacyReadOnly {
		owner, ok := stat.Sys().(*syscall.Stat_t)
		if !ok || owner.Uid != uint32(os.Geteuid()) || owner.Nlink != 1 || stat.Mode().Perm() != 0400 {
			file.Close()
			return nil, fmt.Errorf("旧版只读进程锁的权限或归属不符")
		}
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, fmt.Errorf("同一状态库已有 Agent 运行，拒绝重复注册或计量")
		}
		return nil, fmt.Errorf("无法锁定 Agent 状态库：%w", err)
	}
	return func() { _ = file.Close() }, nil
}
