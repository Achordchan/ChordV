//go:build darwin

package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// These must be inherited private pipe endpoints, not paths from disk or env.
// The owner is always this worker's actual parent and must be running exact B.
type macRecoveryHandoff struct {
	input           *os.File
	output          *os.File
	armedAck        bool
	restartOriginal bool
}

func macRecoveryHandoffScope(intent macRecoveryIntent) (string, error) {
	raw, err := json.Marshal(intent)
	if err != nil {
		return "", err
	}
	return intent.Operation + " " + intent.Generation + " " + macPlanDigest(raw) + " ", nil
}

func (h *macRecoveryHandoff) wait(ctx context.Context, intent macRecoveryIntent, installed macBundleInfo) error {
	if h.input == nil || h.output == nil {
		return errors.New("恢复交接缺少私有管道")
	}
	pid := os.Getppid()
	if pid <= 1 {
		return errors.New("恢复父进程已经退出，无法注册精确退出事件")
	}
	parent, err := ownMacUpdateProcess(pid, installed.Executable)
	if err != nil {
		return err
	}
	defer parent.Close()
	if err = verifyMacHealthProcessCDHash(pid, intent.Candidate.CDHash); err != nil {
		return err
	}
	var challenge [32]byte
	if _, err = rand.Read(challenge[:]); err != nil {
		return err
	}
	scope, err := macRecoveryHandoffScope(intent)
	if err != nil {
		return err
	}
	token := scope + hex.EncodeToString(challenge[:])
	deadline := time.Now().Add(30 * time.Second)
	if value, ok := ctx.Deadline(); ok && value.Before(deadline) {
		deadline = value
	}
	if err = h.confirm(ctx, token, deadline); err != nil {
		return err
	}
	if h.armedAck {
		if err = ctx.Err(); err != nil {
			return err
		}
		if err = parent.validateAlive(); err != nil {
			return err
		}
		if err = verifyMacHealthProcessCDHash(pid, intent.Candidate.CDHash); err != nil {
			return err
		}
		if _, err = fmt.Fprintln(h.output, "CHORDV_RECOVERY_ARMED "+token); err != nil {
			return err
		}
	}
	// EOF is only the pipe boundary. No signal is sent; wait for this exact
	// parent's kernel event, including the identity registered before READY.
	select {
	case <-parent.exited:
		return ctx.Err()
	case <-parent.stopped:
		select {
		case <-parent.exited:
			return ctx.Err()
		default:
			return errors.New("恢复父进程退出监视未确认真实退出")
		}
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(time.Until(deadline)):
		return errors.New("恢复父进程关闭管道后仍未退出")
	}
}

func (h *macRecoveryHandoff) confirm(ctx context.Context, token string, deadline time.Time) error {
	if err := h.input.SetReadDeadline(deadline); err != nil {
		return err
	}
	if err := h.output.SetWriteDeadline(deadline); err != nil {
		return err
	}
	stopCancel := context.AfterFunc(ctx, func() {
		now := time.Now()
		_ = h.input.SetReadDeadline(now)
		_ = h.output.SetWriteDeadline(now)
	})
	defer stopCancel()
	if _, err := fmt.Fprintln(h.output, "CHORDV_RECOVERY_READY "+token); err != nil {
		return errors.Join(ctx.Err(), err)
	}
	reader := bufio.NewReaderSize(h.input, 512)
	line, err := reader.ReadSlice('\n')
	if err != nil || strings.TrimSuffix(string(line), "\n") != "ARM "+token {
		return errors.Join(ctx.Err(), errors.New("恢复父进程没有确认本次私有挑战"))
	}
	if _, err = reader.ReadByte(); err != io.EOF {
		return errors.Join(ctx.Err(), errors.New("恢复父进程管道尚未关闭或包含多余数据"))
	}
	return ctx.Err()
}

func macRecoveryCandidateQuiescent(installed macBundleInfo) error {
	return visitMacRecoveryBundleProcesses(installed, func(unix.KinfoProc) error {
		return errors.New("仍有候选应用实例存活，保留两端应用")
	})
}

func visitMacRecoveryBundleProcesses(bundle macBundleInfo, visit func(unix.KinfoProc) error) error {
	processes, err := unix.SysctlKinfoProcSlice("kern.proc.all")
	if err != nil {
		return err
	}
	for _, process := range processes {
		if process.Eproc.Ucred.Uid != uint32(os.Getuid()) || process.Proc.P_stat == 5 {
			continue
		}
		path, err := macHealthProcessPath(int(process.Proc.P_pid))
		if err != nil {
			// A process may have exited since the global snapshot. Only a fresh
			// kernel absence/zombie observation resolves that uncertainty.
			current, lookupErr := unix.SysctlKinfoProcSlice("kern.proc.pid", int(process.Proc.P_pid))
			if lookupErr == nil && (len(current) == 0 || current[0].Proc.P_stat == 5) {
				continue
			}
			// An unrelated application's on-disk image may have been moved or
			// unlinked. Only a DIFFERENT kernel code hash, bound to a stable
			// process start identity, proves that unreadable image is not B.
			hash, hashErr := macHealthProcessCDHash(int(process.Proc.P_pid))
			after, afterErr := unix.SysctlKinfoProcSlice("kern.proc.pid", int(process.Proc.P_pid))
			if lookupErr == nil && hashErr == nil && hash != bundle.CDHash && afterErr == nil && len(current) == 1 && len(after) == 1 &&
				current[0].Proc.P_starttime == after[0].Proc.P_starttime && current[0].Eproc.Ucred.Uid == after[0].Eproc.Ucred.Uid {
				continue
			}
			return fmt.Errorf("候选实例检查遇到身份不明的存活进程%d：%w", process.Proc.P_pid, errors.Join(err, lookupErr, hashErr, afterErr))
		}
		if path == bundle.Executable {
			if err := visit(process); err != nil {
				return err
			}
		}
	}
	// This observation alone is not exclusion. The caller holds the launch
	// gate across this scan and the subsequent exchange for cooperating builds.
	return nil
}
