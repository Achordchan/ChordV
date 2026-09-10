// Package runner is the agent's main loop: the thing that turns a store, an API
// client and an Xray adapter into a running service.
//
// It is a port of apps/node-agent/src/runner.ts minus everything about inbound
// ownership — under B1 the inbound belongs to the 3x-ui panel (PRD §3.1), so the
// deployment helper, the foreign-inbound probe and the "no tag to provision
// into" deferral all disappear with it.
//
// # Concurrency
//
// The Node agent got serialisation for free: one thread, and a promise chain
// (`withStateMutation`) to keep multi-await sequences atomic. Go does not, and
// the store is explicitly not safe for concurrent use — its connection pool is
// capped at one, so a concurrent read-modify-write would not crash, it would
// silently interleave.
//
// So there is ONE mutex, and it covers both the store and every field below.
// The rule that makes it workable, and the one to keep when editing:
//
//	the lock MAY be held across Xray calls — loopback gRPC, bounded, and the
//	mutation it protects is meaningless without them;
//	the lock MUST NOT be held across a control-plane call — those have a 15s
//	timeout and an SSE stream has none at all.
//
// Every loop below is therefore shaped the same way: lock, decide; unlock, talk
// to the control plane; lock, apply the answer.
package runner

import (
	"context"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/Achordchan/ChordV/apps/agent/internal/agentcfg"
	"github.com/Achordchan/ChordV/apps/agent/internal/commands"
	"github.com/Achordchan/ChordV/apps/agent/internal/decimal"
	"github.com/Achordchan/ChordV/apps/agent/internal/protocol"
	"github.com/Achordchan/ChordV/apps/agent/internal/store"
	"github.com/Achordchan/ChordV/apps/agent/internal/version"
	"github.com/Achordchan/ChordV/apps/agent/internal/xray"
)

// ControlPlane is the half of apiclient.Client the runner uses. It is an
// interface so the loop can be tested without an HTTP server — the failure modes
// worth testing here (backend down mid-batch, a stream that ends, an ack that
// moves the watermark) are tedious to provoke through a real one.
type ControlPlane interface {
	GetConfig(ctx context.Context) (protocol.ConfigSnapshot, error)
	Heartbeat(ctx context.Context, payload protocol.Heartbeat) (protocol.HeartbeatAck, error)
	UploadBatch(ctx context.Context, batch protocol.UsageBatch) (protocol.UsageBatchAck, error)
	ReportCommandResult(ctx context.Context, result protocol.CommandResult) error
	ConsumeEvents(ctx context.Context, onCommand func(protocol.Command) error) error
}

// Intervals the operator does not configure.
const (
	// FlushInterval is the Node agent's, and it is deliberately short: a batch
	// sitting in the local queue is traffic the control plane cannot bill yet.
	FlushInterval = time.Second
	// ReconnectDelay paces the events loop after the stream ends, for ANY
	// reason. The Node agent delayed only after an error, so a control plane
	// that accepts the connection and closes it immediately — a proxy with no
	// upstream, a rolling restart — span the loop as fast as the network
	// allowed. One node doing that is a nuisance; a fleet doing it is an
	// accidental flood at exactly the moment the control plane is weakest.
	ReconnectDelay = 2 * time.Second
	// ShutdownTimeout bounds the last sample and flush. The context that ran the
	// loop is already cancelled by then, so this work needs one of its own — and
	// it must be bounded, or a hung control plane would keep the process alive
	// past whatever patience systemd has before SIGKILL.
	ShutdownTimeout = 10 * time.Second
	// MaxUptimeSeconds guards the restart estimate's arithmetic. An adapter that
	// reported a nonsense uptime would otherwise overflow the multiplication into
	// a NEGATIVE duration and move the estimated start forward by centuries,
	// which reads as "restarted" on every single sample.
	MaxUptimeSeconds = int64(100 * 365 * 24 * time.Hour / time.Second)
)

