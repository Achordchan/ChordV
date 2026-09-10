package runner

import (
	"context"
	"errors"
	"math/big"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Achordchan/ChordV/apps/agent/internal/agentcfg"
	"github.com/Achordchan/ChordV/apps/agent/internal/commands"
	"github.com/Achordchan/ChordV/apps/agent/internal/protocol"
	"github.com/Achordchan/ChordV/apps/agent/internal/store"
	"github.com/Achordchan/ChordV/apps/agent/internal/xray"
)

// --- fakes -------------------------------------------------------------------

// fakeXray is the local Xray. It records what it was asked, in order, because
// several of the properties this package must hold are about ORDER — metering
// before a removal, the mode gate before an install.
type fakeXray struct {
	mu       sync.Mutex
	live     []xray.LiveUser
	calls    []string
	counters []protocol.AbsoluteCounter
	uptime   int64

	healthErr    error
	uptimeErr    error
	ensureErr    error
	countersErr  error
	reconcileErr error
	// onCounters runs at the moment of a counter read, so a test can observe
	// what the store looked like at that instant rather than only afterwards.
	onCounters func()
}

func (f *fakeXray) note(call string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, call)
}

func (f *fakeXray) log() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

func (f *fakeXray) Health(context.Context) error { f.note("health"); return f.healthErr }

func (f *fakeXray) UptimeSeconds(context.Context) (int64, error) {
	f.note("uptime")
	return f.uptime, f.uptimeErr
}

func (f *fakeXray) ListUsers(context.Context) ([]xray.LiveUser, error) {
	f.note("list")
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]xray.LiveUser(nil), f.live...), nil
}

func (f *fakeXray) EnsureUser(_ context.Context, user protocol.DesiredUser, _ xray.Expectation) error {
	f.note("ensure:" + user.Email)
	if f.reconcileErr != nil {
		return f.reconcileErr
	}
	if f.ensureErr != nil {
		return f.ensureErr
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for index, account := range f.live {
		if account.Email == user.Email {
			f.live[index] = xray.LiveUser{Email: user.Email, Flow: user.Flow, UUID: user.UUID}
			return nil
		}
	}
	f.live = append(f.live, xray.LiveUser{Email: user.Email, Flow: user.Flow, UUID: user.UUID})
	return nil
}

func (f *fakeXray) RemoveUser(_ context.Context, email string, _ xray.Expectation) error {
	f.note("remove:" + email)
	f.mu.Lock()
	defer f.mu.Unlock()
	kept := f.live[:0]
	for _, account := range f.live {
		if account.Email != email {
			kept = append(kept, account)
		}
	}
	f.live = kept
	return nil
}

func (f *fakeXray) ReadAbsoluteCounters(context.Context) ([]protocol.AbsoluteCounter, error) {
	f.note("counters")
	if f.onCounters != nil {
		f.onCounters()
	}
	return f.counters, f.countersErr
}

// fakeAPI is the control plane.
type fakeAPI struct {
	mu sync.Mutex

	config    protocol.ConfigSnapshot
	configErr error
	configs   int

	heartbeatAck protocol.HeartbeatAck
	heartbeatErr error
	heartbeats   []protocol.Heartbeat

	uploadAck protocol.UsageBatchAck
	uploadErr error
	uploaded  []protocol.UsageBatch

	reported []protocol.CommandResult

	// stream is delivered to the events callback on each connection, then the
	// stream ends with streamErr.
	stream    []protocol.Command
	streamErr error
	streams   int
}

func (a *fakeAPI) GetConfig(context.Context) (protocol.ConfigSnapshot, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.configs++
	return a.config, a.configErr
}

func (a *fakeAPI) Heartbeat(_ context.Context, payload protocol.Heartbeat) (protocol.HeartbeatAck, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.heartbeats = append(a.heartbeats, payload)
	return a.heartbeatAck, a.heartbeatErr
}

func (a *fakeAPI) UploadBatch(_ context.Context, batch protocol.UsageBatch) (protocol.UsageBatchAck, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.uploadErr != nil {
		return protocol.UsageBatchAck{}, a.uploadErr
	}
	a.uploaded = append(a.uploaded, batch)
	ack := a.uploadAck
	if ack.AckThrough == "" {
		ack = protocol.UsageBatchAck{Accepted: true, AckThrough: batch.Sequence}
	}
	return ack, nil
}

func (a *fakeAPI) ReportCommandResult(_ context.Context, result protocol.CommandResult) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.reported = append(a.reported, result)
	return nil
}

func (a *fakeAPI) ConsumeEvents(ctx context.Context, onCommand func(protocol.Command) error) error {
	a.mu.Lock()
	a.streams++
	queued := append([]protocol.Command(nil), a.stream...)
	err := a.streamErr
	a.mu.Unlock()
	for _, command := range queued {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if callbackErr := onCommand(command); callbackErr != nil {
			return callbackErr
		}
	}
	return err
}

func (a *fakeAPI) results() []protocol.CommandResult {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]protocol.CommandResult(nil), a.reported...)
}

// --- harness -----------------------------------------------------------------

const bootID = "boot-1"

type harness struct {
	runner *Runner
	api    *fakeAPI
	xray   *fakeXray
	store  *store.Store
	now    time.Time
	logs   []string
	mu     sync.Mutex
}

