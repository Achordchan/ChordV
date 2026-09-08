import { randomUUID } from 'node:crypto';
import { isIPv6 } from 'node:net';
import { isPublicUnicastAddress } from './public-address.js';
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

    // Everything goes through the helper — the agent never answers from its own
    // memory. The helper owns the truth (its state file, the config on disk and
    // whether Xray is serving), and it is the only side that can tell a genuine
    // no-op from "someone restored an older config behind our back": a live tag
    // says nothing about which port or key is actually deployed. A true no-op
    // costs one request round trip and never restarts Xray.
    // Resolve the address clients will dial BEFORE anything touches Xray. A
    // broken override or an unreachable control plane must fail while the node
    // still serves its previous inbound — discovering it after the helper has
    // restarted Xray would leave clients dialling the old port and key while
    // the machine serves the new ones.
    const serverHost = await this.resolvePublicHost();
    const requestId = randomUUID();
    // Record the INTENT before handing off: once the helper has the request the
    // machine may change whether or not this process ever learns the outcome (a
    // timeout, a lost result file, a crash). Anything but "this exact spec, and
    // it completed" must therefore lead back through the helper rather than be
    // answered from memory.
    this.store.setInboundState({ hash, report: {}, appliedRevision: command.targetRevision, complete: false });
    const applied = await this.inbound.applier.apply(spec, requestId, command.commandId, requiredListen(serverHost));
    if (applied.listenPort !== spec.listenPort) {
      throw new Error(`配置助手部署的端口 ${applied.listenPort} 与下发的 ${spec.listenPort} 不一致`);
    }
    if (!spec.serverNames.includes(applied.serverName)) {
      throw new Error(`配置助手返回的 serverName ${applied.serverName} 不在下发列表中`);
    }
    await this.waitForInbound(this.inbound.verifyAttempts ?? 15, this.inbound.verifyDelayMs ?? 1_000);
    // The helper refuses a family it cannot serve before publishing, so this is
    // a consistency check on its answer rather than a late failure path.
    if (requiredListen(serverHost) && applied.listen !== requiredListen(serverHost)) {
      throw new Error(`本机对外地址是 IPv6（${serverHost}），但入站监听 ${applied.listen || '未知地址'}`);
    }
    // Users added over gRPC live only in Xray's memory, so a restart empties
    // them. Reconcile on EVERY apply, not only when this call restarted: a
    // previous attempt may have restarted and then failed before (or during)
    // its own reconcile, and the helper answers a repeat with restarted:false.
    const stored = this.store.listDesiredUsers();
    // The ordered flow becomes Node.flow, so every client config will use it.
    // Users already installed in Xray carry the OLD flow, and Xray cannot be
    // asked which flow a user has — so a change is applied by removing them
    // first and letting the reconcile below re-add them with the new one. The
    // deployment's revision carries the change, otherwise the store keeps the
    // higher-revision row it already has.
    const flowChanged = stored.some((user) => (user.flow ?? '') !== spec.flow);
    const users = flowChanged
      ? stored.map((user) => ({ ...user, flow: spec.flow as typeof user.flow }))
      : stored;
    if (flowChanged) {
      for (const user of users) await this.xray.removeUser(user.email);
      // Persist the flow WITHOUT a revision: a user whose revision is already
      // higher than this deployment's would have an upsert rejected, and Xray
      // would then run a flow the store does not know about.
      for (const user of users) this.store.setUserFlow(user.bindingId, user.flow);
    }
    await this.reconcile(users);

    const report: InboundReport = {
      requestId,
      inboundTag: spec.inboundTag,
      serverHost,
      serverPort: spec.listenPort,
      realityPublicKey: applied.realityPublicKey,
      shortId: applied.shortId,
      serverName: applied.serverName,
      flow: spec.flow,
      fingerprint: spec.fingerprint,
      spiderX: spec.spiderX,
      listen: applied.listen,
      xrayVersion: applied.xrayVersion,
      changed: applied.changed,
      liveVerifiedAt: new Date().toISOString(),
    };
    this.store.setInboundState({ hash, report: report as unknown as Record<string, unknown>, appliedRevision: command.targetRevision, complete: true });
    return report;
  }

  /**
   * The address clients will dial. Resolved and validated before Xray is
   * touched: the control plane rejects a non-public address anyway, but a
   * command that gets that far has already restarted Xray and then fails,
   * leaving clients on the old endpoint while the machine serves the new one.
   * The server remains the authority; this copy just fails early and names the
   * value and the override that fixes it.
   */
  private async resolvePublicHost(): Promise<string> {
    const serverHost = await this.inbound!.resolvePublicHost();
    if (!isPublicUnicastAddress(serverHost)) {
      throw new Error(
        `本机对外地址 ${serverHost || '(空)'} 不是可用的公网单播地址：`
          + '请检查反向代理的来源地址，或用 CHORDV_NODE_PUBLIC_HOST 显式指定',
      );
    }
    return serverHost;
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

/**
 * The listen address this node's public endpoint requires. An IPv6 endpoint in
 * front of an IPv4-only listener passes every tag-based check and hands each
 * client a port nothing listens on; an IPv4 endpoint works on either listener,
 * so it imposes nothing.
 */
function requiredListen(serverHost: string): string {
  return isIPv6(serverHost.trim().replace(/^\[|\]$/g, '')) ? '::' : '';
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
