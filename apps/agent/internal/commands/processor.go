// Package commands executes what the control plane asks of this node.
//
// Two rules shape everything here:
//
//   - A command that reports "completed" must mean it was DONE. The control
//     plane advances the node's applied revision on that word, so a partial or
//     pretended success desynchronises the two sides silently.
//   - Only direct_primary may write to Xray. The mode gate is checked per
//     command, not once at startup, because a RECONCILE_USERS can change it.
package commands

import (
	"context"
	"errors"
	"fmt"

	"github.com/Achordchan/ChordV/apps/agent/internal/decimal"
	"github.com/Achordchan/ChordV/apps/agent/internal/protocol"
	"github.com/Achordchan/ChordV/apps/agent/internal/store"
	"github.com/Achordchan/ChordV/apps/agent/internal/xray"
)

// Deps are the collaborators one processor needs.
type Deps struct {
	Store *store.Store
	Xray  xray.Adapter
	// RemoveUnknownUsers decides whether a reconcile may uninstall an account
	// that is live in Xray but absent from the desired set. See Reconcile — it
	// is OFF by default, and that is a deliberate departure from the Node agent.
	RemoveUnknownUsers bool
	// AdoptExistingAccounts lets an install take over an email that already names
	// a live account this agent has no record of. OFF by default: under the
	// panel-shared inbound that account may be the PANEL's, and taking it over
	// overwrites its credentials and makes it deletable by a later omission.
	//
	// Turn it on only for a node being MIGRATED from the Node agent, where the
	// live accounts are known to be ChordV's. See Processor.collision.
	AdoptExistingAccounts bool
	// Logf receives operator-facing notices.
	Logf func(format string, args ...any)
}

// Processor executes commands and reconciles users.
type Processor struct{ deps Deps }

// New builds a processor.
func New(deps Deps) *Processor { return &Processor{deps: deps} }

func (p *Processor) logf(format string, args ...any) {
	if p.deps.Logf != nil {
		p.deps.Logf(format, args...)
	}
}

// Execute runs one command, answering a redelivery from storage instead of
// repeating the work.
//
// A failure is REPORTED, never thrown away: the control plane needs to know that
// its instruction did not land, and the stored failure is cleared so a later
// redelivery may succeed.
func (p *Processor) Execute(ctx context.Context, command protocol.Command, writable bool) (protocol.CommandResult, error) {
	previous, err := p.deps.Store.BeginCommand(command)
	if err != nil {
		return protocol.CommandResult{}, err
	}
	if previous != nil {
		return *previous, nil
	}
	result := protocol.CommandResult{CommandID: command.CommandID, Status: protocol.StatusCompleted}
	extra, applyErr := p.apply(ctx, command, writable)
	if applyErr != nil {
		result.Status = protocol.StatusFailed
		result.Error = applyErr.Error()
	} else {
		if err := p.deps.Store.AdvanceConfigRevision(command.TargetRevision); err != nil {
			return protocol.CommandResult{}, err
		}
		result.Result = map[string]any{"appliedRevision": command.TargetRevision}
		for key, value := range extra {
			result.Result[key] = value
		}
	}
	if err := p.deps.Store.CompleteCommand(result); err != nil {
		return protocol.CommandResult{}, err
	}
	return result, nil
}

func (p *Processor) apply(ctx context.Context, command protocol.Command, writable bool) (map[string]any, error) {
	// REFRESH_QUOTA and RECONCILE_USERS only touch local state, so an observing
	// node may run them. Everything else installs or uninstalls accounts.
	if !writable && command.Type != protocol.CommandRefreshQuota && command.Type != protocol.CommandReconcileUsers {
		return nil, errors.New("当前控制模式禁止修改 Xray 用户")
	}
	switch command.Type {
	case protocol.CommandEnsureUser, protocol.CommandEnableUser:
		return nil, p.ensureUser(ctx, command)
	case protocol.CommandDisableUser:
		return nil, p.terminalUser(ctx, command, false)
	case protocol.CommandRemoveUser:
		return nil, p.terminalUser(ctx, command, true)
	case protocol.CommandReconcileUsers:
		return nil, p.reconcileCommand(ctx, command)
	case protocol.CommandRefreshQuota:
		bindingID, err := stringField(command.Payload, "bindingId")
		if err != nil {
			return nil, err
		}
		quota, err := stringField(command.Payload, "quotaRemainingBytes")
		if err != nil {
			return nil, err
		}
		return nil, p.deps.Store.UpdateQuota(bindingID, quota, command.TargetRevision)
	case protocol.CommandEnsureInbound:
		// B1 moved inbound ownership to the 3x-ui panel (PRD §3.1): the agent no
		// longer deploys one, and the replacement semantics — verify the
		// configured tag is usable — arrive in P2 with the adapter that can check
		// it. Failing is the only honest answer for this build; reporting
		// "completed" would advance the node's applied revision for work that
		// never happened.
		//
		// But the failure is NOT self-contained, and the message has to say so.
		// The deployed control plane still queues these and depends on the report
		// to populate the node's connection parameters (agent.service.ts
		// applyInboundReport), guards concurrency with the command's dedupe key,
		// and compare-and-swaps on expectedInboundAppliedRevision. A node moved
		// to this agent before the §5.2 control-plane change lands would be
		// online, healthy, and unable to serve anyone — which is precisely the
		// state the installer's own comment warns about. That ordering is a
		// blocking prerequisite for the canary, recorded in PRD §9/§10.
		return nil, errors.New(
			"本构建不支持 ENSURE_INBOUND：B1 下入站改由 3x-ui 面板创建，" +
				"节点的连接参数应由后台导入面板入站的 vless 链接得到（PRD §5.2）。" +
				"若本节点仍在用旧的入站下发流程，请先完成控制面侧改造再切换 agent，" +
				"否则该节点会「在线但无法服务」")
	default:
		// A newer control plane talking to an older agent. Guessing is worse
		// than refusing.
		return nil, fmt.Errorf("未知命令类型 %q", command.Type)
	}
}

