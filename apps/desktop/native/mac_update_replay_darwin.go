//go:build darwin

package main

import (
	"context"
	"errors"
)

// A provider must obtain active capabilities outside ordinary same-UID writable
// files; neither journal hashes nor a caller-supplied trust flag implements this.
type macRecoveryAuthority interface {
	active(context.Context, string, string) (macRecoveryIntent, error)
}

type macRecoveryIntent struct {
	Generation        string
	Operation         string
	UID               uint32
	Target            string
	DataDir           string
	Work              string
	PlanSHA256        string
	TransactionSHA256 string
	Filesystem        macUpdateFilesystem
	Current           macBundleInfo
	Candidate         macBundleInfo
	Capability        string
}

func replayMacUpdateRecovery(ctx context.Context, anchor macRecoveryAnchor, authority macRecoveryAuthority, handoff *macRecoveryHandoff) (string, error) {
	if err := ctx.Err(); err != nil {
		return "deferred", err
	}
	if !anchor.valid || authority == nil {
		return "needs_authority", errors.New("恢复执行缺少独立启动锚或受保护授权提供者")
	}
	// Lock paths come from the independent anchor, never from an intent/journal.
	p := macUpdatePlan{Current: anchor.bundle, DataDir: anchor.cfg.DataDir}
	targetLock, err := p.targetLock()
	if err != nil {
		return "deferred", err
	}
	defer targetLock.Close()
	dataLock, err := lockMacUpdateData(anchor.cfg.DataDir)
	if err != nil {
		return "deferred", err
	}
	defer dataLock.Close()
	intent, err := authority.active(ctx, anchor.bundle.Path, anchor.cfg.DataDir)
	if err != nil {
		return "needs_authority", err
	}
	snapshot, err := loadMacRecoveryReplay(ctx, anchor, intent)
	if err != nil {
		return "conflict", err
	}
	if snapshot.helperState != "gone" {
		return "deferred", errors.New("原更新助手仍存活或身份不确定")
	}
	if snapshot.placement == "original_staged" {
		return "original_retained", nil
	}
	if intent.Capability == "hold_candidate" {
		return "healthy_retained", nil
	}
	if intent.Capability != "rollback_original" {
		return "conflict", errors.New("回滚授权已进入清理，拒绝再次交换应用")
	}
	if handoff == nil {
		return "needs_parent_exit", errors.New("回滚必须由当前候选父进程完成独立退出交接")
	}
	if err = handoff.wait(ctx, intent, snapshot.target); err != nil {
		return "deferred", err
	}
	launchGate, err := lockMacTargetLaunch(anchor.bundle.Path, true)
	if err != nil {
		return "deferred", err
	}
	defer launchGate.Close()
	// Waiting can span a generation change or external filesystem edits. Neither
	// a previous snapshot nor a successful EOF/EXIT authorizes the new situation.
	active, err := authority.active(ctx, anchor.bundle.Path, anchor.cfg.DataDir)
	if err != nil || active != intent {
		return "needs_authority", errors.Join(err, errors.New("等待退出期间恢复授权代次或动作已改变"))
	}
	snapshot, err = loadMacRecoveryReplay(ctx, anchor, intent)
	if err != nil || snapshot.placement != "candidate_installed" || snapshot.helperState != "gone" {
		return "conflict", errors.Join(err, errors.New("退出后文件角色或助手状态变化，未交换应用"))
	}
	state, err := reverseMacRecoverySwap(ctx, snapshot)
	if err == nil && state == "rolled_back_retained" && handoff.restartOriginal {
		// Retain the installation and data locks across the launch request and
		// report. The restored application waits for this verified worker to exit
		// before attempting cleanup; this worker never removes its own bundle.
		err = restartMacRestoredOriginal(ctx, snapshot, intent, launchGate)
	}
	return state, err
}

// Both callers must have verified the active authorization, exact bundle roles
// and process ownership under the target, data and exclusive launch locks.
func reverseMacRecoverySwap(ctx context.Context, snapshot macRecoveryReplaySnapshot) (string, error) {
	if err := macRecoveryCandidateQuiescent(snapshot.target); err != nil {
		return "deferred", err
	}
	if err := ctx.Err(); err != nil {
		return "deferred", err
	}
	// The sole mutation is this operation's reverse CAS. No new install, release
	// authorization, floor write, process launch/kill, cleanup or intent retirement.
	if err := snapshot.plan.swapWithDirectories(snapshot.target.Node, snapshot.staged.Node, snapshot.directories); err != nil {
		// A directory fsync can fail AFTER RENAME_SWAP. Never retry it here.
		return "revalidation_required", err
	}
	return "rolled_back_retained", nil
}
