package runner

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/Achordchan/ChordV/apps/agent/internal/connkill"
	"github.com/Achordchan/ChordV/apps/agent/internal/protocol"
	"github.com/Achordchan/ChordV/apps/agent/internal/store"
)

type onlineXray struct {
	*fakeXray
	online map[string]int
	err    error
}

func (x *onlineXray) OnlineUsers(context.Context) (map[string]int, error) { return x.online, x.err }
func (x *onlineXray) OnlineIPs(context.Context, string) ([]string, error) { return nil, nil }
func (x *onlineXray) Listener(context.Context) (connkill.Listener, error) {
	return connkill.Listener{Port: 443}, nil
}

func heartbeatWithOnline(t *testing.T, online map[string]int, readErr error) protocol.Heartbeat {
	t.Helper()
	return heartbeatWithOnlineAfter(t, online, readErr, func(t *testing.T, h *harness) {
		// b2 is disabled, so it is not installed; this agent's own claim is
		// what proves its lingering connection is still b2's.
		if err := h.store.RecordProvisioned("b2", "b@example.com", "uuid-b2"); err != nil {
			t.Fatal(err)
		}
	})
}

func heartbeatWithOnlineAfter(t *testing.T, online map[string]int, readErr error, setup func(*testing.T, *harness)) protocol.Heartbeat {
	t.Helper()
	h := newHarness(t)
	h.seed(t, "7", protocol.ModeDirectPrimary,
		user("b1", "a@example.com", "7", true, "1000"),
		user("b2", "b@example.com", "7", false, "1000"))
	r := h.build(t)
	r.deps.Xray = &onlineXray{fakeXray: h.xray, online: online, err: readErr}
	if err := r.sample(context.Background()); err != nil {
		t.Fatal(err)
	}
	setup(t, h)
	h.api.heartbeatAck = protocol.HeartbeatAck{Accepted: true, AckThrough: "0", ConfigRevision: "7"}
	if err := r.sendHeartbeat(context.Background()); err != nil {
		t.Fatal(err)
	}
	return h.api.heartbeats[len(h.api.heartbeats)-1]
}

// Managed accounts are reported by binding; panel accounts and other inbounds'
// emails never leave the node. A disabled account still online is reported:
// that is exactly the case an operator needs to see.
func TestTheHeartbeatReportsManagedOnlineAccounts(t *testing.T) {
	beat := heartbeatWithOnline(t, map[string]int{"a@example.com": 2, "b@example.com": 1, "panel-self": 1}, nil)
	if beat.OnlineUsers == nil {
		t.Fatal("online report missing")
	}
	got := *beat.OnlineUsers
	if len(got) != 2 || got[0] != (protocol.OnlineUser{BindingID: "b1", IPCount: 2}) || got[1] != (protocol.OnlineUser{BindingID: "b2", IPCount: 1}) {
		t.Fatalf("online report: %+v", got)
	}
}

// "Nobody online" must be distinguishable from "not observed".
func TestTheHeartbeatSendsAnEmptyListWhenNobodyIsOnline(t *testing.T) {
	beat := heartbeatWithOnline(t, map[string]int{}, nil)
	if beat.OnlineUsers == nil || len(*beat.OnlineUsers) != 0 {
		t.Fatalf("want empty list, got %+v", beat.OnlineUsers)
	}
}

// A failed read omits the field so the server keeps its previous view instead
// of marking everyone offline.
func TestAFailedOnlineReadOmitsTheField(t *testing.T) {
	beat := heartbeatWithOnline(t, nil, errors.New("boom"))
	if beat.OnlineUsers != nil {
		t.Fatalf("want nil, got %+v", *beat.OnlineUsers)
	}
}

// An adapter without online tracking never claims anyone is offline.
func TestAnAdapterWithoutOnlineTrackingOmitsTheField(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "7", protocol.ModeDirectPrimary, user("b1", "a@example.com", "7", true, "1000"))
	r := h.build(t)
	if err := r.sample(context.Background()); err != nil {
		t.Fatal(err)
	}
	h.api.heartbeatAck = protocol.HeartbeatAck{Accepted: true, AckThrough: "0", ConfigRevision: "7"}
	if err := r.sendHeartbeat(context.Background()); err != nil {
		t.Fatal(err)
	}
	if beat := h.api.heartbeats[0]; beat.OnlineUsers != nil {
		t.Fatalf("want nil, got %+v", *beat.OnlineUsers)
	}
}

