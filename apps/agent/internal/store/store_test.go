package store

import (
	"math/big"
	"path/filepath"
	"testing"
	"time"

	"github.com/Achordchan/ChordV/apps/agent/internal/protocol"
)

const allowance = "67108864" // 64 MiB, the agent default

func newStore(t *testing.T, nodeID, bootID string) *Store {
	t.Helper()
	return openAt(t, filepath.Join(t.TempDir(), "node-agent.db"), nodeID, bootID)
}

func openAt(t *testing.T, path, nodeID, bootID string) *Store {
	t.Helper()
	store, err := Open(path, Options{
		BootID: bootID, NodeID: nodeID,
		DefaultOfflineAllowance: big.NewInt(64 * 1024 * 1024),
	})
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { store.Close() })
	return store
}

func user(bindingID, email, revision, quota string) protocol.DesiredUser {
	return protocol.DesiredUser{
		BindingID: bindingID, Email: email, UUID: "uuid-" + bindingID,
		Revision: revision, Flow: protocol.FlowVision, Enabled: true,
		QuotaRemainingBytes: quota, OfflineAllowanceBytes: allowance,
	}
}

func seed(t *testing.T, store *Store, users ...protocol.DesiredUser) {
	t.Helper()
	for _, u := range users {
		if err := store.UpsertDesiredUser(u); err != nil {
			t.Fatalf("seed %s: %v", u.BindingID, err)
		}
	}
}

func counter(email, up, down string) protocol.AbsoluteCounter {
	return protocol.AbsoluteCounter{Email: email, UplinkBytes: up, DownlinkBytes: down}
}

func sampleAt(t *testing.T, store *Store, online bool, counters ...protocol.AbsoluteCounter) SampleResult {
	t.Helper()
	result, err := store.RecordSample(counters, time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC), online)
	if err != nil {
		t.Fatalf("record sample: %v", err)
	}
	return result
}

func storedUser(t *testing.T, store *Store, bindingID string) *userRow {
	t.Helper()
	row, err := userByBindingID(store.db, bindingID)
	if err != nil || row == nil {
		t.Fatalf("user %s: %v", bindingID, err)
	}
	return row
}

// --- metering ---------------------------------------------------------------

func TestFirstObservationOnlyEstablishesTheBaseline(t *testing.T) {
	store := newStore(t, "node-1", "boot-1")
	seed(t, store, user("b1", "u1@chordv", "1", "1000000"))

	// The counter may already hold traffic from before this agent existed —
	// after a reinstall, or from the panel's own use of the same inbound.
	// Billing it now would charge the user for history.
	result := sampleAt(t, store, true, counter("u1@chordv", "5000", "7000"))
	if result.Batch == nil {
		t.Fatal("the baseline sample produced no batch; the control plane needs the absolute reading")
	}
	sample := result.Batch.Samples[0]
	if sample.UplinkDeltaBytes != "0" || sample.DownlinkDeltaBytes != "0" {
		t.Fatalf("baseline billed %s/%s, want 0/0", sample.UplinkDeltaBytes, sample.DownlinkDeltaBytes)
	}
	// But the absolute value still travels, so the control plane can detect a
	// reset the agent did not report.
	if sample.UplinkBytes != "5000" || sample.DownlinkBytes != "7000" {
		t.Fatalf("absolute reading = %s/%s", sample.UplinkBytes, sample.DownlinkBytes)
	}
	if row := storedUser(t, store, "b1"); row.QuotaRemainingBytes != "1000000" {
		t.Fatalf("baseline consumed quota: %s", row.QuotaRemainingBytes)
	}
}

func TestSubsequentSamplesBillTheDifference(t *testing.T) {
	store := newStore(t, "node-1", "boot-1")
	seed(t, store, user("b1", "u1@chordv", "1", "1000000"))
	sampleAt(t, store, true, counter("u1@chordv", "5000", "7000"))

	result := sampleAt(t, store, true, counter("u1@chordv", "5300", "7700"))
	sample := result.Batch.Samples[0]
	if sample.UplinkDeltaBytes != "300" || sample.DownlinkDeltaBytes != "700" {
		t.Fatalf("delta = %s/%s, want 300/700", sample.UplinkDeltaBytes, sample.DownlinkDeltaBytes)
	}
	if row := storedUser(t, store, "b1"); row.QuotaRemainingBytes != "999000" {
		t.Fatalf("quota = %s, want 999000", row.QuotaRemainingBytes)
	}
	if result.Batch.Sequence != "2" {
		t.Fatalf("sequence = %s, want 2", result.Batch.Sequence)
	}
}

// TestCounterResetBillsTheWholeNewGeneration is the subtle one, and the one that
// costs real money if it is wrong.
//
// 3x-ui resets Xray's statistics periodically, and Xray starts from zero after a
// restart. The intuitive handling — treat the reset sample as a new baseline and
// wait for the next delta — loses one full interval EVERY time, which is a
// steady, invisible under-count. After a reset the current value IS the whole of
// the new generation's traffic.
func TestCounterResetBillsTheWholeNewGeneration(t *testing.T) {
	store := newStore(t, "node-1", "boot-1")
	seed(t, store, user("b1", "u1@chordv", "1", "1000000"))
	sampleAt(t, store, true, counter("u1@chordv", "5000", "7000"))
	sampleAt(t, store, true, counter("u1@chordv", "9000", "11000"))

	// Xray restarted: the counter is far below what we last saw.
	result := sampleAt(t, store, true, counter("u1@chordv", "400", "600"))
	sample := result.Batch.Samples[0]
	if sample.UplinkDeltaBytes != "400" || sample.DownlinkDeltaBytes != "600" {
		t.Fatalf("post-reset delta = %s/%s, want the full 400/600", sample.UplinkDeltaBytes, sample.DownlinkDeltaBytes)
	}
	// The generation is what lets the control plane tell "a reset happened" from
	// "the agent sent a smaller absolute value by mistake".
	if sample.CounterGeneration != "1" {
		t.Fatalf("generation = %s, want 1 after a reset", sample.CounterGeneration)
	}
	// 1000000 - 8000 (first two intervals) - 1000 (the new generation)
	if row := storedUser(t, store, "b1"); row.QuotaRemainingBytes != "991000" {
		t.Fatalf("quota = %s, want 991000", row.QuotaRemainingBytes)
	}

	// And the generation must not keep climbing while the counter behaves.
	next := sampleAt(t, store, true, counter("u1@chordv", "500", "600"))
	if next.Batch.Samples[0].CounterGeneration != "1" {
		t.Fatalf("generation moved without a reset: %s", next.Batch.Samples[0].CounterGeneration)
	}
}

func TestQuotaFloorsAtZeroAndDisablesTheUser(t *testing.T) {
	store := newStore(t, "node-1", "boot-1")
	seed(t, store, user("b1", "u1@chordv", "1", "1000"))
	sampleAt(t, store, true, counter("u1@chordv", "0", "0"))

	// Far more traffic than the quota: the remainder must clamp, never wrap
	// negative — a negative quota compared with > 0 would re-enable the user.
	result := sampleAt(t, store, true, counter("u1@chordv", "5000", "5000"))
	if len(result.DisableEmails) != 1 || result.DisableEmails[0] != "u1@chordv" {
		t.Fatalf("DisableEmails = %v", result.DisableEmails)
	}
	row := storedUser(t, store, "b1")
	if row.QuotaRemainingBytes != "0" {
		t.Fatalf("quota = %s, want 0", row.QuotaRemainingBytes)
	}
	if row.Enabled {
		t.Fatal("an exhausted user was left enabled")
	}
	// An already-disabled user is not ours to bill any further.
	after := sampleAt(t, store, true, counter("u1@chordv", "9000", "9000"))
	if after.Batch != nil {
		t.Fatalf("a disabled user still produced a batch: %+v", after.Batch)
	}
}

func TestOfflineAllowanceBoundsWhatAPartitionCanCost(t *testing.T) {
	store := newStore(t, "node-1", "boot-1")
	small := user("b1", "u1@chordv", "1", "100000000")
	small.OfflineAllowanceBytes = "1000"
	seed(t, store, small)
	sampleAt(t, store, false, counter("u1@chordv", "0", "0"))

	// Backend unreachable: usage accrues against the allowance even though the
	// quota is nowhere near exhausted.
	sampleAt(t, store, false, counter("u1@chordv", "300", "300"))
	if row := storedUser(t, store, "b1"); row.OfflineUsed != "600" || !row.Enabled {
		t.Fatalf("offline_used = %s enabled = %v", row.OfflineUsed, row.Enabled)
	}
	result := sampleAt(t, store, false, counter("u1@chordv", "800", "800"))
	if len(result.DisableEmails) != 1 {
		t.Fatalf("the offline allowance did not disable the user: %v", result.DisableEmails)
	}
	if row := storedUser(t, store, "b1"); row.Enabled {
		t.Fatal("a user past its offline allowance was left enabled")
	}
}

