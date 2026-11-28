package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"
)

type runtimeInterruption struct {
	Cause         string `json:"cause"`
	ProxyRestored bool   `json:"proxyRestored"`
	Message       string `json:"message"`
}

func (s *DesktopService) connect(ctx context.Context, config runtimeConfig, force bool) (any, error) {
	if err := s.waitStartup(ctx); err != nil {
		return nil, err
	}
	s.operationMu.Lock()
	defer s.operationMu.Unlock()
	if s.installing {
		return nil, errors.New("正在交接更新安装，请等待应用退出")
	}
	if err := requireUnusedMacUpdateJournal(s.cfg.DataDir); err != nil {
		return nil, err
	}
	if err := validateRuntimeConfig(config); err != nil {
		return nil, err
	}
	s.mu.Lock()
	active := s.runtime.process != nil
	s.mu.Unlock()
	if active {
		return nil, errors.New("已有连接正在运行，请先断开")
	}
	if err := localPortAvailable(config.LocalHTTPPort); err != nil {
		return nil, err
	}
	if err := localPortAvailable(config.LocalSocksPort); err != nil {
		return nil, err
	}
	release, err := lockRuntimeMutation(s.cfg.DataDir)
	if err != nil {
		return nil, err
	}
	defer release()
	for _, kind := range []string{"xray", "geoip", "geosite"} {
		path, _ := s.componentPath(kind)
		record, err := s.componentMetadata(kind)
		if err != nil {
			return nil, fmt.Errorf("%s 组件尚未准备完成", kind)
		}
		if err = verifyFile(path, record.InstalledSHA256, record.InstalledSize); err != nil {
			return nil, fmt.Errorf("%s 组件校验失败", kind)
		}
	}
	binary, _ := s.componentPath("xray")
	runtimeDir := filepath.Join(s.cfg.DataDir, "runtime")
	configPath := filepath.Join(runtimeDir, "config.json")
	logPath := filepath.Join(runtimeDir, "xray.log")
	if err := atomicJSON(configPath, buildXrayConfig(config, logPath)); err != nil {
		return nil, err
	}
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	process := exec.Command(binary, "run", "-config", configPath)
	process.Dir = s.binDir()
	process.Env = append(systemProcessEnvironment(), "XRAY_LOCATION_ASSET="+s.binDir())
	process.Stdout = logFile
	process.Stderr = logFile
	hideCommandWindow(process)
	if err = process.Start(); err != nil {
		logFile.Close()
		return nil, errors.New("运行内核启动失败，请检查组件版本")
	}
	done := make(chan struct{})
	s.mu.Lock()
	s.runtime = runtimeState{Status: "connecting", PlatformTarget: platformName(), ActiveSessionID: pointer(config.SessionID), ActiveNodeID: pointer(config.Node.ID), ActiveNodeName: pointer(config.Node.Name), ConfigPath: &configPath, LogPath: &logPath, XrayBinaryPath: &binary, ActivePID: pointer(process.Process.Pid), Config: &config, process: process, processDone: done}
	s.mu.Unlock()
	go func() {
		err := process.Wait()
		logFile.Close()
		s.mu.Lock()
		if s.runtime.process == process {
			s.runtime.processErr = err
		}
		s.mu.Unlock()
		close(done)
		s.runtimeExited(process)
	}()
	if err = waitRuntimeReady(ctx, done, config.LocalHTTPPort, config.LocalSocksPort); err != nil {
		_ = process.Process.Kill()
		<-done
		s.mu.Lock()
		s.runtime.Status = "error"
		s.runtime.LastError = pointer(err.Error())
		s.runtime.process = nil
		s.runtime.ActivePID = nil
		s.mu.Unlock()
		return nil, err
	}
	pipe, err := s.takeProxy(ctx, config.LocalHTTPPort, config.LocalSocksPort, process.Process.Pid, binary, force)
	if err != nil {
		_ = process.Process.Kill()
		<-done
		s.mu.Lock()
		s.runtime.Status = "error"
		s.runtime.LastError = pointer(err.Error())
		s.runtime.process = nil
		s.runtime.ActivePID = nil
		s.mu.Unlock()
		return nil, err
	}
	err = runtimeStartupError(ctx, done)
	if err == nil {
		select {
		case <-pipe.done:
			err = errors.New("代理恢复进程在连接建立前退出")
		default:
		}
	}
	if err != nil {
		_ = process.Process.Kill()
		<-done
		err = errors.Join(err, restoreProxyJournal(s.cfg.DataDir, false))
		_ = pipe.Close()
		s.mu.Lock()
		s.runtime.Status = "error"
		s.runtime.LastError = pointer(err.Error())
		s.runtime.process = nil
		s.runtime.ActivePID = nil
		s.mu.Unlock()
		return nil, err
	}
	s.mu.Lock()
	s.runtime.Status = "connected"
	s.runtime.LastStartedAt = pointer(time.Now().UTC().Format(time.RFC3339))
	s.runtime.watchdog = pipe
	heartbeatCtx, cancel := context.WithCancel(s.ctx)
	s.runtime.heartbeatCancel = cancel
	status := s.runtime
	s.mu.Unlock()
	go s.leaseHeartbeatLoop(heartbeatCtx, config)
	go s.monitorWatchdog(pipe)
	s.publish("chordv://runtime-status", status)
	return map[string]any{"ok": true, "configPath": configPath, "logPath": logPath, "activePid": process.Process.Pid}, nil
}