// newHarness builds a runner over a REAL store — the interesting behaviour here
// is what the loop and the database agree on, and a fake store would only
// re-state the assertions.
func newHarness(t *testing.T) *harness {
	t.Helper()
	state, err := store.Open(filepath.Join(t.TempDir(), "node-agent.db"), store.Options{
		BootID: bootID, NodeID: "node-1", DefaultOfflineAllowance: big.NewInt(64 * 1024 * 1024),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { state.Close() })
	return &harness{
		api:   &fakeAPI{heartbeatAck: protocol.HeartbeatAck{Accepted: true, AckThrough: "0"}, config: protocol.ConfigSnapshot{NodeID: "node-1", Revision: "0", ControlMode: protocol.ModeShadowDirect}},
		xray:  &fakeXray{uptime: 100},
		store: state,
		now:   time.Date(2026, 9, 10, 12, 0, 0, 0, time.UTC),
	}
}

// build finalises the runner. It is separate from newHarness because the runner
// caches the stored snapshot at construction, so every seeding a test does must
// happen first.
func (h *harness) build(t *testing.T) *Runner {
	t.Helper()
	runner, err := New(Deps{
		Config: &agentcfg.Config{
			SampleInterval: 5 * time.Millisecond, HeartbeatInterval: 5 * time.Millisecond,
			RestartTolerance: 2 * time.Second, OfflineAllowanceBytes: big.NewInt(64 * 1024 * 1024),
		},
		Store: h.store,
		API:   h.api,
		Xray:  h.xray,
		Commands: commands.New(commands.Deps{
			Store: h.store, Xray: h.xray, AdoptExistingAccounts: true,
			Logf: func(string, ...any) {},
		}),
		BootID: bootID,
		Logf:   h.record,
		Now:    func() time.Time { return h.now },
	})
	if err != nil {
		t.Fatal(err)
	}
	h.runner = runner
	return runner
}

func (h *harness) record(format string, args ...any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.logs = append(h.logs, format)
}

// seed applies a snapshot the way the control plane would have.
func (h *harness) seed(t *testing.T, revision string, mode protocol.ControlMode, users ...protocol.DesiredUser) {
	t.Helper()
	if _, err := h.store.ApplyConfigSnapshot(protocol.ConfigSnapshot{
		NodeID: "node-1", Revision: revision, ControlMode: mode, Users: users,
	}); err != nil {
		t.Fatal(err)
	}
}

func user(bindingID, email, revision string, enabled bool, quota string) protocol.DesiredUser {
	return protocol.DesiredUser{
		BindingID: bindingID, Email: email, UUID: "uuid-" + bindingID, Flow: protocol.FlowVision,
		Revision: revision, Enabled: enabled, QuotaRemainingBytes: quota,
	}
}

func contains(haystack []string, needle string) bool {
	for _, value := range haystack {
		if value == needle {
			return true
		}
	}
	return false
}

func indexOf(t *testing.T, haystack []string, needle string) int {
	t.Helper()
	for index, value := range haystack {
		if value == needle {
			return index
		}
	}
	t.Fatalf("调用序列 %v 中没有 %q", haystack, needle)
	return -1
}

// --- startup -----------------------------------------------------------------

// TestAFirstBootWithNoBackendRefusesToStart: a node that has never received a
// snapshot has nothing to serve AND no way to find out what it should serve.
// Starting anyway would produce a healthy-looking agent serving nobody.
func TestAFirstBootWithNoBackendRefusesToStart(t *testing.T) {
	h := newHarness(t)
	h.api.configErr = errors.New("控制面不可用")
	runner := h.build(t)

	err := runner.start(context.Background())
	if err == nil {
		t.Fatal("首次启动拿不到配置时必须失败")
	}
	if !strings.Contains(err.Error(), "控制面不可用") {
		t.Fatalf("错误信息应带上原因，实际 %v", err)
	}
}

// TestABackendOutageStartsFromTheStoredConfig is the other half: a node that
// already knows what to serve must keep serving it. An agent that refused to
// start while the control plane was down would take the whole fleet with it.
func TestABackendOutageStartsFromTheStoredConfig(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "7", protocol.ModeDirectPrimary, user("b1", "a@example.com", "7", true, "1000"))
	h.api.configErr = errors.New("控制面不可用")
	runner := h.build(t)

	if err := runner.start(context.Background()); err != nil {
		t.Fatalf("已有本地配置时不应拒绝启动：%v", err)
	}
	if runner.current.Revision != "7" {
		t.Fatalf("应沿用本地 revision 7，实际 %q", runner.current.Revision)
	}
}

// TestADownXrayDoesNotStopTheAgentFromStarting is a deliberate departure from
// the Node agent, which exited. Under B1 the Xray process belongs to 3x-ui and
// is restarted whenever an administrator edits an inbound, so exiting turns an
// ordinary event into a node that is simply ABSENT from the control plane —
// where staying up reports xrayStatus=offline, the same fact with somewhere to
// read it.
func TestADownXrayDoesNotStopTheAgentFromStarting(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "7", protocol.ModeDirectPrimary)
	h.xray.healthErr = errors.New("connection refused")
	runner := h.build(t)

	if err := runner.start(context.Background()); err != nil {
		t.Fatalf("Xray 不可用不应阻止启动：%v", err)
	}
	if runner.xrayHealthy {
		t.Fatal("Xray 不可用时不能标记为健康")
	}
	if err := runner.sendHeartbeat(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := h.api.heartbeats[0].XrayStatus; got != protocol.XrayOffline {
		t.Fatalf("心跳应上报 offline，实际 %q", got)
	}
}

// --- Xray restart detection ---------------------------------------------------

// TestAnXrayRestartReinstallsTheUsers. Accounts added over gRPC live only in
// Xray's memory, so a restart empties the inbound while the agent still believes
// it is provisioned.
func TestAnXrayRestartReinstallsTheUsers(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "7", protocol.ModeDirectPrimary, user("b1", "a@example.com", "7", true, "1000"))
	h.xray.live = []xray.LiveUser{{Email: "a@example.com", UUID: "uuid-b1"}}
	runner := h.build(t)
	runner.state.Lock()
	if err := runner.detectXrayRestartLocked(context.Background()); err != nil {
		t.Fatal(err)
	}
	runner.state.Unlock()

	// Xray is replaced: a NEW process, so its uptime restarts from nearly zero
	// while wall-clock time has moved on.
	h.now = h.now.Add(time.Minute)
	h.xray.uptime = 1
	h.xray.live = nil

	runner.state.Lock()
	err := runner.detectXrayRestartLocked(context.Background())
	runner.state.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if !contains(h.xray.log(), "ensure:a@example.com") {
		t.Fatalf("重启后应重新安装用户，实际调用 %v", h.xray.log())
	}
	if runner.reconcilePending {
		t.Fatal("重新安装成功后不应继续挂着 reconcile 意图")
	}
}

