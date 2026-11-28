//go:build !linux && !darwin && !windows

package main

import (
	"context"
	"errors"
	"os"
	"strconv"
)

func platformReadProxy(context.Context) ([]proxySetting, error) {
	return nil, errors.New("此版本尚未支持当前系统的代理设置")
}
func platformWriteProxy(context.Context, proxySetting) error {
	return errors.New("此版本尚未支持当前系统的代理设置")
}
func processIdentity(_ context.Context, pid int) (string, error) {
	data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	return string(data), err
}
func processExecutable(_ context.Context, pid int) (string, error) {
	return os.Readlink("/proc/" + strconv.Itoa(pid) + "/exe")
}
