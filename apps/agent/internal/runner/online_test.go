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
