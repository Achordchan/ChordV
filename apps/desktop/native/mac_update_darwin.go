//go:build darwin

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type macUpdateHandoff struct {
	dir        string
	command    *exec.Cmd
	pipe       *os.File
	done       chan error
	lines      chan macHelperLine
	identity   string
	planSHA256 string
	cleanup    macCleanupScope
	armed      bool
	abortOnce  sync.Once
	abortErr   error
}

type macHelperLine struct {
	value string
	err   error
}

func (s *DesktopService) prepareMacUpdate(ctx context.Context, path string) (result any, resultErr error) {
	s.macUpdateMu.Lock()
	locked := true
	defer func() {
		if locked {
			s.macUpdateMu.Unlock()
		}
	}()
	if s.macUpdate != nil {
		return nil, errors.New("已有macOS安装交接，请先取消或完成")
	}
	if err := requireUnusedMacUpdateJournal(s.cfg.DataDir); err != nil {
		return nil, err
	}
	pending, err := s.validatedInstaller(path)
	if err != nil {
		return nil, err
	}
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	executable, err = macCanonical(executable)
	if err != nil {
		return nil, err
	}
	target := filepath.Dir(filepath.Dir(filepath.Dir(executable)))
	current, err := readMacBundle(ctx, target, true)
	if err != nil {
		return nil, err
	}
	if current.Executable != executable || current.Build.Mode != buildMode {
		return nil, errors.New("当前程序与应用bundle不一致")
	}
	if err := validateMacSigning(current, current, buildMode); err != nil {
		return nil, err
	}
	dir, err := os.MkdirTemp(filepath.Dir(target), ".chordv-mac-update-")
	if err != nil {
		return nil, fmt.Errorf("应用目录不可写，未启动替换：%w", err)
	}
	if err := os.Chmod(dir, 0700); err != nil {
		_ = os.Remove(dir)
		return nil, err
	}
	directories, err := readMacSwapDirectories(target, dir)
	if err != nil {
		return nil, fmt.Errorf("无法确认新建更新目录，已保留：%w", err)
	}
	scope := directories.cleanupScope(current)
	keep := false
	defer func() {
		if !keep {
			resultErr = errors.Join(resultErr, cleanupMacParentWork(dir, &scope))
		}
	}()
	dataDir, err := macCanonical(s.cfg.DataDir)
	if err != nil {
		return nil, err
	}
	p := macUpdatePlan{Schema: 1, ID: strings.TrimPrefix(filepath.Base(dir), ".chordv-mac-update-"), Work: dir, DataDir: dataDir, Repository: s.cfg.ReleaseRepository, PublicKey: s.cfg.ReleasePublicKey, APIBase: s.cfg.APIBase, ParentPID: os.Getpid(), ParentExecutable: executable, Current: current, Installer: *pending, Directories: &directories}
	p.ExtraRestartEnvironment, err = macUpdateRestartExtra(s.cfg)
	if err != nil {
		return nil, err
	}
	p.ParentIdentity, err = processIdentity(ctx, p.ParentPID)
	if err != nil {
		return nil, err
	}
	p.Installer.Path, err = macCanonical(pending.Path)
	if err != nil {
		return nil, err
	}
	if err = p.stageHelperBundle(ctx, &scope); err != nil {
		return nil, err
	}
	data, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return nil, err
	}
	if err = atomicFile(filepath.Join(dir, macUpdatePlanName), data, 0600); err != nil {
		return nil, err
	}
	if err = p.verifyBoundDirectories(); err != nil {
		return nil, err
	}
	h, err := launchMacUpdateHelper(dir, p.helperExecutable(), macPlanDigest(data), scope)
	if err != nil {
		return nil, err
	}
	s.macUpdate = h
	keep = true
	s.macUpdateMu.Unlock()
	locked = false
	err = h.expect(ctx, "CHORDV_MAC_UPDATE_READY", 3*time.Minute)
	s.macUpdateMu.Lock()
	if s.macUpdate != h {
		s.macUpdateMu.Unlock()
		return nil, errors.New("macOS更新准备已取消")
	}
	if err != nil {
		s.macUpdateMu.Unlock()
		abortErr := h.abort()
		s.macUpdateMu.Lock()
		if s.macUpdate == h && abortErr == nil {
			s.macUpdate = nil
		}
		s.macUpdateMu.Unlock()
		return nil, errors.Join(err, abortErr)
	}
	s.macUpdateMu.Unlock()
	return map[string]bool{"ok": true, "prepared": true}, nil
}

