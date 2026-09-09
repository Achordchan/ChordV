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
	// A changed email is a NEW account as far as Xray is concerned — the adapter
	// addresses accounts by email and cannot infer the previous one. Uninstall
	// the old one FIRST, while the record that names it is still here: after the
	// upsert below the old email is gone from the store, and with unknown-user
	// removal off nothing would ever clean it up. It would keep serving, with no
	// desired-user record left to account for its traffic.
	//
	// The metering baseline follows on its own: the new account's counters start
	// at zero, which reads as a counter reset, so the next sample bumps the
	// generation and bills the new account's traffic in full.
	if stored != nil && stored.Email != user.Email {
		if err := p.deps.Xray.RemoveUser(ctx, stored.Email); err != nil {
			return err
		}
		p.logf("[agent] 用户 %s 的 email 由 %s 变更为 %s，已卸载旧账号", user.BindingID, stored.Email, user.Email)
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
	return p.deps.Xray.EnsureUser(ctx, user)
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
func (p *Processor) supersededBinding(bindingID, targetRevision string, stored *protocol.DesiredUser) (bool, error) {
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
	older, err = decimal.Less(targetRevision, stored.Revision)
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
	if stored != nil {
		older, err := decimal.Less(command.TargetRevision, stored.Revision)
		if err != nil || older {
			return err
		}
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
	// Recorded for BOTH kinds, and even when this node had no row to act on.
	//
	// A disable whose row survives is guarded by that row's revision — but a
	// disable for a binding this node does not store leaves no evidence at all,
	// and a delayed enable at a lower revision would then restore access to an
	// account the control plane just took down. The tombstone is a floor on the
	// binding rather than a fact about the row, so it applies uniformly.
	bindingID, _ := command.Payload["bindingId"].(string)
	if stored != nil {
		bindingID = stored.BindingID
	}
	if bindingID != "" {
		if err := p.deps.Store.RecordBindingTombstone(bindingID, command.TargetRevision); err != nil {
			return err
		}
	}
	if stored == nil {
		return nil
	}
	if remove {
		return p.deps.Store.DeleteUser(stored.BindingID)
	}
	return p.deps.Store.SetUserEnabled(stored.BindingID, false, command.TargetRevision)
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
func (p *Processor) Reconcile(ctx context.Context, users []protocol.DesiredUser) error {
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
	ours := make(map[string]bool, len(recorded))
	for _, user := range recorded {
		ours[user.Email] = true
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
		if err := p.deps.Xray.RemoveUser(ctx, old); err != nil {
			return err
		}
		p.logf("[agent] 用户 %s 的 email 由 %s 变更为 %s，已卸载旧账号", user.BindingID, old, user.Email)
	}
	for _, user := range users {
		if err := p.deps.Store.UpsertDesiredUser(user); err != nil {
			return err
		}
		// Only AFTER the desired-user record is durable. Dropping the pending
		// note first would leave a re-added account with NEITHER form of
		// ownership evidence if this loop then fails or the process dies — and
		// the next snapshot that omits it would classify it as unknown and leave
		// it serving. The opposite order is harmless: holding both for a moment
		// just means the next reconcile clears it.
		if stillPending[user.Email] {
			if err := p.deps.Store.ClearPendingRemoval([]string{user.Email}); err != nil {
				return err
			}
			delete(stillPending, user.Email)
		}
		if user.Enabled {
			if err := p.deps.Xray.EnsureUser(ctx, user); err != nil {
				return err
			}
			continue
		}
		if err := p.deps.Xray.RemoveUser(ctx, user.Email); err != nil {
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
	if err := p.deps.Store.ClearPendingRemoval(retired); err != nil {
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
	var dropped []string
	for _, user := range recorded {
		// Covers both an omitted binding and a renamed one: either way this
		// email is about to lose the record that names it.
		if !desired[user.Email] {
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
		if !known {
			superseded, err := p.supersededBinding(user.BindingID, user.Revision, nil)
			if err != nil {
				return nil, err
			}
			if superseded {
				continue
			}
			merged = append(merged, user)
			continue
		}
		newer, err := decimal.Less(user.Revision, existing.Revision)
		if err != nil {
			return nil, err
		}
		if newer {
			merged = append(merged, existing)
			continue
		}
		merged = append(merged, user)
	}
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