func TestReachingTheBackendSettlesTheOfflineDebt(t *testing.T) {
	store := newStore(t, "node-1", "boot-1")
	seed(t, store, user("b1", "u1@chordv", "1", "100000000"))
	sampleAt(t, store, false, counter("u1@chordv", "0", "0"))
	sampleAt(t, store, false, counter("u1@chordv", "500", "500"))
	if row := storedUser(t, store, "b1"); row.OfflineUsed == "0" {
		t.Fatal("offline usage was not accrued while the backend was unreachable")
	}
	// Everything metered since the last contact is on its way, so the budget
	// starts over — otherwise a long-lived agent would eventually disable every
	// user over accumulated, already-reported traffic.
	sampleAt(t, store, true, counter("u1@chordv", "700", "700"))
	if row := storedUser(t, store, "b1"); row.OfflineUsed != "0" {
		t.Fatalf("offline_used = %s after reaching the backend, want 0", row.OfflineUsed)
	}
}

func TestCountersForUnknownUsersAreIgnored(t *testing.T) {
	store := newStore(t, "node-1", "boot-1")
	seed(t, store, user("b1", "u1@chordv", "1", "1000000"))
	// The inbound is shared with the panel under B1, so counters for emails this
	// node does not own WILL show up. Billing them would invent traffic.
	result := sampleAt(t, store, true, counter("stranger@panel", "9999", "9999"))
	if result.Batch != nil {
		t.Fatalf("a foreign counter produced a batch: %+v", result.Batch)
	}
}

func TestNoMovementProducesNoBatchAndNoSequenceBurn(t *testing.T) {
	store := newStore(t, "node-1", "boot-1")
	if result := sampleAt(t, store, true); result.Batch != nil {
		t.Fatal("an empty reading produced a batch")
	}
	seed(t, store, user("b1", "u1@chordv", "1", "1000000"))
	first := sampleAt(t, store, true, counter("u1@chordv", "10", "10"))
	// Sequence numbers are the control plane's contiguity check: burning one on
	// an empty tick would leave a permanent hole that stalls accounting.
	if first.Batch.Sequence != "1" {
		t.Fatalf("first batch sequence = %s, want 1", first.Batch.Sequence)
	}
}

// --- identity ---------------------------------------------------------------

func TestADatabaseFromAnotherNodeRefusesToOpen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "node-agent.db")
	first := openAt(t, path, "node-1", "boot-1")
	seed(t, first, user("b1", "u1@chordv", "1", "1000000"))
	first.Close()

	// It holds the other node's desired users, command history and unsettled
	// usage batches: adopting it would replay that node's work under these
	// credentials.
	_, err := Open(path, Options{BootID: "boot-2", NodeID: "node-2", DefaultOfflineAllowance: big.NewInt(1)})
	var foreign *ForeignStateError
	if err == nil {
		t.Fatal("a database belonging to another node was adopted")
	}
	if !asForeign(err, &foreign) {
		t.Fatalf("err = %T %v, want *ForeignStateError", err, err)
	}
	if foreign.Recorded != "node-1" || foreign.Current != "node-2" {
		t.Fatalf("ForeignStateError = %+v", foreign)
	}
	// The operator has to be able to see WHICH node it belongs to.
	for _, needle := range []string{"node-1", "node-2", "CHORDV_AGENT_RESET_IDENTITY"} {
		if !contains(err.Error(), needle) {
			t.Fatalf("message does not mention %q: %v", needle, err)
		}
	}
}

func TestReopeningUnderTheSameIdentityKeepsState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "node-agent.db")
	first := openAt(t, path, "node-1", "boot-1")
	seed(t, first, user("b1", "u1@chordv", "1", "1000000"))
	sampleAt(t, first, true, counter("u1@chordv", "10", "10"))
	first.Close()

	// A restart is not a reset: unsettled batches and users must survive it, and
	// the new boot starts its own sequence space at 1.
	second := openAt(t, path, "node-1", "boot-2")
	pending, err := second.PendingBatchCount()
	if err != nil || pending != 1 {
		t.Fatalf("pending = %d, %v; want 1", pending, err)
	}
	users, err := second.ListDesiredUsers()
	if err != nil || len(users) != 1 {
		t.Fatalf("users = %v, %v", users, err)
	}
	result := sampleAt(t, second, true, counter("u1@chordv", "20", "20"))
	if result.Batch.BootID != "boot-2" || result.Batch.Sequence != "1" {
		t.Fatalf("new boot batch = %s/%s, want boot-2/1", result.Batch.BootID, result.Batch.Sequence)
	}
}

// --- desired users ----------------------------------------------------------

func TestAnOlderRevisionNeverUndoesANewerOne(t *testing.T) {
	store := newStore(t, "node-1", "boot-1")
	seed(t, store, user("b1", "u1@chordv", "5", "1000"))
	stale := user("b1", "u1@chordv", "3", "999999")
	stale.Enabled = false
	if err := store.UpsertDesiredUser(stale); err != nil {
		t.Fatal(err)
	}
	// Commands and snapshots race; the revision is the only ordering there is.
	row := storedUser(t, store, "b1")
	if row.QuotaRemainingBytes != "1000" || !row.Enabled || row.Revision != "5" {
		t.Fatalf("a stale revision was applied: %+v", row.DesiredUser)
	}
}

func TestReapplyingAUserKeepsItsMeteringBaseline(t *testing.T) {
	store := newStore(t, "node-1", "boot-1")
	seed(t, store, user("b1", "u1@chordv", "1", "1000000"))
	sampleAt(t, store, true, counter("u1@chordv", "5000", "7000"))

	// A config refresh re-sends every user. If the update branch reset the
	// counter columns, the next sample would re-bill the ENTIRE absolute
	// counter as if it were fresh traffic.
	seed(t, store, user("b1", "u1@chordv", "9", "1000000"))
	row := storedUser(t, store, "b1")
	if row.Uplink != "5000" || row.Downlink != "7000" || !row.CounterInitialized {
		t.Fatalf("re-applying the user reset its metering baseline: %+v", row)
	}
	result := sampleAt(t, store, true, counter("u1@chordv", "5100", "7100"))
	if result.Batch.Samples[0].UplinkDeltaBytes != "100" {
		t.Fatalf("delta after a config refresh = %s, want 100", result.Batch.Samples[0].UplinkDeltaBytes)
	}
}

func TestApplyConfigSnapshotReplacesTheSetAndGuardsRevision(t *testing.T) {
	store := newStore(t, "node-1", "boot-1")
	applied, err := store.ApplyConfigSnapshot(protocol.ConfigSnapshot{
		NodeID: "node-1", Revision: "10", ControlMode: protocol.ModeDirectPrimary,
		Users: []protocol.DesiredUser{user("b1", "u1@chordv", "10", "1000"), user("b2", "u2@chordv", "10", "2000")},
	})
	if err != nil || !applied {
		t.Fatalf("apply = %v, %v", applied, err)
	}
	// A user absent from the snapshot is gone, not merely disabled.
	if _, err := store.ApplyConfigSnapshot(protocol.ConfigSnapshot{
		NodeID: "node-1", Revision: "11", ControlMode: protocol.ModeDirectPrimary,
		Users: []protocol.DesiredUser{user("b1", "u1@chordv", "11", "1000")},
	}); err != nil {
		t.Fatal(err)
	}
	users, _ := store.ListDesiredUsers()
	if len(users) != 1 || users[0].BindingID != "b1" {
		t.Fatalf("users = %v", users)
	}
	// An older snapshot (a delayed response, a retried request) must not undo it.
	applied, err = store.ApplyConfigSnapshot(protocol.ConfigSnapshot{
		NodeID: "node-1", Revision: "9", ControlMode: protocol.ModeShadowDirect,
		Users: []protocol.DesiredUser{},
	})
	if err != nil || applied {
		t.Fatalf("an older snapshot was applied: %v, %v", applied, err)
	}
	if users, _ := store.ListDesiredUsers(); len(users) != 1 {
		t.Fatalf("an older snapshot changed the user set: %v", users)
	}
	mode, _ := store.ControlMode()
	if mode != protocol.ModeDirectPrimary {
		t.Fatalf("an older snapshot changed the control mode to %s", mode)
	}
}

