import { isNodeControlMode, type AgentCommand, type CommandResult, type DesiredUser } from './types.js';
import type { AgentStore } from './store.js';
import type { XrayAdapter } from './xray-adapter.js';

export class CommandProcessor {
  constructor(private readonly store: AgentStore, private readonly xray: XrayAdapter) {}

  async execute(command: AgentCommand, writable: boolean): Promise<CommandResult> {
    const previous = this.store.beginCommand(command);
    if (previous) return previous;
    let result: CommandResult;
    try {
      await this.apply(command, writable);
      this.store.advanceConfigRevision(command.targetRevision);
      result = {
        commandId: command.commandId,
        status: 'completed',
        result: { appliedRevision: command.targetRevision },
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

  private async apply(command: AgentCommand, writable: boolean): Promise<void> {
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
      }
    }
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