// TestARestartBetweenSamplesIsCaughtByTheLiveTable. The uptime estimate cannot
// see a restart that lands within the tolerance of the previous process's start
// — the baseline is simply replaced. The live table is the ground truth.
func TestARestartBetweenSamplesIsCaughtByTheLiveTable(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "7", protocol.ModeDirectPrimary, user("b1", "a@example.com", "7", true, "1000"))
	h.xray.live = []xray.LiveUser{{Email: "a@example.com", UUID: "uuid-b1"}}
	runner := h.build(t)
	runner.state.Lock()
	if err := runner.detectXrayRestartLocked(context.Background()); err != nil {
		t.Fatal(err)
	}
	runner.state.Unlock()

	// The account is gone, but the uptime estimate is unchanged: as far as the
	// arithmetic can tell, this is the same process it saw a moment ago.
	h.xray.live = nil

	runner.state.Lock()
	err := runner.detectXrayRestartLocked(context.Background())
	runner.state.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if !contains(h.xray.log(), "ensure:a@example.com") {
		t.Fatalf("已下发的用户从 Xray 消失时必须补装，实际调用 %v", h.xray.log())
	}
}

// TestAnImplausibleUptimeIsRefusedRatherThanUsed. time.Duration is int64
// NANOseconds, so a large second count overflows the multiplication into a
// NEGATIVE duration — which would push the estimated start centuries forward and
// read as "restarted" on every sample from then on.
func TestAnImplausibleUptimeIsRefusedRatherThanUsed(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "7", protocol.ModeDirectPrimary)
	h.xray.uptime = int64(1) << 62
	runner := h.build(t)

	runner.state.Lock()
	err := runner.detectXrayRestartLocked(context.Background())
	baseline := runner.lastXrayStart
	runner.state.Unlock()
	if err == nil {
		t.Fatal("不合理的运行时长必须报错")
	}
	if !baseline.IsZero() {
		t.Fatal("不合理的读数不能成为重启判断的基准")
	}
}

// TestAFailedRecoveryKeepsTheReconcileIntent. A HandlerService call can fail
// while Xray is still initialising, and by then the health flag and the uptime
// baseline have both moved on: without a surviving intent nothing would retry
// and the node would serve nobody until its next restart.
func TestAFailedRecoveryKeepsTheReconcileIntent(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "7", protocol.ModeDirectPrimary, user("b1", "a@example.com", "7", true, "1000"))
	h.xray.healthErr = errors.New("connection refused")
	runner := h.build(t)
	runner.state.Lock()
	_ = runner.checkXrayLocked(context.Background()) // marks Xray unhealthy
	runner.state.Unlock()

	// Xray answers again, but the install still fails — it is up, not ready.
	h.xray.healthErr = nil
	h.xray.ensureErr = errors.New("xray 尚未就绪")
	runner.state.Lock()
	err := runner.checkXrayLocked(context.Background())
	pending := runner.reconcilePending
	runner.state.Unlock()
	if err == nil {
		t.Fatal("安装失败必须上报")
	}
	if !pending {
		t.Fatal("恢复失败后必须保留 reconcile 意图，否则没有任何东西会重试")
	}

	h.xray.ensureErr = nil
	runner.state.Lock()
	err = runner.checkXrayLocked(context.Background())
	pending = runner.reconcilePending
	runner.state.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if pending {
		t.Fatal("重试成功后应清除意图")
	}
	if !contains(h.xray.log(), "ensure:a@example.com") {
		t.Fatalf("重试应真的把用户装回去，实际调用 %v", h.xray.log())
	}
}

// --- configuration refresh -----------------------------------------------------

// TestASnapshotThatTakesAUserAwayIsMeteredFirst. Once the account is gone from
// Xray its in-memory counters go with it, and the traffic since the last tick
// would never be billed.
func TestASnapshotThatTakesAUserAwayIsMeteredFirst(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "7", protocol.ModeDirectPrimary, user("b1", "a@example.com", "7", true, "1000"))
	h.xray.live = []xray.LiveUser{{Email: "a@example.com", UUID: "uuid-b1"}}
	h.xray.counters = []protocol.AbsoluteCounter{{Email: "a@example.com", UplinkBytes: "10", DownlinkBytes: "0"}}
	h.api.config = protocol.ConfigSnapshot{NodeID: "node-1", Revision: "8", ControlMode: protocol.ModeDirectPrimary}
	runner := h.build(t)

	if _, err := runner.refreshConfig(context.Background()); err != nil {
		t.Fatal(err)
	}
	calls := h.xray.log()
	if indexOf(t, calls, "counters") > indexOf(t, calls, "remove:a@example.com") {
		t.Fatalf("必须先采样再卸载，实际调用 %v", calls)
	}
}

// TestAnUnmeterableRemovalIsRefusedRatherThanApplied. The failure is not
// swallowed: refusing the whole refresh keeps the user — and their counters — in
// place until metering works again, which is the direction that loses nobody's
// money.
func TestAnUnmeterableRemovalIsRefusedRatherThanApplied(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "7", protocol.ModeDirectPrimary, user("b1", "a@example.com", "7", true, "1000"))
	h.xray.live = []xray.LiveUser{{Email: "a@example.com", UUID: "uuid-b1"}}
	h.xray.countersErr = errors.New("统计接口不可用")
	h.api.config = protocol.ConfigSnapshot{NodeID: "node-1", Revision: "8", ControlMode: protocol.ModeDirectPrimary}
	runner := h.build(t)

	if _, err := runner.refreshConfig(context.Background()); err == nil {
		t.Fatal("无法采样时不能应用会删掉用户的快照")
	}
	if contains(h.xray.log(), "remove:a@example.com") {
		t.Fatalf("用户不应被卸载，实际调用 %v", h.xray.log())
	}
	stored, err := h.store.UserByBindingID("b1")
	if err != nil || stored == nil {
		t.Fatalf("本地记录也不应被抹掉：%v", err)
	}
}

