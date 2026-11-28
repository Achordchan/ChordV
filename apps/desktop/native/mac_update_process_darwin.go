//go:build darwin

package main

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

type macUpdateLaunchedProcess struct {
	PID        int
	identity   string
	executable string
	fd         int
	exited     chan struct{}
	stopped    chan struct{}
	closeOnce  sync.Once
	mu         sync.Mutex
	watchErr   error
}

func ownMacUpdateProcess(pid int, executable string) (*macUpdateLaunchedProcess, error) {
	identity, err := macHealthProcessIdentity(pid)
	if err != nil {
		return nil, err
	}
	actual, err := macHealthProcessPath(pid)
	if err != nil || actual != executable {
		return nil, errors.New("LaunchServices返回的进程路径不匹配")
	}
	fd, err := unix.Kqueue()
	if err != nil {
		return nil, err
	}
	p := &macUpdateLaunchedProcess{PID: pid, identity: identity, executable: executable, fd: fd, exited: make(chan struct{}), stopped: make(chan struct{})}
	var exit, wake unix.Kevent_t
	unix.SetKevent(&exit, pid, unix.EVFILT_PROC, unix.EV_ADD|unix.EV_ENABLE|unix.EV_ONESHOT)
	exit.Fflags = unix.NOTE_EXIT
	unix.SetKevent(&wake, 1, unix.EVFILT_USER, unix.EV_ADD|unix.EV_CLEAR)
	if _, err = unix.Kevent(fd, []unix.Kevent_t{exit, wake}, nil, nil); err != nil {
		unix.Close(fd)
		return nil, err
	}
	after, err := macHealthProcessIdentity(pid)
	if err != nil || after != identity {
		unix.Close(fd)
		return nil, errors.New("更新候选在退出事件注册期间已改变")
	}
	go p.watch()
	return p, nil
}

func (p *macUpdateLaunchedProcess) watch() {
	defer close(p.stopped)
	defer unix.Close(p.fd)
	events := make([]unix.Kevent_t, 1)
	for {
		n, err := unix.Kevent(p.fd, nil, events, nil)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			p.mu.Lock()
			p.watchErr = err
			p.mu.Unlock()
			return
		}
		if n != 1 {
			continue
		}
		event := events[0]
		if event.Filter == unix.EVFILT_PROC && event.Ident == uint64(p.PID) && event.Fflags&unix.NOTE_EXIT != 0 {
			close(p.exited)
			return
		}
		if event.Filter == unix.EVFILT_USER {
			return
		}
	}
}

func (p *macUpdateLaunchedProcess) validateAlive() error {
	select {
	case <-p.exited:
		return errors.New("新应用在健康确认前已退出")
	default:
	}
	select {
	case <-p.stopped:
		p.mu.Lock()
		err := p.watchErr
		p.mu.Unlock()
		if err == nil {
			err = errors.New("新应用退出监视已关闭")
		}
		return err
	default:
	}
	identity, err := macHealthProcessIdentity(p.PID)
	if err != nil || identity != p.identity {
		return errors.New("新应用进程身份已改变")
	}
	executable, err := macHealthProcessPath(p.PID)
	if err != nil || executable != p.executable {
		return errors.New("新应用进程执行路径已改变")
	}
	return nil
}

func (p *macUpdateLaunchedProcess) StopAndWait(ctx context.Context) error {
	if p == nil {
		return errors.New("没有可确认归属的新应用进程，保留原应用备份")
	}
	select {
	case <-p.exited:
		return nil
	default:
	}
	if err := p.validateAlive(); err != nil {
		select {
		case <-p.exited:
			return nil
		default:
		}
		return p.waitForExitAfterIdentityLoss(ctx, err)
	}
	if err := unix.Kill(p.PID, unix.SIGTERM); err != nil && !errors.Is(err, unix.ESRCH) {
		return err
	}
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	select {
	case <-p.exited:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
	}
	if err := p.validateAlive(); err != nil {
		select {
		case <-p.exited:
			return nil
		default:
		}
		return p.waitForExitAfterIdentityLoss(ctx, err)
	}
	if err := unix.Kill(p.PID, unix.SIGKILL); err != nil && !errors.Is(err, unix.ESRCH) {
		return err
	}
	select {
	case <-p.exited:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (p *macUpdateLaunchedProcess) waitForExitAfterIdentityLoss(ctx context.Context, identityErr error) error {
	// A dead process can disappear from sysctl before the NOTE_EXIT watcher runs.
	// Only its registered exit event, never that disappearance alone, authorizes rollback.
	select {
	case <-p.exited:
		return nil
	case <-p.stopped:
		select {
		case <-p.exited:
			return nil
		default:
		}
		return fmt.Errorf("进程身份不确定且退出监视停止：%w", identityErr)
	case <-ctx.Done():
		return errors.Join(fmt.Errorf("未终止身份不确定的进程：%w", identityErr), ctx.Err())
	}
}

func (p *macUpdateLaunchedProcess) Close() {
	if p == nil {
		return
	}
	p.closeOnce.Do(func() {
		select {
		case <-p.stopped:
			return
		default:
		}
		var wake unix.Kevent_t
		unix.SetKevent(&wake, 1, unix.EVFILT_USER, 0)
		wake.Fflags = unix.NOTE_TRIGGER
		_, _ = unix.Kevent(p.fd, []unix.Kevent_t{wake}, nil, nil)
		<-p.stopped
	})
}
