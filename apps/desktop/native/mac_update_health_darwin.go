//go:build darwin

package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync"
)

type macUpdateHealthSupervisor struct {
	plan      *macUpdatePlan
	candidate macBundleInfo
	dir       string
	socket    string
	challenge string
	listener  *net.UnixListener
	closeOnce sync.Once
}

func startMacUpdateHealth(p *macUpdatePlan, candidate macBundleInfo) (*macUpdateHealthSupervisor, error) {
	dir, err := os.MkdirTemp("/private/tmp", "cvh-")
	if err != nil {
		return nil, err
	}
	keep := false
	defer func() {
		if !keep {
			_ = os.RemoveAll(dir)
		}
	}()
	if err = os.Chmod(dir, 0700); err != nil {
		return nil, err
	}
	challenge := make([]byte, 32)
	if _, err = rand.Read(challenge); err != nil {
		return nil, err
	}
	socket := filepath.Join(dir, "health.sock")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socket, Net: "unix"})
	if err != nil {
		return nil, err
	}
	if err = os.Chmod(socket, 0600); err != nil {
		listener.Close()
		return nil, err
	}
	keep = true
	return &macUpdateHealthSupervisor{plan: p, candidate: candidate, dir: dir, socket: socket, challenge: hex.EncodeToString(challenge), listener: listener}, nil
}

func (s *macUpdateHealthSupervisor) RestartEnvironment() []string {
	return []string{
		macHealthSocketEnv + "=" + s.socket, macHealthIDEnv + "=" + s.plan.ID, macHealthServerPIDEnv + "=" + strconv.Itoa(os.Getpid()),
	}
}

func (s *macUpdateHealthSupervisor) verifyOwned(ctx context.Context, owned *macUpdateLaunchedProcess) error {
	if owned == nil {
		return errors.New("健康验证缺少可信启动PID")
	}
	if err := owned.validateAlive(); err != nil {
		return err
	}
	actual, err := readMacBundle(ctx, s.plan.Current.Path, true)
	if err != nil {
		return err
	}
	if actual.Node != s.candidate.Node || actual.CDHash != s.candidate.CDHash || actual.Identifier != s.candidate.Identifier || actual.Build != s.candidate.Build || actual.Executable != owned.executable {
		return errors.New("健康确认时新应用bundle身份变化")
	}
	if err = validateMacSigning(s.plan.Current, actual, buildMode); err != nil {
		return err
	}
	if err = verifyMacHealthProcessCDHash(owned.PID, s.candidate.CDHash); err != nil {
		return err
	}
	return owned.validateAlive()
}

func (s *macUpdateHealthSupervisor) Wait(ctx context.Context, owned *macUpdateLaunchedProcess, commit *macRecoveryHealthCommit) error {
	if owned == nil {
		return errors.New("健康确认缺少自有候选进程")
	}
	ctx, cancel := context.WithTimeout(ctx, macUpdateHealthTimeout)
	defer cancel()
	finished := make(chan struct{})
	defer close(finished)
	go func() {
		select {
		case <-ctx.Done():
			_ = s.listener.Close()
		case <-owned.exited:
			_ = s.listener.Close()
		case <-owned.stopped:
			_ = s.listener.Close()
		case <-finished:
		}
	}()
	for {
		conn, err := s.listener.AcceptUnix()
		if err != nil {
			if ctx.Err() != nil {
				return fmt.Errorf("新应用健康确认超时或取消：%w", ctx.Err())
			}
			if aliveErr := owned.validateAlive(); aliveErr != nil {
				return aliveErr
			}
			return err
		}
		pid, uid, peerErr := macHealthPeer(conn)
		if peerErr != nil || pid != owned.PID || uid != uint32(os.Getuid()) {
			_ = conn.Close()
			continue
		}
		return s.acceptOwned(ctx, conn, owned, commit)
	}
}

func (s *macUpdateHealthSupervisor) acceptOwned(ctx context.Context, conn *net.UnixConn, owned *macUpdateLaunchedProcess, commit *macRecoveryHealthCommit) error {
	defer conn.Close()
	deadline, _ := ctx.Deadline()
	if err := conn.SetDeadline(deadline); err != nil {
		return err
	}
	finished := make(chan struct{})
	defer close(finished)
	go func() {
		select {
		case <-ctx.Done():
			_ = conn.Close()
		case <-owned.exited:
			_ = conn.Close()
		case <-owned.stopped:
			_ = conn.Close()
		case <-finished:
		}
	}()
	if err := s.verifyOwned(ctx, owned); err != nil {
		return err
	}
	reader := bufio.NewReaderSize(conn, 4096)
	hello, err := readMacHealthMessage(reader)
	if err != nil {
		return err
	}
	if hello.Kind != "hello" || !macHealthEqual(hello.ID, s.plan.ID) || hello.Challenge != "" || hello.Error != "" {
		return errors.New("新应用健康握手无效")
	}
	if err = writeMacHealthMessage(conn, macHealthMessage{Kind: "challenge", ID: s.plan.ID, Challenge: s.challenge}); err != nil {
		return err
	}
	ack, err := readMacHealthMessage(reader)
	if err != nil {
		return err
	}
	if ack.Kind != "ready" || !macHealthEqual(ack.ID, s.plan.ID) || !macHealthEqual(ack.Challenge, s.challenge) || ack.Error != "" {
		return errors.New("新应用原生启动及界面就绪确认失败")
	}
	if err = s.verifyOwned(ctx, owned); err != nil {
		return err
	}
	if commit != nil {
		if err = s.commitRecoveryHealth(ctx, owned, commit); err != nil {
			return err
		}
		// Once persisted, even a lost ACK or late process exit cannot authorize rollback.
		if err = ctx.Err(); err != nil {
			return errors.Join(errMacUpdateHealthCommitUncertain, err)
		}
	}
	if err = writeMacHealthMessage(conn, macHealthMessage{Kind: "healthy", ID: s.plan.ID, Challenge: s.challenge}); err != nil {
		if commit != nil {
			return errors.Join(errMacUpdateHealthCommitUncertain, err)
		}
		return err
	}
	err = owned.validateAlive()
	if commit != nil {
		if err = errors.Join(ctx.Err(), err); err != nil {
			return errors.Join(errMacUpdateHealthCommitUncertain, err)
		}
	}
	return err
}

func (s *macUpdateHealthSupervisor) Close() {
	if s == nil {
		return
	}
	s.closeOnce.Do(func() { _ = s.listener.Close(); _ = os.RemoveAll(s.dir) })
}