// TestASnapshotCannotReviveAUserThisNodeDisabledWhileBatchesArePending. The
// local disable was made on evidence the control plane has not seen yet — it is
// sitting in the unflushed queue. Taking the snapshot at face value would serve
// traffic nobody is paying for until those batches land.
func TestASnapshotCannotReviveAUserThisNodeDisabledWhileBatchesArePending(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "7", protocol.ModeDirectPrimary, user("b1", "a@example.com", "7", true, "0"))
	h.xray.live = []xray.LiveUser{{Email: "a@example.com", UUID: "uuid-b1"}}
	h.xray.counters = []protocol.AbsoluteCounter{{Email: "a@example.com", UplinkBytes: "10", DownlinkBytes: "0"}}
	runner := h.build(t)

	// A sample exhausts the quota and queues the batch that proves it.
	if err := runner.sample(context.Background()); err != nil {
		t.Fatal(err)
	}
	pending, err := h.store.PendingBatchCount()
	if err != nil || pending == 0 {
		t.Fatalf("这一步应该留下待上报批次：%d %v", pending, err)
	}

	// The control plane still thinks the user is fine.
	h.api.config = protocol.ConfigSnapshot{
		NodeID: "node-1", Revision: "8", ControlMode: protocol.ModeDirectPrimary,
		Users: []protocol.DesiredUser{user("b1", "a@example.com", "8", true, "1000")},
	}
	if _, err := runner.refreshConfig(context.Background()); err != nil {
		t.Fatal(err)
	}
	stored, err := h.store.UserByBindingID("b1")
	if err != nil {
		t.Fatal(err)
	}
	if stored.Enabled {
		t.Fatal("批次尚未上报时，快照不能把本节点停用的用户重新启用")
	}
}

// TestDrainingTheQueueRestoresBackendConfirmedUsers is the release valve for the
// test above: once the backend has seen every byte this node metered, its answer
// about the quota is authoritative and the user comes back.
func TestDrainingTheQueueRestoresBackendConfirmedUsers(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "7", protocol.ModeDirectPrimary, user("b1", "a@example.com", "7", true, "0"))
	h.xray.live = []xray.LiveUser{{Email: "a@example.com", UUID: "uuid-b1"}}
	h.xray.counters = []protocol.AbsoluteCounter{{Email: "a@example.com", UplinkBytes: "10", DownlinkBytes: "0"}}
	runner := h.build(t)
	if err := runner.sample(context.Background()); err != nil {
		t.Fatal(err)
	}

	h.api.config = protocol.ConfigSnapshot{
		NodeID: "node-1", Revision: "8", ControlMode: protocol.ModeDirectPrimary,
		Users: []protocol.DesiredUser{user("b1", "a@example.com", "8", true, "5000")},
	}
	if err := runner.flushBatches(context.Background()); err != nil {
		t.Fatal(err)
	}
	if left, err := h.store.PendingBatchCount(); err != nil || left != 0 {
		t.Fatalf("批次应已全部上报：%d %v", left, err)
	}
	stored, err := h.store.UserByBindingID("b1")
	if err != nil {
		t.Fatal(err)
	}
	if !stored.Enabled {
		t.Fatal("队列清空后，后台确认的额度应让用户恢复")
	}
	if !contains(h.xray.log(), "ensure:a@example.com") {
		t.Fatalf("恢复后应把用户装回 Xray，实际调用 %v", h.xray.log())
	}
}

// TestAnOlderSnapshotDoesNotUndoWhatThisNodeHasApplied.
func TestAnOlderSnapshotDoesNotUndoWhatThisNodeHasApplied(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "9", protocol.ModeDirectPrimary, user("b1", "a@example.com", "9", true, "1000"))
	h.api.config = protocol.ConfigSnapshot{NodeID: "node-1", Revision: "4", ControlMode: protocol.ModeDirectPrimary}
	runner := h.build(t)

	applied, err := runner.refreshConfig(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if applied.Revision != "9" {
		t.Fatalf("过期快照不应被采纳，应返回本地的 revision 9，实际 %q", applied.Revision)
	}
	if len(applied.Users) != 1 {
		t.Fatalf("本地用户不应被过期快照清空，实际 %d 个", len(applied.Users))
	}
}

// --- metering -----------------------------------------------------------------

// TestQuotaExhaustionUninstallsTheAccount.
func TestQuotaExhaustionUninstallsTheAccount(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "7", protocol.ModeDirectPrimary, user("b1", "a@example.com", "7", true, "0"))
	h.xray.live = []xray.LiveUser{{Email: "a@example.com", UUID: "uuid-b1"}}
	h.xray.counters = []protocol.AbsoluteCounter{{Email: "a@example.com", UplinkBytes: "10", DownlinkBytes: "0"}}
	runner := h.build(t)
	// The account is this node's: record the provisioning evidence the ownership
	// check reads.
	if err := h.store.RecordProvisioned("b1", "a@example.com", "uuid-b1"); err != nil {
		t.Fatal(err)
	}

	if err := runner.sample(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !contains(h.xray.log(), "remove:a@example.com") {
		t.Fatalf("额度耗尽后应卸载账号，实际调用 %v", h.xray.log())
	}
}

// TestAnObservingNodeDoesNotTouchXrayWhenQuotaRunsOut. Only direct_primary may
// write, and the mode gate is checked per tick rather than once at startup.
func TestAnObservingNodeDoesNotTouchXrayWhenQuotaRunsOut(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "7", protocol.ModeShadowDirect, user("b1", "a@example.com", "7", true, "0"))
	h.xray.live = []xray.LiveUser{{Email: "a@example.com", UUID: "uuid-b1"}}
	h.xray.counters = []protocol.AbsoluteCounter{{Email: "a@example.com", UplinkBytes: "10", DownlinkBytes: "0"}}
	runner := h.build(t)
	if err := h.store.RecordProvisioned("b1", "a@example.com", "uuid-b1"); err != nil {
		t.Fatal(err)
	}

	if err := runner.sample(context.Background()); err != nil {
		t.Fatal(err)
	}
	if contains(h.xray.log(), "remove:a@example.com") {
		t.Fatalf("观察模式不得写 Xray，实际调用 %v", h.xray.log())
	}
	stored, err := h.store.UserByBindingID("b1")
	if err != nil {
		t.Fatal(err)
	}
	if stored.Enabled {
		t.Fatal("本地记账仍然要停用该用户")
	}
}