// Deps are the collaborators one runner needs.
type Deps struct {
	Config   *agentcfg.Config
	Store    *store.Store
	API      ControlPlane
	Xray     xray.Adapter
	Commands *commands.Processor
	// BootID identifies this process to the control plane and keys the metering
	// sequence. It must be the same value the store was opened with.
	BootID string
	// Logf and Errorf receive operator-facing notices; nil means stderr.
	Logf   func(format string, args ...any)
	Errorf func(format string, args ...any)
	// Now is injectable so a test can drive the Xray restart estimate.
	Now func() time.Time
}

// Runner owns the loop. Create it with New and drive it with Run.
type Runner struct {
	deps Deps

	// state guards the store and every field below it. See the package comment.
	state sync.Mutex
	// The server owns one boot watermark. Serialize boot-bearing requests,
	// independently of state so a slow backend never blocks sampling.
	transport sync.Mutex
	// current is the runner's view of what this node should be serving. It is a
	// cache of the store's, kept because the mode gate is consulted on paths
	// that must not re-read the database, and refreshed from the store after
	// anything that could have changed it.
	current protocol.ConfigSnapshot
	// backendOnline decides how a metering tick treats the offline allowance, so
	// it means "the control plane answered", not "we would like it to".
	backendOnline bool
	xrayHealthy   bool
	// lastXrayStart is the ESTIMATED wall-clock start of the Xray process, from
	// its reported uptime. Zero until the first reading.
	lastXrayStart time.Time
	// reconcilePending survives a failed recovery attempt. A HandlerService call
	// can fail while Xray is still initialising, and by then the health flag and
	// the uptime baseline have both moved on — nothing would retry, and the node
	// would serve nobody until its next restart. So the intent stays set until a
	// reconcile actually completes.
	reconcilePending bool
	// Incremented only when an acknowledgement removes durable batches. A GET
	// started before that settlement cannot release the corresponding cutoff.
	settlementEpoch uint64
	// Retry a failed reconnect refresh from heartbeats even while SSE stays open.
	refreshPending bool
}

// New builds a runner and seeds it with what the store already believes.
func New(deps Deps) (*Runner, error) {
	if deps.Config == nil || deps.Store == nil || deps.API == nil || deps.Xray == nil || deps.Commands == nil || deps.BootID == "" {
		return nil, fmt.Errorf("runner 缺少必要依赖或 bootId")
	}
	if deps.Config.SampleInterval <= 0 || deps.Config.HeartbeatInterval <= 0 {
		return nil, fmt.Errorf("runner 定时间隔必须大于零")
	}
	if deps.Now == nil {
		deps.Now = time.Now
	}
	if deps.Logf == nil {
		deps.Logf = func(format string, args ...any) {
			fmt.Fprintf(os.Stderr, "[node-agent] "+format+"\n", args...)
		}
	}
	if deps.Errorf == nil {
		deps.Errorf = deps.Logf
	}
	snapshot, err := deps.Store.ConfigSnapshot()
	if err != nil {
		return nil, err
	}
	return &Runner{deps: deps, current: snapshot}, nil
}

func (r *Runner) logf(format string, args ...any)   { r.deps.Logf(format, args...) }
func (r *Runner) errorf(format string, args ...any) { r.deps.Errorf(format, args...) }

// Run starts the loop and returns when ctx is cancelled, having taken a final
// sample and flushed what it could. A non-nil error means the agent could not
// start at all.
func (r *Runner) Run(ctx context.Context) error {
	if err := r.start(ctx); err != nil {
		return err
	}
	var group sync.WaitGroup
	r.every(ctx, &group, r.deps.Config.SampleInterval, "计量采样", r.sample)
	r.every(ctx, &group, FlushInterval, "计量上报", r.flushBatches)
	r.every(ctx, &group, r.deps.Config.HeartbeatInterval, "心跳", r.sendHeartbeat)
	group.Add(1)
	go func() {
		defer group.Done()
		r.eventsLoop(ctx)
	}()
	<-ctx.Done()
	group.Wait()
	r.shutdown()
	return nil
}

