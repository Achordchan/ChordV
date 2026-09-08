import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { AGENT_VERSION } from './agent-version.js';
import type { AgentConfig } from './config.js';
import type { AgentApiClient } from './api-client.js';
import type { AgentStore } from './store.js';
import type { XrayAdapter } from './xray-adapter.js';
import { CommandProcessor } from './command-processor.js';
import { FileInboundApplier, type InboundApplier } from './xray-inbound.js';
import { isNodeControlMode, type AgentConfigSnapshot, type DesiredUser } from './types.js';

export class AgentRunner {
  private stopped = false;
  private backendOnline = false;
  private xrayHealthy = false;
  private currentConfig: AgentConfigSnapshot;
  private readonly commands: CommandProcessor;
  private readonly timers = new Set<NodeJS.Timeout>();
  private stateMutationTail: Promise<void> = Promise.resolve();
  private eventsController?: AbortController;
  /** Estimated wall-clock start of the running Xray process, from its uptime. */
  private lastXrayStart = 0;
  /** Set when Xray was (re)started; cleared only once users are back in place. */
  private reconcilePending = false;
  /**
   * True while this host has no inbound to provision users into: Xray cannot
   * add a user to a tag that does not exist, so every reconcile would throw.
   * Established at the top of start() — from the durable intent AND from the
   * helper probe, so it survives a restart whose own probe fails — and cleared
   * only when a deployment completes.
   */
  private awaitingInbound = false;
  /**
   * Set by the startup probe when the helper serves an inbound this identity
   * has no record of; consumed by discardForeignInbound once the refreshed
   * snapshot has said which mode may write Xray at all.
   */
  private foreignInbound = false;
  private readonly inbound: InboundApplier;

  constructor(
    private readonly config: AgentConfig,
    private readonly store: AgentStore,
    private readonly api: AgentApiClient,
    private readonly xray: XrayAdapter,
    inbound: InboundApplier = new FileInboundApplier(config.inboundRequestDir, config.inboundResultDir),
  ) {
    this.inbound = inbound;
    this.commands = new CommandProcessor(store, xray, {
      applier: inbound,
      inboundTag: config.xrayInboundTag,
      resolvePublicHost: () => this.resolvePublicHost(),
    });
    this.currentConfig = store.getConfigSnapshot();
  }

  /** Operator override first; otherwise the address the control plane sees. */
  private async resolvePublicHost(): Promise<string> {
    if (this.config.publicHost) return this.config.publicHost;
    const observed = (await this.api.whoami()).observedIp?.trim();
    if (!observed) throw new Error('控制面未能返回本机公网地址，请配置 CHORDV_NODE_PUBLIC_HOST');
    return observed;
  }

  async start(): Promise<void> {
    // Establish the missing-inbound state BEFORE any startup reconciliation:
    // everything below (refreshConfig, recovery, restart detection) provisions
    // users, and Xray rejects adding a user to a tag that does not exist — a
    // start() that throws keeps the ENSURE_INBOUND that recovers the node from
    // ever arriving. The durable intent survives a restart whose own probe
    // fails; the probe below re-establishes it for helper-managed hosts where
    // no inbound is deployed at all (a fresh VPS an existing node with users
    // was reinstalled onto).
    this.awaitingInbound = this.store.isInboundAwaiting();
    await this.probeInbound();
    try {
      await this.refreshConfig();
    } catch (error) {
      this.backendOnline = false;
      if (this.currentConfig.revision === '0') throw error;
      this.logError(new Error(`后台暂不可用，使用 revision ${this.currentConfig.revision} 的本地配置启动`));
    }
    await this.discardForeignInbound();
    await this.checkXrayAndRecover();
    // Take the restart baseline before the first sampling interval, so a
    // restart in that window is not invisible.
    await this.detectXrayRestart().catch((error) => this.logError(error));
    this.schedule(() => this.sample(), this.config.sampleIntervalMs);
    this.schedule(() => this.flushBatches(), 1_000);
    this.schedule(() => this.sendHeartbeat(), this.config.heartbeatIntervalMs);
    void this.eventsLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.clear();
    this.eventsController?.abort();
    await this.sample().catch(() => undefined);
    await this.flushBatches().catch(() => undefined);
  }

  private schedule(action: () => Promise<void>, intervalMs: number): void {
    let running = false;
    const timer = setInterval(() => {
      if (running || this.stopped) return;
      running = true;
      void action().catch((error) => this.logError(error)).finally(() => { running = false; });
    }, intervalMs);
    timer.unref();
    this.timers.add(timer);
  }