func waitRuntimeReady(ctx context.Context, done <-chan struct{}, ports ...int) error {
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-done:
			return errors.New("运行内核在连接建立前退出，请查看日志")
		case <-deadline.C:
			return errors.New("运行内核未能打开本地代理端口")
		case <-tick.C:
			ready := true
			for _, port := range ports {
				conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 100*time.Millisecond)
				if err != nil {
					ready = false
					break
				}
				conn.Close()
			}
			if ready {
				return runtimeStartupError(ctx, done)
			}
		}
	}
}

func runtimeStartupError(ctx context.Context, done <-chan struct{}) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case <-done:
		return errors.New("运行内核在连接建立前退出，请查看日志")
	default:
		return nil
	}
}

func (s *DesktopService) runtimeExited(process *exec.Cmd) {
	s.operationMu.Lock()
	defer s.operationMu.Unlock()
	s.mu.Lock()
	if s.runtime.process != process {
		s.mu.Unlock()
		return
	}
	if s.runtime.heartbeatCancel != nil {
		s.runtime.heartbeatCancel()
	}
	pipe := s.runtime.watchdog
	s.runtime.process = nil
	s.runtime.ActivePID = nil
	s.runtime.Status = "error"
	s.runtime.LastError = pointer("运行内核意外退出，连接已断开")
	s.mu.Unlock()
	if err := restoreProxyJournal(s.cfg.DataDir, false); err != nil {
		s.publish("chordv://runtime-interrupted", runtimeInterruption{Cause: "kernel-exited", ProxyRestored: false, Message: "运行内核意外退出，系统代理恢复未完成，请重试断开连接。原因：" + err.Error()})
	}
	if pipe != nil {
		pipe.Close()
	}
	s.publish("chordv://runtime-status", map[string]string{"status": "error", "lastError": "运行内核意外退出，连接已断开"})
}

func (s *DesktopService) disconnect() (any, error) {
	if errors.Is(s.waitStartup(context.Background()), errMacRecoveryExitArmed) {
		// Startup already restored the proxy and never opened a runtime.
		// A disconnect must not clear the startup barrier during this exit.
		return map[string]bool{"ok": true}, nil
	}
	s.operationMu.Lock()
	defer s.operationMu.Unlock()
	return s.disconnectLocked()
}

func (s *DesktopService) disconnectLocked() (any, error) {
	s.mu.Lock()
	process := s.runtime.process
	done := s.runtime.processDone
	pipe := s.runtime.watchdog
	if s.runtime.heartbeatCancel != nil {
		s.runtime.heartbeatCancel()
	}
	s.runtime.Status = "disconnecting"
	s.mu.Unlock()
	if process != nil && process.Process != nil {
		_ = process.Process.Kill()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			return nil, errors.New("运行内核尚未退出，系统代理恢复待重试")
		}
	}
	if err := restoreProxyJournal(s.cfg.DataDir, false); err != nil {
		s.mu.Lock()
		s.runtime.Status = "error"
		s.runtime.LastError = pointer(err.Error())
		s.mu.Unlock()
		return nil, err
	}
	if pipe != nil {
		pipe.Close()
	}
	s.mu.Lock()
	s.runtime = runtimeState{Status: "idle", PlatformTarget: platformName()}
	s.startupErr = nil
	s.mu.Unlock()
	s.publish("chordv://runtime-status", map[string]string{"status": "idle"})
	return map[string]bool{"ok": true}, nil
}

func (s *DesktopService) waitStartup(ctx context.Context) error {
	if s.startupDone != nil {
		select {
		case <-s.startupDone:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.startupErr
}

func (s *DesktopService) monitorWatchdog(watchdog *proxyWatchdog) {
	<-watchdog.done
	_ = s.waitStartup(context.Background())
	// Keep the ownership check and disconnect serialized with reconnects.
	s.operationMu.Lock()
	defer s.operationMu.Unlock()
	s.mu.Lock()
	active := s.runtime.watchdog == watchdog && s.runtime.Status == "connected"
	s.mu.Unlock()
	if !active {
		return
	}
	_, err := s.disconnectLocked()
	message := "代理恢复进程已退出，连接已断开，请重新连接。"
	if err != nil {
		message = "代理恢复进程已退出，系统代理恢复未完成，请重试断开连接。原因：" + err.Error()
	}
	s.publish("chordv://runtime-interrupted", runtimeInterruption{Cause: "watchdog-exited", ProxyRestored: err == nil, Message: message})
}

func (s *DesktopService) runtimeLogs() (any, error) {
	path := filepath.Join(s.cfg.DataDir, "runtime", "xray.log")
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return map[string]string{"log": ""}, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if info.Size() > 256*1024 {
		if _, err = f.Seek(-256*1024, io.SeekEnd); err != nil {
			return nil, err
		}
	}
	data, err := io.ReadAll(io.LimitReader(f, 256*1024))
	return map[string]string{"log": string(data)}, err
}