// start is everything that must happen before the periodic work begins.
func (r *Runner) start(ctx context.Context) error {
	if _, err := r.refreshConfig(ctx); err != nil {
		r.state.Lock()
		revision := r.current.Revision
		r.state.Unlock()
		// A node that has never received a snapshot has nothing to serve and no
		// way to find out what it should be serving. Anything else can run on
		// what it already knows: an agent that refuses to start while the control
		// plane is down would take every node offline with it.
		if revision == "0" {
			return fmt.Errorf("首次启动无法获取配置，且本机没有可用的历史配置: %w", err)
		}
		r.errorf("后台暂不可用，使用 revision %s 的本地配置启动：%v", revision, err)
	}

	r.state.Lock()
	defer r.state.Unlock()
	// A DOWN Xray is not a startup failure, and this is a deliberate departure
	// from the Node agent, which threw out of start() and let the process exit.
	//
	// Under B1 the Xray process belongs to 3x-ui, which restarts it whenever an
	// administrator edits an inbound — so "Xray is briefly down" is now ordinary
	// operation rather than a broken host. Exiting turns that into a restart loop
	// in which the node is simply ABSENT from the control plane; staying up
	// reports xrayStatus=offline every heartbeat, which is the same fact with
	// somewhere to read it. The sampler retries, and the reconcile intent set
	// here is what reinstalls the users once it answers.
	if err := r.checkXrayLocked(ctx); err != nil {
		r.errorf("启动时 Xray 不可用，将在采样循环中重试：%v", err)
		return nil
	}
	// Take the restart baseline before the first sampling interval, so a restart
	// inside that window is not invisible.
	if err := r.detectXrayRestartLocked(ctx); err != nil {
		r.errorf("启动时无法读取 Xray 运行时长：%v", err)
	}
	return nil
}

// every runs action on a ticker until ctx is done.
//
// One goroutine per ticker, running its action to completion, is what replaces
// the Node agent's `running` re-entrancy guard: time.Ticker drops ticks that
// arrive while the receiver is busy, so a slow sample delays the next one
// instead of overlapping it.
func (r *Runner) every(ctx context.Context, group *sync.WaitGroup, interval time.Duration, what string, action func(context.Context) error) {
	group.Add(1)
	go func() {
		defer group.Done()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := action(ctx); err != nil && ctx.Err() == nil {
					r.errorf("%s失败：%v", what, err)
				}
			}
		}
	}()
}

// shutdown takes the last sample and flushes what it can.
//
// The traffic since the last tick is real money, and it is only in Xray's
// in-memory counters. Its context is fresh because the one that ran the loop is
// cancelled by now, and bounded because systemd will not wait forever.
func (r *Runner) shutdown() {
	ctx, cancel := context.WithTimeout(context.Background(), ShutdownTimeout)
	defer cancel()
	r.logf("正在保存最后一次计量样本")
	if err := r.sample(ctx); err != nil {
		r.errorf("退出前的计量采样失败：%v", err)
	}
	if err := r.flushBatches(ctx); err != nil {
		r.errorf("退出前的计量上报失败：%v", err)
	}
}

// --- configuration ----------------------------------------------------------

// refreshConfig fetches the desired state and applies it, returning what was
// applied — which is the STORED snapshot when the control plane's is older.
func (r *Runner) refreshConfig(ctx context.Context) (result protocol.ConfigSnapshot, refreshErr error) {
	ctx, cancel := context.WithTimeout(ctx, ShutdownTimeout)
	defer cancel()
	r.state.Lock()
	epoch := r.settlementEpoch
	r.state.Unlock()
	defer func() {
		if refreshErr != nil {
			r.state.Lock()
			r.refreshPending = true
			r.state.Unlock()
		}
	}()
	snapshot, err := r.deps.API.GetConfig(ctx)
	if err != nil {
		r.setBackendOnline(false)
		return protocol.ConfigSnapshot{}, err
	}
	r.state.Lock()
	defer r.state.Unlock()
	// The control plane answered, which is the whole of what backendOnline
	// claims. The Node agent set it only after the local apply had also
	// succeeded, so a local failure (a malformed user in the snapshot, say) read
	// as "backend offline" and started spending the offline allowance while the
	// backend was demonstrably up.
	r.backendOnline = true
	if epoch != r.settlementEpoch {
		return protocol.ConfigSnapshot{}, fmt.Errorf("配置请求期间计量已结算，丢弃响应并重新拉取")
	}
	applied, err := r.applyRefreshedLocked(ctx, snapshot)
	if err == nil {
		r.refreshPending = false
	}
	return applied, err
}

