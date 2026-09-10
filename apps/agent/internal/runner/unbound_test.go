package runner

import (
	"context"
	"github.com/Achordchan/ChordV/apps/agent/internal/protocol"
	"testing"
)

type unboundXray struct{ *fakeXray }

func (*unboundXray) InboundReady() bool { return false }

func TestUnboundRunnerOnlyChecksHealthAndReportsWaiting(t *testing.T) {
	h := newHarness(t)
	r := h.build(t)
	r.deps.Xray = &unboundXray{h.xray}
	r.current.ControlMode = protocol.ModeDirectPrimary
	r.reconcilePending = true
	ctx := context.Background()
	if err := r.sample(ctx); err != nil {
		t.Fatal(err)
	}
	if err := r.detectMissingUsersLocked(ctx); err != nil {
		t.Fatal(err)
	}
	if err := r.flushPendingReconcileLocked(ctx); err != nil {
		t.Fatal(err)
	}
	if err := r.sendHeartbeat(ctx); err != nil {
		t.Fatal(err)
	}
	if len(h.api.heartbeats) != 1 || h.api.heartbeats[0].XrayStatus != protocol.XrayAwaitingInbound {
		t.Fatalf("wrong readiness: %+v", h.api.heartbeats)
	}
	for _, call := range h.xray.log() {
		if call != "health" {
			t.Fatalf("unbound runner touched inbound: %v", h.xray.log())
		}
	}
	if !r.reconcilePending {
		t.Fatal("pending reconciliation lost before binding")
	}
	if count, err := h.store.PendingBatchCount(); err != nil || count != 0 {
		t.Fatalf("unbound sampling created usage: %d %v", count, err)
	}
}
