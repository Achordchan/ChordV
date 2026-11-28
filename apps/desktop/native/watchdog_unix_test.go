//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

func prepareHolderGroup(cmd *exec.Cmd)    { cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }
func killHolderGroup(cmd *exec.Cmd) error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
