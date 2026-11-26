package runner

import (
	"context"
	"testing"
	"time"

	"github.com/Achordchan/ChordV/apps/agent/internal/protocol"
	"github.com/Achordchan/ChordV/apps/agent/internal/xray"
)

// --- subscription expiry while the control plane is unreachable -------------

// expiring is user() with an expiry `offset` from the harness clock.
func (h *harness) expiring(bindingID, email, revision string, offset time.Duration) protocol.DesiredUser {
	u := user(bindingID, email, revision, true, "1000000")
	u.ExpiresAt = h.now.Add(offset).Format(time.RFC3339)
	return u
}

// installed makes an account one this node provisioned, which is what the
// ownership check reads before it will uninstall anything.
func (h *harness) installed(t *testing.T, users ...protocol.DesiredUser) {
	t.Helper()
	for _, u := range users {
		h.xray.live = append(h.xray.live, xray.LiveUser{Email: u.Email, UUID: u.UUID, Flow: u.Flow})
		if err := h.store.RecordProvisioned(u.BindingID, u.Email, u.UUID); err != nil {
			t.Fatal(err)
		}
	}
}

// TestAnExpiredSubscriptionIsCutOffWhileTheBackendIsDown is the reason the
// agent stores the date at all. The control plane ends a subscription when it
// sees traffic past the expiry; unreachable, it sees nothing, and the node kept
// serving a customer whose subscription had run out for as long as the outage
// lasted.
func TestAnExpiredSubscriptionIsCutOffWhileTheBackendIsDown(t *testing.T) {
	h := newHarness(t)
	lapsed := h.expiring("b1", "lapsed@example.com", "7", -time.Minute)
	current := h.expiring("b2", "current@example.com", "7", time.Hour)
	undated := user("b3", "undated@example.com", "7", true, "1000000")
	h.seed(t, "7", protocol.ModeDirectPrimary, lapsed, current, undated)
	runner := h.build(t)
	h.installed(t, lapsed, current, undated)

	if err := runner.sample(context.Background()); err != nil {
		t.Fatal(err)
	}
	calls := h.xray.log()
	if !contains(calls, "remove:lapsed@example.com") {
		t.Fatalf("到期用户应被卸载，实际调用 %v", calls)
	}
	if contains(calls, "remove:current@example.com") || contains(calls, "remove:undated@example.com") {
		t.Fatalf("未到期或没有到期时间的用户不应被动到，实际调用 %v", calls)
	}
}

// TestAReachableBackendKeepsTheSayOnExpiry. While the control plane answers it
// is the authority: an agent that also acted on its own clock could only ever
// disagree with it, and a node whose clock runs fast would cut off paying
// customers with nothing wrong anywhere else.
func TestAReachableBackendKeepsTheSayOnExpiry(t *testing.T) {
	h := newHarness(t)
	lapsed := h.expiring("b1", "lapsed@example.com", "7", -time.Minute)
	h.seed(t, "7", protocol.ModeDirectPrimary, lapsed)
	h.api.config = protocol.ConfigSnapshot{
		NodeID: "node-1", Revision: "7", ControlMode: protocol.ModeDirectPrimary,
		Users: []protocol.DesiredUser{lapsed},
	}
	runner := h.build(t)
	h.installed(t, lapsed)
	if _, err := runner.refreshConfig(context.Background()); err != nil {
		t.Fatal(err)
	}

	if err := runner.sample(context.Background()); err != nil {
		t.Fatal(err)
	}
	if contains(h.xray.log(), "remove:lapsed@example.com") {
		t.Fatalf("后台可达时不应由本机判定到期，实际调用 %v", h.xray.log())
	}
	if stored, _ := h.store.UserByBindingID("b1"); stored == nil || !stored.Enabled {
		t.Fatalf("stored = %+v", stored)
	}
}

// TestAnObservingNodeRecordsTheExpiryButLeavesXrayAlone: only direct_primary
// may write to Xray, for expiry exactly as for quota.
func TestAnObservingNodeRecordsTheExpiryButLeavesXrayAlone(t *testing.T) {
	h := newHarness(t)
	lapsed := h.expiring("b1", "lapsed@example.com", "7", -time.Minute)
	h.seed(t, "7", protocol.ModeShadowDirect, lapsed)
	runner := h.build(t)
	h.installed(t, lapsed)

	if err := runner.sample(context.Background()); err != nil {
		t.Fatal(err)
	}
	if contains(h.xray.log(), "remove:lapsed@example.com") {
		t.Fatalf("观察模式不应写 Xray，实际调用 %v", h.xray.log())
	}
}