func (p *Processor) ensureUser(ctx context.Context, command protocol.Command) error {
	stored, err := p.findStored(command.Payload)
	if err != nil {
		return err
	}
	bindingID, _ := command.Payload["bindingId"].(string)
	if stored != nil {
		bindingID = stored.BindingID
	}
	skip, err := p.supersededBinding(bindingID, command.TargetRevision, stored)
	if err != nil || skip {
		return err
	}
	user, err := p.resolveUser(command, stored)
	if err != nil {
		return err
	}
	user.Enabled = true
	user.Revision = command.TargetRevision
	// Before the uninstall below, not after: the store validates these fields
	// inside UpsertDesiredUser, which runs only once the old account is already
	// gone. A malformed quota would otherwise take a working account down and
	// then fail — on this attempt and on every retry.
	if err := validateUser(user); err != nil {
		return err
	}
	// A changed email is a NEW account as far as Xray is concerned — the adapter
	// addresses accounts by email and cannot infer the previous one. Uninstall
	// the old one FIRST, while the record that names it is still here: after the
	// upsert below the old email is gone from the store, and with unknown-user
	// removal off nothing would ever clean it up. It would keep serving, with no
	// desired-user record left to account for its traffic.
	//
	// The metering baseline is reset by the store when the email changes; see
	// upsertDesiredUserTx.
	//
	// Guarded by ownership, exactly as Reconcile's rename pass is: a stored row
	// can name a PANEL account this node merely observed in shadow mode, and
	// uninstalling it here would walk straight past the protection that keeps
	// the shared inbound safe.
	if stored != nil && stored.Email != user.Email {
		owned, err := p.owns(stored.Email)
		if err != nil {
			return err
		}
		if !owned {
			p.logf("[agent] 用户 %s 的 email 由 %s 变更为 %s，但旧账号不是本节点装的（可能属于面板），未卸载",
				user.BindingID, stored.Email, user.Email)
		} else {
			if err := p.deps.Xray.RemoveUser(ctx, stored.Email); err != nil {
				return err
			}
			if err := p.deps.Store.ForgetProvisioned([]string{stored.Email}); err != nil {
				return err
			}
			// BOTH forms, as REMOVE_USER does: a pending note left behind keeps
			// asserting ownership of an address this binding has released, and
			// the panel may reuse it before the next reconcile looks again.
			if err := p.deps.Store.ClearPendingRemoval([]string{stored.Email}); err != nil {
				return err
			}
			p.logf("[agent] 用户 %s 的 email 由 %s 变更为 %s，已卸载旧账号", user.BindingID, stored.Email, user.Email)
		}
	}
	// Store BEFORE Xray: a crash between the two leaves a user the store knows
	// about but Xray does not, which the next reconcile repairs. The reverse
	// leaves a user serving traffic that no local record accounts for.
	if err := p.deps.Store.UpsertDesiredUser(user); err != nil {
		return err
	}
	// The binding is legitimately back — at a revision newer than whatever
	// deleted it, or staleForEnable would have stopped us. Keeping the tombstone
	// would block nothing and grow forever.
	if err := p.deps.Store.ClearBindingTombstone(user.BindingID); err != nil {
		return err
	}
	// Claimed only once the install has SUCCEEDED. An attempted install is not
	// proof of ownership, and the difference is destructive: if this email
	// already names a panel account, a failed EnsureUser would leave the panel's
	// account marked as ChordV's, for the next omission to delete.
	//
	// But that leaves a window — a crash between the install and the claim — and
	// re-running the reconcile only repairs it while the snapshot still names the
	// binding. Revoke the subscription in between and the account is installed,
	// unclaimed, unmetered and permanent. So an INTENT goes down first, which is
	// weaker than a claim and cannot be mistaken for one.
	//
	// Recorded only if the address names no live account right now: that is what
	// makes it resolvable later, because any account carrying it afterwards can
	// only be this agent's. Checked only when the account is not already ours, so
	// the common case costs no extra call.
	owned, err := p.owns(user.Email)
	if err != nil {
		return err
	}
	if !owned {
		live, err := p.deps.Xray.ListUsers(ctx)
		if err != nil {
			return err
		}
		taken := false
		for _, account := range live {
			if account.Email == user.Email {
				taken = true
				break
			}
		}
		if taken {
			return p.collision(user)
		}
		if err := p.deps.Store.RecordProvisionIntent(user.BindingID, user.Email, user.UUID); err != nil {
			return err
		}
	}
	if err := p.deps.Xray.EnsureUser(ctx, user); err != nil {
		return err
	}
	return p.deps.Store.RecordProvisioned(user.BindingID, user.Email)
}

// collision decides what to do about a desired account whose email already names
// a LIVE account this agent never installed.
//
// Suppressing only the intent is not enough: EnsureUser's contract allows it to
// UPDATE an existing account, so the call would overwrite the panel user's
// credentials — cutting off their service — and the claim that follows would let
// a later snapshot omission delete the account outright.
//
// The two possibilities are genuinely indistinguishable from here. It may be the
// panel's account. It may equally be ChordV's own, installed by the TypeScript
// agent this one replaces, or by a previous instance whose evidence is gone —
// which is exactly what a promotion or an in-place upgrade looks like. So the
// choice is not the agent's to make silently: it refuses, unless an operator has
// declared this node a migration by turning AdoptExistingAccounts on.
func (p *Processor) collision(user protocol.DesiredUser) error {
	if p.deps.AdoptExistingAccounts {
		p.logf("[agent] binding %s 的 email %s 已有一个本节点未记录的活账号，按 AdoptExistingAccounts 接管",
			user.BindingID, user.Email)
		return nil
	}
	return fmt.Errorf("binding %s 要用的 email %s 已经是入站中一个本节点从未安装过的账号。"+
		"B1 下入站与 3x-ui 面板共用，覆盖它会切断面板用户的服务，并让之后的快照遗漏把它删掉。"+
		"若这是从旧 agent 迁移、这些账号确实是 ChordV 的，请为本节点开启 AdoptExistingAccounts；"+
		"否则请在面板侧改名，或由控制面换一个 email",
		user.BindingID, user.Email)
}