func (r *Runner) applyRefreshedLocked(ctx context.Context, snapshot protocol.ConfigSnapshot) (protocol.ConfigSnapshot, error) {
	current, err := r.deps.Store.ConfigSnapshot()
	if err != nil {
		return protocol.ConfigSnapshot{}, err
	}
	prepared, err := r.deps.Commands.PrepareSnapshot(snapshot)
	if err != nil {
		return protocol.ConfigSnapshot{}, err
	}
	older, err := decimal.Less(snapshot.Revision, current.Revision)
	if err != nil {
		return protocol.ConfigSnapshot{}, err
	}
	if older {
		r.current = current
		return current, nil
	}
	if current.ControlMode == protocol.ModeDirectPrimary || prepared.ControlMode == protocol.ModeDirectPrimary {
		if err := r.sampleBeforeRemovalLocked(ctx, current, prepared); err != nil {
			return protocol.ConfigSnapshot{}, err
		}
	}
	// Sampling above may itself exhaust another user's quota. Read AFTER it,
	// not from the pre-sample snapshot, before preserving local disables.
	local, err := r.deps.Store.ListDesiredUsers()
	if err != nil {
		return protocol.ConfigSnapshot{}, err
	}
	preserve, err := r.preserveLocalDisablesLocked()
	if err != nil {
		return protocol.ConfigSnapshot{}, err
	}
	if preserve {
		prepared.Users = withLocalDisables(prepared.Users, local)
	}
	if !preserve {
		if err := r.restoreOfflineUsersLocked(snapshot.Users, local); err != nil {
			return protocol.ConfigSnapshot{}, err
		}
		// Re-merge after recovery: equal-revision local disables otherwise win.
		prepared, err = r.deps.Commands.PrepareSnapshot(snapshot)
		if err != nil {
			return protocol.ConfigSnapshot{}, err
		}
	}
	if err := r.deps.Commands.ApplySnapshot(ctx, prepared); err != nil {
		return protocol.ConfigSnapshot{}, err
	}
	if r.current, err = r.deps.Store.ConfigSnapshot(); err != nil {
		return protocol.ConfigSnapshot{}, err
	}
	return snapshot, nil
}

// sampleBeforeRemovalLocked meters the traffic of any enabled user this snapshot
// is about to take away.
//
// Once the user is gone from Xray its in-memory counters go with it, and the
// traffic since the last tick would simply never be billed. The failure is NOT
// swallowed: refusing the whole refresh keeps the user — and their counters —
// in place until metering works again, which is the direction that loses money
// for nobody.
func (r *Runner) sampleBeforeRemovalLocked(ctx context.Context, current, snapshot protocol.ConfigSnapshot) error {
	wanted := make(map[string]protocol.DesiredUser, len(snapshot.Users))
	for _, user := range snapshot.Users {
		wanted[user.BindingID] = user
	}
	for _, user := range current.Users {
		next := wanted[user.BindingID]
		if user.Enabled && (!next.Enabled || next.Email != user.Email || next.UUID != user.UUID || next.Flow != user.Flow) {
			return r.sampleLocked(ctx)
		}
	}
	return nil
}

// preserveLocalDisablesLocked reports whether this node's own quota decisions
// must survive the incoming snapshot.
//
// A user disabled locally for running out of quota was disabled on evidence the
// control plane has not seen yet — it is sitting in the unflushed batch queue.
// Taking the snapshot's enabled=true at face value would put them back online
// and serve traffic nobody is paying for, until the batches land and the
// backend disables them again.
func (r *Runner) preserveLocalDisablesLocked() (bool, error) {
	pending, err := r.deps.Store.PendingBatchCount()
	if err != nil || pending == 0 {
		return false, err
	}
	return r.deps.Store.HasUsageDisabledUsers()
}

