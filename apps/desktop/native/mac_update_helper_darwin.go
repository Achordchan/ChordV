//go:build darwin

package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"golang.org/x/sys/unix"
)

var prepareMacUpdateBundle = func(ctx context.Context, p *macUpdatePlan) error { return p.stage(ctx) }

func macParentExitEvent(p *macUpdatePlan) (int, error) {
	if p.ParentPID != os.Getppid() {
		return -1, errors.New("独立安装进程不是原GUI的子进程")
	}
	identity, err := processIdentity(context.Background(), p.ParentPID)
	if err != nil || identity != p.ParentIdentity {
		return -1, errors.New("更新父进程身份不一致")
	}
	executable, err := processExecutable(context.Background(), p.ParentPID)
	if err != nil || executable != p.ParentExecutable {
		return -1, errors.New("更新父进程路径不一致")
	}
	fd, err := unix.Kqueue()
	if err != nil {
		return -1, err
	}
	var event unix.Kevent_t
	unix.SetKevent(&event, p.ParentPID, unix.EVFILT_PROC, unix.EV_ADD|unix.EV_ENABLE|unix.EV_ONESHOT)
	event.Fflags = unix.NOTE_EXIT
	if _, err = unix.Kevent(fd, []unix.Kevent_t{event}, nil, nil); err != nil {
		unix.Close(fd)
		return -1, err
	}
	identity, err = processIdentity(context.Background(), p.ParentPID)
	if err != nil || identity != p.ParentIdentity {
		unix.Close(fd)
		return -1, errors.New("更新父进程在事件注册时已改变")
	}
	return fd, nil
}

func waitMacParentExit(ctx context.Context, fd int, pid int) error {
	var wake unix.Kevent_t
	unix.SetKevent(&wake, 1, unix.EVFILT_USER, unix.EV_ADD|unix.EV_CLEAR)
	if _, err := unix.Kevent(fd, []unix.Kevent_t{wake}, nil, nil); err != nil {
		return err
	}
	stop, finished := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(finished)
		select {
		case <-ctx.Done():
			wake.Fflags = unix.NOTE_TRIGGER
			_, _ = unix.Kevent(fd, []unix.Kevent_t{wake}, nil, nil)
		case <-stop:
		}
	}()
	defer func() { close(stop); <-finished }()
	deadline := time.Now().Add(30 * time.Second)
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return errors.New("更新父进程未退出，未替换应用")
		}
		timeout := unix.NsecToTimespec(remaining.Nanoseconds())
		events := make([]unix.Kevent_t, 1)
		n, err := unix.Kevent(fd, nil, events, &timeout)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return err
		}
		if n == 1 && events[0].Filter == unix.EVFILT_PROC && events[0].Ident == uint64(pid) && events[0].Fflags&unix.NOTE_EXIT != 0 {
			return nil
		}
		if n == 1 && events[0].Filter == unix.EVFILT_USER {
			return ctx.Err()
		}
		return errors.New("未收到匹配父进程的退出事件，未替换应用")
	}
}

func macInputEvents(ctx context.Context, input *bufio.Reader, armed *atomic.Bool, cancel context.CancelFunc) <-chan string {
	events := make(chan string, 4)
	go func() {
		defer close(events)
		for {
			line, err := input.ReadString('\n')
			if err != nil {
				if !armed.Load() {
					cancel()
				}
				select {
				case events <- "EOF":
				case <-ctx.Done():
				}
				return
			}
			line = strings.TrimSpace(line)
			if len(line) > 128 || line != "ARM" && line != "CANCEL" {
				cancel()
				return
			}
			if line == "CANCEL" {
				cancel()
			}
			select {
			case events <- line:
			case <-ctx.Done():
				return
			}
			if line == "CANCEL" {
				return
			}
		}
	}()
	return events
}

func (p *macUpdatePlan) verifyCurrent(ctx context.Context) error {
	current, err := readMacBundle(ctx, p.Current.Path, true)
	if err != nil {
		return err
	}
	if current.Node != p.Current.Node || current.CDHash != p.Current.CDHash || current.Identifier != p.Current.Identifier || current.Executable != p.ParentExecutable || current.Build != p.Current.Build || current.Build.Mode != buildMode {
		return errors.New("原应用身份或内容已变化，拒绝覆盖")
	}
	return validateMacSigning(p.Current, current, buildMode)
}

func runMacUpdateHelper(dir string) error {
	var open macRecoveryArmingProvider
	if macProtectedStartupRecoveryEnabled && buildMode == "release" {
		open = openMacUpdateRecoveryAuthority
	}
	return runMacUpdateHelperWithRecovery(dir, open)
}

// Opening an authority must not mutate it: the ARM handshake owns the first write.
type macRecoveryArmingProvider func(context.Context, *macUpdatePlan) (macRecoveryArmingAuthority, error)