// supersededBinding is the ONE place that decides whether an instruction about
// a binding has been overtaken. Every path that could enable or reinstate an
// account consults it.
//
// It was previously spread across the callers, and each place that forgot one of
// the three sources was a way for a revoked account to come back. The sources:
//
//   - the SNAPSHOT watermark — a newer full reconcile has replaced everything.
//     Deliberately NOT the applied-revision watermark, which advances on every
//     completed command: binding B succeeding at 6 says nothing about a retry
//     for binding A at 5, and treating it as superseding would skip that retry
//     and cache the skip as a success.
//   - the binding's own stored revision — a newer instruction about THIS
//     binding.
//   - its TOMBSTONE — what remains after the row itself is deleted, and the only
//     evidence left once a terminal command has run. Recorded at or below the
//     target revision means superseded: a re-delivered enable must not undo the
//     disable that the same revision produced.
//
// Every revision the control plane emits comes from ONE counter — the node's
// agentConfigRevision, incremented and then copied into both a command's target
// revision and the binding's directRevision. There is no second axis.
//
// What differs is what a given number MEANS, and that is where the watermark
// stops applying:
//
//   - a command's target revision, and a snapshot's own revision, are FRESHNESS
//     CLAIMS — "this reflects the world as of here". Comparing one against the
//     watermark asks a sound question.
//   - a binding's revision inside a snapshot is a LAST-MODIFIED STAMP — "this
//     binding last changed here". A binding untouched since revision 5 belongs
//     in a snapshot at revision 11 exactly as it is; measuring that 5 against a
//     watermark of 10 asks "did you last change before the previous snapshot",
//     and drops every binding whose honest answer is yes.
//
// So: use this function when the revision in hand is a freshness claim, and
// supersededForBinding when it is a last-modified stamp whose carrier the caller
// has already checked against the watermark.
func (p *Processor) supersededBinding(bindingID, targetRevision string, stored *protocol.DesiredUser) (bool, error) {
	snapshot, err := p.deps.Store.SnapshotRevision()
	if err != nil {
		return false, err
	}
	older, err := decimal.Less(targetRevision, snapshot)
	if err != nil || older {
		return older, err
	}
	return p.supersededForBinding(bindingID, targetRevision, stored)
}

// staleTerminal is the terminal counterpart of supersededBinding.
//
// It keeps the checks that mean "a NEWER instruction has already spoken" and
// drops the two equal-revision ones, because those are proof about an ENABLE and
// not about a terminal operation:
//
//   - "already disabled at this revision" says nothing about whether the account
//     was uninstalled from Xray. Reconcile persists the disabled row BEFORE
//     touching Xray, so a failed uninstall leaves exactly that state — and a
//     DISABLE_USER at the same revision would then be skipped while the account
//     kept serving.
//   - a tombstone at this revision does not say WHICH terminal command wrote it.
//     A DISABLE at R followed by a REMOVE at R would report the removal
//     completed and leave the local row in place permanently.
//
// Nothing is lost by re-running a terminal command: RemoveUser succeeds for an
// account that is not installed, and ApplyTerminal is a no-op at an equal
// revision. And a REDELIVERY of the same command never reaches here — Execute
// returns the stored result for a commandId it has already finished.
func (p *Processor) staleTerminal(bindingID, targetRevision string, stored *protocol.DesiredUser) (bool, error) {
	snapshot, err := p.deps.Store.SnapshotRevision()
	if err != nil {
		return false, err
	}
	older, err := decimal.Less(targetRevision, snapshot)
	if err != nil || older {
		return older, err
	}
	if bindingID != "" {
		tombstone, err := p.deps.Store.BindingTombstone(bindingID)
		if err != nil {
			return false, err
		}
		if tombstone != "0" {
			older, err := decimal.Less(targetRevision, tombstone)
			if err != nil || older {
				return older, err
			}
		}
	}
	if stored == nil {
		return false, nil
	}
	return decimal.Less(targetRevision, stored.Revision)
}

// supersededForBinding is supersededBinding without the snapshot watermark: the
// binding's own history only.
func (p *Processor) supersededForBinding(bindingID, targetRevision string, stored *protocol.DesiredUser) (bool, error) {
	if bindingID != "" {
		tombstone, err := p.deps.Store.BindingTombstone(bindingID)
		if err != nil {
			return false, err
		}
		// "0" is the absence of a tombstone, not a terminal command at revision
		// zero — the control plane's revisions are a counter that starts at one.
		if tombstone != "0" {
			newer, err := decimal.Less(tombstone, targetRevision)
			if err != nil {
				return false, err
			}
			if !newer {
				return true, nil
			}
		}
	}
	if stored == nil {
		return false, nil
	}
	older, err := decimal.Less(targetRevision, stored.Revision)
	if err != nil || older {
		return older, err
	}
	return targetRevision == stored.Revision && !stored.Enabled, nil
}

// terminalUser handles DISABLE_USER and REMOVE_USER, which differ only in
// whether the local record survives.
func (p *Processor) terminalUser(ctx context.Context, command protocol.Command, remove bool) error {
	stored, err := p.findStored(command.Payload)
	if err != nil {
		return err
	}
	// A terminal command's revision IS a command target revision, so it belongs
	// on the watermark's axis and must be measured against it. Comparing only
	// against the stored row is not enough: a snapshot at revision 10 may carry
	// this binding untouched since revision 1, and a delayed DISABLE_USER at 5
	// then passes a 5-vs-1 test and uninstalls an account the newer full snapshot
	// installed.
	//
	// staleTerminal, not supersededBinding — see its comment for why an
	// equal-revision disable is proof for an enable and not for a removal.
	bindingID, _ := command.Payload["bindingId"].(string)
	if stored != nil {
		bindingID = stored.BindingID
	}
	skip, err := p.staleTerminal(bindingID, command.TargetRevision, stored)
	if err != nil || skip {
		return err
	}
	email := ""
	if stored != nil {
		email = stored.Email
	} else {
		// The user may already be gone locally while still installed in Xray —
		// exactly the case a terminal command must still be able to clean up.
		if email, err = optionalField(command.Payload, "email", "userKey"); err != nil {
			return err
		}
	}
	// The adapter addresses accounts by email, and its contract says removing an
	// account that is not installed SUCCEEDS — so an empty target would return
	// success, mark the command permanently completed, and never touch the
	// account it was meant to remove. A binding this node no longer stores, sent
	// without an email, is exactly that case: it must come back as an actionable
	// failure instead.
	if email == "" {
		return fmt.Errorf("命令 %s 未能确定要卸载的账号：本机没有 bindingId 的记录，payload 也未提供 email",
			command.Type)
	}
	// Xray FIRST here, unlike ensureUser: until the account is uninstalled it is
	// still carrying traffic, and a crash after the local delete would leave it
	// serving with nothing left to notice it.
	if err := p.deps.Xray.RemoveUser(ctx, email); err != nil {
		return err
	}
	// A REMOVE ends the agent's claim on the account; a DISABLE does not — the
	// record survives and a later enable puts the same account back.
	//
	// BOTH forms of evidence go, not just the provisioning record: a pending note
	// left behind would keep asserting ownership of an address the control plane
	// has released, and the panel may reuse it.
	if remove {
		if err := p.deps.Store.ForgetProvisioned([]string{email}); err != nil {
			return err
		}
		if err := p.deps.Store.ClearPendingRemoval([]string{email}); err != nil {
			return err
		}
	}
	// Recorded for BOTH kinds, and even when this node had no row to act on.
	//
	// A disable whose row survives is guarded by that row's revision — but a
	// disable for a binding this node does not store leaves no evidence at all,
	// and a delayed enable at a lower revision would then restore access to an
	// account the control plane just took down. The tombstone is a floor on the
	// binding rather than a fact about the row, so it applies uniformly.
	//
	// And it goes down TOGETHER with the row change, in one transaction. A
	// tombstone that lands alone already says "this command is applied", so a
	// crash before the row is retired makes the redelivery return early and
	// report completed while the enabled row survives for the next reconcile to
	// reinstall.
	if bindingID == "" {
		return nil
	}
	return p.deps.Store.ApplyTerminal(bindingID, command.TargetRevision, remove)
}

