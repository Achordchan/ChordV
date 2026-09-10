package commands

import (
	"context"
	"github.com/Achordchan/ChordV/apps/agent/internal/protocol"
	"testing"
)

type unboundXray struct{ *fakeXray }

func (*unboundXray) InboundReady() bool { return false }

func TestUnboundProcessorRejectsAccountCommandsAndReconciliation(t *testing.T) {
	p, fake, _ := newProcessor(t, false)
	p.deps.Xray = &unboundXray{fake}
	ctx := context.Background()
	if err := p.Reconcile(ctx, nil); err != nil {
		t.Fatal(err)
	}
	if err := p.Reconcile(ctx, []protocol.DesiredUser{{BindingID: "account"}}); err == nil {
		t.Fatal("unbound reconcile accepted accounts")
	}
	for _, kind := range []protocol.CommandType{protocol.CommandEnsureUser, protocol.CommandEnableUser, protocol.CommandDisableUser, protocol.CommandRemoveUser, protocol.CommandReconcileUsers, protocol.CommandRefreshQuota} {
		result := run(t, p, command(string(kind), kind, "1", userPayload("binding", "panel-user")), true)
		if result.Status != protocol.StatusFailed {
			t.Fatalf("unbound command %s accepted", kind)
		}
	}
	calls := 0
	p.deps.ValidatePanel = func(context.Context, map[string]any) (map[string]any, error) {
		calls++
		return map[string]any{"validated": true}, nil
	}
	result := run(t, p, command("bind", protocol.CommandEnsureInbound, "2", map[string]any{"mode": "validate_panel"}), true)
	if result.Status != protocol.StatusCompleted || calls != 1 {
		t.Fatal("binding command must remain available")
	}
	if len(fake.calls) != 0 {
		t.Fatalf("unbound processor touched accounts: %v", fake.calls)
	}
}
