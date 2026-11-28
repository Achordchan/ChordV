//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

func hideCommandWindow(_ *exec.Cmd) {}

func detachWatchdog(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }
