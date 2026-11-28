//go:build darwin

package main

import (
	"bufio"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

type macStartupRollbackRequest struct{ intent macRecoveryIntent }

func (r *macStartupRollbackRequest) Error() string { return errMacStartupRollbackHandoff.Error() }
func (r *macStartupRollbackRequest) Unwrap() error { return errMacStartupRollbackHandoff }

func startMacStartupRollback(ctx context.Context, anchor macRecoveryAnchor, expected macRecoveryIntent, authority macRecoveryAuthority, command func(string) *exec.Cmd) error {
	if authority == nil || command == nil || expected.Capability != "rollback_original" {
		return errors.New("恢复交接缺少本次回滚授权或独立助手")
	}
	if !anchor.valid {
		return errors.New("恢复交接缺少候选启动锚")
	}
	if actual, err := macHealthProcessPath(os.Getpid()); err != nil || actual != anchor.bundle.Executable {
		return errors.Join(err, errors.New("当前进程不是本次正在运行的候选应用"))
	}
	if err := verifyMacHealthProcessCDHash(os.Getpid(), expected.Candidate.CDHash); err != nil {
		return err
	}
	var plan macUpdatePlan
	err := withMacRecoveryCleanupLocks(ctx, anchor, func() error {
		intent, err := authority.active(ctx, anchor.bundle.Path, anchor.cfg.DataDir)
		if err != nil || intent != expected {
			return errors.Join(err, errors.New("启动判断后的回滚授权已变化"))
		}
		snapshot, err := loadMacRecoveryReplay(ctx, anchor, intent)
		if err != nil || snapshot.placement != "candidate_installed" || snapshot.helperState != "gone" {
			return errors.Join(err, errors.New("候选身份或原更新助手状态已变化，未启动恢复助手"))
		}
		plan = snapshot.plan
		return plan.verifyHelperBundle(ctx)
	})
	if err != nil {
		return err
	}
	// Release the update locks before spawning: the worker must acquire both
	// independently and reread the exact protected intent before announcing READY.
	cmd := command(plan.helperExecutable())
	if cmd == nil || cmd.Path != plan.helperExecutable() {
		return errors.New("恢复助手不是已核对的独立应用副本")
	}
	return armMacStartupRollbackWorker(ctx, cmd, expected, func(pid int) error {
		intent, err := authority.active(ctx, anchor.bundle.Path, anchor.cfg.DataDir)
		if err != nil || intent != expected {
			return errors.Join(err, errors.New("等待恢复助手时授权已换代"))
		}
		if err := plan.verifyHelperBundle(ctx); err != nil {
			return err
		}
		return verifyMacHealthProcessCDHash(pid, expected.Current.CDHash)
	})
}

func armMacStartupRollbackWorker(ctx context.Context, command *exec.Cmd, intent macRecoveryIntent, verify func(int) error) (result error) {
	if err := ctx.Err(); err != nil {
		return err
	}
	workerInput, parentOutput, err := os.Pipe()
	if err != nil {
		return err
	}
	defer workerInput.Close()
	defer parentOutput.Close()
	parentInput, workerOutput, err := os.Pipe()
	if err != nil {
		return err
	}
	defer parentInput.Close()
	defer workerOutput.Close()
	command.Stdin, command.Stdout = workerInput, workerOutput
	if err = command.Start(); err != nil {
		return err
	}
	workerInput.Close()
	workerOutput.Close()
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	armed := false
	defer func() {
		if armed {
			return
		}
		// This is the exact child we started, never a PID read from disk. Abort
		// it even if an ARM was sent but the acknowledgment could not be verified.
		_ = command.Process.Kill()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			result = errors.Join(result, errors.New("本次恢复助手退出未确认，保留候选运行"))
		}
	}()
	owned, err := ownMacUpdateProcess(command.Process.Pid, command.Path)
	if err != nil {
		return err
	}
	defer owned.Close()
	verifyOwned := func() error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := verify(owned.PID); err != nil {
			return err
		}
		return errors.Join(ctx.Err(), owned.validateAlive())
	}
	if err = verifyOwned(); err != nil {
		return err
	}
	deadline := time.Now().Add(25 * time.Second)
	if until, ok := ctx.Deadline(); ok && until.Before(deadline) {
		deadline = until
	}
	if err = errors.Join(parentInput.SetReadDeadline(deadline), parentOutput.SetWriteDeadline(deadline)); err != nil {
		return err
	}
	stopCancel := context.AfterFunc(ctx, func() {
		_ = parentInput.SetReadDeadline(time.Now())
		_ = parentOutput.SetWriteDeadline(time.Now())
	})
	defer stopCancel()
	reader := bufio.NewReaderSize(parentInput, 512)
	line, err := reader.ReadSlice('\n')
	scope, scopeErr := macRecoveryHandoffScope(intent)
	if err != nil || scopeErr != nil {
		return errors.Join(ctx.Err(), err, scopeErr)
	}
	prefix := "CHORDV_RECOVERY_READY " + scope
	challenge, ok := strings.CutPrefix(strings.TrimSuffix(string(line), "\n"), prefix)
	decoded, decodeErr := hex.DecodeString(challenge)
	if !ok || len(decoded) != 32 || decodeErr != nil || hex.EncodeToString(decoded) != challenge {
		return errors.New("恢复助手握手未绑定本次完整回滚授权")
	}
	if err = verifyOwned(); err != nil {
		return err
	}
	token := scope + challenge
	if _, err = fmt.Fprintln(parentOutput, "ARM "+token); err != nil {
		return err
	}
	if err = parentOutput.Close(); err != nil {
		return err
	}
	line, err = reader.ReadSlice('\n')
	if err != nil || string(line) != "CHORDV_RECOVERY_ARMED "+token+"\n" {
		return errors.Join(ctx.Err(), err, errors.New("独立恢复助手未确认已等待本次进程退出"))
	}
	if err = verifyOwned(); err != nil {
		return err
	}
	armed = true
	return nil
}
