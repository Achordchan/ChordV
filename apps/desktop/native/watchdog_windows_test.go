//go:build windows

package main

import "os/exec"

func prepareHolderGroup(cmd *exec.Cmd)    { hideCommandWindow(cmd) }
func killHolderGroup(cmd *exec.Cmd) error { return cmd.Process.Kill() }