// withLocalDisables keeps a locally-disabled user disabled.
func withLocalDisables(incoming, local []protocol.DesiredUser) []protocol.DesiredUser {
	disabled := make(map[string]protocol.DesiredUser, len(local))
	for _, user := range local {
		if !user.Enabled {
			disabled[user.BindingID] = user
		}
	}
	merged := make([]protocol.DesiredUser, 0, len(incoming))
	for _, user := range incoming {
		if held, ok := disabled[user.BindingID]; ok {
			user = held
		}
		merged = append(merged, user)
	}
	return merged
}

// --- Xray health and restart detection ---------------------------------------

func (r *Runner) checkXrayLocked(ctx context.Context) error {
	if err := r.deps.Xray.Health(ctx); err != nil {
		r.xrayHealthy = false
		return err
	}
	// Coming back from unhealthy is itself a reconcile trigger: users added over
	// gRPC live only in Xray's memory, and whatever made it unreachable may well
	// have replaced the process.
	if !r.xrayHealthy {
		r.reconcilePending = true
	}
	r.xrayHealthy = true
	if err := r.flushPendingReconcileLocked(ctx); err != nil {
		r.xrayHealthy = false
		return err
	}
	return nil
}

func (r *Runner) flushPendingReconcileLocked(ctx context.Context) error {
	if !r.reconcilePending || r.current.ControlMode != protocol.ModeDirectPrimary {
		return nil
	}
	users, err := r.deps.Store.ListDesiredUsers()
	if err != nil {
		return err
	}
	if err := r.deps.Commands.Reconcile(ctx, users); err != nil {
		return err
	}
	r.reconcilePending = false
	return nil
}

// detectXrayRestartLocked notices that Xray was replaced under us.
//
// Users added over gRPC live only in Xray's memory, so ANY restart — ours, an
// operator's, a 3x-ui inbound edit, a package upgrade, an OOM kill — silently
// empties the inbound while the agent still believes it is provisioned.
func (r *Runner) detectXrayRestartLocked(ctx context.Context) error {
	uptime, err := r.deps.Xray.UptimeSeconds(ctx)
	if err != nil {
		return err
	}
	if uptime < 0 || uptime > MaxUptimeSeconds {
		return fmt.Errorf("Xray 报告的运行时长不合理（%d 秒），无法据此判断是否重启过", uptime)
	}
	// Compare the process's ESTIMATED START, not whether uptime fell: a restart
	// shortly after a sample leaves uptime HIGHER than last time (1s, restart,
	// then 3s), and the emptied user table would never be noticed. The estimate
	// only moves forward when the process was replaced; the tolerance absorbs
	// second-granularity uptime and scheduling jitter, and a false positive costs
	// one extra idempotent reconcile.
	start := r.deps.Now().Add(-time.Duration(uptime) * time.Second)
	if !r.lastXrayStart.IsZero() && start.Sub(r.lastXrayStart) > r.deps.Config.RestartTolerance {
		r.reconcilePending = true
	}
	r.lastXrayStart = start

	// The estimate cannot see a restart that landed WITHIN the tolerance of the
	// previous process's start — entirely between two samples, the baseline is
	// simply replaced. The LIVE table is the ground truth: an enabled user we own
	// going missing means something took them, whatever the uptime says. One
	// extra query per sample, of the same kind metering already issues.
	if err := r.detectMissingUsersLocked(ctx); err != nil {
		return err
	}
	return r.flushPendingReconcileLocked(ctx)
}

func (r *Runner) detectMissingUsersLocked(ctx context.Context) error {
	if r.current.ControlMode != protocol.ModeDirectPrimary {
		return nil
	}
	users, err := r.deps.Store.ListDesiredUsers()
	if err != nil {
		return err
	}
	wanted := []string{}
	for _, user := range users {
		if user.Enabled {
			wanted = append(wanted, user.Email)
		}
	}
	if len(wanted) == 0 {
		return nil
	}
	live, err := r.deps.Xray.ListUsers(ctx)
	if err != nil {
		return err
	}
	installed := make(map[string]bool, len(live))
	for _, account := range live {
		installed[account.Email] = true
	}
	for _, email := range wanted {
		if !installed[email] {
			r.reconcilePending = true
			return nil
		}
	}
	return nil
}

// --- metering ---------------------------------------------------------------

func (r *Runner) sample(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, ShutdownTimeout)
	defer cancel()
	r.state.Lock()
	defer r.state.Unlock()
	return r.sampleLocked(ctx)
}