func (p *Processor) reconcileCommand(ctx context.Context, command protocol.Command) error {
	current, err := p.deps.Store.ConfigSnapshot()
	if err != nil {
		return err
	}
	// Against the SNAPSHOT watermark, for the same reason staleForEnable is:
	// another binding's command completing does not make this snapshot stale.
	snapshot, err := p.deps.Store.SnapshotRevision()
	if err != nil {
		return err
	}
	older, err := decimal.Less(command.TargetRevision, snapshot)
	if err != nil {
		return err
	}
	if older {
		return errors.New("拒绝执行过期的 RECONCILE_USERS revision")
	}
	users := current.Users
	if raw, present := command.Payload["users"]; present {
		if users, err = parseDesiredUsers(raw, command.TargetRevision); err != nil {
			return err
		}
	}
	// An ABSENT controlMode means "keep whatever this node is on". A PRESENT one
	// that this build does not recognise is a newer control plane speaking a
	// vocabulary this agent does not have — quite possibly a new observation mode
	// — and silently falling back to the stored mode would read an instruction it
	// cannot understand as permission to keep writing to Xray. Refuse instead,
	// exactly as an unknown command type is refused.
	mode := current.ControlMode
	if raw, present := command.Payload["controlMode"]; present {
		value, ok := raw.(string)
		if !ok || !protocol.IsControlMode(value) {
			return fmt.Errorf("无法识别的控制模式 %v，拒绝执行（可能是较新的控制面下发了本构建不认识的模式）", raw)
		}
		mode = protocol.ControlMode(value)
	}
	// A PROMOTION must bring its own user set.
	//
	// getConfig only filters the snapshot to source === "direct" once the node IS
	// on direct_primary; in the observing modes it hands over the PANEL's
	// bindings too. So the users this node is holding while it observes are not
	// a lawful desired set for the direct track — and a mode-only instruction,
	// which falls back to exactly those users, would have Reconcile install and
	// CLAIM the panel's accounts. The next properly filtered snapshot then omits
	// them, and now that they are claimed the cleanup uninstalls them, with
	// RemoveUnknownUsers off and nothing to notice.
	//
	// The agent cannot fetch the authoritative set from here, so it refuses and
	// says what the control plane must send instead.
	if _, carriesUsers := command.Payload["users"]; !carriesUsers &&
		mode == protocol.ModeDirectPrimary && current.ControlMode != protocol.ModeDirectPrimary {
		return fmt.Errorf("拒绝仅凭控制模式把节点晋升到 direct_primary：本节点在 %s 下持有的用户集包含面板来源的 binding，"+
			"直接沿用会把面板账号装上并认领为本节点所有。请在同一条 RECONCILE_USERS 里下发过滤后的 users",
			current.ControlMode)
	}
	// A snapshot older than an individual command that has ALREADY landed must
	// not undo it, and the snapshot watermark cannot see that: it only moves when
	// a snapshot lands, so a delayed reconcile at revision 5 passes the gate even
	// though a DISABLE_USER at 6 has been applied. Reconcile would then hand Xray
	// the snapshot's stale Enabled flag and reinstall the disabled account — the
	// store's own per-row revision guard rejects the write, but Xray was already
	// changed — and the omission cleanup would uninstall a binding a newer
	// command had just added.
	//
	// So the snapshot is merged with anything newer BEFORE Xray is touched, and
	// the merged set is what gets persisted too.
	if users, err = p.mergeNewerBindings(users, command.TargetRevision); err != nil {
		return err
	}
	// Write permission is resolved from the mode this command ESTABLISHES, not
	// from the caller's view of the mode before it.
	//
	// A RECONCILE_USERS carrying controlMode=direct_primary IS the control plane
	// handing this node the direct track — the grant and the users it authorises
	// arrive together. Deferring to the caller's stale "not writable" would skip
	// the installation, persist the new mode anyway, and report completed with an
	// advanced applied revision: the control plane would believe the handover
	// happened while no account was installed, and a redelivery would return the
	// cached success instead of retrying. Replay is already blocked by the
	// revision guard above, so an old command cannot grant anything.
	if mode == protocol.ModeDirectPrimary {
		if err := p.Reconcile(ctx, users); err != nil {
			return err
		}
	} else if err := p.rememberDroppedOwnership(users); err != nil {
		// This node may not write Xray right now, but the snapshot below still
		// erases the records of everything this instruction drops — and those
		// accounts stay installed in the shared inbound. Without a note of who
		// they were, a later promotion would see accounts it has never heard of
		// and, under the panel-shared inbound, leave them serving.
		return err
	}
	_, err = p.deps.Store.ApplyConfigSnapshot(protocol.ConfigSnapshot{
		NodeID: current.NodeID, Revision: command.TargetRevision, ControlMode: mode, Users: users,
	})
	return err
}

