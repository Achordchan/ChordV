package commands

import (
	"context"
	"errors"
	"math/big"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Achordchan/ChordV/apps/agent/internal/protocol"
	"github.com/Achordchan/ChordV/apps/agent/internal/store"
	"github.com/Achordchan/ChordV/apps/agent/internal/xray"
)

// fakeXray records what the processor asked of Xray, in order.
type fakeXray struct {
	live      []xray.LiveUser
	calls     []string
	ensureErr error
	// ensureErrFor fails the install of ONE account, so a test can stop the loop
	// partway and inspect what survived.
	ensureErrFor string
	removeErr    error
	// removeErrFor fails the uninstall of ONE account, so a test can prove that a
	// failure stops the caller from going on to erase the evidence.
	removeErrFor string
	// onRemove runs at the moment of uninstall. Ordering between the store and
	// Xray cannot be seen from the call log alone — store writes do not appear
	// in it — so a test that cares about the interleaving observes the store
	// from inside the call instead.
	onRemove func()
}

func (f *fakeXray) Health(context.Context) error                 { return nil }
func (f *fakeXray) UptimeSeconds(context.Context) (int64, error) { return 100, nil }
func (f *fakeXray) ListUsers(context.Context) ([]xray.LiveUser, error) {
	f.calls = append(f.calls, "list")
	return f.live, nil
}
func (f *fakeXray) EnsureUser(_ context.Context, user protocol.DesiredUser) error {
	f.calls = append(f.calls, "ensure:"+user.Email)
	if f.ensureErrFor != "" && f.ensureErrFor == user.Email {
		return errors.New("安装失败")
	}
	return f.ensureErr
}
func (f *fakeXray) RemoveUser(_ context.Context, email string) error {
	f.calls = append(f.calls, "remove:"+email)
	if f.onRemove != nil {
		f.onRemove()
	}
	if f.removeErrFor != "" && f.removeErrFor == email {
		return errors.New("卸载失败")
	}
	return f.removeErr
}
func (f *fakeXray) ReadAbsoluteCounters(context.Context) ([]protocol.AbsoluteCounter, error) {
	return nil, nil
}