func TestASnapshotForAnotherNodeIsRefused(t *testing.T) {
	store := newStore(t, "node-1", "boot-1")
	if _, err := store.ApplyConfigSnapshot(protocol.ConfigSnapshot{
		NodeID: "node-2", Revision: "1", ControlMode: protocol.ModeDirectPrimary,
	}); err == nil {
		t.Fatal("a snapshot addressed to another node was applied")
	}
}

func TestControlModeFallsBackToTheNonWritableMode(t *testing.T) {
	store := newStore(t, "node-1", "boot-1")
	// Absent.
	if mode, _ := store.ControlMode(); mode != protocol.ModeShadowDirect {
		t.Fatalf("absent control mode = %s", mode)
	}
	// Corrupt. Only direct_primary may write to Xray, so anything unrecognised
	// must land on a mode that may NOT — a corrupt row must never grant it.
	if err := store.setMeta("control_mode", "DIRECT_PRIMARY"); err != nil {
		t.Fatal(err)
	}
	if mode, _ := store.ControlMode(); mode != protocol.ModeShadowDirect {
		t.Fatalf("corrupt control mode = %s, want shadow_direct", mode)
	}
}

func TestRestoreBackendConfirmedUsersTakesTheLowerQuota(t *testing.T) {
	store := newStore(t, "node-1", "boot-1")
	seed(t, store, user("b1", "u1@chordv", "1", "500"), user("b2", "u2@chordv", "1", "5000"))

	if err := store.RestoreBackendConfirmedUsers([]protocol.DesiredUser{
		user("b1", "u1@chordv", "2", "9000"), // backend higher: keep the local 500
		user("b2", "u2@chordv", "2", "100"),  // backend lower: adopt 100
	}); err != nil {
		t.Fatal(err)
	}
	// The agent's count is authoritative for traffic it metered offline; the
	// backend's for purchases and for other nodes. The minimum can only
	// under-serve, never over-serve.
	if row := storedUser(t, store, "b1"); row.QuotaRemainingBytes != "500" {
		t.Fatalf("b1 quota = %s, want the lower local 500", row.QuotaRemainingBytes)
	}
	if row := storedUser(t, store, "b2"); row.QuotaRemainingBytes != "100" {
		t.Fatalf("b2 quota = %s, want the lower backend 100", row.QuotaRemainingBytes)
	}
	// A confirmed zero quota may not come back enabled.
	if err := store.RestoreBackendConfirmedUsers([]protocol.DesiredUser{user("b1", "u1@chordv", "3", "0")}); err != nil {
		t.Fatal(err)
	}
	if row := storedUser(t, store, "b1"); row.Enabled {
		t.Fatal("a user with no quota was re-enabled")
	}
}

// --- batches ----------------------------------------------------------------

func TestAckThroughDropsOnlyThatBootsSettledBatches(t *testing.T) {
	path := filepath.Join(t.TempDir(), "node-agent.db")
	first := openAt(t, path, "node-1", "boot-1")
	seed(t, first, user("b1", "u1@chordv", "1", "100000000"))
	for i := 1; i <= 3; i++ {
		sampleAt(t, first, true, counter("u1@chordv", itoa(i*100), itoa(i*100)))
	}
	first.Close()

	second := openAt(t, path, "node-1", "boot-2")
	sampleAt(t, second, true, counter("u1@chordv", "999", "999"))

	removed, err := second.AckThrough("boot-1", "2")
	if err != nil || removed != 2 {
		t.Fatalf("removed = %d, %v; want 2", removed, err)
	}
	pending, _ := second.PendingBatchCount()
	if pending != 2 {
		t.Fatalf("pending = %d, want boot-1#3 and boot-2#1", pending)
	}
	// Sequences are scoped to a boot; acknowledging one boot must never touch
	// another's, or a superseded boot's retry would find a hole.
	marks, err := second.PendingBatchWatermarks()
	if err != nil || len(marks) != 2 {
		t.Fatalf("watermarks = %v, %v", marks, err)
	}
	if marks[0].BootID != "boot-1" || marks[0].SequenceThrough != "3" {
		t.Fatalf("watermarks[0] = %+v", marks[0])
	}
	if marks[1].BootID != "boot-2" || marks[1].SequenceThrough != "1" {
		t.Fatalf("watermarks[1] = %+v", marks[1])
	}
}

func TestPendingBatchesRoundTripThroughStorage(t *testing.T) {
	store := newStore(t, "node-1", "boot-1")
	seed(t, store, user("b1", "u1@chordv", "1", "100000000"))
	sampleAt(t, store, true, counter("u1@chordv", "10", "20"))
	sampleAt(t, store, true, counter("u1@chordv", "30", "50"))

	batches, err := store.ListPendingBatches(0)
	if err != nil || len(batches) != 2 {
		t.Fatalf("batches = %v, %v", batches, err)
	}
	// Insertion order, because the control plane requires contiguity.
	if batches[0].Sequence != "1" || batches[1].Sequence != "2" {
		t.Fatalf("order = %s, %s", batches[0].Sequence, batches[1].Sequence)
	}
	if batches[1].Samples[0].UplinkDeltaBytes != "20" {
		t.Fatalf("stored payload lost its delta: %+v", batches[1].Samples[0])
	}
	if batches[0].SampledAt != "2026-09-09T12:00:00.000Z" {
		// The control plane validates @IsDateString and the Node agent emits
		// exactly this shape; both agents must be byte-identical here.
		t.Fatalf("sampledAt = %q", batches[0].SampledAt)
	}
}

// --- commands ---------------------------------------------------------------

func TestCompletedCommandsAreAnsweredFromStorage(t *testing.T) {
	store := newStore(t, "node-1", "boot-1")
	command := protocol.Command{
		CommandID: "cmd-1", Type: protocol.CommandRefreshQuota,
		TargetRevision: "7", Payload: map[string]any{"bindingId": "b1"},
	}
	previous, err := store.BeginCommand(command)
	if err != nil || previous != nil {
		t.Fatalf("first BeginCommand = %v, %v", previous, err)
	}
	if err := store.CompleteCommand(protocol.CommandResult{
		CommandID: "cmd-1", Status: protocol.StatusCompleted,
		Result: map[string]any{"appliedRevision": "7"},
	}); err != nil {
		t.Fatal(err)
	}
	// A redelivered command must be answered verbatim, not executed twice.
	previous, err = store.BeginCommand(command)
	if err != nil || previous == nil {
		t.Fatalf("redelivery = %v, %v; want the stored result", previous, err)
	}
	if previous.Status != protocol.StatusCompleted || previous.Result["appliedRevision"] != "7" {
		t.Fatalf("stored result = %+v", previous)
	}
}

func TestFailedCommandsAreAllowedToSucceedLater(t *testing.T) {
	store := newStore(t, "node-1", "boot-1")
	command := protocol.Command{
		CommandID: "cmd-1", Type: protocol.CommandEnsureUser,
		TargetRevision: "7", Payload: map[string]any{"bindingId": "b1"},
	}
	store.BeginCommand(command)
	if err := store.CompleteCommand(protocol.CommandResult{
		CommandID: "cmd-1", Status: protocol.StatusFailed, Error: "Xray 尚未就绪",
	}); err != nil {
		t.Fatal(err)
	}
	// Failures here are usually transient — Xray still starting, a dropped
	// connection. Answering a redelivery with the old failure would make the
	// node permanently unable to apply that command.
	previous, err := store.BeginCommand(command)
	if err != nil || previous != nil {
		t.Fatalf("a failed command was replayed as final: %v, %v", previous, err)
	}
}

// --- health -----------------------------------------------------------------

func TestHealthSnapshotReportsQueueState(t *testing.T) {
	store := newStore(t, "node-1", "boot-1")
	seed(t, store, user("b1", "u1@chordv", "1", "100000000"))
	sampleAt(t, store, true, counter("u1@chordv", "10", "10"))

	snapshot, err := store.HealthSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	if snapshot["journalMode"] != "wal" {
		t.Fatalf("journalMode = %v, want wal", snapshot["journalMode"])
	}
	if snapshot["bootId"] != "boot-1" || snapshot["pendingBatches"] != 1 || snapshot["desiredUsers"] != 1 {
		t.Fatalf("snapshot = %v", snapshot)
	}
}