// TestAStoreFailureIsNotReportedAsXrayBeingDown. xrayStatus is what the control
// plane uses to decide whether a node can serve; answering "offline" for a local
// database problem sends an operator to the wrong host.
func TestAStoreFailureIsNotReportedAsXrayBeingDown(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "7", protocol.ModeDirectPrimary, user("b1", "a@example.com", "7", true, "1000"))
	// A counter the decimal guard rejects: the read succeeded, the fold fails.
	h.xray.counters = []protocol.AbsoluteCounter{{Email: "a@example.com", UplinkBytes: "-1", DownlinkBytes: "0"}}
	runner := h.build(t)

	if err := runner.sample(context.Background()); err == nil {
		t.Fatal("非法计数必须上报为错误")
	}
	runner.state.Lock()
	healthy := runner.xrayHealthy
	runner.state.Unlock()
	if !healthy {
		t.Fatal("本地状态库的问题不能被上报成 Xray 掉线")
	}
}

// --- heartbeat -----------------------------------------------------------------

// TestTheHeartbeatCarriesTheQueueDepthAndAcksIt.
func TestTheHeartbeatCarriesTheQueueDepthAndAcksIt(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "7", protocol.ModeDirectPrimary, user("b1", "a@example.com", "7", true, "1000"))
	h.xray.counters = []protocol.AbsoluteCounter{{Email: "a@example.com", UplinkBytes: "10", DownlinkBytes: "0"}}
	runner := h.build(t)
	if err := runner.sample(context.Background()); err != nil {
		t.Fatal(err)
	}

	h.api.heartbeatAck = protocol.HeartbeatAck{Accepted: true, AckThrough: "1", ConfigRevision: "7"}
	if err := runner.sendHeartbeat(context.Background()); err != nil {
		t.Fatal(err)
	}
	beat := h.api.heartbeats[0]
	if beat.QueueDepth != 1 {
		t.Fatalf("心跳应带上待上报批次数 1，实际 %d", beat.QueueDepth)
	}
	if beat.BootID != bootID || beat.ConfigRevision != "7" {
		t.Fatalf("心跳字段不对：%+v", beat)
	}
	if left, err := h.store.PendingBatchCount(); err != nil || left != 0 {
		t.Fatalf("心跳的 ack 应清掉已结算批次：%d %v", left, err)
	}
}

// TestAnObservingNodeLearnsAboutConfigChangesFromTheHeartbeat. A shadow node
// receives no commands, so the ack is the only place it hears that the desired
// state moved.
func TestAnObservingNodeLearnsAboutConfigChangesFromTheHeartbeat(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "7", protocol.ModeShadowDirect)
	h.api.heartbeatAck = protocol.HeartbeatAck{Accepted: true, AckThrough: "0", ConfigRevision: "9"}
	h.api.config = protocol.ConfigSnapshot{
		NodeID: "node-1", Revision: "9", ControlMode: protocol.ModeShadowDirect,
		Users: []protocol.DesiredUser{user("b1", "a@example.com", "9", true, "1000")},
	}
	runner := h.build(t)

	if err := runner.sendHeartbeat(context.Background()); err != nil {
		t.Fatal(err)
	}
	revision, err := h.store.ConfigRevision()
	if err != nil {
		t.Fatal(err)
	}
	if revision != "9" {
		t.Fatalf("观察节点应据 ack 拉取新配置，实际 revision %q", revision)
	}
}

// TestADirectNodeIgnoresTheAckRevision: it gets its instructions as commands, and
// an extra refresh on every heartbeat would race them.
func TestADirectNodeIgnoresTheAckRevision(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "7", protocol.ModeDirectPrimary)
	h.api.heartbeatAck = protocol.HeartbeatAck{Accepted: true, AckThrough: "0", ConfigRevision: "9"}
	runner := h.build(t)

	if err := runner.sendHeartbeat(context.Background()); err != nil {
		t.Fatal(err)
	}
	if h.api.configs != 0 {
		t.Fatalf("direct_primary 不应因心跳 ack 去拉配置，实际拉了 %d 次", h.api.configs)
	}
}

// TestAMalformedAckRevisionDoesNotFailTheHeartbeat. It is the control plane's
// field; refusing the heartbeat over it would take the node offline for a
// cosmetic problem.
func TestAMalformedAckRevisionDoesNotFailTheHeartbeat(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "7", protocol.ModeShadowDirect)
	h.api.heartbeatAck = protocol.HeartbeatAck{Accepted: true, AckThrough: "0", ConfigRevision: "不是数字"}
	runner := h.build(t)

	if err := runner.sendHeartbeat(context.Background()); err != nil {
		t.Fatalf("ack 里的非法 revision 不应让心跳失败：%v", err)
	}
}

// --- metering upload -------------------------------------------------------------

// TestAFailedUploadStopsTheQueueWhereItIs. Batches are ordered and the server's
// contiguity check depends on it, so skipping past a failure would break the
// sequence for every batch behind it.
func TestAFailedUploadStopsTheQueueWhereItIs(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "7", protocol.ModeDirectPrimary, user("b1", "a@example.com", "7", true, "5000"))
	runner := h.build(t)
	for index, reading := range []string{"10", "20"} {
		h.xray.counters = []protocol.AbsoluteCounter{{Email: "a@example.com", UplinkBytes: reading, DownlinkBytes: "0"}}
		if err := runner.sample(context.Background()); err != nil {
			t.Fatalf("第 %d 次采样失败：%v", index, err)
		}
	}
	if pending, err := h.store.PendingBatchCount(); err != nil || pending != 2 {
		t.Fatalf("应有两个待上报批次：%d %v", pending, err)
	}

	h.api.uploadErr = errors.New("控制面 502")
	if err := runner.flushBatches(context.Background()); err == nil {
		t.Fatal("上传失败必须上报")
	}
	if pending, err := h.store.PendingBatchCount(); err != nil || pending != 2 {
		t.Fatalf("上传失败时批次必须原样保留：%d %v", pending, err)
	}
	runner.state.Lock()
	online := runner.backendOnline
	runner.state.Unlock()
	if online {
		t.Fatal("上传失败后必须标记后台离线，否则离线额度不会开始计")
	}

	h.api.uploadErr = nil
	if err := runner.flushBatches(context.Background()); err != nil {
		t.Fatal(err)
	}
	if pending, err := h.store.PendingBatchCount(); err != nil || pending != 0 {
		t.Fatalf("恢复后应清空队列：%d %v", pending, err)
	}
}