func newProcessor(t *testing.T, removeUnknown bool) (*Processor, *fakeXray, *store.Store) {
	t.Helper()
	state, err := store.Open(filepath.Join(t.TempDir(), "node-agent.db"), store.Options{
		BootID: "boot-1", NodeID: "node-1", DefaultOfflineAllowance: big.NewInt(64 * 1024 * 1024),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { state.Close() })
	fake := &fakeXray{}
	return New(Deps{Store: state, Xray: fake, RemoveUnknownUsers: removeUnknown, Logf: func(string, ...any) {}}), fake, state
}

func command(id string, kind protocol.CommandType, revision string, payload map[string]any) protocol.Command {
	return protocol.Command{CommandID: id, Type: kind, TargetRevision: revision, Payload: payload}
}

func userPayload(bindingID, email string) map[string]any {
	return map[string]any{
		"bindingId": bindingID, "email": email, "uuid": "uuid-" + bindingID,
		"flow": protocol.FlowVision, "quotaRemainingBytes": "1000000",
	}
}

func run(t *testing.T, p *Processor, cmd protocol.Command, writable bool) protocol.CommandResult {
	t.Helper()
	result, err := p.Execute(context.Background(), cmd, writable)
	if err != nil {
		t.Fatalf("Execute(%s): %v", cmd.CommandID, err)
	}
	return result
}

// --- the B1 departure -------------------------------------------------------

// TestReconcileDoesNotRemoveAccountsItDoesNotOwn is the one place this port
// deliberately differs from the Node agent, and the reason is the topology, not
// the code.
//
// There, ChordV created and owned the whole inbound, so a live account outside
// the desired set could only be its own leftover. Under B1 the inbound is
// created by an administrator in the 3x-ui panel and is SHARED, so ListUsers
// also returns the PANEL's accounts — and the ported line would delete them.
func TestReconcileDoesNotRemoveAccountsItDoesNotOwn(t *testing.T) {
	processor, fake, _ := newProcessor(t, false)
	fake.live = []xray.LiveUser{
		{Email: "u1@chordv"},
		{Email: "someone@panel"}, // the panel's own account, on the shared inbound
	}
	users := []protocol.DesiredUser{{
		BindingID: "b1", Email: "u1@chordv", UUID: "uuid-b1", Revision: "1",
		Enabled: true, QuotaRemainingBytes: "1000", OfflineAllowanceBytes: "1000",
	}}
	if err := processor.Reconcile(context.Background(), users); err != nil {
		t.Fatal(err)
	}
	for _, call := range fake.calls {
		if call == "remove:someone@panel" {
			t.Fatal("reconcile deleted an account belonging to the 3x-ui panel")
		}
	}
	// The desired account is still installed, so the safe default costs nothing
	// on the happy path.
	if !contains(fake.calls, "ensure:u1@chordv") {
		t.Fatalf("calls = %v", fake.calls)
	}
}

func TestReconcileRemovesStrangersOnlyWhenExplicitlyAllowed(t *testing.T) {
	processor, fake, _ := newProcessor(t, true)
	fake.live = []xray.LiveUser{{Email: "u1@chordv"}, {Email: "gone@chordv"}}
	users := []protocol.DesiredUser{{
		BindingID: "b1", Email: "u1@chordv", UUID: "uuid-b1", Revision: "1",
		Enabled: true, QuotaRemainingBytes: "1000", OfflineAllowanceBytes: "1000",
	}}
	if err := processor.Reconcile(context.Background(), users); err != nil {
		t.Fatal(err)
	}
	// The gap the safe default leaves open: an account deleted while the agent
	// was down keeps serving. The switch closes it, for a deployment that can
	// prove the inbound is not shared.
	if !contains(fake.calls, "remove:gone@chordv") {
		t.Fatalf("calls = %v", fake.calls)
	}
}

func TestReconcileUninstallsDisabledUsers(t *testing.T) {
	processor, fake, _ := newProcessor(t, false)
	users := []protocol.DesiredUser{{
		BindingID: "b1", Email: "u1@chordv", UUID: "uuid-b1", Revision: "1",
		Enabled: false, QuotaRemainingBytes: "0", OfflineAllowanceBytes: "1000",
	}}
	if err := processor.Reconcile(context.Background(), users); err != nil {
		t.Fatal(err)
	}
	// A disabled user is in the desired SET but must not be installed — the
	// stranger rule never sees them, so this has to be handled here.
	if !contains(fake.calls, "remove:u1@chordv") || contains(fake.calls, "ensure:u1@chordv") {
		t.Fatalf("calls = %v", fake.calls)
	}
}

// --- the mode gate ----------------------------------------------------------

func TestOnlyLocalCommandsRunWithoutWriteAccess(t *testing.T) {
	processor, fake, state := newProcessor(t, false)
	state.UpsertDesiredUser(protocol.DesiredUser{
		BindingID: "b1", Email: "u1@chordv", UUID: "u", Revision: "1",
		Enabled: true, QuotaRemainingBytes: "1000", OfflineAllowanceBytes: "1000",
	})
	for _, kind := range []protocol.CommandType{
		protocol.CommandEnsureUser, protocol.CommandEnableUser,
		protocol.CommandDisableUser, protocol.CommandRemoveUser, protocol.CommandEnsureInbound,
	} {
		result := run(t, processor, command("c-"+string(kind), kind, "2", userPayload("b1", "u1@chordv")), false)
		if result.Status != protocol.StatusFailed {
			t.Fatalf("%s was executed without write access", kind)
		}
	}
	if len(fake.calls) != 0 {
		t.Fatalf("a non-writable node touched Xray: %v", fake.calls)
	}
	// These two only touch local state, so an observing node may run them.
	result := run(t, processor, command("c-quota", protocol.CommandRefreshQuota, "3",
		map[string]any{"bindingId": "b1", "quotaRemainingBytes": "555"}), false)
	if result.Status != protocol.StatusCompleted {
		t.Fatalf("REFRESH_QUOTA refused on an observing node: %+v", result)
	}
}

// --- idempotency ------------------------------------------------------------

func TestARedeliveredCompletedCommandIsNotExecutedAgain(t *testing.T) {
	processor, fake, _ := newProcessor(t, false)
	cmd := command("c1", protocol.CommandEnsureUser, "2", userPayload("b1", "u1@chordv"))
	first := run(t, processor, cmd, true)
	if first.Status != protocol.StatusCompleted || first.Result["appliedRevision"] != "2" {
		t.Fatalf("first = %+v", first)
	}
	before := len(fake.calls)
	second := run(t, processor, cmd, true)
	if second.Status != protocol.StatusCompleted {
		t.Fatalf("second = %+v", second)
	}
	// The control plane redelivers; repeating the work would be at best wasted
	// and at worst a resurrection of a user removed in between.
	if len(fake.calls) != before {
		t.Fatalf("the redelivery touched Xray again: %v", fake.calls)
	}
}

func TestAFailedCommandIsReportedAndMayBeRetried(t *testing.T) {
	processor, fake, _ := newProcessor(t, false)
	fake.ensureErr = errors.New("Xray 尚未就绪")
	cmd := command("c1", protocol.CommandEnsureUser, "2", userPayload("b1", "u1@chordv"))
	result := run(t, processor, cmd, true)
	if result.Status != protocol.StatusFailed || !strings.Contains(result.Error, "尚未就绪") {
		t.Fatalf("result = %+v", result)
	}
	// A failure must not advance the applied revision — the control plane treats
	// that as "this instruction landed".
	if revision, _ := processor.deps.Store.ConfigRevision(); revision != "0" {
		t.Fatalf("a failed command advanced the applied revision to %s", revision)
	}
	fake.ensureErr = nil
	retry := run(t, processor, cmd, true)
	if retry.Status != protocol.StatusCompleted {
		t.Fatalf("a transient failure became permanent: %+v", retry)
	}
}

// --- individual commands ----------------------------------------------------

func TestEnsureUserRecordsLocallyBeforeInstalling(t *testing.T) {
	processor, fake, state := newProcessor(t, false)
	fake.ensureErr = errors.New("gRPC 断开")
	run(t, processor, command("c1", protocol.CommandEnsureUser, "2", userPayload("b1", "u1@chordv")), true)
	// Store first: a crash between the two leaves a user the store knows about
	// but Xray does not, which the next reconcile repairs. The reverse leaves an
	// account serving traffic that no local record accounts for.
	stored, err := state.UserByBindingID("b1")
	if err != nil || stored == nil {
		t.Fatalf("the user was not recorded before the install was attempted: %v", err)
	}
}

func TestAStaleEnableDoesNotUndoANewerDisable(t *testing.T) {
	processor, fake, state := newProcessor(t, false)
	run(t, processor, command("c1", protocol.CommandEnsureUser, "5", userPayload("b1", "u1@chordv")), true)
	run(t, processor, command("c2", protocol.CommandDisableUser, "6",
		map[string]any{"bindingId": "b1", "email": "u1@chordv"}), true)

	before := len(fake.calls)
	// A redelivered enable from an older revision must not resurrect the user.
	result := run(t, processor, command("c3", protocol.CommandEnableUser, "4", userPayload("b1", "u1@chordv")), true)
	if result.Status != protocol.StatusCompleted {
		t.Fatalf("a superseded enable should be a no-op, not a failure: %+v", result)
	}
	if len(fake.calls) != before {
		t.Fatalf("a stale enable reinstalled the user: %v", fake.calls)
	}
	stored, _ := state.UserByBindingID("b1")
	if stored == nil || stored.Enabled {
		t.Fatalf("stored = %+v", stored)
	}

	// The SAME revision, redelivered out of order. A plain "older than stored"
	// check does not catch this — the disable that produced the current state
	// carries exactly this revision — yet re-enabling would undo it.
	result = run(t, processor, command("c4", protocol.CommandEnableUser, "6", userPayload("b1", "u1@chordv")), true)
	if result.Status != protocol.StatusCompleted {
		t.Fatalf("result = %+v", result)
	}
	if len(fake.calls) != before {
		t.Fatalf("an enable at the disable's own revision resurrected the user: %v", fake.calls)
	}
	if stored, _ := state.UserByBindingID("b1"); stored == nil || stored.Enabled {
		t.Fatalf("stored = %+v", stored)
	}
}

func TestTerminalCommandsUninstallBeforeForgetting(t *testing.T) {
	processor, fake, state := newProcessor(t, false)
	run(t, processor, command("c1", protocol.CommandEnsureUser, "2", userPayload("b1", "u1@chordv")), true)

	fake.calls = nil
	// Xray FIRST: until the account is uninstalled it is still carrying traffic,
	// and a crash after the local delete would leave it serving with no local
	// record left to notice it. The call log alone cannot show this — store
	// writes do not appear in it — so the store is observed from inside the
	// uninstall.
	recordPresentDuringRemove := false
	fake.onRemove = func() {
		stored, err := state.UserByBindingID("b1")
		if err == nil && stored != nil {
			recordPresentDuringRemove = true
		}
	}
	run(t, processor, command("c2", protocol.CommandRemoveUser, "3",
		map[string]any{"bindingId": "b1", "email": "u1@chordv"}), true)
	if len(fake.calls) == 0 || fake.calls[0] != "remove:u1@chordv" {
		t.Fatalf("calls = %v", fake.calls)
	}
	if !recordPresentDuringRemove {
		t.Fatal("the local record was deleted BEFORE the account was uninstalled")
	}
	if stored, _ := state.UserByBindingID("b1"); stored != nil {
		t.Fatal("REMOVE_USER left the local record behind")
	}
}

func TestATerminalCommandStillWorksForAUserThisNodeForgot(t *testing.T) {
	processor, fake, _ := newProcessor(t, false)
	// The local record may already be gone while the account is still installed
	// — exactly when a terminal command matters most.
	result := run(t, processor, command("c1", protocol.CommandDisableUser, "3",
		map[string]any{"bindingId": "b-unknown", "email": "ghost@chordv"}), true)
	if result.Status != protocol.StatusCompleted {
		t.Fatalf("result = %+v", result)
	}
	if !contains(fake.calls, "remove:ghost@chordv") {
		t.Fatalf("calls = %v", fake.calls)
	}
}

func TestReconcileUsersRefusesAStaleRevisionAndCarriesTheMode(t *testing.T) {
	processor, _, state := newProcessor(t, false)
	payload := map[string]any{
		"controlMode": string(protocol.ModeDirectPrimary),
		"users":       []any{map[string]any(userPayload("b1", "u1@chordv"))},
	}
	if result := run(t, processor, command("c1", protocol.CommandReconcileUsers, "10", payload), true); result.Status != protocol.StatusCompleted {
		t.Fatalf("result = %+v", result)
	}
	if mode, _ := state.ControlMode(); mode != protocol.ModeDirectPrimary {
		t.Fatalf("mode = %s", mode)
	}
	// An older reconcile would replace the user set with a superseded one.
	result := run(t, processor, command("c2", protocol.CommandReconcileUsers, "9", payload), true)
	if result.Status != protocol.StatusFailed || !strings.Contains(result.Error, "过期") {
		t.Fatalf("a stale RECONCILE_USERS was accepted: %+v", result)
	}
}

func TestEnsureInboundFailsLoudlyInThisBuild(t *testing.T) {
	processor, _, _ := newProcessor(t, false)
	result := run(t, processor, command("c1", protocol.CommandEnsureInbound, "2", map[string]any{}), true)
	// B1 moved inbound ownership to the panel; the verification that replaces
	// deployment arrives in P2. Reporting "completed" would advance the node's
	// applied revision for work that never happened.
	if result.Status != protocol.StatusFailed {
		t.Fatalf("result = %+v", result)
	}
	// The deployed control plane still queues these and populates the node's
	// connection parameters from the report, so this failure is not
	// self-contained: the message has to name what the operator must do instead,
	// or a node moved to this agent too early is simply "online and unable to
	// serve anyone".
	for _, needle := range []string{"面板", "vless", "无法服务"} {
		if !strings.Contains(result.Error, needle) {
			t.Fatalf("the refusal does not mention %q: %s", needle, result.Error)
		}
	}
}

func TestAnUnknownCommandTypeIsRefused(t *testing.T) {
	processor, _, _ := newProcessor(t, false)
	result := run(t, processor, command("c1", protocol.CommandType("ROTATE_KEYS"), "2", map[string]any{}), true)
	// A newer control plane talking to an older agent. Guessing is worse than
	// refusing, and the control plane needs to hear that it did not land.
	if result.Status != protocol.StatusFailed {
		t.Fatalf("an unknown command type was accepted: %+v", result)
	}
}

func TestMissingPayloadFieldsAreRefused(t *testing.T) {
	processor, _, _ := newProcessor(t, false)
	for name, payload := range map[string]map[string]any{
		"no bindingId": {"email": "u1@chordv", "uuid": "u"},
		"no uuid":      {"bindingId": "b1", "email": "u1@chordv"},
		"no email":     {"bindingId": "b1", "uuid": "u"},
		"bad flow":     {"bindingId": "b1", "email": "u1@chordv", "uuid": "u", "flow": "vision"},
	} {
		result := run(t, processor, command("c-"+name, protocol.CommandEnsureUser, "2", payload), true)
		if result.Status != protocol.StatusFailed {
			t.Fatalf("%s was accepted: %+v", name, result)
		}
	}
}

func TestAnAbsentEnabledFlagMeansEnabled(t *testing.T) {
	processor, fake, state := newProcessor(t, false)
	// This has to go through RECONCILE_USERS: the ENSURE_USER path sets Enabled
	// explicitly, so it cannot see the payload default at all.
	payload := map[string]any{
		"controlMode": string(protocol.ModeDirectPrimary),
		"users":       []any{map[string]any(userPayload("b1", "u1@chordv"))}, // no "enabled" key
	}
	if result := run(t, processor, command("c1", protocol.CommandReconcileUsers, "2", payload), true); result.Status != protocol.StatusCompleted {
		t.Fatalf("result = %+v", result)
	}
	// A missing field must never silently take a user offline: absent means
	// enabled, and only an explicit false disables.
	if !contains(fake.calls, "ensure:u1@chordv") || contains(fake.calls, "remove:u1@chordv") {
		t.Fatalf("calls = %v", fake.calls)
	}
	if stored, _ := state.UserByBindingID("b1"); stored == nil || !stored.Enabled {
		t.Fatalf("stored = %+v", stored)
	}

	// And an explicit false still disables.
	disabled := map[string]any(userPayload("b2", "u2@chordv"))
	disabled["enabled"] = false
	if result := run(t, processor, command("c2", protocol.CommandReconcileUsers, "3", map[string]any{
		"controlMode": string(protocol.ModeDirectPrimary),
		"users":       []any{disabled},
	}), true); result.Status != protocol.StatusCompleted {
		t.Fatalf("result = %+v", result)
	}
	if stored, _ := state.UserByBindingID("b2"); stored == nil || stored.Enabled {
		t.Fatalf("an explicit enabled:false was ignored: %+v", stored)
	}
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

// --- ownership evidence -----------------------------------------------------

// TestReconcileRemovesOmittedAccountsItHasARecordOf closes the gap the safe
// default would otherwise leave open, WITHOUT touching the panel's accounts.
//
// A subscription revoked while the agent was offline arrives as a full
// RECONCILE_USERS that simply omits the binding. Leaving it installed keeps
// serving an account nobody is paying for — and ApplyConfigSnapshot then deletes
// the only local record of it, so nothing would ever notice again. A stored
// desired-user record is proof that the account is ours, which is exactly the
// distinction the panel's accounts do not satisfy.
func TestReconcileRemovesOmittedAccountsItHasARecordOf(t *testing.T) {
	processor, fake, state := newProcessor(t, false)
	for _, seeded := range []protocol.DesiredUser{
		{BindingID: "b1", Email: "u1@chordv", UUID: "u1", Revision: "1", Enabled: true, QuotaRemainingBytes: "1000", OfflineAllowanceBytes: "1000"},
		{BindingID: "b2", Email: "revoked@chordv", UUID: "u2", Revision: "1", Enabled: true, QuotaRemainingBytes: "1000", OfflineAllowanceBytes: "1000"},
	} {
		if err := state.UpsertDesiredUser(seeded); err != nil {
			t.Fatal(err)
		}
	}
	fake.live = []xray.LiveUser{
		{Email: "u1@chordv"},
		{Email: "revoked@chordv"}, // ours, dropped from the new instruction
		{Email: "someone@panel"},  // never ours
	}
	payload := map[string]any{
		"controlMode": string(protocol.ModeDirectPrimary),
		"users":       []any{map[string]any(userPayload("b1", "u1@chordv"))},
	}
	if result := run(t, processor, command("c1", protocol.CommandReconcileUsers, "5", payload), true); result.Status != protocol.StatusCompleted {
		t.Fatalf("result = %+v", result)
	}
	if !contains(fake.calls, "remove:revoked@chordv") {
		t.Fatalf("a revoked account this node owned was left serving: %v", fake.calls)
	}
	if contains(fake.calls, "remove:someone@panel") {
		t.Fatalf("an account this node never recorded was deleted: %v", fake.calls)
	}
	// And the snapshot did replace the set.
	if stored, _ := state.UserByBindingID("b2"); stored != nil {
		t.Fatal("the omitted binding kept its local record")
	}
}

func TestAFailedUninstallStopsTheSnapshotFromErasingTheEvidence(t *testing.T) {
	processor, fake, state := newProcessor(t, false)
	if err := state.UpsertDesiredUser(protocol.DesiredUser{
		BindingID: "b2", Email: "revoked@chordv", UUID: "u2", Revision: "1",
		Enabled: true, QuotaRemainingBytes: "1000", OfflineAllowanceBytes: "1000",
	}); err != nil {
		t.Fatal(err)
	}
	fake.live = []xray.LiveUser{{Email: "revoked@chordv"}}
	fake.removeErrFor = "revoked@chordv"

	result := run(t, processor, command("c1", protocol.CommandReconcileUsers, "5", map[string]any{
		"controlMode": string(protocol.ModeDirectPrimary),
		"users":       []any{map[string]any(userPayload("b1", "u1@chordv"))},
	}), true)
	if result.Status != protocol.StatusFailed {
		t.Fatalf("a failed uninstall was reported as success: %+v", result)
	}
	// The record is the only proof the account is ours. Losing it while the
	// account is still installed makes the leak permanent and invisible.
	if stored, _ := state.UserByBindingID("b2"); stored == nil {
		t.Fatal("the record was deleted even though the account is still installed")
	}
}

// --- merging an existing user -----------------------------------------------

func TestEnablingAnExhaustedUserAdoptsTheReplenishedQuota(t *testing.T) {
	processor, _, state := newProcessor(t, false)
	if err := state.UpsertDesiredUser(protocol.DesiredUser{
		BindingID: "b1", Email: "u1@chordv", UUID: "u1", Revision: "1",
		Enabled: false, QuotaRemainingBytes: "0", OfflineAllowanceBytes: "1000",
	}); err != nil {
		t.Fatal(err)
	}
	payload := userPayload("b1", "u1@chordv")
	payload["quotaRemainingBytes"] = "5000000"
	payload["offlineAllowanceBytes"] = "2048"

	if result := run(t, processor, command("c1", protocol.CommandEnableUser, "9", payload), true); result.Status != protocol.StatusCompleted {
		t.Fatalf("result = %+v", result)
	}
	stored, _ := state.UserByBindingID("b1")
	if stored == nil || !stored.Enabled {
		t.Fatalf("stored = %+v", stored)
	}
	// Dropping the supplied quota would report success and then have the very
	// next metering tick disable the user again, because the local remainder is
	// still zero.
	if stored.QuotaRemainingBytes != "5000000" {
		t.Fatalf("quota = %s, want the replenished 5000000", stored.QuotaRemainingBytes)
	}
	if stored.OfflineAllowanceBytes != "2048" {
		t.Fatalf("allowance = %s", stored.OfflineAllowanceBytes)
	}
}

func TestChangingAUsersEmailUninstallsTheOldAccount(t *testing.T) {
	processor, fake, state := newProcessor(t, false)
	run(t, processor, command("c1", protocol.CommandEnsureUser, "2", userPayload("b1", "old@chordv")), true)
	fake.calls = nil

	renamed := userPayload("b1", "new@chordv")
	if result := run(t, processor, command("c2", protocol.CommandEnsureUser, "3", renamed), true); result.Status != protocol.StatusCompleted {
		t.Fatalf("result = %+v", result)
	}
	// The adapter addresses accounts by email and cannot infer the previous one.
	// With unknown-user removal off, an orphan would keep serving forever with
	// no desired-user record left to account for its traffic.
	if !contains(fake.calls, "remove:old@chordv") {
		t.Fatalf("the old account was left installed: %v", fake.calls)
	}
	if !contains(fake.calls, "ensure:new@chordv") {
		t.Fatalf("calls = %v", fake.calls)
	}
	// Uninstall BEFORE the record is rewritten: afterwards nothing names the old
	// account any more.
	if index(fake.calls, "remove:old@chordv") > index(fake.calls, "ensure:new@chordv") {
		t.Fatalf("the new account was installed before the old one was removed: %v", fake.calls)
	}
	stored, _ := state.UserByBindingID("b1")
	if stored == nil || stored.Email != "new@chordv" {
		t.Fatalf("stored = %+v", stored)
	}
}

func index(values []string, want string) int {
	for i, value := range values {
		if value == want {
			return i
		}
	}
	return -1
}

// TestReconcileRetiresARenamedAccountBeforeOverwritingItsRecord covers the
// rename-and-retry path.
//
// The upsert replaces the only durable record naming the old account. If the
// install that follows fails — or the process dies — a later reconcile would see
// the old account as one it has never heard of and, with unknown-user removal
// off, leave it serving forever. So the retirement happens FIRST, while the
// record still names it.
func TestReconcileRetiresARenamedAccountBeforeOverwritingItsRecord(t *testing.T) {
	processor, fake, state := newProcessor(t, false)
	if err := state.UpsertDesiredUser(protocol.DesiredUser{
		BindingID: "b1", Email: "old@chordv", UUID: "u1", Revision: "1",
		Enabled: true, QuotaRemainingBytes: "1000", OfflineAllowanceBytes: "1000",
	}); err != nil {
		t.Fatal(err)
	}
	fake.live = []xray.LiveUser{{Email: "old@chordv"}}
	// The install fails, which is exactly when the ordering matters.
	fake.ensureErr = errors.New("gRPC 断开")

	recordStillNamedOld := false
	fake.onRemove = func() {
		if stored, err := state.UserByBindingID("b1"); err == nil && stored != nil && stored.Email == "old@chordv" {
			recordStillNamedOld = true
		}
	}
	payload := map[string]any{
		"controlMode": string(protocol.ModeDirectPrimary),
		"users":       []any{map[string]any(userPayload("b1", "new@chordv"))},
	}
	if result := run(t, processor, command("c1", protocol.CommandReconcileUsers, "5", payload), true); result.Status != protocol.StatusFailed {
		t.Fatalf("a failed install was reported as success: %+v", result)
	}
	if !contains(fake.calls, "remove:old@chordv") {
		t.Fatalf("the renamed account was not retired: %v", fake.calls)
	}
	if !recordStillNamedOld {
		t.Fatal("the record was overwritten BEFORE the old account was retired")
	}

	// The retry succeeds, and must not need the (now gone) old record to do the
	// right thing.
	fake.ensureErr = nil
	fake.onRemove = nil
	if result := run(t, processor, command("c2", protocol.CommandReconcileUsers, "6", payload), true); result.Status != protocol.StatusCompleted {
		t.Fatalf("the retry failed: %+v", result)
	}
	if stored, _ := state.UserByBindingID("b1"); stored == nil || stored.Email != "new@chordv" {
		t.Fatalf("stored = %+v", stored)
	}
}

// TestPromotionInstallsUsersEvenWhenTheCallerThinksItCannotWrite covers the
// handover. A RECONCILE_USERS carrying controlMode=direct_primary IS the grant;
// deferring to the caller's stale view of the previous mode would persist the
// new mode, report completed with an advanced revision, and install nobody.
func TestPromotionInstallsUsersEvenWhenTheCallerThinksItCannotWrite(t *testing.T) {
	processor, fake, state := newProcessor(t, false)
	payload := map[string]any{
		"controlMode": string(protocol.ModeDirectPrimary),
		"users":       []any{map[string]any(userPayload("b1", "u1@chordv"))},
	}
	// writable=false: the node was observing until this very command.
	result := run(t, processor, command("c1", protocol.CommandReconcileUsers, "5", payload), false)
	if result.Status != protocol.StatusCompleted {
		t.Fatalf("result = %+v", result)
	}
	if !contains(fake.calls, "ensure:u1@chordv") {
		t.Fatalf("the handover completed without installing anyone: %v", fake.calls)
	}
	if mode, _ := state.ControlMode(); mode != protocol.ModeDirectPrimary {
		t.Fatalf("mode = %s", mode)
	}
}

func TestAFailedHandoverDoesNotAdvanceAnything(t *testing.T) {
	processor, fake, state := newProcessor(t, false)
	fake.ensureErr = errors.New("gRPC 断开")
	payload := map[string]any{
		"controlMode": string(protocol.ModeDirectPrimary),
		"users":       []any{map[string]any(userPayload("b1", "u1@chordv"))},
	}
	result := run(t, processor, command("c1", protocol.CommandReconcileUsers, "5", payload), false)
	if result.Status != protocol.StatusFailed {
		t.Fatalf("result = %+v", result)
	}
	// Neither the mode nor the revision may move: the control plane treats both
	// as evidence that the handover landed.
	if mode, _ := state.ControlMode(); mode == protocol.ModeDirectPrimary {
		t.Fatal("a failed handover still promoted the node")
	}
	if revision, _ := state.ConfigRevision(); revision != "0" {
		t.Fatalf("a failed handover advanced the applied revision to %s", revision)
	}
	// And a redelivery must retry rather than return a cached success.
	fake.ensureErr = nil
	if retry := run(t, processor, command("c1", protocol.CommandReconcileUsers, "5", payload), false); retry.Status != protocol.StatusCompleted {
		t.Fatalf("the redelivery did not retry: %+v", retry)
	}
}

// TestOwnershipSurvivesASnapshotAppliedWithoutWriteAccess covers the sequence
// that would otherwise leak an account forever:
//
//	shadow_direct → RECONCILE_USERS drops a binding → its record is erased,
//	but nothing may uninstall it → later promotion sees an account it has
//	never heard of → under the panel-shared inbound, leaves it serving.
func TestOwnershipSurvivesASnapshotAppliedWithoutWriteAccess(t *testing.T) {
	processor, fake, state := newProcessor(t, false)
	if err := state.UpsertDesiredUser(protocol.DesiredUser{
		BindingID: "b2", Email: "revoked@chordv", UUID: "u2", Revision: "1",
		Enabled: true, QuotaRemainingBytes: "1000", OfflineAllowanceBytes: "1000",
	}); err != nil {
		t.Fatal(err)
	}
	fake.live = []xray.LiveUser{{Email: "revoked@chordv"}, {Email: "someone@panel"}}

	// Observing mode: the binding is dropped, and nothing may touch Xray.
	observing := map[string]any{
		"controlMode": string(protocol.ModeShadowDirect),
		"users":       []any{map[string]any(userPayload("b1", "u1@chordv"))},
	}
	if result := run(t, processor, command("c1", protocol.CommandReconcileUsers, "5", observing), false); result.Status != protocol.StatusCompleted {
		t.Fatalf("result = %+v", result)
	}
	if len(fake.calls) != 0 {
		t.Fatalf("an observing node touched Xray: %v", fake.calls)
	}
	if stored, _ := state.UserByBindingID("b2"); stored != nil {
		t.Fatal("the snapshot did not replace the user set")
	}

	// Promotion. The erased record is gone, but the ownership note is not.
	promote := map[string]any{
		"controlMode": string(protocol.ModeDirectPrimary),
		"users":       []any{map[string]any(userPayload("b1", "u1@chordv"))},
	}
	if result := run(t, processor, command("c2", protocol.CommandReconcileUsers, "6", promote), false); result.Status != protocol.StatusCompleted {
		t.Fatalf("result = %+v", result)
	}
	if !contains(fake.calls, "remove:revoked@chordv") {
		t.Fatalf("the revoked account survived the promotion: %v", fake.calls)
	}
	if contains(fake.calls, "remove:someone@panel") {
		t.Fatalf("the panel's account was deleted: %v", fake.calls)
	}
	// The note is consumed, or the list would grow forever.
	if remaining, _ := state.PendingRemovals(); len(remaining) != 0 {
		t.Fatalf("pending removals = %v, want none after the account was retired", remaining)
	}
}

func TestAReaddedAccountClearsItsPendingRemoval(t *testing.T) {
	processor, fake, state := newProcessor(t, false)
	if err := state.UpsertDesiredUser(protocol.DesiredUser{
		BindingID: "b1", Email: "u1@chordv", UUID: "u1", Revision: "1",
		Enabled: true, QuotaRemainingBytes: "1000", OfflineAllowanceBytes: "1000",
	}); err != nil {
		t.Fatal(err)
	}
	fake.live = []xray.LiveUser{{Email: "u1@chordv"}}
	run(t, processor, command("c1", protocol.CommandReconcileUsers, "5", map[string]any{
		"controlMode": string(protocol.ModeShadowDirect), "users": []any{},
	}), false)
	if pending, _ := state.PendingRemovals(); len(pending) != 1 {
		t.Fatalf("pending = %v, want the dropped account", pending)
	}
	// Re-subscribed before the promotion: the account must be installed, not
	// retired, and the stale note must not outlive the decision.
	run(t, processor, command("c2", protocol.CommandReconcileUsers, "6", map[string]any{
		"controlMode": string(protocol.ModeDirectPrimary),
		"users":       []any{map[string]any(userPayload("b1", "u1@chordv"))},
	}), false)
	if contains(fake.calls, "remove:u1@chordv") {
		t.Fatalf("a re-added account was retired: %v", fake.calls)
	}
	if pending, _ := state.PendingRemovals(); len(pending) != 0 {
		t.Fatalf("pending = %v, want none", pending)
	}
}

// --- identity resolution ----------------------------------------------------

// TestAConflictingBindingAndEmailIsRefused: the binding id is the identity, the
// email is reassignable. An "either matches" lookup returns whichever row comes
// first, so a payload naming binding b1 with an email belonging to b2 could edit
// — or uninstall — the wrong account and report success.
func TestAConflictingBindingAndEmailIsRefused(t *testing.T) {
	processor, fake, state := newProcessor(t, false)
	for _, seeded := range []protocol.DesiredUser{
		{BindingID: "b1", Email: "alice@chordv", UUID: "u1", Revision: "1", Enabled: true, QuotaRemainingBytes: "1000", OfflineAllowanceBytes: "1000"},
		{BindingID: "b2", Email: "bob@chordv", UUID: "u2", Revision: "1", Enabled: true, QuotaRemainingBytes: "1000", OfflineAllowanceBytes: "1000"},
	} {
		if err := state.UpsertDesiredUser(seeded); err != nil {
			t.Fatal(err)
		}
	}
	conflicting := map[string]any{"bindingId": "b1", "email": "bob@chordv", "uuid": "u1", "flow": protocol.FlowVision}

	result := run(t, processor, command("c1", protocol.CommandEnsureUser, "5", conflicting), true)
	if result.Status != protocol.StatusFailed || !strings.Contains(result.Error, "b2") {
		t.Fatalf("a conflicting payload was executed: %+v", result)
	}
	result = run(t, processor, command("c2", protocol.CommandRemoveUser, "6", conflicting), true)
	if result.Status != protocol.StatusFailed {
		t.Fatalf("a conflicting terminal command was executed: %+v", result)
	}
	if len(fake.calls) != 0 {
		t.Fatalf("a conflicting payload reached Xray: %v", fake.calls)
	}
	// Neither account may have moved.
	for binding, email := range map[string]string{"b1": "alice@chordv", "b2": "bob@chordv"} {
		stored, _ := state.UserByBindingID(binding)
		if stored == nil || stored.Email != email || !stored.Enabled {
			t.Fatalf("%s = %+v", binding, stored)
		}
	}
}

func TestTheBindingIdWinsWhenTheEmailIsSimplyNew(t *testing.T) {
	processor, _, state := newProcessor(t, false)
	if err := state.UpsertDesiredUser(protocol.DesiredUser{
		BindingID: "b1", Email: "old@chordv", UUID: "u1", Revision: "1",
		Enabled: true, QuotaRemainingBytes: "1000", OfflineAllowanceBytes: "1000",
	}); err != nil {
		t.Fatal(err)
	}
	// An email nobody else owns is a rename, not a conflict.
	result := run(t, processor, command("c1", protocol.CommandEnsureUser, "5", userPayload("b1", "new@chordv")), true)
	if result.Status != protocol.StatusCompleted {
		t.Fatalf("a legitimate rename was refused: %+v", result)
	}
	if stored, _ := state.UserByBindingID("b1"); stored == nil || stored.Email != "new@chordv" {
		t.Fatalf("stored = %+v", stored)
	}
}

// TestAFailureMidReconcileLeavesOwnershipEvidenceIntact covers the window the
// pending-removal list itself could open.
//
// Clearing the notes up front means a failure while processing an EARLIER user
// leaves a re-added account with neither a pending note nor a desired-user
// record — and the next snapshot that omits it classifies it as unknown and,
// under the panel-shared inbound, leaves it serving.
func TestAFailureMidReconcileLeavesOwnershipEvidenceIntact(t *testing.T) {
	processor, fake, state := newProcessor(t, false)
	if err := state.RecordPendingRemoval([]string{"back@chordv"}); err != nil {
		t.Fatal(err)
	}
	fake.live = []xray.LiveUser{{Email: "back@chordv"}}
	// The FIRST user fails; the re-added one is never reached.
	fake.ensureErrFor = "first@chordv"

	result := run(t, processor, command("c1", protocol.CommandReconcileUsers, "5", map[string]any{
		"controlMode": string(protocol.ModeDirectPrimary),
		"users": []any{
			map[string]any(userPayload("b1", "first@chordv")),
			map[string]any(userPayload("b2", "back@chordv")),
		},
	}), true)
	if result.Status != protocol.StatusFailed {
		t.Fatalf("result = %+v", result)
	}
	// Exactly one of the two forms of evidence must survive; neither is a leak.
	stored, _ := state.UserByBindingID("b2")
	pending, _ := state.PendingRemovals()
	if stored == nil && !contains(pending, "back@chordv") {
		t.Fatal("a still-installed account was left with no ownership evidence at all")
	}
}

func TestATerminalCommandWithoutATargetIsRefused(t *testing.T) {
	processor, fake, _ := newProcessor(t, false)
	// A binding this node no longer stores, sent without an email. optionalField
	// happily returns "", and the adapter's contract says removing an account
	// that is not installed SUCCEEDS — so an empty target would report success
	// and mark the command permanently completed without touching anything.
	for _, kind := range []protocol.CommandType{protocol.CommandDisableUser, protocol.CommandRemoveUser} {
		result := run(t, processor, command("c-"+string(kind), kind, "3",
			map[string]any{"bindingId": "b-unknown"}), true)
		if result.Status != protocol.StatusFailed {
			t.Fatalf("%s with no resolvable target was reported as done: %+v", kind, result)
		}
	}
	if contains(fake.calls, "remove:") {
		t.Fatalf("the adapter was called with an empty target: %v", fake.calls)
	}
}

// TestAnotherBindingsProgressDoesNotSupersedeAFailedInstall covers the trap of
// using the global applied-revision watermark as a per-binding staleness gate.
//
// ConfigRevision advances on EVERY completed command. If A's install fails at
// revision 5 and B's succeeds at 6, retrying A would look "already superseded"
// — and be cached as a success. A stays uninstalled forever, and the control
// plane is told it landed.
func TestAnotherBindingsProgressDoesNotSupersedeAFailedInstall(t *testing.T) {
	processor, fake, state := newProcessor(t, false)
	fake.ensureErrFor = "a@chordv"
	if result := run(t, processor, command("cA", protocol.CommandEnsureUser, "5", userPayload("bA", "a@chordv")), true); result.Status != protocol.StatusFailed {
		t.Fatalf("setup: %+v", result)
	}
	// An unrelated binding moves the global watermark past A's revision.
	if result := run(t, processor, command("cB", protocol.CommandEnsureUser, "6", userPayload("bB", "b@chordv")), true); result.Status != protocol.StatusCompleted {
		t.Fatalf("setup: %+v", result)
	}
	if revision, _ := state.ConfigRevision(); revision != "6" {
		t.Fatalf("ConfigRevision = %s, want the global watermark to have moved", revision)
	}

	fake.ensureErrFor = ""
	fake.calls = nil
	// A's retry is still live work: the control plane never said anything new
	// about A.
	if result := run(t, processor, command("cA2", protocol.CommandEnsureUser, "5", userPayload("bA", "a@chordv")), true); result.Status != protocol.StatusCompleted {
		t.Fatalf("retry = %+v", result)
	}
	if !contains(fake.calls, "ensure:a@chordv") {
		t.Fatalf("the retry was skipped as superseded: %v", fake.calls)
	}
}

func TestAFullSnapshotStillSupersedesAnOlderPerUserCommand(t *testing.T) {
	processor, fake, _ := newProcessor(t, false)
	// The snapshot watermark is what a per-binding command must actually yield
	// to — dropping the global check must not drop this one with it.
	if result := run(t, processor, command("c1", protocol.CommandReconcileUsers, "10", map[string]any{
		"controlMode": string(protocol.ModeDirectPrimary), "users": []any{},
	}), true); result.Status != protocol.StatusCompleted {
		t.Fatalf("setup: %+v", result)
	}
	fake.calls = nil
	result := run(t, processor, command("c2", protocol.CommandEnsureUser, "4", userPayload("b1", "ghost@chordv")), true)
	if result.Status != protocol.StatusCompleted {
		t.Fatalf("a superseded command should be a no-op, not a failure: %+v", result)
	}
	if contains(fake.calls, "ensure:ghost@chordv") {
		t.Fatalf("a command older than the last full snapshot was applied: %v", fake.calls)
	}
}

func TestAnUnrecognisedControlModeIsRefused(t *testing.T) {
	processor, fake, state := newProcessor(t, false)
	// Get the node onto the writable track first, so the refusal below is the
	// only thing that can stop it writing.
	if result := run(t, processor, command("c0", protocol.CommandReconcileUsers, "5", map[string]any{
		"controlMode": string(protocol.ModeDirectPrimary), "users": []any{},
	}), true); result.Status != protocol.StatusCompleted {
		t.Fatalf("setup: %+v", result)
	}
	fake.calls = nil

	// A newer control plane introducing, say, an observation mode. Silently
	// keeping the stored direct_primary would read an instruction this build
	// cannot understand as permission to keep writing.
	for name, raw := range map[string]any{
		"unknown string": "observe_only",
		"wrong type":     42,
		"null":           nil,
	} {
		result := run(t, processor, command("c-"+name, protocol.CommandReconcileUsers, "6", map[string]any{
			"controlMode": raw,
			"users":       []any{map[string]any(userPayload("b1", "u1@chordv"))},
		}), true)
		if result.Status != protocol.StatusFailed {
			t.Fatalf("%s was accepted: %+v", name, result)
		}
	}
	if len(fake.calls) != 0 {
		t.Fatalf("an unrecognised mode still reached Xray: %v", fake.calls)
	}
	if mode, _ := state.ControlMode(); mode != protocol.ModeDirectPrimary {
		t.Fatalf("the refusal changed the stored mode to %s", mode)
	}
	// An ABSENT mode still means "keep whatever this node is on".
	if result := run(t, processor, command("c-absent", protocol.CommandReconcileUsers, "7", map[string]any{
		"users": []any{map[string]any(userPayload("b1", "u1@chordv"))},
	}), true); result.Status != protocol.StatusCompleted {
		t.Fatalf("an absent controlMode was refused: %+v", result)
	}
	if !contains(fake.calls, "ensure:u1@chordv") {
		t.Fatalf("calls = %v", fake.calls)
	}
}