// Reconcile makes Xray's installed accounts match the desired set.
//
// The final step — what to do about accounts that are live but NOT desired — is
// where this departs from the Node agent, and the reason is the topology rather
// than the code.
//
// There, ChordV created and owned the whole inbound (`chordv-in`), so a live
// account outside the desired set could only be ChordV's own leftover and
// removing it was correct. Under B1 the inbound is created by an administrator
// in the 3x-ui panel and is SHARED (PRD §3.1), so ListUsers also returns the
// PANEL's accounts. Porting that step unchanged would have ChordV silently
// delete the panel's users.
//
// The split that resolves it is ownership, and the STORE is the evidence:
//
//   - live, not desired, but this node has a desired-user record for it — ours,
//     dropped from the latest instruction. It MUST be uninstalled: a
//     subscription revoked while the agent was offline arrives exactly this way,
//     and leaving it would keep serving an account nobody is paying for while
//     ApplyConfigSnapshot goes on to delete the only local record of it.
//   - live, not desired, and never in our records — could be the panel's.
//     Reported, never touched. RemoveUnknownUsers overrides that for a
//     deployment that can prove the inbound is not shared.
//
// The ownership snapshot is taken BEFORE the desired set is written, because
// that write is what erases the evidence.
// resolveIntents settles every unresolved installation intent against Xray.
func (p *Processor) resolveIntents(live []xray.LiveUser) error {
	intents, err := p.deps.Store.ProvisionIntents()
	if err != nil || len(intents) == 0 {
		return err
	}
	installed := make(map[string]xray.LiveUser, len(live))
	for _, account := range live {
		installed[account.Email] = account
	}
	var abandoned []string
	for email, intent := range intents {
		account, present := installed[email]
		if !present {
			// Nothing at that address: the install never landed, and keeping the
			// intent would only let it accumulate.
			abandoned = append(abandoned, email)
			continue
		}
		// PRESENCE IS NOT IDENTITY. The address being free when the intent was
		// written does not prove that whatever sits there now is this agent's:
		// the inbound is shared, and the panel writes to it independently. If the
		// install failed — or the process died before it ran — an administrator
		// could have created that email in between, and converting presence into
		// ownership would hand the panel's account to the omission cleanup.
		//
		// So the uuid has to match. An adapter that cannot report one leaves it
		// empty, and an intent that cannot be checked is LEFT UNRESOLVED rather
		// than resolved by guessing: an unresolved intent costs a little state,
		// a wrong resolution costs somebody their account.
		if account.UUID == "" || intent.UUID == "" || account.UUID != intent.UUID {
			continue
		}
		if err := p.deps.Store.RecordProvisioned(intent.BindingID, email); err != nil {
			return err
		}
	}
	return p.deps.Store.ForgetProvisioned(abandoned)
}

// owns reports whether this agent installed the account, by the same two pieces
// of evidence Reconcile's ownership map is built from.
func (p *Processor) owns(email string) (bool, error) {
	provisioned, err := p.deps.Store.ProvisionedAccounts()
	if err != nil {
		return false, err
	}
	for _, candidate := range provisioned {
		if candidate == email {
			return true, nil
		}
	}
	pending, err := p.deps.Store.PendingRemovals()
	if err != nil {
		return false, err
	}
	for _, candidate := range pending {
		if candidate == email {
			return true, nil
		}
	}
	return false, nil
}

// validateUser checks everything the store will check, BEFORE the caller does
// anything it cannot take back.
//
// The store validates a user's decimals inside UpsertDesiredUser, which runs
// AFTER the rename path has already uninstalled the old account. So a snapshot
// carrying, say, quotaRemainingBytes "-1" takes a working account down, fails,
// and fails again on every retry: a malformed field turns into an outage that
// only the control plane can end. Checking first turns it back into a rejected
// command with the service untouched.
func validateUser(user protocol.DesiredUser) error {
	if user.BindingID == "" {
		return errors.New("目标用户缺少 bindingId")
	}
	if user.Email == "" {
		return fmt.Errorf("binding %s 缺少 email", user.BindingID)
	}
	if user.UUID == "" {
		return fmt.Errorf("binding %s 缺少 uuid", user.BindingID)
	}
	for field, value := range map[string]string{
		"revision":            user.Revision,
		"quotaRemainingBytes": user.QuotaRemainingBytes,
	} {
		if _, err := decimal.Normalize(value); err != nil {
			return fmt.Errorf("binding %s 的 %s 非法：%w", user.BindingID, field, err)
		}
	}
	// Empty means "use the agent default", which the store substitutes.
	if user.OfflineAllowanceBytes != "" {
		if _, err := decimal.Normalize(user.OfflineAllowanceBytes); err != nil {
			return fmt.Errorf("binding %s 的 offlineAllowanceBytes 非法：%w", user.BindingID, err)
		}
	}
	return nil
}

// distinctBindings refuses a desired set that names the same binding, or the
// same account, twice.
//
// Neither duplicate is recoverable once it has been acted on. Two rows for one
// bindingId both get installed in Xray, but the upserts collapse into a single
// stored row holding the LAST email — and because both emails are in the desired
// set, the cleanup pass below skips the other one. From the next reconcile on it
// is simply a stranger: with unknown-user removal off (the B1 default, because
// the inbound is shared with the panel) nothing will ever take it down, and
// there is no local record to meter it or to revoke it through.
//
// Two bindings sharing one email is the mirror image — one Xray account with two
// owners, so a terminal command for either uninstalls the other's service.
//
// Refusing costs one failed command that the control plane can see and fix.
func distinctBindings(users []protocol.DesiredUser) error {
	bindings := make(map[string]bool, len(users))
	emails := make(map[string]string, len(users))
	for _, user := range users {
		if err := validateUser(user); err != nil {
			return err
		}
		if bindings[user.BindingID] {
			return fmt.Errorf("目标用户集里 bindingId %s 出现了多次", user.BindingID)
		}
		bindings[user.BindingID] = true
		if owner, taken := emails[user.Email]; taken {
			return fmt.Errorf("目标用户集里 email %s 同时属于 binding %s 和 %s",
				user.Email, owner, user.BindingID)
		}
		emails[user.Email] = user.BindingID
	}
	return nil
}