// --- commands ---------------------------------------------------------------------

func commandOf(id string, kind protocol.CommandType, revision string, payload map[string]any) protocol.Command {
	return protocol.Command{CommandID: id, Type: kind, TargetRevision: revision, Payload: payload}
}

// TestAReconcileCommandGrantsTheDirectTrackBeforeItRuns. The grant and the users
// it authorises arrive together; deferring to the caller's stale view of the
// mode would skip the installation and still report the handover as done.
func TestAReconcileCommandGrantsTheDirectTrackBeforeItRuns(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "7", protocol.ModeShadowDirect)
	runner := h.build(t)

	result, err := runner.execute(context.Background(), commandOf("c1", protocol.CommandReconcileUsers, "8", map[string]any{
		"controlMode": string(protocol.ModeDirectPrimary),
		"users": []any{map[string]any{
			"bindingId": "b1", "email": "a@example.com", "uuid": "uuid-b1",
			"flow": protocol.FlowVision, "enabled": true, "quotaRemainingBytes": "1000",
		}},
	}))
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != protocol.StatusCompleted {
		t.Fatalf("命令应成功，实际 %+v", result)
	}
	if !contains(h.xray.log(), "ensure:a@example.com") {
		t.Fatalf("晋升命令必须真的把用户装上，实际调用 %v", h.xray.log())
	}
}

// TestAReplayedHandoverGrantsNothing: an older revision is a replay, and adopting
// its mode would hand write access back to a node the control plane has since
// demoted.
func TestAReplayedHandoverGrantsNothing(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "9", protocol.ModeShadowDirect)
	runner := h.build(t)

	result, err := runner.execute(context.Background(), commandOf("c1", protocol.CommandReconcileUsers, "4", map[string]any{
		"controlMode": string(protocol.ModeDirectPrimary),
	}))
	if err != nil || result.Status != protocol.StatusFailed {
		t.Fatalf("stale handover: %+v %v", result, err)
	}
	mode := runner.current.ControlMode
	if mode != protocol.ModeShadowDirect {
		t.Fatalf("过期命令不能授予写权限，实际模式 %q", mode)
	}
}

