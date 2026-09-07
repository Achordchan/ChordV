import { randomUUID } from 'node:crypto';
import { isNodeControlMode, type AgentCommand, type CommandResult, type DesiredUser, type InboundReport } from './types.js';
import type { AgentStore } from './store.js';
import type { XrayAdapter } from './xray-adapter.js';
import { inboundSpecHash, parseInboundSpec, type InboundApplier } from './xray-inbound.js';

/**
 * What ENSURE_INBOUND needs beyond users: the root helper that owns the Xray
 * config, the tag metering reads, and the address clients will dial. Optional
 * so the user-command paths (and their tests) construct a processor unchanged.
 */
export interface InboundDeps {
  applier: InboundApplier;
  inboundTag: string;
  resolvePublicHost(): Promise<string>;
  /** Restarting Xray is not instant; how long to wait for the tag to appear. */
  verifyAttempts?: number;
  verifyDelayMs?: number;
}

export class CommandProcessor {
  constructor(
    private readonly store: AgentStore,
    private readonly xray: XrayAdapter,
    private readonly inbound?: InboundDeps,
  ) {}

  async execute(command: AgentCommand, writable: boolean): Promise<CommandResult> {
    const previous = this.store.beginCommand(command);
    if (previous) return previous;
    let result: CommandResult;
    try {
      // apply() may return fields that only it can produce (the deployed
      // inbound's public parameters), so they are merged here rather than
      // reconstructed by the caller.
      const extra = await this.apply(command, writable);
      this.store.advanceConfigRevision(command.targetRevision);
      result = {
        commandId: command.commandId,
        status: 'completed',
        result: { appliedRevision: command.targetRevision, ...extra },
      };
    } catch (error) {
      result = {
        commandId: command.commandId,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
    this.store.completeCommand(result);
    return result;
  }

  private async apply(command: AgentCommand, writable: boolean): Promise<Record<string, unknown> | void> {
    if (!writable && command.type !== 'REFRESH_QUOTA' && command.type !== 'RECONCILE_USERS') {
      throw new Error('当前控制模式禁止修改 Xray 用户');
    }
    switch (command.type) {
      case 'ENSURE_USER':
      case 'ENABLE_USER': {
        const stored = this.findStored(command.payload);
        if (
          isOlderRevision(command.targetRevision, this.store.getConfigRevision())
          || (stored && (
          isOlderRevision(command.targetRevision, stored.revision)
          || (command.targetRevision === stored.revision && !stored.enabled)
          ))
        ) return;
        const user = this.resolveUser(command);
        const enabled = { ...user, enabled: true, revision: command.targetRevision };
        this.store.upsertDesiredUser(enabled);
        await this.xray.ensureUser(enabled);
        return;
      }
      case 'DISABLE_USER': {
        const stored = this.findStored(command.payload);
        if (stored && isOlderRevision(command.targetRevision, stored.revision)) return;
        const target = stored ?? this.resolveTerminalTarget(command.payload);
        await this.xray.removeUser(target.email);
        if (stored) this.store.setUserEnabled(stored.bindingId, false, command.targetRevision);
        return;
      }
      case 'REMOVE_USER': {
        const stored = this.findStored(command.payload);
        if (stored && isOlderRevision(command.targetRevision, stored.revision)) return;
        const target = stored ?? this.resolveTerminalTarget(command.payload);
        await this.xray.removeUser(target.email);
        if (stored) this.store.deleteUser(stored.bindingId);
        return;
      }
      case 'RECONCILE_USERS': {
        const users = Array.isArray(command.payload.users)
          ? command.payload.users.map((item) => parseDesiredUser(item, command.targetRevision))
          : this.store.listDesiredUsers();
        const current = this.store.getConfigSnapshot();
        if (BigInt(command.targetRevision) < BigInt(current.revision)) {
          throw new Error('拒绝执行过期的 RECONCILE_USERS revision');
        }
        const controlMode = isNodeControlMode(command.payload.controlMode)
          ? command.payload.controlMode
          : current.controlMode;
        const nextSnapshot = {
          nodeId: current.nodeId,
          revision: command.targetRevision,
          controlMode,
          users,
        };
        if (writable && controlMode === 'direct_primary') await this.reconcile(users);
        this.store.applyConfigSnapshot(nextSnapshot);
        return;
      }
      case 'REFRESH_QUOTA': {
        const bindingId = stringField(command.payload, 'bindingId');
        const quota = stringField(command.payload, 'quotaRemainingBytes');
        this.store.updateQuota(bindingId, quota, command.targetRevision);
        return;
      }
      case 'ENSURE_INBOUND':
        return { inbound: await this.ensureInbound(command) };
    }
  }

  /**
   * Deploys the control plane's inbound through the root helper and reports the
   * parameters clients need. Everything here is fail-loud: a node whose command
   * says "completed" must be a node an operator can activate, so a helper
   * failure, a stale revision or an inbound that does not come back live all
   * throw instead of reporting a partial success.
   */
  private async ensureInbound(command: AgentCommand): Promise<InboundReport> {
    if (!this.inbound) throw new Error('本机未启用 Xray 入站部署能力（缺少配置助手）');
    const spec = parseInboundSpec(command.payload, this.inbound.inboundTag);
    const hash = inboundSpecHash(spec);
    const previous = this.store.getInboundState();
    if (previous && isOlderRevision(command.targetRevision, previous.appliedRevision)) {
      throw new Error('拒绝执行过期的 ENSURE_INBOUND revision');
    }

    // Re-issuing the same spec must not restart Xray: a restart drops every
    // live connection and every gRPC-provisioned user. Verify the running
    // instance instead and answer from what was applied last time.
    if (previous?.hash === hash && !spec.rotateKeys && await this.xray.inboundLive()) {
      const report = { ...(previous.report as unknown as InboundReport), changed: false, liveVerifiedAt: new Date().toISOString() };
      this.store.setInboundState({ hash, report: report as unknown as Record<string, unknown>, appliedRevision: command.targetRevision });
      return report;
    }

    const requestId = randomUUID();
    const applied = await this.inbound.applier.apply(spec, requestId);
    if (applied.listenPort !== spec.listenPort) {
      throw new Error(`配置助手部署的端口 ${applied.listenPort} 与下发的 ${spec.listenPort} 不一致`);
    }
    if (!spec.serverNames.includes(applied.serverName)) {
      throw new Error(`配置助手返回的 serverName ${applied.serverName} 不在下发列表中`);
    }
    await this.waitForInbound(this.inbound.verifyAttempts ?? 15, this.inbound.verifyDelayMs ?? 1_000);
    // A restart wipes users added over gRPC — they live only in Xray's memory.
    if (applied.restarted) await this.reconcile(this.store.listDesiredUsers());

    const report: InboundReport = {
      requestId,
      inboundTag: spec.inboundTag,
      serverHost: await this.inbound.resolvePublicHost(),
      serverPort: spec.listenPort,
      realityPublicKey: applied.realityPublicKey,
      shortId: applied.shortId,
      serverName: applied.serverName,
      flow: spec.flow,
      fingerprint: spec.fingerprint,
      spiderX: spec.spiderX,
      xrayVersion: applied.xrayVersion,
      changed: applied.changed,
      liveVerifiedAt: new Date().toISOString(),
    };
    this.store.setInboundState({ hash, report: report as unknown as Record<string, unknown>, appliedRevision: command.targetRevision });
    return report;
  }

  /** A restart is not instant; give the new inbound a bounded window to appear. */
  private async waitForInbound(attempts: number, delayMs: number): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        await this.xray.health();
        if (await this.xray.inboundLive()) return;
        lastError = new Error('Xray 已启动但未加载目标入站 tag');
      } catch (error) { lastError = error; }
      await new Promise((done) => setTimeout(done, delayMs));
    }
    throw new Error(`入站部署后未能确认生效：${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  private resolveUser(command: AgentCommand): DesiredUser {
    const stored = this.findStored(command.payload);
    if (stored) {
      return {
        ...stored,
        email: optionalString(command.payload.email) || optionalString(command.payload.userKey) || stored.email,
        uuid: optionalString(command.payload.uuid) || stored.uuid,
        flow: parseFlow(command.payload.flow) ?? stored.flow,
      };
    }
    return parseDesiredUser(command.payload, command.targetRevision);
  }

  private resolveTerminalTarget(payload: Record<string, unknown>): { bindingId: string; email: string } {
    return {
      bindingId: stringField(payload, 'bindingId'),
      email: optionalString(payload.email) || stringField(payload, 'userKey'),
    };
  }

  private findStored(payload: Record<string, unknown>): DesiredUser | undefined {
    const bindingId = optionalString(payload.bindingId);
    const email = optionalString(payload.email) || optionalString(payload.userKey);
    return this.store.listDesiredUsers().find((user) =>
      (bindingId && user.bindingId === bindingId) || (email && user.email === email));
  }

  async reconcile(users: DesiredUser[]): Promise<void> {
    const actual = await this.xray.listUsers();
    const desiredByEmail = new Map(users.map((user) => [user.email, user]));
    for (const user of users) {
      this.store.upsertDesiredUser(user);
      if (user.enabled) await this.xray.ensureUser(user);
      else await this.xray.removeUser(user.email);
    }
    for (const user of actual) if (!desiredByEmail.has(user.email)) await this.xray.removeUser(user.email);
  }
}

function isOlderRevision(candidate: string, current: string): boolean {
  return BigInt(candidate) < BigInt(current);
}

function parseDesiredUser(value: unknown, revision: string): DesiredUser {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('命令缺少有效用户 payload');
  const item = value as Record<string, unknown>;
  return {
    bindingId: stringField(item, 'bindingId'),
    revision: optionalString(item.revision) || revision,
    email: optionalString(item.email) || stringField(item, 'userKey'),
    uuid: stringField(item, 'uuid'),
    flow: parseFlow(item.flow) || '',
    enabled: item.enabled !== false,
    quotaRemainingBytes: optionalString(item.quotaRemainingBytes) || '0',
    offlineAllowanceBytes: optionalString(item.offlineAllowanceBytes) || String(64 * 1024 * 1024),
  };
}

function parseFlow(value: unknown): 'xtls-rprx-vision' | '' | undefined {
  if (value === undefined) return undefined;
  if (value === '' || value === 'xtls-rprx-vision') return value;
  throw new Error('flow 仅支持 xtls-rprx-vision 或空字符串');
}

function stringField(value: Record<string, unknown>, field: string): string {
  const result = optionalString(value[field]);
  if (!result) throw new Error(`命令缺少 ${field}`);
  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
