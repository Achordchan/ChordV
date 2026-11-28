//go:build darwin || linux

package api

import (
	"errors"
	"os"
	"syscall"
)

func storageAvailableBytes(root *os.Root) (uint64, error) {
	directory, err := root.Open(".")
	if err != nil {
		return 0, err
	}
	defer directory.Close()
	var stat syscall.Statfs_t
	if err := syscall.Fstatfs(int(directory.Fd()), &stat); err != nil {
		return 0, err
	}
	if stat.Bsize <= 0 {
		return 0, errors.New("文件系统返回无效块大小")
	}
	return checkedStorageAvailableBytes(uint64(stat.Bavail), uint64(stat.Bsize))
}