// TestAnUnknownControlModeIsLeftToTheProcessor. Adopting it here would be worse
// than useless: the store falls back to shadow_direct on an unrecognised value,
// so a newer control plane's vocabulary would silently DEMOTE the node instead of
// failing loudly.
func TestAnUnknownControlModeIsLeftToTheProcessor(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "7", protocol.ModeDirectPrimary)
	runner := h.build(t)

	result, err := runner.execute(context.Background(), commandOf("c1", protocol.CommandReconcileUsers, "8", map[string]any{
		"controlMode": "quantum_primary",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != protocol.StatusFailed {
		t.Fatalf("无法识别的模式必须失败，实际 %+v", result)
	}
	runner.state.Lock()
	mode := runner.current.ControlMode
	runner.state.Unlock()
	if mode != protocol.ModeDirectPrimary {
		t.Fatalf("失败的命令不应改变本节点的模式，实际 %q", mode)
	}
}

// TestATerminalCommandIsMeteredBeforeItRuns. The account is about to go away and
// its counters with it.
func TestATerminalCommandIsMeteredBeforeItRuns(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "7", protocol.ModeDirectPrimary, user("b1", "a@example.com", "7", true, "5000"))
	h.xray.live = []xray.LiveUser{{Email: "a@example.com", UUID: "uuid-b1"}}
	h.xray.counters = []protocol.AbsoluteCounter{{Email: "a@example.com", UplinkBytes: "10", DownlinkBytes: "0"}}
	runner := h.build(t)
	if err := h.store.RecordProvisioned("b1", "a@example.com", "uuid-b1"); err != nil {
		t.Fatal(err)
	}

	result, err := runner.execute(context.Background(), commandOf("c1", protocol.CommandRemoveUser, "8", map[string]any{
		"bindingId": "b1",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != protocol.StatusCompleted {
		t.Fatalf("删除应成功，实际 %+v", result)
	}
	calls := h.xray.log()
	if indexOf(t, calls, "counters") > indexOf(t, calls, "remove:a@example.com") {
		t.Fatalf("必须先采样再卸载，实际调用 %v", calls)
	}
	if _, present := result.Result["disableWatermarks"]; !present {
		t.Fatalf("终态命令必须带上本地队列水位线，实际 %+v", result.Result)
	}
}

// TestATerminalCommandThatCannotBeMeteredIsReportedFailed is a deliberate
// departure from the Node agent, whose uncaught throw tore down the SSE
// connection: the control plane then saw the stream drop for a reason it could
// not read, and every OTHER command queued behind it went with it.
func TestATerminalCommandThatCannotBeMeteredIsReportedFailed(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "7", protocol.ModeDirectPrimary, user("b1", "a@example.com", "7", true, "5000"))
	h.xray.live = []xray.LiveUser{{Email: "a@example.com", UUID: "uuid-b1"}}
	h.xray.countersErr = errors.New("统计接口不可用")
	runner := h.build(t)

	result, err := runner.execute(context.Background(), commandOf("c1", protocol.CommandRemoveUser, "8", map[string]any{
		"bindingId": "b1",
	}))
	if err != nil {
		t.Fatalf("采样失败不应把错误抛回命令流：%v", err)
	}
	if result.Status != protocol.StatusFailed {
		t.Fatalf("应报告为失败，实际 %+v", result)
	}
	if !strings.Contains(result.Error, "漏计") {
		t.Fatalf("失败原因应说明为什么拒绝，实际 %q", result.Error)
	}
	if contains(h.xray.log(), "remove:a@example.com") {
		t.Fatalf("拒绝执行时不得卸载账号，实际调用 %v", h.xray.log())
	}
	stored, err := h.store.UserByBindingID("b1")
	if err != nil || stored == nil {
		t.Fatalf("本地记录也应保留：%v", err)
	}
}

// TestACommandResultIsReportedBack.
func TestACommandResultIsReportedBack(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "7", protocol.ModeDirectPrimary, user("b1", "a@example.com", "7", true, "5000"))
	runner := h.build(t)

	if err := runner.handleCommand(context.Background(), commandOf("c1", protocol.CommandRefreshQuota, "8", map[string]any{
		"bindingId": "b1", "quotaRemainingBytes": "9000",
	})); err != nil {
		t.Fatal(err)
	}
	reported := h.api.results()
	if len(reported) != 1 || reported[0].CommandID != "c1" || reported[0].Status != protocol.StatusCompleted {
		t.Fatalf("命令结果应回报，实际 %+v", reported)
	}
}

// --- the loop itself --------------------------------------------------------------

// TestTheEventsLoopReconnectsAfterTheStreamEnds, and paces itself while doing
// it. A control plane that accepts the connection and closes it immediately — a
// proxy with no upstream, a rolling restart — must not be spun against as fast
// as the network allows.
func TestTheEventsLoopReconnectsAfterTheStreamEnds(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "7", protocol.ModeDirectPrimary)
	h.api.config = protocol.ConfigSnapshot{NodeID: "node-1", Revision: "7", ControlMode: protocol.ModeDirectPrimary}
	h.api.streamErr = errors.New("流被关闭")
	runner := h.build(t)

	ctx, cancel := context.WithTimeout(context.Background(), 3*ReconnectDelay+ReconnectDelay/2)
	defer cancel()
	runner.eventsLoop(ctx)

	h.api.mu.Lock()
	streams := h.api.streams
	h.api.mu.Unlock()
	if streams < 2 {
		t.Fatalf("流结束后应重连，实际只连接了 %d 次", streams)
	}
	// Roughly one connection per ReconnectDelay. A loop with no pacing would run
	// through hundreds in the same window.
	if streams > 6 {
		t.Fatalf("重连没有节流，%v 内连了 %d 次", 3*ReconnectDelay, streams)
	}
}

// TestRunTakesAFinalSampleOnTheWayOut. The traffic since the last tick is real
// money and it lives only in Xray's in-memory counters.
func TestRunTakesAFinalSampleOnTheWayOut(t *testing.T) {
	h := newHarness(t)
	u := user("b1", "a@example.com", "7", true, "5000")
	h.seed(t, "7", protocol.ModeDirectPrimary, u)
	h.api.config = protocol.ConfigSnapshot{NodeID: "node-1", Revision: "7", ControlMode: protocol.ModeDirectPrimary, Users: []protocol.DesiredUser{u}}
	h.xray.counters = []protocol.AbsoluteCounter{{Email: u.Email, UplinkBytes: "10", DownlinkBytes: "0"}}
	r := h.build(t)
	// No periodic sample can run. Only shutdown can produce this batch.
	r.deps.Config.SampleInterval = time.Hour
	r.deps.Config.HeartbeatInterval = time.Hour
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := r.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if len(h.api.uploaded) != 1 {
		t.Fatalf("final sample not uploaded: %v", h.api.uploaded)
	}
}

func TestForeignSnapshotCannotTouchXray(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "7", protocol.ModeDirectPrimary, user("b1", "a@example.com", "7", true, "1000"))
	h.api.config = protocol.ConfigSnapshot{NodeID: "foreign", Revision: "8", ControlMode: protocol.ModeDirectPrimary}
	r := h.build(t)
	if _, err := r.refreshConfig(context.Background()); err == nil {
		t.Fatal("accepted foreign snapshot")
	}
	if len(h.xray.log()) != 0 {
		t.Fatalf("touched Xray before validation: %v", h.xray.log())
	}
}

func TestRefreshKeepsNewerBindingDisabled(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "9", protocol.ModeDirectPrimary, user("b1", "a@example.com", "9", false, "1000"))
	h.api.config = protocol.ConfigSnapshot{NodeID: "node-1", Revision: "10", ControlMode: protocol.ModeDirectPrimary,
		Users: []protocol.DesiredUser{user("b1", "a@example.com", "7", true, "1000")}}
	r := h.build(t)
	if _, err := r.refreshConfig(context.Background()); err != nil {
		t.Fatal(err)
	}
	if contains(h.xray.log(), "ensure:a@example.com") {
		t.Fatal("stale binding reinstalled")
	}
}

func TestRefreshAfterSamplingKeepsNewlyExhaustedUsersDisabled(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "7", protocol.ModeDirectPrimary, user("a", "a@example.com", "7", true, "1000"), user("b", "b@example.com", "7", true, "10"))
	r := h.build(t)
	h.xray.counters = []protocol.AbsoluteCounter{{Email: "b@example.com", UplinkBytes: "0", DownlinkBytes: "0"}}
	if err := r.sample(context.Background()); err != nil {
		t.Fatal(err)
	}
	h.xray.counters[0].UplinkBytes = "20"
	h.api.config = protocol.ConfigSnapshot{NodeID: "node-1", Revision: "8", ControlMode: protocol.ModeDirectPrimary,
		Users: []protocol.DesiredUser{user("b", "b@example.com", "8", true, "1000")}}
	if _, err := r.refreshConfig(context.Background()); err != nil {
		t.Fatal(err)
	}
	stored, err := h.store.UserByBindingID("b")
	if err != nil || stored.Enabled || stored.QuotaRemainingBytes != "0" {
		t.Fatalf("lost local cutoff: %+v %v", stored, err)
	}
}