func (r *Runner) sampleLocked(ctx context.Context) error {
	counters, err := r.deps.Xray.ReadAbsoluteCounters(ctx)
	if err != nil {
		r.xrayHealthy = false
		return err
	}
	counters, err = r.attributableCountersLocked(ctx, counters)
	if err != nil {
		return err
	}
	if !r.xrayHealthy {
		r.reconcilePending = true
	}
	r.xrayHealthy = true
	// A store failure is NOT reported as Xray being unhealthy, which the Node
	// agent did by wrapping the whole block in one catch. xrayStatus is what the
	// control plane uses to decide whether this node can serve; answering
	// "offline" for a local database problem sends an operator to the wrong host.
	result, err := r.deps.Store.RecordSample(counters, r.deps.Now(), r.backendOnline)
	if err != nil {
		return err
	}
	if r.current.ControlMode == protocol.ModeDirectPrimary {
		if err := r.deps.Commands.UninstallExhausted(ctx, result.DisableEmails); err != nil {
			r.xrayHealthy = false
			r.reconcilePending = true
			return err
		}
	}
	// Meter first. One conflicting account must not prevent the remaining
	// installed users from being billed while recovery keeps retrying.
	if err := r.checkXrayLocked(ctx); err != nil {
		r.errorf("计量已保存，Xray 恢复待重试：%v", err)
	} else if err := r.detectXrayRestartLocked(ctx); err != nil {
		r.xrayHealthy = false
		r.reconcilePending = true
		r.errorf("计量已保存，重启检测/恢复待重试：%v", err)
	}

	return nil
}

// flushBatches uploads the local metering queue.
func (r *Runner) flushBatches(ctx context.Context) error {
	if err := r.uploadPending(ctx); err != nil {
		return err
	}
	return r.recoverAfterUpload(ctx)
}

func (r *Runner) uploadPending(ctx context.Context) error {
	r.transport.Lock()
	defer r.transport.Unlock()
	r.state.Lock()
	batches, err := r.deps.Store.ListPendingBatches(0)
	r.state.Unlock()
	if err != nil {
		return err
	}
	for _, batch := range batches {
		if batch.BootID != batches[0].BootID {
			break
		}
		ack, err := r.deps.API.UploadBatch(ctx, batch)
		if err != nil {
			r.setBackendOnline(false)
			return err
		}
		if !ack.Accepted {
			r.setBackendOnline(false)
			return fmt.Errorf("控制面未接受计量批次 %s/%s", batch.BootID, batch.Sequence)
		}
		r.state.Lock()
		err = r.ackLocked(batch.BootID, ack.AckThrough)
		r.backendOnline = true
		r.state.Unlock()
		if err != nil {
			return err
		}
		behind, err := decimal.Less(ack.AckThrough, batch.Sequence)
		if err != nil {
			return err
		}
		if behind {
			break
		} // replay again until the server's bounded scan catches up
	}
	return nil
}

func (r *Runner) recoverAfterUpload(ctx context.Context) error {
	// Draining the queue is what settles the argument about locally-disabled
	// users: the backend has now seen every byte this node metered, so its answer
	// about their quota is authoritative and they can come back.
	r.state.Lock()
	pending, err := r.deps.Store.PendingBatchCount()
	var disabled bool
	if err == nil {
		disabled, err = r.deps.Store.HasUsageDisabledUsers()
	}
	r.state.Unlock()
	if err != nil || pending != 0 || !disabled {
		return err
	}
	_, err = r.refreshConfig(ctx)
	return err
}

// --- heartbeat ---------------------------------------------------------------

