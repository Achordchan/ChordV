//go:build e2e && darwin

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type e2eOwnedProcess struct {
	PID      int    `json:"pid"`
	Binary   string `json:"binary"`
	Identity string `json:"identity"`
}
type e2eWatchdogReceipt struct {
	Process    e2eOwnedProcess `json:"process"`
	ParentPID  int             `json:"parentPid"`
	APIBase    string          `json:"apiBase"`
	DataDir    string          `json:"dataDir"`
	StatePath  string          `json:"statePath"`
	Automation string          `json:"automation"`
}
type e2eWatchdogTarget struct {
	command *exec.Cmd
	process e2eOwnedProcess
	done    chan struct{}
}

const e2eWatchdogReceiptName = ".e2e-watchdog-process.json"
const e2eWatchdogResultName = ".e2e-watchdog-result.json"

// Go test二进制不执行应用main：这里只分发子进程角色，恢复仍调用真实生产函数。
func init() {
	if len(os.Args) == 2 && os.Args[1] == "--e2e-watchdog-owned-target" {
		fmt.Println("E2E_OWNED_TARGET_READY")
		for {
			time.Sleep(time.Hour)
		}
	}
	if len(os.Args) != 3 {
		return
	}
	var err error
	switch os.Args[1] {
	case "--proxy-watchdog":
		state := os.Getenv("CHORDV_E2E_PROXY_STATE")
		if state == "" {
			fmt.Fprintln(os.Stderr, "测试watchdog缺少文件profile")
			os.Exit(2)
		}
		if err = installE2EFileProxy(state); err == nil {
			var process e2eOwnedProcess
			process, err = e2eCurrentProcess(os.Getpid())
			if err == nil {
				err = atomicJSON(filepath.Join(os.Args[2], e2eWatchdogReceiptName), e2eWatchdogReceipt{Process: process, ParentPID: os.Getppid(), APIBase: os.Getenv("CHORDV_API_BASE_URL"), DataDir: os.Getenv("CHORDV_MYGO_DATA_DIR"), StatePath: state, Automation: os.Getenv("MYGO_AUTOMATION")})
			}
			if err == nil {
				err = runProxyWatchdog(os.Args[2])
			}
			message := ""
			if err != nil {
				message = err.Error()
			}
			_ = atomicJSON(filepath.Join(os.Args[2], e2eWatchdogResultName), map[string]string{"error": message})
		}
	case "--e2e-watchdog-holder":
		err = runE2EWatchdogHolder(os.Args[2])
	default:
		return
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(3)
	}
	os.Exit(0)
}

func e2eCurrentProcess(pid int) (e2eOwnedProcess, error) {
	identity, err := processIdentity(context.Background(), pid)
	if err != nil {
		return e2eOwnedProcess{}, err
	}
	binary, err := processExecutable(context.Background(), pid)
	return e2eOwnedProcess{PID: pid, Binary: binary, Identity: identity}, err
}

func trackE2EWatchdogTarget(command *exec.Cmd) (*e2eWatchdogTarget, error) {
	if err := command.Start(); err != nil {
		return nil, err
	}
	target := &e2eWatchdogTarget{command: command, done: make(chan struct{})}
	go func() { _ = command.Wait(); close(target.done) }()
	process, err := e2eCurrentProcess(command.Process.Pid)
	if err != nil {
		target.stop()
		return nil, err
	}
	target.process = process
	return target, nil
}

func startE2EWatchdogTarget() (*e2eWatchdogTarget, error) {
	binary, err := os.Executable()
	if err != nil {
		return nil, err
	}
	command := exec.Command(binary, "--e2e-watchdog-owned-target")
	command.Env = systemProcessEnvironment()
	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, err
	}
	target, err := trackE2EWatchdogTarget(command)
	if err != nil {
		return nil, err
	}
	ready := make(chan error, 1)
	go func() {
		line, err := bufio.NewReader(stdout).ReadString('\n')
		if err == nil && line != "E2E_OWNED_TARGET_READY\n" {
			err = errors.New("测试目标握手无效")
		}
		ready <- err
	}()
	select {
	case err := <-ready:
		if err != nil {
			target.stop()
			return nil, err
		}
	case <-time.After(3 * time.Second):
		target.stop()
		return nil, errors.New("测试目标启动超时")
	}
	return target, nil
}

func (target *e2eWatchdogTarget) stop() {
	select {
	case <-target.done:
		return
	default:
	}
	_ = target.command.Process.Kill()
	<-target.done
}

func stopE2ERecordedProcess(expected e2eOwnedProcess) {
	if expected.PID <= 0 || expected.PID == os.Getpid() {
		return
	}
	current, err := e2eCurrentProcess(expected.PID)
	if err != nil || current != expected {
		return
	}
	process, err := os.FindProcess(expected.PID)
	if err == nil {
		_ = process.Kill()
	}
}

func readE2EWatchdogReceipt(dir string) (e2eWatchdogReceipt, error) {
	var receipt e2eWatchdogReceipt
	data, err := os.ReadFile(filepath.Join(dir, e2eWatchdogReceiptName))
	if err == nil {
		err = json.Unmarshal(data, &receipt)
	}
	return receipt, err
}

func cleanupE2EWatchdog(dir string, guard *proxyWatchdog, target *e2eWatchdogTarget) {
	// 失败清理先终止已验证的watchdog，再处理测试目标，绝不把testrunner当内核。
	if receipt, err := readE2EWatchdogReceipt(dir); err == nil {
		stopE2ERecordedProcess(receipt.Process)
	}
	if guard != nil {
		_ = guard.Close()
		select {
		case <-guard.done:
		case <-time.After(3 * time.Second):
		}
	}
	if target != nil {
		target.stop()
	}
}

func runE2EWatchdogHolder(dir string) error {
	if os.Getenv("CHORDV_E2E_PROXY_STATE") == "" {
		return errors.New("holder缺少文件profile")
	}
	cfg, err := loadConfig()
	if err != nil || cfg.DataDir != dir {
		return errors.New("holder目录不匹配")
	}
	target, err := startE2EWatchdogTarget()
	if err != nil {
		return err
	}
	var guard *proxyWatchdog
	defer func() { cleanupE2EWatchdog(dir, guard, target) }()
	if err := atomicJSON(filepath.Join(dir, ".e2e-holder-target.json"), target.process); err != nil {
		return err
	}
	service := newDesktopService(cfg)
	defer service.cancel()
	guard, err = service.takeProxy(context.Background(), 41001, 41002, target.process.PID, target.process.Binary, false)
	if err != nil {
		return err
	}
	if err := json.NewEncoder(os.Stdout).Encode(map[string]any{"holderPid": os.Getpid(), "target": target.process}); err != nil {
		return err
	}
	_, err = io.Copy(io.Discard, os.Stdin)
	return err
}

func e2eRecordedProcessAlive(expected e2eOwnedProcess) bool {
	current, err := e2eCurrentProcess(expected.PID)
	if err != nil || current != expected {
		return false
	}
	state, err := commandOutput(context.Background(), "/bin/ps", "-p", fmt.Sprint(expected.PID), "-o", "stat=")
	return err == nil && !strings.Contains(state, "Z")
}