  private async refreshConfig(): Promise<AgentConfigSnapshot> {
    const snapshot = await this.api.getConfig();
    const appliedSnapshot = await this.withStateMutation(async () => {
      const current = this.store.getConfigSnapshot();
      if (BigInt(snapshot.revision) < BigInt(current.revision)) return current;
      if (snapshot.controlMode === 'direct_primary') {
        const snapshotUsers = new Map(snapshot.users.map((user) => [user.bindingId, user]));
        const removesEnabledUser = this.store.listDesiredUsers().some((user) =>
          user.enabled && snapshotUsers.get(user.bindingId)?.enabled !== true);
        if (removesEnabledUser) await this.sampleWithinStateMutation();
        const preserveLocalDisables = this.store.pendingBatchCount() > 0 && this.store.hasUsageDisabledUsers();
        const localUsers = new Map(this.store.listDesiredUsers().map((user) => [user.bindingId, user]));
        const reconcileUsers = preserveLocalDisables
          ? snapshot.users.map((user) => localUsers.get(user.bindingId)?.enabled === false ? { ...user, enabled: false } : user)
          : snapshot.users;
        await this.reconcileUsers(reconcileUsers);
        if (preserveLocalDisables) {
          this.store.applyConfigSnapshot({ ...snapshot, users: reconcileUsers });
          this.currentConfig = this.store.getConfigSnapshot();
          return snapshot;
        }
      }
      this.store.applyConfigSnapshot(snapshot);
      this.currentConfig = this.store.getConfigSnapshot();
      return snapshot;
    });
    this.backendOnline = true;
    return appliedSnapshot;
  }

  private async recoverBackendConfirmedUsers(snapshot: AgentConfigSnapshot): Promise<void> {
    await this.withStateMutation(async () => {
      if (this.store.pendingBatchCount() !== 0 || !this.store.hasUsageDisabledUsers()) return;
      this.store.restoreBackendConfirmedUsers(snapshot.users);
      this.currentConfig = this.store.getConfigSnapshot();
      if (this.currentConfig.controlMode === 'direct_primary') {
        await this.reconcileUsers(this.store.listDesiredUsers());
      }
    });
  }

  /**
   * Every user-provisioning path funnels through here. While this host has no
   * inbound of its own, Xray has no tag to add users to and the call would
   * throw — out of start(), or out of the events loop before it can receive
   * the ENSURE_INBOUND that would fix it. Remember the intent instead; the
   * deployment reconciles as part of applying the inbound.
   */
  private async reconcileUsers(users: DesiredUser[]): Promise<void> {
    if (this.awaitingInbound) {
      this.reconcilePending = true;
      return;
    }
    await this.commands.reconcile(users);
  }