func (r *Runner) sendHeartbeat(ctx context.Context) error {
	r.transport.Lock()
	locked := true
	defer func() {
		if locked {
			r.transport.Unlock()
		}
	}()
	r.state.Lock()
	revision, err := r.deps.Store.ConfigRevision()
	var depth int
	if err == nil {
		depth, err = r.deps.Store.PendingBatchCount()
	}
	heartbeatBoot := r.deps.BootID
	if err == nil {
		var pending []protocol.UsageBatch
		pending, err = r.deps.Store.ListPendingBatches(1)
		if len(pending) > 0 {
			heartbeatBoot = pending[0].BootID
		}
	}
	status := protocol.XrayOffline
	if r.xrayHealthy {
		status = protocol.XrayHealthy
	}
	mode := r.current.ControlMode
	refreshPending := r.refreshPending
	r.state.Unlock()
	if err != nil {
		return err
	}

	ack, err := r.deps.API.Heartbeat(ctx, protocol.Heartbeat{
		BootID:         heartbeatBoot,
		Version:        version.Version,
		ConfigRevision: revision,
		QueueDepth:     depth,
		XrayStatus:     status,
	})
	if err != nil {
		r.setBackendOnline(false)
		return err
	}
	if !ack.Accepted {
		r.setBackendOnline(false)
		return fmt.Errorf("控制面未接受心跳")
	}
	r.state.Lock()
	err = r.ackLocked(heartbeatBoot, ack.AckThrough)
	r.backendOnline = true
	r.state.Unlock()
	if err != nil {
		return err
	}

	r.transport.Unlock()
	locked = false
	// An OBSERVING node gets no commands, so the heartbeat's ack is the only
	// place it learns that the desired state moved. A malformed revision is
	// ignored rather than fatal: it is the control plane's field, and refusing
	// the heartbeat over it would take the node offline for a cosmetic problem.
	if refreshPending {
		_, err := r.refreshConfig(ctx)
		return err
	}
	if mode != protocol.ModeShadowDirect {
		return nil
	}
	newer, err := decimal.Less(revision, ack.ConfigRevision)
	if err != nil || !newer {
		return nil
	}
	_, err = r.refreshConfig(ctx)
	return err
}

func (r *Runner) setBackendOnline(online bool) {
	r.state.Lock()
	r.backendOnline = online
	r.state.Unlock()
}

// --- commands ----------------------------------------------------------------

// eventsLoop keeps one SSE connection to the control plane, reconnecting until
// ctx is cancelled. Each connection begins with a full config refresh: the
// stream carries what changes from now on, not what changed while it was down.
func (r *Runner) eventsLoop(ctx context.Context) {
	for ctx.Err() == nil {
		err := r.consumeOnce(ctx)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			r.setBackendOnline(false)
			r.errorf("命令流中断，%s 后重连：%v", ReconnectDelay, err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(ReconnectDelay):
		}
	}
}

func (r *Runner) consumeOnce(ctx context.Context) error {
	if _, err := r.refreshConfig(ctx); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		// A local apply failure must not block cached reports or recovery commands.
		// The API authenticates the stream; Execute still enforces mode and revision.
		r.errorf("连接命令流前配置刷新失败，将由心跳重试：%v", err)
	}
	return r.deps.API.ConsumeEvents(ctx, func(command protocol.Command) error {
		return r.handleCommand(ctx, command)
	})
}

// handleCommand executes one command and reports the outcome.
//
// Reporting happens OUTSIDE the lock, and that is not just about latency: the
// report is a control-plane call, and holding the state lock across it would
// stall metering for as long as the control plane takes to answer.
func (r *Runner) handleCommand(ctx context.Context, command protocol.Command) error {
	result, err := r.execute(ctx, command)
	if err != nil {
		return err
	}
	return r.deps.API.ReportCommandResult(ctx, result)
}

