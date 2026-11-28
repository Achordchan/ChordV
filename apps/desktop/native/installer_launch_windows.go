//go:build windows

package main

import (
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

func startWindowsInstaller(path string) error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return err
	}
	commandLine, err := nsisInstallerCommandLine(path, filepath.Dir(executable))
	if err != nil {
		return err
	}
	cmd := exec.Command(path)
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: commandLine}
	if err = cmd.Start(); err != nil {
		return err
	}
	go func() {
		if err := cmd.Wait(); err != nil {
			log.Print("Windows 安装程序已退出：", err)
		}
	}()
	return nil
}