func (p *Processor) Reconcile(ctx context.Context, users []protocol.DesiredUser) error {
	// Before ListUsers, not merely before the writes: a caller that reaches this
	// with a malformed set should get the refusal without the agent having
	// touched Xray at all.
	if err := distinctBindings(users); err != nil {
		return err
	}
	live, err := p.deps.Xray.ListUsers(ctx)
	if err != nil {
		return err
	}
	// Taken first: upserting the desired set below, and ApplyConfigSnapshot
	// afterwards, both change what this node remembers owning.
	recorded, err := p.deps.Store.ListDesiredUsers()
	if err != nil {
		return err
	}
	// Ownership comes from PROVISIONING, not from having a desired-user record.
	//
	// The control plane's getConfig includes PANEL-sourced bindings while a node
	// is in xui_primary or shadow_direct, and filters them out only in
	// direct_primary. So a node that observed a snapshot in shadow mode holds
	// desired-user rows for the panel's own accounts, and the filtered set it
	// receives on promotion omits them. Reading ownership off those rows would
	// classify the panel's accounts as ChordV leftovers and uninstall them —
	// silently, with RemoveUnknownUsers off and no warning, because as far as
	// that map is concerned they were ours all along.
	//
	// "This agent called EnsureUser for this email" is the fact none of that can
	// manufacture.
	//
	// Unresolved INTENTS are settled first, against what Xray actually holds. An
	// intent was only written when the address named no live account, so finding
	// one there now means the install landed and the claim did not — the crash
	// window ensureUser describes. Finding nothing means the install never
	// happened, and the intent is dropped rather than left to accumulate.
	if err := p.resolveIntents(live); err != nil {
		return err
	}
	provisioned, err := p.deps.Store.ProvisionedAccounts()
	if err != nil {
		return err
	}
	ours := make(map[string]bool, len(provisioned))
	for _, email := range provisioned {
		ours[email] = true
	}
	// Accounts whose record was erased by a snapshot applied while this node
	// could not write Xray. They are still ours, and this is the only surviving
	// evidence of it.
	pending, err := p.deps.Store.PendingRemovals()
	if err != nil {
		return err
	}
	for _, email := range pending {
		ours[email] = true
	}
	desired := make(map[string]bool, len(users))
	for _, user := range users {
		desired[user.Email] = true
	}
	stillPending := make(map[string]bool, len(pending))
	for _, email := range pending {
		stillPending[email] = true
	}
	// Renames are settled BEFORE anything is written, for the same reason
	// ensureUser does it: the upsert below replaces the only durable record that
	// names the old account. If the install that follows fails — or the process
	// dies — the next reconcile would see the old account as one it has never
	// heard of and, with unknown-user removal off, leave it serving forever.
	previousEmail := make(map[string]string, len(recorded))
	for _, user := range recorded {
		previousEmail[user.BindingID] = user.Email
	}
	for _, user := range users {
		old, known := previousEmail[user.BindingID]
		if !known || old == user.Email {
			continue
		}
		// The same ownership test the omission cleanup applies, and for the same
		// reason. `recorded` includes PANEL bindings observed in shadow mode, so
		// a binding that keeps its id but arrives with a different email on
		// promotion would otherwise have the panel's account uninstalled here —
		// straight past the guard that is supposed to make that impossible.
		if !ours[old] {
			p.logf("[agent] 用户 %s 的 email 由 %s 变更为 %s，但旧账号不是本节点装的（可能属于面板），未卸载",
				user.BindingID, old, user.Email)
			continue
		}
		if err := p.deps.Xray.RemoveUser(ctx, old); err != nil {
			return err
		}
		// The old email is gone for good; the new one is claimed by the install
		// pass below.
		if err := p.deps.Store.ForgetProvisioned([]string{old}); err != nil {
			return err
		}
		// BOTH forms — see the same handover in ensureUser.
		if err := p.deps.Store.ClearPendingRemoval([]string{old}); err != nil {
			return err
		}
		p.logf("[agent] 用户 %s 的 email 由 %s 变更为 %s，已卸载旧账号", user.BindingID, old, user.Email)
	}
	// All of them in ONE transaction, before any of the Xray work below.
	//
	// A per-user upsert loop cannot express an email HAND-OFF: desired_users_v2
	// has a unique email, so the first user taking an address another row still
	// holds fails — after the rename pass above has already uninstalled both
	// accounts. Two users offline, and every retry reproduces it. ApplyDesiredUsers
	// parks the contested addresses first, which makes a swap no harder than a
	// chain, and rolls the whole set back on failure.
	if err := p.deps.Store.ApplyDesiredUsers(users); err != nil {
		return err
	}
	// The pending note is an account's ONLY ownership evidence when the snapshot
	// that erased its record was applied without write access. Clearing it before
	// something durable has taken its place drops the account out of ownership
	// entirely, and a later snapshot that omits it then leaves it installed
	// forever — the desired-user row is no help, because cleanup deliberately
	// does not read ownership off those rows.
	//
	// So each branch below hands the claim over before letting go of it: an
	// enabled user gets a provisioning record first, a disabled one keeps the
	// note until its uninstall has actually succeeded.
	liveNow := make(map[string]bool, len(live))
	for _, account := range live {
		liveNow[account.Email] = true
	}
	clearPending := func(email string) error {
		if !stillPending[email] {
			return nil
		}
		if err := p.deps.Store.ClearPendingRemoval([]string{email}); err != nil {
			return err
		}
		delete(stillPending, email)
		return nil
	}
	for _, user := range users {
		if user.Enabled {
			// Install FIRST, then claim — see ensureUser. A failed install must
			// not leave a claim on an address that may be the panel's; an intent
			// covers the crash window in between, and is only written when the
			// address names no live account.
			//
			// The pending note is only released after the claim exists, which is
			// what keeps a failure here from dropping the account out of
			// ownership altogether.
			if liveNow[user.Email] && !ours[user.Email] {
				if err := p.collision(user); err != nil {
					return err
				}
			} else if err := p.deps.Store.RecordProvisionIntent(user.BindingID, user.Email, user.UUID); err != nil {
				return err
			}
			if err := p.deps.Xray.EnsureUser(ctx, user); err != nil {
				return err
			}
			if err := p.deps.Store.RecordProvisioned(user.BindingID, user.Email); err != nil {
				return err
			}
			if err := clearPending(user.Email); err != nil {
				return err
			}
			continue
		}
		if err := p.deps.Xray.RemoveUser(ctx, user.Email); err != nil {
			return err
		}
		// Disabled, so it is no longer installed — but the RECORD stays, and so
		// the account is still this agent's to account for. The claim is dropped
		// only when the account leaves for good, below.
		if err := clearPending(user.Email); err != nil {
			return err
		}
	}
	var unknown, retired []string
	liveEmails := make(map[string]bool, len(live))
	for _, installed := range live {
		liveEmails[installed.Email] = true
		if desired[installed.Email] {
			continue
		}
		if ours[installed.Email] || p.deps.RemoveUnknownUsers {
			// Propagate a failure rather than swallowing it: the caller must not
			// go on to replace the snapshot, which would delete the record that
			// proves this account is ours.
			if err := p.deps.Xray.RemoveUser(ctx, installed.Email); err != nil {
				return err
			}
			retired = append(retired, installed.Email)
			continue
		}
		unknown = append(unknown, installed.Email)
	}
	// A pending account that is no longer installed has nothing left to settle;
	// keeping it would make the list grow without bound.
	for email := range stillPending {
		if !liveEmails[email] {
			retired = append(retired, email)
		}
	}
	// The same for a PROVISIONING claim, and it matters more.
	//
	// The cleanup above only ever sees accounts Xray reports. An account that is
	// neither desired nor installed — Xray restarted and did not bring it back,
	// and the snapshot has since dropped it — is reachable by nothing: no row, no
	// live entry, so its claim would sit there forever. Then a panel
	// administrator reuses the address, and the next reconcile deletes THEIR
	// account as ours.
	//
	// Nothing is lost by releasing it: a claim only earns its keep while the
	// account still exists to be retired.
	for _, email := range provisioned {
		if !desired[email] && !liveEmails[email] {
			retired = append(retired, email)
		}
	}
	if err := p.deps.Store.ClearPendingRemoval(retired); err != nil {
		return err
	}
	// Retired accounts are uninstalled and out of the desired set; nothing is
	// left for this agent to answer for.
	if err := p.deps.Store.ForgetProvisioned(retired); err != nil {
		return err
	}
	if len(unknown) > 0 {
		p.logf("[agent] 入站中有 %d 个本节点从未记录过的账号，未做处理（B1 下入站与 3x-ui 面板共用，"+
			"它们可能属于面板）：%v", len(unknown), unknown)
	}
	return nil
}