// Traffic with no online record means statsUserOnline is off: report nothing
// rather than "everyone offline", and recover once tracking works.
func TestTrafficWithoutOnlineRecordsOmitsTheReport(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "7", protocol.ModeDirectPrimary, user("b1", "a@example.com", "7", true, "100000"))
	r := h.build(t)
	x := &onlineXray{fakeXray: h.xray, online: map[string]int{}}
	r.deps.Xray = x
	h.api.heartbeatAck = protocol.HeartbeatAck{Accepted: true, AckThrough: "0", ConfigRevision: "7"}
	h.xray.counters = []protocol.AbsoluteCounter{{Email: "a@example.com", UplinkBytes: "10", DownlinkBytes: "0"}}
	if err := r.sample(context.Background()); err != nil {
		t.Fatal(err)
	}
	h.xray.counters = []protocol.AbsoluteCounter{{Email: "a@example.com", UplinkBytes: "20", DownlinkBytes: "5"}}
	if err := r.sample(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := r.sendHeartbeat(context.Background()); err != nil {
		t.Fatal(err)
	}
	if beat := h.api.heartbeats[len(h.api.heartbeats)-1]; beat.OnlineUsers != nil {
		t.Fatalf("active traffic with empty online stats must omit the report, got %+v", *beat.OnlineUsers)
	}
	x.online = map[string]int{"a@example.com": 1}
	if err := r.sendHeartbeat(context.Background()); err != nil {
		t.Fatal(err)
	}
	if beat := h.api.heartbeats[len(h.api.heartbeats)-1]; beat.OnlineUsers == nil || len(*beat.OnlineUsers) != 1 {
		t.Fatalf("report should resume once tracking works: %+v", beat.OnlineUsers)
	}
	// Idle accounts (no traffic since the last sample) with an empty report are
	// a genuine "nobody online".
	if err := r.sample(context.Background()); err != nil {
		t.Fatal(err)
	}
	x.online = map[string]int{}
	if err := r.sendHeartbeat(context.Background()); err != nil {
		t.Fatal(err)
	}
	if beat := h.api.heartbeats[len(h.api.heartbeats)-1]; beat.OnlineUsers == nil || len(*beat.OnlineUsers) != 0 {
		t.Fatalf("idle node should report an empty list: %+v", beat.OnlineUsers)
	}
}

func TestOnlineTrackingConsistent(t *testing.T) {
	if !onlineTrackingConsistent(map[string]int{}, nil) {
		t.Fatal("no traffic: consistent")
	}
	if onlineTrackingConsistent(map[string]int{}, []string{"a"}) {
		t.Fatal("traffic but no online: inconsistent")
	}
	if !onlineTrackingConsistent(map[string]int{"a": 1}, []string{"a", "b"}) {
		t.Fatal("one active account seen online: consistent")
	}
}

func installedUUID(t *testing.T, h *harness, email string) string {
	t.Helper()
	for _, account := range h.xray.live {
		if account.Email == email {
			return account.UUID
		}
	}
	return ""
}

// Online stats are keyed by email only. A panel account that reuses a managed
// address (different UUID), or a claim held by another binding, must not be
// reported as the managed binding being online.
func TestOnlineRecordsNeedProvenOwnership(t *testing.T) {
	beat := heartbeatWithOnlineAfter(t, map[string]int{"a@example.com": 1, "b@example.com": 1}, nil, func(t *testing.T, h *harness) {
		if installedUUID(t, h, "a@example.com") != "uuid-b1" {
			t.Fatalf("b1 should be installed with its own identity: %+v", h.xray.live)
		}
		for index := range h.xray.live {
			if h.xray.live[index].Email == "a@example.com" {
				h.xray.live[index].UUID = "panel-uuid"
			}
		}
		if err := h.store.RecordProvisioned("someone-else", "b@example.com", "uuid-b2"); err != nil {
			t.Fatal(err)
		}
	})
	if beat.OnlineUsers == nil || len(*beat.OnlineUsers) != 0 {
		t.Fatalf("unproven records must not be attributed: %+v", beat.OnlineUsers)
	}
}

// A removed account with no claim of ours is not attributed either.
func TestAnUninstalledAccountWithoutAClaimIsNotReported(t *testing.T) {
	beat := heartbeatWithOnlineAfter(t, map[string]int{"b@example.com": 1}, nil, func(*testing.T, *harness) {})
	if beat.OnlineUsers == nil || len(*beat.OnlineUsers) != 0 {
		t.Fatalf("want empty list, got %+v", beat.OnlineUsers)
	}
}

// The control plane rejects an ipCount above its limit, which would drop the
// whole heartbeat; the agent clamps it instead.
func TestAnOversizedIPCountIsClamped(t *testing.T) {
	beat := heartbeatWithOnline(t, map[string]int{"a@example.com": protocol.MaxOnlineIPCount + 5}, nil)
	if beat.OnlineUsers == nil || len(*beat.OnlineUsers) != 1 || (*beat.OnlineUsers)[0].IPCount != protocol.MaxOnlineIPCount {
		t.Fatalf("want clamped count, got %+v", beat.OnlineUsers)
	}
}

