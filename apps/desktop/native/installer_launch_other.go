//go:build !windows

package main

import "errors"

func startWindowsInstaller(string) error {
	return errors.New("此安装操作仅适用于 Windows")
}
