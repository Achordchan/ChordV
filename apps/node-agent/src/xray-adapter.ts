import { XtlsApi } from '@remnawave/xtls-sdk';
import type { AbsoluteCounter, DesiredUser } from './types.js';

export interface XrayAdapter {
  health(): Promise<void>;
  readAbsoluteCounters(): Promise<AbsoluteCounter[]>;
  listUsers(): Promise<Array<{ email: string; uuid?: string }>>;
  ensureUser(user: DesiredUser): Promise<void>;
  removeUser(email: string): Promise<void>;
}

function integerString(value: number, label: string): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} 不是安全的非负整数，拒绝进行可能失真的计量`);
  }
  return String(value);
}

export class XtlsXrayAdapter implements XrayAdapter {
  private readonly api: XtlsApi;

  constructor(connectionUrl: string, private readonly inboundTag: string) {
    this.api = new XtlsApi({ connectionUrl });
  }

  async health(): Promise<void> {
    const result = await this.api.stats.getSysStats();
    if (!result.isOk) throw new Error(result.message || 'Xray StatsService 不可用');
  }

  async readAbsoluteCounters(): Promise<AbsoluteCounter[]> {
    const [statsResult, users] = await Promise.all([
      this.api.stats.getAllUsersStats(false),
      this.listUsers(),
    ]);
    if (!statsResult.isOk || !statsResult.data) {
      throw new Error(statsResult.message || '读取 Xray 用户计数失败');
    }
    return mergeInboundUsersWithStats(users, statsResult.data.users);
  }

  async listUsers(): Promise<Array<{ email: string; uuid?: string }>> {
    const result = await this.api.handler.getInboundUsers(this.inboundTag);
    if (!result.isOk || !result.data) throw new Error(result.message || '读取 Xray 入站用户失败');
    return result.data.users.map((user) => ({
      email: user.username,
      uuid: user.vless?.id,
    }));
  }

  async ensureUser(user: DesiredUser): Promise<void> {
    const users = await this.listUsers();
    const existing = users.find((item) => item.email === user.email);
    if (existing?.uuid === user.uuid) return;
    if (existing) await this.removeUser(user.email);
    const result = await this.api.handler.addVlessUser({
      tag: this.inboundTag,
      username: user.email,
      uuid: user.uuid,
      flow: user.flow || '',
      level: 0,
    });
    if (!result.isOk || !result.data?.isAdded) {
      throw new Error(result.message || `创建用户 ${user.email} 失败`);
    }
  }

  async removeUser(email: string): Promise<void> {
    const users = await this.listUsers();
    if (!users.some((item) => item.email === email)) return;
    const result = await this.api.handler.removeUser(this.inboundTag, email);
    if (!result.isOk || !result.data?.isDeleted) {
      throw new Error(result.message || `移除用户 ${email} 失败`);
    }
  }
}

export function mergeInboundUsersWithStats(
  inboundUsers: Array<{ email: string }>,
  statsUsers: Array<{ username: string; uplink: number; downlink: number }>,
): AbsoluteCounter[] {
  const statsByEmail = new Map(statsUsers.map((user) => [user.username, user]));
  return inboundUsers.map((user) => {
    const stats = statsByEmail.get(user.email);
    return {
      email: user.email,
      uplinkBytes: integerString(stats?.uplink ?? 0, `${user.email} uplink`),
      downlinkBytes: integerString(stats?.downlink ?? 0, `${user.email} downlink`),
    };
  });
}