func TestReadOnlyOpenRefusesAnAbsentDatabase(t *testing.T) {
	// The probe may run as root; creating anything here would leave root-owned
	// files the unprivileged service cannot use.
	_, err := Open(filepath.Join(t.TempDir(), "absent.db"), Options{
		BootID: "probe", NodeID: "node-1", DefaultOfflineAllowance: big.NewInt(1), ReadOnly: true,
	})
	if err == nil {
		t.Fatal("the read-only probe opened a database that does not exist")
	}
}

// --- helpers ----------------------------------------------------------------

func asForeign(err error, target **ForeignStateError) bool {
	value, ok := err.(*ForeignStateError)
	if ok {
		*target = value
	}
	return ok
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (func() bool {
		for i := 0; i+len(needle) <= len(haystack); i++ {
			if haystack[i:i+len(needle)] == needle {
				return true
			}
		}
		return false
	})()
}

func itoa(value int) string { return big.NewInt(int64(value)).String() }

// --- idle suppression -------------------------------------------------------

// TestIdleUsersProduceNoBatch is the reviewer's case: the previous no-movement
// test only fed an EMPTY reading, which says nothing about the common one —
// enabled users sitting idle while Xray keeps returning their unchanged
// counters. The Node agent emitted a batch for every such tick: 17,280 a day at
// a five-second interval, each an fsync under synchronous=FULL, all deltas zero.
func TestIdleUsersProduceNoBatch(t *testing.T) {
	store := newStore(t, "node-1", "boot-1")
	seed(t, store, user("b1", "u1@chordv", "1", "1000000"))
	if first := sampleAt(t, store, true, counter("u1@chordv", "5000", "7000")); first.Batch == nil {
		t.Fatal("the user's first reading must be emitted — it is their baseline")
	}
	for tick := 0; tick < 5; tick++ {
		if result := sampleAt(t, store, true, counter("u1@chordv", "5000", "7000")); result.Batch != nil {
			t.Fatalf("tick %d emitted a batch for an idle user: %+v", tick, result.Batch)
		}
	}
	// Sequence numbers are skipped, never burned: the control plane's contiguity
	// check would stall permanently on a hole.
	moved := sampleAt(t, store, true, counter("u1@chordv", "5001", "7000"))
	if moved.Batch == nil || moved.Batch.Sequence != "2" {
		t.Fatalf("after five idle ticks the next batch = %+v, want sequence 2", moved.Batch)
	}
}

func TestIdleUsersStillHaveTheirBookkeepingRun(t *testing.T) {
	store := newStore(t, "node-1", "boot-1")
	seed(t, store, user("b1", "u1@chordv", "1", "100000000"))
	sampleAt(t, store, false, counter("u1@chordv", "0", "0"))
	sampleAt(t, store, false, counter("u1@chordv", "500", "500"))
	if row := storedUser(t, store, "b1"); row.OfflineUsed != "1000" {
		t.Fatalf("offline_used = %s, want 1000", row.OfflineUsed)
	}
	// Suppressing the SAMPLE must not suppress the row update. Settling the
	// offline debt is a state change with no delta behind it, and skipping it
	// would leave an idle user with a permanently shortened allowance the next
	// time the backend goes away.
	if result := sampleAt(t, store, true, counter("u1@chordv", "500", "500")); result.Batch != nil {
		t.Fatalf("an idle tick emitted a batch: %+v", result.Batch)
	}
	if row := storedUser(t, store, "b1"); row.OfflineUsed != "0" {
		t.Fatalf("offline_used = %s after reaching the backend on an idle tick, want 0", row.OfflineUsed)
	}
}

func TestAResetIsEmittedEvenWithNoTrafficBehindIt(t *testing.T) {
	store := newStore(t, "node-1", "boot-1")
	seed(t, store, user("b1", "u1@chordv", "1", "1000000"))
	sampleAt(t, store, true, counter("u1@chordv", "5000", "7000"))

	// Counters reset to exactly zero: the delta is zero, but the generation bump
	// is what explains the discontinuity in every later sample. Suppressing it
	// would leave the control plane to discover a changed generation with no
	// record of when it changed.
	result := sampleAt(t, store, true, counter("u1@chordv", "0", "0"))
	if result.Batch == nil {
		t.Fatal("a counter reset with no traffic behind it was suppressed")
	}
	sample := result.Batch.Samples[0]
	if sample.CounterGeneration != "1" || sample.UplinkDeltaBytes != "0" {
		t.Fatalf("sample = %+v", sample)
	}
}

func TestANewUsersBaselineIsEmittedOnALaterTick(t *testing.T) {
	store := newStore(t, "node-1", "boot-1")
	seed(t, store, user("b1", "u1@chordv", "1", "1000000"))
	sampleAt(t, store, true, counter("u1@chordv", "5000", "7000"))

	// A user added mid-boot has an uninitialised counter, so their first reading
	// is a baseline and must go out — a boot-level "baseline already emitted"
	// flag would have swallowed it.
	seed(t, store, user("b2", "u2@chordv", "2", "1000000"))
	result := sampleAt(t, store, true,
		counter("u1@chordv", "5000", "7000"), counter("u2@chordv", "40", "60"))
	if result.Batch == nil || len(result.Batch.Samples) != 1 {
		t.Fatalf("batch = %+v, want exactly the new user's baseline", result.Batch)
	}
	if result.Batch.Samples[0].BindingID != "b2" || result.Batch.Samples[0].UplinkDeltaBytes != "0" {
		t.Fatalf("sample = %+v", result.Batch.Samples[0])
	}
}

// --- path handling ----------------------------------------------------------

// TestDatabasePathWithURIMetacharacters covers a data directory whose name
// contains characters that mean something in a URI. The path passes the
// ownership and sidecar checks, and then a concatenated `file:` URI would open a
// DIFFERENT file — or none — than the one that was checked.
func TestDatabasePathWithURIMetacharacters(t *testing.T) {
	for _, name := range []string{"agent#1", "agent?x", "agent%2e", "agent 1"} {
		path := filepath.Join(t.TempDir(), name, "node-agent.db")
		store, err := Open(path, Options{
			BootID: "boot-1", NodeID: "node-1", DefaultOfflineAllowance: big.NewInt(1024),
		})
		if err != nil {
			t.Fatalf("%s: writable open failed: %v", name, err)
		}
		seed(t, store, user("b1", "u1@chordv", "1", "1000000"))

		// The service is running, so the WAL sidecars exist and the probe may open.
		probe, err := Open(path, Options{
			BootID: "probe", NodeID: "node-1", DefaultOfflineAllowance: big.NewInt(1024), ReadOnly: true,
		})
		if err != nil {
			store.Close()
			t.Fatalf("%s: health probe failed on a path it had already checked: %v", name, err)
		}
		snapshot, err := probe.HealthSnapshot()
		if err != nil {
			probe.Close()
			store.Close()
			t.Fatalf("%s: %v", name, err)
		}
		// Proof it opened the SAME database, not an empty one silently created
		// at a truncated path.
		if snapshot["desiredUsers"] != 1 || snapshot["bootId"] != "boot-1" {
			probe.Close()
			store.Close()
			t.Fatalf("%s: probe read a different database: %v", name, snapshot)
		}
		probe.Close()
		store.Close()
	}
}

// TestRelativeDatabasePathOpens covers the shape the shipped .env uses:
// AGENT_DATABASE_PATH=./data/node-agent.db. A relative path has no valid `file:`
// URI — url.URL renders `data/node-agent.db` as `file://data/node-agent.db`,
// where SQLite reads `data` as an AUTHORITY rather than a directory and refuses
// to open. Every other path test here uses t.TempDir, which is absolute, so none
// of them can see it.
func TestRelativeDatabasePathOpens(t *testing.T) {
	t.Chdir(t.TempDir())

	store, err := Open("data/node-agent.db", Options{
		BootID: "boot-1", NodeID: "node-1", DefaultOfflineAllowance: big.NewInt(1024),
	})
	if err != nil {
		t.Fatalf("a relative database path could not be opened: %v", err)
	}
	seed(t, store, user("b1", "u1@chordv", "1", "1000000"))
	if result := sampleAt(t, store, true, counter("u1@chordv", "10", "20")); result.Batch == nil {
		t.Fatal("the store opened but does not work")
	}

	// The probe resolves the same way, so it inspects the file the service uses.
	probe, err := Open("./data/node-agent.db", Options{
		BootID: "probe", NodeID: "node-1", DefaultOfflineAllowance: big.NewInt(1024), ReadOnly: true,
	})
	if err != nil {
		store.Close()
		t.Fatalf("the read-only probe rejected a relative path: %v", err)
	}
	snapshot, err := probe.HealthSnapshot()
	probe.Close()
	store.Close()
	if err != nil {
		t.Fatal(err)
	}
	if snapshot["desiredUsers"] != 1 || snapshot["bootId"] != "boot-1" {
		t.Fatalf("the probe read a different database: %v", snapshot)
	}
}