  /**
   * The READ-ONLY half of inbound hygiene, run BEFORE any startup
   * reconciliation: it asks the helper what is actually deployed and records
   * what follows from the answer —
   *
   * - a helper-managed host with NOTHING deployed has no tag to provision
   *   users into. A fresh VPS that an existing node with users was reinstalled
   *   onto starts with base and metering fragments only, and reconciling users
   *   into the absent tag would throw out of start() before the redeploying
   *   ENSURE_INBOUND can arrive;
   * - a deployed inbound this identity has no record of belongs to a DIFFERENT
   *   node (repurposed VPS, restored image, hand-copied data directory — the
   *   state database travels with the identity, the Xray config does not).
   *
   * Both defer user provisioning; the destructive clearing happens later, in
   * discardForeignInbound, once the refreshed snapshot has said which mode may
   * write Xray at all.
   */
  private async probeInbound(): Promise<void> {
    this.foreignInbound = false;
    // The installer creates the result directory; without it there is no helper
    // on this host — nothing it could have deployed, and probing would just
    // stall startup waiting for an answer nobody will write. Hosts without the
    // helper also keep OPERATOR-managed inbounds (the pre-R2 population):
    // those have no deployment record either, and their users must keep
    // flowing, so no deferral is derived here.
    if (!existsSync(this.config.inboundResultDir)) return;
    // The last result file is not evidence: a deployment that failed and rolled
    // back leaves ok:false behind while the PREVIOUS inbound is still serving,
    // and a helper that crashed leaves no result at all.
    let status: Awaited<ReturnType<InboundApplier['status']>>;
    try {
      status = await this.inbound.status(randomUUID());
    } catch (error) {
      // No answer is not evidence either — and the clearing that might follow
      // is destructive, so guessing would take a healthy node offline. Report
      // and leave it alone; the state database's identity binding still
      // prevents this agent from adopting the other node's users, and the
      // durable intent (if any) holds from the top of start().
      this.logError(new Error(`无法确认本机是否残留他人入站配置：${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    if (!status.deployed) {
      // A helper-managed host only ever gets its tag through a deployment, so
      // user provisioning has nothing to target until ENSURE_INBOUND arrives.
      // Durable, so a restart whose own probe fails reaches the same
      // conclusion. Deliberately NOT gated on the control mode: a fresh
      // reinstall's local mode is still the shadow default while the backend
      // snapshot that flips it to direct_primary carries the users.
      this.store.setInboundAwaiting(true);
      this.awaitingInbound = true;
      return;
    }
    if (this.store.getInboundState()) return; // ours
    // The helper serves an inbound this identity never asked for: the keys and
    // port belong to a stranger. Defer provisioning NOW — durably, so a crash
    // before the clearing must not lose the "tag is gone" fact with the
    // process — and leave the clearing itself to the mode gate below.
    this.foreignInbound = true;
    this.store.setInboundAwaiting(true);
    this.awaitingInbound = true;
  }

  /**
   * The destructive half: publishes an EMPTY inbound for a foreign deployment,
   * so this host does not keep serving a stranger's node with its keys. Only
   * the mode that is allowed to write Xray at all may do it, and the mode
   * comes from the refreshed snapshot — a fresh VPS's local default is shadow
   * while the backend's answer is the actual decision.
   */
  private async discardForeignInbound(): Promise<void> {
    if (!this.foreignInbound) return;
    if (this.currentConfig.controlMode !== 'direct_primary') return;
    if (this.store.getInboundState()) return;
    await this.inbound.reset(randomUUID());
    // awaitingInbound was already set (durably) by the probe that saw the
    // foreign inbound: the tag is gone and the users this identity wants have
    // nowhere to go until the ENSURE_INBOUND that recreates it. Record the
    // re-provisioning intent and let the deployment carry it out
    // (ensureInbound reconciles on every apply).
    this.reconcilePending = true;
    console.warn('[node-agent] 已清除不属于本节点身份的 Xray 入站配置，等待控制面重新下发入站后再恢复用户');
  }

  private async checkXrayAndRecover(): Promise<void> {
    await this.xray.health();
    if (!this.xrayHealthy) this.reconcilePending = true;
    this.xrayHealthy = true;
    await this.flushPendingReconcile();
  }

  /**
   * Recovery is not "we tried once": a HandlerService call can fail while Xray
   * is still initialising, and by then the health flag and the uptime baseline
   * have already moved on — nothing would retry, and the node would serve no
   * users until the next restart. So the intent stays pending until a reconcile
   * actually completes.
   */
  private async flushPendingReconcile(): Promise<void> {
    if (!this.reconcilePending || this.currentConfig.controlMode !== 'direct_primary') return;
    // No inbound, nowhere to put them: keep the intent, skip the attempt.
    if (this.awaitingInbound) return;
    await this.commands.reconcile(this.store.listDesiredUsers());
    this.reconcilePending = false;
  }

  /**
   * Users added over gRPC live only in Xray's memory, so ANY restart — ours, an
   * operator's, a package upgrade, an OOM kill — silently empties the inbound
   * while the agent still believes it is provisioned. A falling uptime is the
   * only signal that reaches us, so treat it as a reconcile trigger.
   */
  private async detectXrayRestart(): Promise<void> {
    const uptime = await this.xray.uptimeSeconds();
    // Compare the process's ESTIMATED START, not whether uptime fell: a restart
    // shortly after a sample leaves uptime higher than last time (1s, restart,
    // then 3s), and the emptied user table would never be noticed. The estimate
    // only moves forward when the process was replaced; the tolerance absorbs
    // second-granularity uptime and scheduling jitter, and a false positive
    // only costs one extra reconcile.
    const startEstimate = Date.now() - uptime * 1_000;
    if (this.lastXrayStart > 0 && startEstimate - this.lastXrayStart > this.config.restartToleranceMs) {
      this.reconcilePending = true;
    }
    this.lastXrayStart = startEstimate;
    // The estimate cannot see a restart that landed WITHIN the tolerance of the
    // previous process's start — entirely between samples, the baseline is
    // simply replaced: a freshly started Xray that already accepted the
    // reconciled users can be restarted again a second later by automation, and
    // the emptied table never triggers the comparison. The LIVE table is the
    // ground truth: an enabled user we own going missing means a restart (or
    // anything else) took them, whatever the uptime says. One extra stats query
    // per sample, the same kind metering already issues.
    if (this.currentConfig.controlMode === 'direct_primary' && !this.awaitingInbound) {
      const desired = this.store.listDesiredUsers().filter((user) => user.enabled);
      if (desired.length > 0) {
        const live = new Set((await this.xray.listUsers()).map((user) => user.email));
        if (desired.some((user) => !live.has(user.email))) this.reconcilePending = true;
      }
    }
    await this.flushPendingReconcile();
  }

  private async sample(): Promise<void> {
    await this.withStateMutation(async () => {
      await this.sampleWithinStateMutation();
    });
  }

  private async sampleWithinStateMutation(): Promise<void> {
    try {
      await this.checkXrayAndRecover();
      await this.detectXrayRestart();
      const counters = await this.xray.readAbsoluteCounters();
      const result = this.store.recordSample(counters, new Date(), this.backendOnline);
      if (this.currentConfig.controlMode === 'direct_primary') {
        for (const email of result.disableEmails) await this.xray.removeUser(email);
      }
    } catch (error) {
      this.xrayHealthy = false;
      throw error;
    }
  }

  private async flushBatches(): Promise<void> {
    const batches = this.store.listPendingBatches();
    for (const batch of batches) {
      try {
        const ack = await this.api.uploadBatch(batch);
        this.store.ackThrough(batch.bootId, ack.ackThrough);
        this.backendOnline = true;
      } catch (error) {
        this.backendOnline = false;
        throw error;
      }
    }
    if (batches.length > 0 && this.store.pendingBatchCount() === 0 && this.store.hasUsageDisabledUsers()) {
      const snapshot = await this.refreshConfig();
      await this.recoverBackendConfirmedUsers(snapshot);
    }
  }

  private async sendHeartbeat(): Promise<void> {
    try {
      const bootId = String(this.store.healthSnapshot().bootId);
      const response = await this.api.heartbeat({
        bootId,
        version: AGENT_VERSION,
        configRevision: this.store.getConfigRevision(),
        queueDepth: this.store.pendingBatchCount(),
        xrayStatus: this.xrayHealthy ? 'healthy' : 'offline',
      });
      this.store.ackThrough(bootId, response.ackThrough);
      this.backendOnline = true;
      if (
        this.currentConfig.controlMode === 'shadow_direct' &&
        /^\d+$/.test(response.configRevision) &&
        BigInt(response.configRevision) > BigInt(this.store.getConfigRevision())
      ) {
        await this.refreshConfig();
      }
    } catch (error) {
      this.backendOnline = false;
      throw error;
    }
  }

  private async eventsLoop(): Promise<void> {
    while (!this.stopped) {
      this.eventsController = new AbortController();
      try {
        const snapshot = await this.refreshConfig();
        await this.recoverBackendConfirmedUsers(snapshot);
        await this.api.consumeEvents(async (command) => {
          this.backendOnline = true;
          const result = await this.withStateMutation(async () => {
            if (
              command.type === 'RECONCILE_USERS' &&
              isNodeControlMode(command.payload.controlMode) &&
              /^\d+$/.test(command.targetRevision) &&
              BigInt(command.targetRevision) >= BigInt(this.currentConfig.revision)
            ) {
              // 模式必须在命令执行前切换，保证只有 direct_primary 会获得 Xray 写权限。
              this.currentConfig = {
                ...this.currentConfig,
                controlMode: command.payload.controlMode,
                revision: command.targetRevision,
              };
            }
            if (
              this.currentConfig.controlMode === 'direct_primary'
              && (command.type === 'DISABLE_USER' || command.type === 'REMOVE_USER' || command.type === 'ENSURE_INBOUND')
            ) {
              // A deployment restarts Xray, and its in-memory counters die with
              // it. Command execution also blocks the periodic sampler, so the
              // traffic since the last sample would simply be unbilled.
              await this.sampleWithinStateMutation();
            }
            const commandResult = await this.commands.execute(command, this.currentConfig.controlMode === 'direct_primary');
            if (commandResult.status === 'completed' && command.type === 'ENSURE_INBOUND') {
              // The tag exists again and the deployment reconciled the users
              // into it, so the deferred intent is satisfied — durably too, or
              // the next restart would defer again for no reason.
              this.store.setInboundAwaiting(false);
              this.awaitingInbound = false;
              this.reconcilePending = false;
            }
            if (commandResult.status === 'completed' && (command.type === 'DISABLE_USER' || command.type === 'REMOVE_USER')) {
              commandResult.result = {
                ...commandResult.result,
                disableWatermarks: this.store.pendingBatchWatermarks(),
              };
            }
            this.currentConfig = this.store.getConfigSnapshot();
            return commandResult;
          });
          await this.api.reportCommandResult(result);
        }, this.eventsController.signal);
      } catch (error) {
        if (!this.stopped) {
          this.backendOnline = false;
          this.logError(error);
          await delay(2_000);
        }
      }
    }
  }

  private logError(error: unknown): void {
    console.error(`[node-agent] ${error instanceof Error ? error.message : String(error)}`);
  }

  private async withStateMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.stateMutationTail;
    let release!: () => void;
    this.stateMutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