func TestOwnsOnlineRecord(t *testing.T) {
	mine := onlineCandidate{BindingID: "b1", UUID: "u1"}
	if !ownsOnlineRecord(mine, "u1", true) || ownsOnlineRecord(mine, "other", true) {
		t.Fatal("installed accounts are judged by identity")
	}
	if ownsOnlineRecord(mine, "", false) {
		t.Fatal("no claim, no ownership")
	}
	withClaim := func(claim store.Claim) onlineCandidate { c := mine; c.Claim = &claim; return c }
	if !ownsOnlineRecord(withClaim(store.Claim{BindingID: "b1", UUID: "u1"}), "", false) {
		t.Fatal("own claim with matching identity")
	}
	if !ownsOnlineRecord(withClaim(store.Claim{BindingID: "b1", UUID: "u0", NextUUID: "u1"}), "", false) {
		t.Fatal("rotation in flight still ours")
	}
	if ownsOnlineRecord(withClaim(store.Claim{BindingID: "b1", UUID: "u9"}), "", false) {
		t.Fatal("contradicting identity")
	}
	if ownsOnlineRecord(withClaim(store.Claim{BindingID: "b9", UUID: "u1"}), "", false) {
		t.Fatal("another binding's claim")
	}
}

// Every report carries a strictly increasing sequence, even when the clock
// stands still, so the server can discard a delayed older report.
func TestOnlineReportsCarryAnIncreasingSequence(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "7", protocol.ModeDirectPrimary, user("b1", "a@example.com", "7", true, "1000"))
	r := h.build(t)
	r.deps.Xray = &onlineXray{fakeXray: h.xray, online: map[string]int{"a@example.com": 1}}
	if err := r.sample(context.Background()); err != nil {
		t.Fatal(err)
	}
	h.api.heartbeatAck = protocol.HeartbeatAck{Accepted: true, AckThrough: "0", ConfigRevision: "7"}
	for i := 0; i < 2; i++ {
		if err := r.sendHeartbeat(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	first, second := h.api.heartbeats[0], h.api.heartbeats[1]
	if first.OnlineSequence <= 0 || second.OnlineSequence <= first.OnlineSequence {
		t.Fatalf("sequences must increase: %d then %d", first.OnlineSequence, second.OnlineSequence)
	}
	if first.OnlineSequence < h.now.UnixMilli() {
		t.Fatalf("sequence should follow the wall clock: %d", first.OnlineSequence)
	}
}

// A report that is not sent carries no sequence.
func TestAnOmittedReportHasNoSequence(t *testing.T) {
	beat := heartbeatWithOnline(t, nil, errors.New("boom"))
	if beat.OnlineSequence != 0 {
		t.Fatalf("want 0, got %d", beat.OnlineSequence)
	}
}

// A restart after the clock went back must not fall below a sequence already
// sent: the last one is persisted and the next always continues above it.
func TestTheSequenceSurvivesARestartWithABackwardClock(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "7", protocol.ModeDirectPrimary, user("b1", "a@example.com", "7", true, "1000"))
	ahead := h.now.Add(10 * time.Hour).UnixMilli()
	if err := h.store.SetOnlineSequence(ahead); err != nil {
		t.Fatal(err)
	}
	r := h.build(t)
	r.deps.Xray = &onlineXray{fakeXray: h.xray, online: map[string]int{"a@example.com": 1}}
	if err := r.sample(context.Background()); err != nil {
		t.Fatal(err)
	}
	h.api.heartbeatAck = protocol.HeartbeatAck{Accepted: true, AckThrough: "0", ConfigRevision: "7"}
	if err := r.sendHeartbeat(context.Background()); err != nil {
		t.Fatal(err)
	}
	beat := h.api.heartbeats[len(h.api.heartbeats)-1]
	if beat.OnlineUsers == nil || beat.OnlineSequence != ahead+1 {
		t.Fatalf("want sequence %d, got %d (%+v)", ahead+1, beat.OnlineSequence, beat.OnlineUsers)
	}
	if stored, err := h.store.OnlineSequence(); err != nil || stored != ahead+1 {
		t.Fatalf("persisted sequence: %d %v", stored, err)
	}
}

// Xray lists UUIDs in lowercase even when the binding carries uppercase.
func TestOwnershipComparesUUIDsCanonically(t *testing.T) {
	upper := onlineCandidate{BindingID: "b1", UUID: "6F1C1A5E-0D4B-4C1E-9C1A-1234567890AB"}
	if !ownsOnlineRecord(upper, "6f1c1a5e-0d4b-4c1e-9c1a-1234567890ab", true) {
		t.Fatal("installed account with a lowercase live UUID is still ours")
	}
	upper.Claim = &store.Claim{BindingID: "b1", UUID: "6f1c1a5e-0d4b-4c1e-9c1a-1234567890ab"}
	if !ownsOnlineRecord(upper, "", false) {
		t.Fatal("claim recorded in lowercase is still ours")
	}
}
