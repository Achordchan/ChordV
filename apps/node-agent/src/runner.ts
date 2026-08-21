import type { AgentConfig } from './config.js';
import type { AgentApiClient } from './api-client.js';
import type { AgentStore } from './store.js';
import type { XrayAdapter } from './xray-adapter.js';
import { CommandProcessor } from './command-processor.js';
import { isNodeControlMode, type AgentConfigSnapshot } from './types.js';

export class AgentRunner {
  private stopped = false;
  private backendOnline = false;
  private xrayHealthy = false;
  private currentConfig: AgentConfigSnapshot;
  private readonly commands: CommandProcessor;
  private readonly timers = new Set<NodeJS.Timeout>();
  private stateMutationTail: Promise<void> = Promise.resolve();
  private eventsController?: AbortController;

  constructor(
    private readonly config: AgentConfig,
    private readonly store: AgentStore,
    private readonly api: AgentApiClient,
    private readonly xray: XrayAdapter,
  ) {
    this.commands = new CommandProcessor(store, xray);
    this.currentConfig = store.getConfigSnapshot();
  }

  async start(): Promise<void> {
    try {
      await this.refreshConfig();
    } catch (error) {
      this.backendOnline = false;
      if (this.currentConfig.revision === '0') throw error;
      this.logError(new Error(`后台暂不可用，使用 revision ${this.currentConfig.revision} 的本地配置启动`));
    }
    await this.checkXrayAndRecover();
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
        const preserveLocalDisables = this.store.pendingBatchCount() > 0 && this.store.hasUsageDisabledUsers();
        const localUsers = new Map(this.store.listDesiredUsers().map((user) => [user.bindingId, user]));
        const reconcileUsers = preserveLocalDisables
          ? snapshot.users.map((user) => localUsers.get(user.bindingId)?.enabled === false ? { ...user, enabled: false } : user)
          : snapshot.users;
        await this.commands.reconcile(reconcileUsers);
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
        await this.commands.reconcile(this.store.listDesiredUsers());
      }
    });
  }

  private async checkXrayAndRecover(): Promise<void> {
    await this.xray.health();
    const recovered = !this.xrayHealthy;
    this.xrayHealthy = true;
    if (recovered && this.currentConfig.controlMode === 'direct_primary') {
      await this.commands.reconcile(this.store.listDesiredUsers());
    }
  }

  private async sample(): Promise<void> {
    await this.withStateMutation(async () => {
      await this.sampleWithinStateMutation();
    });
  }

  private async sampleWithinStateMutation(): Promise<void> {
    try {
      await this.checkXrayAndRecover();
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
        version: '0.1.0',
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
              && (command.type === 'DISABLE_USER' || command.type === 'REMOVE_USER')
            ) {
              await this.sampleWithinStateMutation();
            }
            const commandResult = await this.commands.execute(command, this.currentConfig.controlMode === 'direct_primary');
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