func TestAnOlderDatabaseGetsASafeSnapshotWatermark(t *testing.T) {
	// A database written before the watermark existed reads as 0, which would let
	// a long-delayed per-binding command pass the staleness gate and recreate a
	// binding a full snapshot has since removed. config_revision is at least as
	// high as any snapshot that database applied, so adopting it errs toward
	// REFUSING work — a wrongly-skipped install is repaired by the next reconcile,
	// a resurrected revoked account is not.
	path := filepath.Join(t.TempDir(), "node-agent.db")
	first := openAt(t, path, "node-1", "boot-1")
	if err := first.AdvanceConfigRevision("10"); err != nil {
		t.Fatal(err)
	}
	// The pre-change shape: an applied revision on record, no watermark.
	if _, err := first.db.Exec(`DELETE FROM meta_v2 WHERE key = 'snapshot_revision'`); err != nil {
		t.Fatal(err)
	}
	first.Close()

	second := openAt(t, path, "node-1", "boot-2")
	watermark, err := second.SnapshotRevision()
	if err != nil || watermark != "10" {
		t.Fatalf("SnapshotRevision = %s, %v; want the conservative 10", watermark, err)
	}
}

func TestABrandNewDatabaseStartsWithNoSnapshotWatermark(t *testing.T) {
	// The backfill must not invent history: a fresh node has applied nothing, and
	// starting it at anything but zero would reject the first real instructions.
	store := newStore(t, "node-1", "boot-1")
	watermark, err := store.SnapshotRevision()
	if err != nil || watermark != "0" {
		t.Fatalf("SnapshotRevision = %s, %v; want 0", watermark, err)
	}
}

func TestBindingTombstonesOnlyMoveForward(t *testing.T) {
	store := newStore(t, "node-1", "boot-1")
	if err := store.RecordBindingTombstone("b1", "6"); err != nil {
		t.Fatal(err)
	}
	// Commands can arrive out of order; an older deletion must not lower the bar
	// that a stale install has to clear.
	if err := store.RecordBindingTombstone("b1", "3"); err != nil {
		t.Fatal(err)
	}
	if value, _ := store.BindingTombstone("b1"); value != "6" {
		t.Fatalf("tombstone = %s, want 6", value)
	}
	if err := store.RecordBindingTombstone("b1", "9"); err != nil {
		t.Fatal(err)
	}
	if value, _ := store.BindingTombstone("b1"); value != "9" {
		t.Fatalf("tombstone = %s, want 9", value)
	}
	if err := store.ClearBindingTombstone("b1"); err != nil {
		t.Fatal(err)
	}
	if value, _ := store.BindingTombstone("b1"); value != "0" {
		t.Fatalf("tombstone = %s after clearing, want 0", value)
	}
}

func TestTombstoneComparisonIsExactBeyondInt64(t *testing.T) {
	store := newStore(t, "node-1", "boot-1")
	// Both of these saturate to the same value under SQLite's CAST … AS INTEGER,
	// so a SQL-side comparison could not tell them apart — and the later deletion
	// would fail to raise the floor, leaving an enable between the two revisions
	// free to pass the staleness guard.
	low := "9223372036854775808"  // int64 max + 1
	high := "9223372036854775809" // int64 max + 2
	if err := store.RecordBindingTombstone("b1", low); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordBindingTombstone("b1", high); err != nil {
		t.Fatal(err)
	}
	if value, _ := store.BindingTombstone("b1"); value != high {
		t.Fatalf("tombstone = %s, want %s", value, high)
	}
	// And the reverse direction must still be refused.
	if err := store.RecordBindingTombstone("b1", low); err != nil {
		t.Fatal(err)
	}
	if value, _ := store.BindingTombstone("b1"); value != high {
		t.Fatalf("an older deletion lowered the floor to %s", value)
	}
}

func TestAFreshDatabasePersistsItsZeroWatermark(t *testing.T) {
	// Reading as zero is not enough: the key must EXIST, or the next open — after
	// individual commands have moved config_revision but before any snapshot has
	// arrived — mistakes this database for an old one and backfills the watermark
	// from that per-command progress.
	path := filepath.Join(t.TempDir(), "node-agent.db")
	first := openAt(t, path, "node-1", "boot-1")
	if err := first.AdvanceConfigRevision("6"); err != nil {
		t.Fatal(err)
	}
	first.Close()

	second := openAt(t, path, "node-1", "boot-2")
	watermark, err := second.SnapshotRevision()
	if err != nil || watermark != "0" {
		t.Fatalf("SnapshotRevision = %s, %v; want 0 — no snapshot has ever been applied", watermark, err)
	}
}

