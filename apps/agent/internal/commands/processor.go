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
		// longer deploys one. The replacement semantics — verify the configured
		// tag is usable — arrive in P2 with the adapter that can check it.
		// Failing loudly is the only honest answer for this build; reporting
		// "completed" would advance the node's applied revision for work that
		// never happened.
		return nil, errors.New("本构建不支持 ENSURE_INBOUND：B1 下入站由 3x-ui 面板创建，校验能力随 P2 提供")
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
	skip, err := p.staleForEnable(command, stored)
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
	return p.deps.Xray.EnsureUser(ctx, user)
}

// staleForEnable reports whether this enable has already been superseded.
func (p *Processor) staleForEnable(command protocol.Command, stored *protocol.DesiredUser) (bool, error) {
	current, err := p.deps.Store.ConfigRevision()
	if err != nil {
		return false, err
	}
	older, err := decimal.Less(command.TargetRevision, current)
	if err != nil || older {
		return older, err
	}
	if stored == nil {
		return false, nil
	}
	older, err = decimal.Less(command.TargetRevision, stored.Revision)
	if err != nil || older {
		return older, err
	}
	// Same revision, already disabled: a re-delivered enable must not undo the
	// disable that the SAME revision produced.
	return command.TargetRevision == stored.Revision && !stored.Enabled, nil
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
	// Xray FIRST here, unlike ensureUser: until the account is uninstalled it is
	// still carrying traffic, and a crash after the local delete would leave it
	// serving with nothing left to notice it.
	if err := p.deps.Xray.RemoveUser(ctx, email); err != nil {
		return err
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
	older, err := decimal.Less(command.TargetRevision, current.Revision)
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
	mode := current.ControlMode
	if value, ok := command.Payload["controlMode"].(string); ok && protocol.IsControlMode(value) {
		mode = protocol.ControlMode(value)
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
	// An account handed back a desired-user record of its own is no longer
	// pending anything.
	var settled []string
	for _, email := range pending {
		if desired[email] {
			settled = append(settled, email)
		}
	}
	if err := p.deps.Store.ClearPendingRemoval(settled); err != nil {
		return err
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
	for _, email := range pending {
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
