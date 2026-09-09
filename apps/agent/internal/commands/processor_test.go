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
	removeErr error
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
	return f.ensureErr
}
func (f *fakeXray) RemoveUser(_ context.Context, email string) error {
	f.calls = append(f.calls, "remove:"+email)
	if f.onRemove != nil {
		f.onRemove()
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
	if result.Status != protocol.StatusFailed || !strings.Contains(result.Error, "P2") {
		t.Fatalf("result = %+v", result)
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