// TestApplyTerminalRollsTheTombstoneBackWithTheRow is the reason the tombstone
// and the row change share a transaction.
//
// The tombstone is what makes a re-delivered terminal command idempotent: once
// it stands at the command's revision, the processor's staleness guard treats
// the command as already applied and returns completed. So a tombstone that
// survives a failed row change is worse than no tombstone at all — the retry
// reports success, the enabled row is still there, and the next reconcile
// reinstalls the account.
//
// A trigger stands in for the crash: it aborts the DELETE after the tombstone
// statement has already run inside the same transaction.
func TestApplyTerminalRollsTheTombstoneBackWithTheRow(t *testing.T) {
	state := newStore(t, "node-1", "boot-1")
	if err := state.UpsertDesiredUser(protocol.DesiredUser{
		BindingID: "b1", Email: "u1@chordv", UUID: "u", Revision: "5", Enabled: true,
		QuotaRemainingBytes: "100", OfflineAllowanceBytes: allowance,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := state.db.Exec(`CREATE TRIGGER boom BEFORE DELETE ON desired_users_v2
		BEGIN SELECT RAISE(ABORT, 'boom'); END`); err != nil {
		t.Fatal(err)
	}

	if err := state.ApplyTerminal("b1", "6", true); err == nil {
		t.Fatal("ApplyTerminal 在行写入失败时仍然返回了成功")
	}

	tombstone, err := state.BindingTombstone("b1")
	if err != nil {
		t.Fatal(err)
	}
	if tombstone != "0" {
		t.Fatalf("行没删成功，墓碑却留下了 %s —— 重投会误报完成", tombstone)
	}

	// And once the obstacle is gone the retry completes the whole transition.
	if _, err := state.db.Exec(`DROP TRIGGER boom`); err != nil {
		t.Fatal(err)
	}
	if err := state.ApplyTerminal("b1", "6", true); err != nil {
		t.Fatal(err)
	}
	if tombstone, _ = state.BindingTombstone("b1"); tombstone != "6" {
		t.Fatalf("重试后墓碑 = %s", tombstone)
	}
	users, err := state.ListDesiredUsers()
	if err != nil {
		t.Fatal(err)
	}
	for _, user := range users {
		if user.BindingID == "b1" {
			t.Fatal("重试后记录仍在")
		}
	}
}

// TestARenameStartsANewMeteringGeneration covers the case the reset detector
// cannot see.
//
// Xray addresses accounts by email, so renaming a binding hands it a different
// account whose counter starts at zero. The detector only fires when a reading
// goes DOWN — so if the new account moves MORE bytes than the old baseline
// before the first sample, nothing looks wrong and only the difference gets
// billed. Here the old baseline is 100 and the new account's first reading is
// 150: the whole 150 must be billed, not 50.
func TestARenameStartsANewMeteringGeneration(t *testing.T) {
	state := newStore(t, "node-1", "boot-1")
	seed(t, state, protocol.DesiredUser{
		BindingID: "b1", Email: "old@chordv", UUID: "u", Revision: "1", Enabled: true,
		QuotaRemainingBytes: "1000000", OfflineAllowanceBytes: allowance,
	})
	// Establish the baseline, then bill 100 bytes against it.
	sampleAt(t, state, true, counter("old@chordv", "0", "0"))
	sampleAt(t, state, true, counter("old@chordv", "100", "0"))

	before := storedUser(t, state, "b1")
	if err := state.UpsertDesiredUser(protocol.DesiredUser{
		BindingID: "b1", Email: "new@chordv", UUID: "u", Revision: "2", Enabled: true,
		QuotaRemainingBytes: "1000000", OfflineAllowanceBytes: allowance,
	}); err != nil {
		t.Fatal(err)
	}
	after := storedUser(t, state, "b1")
	if after.Uplink != "0" || after.Downlink != "0" {
		t.Fatalf("改名后基线没有归零：%s/%s", after.Uplink, after.Downlink)
	}
	if after.Generation == before.Generation {
		t.Fatalf("改名后 generation 没有推进：%s", after.Generation)
	}
	if !after.CounterInitialized {
		t.Fatal("改名后应保持已初始化，否则第一份样本只建基线、白丢一段流量")
	}

	result := sampleAt(t, state, true, counter("new@chordv", "150", "0"))
	if result.Batch == nil || len(result.Batch.Samples) != 1 {
		t.Fatalf("batch = %+v", result.Batch)
	}
	if got := result.Batch.Samples[0].UplinkDeltaBytes; got != "150" {
		t.Fatalf("改名后第一次采样计费 %s，应为 150（旧基线 100 被当成了新账号的已计费量）", got)
	}
}

// TestAnOmissionFloorCannotOutliveItsDeletion is why the floor is written inside
// replaceDesiredUsersTx rather than by the caller beforehand.
//
// A tombstone that lands while the deletion does not is WORSE than no tombstone:
// the enabled row survives next to a floor that now makes every later
// instruction about the binding look superseded, so a merge preserves the stale
// enabled row and the revoked account goes back in.
func TestAnOmissionFloorCannotOutliveItsDeletion(t *testing.T) {
	state := newStore(t, "node-1", "boot-1")
	seed(t, state, protocol.DesiredUser{
		BindingID: "b1", Email: "u1@chordv", UUID: "u", Revision: "1", Enabled: true,
		QuotaRemainingBytes: "100", OfflineAllowanceBytes: allowance,
	})
	if _, err := state.db.Exec(`CREATE TRIGGER boom BEFORE DELETE ON desired_users_v2
		BEGIN SELECT RAISE(ABORT, 'boom'); END`); err != nil {
		t.Fatal(err)
	}

	if _, err := state.ApplyConfigSnapshot(protocol.ConfigSnapshot{
		NodeID: "node-1", Revision: "7", ControlMode: protocol.ModeDirectPrimary,
	}); err == nil {
		t.Fatal("删除失败时快照仍然被当成应用成功")
	}
	if floor, _ := state.BindingTombstone("b1"); floor != "0" {
		t.Fatalf("行没删成功，吊销下限却留下了 %s", floor)
	}

	if _, err := state.db.Exec(`DROP TRIGGER boom`); err != nil {
		t.Fatal(err)
	}
	if _, err := state.ApplyConfigSnapshot(protocol.ConfigSnapshot{
		NodeID: "node-1", Revision: "7", ControlMode: protocol.ModeDirectPrimary,
	}); err != nil {
		t.Fatal(err)
	}
	if floor, _ := state.BindingTombstone("b1"); floor != "7" {
		t.Fatalf("快照遗漏没有留下吊销下限：%s", floor)
	}
	users, err := state.ListDesiredUsers()
	if err != nil {
		t.Fatal(err)
	}
	if len(users) != 0 {
		t.Fatalf("被遗漏的记录还在：%+v", users)
	}
}

// TestAnUpgradeDoesNotClaimDesiredRowsOnItsOwn is the boundary of the migration.
//
// A direct-source binding proves the control plane WANTS this node to serve that
// address. It does not prove that the account living there was installed by this
// agent: the row survives a disable, and it survives an install that was refused
// or that failed. Adopting rows would walk straight past the collision
// protection that is on by default, and a later omission would delete a panel
// account that had taken the address.
//
// Recovery comes from the command log instead — see the replay tests.
func TestAnUpgradeDoesNotClaimDesiredRowsOnItsOwn(t *testing.T) {
	for _, mode := range []protocol.ControlMode{protocol.ModeDirectPrimary, protocol.ModeShadowDirect} {
		t.Run(string(mode), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "node-agent.db")
			state := openAt(t, path, "node-1", "boot-1")
			if _, err := state.ApplyConfigSnapshot(protocol.ConfigSnapshot{
				NodeID: "node-1", Revision: "5", ControlMode: mode,
				Users: []protocol.DesiredUser{{
					BindingID: "b1", Email: "u1@chordv", UUID: "u", Revision: "5",
					Enabled: true, QuotaRemainingBytes: "100", OfflineAllowanceBytes: allowance,
				}},
			}); err != nil {
				t.Fatal(err)
			}
			// Simulate the pre-migration state: the rows exist, the evidence
			// table does not yet.
			if _, err := state.db.Exec(`DELETE FROM provisioned_accounts_v2`); err != nil {
				t.Fatal(err)
			}
			if _, err := state.db.Exec(`DELETE FROM meta_v2 WHERE key = 'provisioned_backfilled'`); err != nil {
				t.Fatal(err)
			}
			state.Close()

			reopened := openAt(t, path, "node-1", "boot-2")
			got, err := reopened.ProvisionedAccounts()
			if err != nil {
				t.Fatal(err)
			}
			if len(got) != 0 {
				t.Fatalf("升级仅凭 desired 记录就认领了账号：%v", got)
			}
		})
	}
}

// TestAnUpgradeRecoversOwnershipFromTheCommandLog covers the node the current
// mode cannot describe: it provisioned accounts in direct_primary and has since
// been moved to an observing mode.
//
// Reading only the desired set there claims nothing (correctly — those rows may
// be the panel's) and, if the migration were then marked done, the node would be
// frozen in permanent unownership. The command log is never pruned, and a
// COMPLETED ENSURE_USER is a record of what this agent actually installed.
func TestAnUpgradeRecoversOwnershipFromTheCommandLog(t *testing.T) {
	path := filepath.Join(t.TempDir(), "node-agent.db")
	state := openAt(t, path, "node-1", "boot-1")

	cmd := protocol.Command{
		CommandID: "c1", Type: protocol.CommandEnsureUser, TargetRevision: "5",
		Payload: map[string]any{"bindingId": "b1", "email": "ours@chordv", "uuid": "u"},
	}
	if _, err := state.BeginCommand(cmd); err != nil {
		t.Fatal(err)
	}
	if err := state.CompleteCommand(protocol.CommandResult{
		CommandID: "c1", Status: protocol.StatusCompleted,
	}); err != nil {
		t.Fatal(err)
	}
	// The node has since been moved to an observing mode, and holds a record for
	// a PANEL binding it merely observed.
	if _, err := state.ApplyConfigSnapshot(protocol.ConfigSnapshot{
		NodeID: "node-1", Revision: "6", ControlMode: protocol.ModeShadowDirect,
		Users: []protocol.DesiredUser{{
			BindingID: "bp", Email: "panel@panel", UUID: "u", Revision: "6",
			Enabled: true, QuotaRemainingBytes: "1", OfflineAllowanceBytes: allowance,
		}},
	}); err != nil {
		t.Fatal(err)
	}
	// Pre-migration state.
	if _, err := state.db.Exec(`DELETE FROM provisioned_accounts_v2`); err != nil {
		t.Fatal(err)
	}
	if _, err := state.db.Exec(`DELETE FROM meta_v2 WHERE key = 'provisioned_backfilled'`); err != nil {
		t.Fatal(err)
	}
	state.Close()

	reopened := openAt(t, path, "node-1", "boot-2")
	got, err := reopened.ProvisionedAccounts()
	if err != nil {
		t.Fatal(err)
	}
	if _, held := got["ours@chordv"]; !held || len(got) != 1 {
		t.Fatalf("升级后的供给凭据 = %v，want 仅 [ours@chordv]（面板账号不得被认领）", got)
	}
}