func openMacUpdateRecoveryAuthority(ctx context.Context, plan *macUpdatePlan) (macRecoveryArmingAuthority, error) {
	// The helper's signed seal and running code hash were matched to Current.
	store, err := openMacRecoveryKeychainSlot(plan.Current, plan.Current.Path, plan.DataDir)
	if err != nil {
		return nil, err
	}
	if err := store.requireEmptyForUpdate(ctx); err != nil {
		return nil, err
	}
	return store, nil
}

func runMacUpdateHelperWithRecovery(dir string, open macRecoveryArmingProvider) (result error) {
	p, raw, err := readMacPlan(dir)
	if err != nil {
		return err
	}
	input := bufio.NewReaderSize(os.Stdin, 4096)
	hello, err := input.ReadString('\n')
	if err != nil || len(hello) > 128 || strings.TrimSpace(hello) != macPlanDigest(raw) {
		return errors.New("独立安装缺少私有管道授权")
	}
	p.planSHA256 = macPlanDigest(raw)
	helper, err := os.Executable()
	if err != nil {
		return err
	}
	helper, err = macCanonical(helper)
	if err != nil || p.HelperBundle == nil || helper != p.helperExecutable() {
		return errors.New("独立安装执行路径错误")
	}
	if err = p.verifyHelperBundle(context.Background()); err != nil {
		return err
	}
	if actual, err := macHealthProcessCDHash(os.Getpid()); err != nil || actual != p.Current.CDHash {
		return errors.New("运行中的独立安装助手与原应用签名不一致")
	}
	parentEvent, err := macParentExitEvent(p)
	if err != nil {
		return err
	}
	defer unix.Close(parentEvent)
	targetLock, err := p.targetLock()
	if err != nil {
		return err
	}
	defer targetLock.Close()
	lock, err := lockMacUpdateData(p.DataDir)
	if err != nil {
		if errors.Is(err, unix.EWOULDBLOCK) {
			return errors.New("另一独立应用更新尚未完成")
		}
		return err
	}
	defer lock.Close()
	// The GUI preflight can go stale before the helper acquires both locks.
	if err := requireUnusedMacUpdateJournal(p.DataDir); err != nil {
		return err
	}
	if err = p.verifyBoundDirectories(); err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var armed atomic.Bool
	var pending macRecoveryPendingArm
	events := macInputEvents(ctx, input, &armed, cancel)
	cleanup := true
	defer func() {
		if cleanup && !errors.Is(result, errMacUpdateCandidateIdentity) {
			result = errors.Join(result, p.cancelPreparedWork())
		}
		if result != nil {
			result = errors.Join(result, p.report(false, "自动更新未完成："+result.Error()))
		}
	}()
	if err = p.verifyCurrent(ctx); err != nil {
		return err
	}
	if err = prepareMacUpdateBundle(ctx, p); err != nil {
		return err
	}
	if err = p.verifyBoundDirectories(); err != nil {
		return err
	}
	var store macRecoveryArmingAuthority
	if open != nil {
		store, err = open(ctx, p)
		if err != nil || store == nil {
			return errors.Join(err, errors.New("受保护更新授权存储未就绪，未交接更新"))
		}
	}
	if _, err = fmt.Fprintln(os.Stdout, "CHORDV_MAC_UPDATE_READY"); err != nil {
		return err
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case event, ok := <-events:
			if !ok || event == "CANCEL" || event == "EOF" && !armed.Load() {
				return nil
			}
			if event == "ARM" {
				if armed.Load() {
					return errors.New("重复提交应用更新")
				}
				if err = p.verifyBoundDirectories(); err != nil {
					return err
				}
				if err = p.verifyCurrent(ctx); err != nil {
					return err
				}
				candidate, err := p.verifyPreparedCandidate(ctx)
				if err != nil {
					return err
				}
				if err = p.verifyHelperBundle(ctx); err != nil {
					return err
				}
				if store != nil {
					pending, err = p.pendingRecoveryArm(ctx, candidate)
					if err != nil {
						return err
					}
					// Even an uncertain reservation can have persisted. Do not
					// erase the records or either bundle without retirement.
					cleanup = false
					if err = store.reserve(ctx, pending); err != nil {
						return errors.Join(err, errors.New("受保护恢复预授权未确认，未提交更新交接"))
					}
				}
				if err = p.journal("armed", candidate.CDHash, ""); err != nil {
					return err
				}
				armed.Store(true)
				if _, err = fmt.Fprintln(os.Stdout, "CHORDV_MAC_UPDATE_ARMED"); err != nil {
					return err
				}
				continue
			}
			if event != "EOF" {
				return errors.New("独立安装协议无效")
			}
			if err = p.verifyBoundDirectories(); err != nil {
				return err
			}
			if err = p.journal("waiting_parent_exit", p.preparedCandidate.CDHash, ""); err != nil {
				return err
			}
			if err = waitMacParentExit(ctx, parentEvent, p.ParentPID); err != nil {
				return err
			}
			launchGate, err := lockMacTargetLaunch(p.Current.Path, true)
			if err != nil {
				return err
			}
			defer launchGate.Close()
			cleanup = false
			return p.apply(ctx, launchGate, store, pending)
		}
	}
}