func TestRejectedAcksKeepBatches(t *testing.T) {
	for _, via := range []string{"heartbeat", "upload"} {
		t.Run(via, func(t *testing.T) {
			h := newHarness(t)
			h.seed(t, "7", protocol.ModeShadowDirect, user("b1", "a@example.com", "7", true, "1000"))
			r := h.build(t)
			h.xray.counters = []protocol.AbsoluteCounter{{Email: "a@example.com", UplinkBytes: "0", DownlinkBytes: "0"}}
			if err := r.sample(context.Background()); err != nil {
				t.Fatal(err)
			}
			h.api.heartbeatAck = protocol.HeartbeatAck{Accepted: false, AckThrough: "1"}
			h.api.uploadAck = protocol.UsageBatchAck{Accepted: false, AckThrough: "1"}
			var err error
			if via == "heartbeat" {
				err = r.sendHeartbeat(context.Background())
			} else {
				err = r.flushBatches(context.Background())
			}
			if err == nil {
				t.Fatal("negative ack accepted")
			}
			if n, _ := h.store.PendingBatchCount(); n != 1 {
				t.Fatalf("lost batch: %d", n)
			}
		})
	}
}

func TestCompletedTerminalReplayDoesNotNeedXray(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "7", protocol.ModeDirectPrimary, user("b1", "a@example.com", "7", true, "1000"))
	r := h.build(t)
	cmd := commandOf("c1", protocol.CommandRemoveUser, "8", map[string]any{"bindingId": "b1"})
	first, err := r.execute(context.Background(), cmd)
	if err != nil || first.Status != protocol.StatusCompleted {
		t.Fatalf("first: %+v %v", first, err)
	}
	h.xray.healthErr = errors.New("down")
	second, err := r.execute(context.Background(), cmd)
	if err != nil || second.Status != protocol.StatusCompleted {
		t.Fatalf("replay: %+v %v", second, err)
	}
	if _, ok := second.Result["disableWatermarks"]; !ok {
		t.Fatal("lost persisted watermarks")
	}
}

type blockedAPI struct {
	*fakeAPI
	entered chan struct{}
	release chan struct{}
}

func (a *blockedAPI) Heartbeat(ctx context.Context, p protocol.Heartbeat) (protocol.HeartbeatAck, error) {
	close(a.entered)
	select {
	case <-ctx.Done():
		return protocol.HeartbeatAck{}, ctx.Err()
	case <-a.release:
	}
	return a.fakeAPI.Heartbeat(ctx, p)
}

func TestBlockedHeartbeatDoesNotBlockSampling(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "7", protocol.ModeShadowDirect, user("b1", "a@example.com", "7", true, "1000"))
	r := h.build(t)
	a := &blockedAPI{fakeAPI: h.api, entered: make(chan struct{}), release: make(chan struct{})}
	r.deps.API = a
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	beat := make(chan error, 1)
	go func() { beat <- r.sendHeartbeat(ctx) }()
	<-a.entered
	done := make(chan error, 1)
	go func() { done <- r.sample(ctx) }()
	select {
	case err := <-done:
		if err != nil {
			t.Error(err)
		}
	case <-ctx.Done():
		t.Error("network call held state lock")
	}
	close(a.release)
	<-beat
}

func TestOfflineCutoffRecoversAtSameRevisionAfterHeartbeatAck(t *testing.T) {
	h := newHarness(t)
	u := user("b1", "a@example.com", "7", true, "1000")
	u.OfflineAllowanceBytes = "10"
	h.seed(t, "7", protocol.ModeDirectPrimary, u)
	h.api.config = protocol.ConfigSnapshot{NodeID: "node-1", Revision: "7", ControlMode: protocol.ModeDirectPrimary, Users: []protocol.DesiredUser{u}}
	r := h.build(t)
	h.xray.counters = []protocol.AbsoluteCounter{{Email: u.Email, UplinkBytes: "0", DownlinkBytes: "0"}}
	if err := r.sample(context.Background()); err != nil {
		t.Fatal(err)
	}
	h.xray.counters[0].UplinkBytes = "20"
	if err := r.sample(context.Background()); err != nil {
		t.Fatal(err)
	}
	h.api.heartbeatAck = protocol.HeartbeatAck{Accepted: true, AckThrough: "2", ConfigRevision: "7"}
	if err := r.sendHeartbeat(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := r.flushBatches(context.Background()); err != nil {
		t.Fatal(err)
	}
	stored, err := h.store.UserByBindingID("b1")
	if err != nil || !stored.Enabled || stored.QuotaRemainingBytes != "980" {
		t.Fatalf("recovery: %+v %v", stored, err)
	}
	live, _ := h.xray.ListUsers(context.Background())
	if len(live) != 1 {
		t.Fatal("restored store without reinstall")
	}
}

func TestSSEReconcileMetersRemovalAndPreservesLocalCutoff(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "7", protocol.ModeDirectPrimary, user("a", "a@example.com", "7", true, "1000"), user("b", "b@example.com", "7", true, "10"))
	r := h.build(t)
	h.xray.counters = []protocol.AbsoluteCounter{{Email: "b@example.com", UplinkBytes: "0", DownlinkBytes: "0"}}
	if err := r.sample(context.Background()); err != nil {
		t.Fatal(err)
	}
	h.xray.counters[0].UplinkBytes = "20"
	result, err := r.execute(context.Background(), commandOf("c1", protocol.CommandReconcileUsers, "8", map[string]any{
		"controlMode": string(protocol.ModeDirectPrimary), "users": []any{map[string]any{
			"bindingId": "b", "email": "b@example.com", "uuid": "uuid-b", "revision": "8", "enabled": true, "flow": protocol.FlowVision, "quotaRemainingBytes": "1000",
		}},
	}))
	if err != nil || result.Status != protocol.StatusCompleted {
		t.Fatalf("reconcile: %+v %v", result, err)
	}
	stored, err := h.store.UserByBindingID("b")
	if err != nil || stored.Enabled || stored.QuotaRemainingBytes != "0" {
		t.Fatalf("SSE bypassed cutoff: %+v %v", stored, err)
	}
}