func (r *Runner) execute(ctx context.Context, command protocol.Command) (protocol.CommandResult, error) {
	ctx, cancel := context.WithTimeout(ctx, ShutdownTimeout)
	defer cancel()
	r.state.Lock()
	defer r.state.Unlock()
	r.backendOnline = true

	previous, err := r.deps.Store.CompletedCommand(command.CommandID)
	if err != nil {
		return protocol.CommandResult{}, err
	}
	if previous != nil {
		return *previous, nil
	}
	writable := r.current.ControlMode == protocol.ModeDirectPrimary

	reconfigures, err := r.deps.Commands.ReconfiguresUser(command)
	if err != nil {
		return protocol.CommandResult{CommandID: command.CommandID, Status: protocol.StatusFailed, Error: err.Error()}, nil
	}
	if writable && (isTerminal(command.Type) || command.Type == protocol.CommandReconcileUsers || reconfigures) {

		// The command is about to take an account down, and its counters die with
		// it. Meter first, or the traffic since the last tick is unbilled.
		//
		// A failure here does NOT tear down the stream, which is what the Node
		// agent's uncaught throw did — it reports the command as failed instead.
		// The control plane then knows the instruction did not land and will
		// redeliver it, rather than watching the connection drop for a reason it
		// cannot see and losing every OTHER command queued behind it.
		if err := r.sampleLocked(ctx); err != nil {
			return protocol.CommandResult{
				CommandID: command.CommandID,
				Status:    protocol.StatusFailed,
				Error:     fmt.Sprintf("停用/删除前无法完成计量采样，拒绝执行以免漏计流量：%v", err),
			}, nil
		}
	}

	result, err := r.deps.Commands.Execute(ctx, command, writable)
	if err != nil {
		return protocol.CommandResult{}, err
	}
	if r.current, err = r.deps.Store.ConfigSnapshot(); err != nil {
		return protocol.CommandResult{}, err
	}
	return result, nil
}

func isTerminal(commandType protocol.CommandType) bool {
	return commandType == protocol.CommandDisableUser || commandType == protocol.CommandRemoveUser
}

// Offline cutoffs with credit remaining can recover at the same revision, but
// only after every batch is acknowledged. Quota-zero users need a newer top-up;
// terminal tombstones are never treated as local offline decisions.
func (r *Runner) restoreOfflineUsersLocked(incoming, local []protocol.DesiredUser) error {
	byID := make(map[string]protocol.DesiredUser, len(local))
	for _, user := range local {
		byID[user.BindingID] = user
	}
	var recover []protocol.DesiredUser
	for _, user := range incoming {
		held, ok := byID[user.BindingID]
		if !ok || held.Enabled || !user.Enabled || held.QuotaRemainingBytes == "0" || held.Email != user.Email || held.UUID != user.UUID {
			continue
		}
		older, err := decimal.Less(user.Revision, held.Revision)
		if err != nil {
			return err
		}
		if older {
			continue
		}
		tombstone, err := r.deps.Store.BindingTombstone(user.BindingID)
		if err != nil {
			return err
		}
		if tombstone != "0" {
			continue
		}
		offline, err := r.deps.Store.OfflineDisabled(user.BindingID)
		if err != nil {
			return err
		}
		if !offline {
			continue
		}
		recover = append(recover, user)
	}
	return r.deps.Store.RestoreBackendConfirmedUsers(recover)
}

func (r *Runner) ackLocked(bootID, through string) error {
	removed, err := r.deps.Store.AckThrough(bootID, through)
	if err == nil && removed > 0 {
		r.settlementEpoch++
	}
	return err
}

// Counters are keyed only by email. Refuse a positively identified replacement
// before folding it into the subscription. A missing/unknown identity cannot
// prove a replacement (a removed account may leave a final stats reading).
// This is not an atomic identity+counter read; the panel race remains in PRD §10.
func (r *Runner) attributableCountersLocked(ctx context.Context, counters []protocol.AbsoluteCounter) ([]protocol.AbsoluteCounter, error) {
	if len(counters) == 0 {
		return counters, nil
	}
	live, err := r.deps.Xray.ListUsers(ctx)
	if err != nil {
		return nil, err
	}
	users, err := r.deps.Store.ListDesiredUsers()
	if err != nil {
		return nil, err
	}
	wanted := make(map[string]string, len(users))
	for _, user := range users {
		wanted[user.Email] = user.UUID
	}
	installed := make(map[string]string, len(live))
	for _, user := range live {
		installed[user.Email] = user.UUID
	}
	filtered := make([]protocol.AbsoluteCounter, 0, len(counters))
	for _, counter := range counters {
		expected, known := wanted[counter.Email]
		if !known {
			continue
		}
		actual := installed[counter.Email]
		if actual != "" && expected != "" && actual != expected {
			r.errorf("账号 %s 的实时身份与 binding 不符，跳过计量", counter.Email)
			continue
		}
		filtered = append(filtered, counter)
	}
	return filtered, nil
}
