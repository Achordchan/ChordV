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
		return nil, p.reconcileCommand(ctx, command, writable)
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

func (p *Processor) reconcileCommand(ctx context.Context, command protocol.Command, writable bool) error {
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
	// The mode change lands with the users it authorises, so a node being handed
	// the direct track installs them in the same command that grants it.
	if writable && mode == protocol.ModeDirectPrimary {
		if err := p.Reconcile(ctx, users); err != nil {
			return err
		}
	}
	_, err = p.deps.Store.ApplyConfigSnapshot(protocol.ConfigSnapshot{
		NodeID: current.NodeID, Revision: command.TargetRevision, ControlMode: mode, Users: users,
	})
	return err
}

// Reconcile makes Xray's installed accounts match the desired set.
//
// The final step — what to do about accounts that are live but NOT desired —
// is where this deliberately departs from the Node agent.
//
// There, ChordV owned the whole inbound (`chordv-in`, created by the agent), so
// a live account outside the desired set could only be ChordV's own leftover and
// removing it was correct. Under B1 the inbound is created by an administrator
// in the 3x-ui panel and is SHARED (PRD §3.1), so ListUsers also returns the
// PANEL's accounts. Porting that step unchanged would have ChordV silently
// delete the panel's users — a destructive, cross-boundary action produced
// purely by the topology change, with no code change behind it.
//
// So it is OFF by default: strangers are reported, not removed. The cost is that
// a ChordV account deleted while the agent was down keeps serving until someone
// notices. Closing that gap safely needs a way to tell "ours" from "theirs" —
// an email namespace is the obvious candidate — which is a control-plane
// decision, recorded as an open item in the PRD rather than assumed here.
func (p *Processor) Reconcile(ctx context.Context, users []protocol.DesiredUser) error {
	live, err := p.deps.Xray.ListUsers(ctx)
	if err != nil {
		return err
	}
	desired := make(map[string]bool, len(users))
	for _, user := range users {
		desired[user.Email] = true
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
	var strangers []string
	for _, installed := range live {
		if desired[installed.Email] {
			continue
		}
		strangers = append(strangers, installed.Email)
	}
	if len(strangers) == 0 {
		return nil
	}
	if !p.deps.RemoveUnknownUsers {
		p.logf("[agent] 入站中有 %d 个不在下发名单里的账号，未做处理（B1 下入站与 3x-ui 面板共用，"+
			"删除它们可能会删掉面板自己的用户）：%v", len(strangers), strangers)
		return nil
	}
	for _, email := range strangers {
		if err := p.deps.Xray.RemoveUser(ctx, email); err != nil {
			return err
		}
	}
	return nil
}

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
	for index := range users {
		if (bindingID != "" && users[index].BindingID == bindingID) ||
			(email != "" && users[index].Email == email) {
			found := users[index]
			return &found, nil
		}
	}
	return nil, nil
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
