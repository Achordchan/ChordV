//go:build darwin

package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"time"
)

var errMacUnexpectedHealthHelper = errors.New("更新健康服务端不是本次操作的独立签名助手")

func beginMacUpdateHealth() (*macUpdateHealthClient, error) {
	return dialMacUpdateHealth(verifyMacUpdateHealthHelper)
}

// The socket and operation ID select a session, not a trusted executable.
// Derive the one permitted helper location from this actual candidate bundle.
func verifyMacUpdateHealthHelper(pid int, operation string) error {
	executable, err := os.Executable()
	if err != nil {
		return errors.Join(errMacUnexpectedHealthHelper, err)
	}
	executable, err = macCanonical(executable)
	if err != nil {
		return errors.Join(errMacUnexpectedHealthHelper, err)
	}
	selfPath, err := macHealthProcessPath(os.Getpid())
	if err != nil || selfPath != executable {
		return errors.Join(errMacUnexpectedHealthHelper, err)
	}
	target := filepath.Dir(filepath.Dir(filepath.Dir(executable)))
	work := filepath.Join(filepath.Dir(target), ".chordv-mac-update-"+operation)
	helperPath := filepath.Join(work, macUpdateHelperBundleName)
	identity, err := macHealthProcessIdentity(pid)
	if err != nil {
		return errors.Join(errMacUnexpectedHealthHelper, err)
	}
	peerPath, err := macHealthProcessPath(pid)
	if err != nil || filepath.Dir(peerPath) != filepath.Join(helperPath, "Contents", "MacOS") {
		return errors.Join(errMacUnexpectedHealthHelper, err)
	}
	if err = validateMacWork(work); err != nil {
		return errors.Join(errMacUnexpectedHealthHelper, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	self, err := readMacBundle(ctx, target, true)
	if err != nil || self.Executable != executable || self.Build.Mode != buildMode {
		return errors.Join(errMacUnexpectedHealthHelper, err)
	}
	helper, err := readMacBundle(ctx, helperPath, true)
	if err != nil || helper.Executable != peerPath || helper.Build.Mode != buildMode {
		return errors.Join(errMacUnexpectedHealthHelper, err)
	}
	if err = validateMacSigning(self, helper, buildMode); err != nil {
		return errors.Join(errMacUnexpectedHealthHelper, err)
	}
	if err = verifyMacHealthProcessCDHash(os.Getpid(), self.CDHash); err != nil {
		return errors.Join(errMacUnexpectedHealthHelper, err)
	}
	if err = verifyMacHealthProcessCDHash(pid, helper.CDHash); err != nil {
		return errors.Join(errMacUnexpectedHealthHelper, err)
	}
	after, err := macHealthProcessIdentity(pid)
	if err != nil || after != identity {
		return errors.Join(errMacUnexpectedHealthHelper, err)
	}
	return ctx.Err()
}