// rememberDroppedOwnership notes the accounts this snapshot is about to forget
// while write access is elsewhere, so a later promotion can still retire them.
func (p *Processor) rememberDroppedOwnership(users []protocol.DesiredUser) error {
	recorded, err := p.deps.Store.ListDesiredUsers()
	if err != nil {
		return err
	}
	desired := make(map[string]bool, len(users))
	for _, user := range users {
		desired[user.Email] = true
	}
	// Same restriction as Reconcile's ownership map, and for the same reason: a
	// desired-user row is not evidence that ChordV provisioned the account. In
	// the shadow modes those rows include the PANEL's bindings, and noting them
	// as "ours, pending removal" would hand a later promotion a list of the
	// panel's accounts to uninstall — the mistake merely deferred rather than
	// avoided.
	provisioned, err := p.deps.Store.ProvisionedAccounts()
	if err != nil {
		return err
	}
	ours := make(map[string]bool, len(provisioned))
	for _, email := range provisioned {
		ours[email] = true
	}
	var dropped []string
	for _, user := range recorded {
		// Covers both an omitted binding and a renamed one: either way this
		// email is about to lose the record that names it.
		if !desired[user.Email] && ours[user.Email] {
			dropped = append(dropped, user.Email)
		}
	}
	return p.deps.Store.RecordPendingRemoval(dropped)
}

// findStored resolves the account a command addresses.
//
// The binding id is the IDENTITY; the email is an addressing convenience that
// can be reassigned. Matching on "binding id OR email" therefore returns
// whichever row happens to come first when a payload carries a binding id and an
// email belonging to a DIFFERENT binding — and the caller then edits, or
// uninstalls, the wrong account while reporting success. So the binding id wins
// when present, and an email pointing somewhere else is a conflict rather than a
// tie to break silently.
func (p *Processor) findStored(payload map[string]any) (*protocol.DesiredUser, error) {
	bindingID, _ := payload["bindingId"].(string)
	email, _ := payload["email"].(string)
	if email == "" {
		email, _ = payload["userKey"].(string)
	}
	if bindingID == "" && email == "" {
		return nil, nil
	}
	users, err := p.deps.Store.ListDesiredUsers()
	if err != nil {
		return nil, err
	}
	var byBinding, byEmail *protocol.DesiredUser
	for index := range users {
		if bindingID != "" && users[index].BindingID == bindingID {
			byBinding = &users[index]
		}
		if email != "" && users[index].Email == email {
			byEmail = &users[index]
		}
	}
	if bindingID == "" {
		return byEmail, nil
	}
	if byEmail != nil && byEmail.BindingID != bindingID {
		return nil, fmt.Errorf(
			"命令的 bindingId %s 与 email %s 指向不同的账号（该 email 属于 %s），拒绝执行",
			bindingID, email, byEmail.BindingID)
	}
	return byBinding, nil
}

// resolveUser merges the command's fields over the stored user, or builds a new
// one when this node has never seen the binding.
func (p *Processor) resolveUser(command protocol.Command, stored *protocol.DesiredUser) (protocol.DesiredUser, error) {
	if stored == nil {
		return parseDesiredUser(command.Payload, command.TargetRevision)
	}
	user := *stored
	if email, _ := optionalField(command.Payload, "email", "userKey"); email != "" {
		user.Email = email
	}
	if uuid, ok := command.Payload["uuid"].(string); ok && uuid != "" {
		user.UUID = uuid
	}
	if raw, present := command.Payload["flow"]; present {
		flow, err := parseFlow(raw)
		if err != nil {
			return protocol.DesiredUser{}, err
		}
		user.Flow = flow
	}
	// An explicitly supplied quota is the control plane's newer word and must
	// win — upsertDesiredUser only applies it when the command's revision is
	// higher, so ordering is already enforced. Dropping it (as the Node agent
	// does) makes re-enabling an exhausted user report success and then have the
	// very next metering tick disable it again, because the local remainder is
	// still zero.
	if value, ok := command.Payload["quotaRemainingBytes"].(string); ok && value != "" {
		user.QuotaRemainingBytes = value
	}
	if value, ok := command.Payload["offlineAllowanceBytes"].(string); ok && value != "" {
		user.OfflineAllowanceBytes = value
	}
	return user, nil
}

// --- payload parsing --------------------------------------------------------

