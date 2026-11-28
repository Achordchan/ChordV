//go:build linux

package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func linuxGNOMEBackend() (gnomeProxyBackend, error) {
	session := gnomeSessionEnvironment(os.Environ())
	if len(session) == 0 || os.Geteuid() == 0 {
		return gnomeProxyBackend{}, errors.New("仅支持GNOME桌面登录用户的本地D-Bus代理设置；当前会话不受支持")
	}
	directory := os.Getenv("XDG_RUNTIME_DIR")
	info, err := os.Stat(directory)
	if err != nil || !info.IsDir() {
		return gnomeProxyBackend{}, errors.New("GNOME用户运行目录无效")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Geteuid()) || info.Mode().Perm() != 0700 {
		return gnomeProxyBackend{}, errors.New("GNOME用户运行目录身份或权限无效")
	}
	binary, err := exec.LookPath("gsettings")
	if err != nil {
		return gnomeProxyBackend{}, errors.New("GNOME代理需要系统gsettings命令")
	}
	environment := append(systemProcessEnvironment(), "GSETTINGS_BACKEND=dconf")
	scope, err := gnomeProxyNamespace(environment)
	if err != nil {
		return gnomeProxyBackend{}, err
	}
	return gnomeProxyBackend{scope: scope, run: func(ctx context.Context, args ...string) (string, error) {
		if current, err := gnomeProxyNamespace(environment); err != nil || current != scope {
			return "", errors.New("GNOME代理配置空间在操作期间改变")
		}
		ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, binary, args...)
		command.Env = environment
		output, err := command.Output()
		if err != nil {
			if ctx.Err() != nil {
				return "", ctx.Err()
			}
			return "", errors.New("gsettings操作失败，请检查GNOME会话或策略权限")
		}
		if len(output) > 65536 {
			return "", errors.New("gsettings返回内容过大")
		}
		if current, err := gnomeProxyNamespace(environment); err != nil || current != scope {
			return "", errors.New("GNOME代理配置空间在操作期间改变")
		}
		return string(output), nil
	}}, nil
}
func platformReadProxy(ctx context.Context) ([]proxySetting, error) {
	backend, err := linuxGNOMEBackend()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	setting, err := backend.read(ctx)
	if err != nil {
		return nil, err
	}
	return []proxySetting{setting}, nil
}
func platformWriteProxy(ctx context.Context, setting proxySetting) error {
	backend, err := linuxGNOMEBackend()
	if err != nil {
		return err
	}
	expected, ok := ctx.Value(proxyExpectationKey{}).(proxySetting)
	if !ok {
		return errors.New("GNOME代理写入缺少预期快照")
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	return backend.write(ctx, setting, expected)
}
func processIdentity(ctx context.Context, pid int) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	raw, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		return "", err
	}
	identity, err := linuxProcessStarttime(raw, pid)
	if err != nil {
		return "", err
	}
	boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return "", err
	}
	id := strings.TrimSpace(string(boot))
	if len(id) != 36 || strings.ContainsAny(id, "\n\r\x00:") {
		return "", errors.New("Linux启动标识无效")
	}
	return identity + ":" + id, nil
}
func processExecutable(ctx context.Context, pid int) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return os.Readlink(filepath.Join("/proc", strconv.Itoa(pid), "exe"))
}