func (s *DesktopService) commitMacUpdate(ctx context.Context) (any, error) {
	s.macUpdateMu.Lock()
	defer s.macUpdateMu.Unlock()
	h := s.macUpdate
	if h == nil || h.armed {
		return nil, errors.New("没有可提交的macOS更新")
	}
	p, raw, err := readMacPlan(h.dir)
	if err != nil {
		return nil, err
	}
	if macPlanDigest(raw) != h.planSHA256 {
		return nil, errors.New("更新计划已偏离准备时的原文")
	}
	if err = p.verifyBoundDirectories(); err != nil {
		return nil, err
	}
	current, err := s.validatedInstaller(p.Installer.Path)
	if err != nil {
		return nil, err
	}
	s.pendingMu.Lock()
	defer s.pendingMu.Unlock()
	if err = p.verifyPendingSnapshot(current, s.pending); err != nil {
		return nil, err
	}
	if _, err = p.verifyCandidate(ctx); err != nil {
		return nil, err
	}
	if _, err = fmt.Fprintln(h.pipe, "ARM"); err != nil {
		return nil, err
	}
	if err = h.expect(ctx, "CHORDV_MAC_UPDATE_ARMED", 30*time.Second); err != nil {
		return nil, err
	}
	h.armed = true
	return map[string]bool{"ok": true, "handoffAccepted": true}, nil
}

func (p *macUpdatePlan) verifyPendingSnapshot(validated, cached *pendingInstaller) error {
	data, err := os.ReadFile(filepath.Join(p.DataDir, "updater", "pending.json"))
	if err != nil {
		return err
	}
	if len(data) > 2<<20 {
		return errors.New("当前安装记录过大")
	}
	var persisted pendingInstaller
	if json.Unmarshal(data, &persisted) != nil {
		return errors.New("当前安装记录无效")
	}
	for _, item := range []*pendingInstaller{validated, cached, &persisted} {
		if item == nil {
			return errors.New("当前安装记录已撤销")
		}
		copy := *item
		copy.Path, err = macCanonical(copy.Path)
		if err != nil || copy != p.Installer {
			return errors.New("准备期间当前安装包或发布授权已变化，请重新检查更新")
		}
	}
	return nil
}

func (s *DesktopService) abortMacUpdate() error {
	s.macUpdateMu.Lock()
	defer s.macUpdateMu.Unlock()
	if s.macUpdate == nil {
		return nil
	}
	// ACK commits the shared handoff; even a report-write failure still quits.
	if s.macUpdate.armed {
		return errors.New("应用更新交接已确认，不能取消")
	}
	err := s.macUpdate.abort()
	if err == nil {
		s.macUpdate = nil
	}
	return err
}

func launchMacUpdateHelper(dir, executable, digest string, scope macCleanupScope) (*macUpdateHandoff, error) {
	reader, writer, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(executable, "--chordv-mac-update-helper", dir)
	cmd.Env = systemProcessEnvironment()
	cmd.Stdin = reader
	detachWatchdog(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		reader.Close()
		writer.Close()
		return nil, err
	}
	logFile, err := os.OpenFile(filepath.Join(dir, "helper.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		reader.Close()
		writer.Close()
		return nil, err
	}
	defer logFile.Close()
	cmd.Stderr = logFile
	if err = cmd.Start(); err != nil {
		reader.Close()
		writer.Close()
		return nil, err
	}
	reader.Close()
	h := &macUpdateHandoff{dir: dir, planSHA256: digest, cleanup: scope, command: cmd, pipe: writer, done: make(chan error, 1), lines: make(chan macHelperLine, 4)}
	go func() { h.done <- cmd.Wait(); close(h.done) }()
	go func() {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 1024), 8192)
		for scanner.Scan() {
			h.lines <- macHelperLine{value: scanner.Text()}
		}
		h.lines <- macHelperLine{err: errors.Join(scanner.Err(), errors.New("独立安装进程输出已关闭"))}
		close(h.lines)
	}()
	h.identity, err = processIdentity(context.Background(), cmd.Process.Pid)
	if err == nil {
		_, err = fmt.Fprintln(writer, digest)
	}
	if err != nil {
		return nil, errors.Join(err, h.abort())
	}
	return h, nil
}

func (h *macUpdateHandoff) expect(ctx context.Context, wanted string, timeout time.Duration) error {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case line := <-h.lines:
		if line.err != nil {
			return line.err
		}
		if line.value != wanted {
			return fmt.Errorf("独立安装握手无效：%s", line.value)
		}
		return nil
	case err := <-h.done:
		return fmt.Errorf("独立安装进程提前退出：%v", err)
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return errors.New("独立安装进程握手超时")
	}
}

func (h *macUpdateHandoff) abort() error {
	h.abortOnce.Do(func() { h.abortErr = h.abortOwned() })
	return h.abortErr
}

func (h *macUpdateHandoff) abortOwned() error {
	_, _ = fmt.Fprintln(h.pipe, "CANCEL")
	_ = h.pipe.Close()
	select {
	case <-h.done:
	case <-time.After(macUpdateAbortTimeout):
		identity, err := processIdentity(context.Background(), h.command.Process.Pid)
		executable, exeErr := processExecutable(context.Background(), h.command.Process.Pid)
		if err != nil || exeErr != nil || identity != h.identity || executable != h.command.Path {
			return errors.New("无法确认独立安装进程身份，保留恢复目录")
		}
		if err = h.command.Process.Kill(); err != nil {
			return err
		}
		<-h.done
	}
	return cleanupMacParentWork(h.dir, &h.cleanup)
}
