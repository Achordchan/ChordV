package durable

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// AcquireProcessLock holds one writer for the complete identity/database
// lifecycle. SQLite transactions alone cannot stop two agents from sampling
// the same Xray counters under competing boot IDs.
func AcquireProcessLock(databasePath string) (func(), error) {
	if err := os.MkdirAll(filepath.Dir(databasePath), 0700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(databasePath+".lock", os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, fmt.Errorf("无法打开 Agent 进程锁：%w", err)
	}
	stat, err := file.Stat()
	if err != nil || !stat.Mode().IsRegular() {
		file.Close()
		return nil, fmt.Errorf("Agent 进程锁必须是普通文件")
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		file.Close()
		return nil, fmt.Errorf("同一状态库已有 Agent 运行，拒绝重复注册或计量")
	}
	return func() { _ = file.Close() }, nil
}
