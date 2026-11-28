//go:build !darwin && !linux

package api

import (
	"errors"
	"os"
)

func storageAvailableBytes(*os.Root) (uint64, error) {
	return 0, errors.New("当前服务端平台尚未实现磁盘可用空间查询")
}
