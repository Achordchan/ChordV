package runner

import (
	"context"
	"errors"
	"testing"

	"github.com/Achordchan/ChordV/apps/agent/internal/protocol"
)

type onlineXray struct {
	*fakeXray
	online map[string]int
	err    error
}

func (x *onlineXray) OnlineUsers(context.Context) (map[string]int, error) { return x.online, x.err }
func (x *onlineXray) OnlineIPs(context.Context, string) ([]string, error) { return nil, nil }
func (x *onlineXray) ListenPort(context.Context) (int, error)             { return 443, nil }

func heartbeatWithOnline(t *testing.T, online map[string]int, readErr error) protocol.Heartbeat {
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