// TestAnAmbiguousUpgradeIsNotMarkedDone is the other half: when there is nothing
// to go on, the migration must stay open so a later promotion can finish it,
// rather than freezing the node into permanent unownership.
func TestAnAmbiguousUpgradeIsNotMarkedDone(t *testing.T) {
	path := filepath.Join(t.TempDir(), "node-agent.db")
	state := openAt(t, path, "node-1", "boot-1")
	if _, err := state.ApplyConfigSnapshot(protocol.ConfigSnapshot{
		NodeID: "node-1", Revision: "6", ControlMode: protocol.ModeShadowDirect,
		Users: []protocol.DesiredUser{{
			BindingID: "bp", Email: "panel@panel", UUID: "u", Revision: "6",
			Enabled: true, QuotaRemainingBytes: "1", OfflineAllowanceBytes: allowance,
		}},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := state.db.Exec(`DELETE FROM meta_v2 WHERE key = 'provisioned_backfilled'`); err != nil {
		t.Fatal(err)
	}
	state.Close()

	reopened := openAt(t, path, "node-1", "boot-2")
	done, err := reopened.meta("provisioned_backfilled")
	if err != nil {
		t.Fatal(err)
	}
	if done != "" {
		t.Fatal("含糊不清的升级被标记成已完成，节点就此永久失去所有权恢复的机会")
	}
	if got, _ := reopened.ProvisionedAccounts(); len(got) != 0 {
		t.Fatalf("观察态的记录被认领了：%v", got)
	}
}

// TestTheUpgradeReplayHonorsReleases is why the command log is REPLAYED rather
// than harvested.
//
// An old install proves historical ownership, not current. Here ChordV installed
// an address, removed it, and a panel administrator later reused it. Adopting
// every historical install would hand the panel's live account to ChordV, and
// the next direct reconcile would delete it — the exact accident the
// provisioning table exists to prevent, reintroduced through the migration.
func TestTheUpgradeReplayHonorsReleases(t *testing.T) {
	path := filepath.Join(t.TempDir(), "node-agent.db")
	state := openAt(t, path, "node-1", "boot-1")

	finish := func(id string, kind protocol.CommandType, revision string, payload map[string]any) {
		t.Helper()
		if _, err := state.BeginCommand(protocol.Command{
			CommandID: id, Type: kind, TargetRevision: revision, Payload: payload,
		}); err != nil {
			t.Fatal(err)
		}
		if err := state.CompleteCommand(protocol.CommandResult{
			CommandID: id, Status: protocol.StatusCompleted,
		}); err != nil {
			t.Fatal(err)
		}
		// completed_at has millisecond resolution; rowid breaks the ties, but
		// keep the ordering unambiguous for the assertion's sake.
		time.Sleep(2 * time.Millisecond)
	}

	finish("c1", protocol.CommandEnsureUser, "1", map[string]any{"bindingId": "b1", "email": "recycled@chordv", "uuid": "u"})
	finish("c2", protocol.CommandEnsureUser, "2", map[string]any{"bindingId": "b2", "email": "kept@chordv", "uuid": "u"})
	finish("c3", protocol.CommandRemoveUser, "3", map[string]any{"bindingId": "b1", "email": "recycled@chordv"})
	// A rename: b2 moves, so its old address is released.
	finish("c4", protocol.CommandEnsureUser, "4", map[string]any{"bindingId": "b2", "email": "moved@chordv", "uuid": "u"})

	if _, err := state.db.Exec(`DELETE FROM provisioned_accounts_v2`); err != nil {
		t.Fatal(err)
	}
	if _, err := state.db.Exec(`DELETE FROM meta_v2 WHERE key = 'provisioned_backfilled'`); err != nil {
		t.Fatal(err)
	}
	state.Close()

	reopened := openAt(t, path, "node-1", "boot-2")
	got, err := reopened.ProvisionedAccounts()
	if err != nil {
		t.Fatal(err)
	}
	if _, held := got["moved@chordv"]; !held || len(got) != 1 {
		t.Fatalf("升级后的供给凭据 = %v，want 仅 [moved@chordv]："+
			"recycled@chordv 已被移除（面板可能已重用该地址），kept@chordv 已被改名释放", got)
	}
}

// TestTheUpgradeReplayIncludesEnableCommands is the sibling ENABLE_USER of the
// replay test.
//
// The processor runs ENABLE_USER through the very same install/rename path as
// ENSURE_USER. Leaving it out of the replay made an ensure-then-enable rename
// recover the OLD address: the revoked new one would be left serving, and a
// panel account that reused the old one could be deleted.
func TestTheUpgradeReplayIncludesEnableCommands(t *testing.T) {
	path := filepath.Join(t.TempDir(), "node-agent.db")
	state := openAt(t, path, "node-1", "boot-1")

	finish := func(id string, kind protocol.CommandType, revision string, payload map[string]any) {
		t.Helper()
		if _, err := state.BeginCommand(protocol.Command{
			CommandID: id, Type: kind, TargetRevision: revision, Payload: payload,
		}); err != nil {
			t.Fatal(err)
		}
		if err := state.CompleteCommand(protocol.CommandResult{
			CommandID: id, Status: protocol.StatusCompleted,
		}); err != nil {
			t.Fatal(err)
		}
		time.Sleep(2 * time.Millisecond)
	}

	finish("c1", protocol.CommandEnsureUser, "1", map[string]any{"bindingId": "b1", "email": "before@chordv", "uuid": "u"})
	finish("c2", protocol.CommandEnableUser, "2", map[string]any{"bindingId": "b1", "email": "after@chordv", "uuid": "u"})

	if _, err := state.db.Exec(`DELETE FROM provisioned_accounts_v2`); err != nil {
		t.Fatal(err)
	}
	if _, err := state.db.Exec(`DELETE FROM meta_v2 WHERE key = 'provisioned_backfilled'`); err != nil {
		t.Fatal(err)
	}
	state.Close()

	reopened := openAt(t, path, "node-1", "boot-2")
	got, err := reopened.ProvisionedAccounts()
	if err != nil {
		t.Fatal(err)
	}
	if _, held := got["after@chordv"]; !held || len(got) != 1 {
		t.Fatalf("升级后的供给凭据 = %v，want 仅 [after@chordv]：ENABLE_USER 改名释放了 before@chordv", got)
	}
}

// TestTheUpgradeReplayIgnoresSupersededCommands is why the replay is ordered by
// REVISION rather than by completion.
//
// "completed" does not mean "changed something": a command the staleness guards
// skipped reports completed too, because from the control plane's side it is
// settled. In completion order a delayed install at revision 5 — which arrived
// after the removal at 6 and did nothing — re-claims an address it never
// reinstalled. If the panel has since reused it, the next direct reconcile
// deletes the panel's account.
func TestTheUpgradeReplayIgnoresSupersededCommands(t *testing.T) {
	path := filepath.Join(t.TempDir(), "node-agent.db")
	state := openAt(t, path, "node-1", "boot-1")

	finish := func(id string, kind protocol.CommandType, revision string, payload map[string]any) {
		t.Helper()
		if _, err := state.BeginCommand(protocol.Command{
			CommandID: id, Type: kind, TargetRevision: revision, Payload: payload,
		}); err != nil {
			t.Fatal(err)
		}
		if err := state.CompleteCommand(protocol.CommandResult{
			CommandID: id, Status: protocol.StatusCompleted,
		}); err != nil {
			t.Fatal(err)
		}
		time.Sleep(2 * time.Millisecond)
	}

	finish("c1", protocol.CommandEnsureUser, "5", map[string]any{"bindingId": "b1", "email": "recycled@chordv", "uuid": "u"})
	finish("c2", protocol.CommandRemoveUser, "6", map[string]any{"bindingId": "b1", "email": "recycled@chordv"})
	// Delivered late, superseded on arrival, and recorded as completed.
	finish("c3", protocol.CommandEnsureUser, "5", map[string]any{"bindingId": "b1", "email": "recycled@chordv", "uuid": "u"})

	if _, err := state.db.Exec(`DELETE FROM provisioned_accounts_v2`); err != nil {
		t.Fatal(err)
	}
	if _, err := state.db.Exec(`DELETE FROM meta_v2 WHERE key = 'provisioned_backfilled'`); err != nil {
		t.Fatal(err)
	}
	state.Close()

	reopened := openAt(t, path, "node-1", "boot-2")
	got, err := reopened.ProvisionedAccounts()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("升级后的供给凭据 = %v，want 空：revision 5 的安装已被 revision 6 的移除取代", got)
	}
}

// TestTheUpgradeReplayInheritsTheControlMode covers the reconcile that does not
// repeat the mode.
//
// An ABSENT controlMode means "keep whatever this node is on", and the processor
// honours that. A replay that requires every payload to repeat it drops those
// reconciles — including their RELEASES. A mode-omitted direct reconcile that
// removes everyone would then leave the previous install claimed, and a panel
// account reusing that address could be deleted as ours.
func TestTheUpgradeReplayInheritsTheControlMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "node-agent.db")
	state := openAt(t, path, "node-1", "boot-1")

	finish := func(id string, kind protocol.CommandType, revision string, payload map[string]any) {
		t.Helper()
		if _, err := state.BeginCommand(protocol.Command{
			CommandID: id, Type: kind, TargetRevision: revision, Payload: payload,
		}); err != nil {
			t.Fatal(err)
		}
		if err := state.CompleteCommand(protocol.CommandResult{
			CommandID: id, Status: protocol.StatusCompleted,
		}); err != nil {
			t.Fatal(err)
		}
		time.Sleep(2 * time.Millisecond)
	}

	finish("c1", protocol.CommandReconcileUsers, "1", map[string]any{
		"controlMode": string(protocol.ModeDirectPrimary),
		"users":       []any{map[string]any{"bindingId": "b1", "email": "recycled@chordv", "uuid": "u"}},
	})
	// No controlMode: the node stays on direct_primary, and this removes everyone.
	finish("c2", protocol.CommandReconcileUsers, "2", map[string]any{"users": []any{}})

	if _, err := state.db.Exec(`DELETE FROM provisioned_accounts_v2`); err != nil {
		t.Fatal(err)
	}
	if _, err := state.db.Exec(`DELETE FROM meta_v2 WHERE key = 'provisioned_backfilled'`); err != nil {
		t.Fatal(err)
	}
	state.Close()

	reopened := openAt(t, path, "node-1", "boot-2")
	got, err := reopened.ProvisionedAccounts()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("升级后的供给凭据 = %v，want 空：省略 controlMode 的那次 reconcile 清空了用户集", got)
	}
}