func parseDesiredUsers(raw any, revision string) ([]protocol.DesiredUser, error) {
	items, ok := raw.([]any)
	if !ok {
		return nil, errors.New("RECONCILE_USERS 的 users 字段必须是数组")
	}
	users := make([]protocol.DesiredUser, 0, len(items))
	for _, item := range items {
		payload, ok := item.(map[string]any)
		if !ok {
			return nil, errors.New("命令缺少有效用户 payload")
		}
		user, err := parseDesiredUser(payload, revision)
		if err != nil {
			return nil, err
		}
		users = append(users, user)
	}
	// Checked here as well as in Reconcile, because an observing node never
	// reaches Reconcile: it persists the snapshot and stops. A duplicate
	// bindingId would collapse into one row there just as silently, and the node
	// would carry that damaged record into its next promotion.
	if err := distinctBindings(users); err != nil {
		return nil, err
	}
	return users, nil
}

func parseDesiredUser(payload map[string]any, revision string) (protocol.DesiredUser, error) {
	bindingID, err := stringField(payload, "bindingId")
	if err != nil {
		return protocol.DesiredUser{}, err
	}
	email, err := optionalField(payload, "email", "userKey")
	if err != nil {
		return protocol.DesiredUser{}, err
	}
	if email == "" {
		return protocol.DesiredUser{}, errors.New("命令缺少 email")
	}
	uuid, err := stringField(payload, "uuid")
	if err != nil {
		return protocol.DesiredUser{}, err
	}
	flow, err := parseFlow(payload["flow"])
	if err != nil {
		return protocol.DesiredUser{}, err
	}
	user := protocol.DesiredUser{
		BindingID: bindingID, Email: email, UUID: uuid, Flow: flow,
		Revision: revision, Enabled: true,
		QuotaRemainingBytes:   "0",
		OfflineAllowanceBytes: "",
	}
	if value, ok := payload["revision"].(string); ok && value != "" {
		user.Revision = value
	}
	// Absent means enabled; only an explicit false disables. A missing field
	// must never silently take a user offline.
	if value, ok := payload["enabled"].(bool); ok {
		user.Enabled = value
	}
	if value, ok := payload["quotaRemainingBytes"].(string); ok && value != "" {
		user.QuotaRemainingBytes = value
	}
	if value, ok := payload["offlineAllowanceBytes"].(string); ok && value != "" {
		user.OfflineAllowanceBytes = value
	}
	return user, nil
}

func parseFlow(raw any) (string, error) {
	if raw == nil {
		return protocol.FlowNone, nil
	}
	value, ok := raw.(string)
	if !ok || (value != protocol.FlowNone && value != protocol.FlowVision) {
		return "", errors.New("flow 仅支持 xtls-rprx-vision 或空字符串")
	}
	return value, nil
}

func stringField(payload map[string]any, field string) (string, error) {
	value, _ := payload[field].(string)
	if value == "" {
		return "", fmt.Errorf("命令缺少 %s", field)
	}
	return value, nil
}

// optionalField returns the first non-empty of the given keys, or "".
func optionalField(payload map[string]any, fields ...string) (string, error) {
	for _, field := range fields {
		if value, ok := payload[field].(string); ok && value != "" {
			return value, nil
		}
	}
	return "", nil
}

// mergeNewerBindings folds a snapshot together with any per-binding state that
// is newer than it.
//
// Two directions, and both matter:
//
//   - a binding the snapshot CARRIES, whose stored revision is higher — the
//     stored state wins, so a stale Enabled flag cannot reinstall an account a
//     newer DISABLE_USER took down;
//   - a binding the snapshot OMITS, whose stored revision is higher — it was
//     added by a newer command, so it is kept rather than uninstalled and
//     forgotten.
//
// Anything at or below the command's own target revision is left to the snapshot:
// that is what a full reconcile is for. The COMMAND's revision is the yardstick,
// not one derived from the payload — an empty snapshot ("remove everyone") carries
// no user to derive it from, and falling back to zero would turn it into a no-op.
func (p *Processor) mergeNewerBindings(users []protocol.DesiredUser, snapshotRevision string) ([]protocol.DesiredUser, error) {
	recorded, err := p.deps.Store.ListDesiredUsers()
	if err != nil {
		return nil, err
	}
	stored := make(map[string]protocol.DesiredUser, len(recorded))
	for _, user := range recorded {
		stored[user.BindingID] = user
	}
	merged := make([]protocol.DesiredUser, 0, len(users))
	carried := make(map[string]bool, len(users))
	for _, user := range users {
		carried[user.BindingID] = true
		existing, known := stored[user.BindingID]
		// A snapshot from before a terminal command still passes the watermark
		// gate, so it can carry a binding that has since been revoked. Without
		// this the reconcile below would reinstall it.
		//
		// supersededForBinding, NOT supersededBinding: user.Revision is the
		// binding's own revision, not this snapshot's. The command's freshness
		// was checked against the watermark by the caller; measuring a per-user
		// revision against it again would drop any binding whose last change
		// predates the previous snapshot — which is most of them.
		if !known {
			superseded, err := p.supersededForBinding(user.BindingID, user.Revision, nil)
			if err != nil {
				return nil, err
			}
			if superseded {
				continue
			}
			merged = append(merged, user)
			continue
		}
		// The same question for a binding we DO have a row for, and it has to be
		// the same predicate: a plain "is the snapshot older" comparison lets a
		// snapshot carrying the binding enabled at the very revision that
		// disabled it reinstall the account.
		superseded, err := p.supersededForBinding(user.BindingID, user.Revision, &existing)
		if err != nil {
			return nil, err
		}
		if superseded {
			merged = append(merged, existing)
			continue
		}
		merged = append(merged, user)
	}
	// This loop DOES measure a stored revision against a snapshot revision, and
	// that is deliberate. Its question is not "which instruction is newer about
	// this binding" but "was this binding added AFTER the snapshot was built" —
	// and the only quantity the agent holds that can stand for "after" is the
	// stored revision. That reads correctly when the row was written by a
	// command (its revision is that command's freshness claim) and conservatively
	// when the row came from an earlier snapshot (a last-modified stamp, so at
	// worst an old row is left to the snapshot's own omission handling).
	// Restricting this to the binding's own history instead would mean the loop
	// could never uninstall anything.
	for _, user := range recorded {
		if carried[user.BindingID] {
			continue
		}
		newer, err := decimal.Less(snapshotRevision, user.Revision)
		if err != nil {
			return nil, err
		}
		if newer {
			merged = append(merged, user)
		}
	}
	return merged, nil
}
