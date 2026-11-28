//go:build darwin

package main

import (
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync"

	"github.com/ebitengine/purego"
	"golang.org/x/sys/unix"
)

var macHealthProcPath struct {
	sync.Once
	fn  func(int32, *byte, uint32) int32
	err error
}

// Read the kernel process path, not a caller-controlled argv or a process name.
func macHealthProcessPath(pid int) (string, error) {
	macHealthProcPath.Do(func() {
		var lib uintptr
		lib, macHealthProcPath.err = purego.Dlopen("/usr/lib/libproc.dylib", purego.RTLD_NOW|purego.RTLD_LOCAL)
		if macHealthProcPath.err == nil {
			purego.RegisterLibFunc(&macHealthProcPath.fn, lib, "proc_pidpath")
		}
	})
	if macHealthProcPath.err != nil {
		return "", macHealthProcPath.err
	}
	buffer := make([]byte, 4096)
	if macHealthProcPath.fn(int32(pid), &buffer[0], uint32(len(buffer))) <= 0 {
		return "", fmt.Errorf("无法读取进程%d的内核路径", pid)
	}
	for i, b := range buffer {
		if b == 0 {
			return string(buffer[:i]), nil
		}
	}
	return "", errors.New("进程内核路径超过限制")
}

func macHealthProcessIdentity(pid int) (string, error) {
	info, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		return "", err
	}
	if int(info.Proc.P_pid) != pid || info.Proc.P_stat == 5 {
		return "", unix.ESRCH
	}
	if info.Eproc.Ucred.Uid != uint32(os.Getuid()) {
		return "", errors.New("更新进程UID不一致")
	}
	return strconv.FormatInt(info.Proc.P_starttime.Sec, 10) + ":" + strconv.FormatInt(int64(info.Proc.P_starttime.Usec), 10), nil
}

func macHealthPeer(conn *net.UnixConn) (pid int, uid uint32, err error) {
	raw, err := conn.SyscallConn()
	if err != nil {
		return 0, 0, err
	}
	var controlErr error
	err = raw.Control(func(fd uintptr) {
		var cred *unix.Xucred
		cred, controlErr = unix.GetsockoptXucred(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERCRED)
		if controlErr != nil {
			return
		}
		uid = cred.Uid
		pid, controlErr = unix.GetsockoptInt(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERPID)
	})
	return pid, uid, errors.Join(err, controlErr)
}

func macHealthPrivateSocket(path string) error {
	if !filepath.IsAbs(path) || len(path) > 100 || filepath.Base(path) != "health.sock" {
		return errors.New("更新健康socket路径无效")
	}
	dir := filepath.Dir(path)
	canonical, err := filepath.EvalSymlinks(dir)
	if err != nil || canonical != dir {
		return errors.New("更新健康目录不是规范路径")
	}
	if filepath.Dir(dir) != "/private/tmp" || len(filepath.Base(dir)) < 5 || filepath.Base(dir)[:4] != "cvh-" {
		return errors.New("更新健康目录不在私有临时位置")
	}
	for _, item := range []struct {
		path string
		mode os.FileMode
	}{{dir, os.ModeDir | 0700}, {path, os.ModeSocket | 0600}} {
		info, e := os.Lstat(item.path)
		if e != nil {
			return e
		}
		var stat unix.Stat_t
		if e = unix.Lstat(item.path, &stat); e != nil {
			return e
		}
		if stat.Uid != uint32(os.Getuid()) || info.Mode() != item.mode {
			return errors.New("更新健康socket或目录权限错误")
		}
	}
	return nil
}

var macHealthCodeSignature struct {
	sync.Once
	fn  func(int32, uint32, *byte, uintptr) int32
	err error
}

// CS_OPS_CDHASH is the read-only CodeDirectory query in Apple's bsd/sys/codesign.h.
// Query the running image as well as the on-disk bundle; equal paths alone are not identity.
func macHealthProcessCDHash(pid int) (string, error) {
	macHealthCodeSignature.Do(func() {
		var library, symbol uintptr
		library, macHealthCodeSignature.err = purego.Dlopen("/usr/lib/libSystem.B.dylib", purego.RTLD_NOW|purego.RTLD_LOCAL)
		if macHealthCodeSignature.err != nil {
			return
		}
		symbol, macHealthCodeSignature.err = purego.Dlsym(library, "csops")
		if macHealthCodeSignature.err == nil {
			purego.RegisterFunc(&macHealthCodeSignature.fn, symbol)
		}
	})
	if macHealthCodeSignature.err != nil {
		return "", macHealthCodeSignature.err
	}
	hash := make([]byte, 20)
	if macHealthCodeSignature.fn(int32(pid), 5, &hash[0], uintptr(len(hash))) != 0 {
		return "", errors.New("无法读取运行中候选的内核签名哈希")
	}
	nonzero := false
	for _, b := range hash {
		nonzero = nonzero || b != 0
	}
	if !nonzero {
		return "", errors.New("运行中候选缺少内核签名哈希")
	}
	return hex.EncodeToString(hash), nil
}

func verifyMacHealthProcessCDHash(pid int, expected string) error {
	actual, err := macHealthProcessCDHash(pid)
	if err != nil {
		return err
	}
	if !macHealthEqual(actual, expected) {
		return errors.New("运行中候选签名哈希与授权安装包不一致")
	}
	return nil
}