// TestTheUpgradeReplayHonorsPerBindingFloors is why revision ORDER alone is not
// enough.
//
// A snapshot's per-user revision is the binding's own and can sit far below the
// snapshot's. The live merge drops a user whose revision does not clear the
// binding's floor, so that reconcile never installed it and never owned it.
// Replaying the raw payload instead re-claims an address the control plane
// released — and a panel account that reused it is then deleted as ours.
func TestTheUpgradeReplayHonorsPerBindingFloors(t *testing.T) {
	path := filepath.Join(t.TempDir(), "node-agent.db")
	state := openAt(t, path, "node-1", "boot-1")

	finish := func(id string, kind protocol.CommandType, revision string, payload map[string]any) {
		t.Helper()
		if _, err := state.BeginCommand(protocol.Command{
			CommandID: id, Type: kind, TargetRevision: revision, Payload: payload,
		}); err != nil {
			t.Fatal(err)
		}
		if err := state.CompleteCommand(protocol.CommandResult{
			CommandID: id, Status: protocol.StatusCompleted,
		}); err != nil {
			t.Fatal(err)
		}
		time.Sleep(2 * time.Millisecond)
	}

	finish("c1", protocol.CommandEnsureUser, "5", map[string]any{"bindingId": "b1", "email": "recycled@chordv", "uuid": "u"})
	finish("c2", protocol.CommandRemoveUser, "6", map[string]any{"bindingId": "b1", "email": "recycled@chordv"})
	// A snapshot at 10 still carrying b1 — but at ITS revision 5, which the live
	// merge measures against the binding's floor of 6 and drops.
	finish("c3", protocol.CommandReconcileUsers, "10", map[string]any{
		"controlMode": string(protocol.ModeDirectPrimary),
		"users": []any{
			map[string]any{"bindingId": "b1", "email": "recycled@chordv", "uuid": "u", "revision": "5"},
			map[string]any{"bindingId": "b2", "email": "kept@chordv", "uuid": "u", "revision": "9"},
		},
	})

	if _, err := state.db.Exec(`DELETE FROM provisioned_accounts_v2`); err != nil {
		t.Fatal(err)
	}
	if _, err := state.db.Exec(`DELETE FROM meta_v2 WHERE key = 'provisioned_backfilled'`); err != nil {
		t.Fatal(err)
	}
	state.Close()

	reopened := openAt(t, path, "node-1", "boot-2")
	got, err := reopened.ProvisionedAccounts()
	if err != nil {
		t.Fatal(err)
	}
	if _, held := got["kept@chordv"]; !held || len(got) != 1 {
		t.Fatalf("升级后的供给凭据 = %v，want 仅 [kept@chordv]：b1 在 revision 6 被移除，"+
			"快照携带的 revision 5 过不了它的下限", got)
	}
}

// TestTheUpgradeReplayDoesNotClaimDisabledUsers keeps the migration from
// inventing ownership.
//
// A disabled user in a reconcile payload is only ever uninstalled, never
// installed, so its presence is not evidence that this agent ever held the
// address. If the panel has since taken it, inventing a claim here means the
// next omission deletes their account.
func TestTheUpgradeReplayDoesNotClaimDisabledUsers(t *testing.T) {
	path := filepath.Join(t.TempDir(), "node-agent.db")
	state := openAt(t, path, "node-1", "boot-1")

	if _, err := state.BeginCommand(protocol.Command{
		CommandID: "c1", Type: protocol.CommandReconcileUsers, TargetRevision: "5",
		Payload: map[string]any{
			"controlMode": string(protocol.ModeDirectPrimary),
			"users": []any{
				map[string]any{"bindingId": "b1", "email": "neverours@panel", "uuid": "u", "enabled": false},
				map[string]any{"bindingId": "b2", "email": "ours@chordv", "uuid": "u"},
			},
		},
	}); err != nil {
		t.Fatal(err)
	}
	if err := state.CompleteCommand(protocol.CommandResult{
		CommandID: "c1", Status: protocol.StatusCompleted,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := state.db.Exec(`DELETE FROM provisioned_accounts_v2`); err != nil {
		t.Fatal(err)
	}
	if _, err := state.db.Exec(`DELETE FROM meta_v2 WHERE key = 'provisioned_backfilled'`); err != nil {
		t.Fatal(err)
	}
	state.Close()

	reopened := openAt(t, path, "node-1", "boot-2")
	got, err := reopened.ProvisionedAccounts()
	if err != nil {
		t.Fatal(err)
	}
	if _, held := got["ours@chordv"]; !held || len(got) != 1 {
		t.Fatalf("升级后的供给凭据 = %v，want 仅 [ours@chordv]：停用的用户从未被安装过", got)
	}
}

// TestTheUpgradeReplayRecoversIdentity keeps a recovered claim contradictable.
//
// A claim with no identity can be refuted by nothing, so a panel account that
// reused the address would be accepted as ours and deleted by a later omission.
// The command payloads carry the uuid; the replay has to keep it.
func TestTheUpgradeReplayRecoversIdentity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "node-agent.db")
	state := openAt(t, path, "node-1", "boot-1")

	finish := func(id string, kind protocol.CommandType, revision string, payload map[string]any) {
		t.Helper()
		if _, err := state.BeginCommand(protocol.Command{
			CommandID: id, Type: kind, TargetRevision: revision, Payload: payload,
		}); err != nil {
			t.Fatal(err)
		}
		if err := state.CompleteCommand(protocol.CommandResult{
			CommandID: id, Status: protocol.StatusCompleted,
		}); err != nil {
			t.Fatal(err)
		}
		time.Sleep(2 * time.Millisecond)
	}

	finish("c1", protocol.CommandEnsureUser, "1", map[string]any{
		"bindingId": "b1", "email": "u1@chordv", "uuid": "uuid-b1",
	})
	// Disabled afterwards: ownership is retained, and the identity must be too.
	finish("c2", protocol.CommandDisableUser, "2", map[string]any{"bindingId": "b1"})

	if _, err := state.db.Exec(`DELETE FROM provisioned_accounts_v2`); err != nil {
		t.Fatal(err)
	}
	if _, err := state.db.Exec(`DELETE FROM meta_v2 WHERE key = 'provisioned_backfilled'`); err != nil {
		t.Fatal(err)
	}
	state.Close()

	reopened := openAt(t, path, "node-1", "boot-2")
	claims, err := reopened.ProvisionedAccounts()
	if err != nil {
		t.Fatal(err)
	}
	if claims["u1@chordv"].UUID != "uuid-b1" {
		t.Fatalf("恢复的认领没有身份，任何账号都无法反驳它：%+v", claims)
	}
}
