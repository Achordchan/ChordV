//go:build darwin

package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

var errMacTargetLaunchBusy = errors.New("该应用正在更新或有实例启动，未取得应用启动锁")

// The lock is per installed path, not per DataDir. Keep it outside the bundle
// and its parent so read-only installs also participate. Never unlink it while
// either side may hold a descriptor. This is cooperative exclusion, not authority.
func lockMacTargetLaunch(target string, exclusive bool) (*os.File, error) {
	uid := uint32(os.Getuid())
	// Use the operating system's per-user directory, not HOME, TMPDIR or the
	// temporary/cache subdirectories whose entries can be aged out while open.
	userDir, err := runMacUpdateCommand(context.Background(), 3*time.Second, "/usr/bin/getconf", "DARWIN_USER_DIR")
	if err != nil {
		return nil, err
	}
	path := strings.TrimSpace(string(userDir))
	if !filepath.IsAbs(path) {
		return nil, errors.New("应用启动锁缺少系统用户目录")
	}
	base, err := macCanonical(path)
	if err != nil {
		return nil, errors.Join(err, errors.New("应用启动锁缺少系统用户目录"))
	}
	root := filepath.Join(base, "chordv-launch-gates")
	if err := os.Mkdir(root, 0700); err != nil && !os.IsExist(err) {
		return nil, err
	}
	dir, err := unix.Open(root, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	defer unix.Close(dir)
	var stat unix.Stat_t
	if err = unix.Fstat(dir, &stat); err != nil || stat.Uid != uid || stat.Mode&0777 != 0700 {
		return nil, errors.Join(err, errors.New("应用启动锁目录身份无效"))
	}
	name := macPlanDigest([]byte(strings.ToLower(target)))[:32] + ".lock"
	fd, err := unix.Openat(dir, name, unix.O_CREAT|unix.O_RDWR|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0600)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), filepath.Join(root, name))
	if err = unix.Fstat(fd, &stat); err != nil || stat.Mode&unix.S_IFMT != unix.S_IFREG || stat.Mode&0777 != 0600 || stat.Uid != uid || stat.Nlink != 1 {
		file.Close()
		return nil, errors.Join(err, errors.New("应用启动锁文件身份无效"))
	}
	mode := unix.LOCK_SH
	if exclusive {
		mode = unix.LOCK_EX
	}
	if err = unix.Flock(fd, mode|unix.LOCK_NB); err != nil {
		file.Close()
		if errors.Is(err, unix.EWOULDBLOCK) {
			return nil, errMacTargetLaunchBusy
		}
		return nil, err
	}
	return file, nil
}

func beginMacDesktopLaunch(health *macUpdateHealthClient) (*os.File, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	exe, err = macCanonical(exe)
	if err != nil {
		return nil, err
	}
	target := filepath.Dir(filepath.Dir(filepath.Dir(exe)))
	if !strings.HasSuffix(target, ".app") || filepath.Dir(exe) != filepath.Join(target, "Contents", "MacOS") {
		return nil, nil // The unpackaged MyGo development entry is not an install target.
	}
	lock, err := lockMacTargetLaunch(target, false)
	if errors.Is(err, errMacTargetLaunchBusy) && health != nil {
		// beginMacUpdateHealth has already authenticated the signed live helper.
		// That helper owns the exclusive gate through this candidate's readiness.
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if running, err := macHealthProcessPath(os.Getpid()); err != nil || running != exe {
		lock.Close()
		return nil, errors.Join(err, errors.New("启动期间应用程序位置已改变"))
	}
	return lock, nil
}
