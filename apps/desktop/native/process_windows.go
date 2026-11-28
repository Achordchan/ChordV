//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

func hideCommandWindow(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }

func detachWatchdog(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x00000200 | 0x00000008}
}