// TestARenewalDuringTheOutageBringsTheUserBack. The customer renewed while the
// node could not hear about it, and the node cut them off by the old date. The
// control plane's first answer afterwards still wants the user — at the SAME
// revision when the renewal's own command never arrived — and that answer has
// to win, or a local clock decision would outlive the outage that excused it.
func TestARenewalDuringTheOutageBringsTheUserBack(t *testing.T) {
	h := newHarness(t)
	lapsed := h.expiring("b1", "a@example.com", "7", -time.Minute)
	h.seed(t, "7", protocol.ModeDirectPrimary, lapsed)
	runner := h.build(t)
	h.installed(t, lapsed)
	if err := runner.sample(context.Background()); err != nil {
		t.Fatal(err)
	}
	if stored, _ := h.store.UserByBindingID("b1"); stored == nil || stored.Enabled {
		t.Fatalf("前置条件：用户应已被本机停用，实际 %+v", stored)
	}

	renewed := lapsed
	renewed.ExpiresAt = h.now.Add(30 * 24 * time.Hour).Format(time.RFC3339)
	h.api.config = protocol.ConfigSnapshot{
		NodeID: "node-1", Revision: "7", ControlMode: protocol.ModeDirectPrimary,
		Users: []protocol.DesiredUser{renewed},
	}
	if err := runner.sendHeartbeat(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := runner.flushBatches(context.Background()); err != nil {
		t.Fatal(err)
	}

	stored, err := h.store.UserByBindingID("b1")
	if err != nil || stored == nil || !stored.Enabled {
		t.Fatalf("后台仍要这个用户，应恢复：%+v %v", stored, err)
	}
	want, _ := protocol.NormalizeExpiresAt(renewed.ExpiresAt)
	if stored.ExpiresAt != want {
		t.Fatalf("恢复后应记下续费后的到期时间 %s，实际 %s", want, stored.ExpiresAt)
	}
	live, _ := h.xray.ListUsers(context.Background())
	if len(live) != 1 || live[0].Email != "a@example.com" {
		t.Fatalf("恢复后应把账号装回 Xray，实际 %v", live)
	}

	// And it stays back: the node is online again, so the next tick is the
	// control plane's to judge, not the clock's.
	if err := runner.sample(context.Background()); err != nil {
		t.Fatal(err)
	}
	if stored, _ := h.store.UserByBindingID("b1"); stored == nil || !stored.Enabled {
		t.Fatalf("恢复后的下一次采样又把用户停了：%+v", stored)
	}
}

// TestTheBackendConfirmingTheExpirySettlesIt. The other answer: the control
// plane agrees the user is off. The row must stop counting as a decision this
// node made on its own — otherwise recoverAfterUpload asks for a fresh snapshot
// after every upload for as long as the binding exists.
func TestTheBackendConfirmingTheExpirySettlesIt(t *testing.T) {
	h := newHarness(t)
	lapsed := h.expiring("b1", "a@example.com", "7", -time.Minute)
	h.seed(t, "7", protocol.ModeDirectPrimary, lapsed)
	runner := h.build(t)
	h.installed(t, lapsed)
	if err := runner.sample(context.Background()); err != nil {
		t.Fatal(err)
	}
	if held, err := h.store.HasUsageDisabledUsers(); err != nil || !held {
		t.Fatalf("前置条件：应有本机停用的用户：%v %v", held, err)
	}

	confirmed := lapsed
	confirmed.Enabled = false
	h.api.config = protocol.ConfigSnapshot{
		NodeID: "node-1", Revision: "7", ControlMode: protocol.ModeDirectPrimary,
		Users: []protocol.DesiredUser{confirmed},
	}
	if err := runner.sendHeartbeat(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := runner.flushBatches(context.Background()); err != nil {
		t.Fatal(err)
	}

	stored, err := h.store.UserByBindingID("b1")
	if err != nil || stored == nil || stored.Enabled {
		t.Fatalf("后台确认停用后用户应保持停用：%+v %v", stored, err)
	}
	if held, err := h.store.HasUsageDisabledUsers(); err != nil || held {
		t.Fatalf("后台确认后不应再算本机停用：%v %v", held, err)
	}
	h.api.mu.Lock()
	asked := h.api.configs
	h.api.mu.Unlock()
	if err := runner.flushBatches(context.Background()); err != nil {
		t.Fatal(err)
	}
	h.api.mu.Lock()
	again := h.api.configs
	h.api.mu.Unlock()
	if again != asked {
		t.Fatalf("已结清的到期停用不应再触发拉取配置：%d → %d", asked, again)
	}
	if contains(h.xray.log(), "ensure:a@example.com") {
		t.Fatalf("后台确认停用的用户不应被装回，实际调用 %v", h.xray.log())
	}
}

// TestALapsedUserIsNotReinstalledByAnXrayRestartDuringTheOutage. 3x-ui restarts
// Xray whenever an administrator edits an inbound, and the recovery that
// follows reinstalls this node's users. A cutoff that did not survive it would
// last only until the next panel edit.
func TestALapsedUserIsNotReinstalledByAnXrayRestartDuringTheOutage(t *testing.T) {
	h := newHarness(t)
	lapsed := h.expiring("b1", "lapsed@example.com", "7", -time.Minute)
	current := h.expiring("b2", "current@example.com", "7", time.Hour)
	h.seed(t, "7", protocol.ModeDirectPrimary, lapsed, current)
	runner := h.build(t)
	h.installed(t, lapsed, current)
	if err := runner.sample(context.Background()); err != nil {
		t.Fatal(err)
	}

	// Xray comes back empty, having just started.
	h.xray.mu.Lock()
	h.xray.live = nil
	h.xray.uptime = 1
	h.xray.calls = nil
	h.xray.mu.Unlock()
	h.now = h.now.Add(10 * time.Minute)
	if err := runner.sample(context.Background()); err != nil {
		t.Fatal(err)
	}
	calls := h.xray.log()
	if !contains(calls, "ensure:current@example.com") {
		t.Fatalf("Xray 重启后应装回未到期的用户，实际调用 %v", calls)
	}
	if contains(calls, "ensure:lapsed@example.com") {
		t.Fatalf("Xray 重启不应把已到期停用的用户装回，实际调用 %v", calls)
	}
}
