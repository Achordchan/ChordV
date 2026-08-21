import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type {
  AbsoluteCounter,
  AgentCommand,
  AgentConfigSnapshot,
  CommandResult,
  DesiredUser,
  SampleResult,
  UsageBatch,
} from './types.js';

interface UserRow {
  binding_id: string;
  email: string;
  uuid: string;
  flow: 'xtls-rprx-vision' | '';
  enabled: number;
  revision: string;
  quota_remaining: string;
  offline_allowance: string;
  offline_used: string;
  generation: string;
  counter_initialized: number;
  uplink: string;
  downlink: string;
}

interface BatchRow { sequence: string; payload: string }
interface CommandRow { result: string | null }

export interface StoreOptions {
  bootId: string;
  nodeId: string;
  defaultOfflineAllowanceBytes: bigint;
}

export class AgentStore {
  private readonly db: Database.Database;

  constructor(databasePath: string, private readonly options: StoreOptions) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    this.initializeBoot(options.bootId);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta_v2 (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS desired_users_v2 (
        binding_id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        uuid TEXT NOT NULL,
        flow TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        revision TEXT NOT NULL,
        quota_remaining TEXT NOT NULL,
        offline_allowance TEXT NOT NULL,
        offline_used TEXT NOT NULL DEFAULT '0',
        generation TEXT NOT NULL DEFAULT '0',
        counter_initialized INTEGER NOT NULL DEFAULT 0,
        uplink TEXT NOT NULL DEFAULT '0',
        downlink TEXT NOT NULL DEFAULT '0',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage_batches_v2 (
        boot_id TEXT NOT NULL,
        sequence TEXT NOT NULL,
        sampled_at TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (boot_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS commands_v2 (
        command_id TEXT PRIMARY KEY,
        command_type TEXT NOT NULL,
        target_revision TEXT NOT NULL,
        payload TEXT NOT NULL,
        result TEXT,
        completed_at TEXT
      );
    `);
  }

  close(): void { this.db.close(); }

  private getMeta(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM meta_v2 WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare(`INSERT INTO meta_v2(key, value) VALUES(?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
  }

  private initializeBoot(bootId: string): void {
    this.db.transaction(() => {
      this.setMeta('boot_id', bootId);
      const sequenceKey = this.sequenceKey(bootId);
      if (!this.getMeta(sequenceKey)) this.setMeta(sequenceKey, '1');
    })();
  }

  private sequenceKey(bootId: string): string {
    return `next_sequence:${bootId}`;
  }

  private baselineKey(bootId: string): string {
    return `baseline_emitted:${bootId}`;
  }

  getConfigRevision(): string { return this.getMeta('config_revision') || '0'; }

  advanceConfigRevision(revision: string): void {
    const next = decimal(revision);
    if (BigInt(next) > BigInt(this.getConfigRevision())) this.setMeta('config_revision', next);
  }

  getConfigSnapshot(): AgentConfigSnapshot {
    const mode = this.getMeta('control_mode');
    const controlMode = mode === 'xui_primary' || mode === 'shadow_direct' || mode === 'direct_primary' || mode === 'rollback_pending'
      ? mode
      : 'shadow_direct';
    return {
      nodeId: this.options.nodeId,
      revision: this.getConfigRevision(),
      controlMode,
      users: this.listDesiredUsers(),
    };
  }

  applyConfigSnapshot(snapshot: AgentConfigSnapshot): boolean {
    if (snapshot.nodeId !== this.options.nodeId) throw new Error('Agent 配置 nodeId 与本机凭据不一致');
    const revision = decimal(snapshot.revision);
    if (BigInt(revision) < BigInt(this.getConfigRevision())) return false;
    this.db.transaction(() => {
      this.replaceDesiredUsers(snapshot.users, revision);
      this.setMeta('control_mode', snapshot.controlMode);
      this.setMeta('config_revision', revision);
    })();
    return true;
  }

  replaceDesiredUsers(users: DesiredUser[], revision: string): void {
    this.db.transaction(() => {
      const keep = new Set(users.map((user) => user.bindingId));
      for (const user of users) this.upsertDesiredUser(user);
      const existing = this.db.prepare('SELECT binding_id FROM desired_users_v2').all() as Array<{ binding_id: string }>;
      const remove = this.db.prepare('DELETE FROM desired_users_v2 WHERE binding_id = ?');
      for (const row of existing) if (!keep.has(row.binding_id)) remove.run(row.binding_id);
      this.setMeta('config_revision', decimal(revision));
    })();
  }

  upsertDesiredUser(user: DesiredUser): void {
    const revision = decimal(user.revision);
    const current = this.getUserByBindingId(user.bindingId);
    if (current && BigInt(current.revision) >= BigInt(revision)) return;
    this.db.prepare(`
      INSERT INTO desired_users_v2(
        binding_id, email, uuid, flow, enabled, revision, quota_remaining,
        offline_allowance, offline_used, generation, counter_initialized, uplink, downlink, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, '0', '0', 0, '0', '0', ?)
      ON CONFLICT(binding_id) DO UPDATE SET
        email = excluded.email, uuid = excluded.uuid, flow = excluded.flow,
        enabled = excluded.enabled, revision = excluded.revision,
        quota_remaining = excluded.quota_remaining,
        offline_allowance = excluded.offline_allowance, updated_at = excluded.updated_at
    `).run(
      user.bindingId,
      user.email,
      user.uuid,
      user.flow || '',
      user.enabled ? 1 : 0,
      revision,
      decimal(user.quotaRemainingBytes),
      decimal(user.offlineAllowanceBytes || this.options.defaultOfflineAllowanceBytes.toString()),
      new Date().toISOString(),
    );
  }

  updateQuota(bindingId: string, quotaRemainingBytes: string, revision: string): void {
    const current = this.getUserByBindingId(bindingId);
    if (!current || BigInt(current.revision) > BigInt(decimal(revision))) return;
    this.db.prepare(`UPDATE desired_users_v2 SET quota_remaining = ?, revision = ?, offline_used = '0', updated_at = ?
      WHERE binding_id = ?`).run(decimal(quotaRemainingBytes), decimal(revision), new Date().toISOString(), bindingId);
  }

  setUserEnabled(bindingId: string, enabled: boolean, revision: string): void {
    const current = this.getUserByBindingId(bindingId);
    if (!current || BigInt(current.revision) > BigInt(decimal(revision))) return;
    this.db.prepare(`UPDATE desired_users_v2 SET enabled = ?, revision = ?, updated_at = ? WHERE binding_id = ?`)
      .run(enabled ? 1 : 0, decimal(revision), new Date().toISOString(), bindingId);
  }

  deleteUser(bindingId: string): void { this.db.prepare('DELETE FROM desired_users_v2 WHERE binding_id = ?').run(bindingId); }

  getUserByBindingId(bindingId: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM desired_users_v2 WHERE binding_id = ?').get(bindingId) as UserRow | undefined;
  }

  getUserByEmail(email: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM desired_users_v2 WHERE email = ?').get(email) as UserRow | undefined;
  }

  listDesiredUsers(): DesiredUser[] {
    const rows = this.db.prepare('SELECT * FROM desired_users_v2 ORDER BY email').all() as UserRow[];
    return rows.map(toDesiredUser);
  }

  hasOfflineDisabledUsers(): boolean {
    const rows = this.db.prepare(`SELECT offline_used, offline_allowance FROM desired_users_v2
      WHERE enabled = 0 AND offline_used != '0'`).all() as Array<{ offline_used: string; offline_allowance: string }>;
    return rows.some((row) => BigInt(row.offline_used) >= BigInt(row.offline_allowance));
  }

  hasUsageDisabledUsers(): boolean {
    const rows = this.db.prepare(`SELECT quota_remaining, offline_used, offline_allowance FROM desired_users_v2
      WHERE enabled = 0`).all() as Array<{ quota_remaining: string; offline_used: string; offline_allowance: string }>;
    return rows.some((row) =>
      BigInt(row.quota_remaining) === 0n
      || (BigInt(row.offline_used) > 0n && BigInt(row.offline_used) >= BigInt(row.offline_allowance)));
  }

  restoreBackendConfirmedUsers(users: DesiredUser[]): void {
    this.db.transaction(() => {
      const update = this.db.prepare(`UPDATE desired_users_v2 SET enabled = ?, quota_remaining = ?,
        offline_used = '0', updated_at = ? WHERE binding_id = ?`);
      for (const user of users) {
        const row = this.getUserByBindingId(user.bindingId);
        if (!row) continue;
        const localQuota = BigInt(row.quota_remaining);
        const backendQuota = BigInt(decimal(user.quotaRemainingBytes));
        const confirmedQuota = localQuota < backendQuota ? localQuota : backendQuota;
        const enabled = user.enabled && confirmedQuota > 0n;
        update.run(enabled ? 1 : 0, confirmedQuota.toString(), new Date().toISOString(), user.bindingId);
      }
    })();
  }

  recordSample(counters: AbsoluteCounter[], sampledAt: Date, backendOnline: boolean): SampleResult {
    return this.db.transaction(() => {
      const samples: UsageBatch['samples'] = [];
      const disableEmails: string[] = [];
      const baselineKey = this.baselineKey(this.options.bootId);
      const update = this.db.prepare(`UPDATE desired_users_v2 SET generation = ?, counter_initialized = 1,
        uplink = ?, downlink = ?, quota_remaining = ?, offline_used = ?, enabled = ?, updated_at = ? WHERE binding_id = ?`);

      for (const counter of counters) {
        const row = this.getUserByEmail(counter.email);
        if (!row || row.enabled !== 1) continue;
        const currentUp = BigInt(decimal(counter.uplinkBytes));
        const currentDown = BigInt(decimal(counter.downlinkBytes));
        const previousUp = BigInt(row.uplink);
        const previousDown = BigInt(row.downlink);
        const initialized = row.counter_initialized === 1;
        const rolledBack = initialized && (currentUp < previousUp || currentDown < previousDown);
        const generation = BigInt(row.generation) + (rolledBack ? 1n : 0n);
        // 首次观测只建立迁移基线；已跟踪计数回退时，当前值是新一代自重置后的完整增量。
        // 3X-UI 会周期性重置 Xray 统计，丢弃新代首样本会形成稳定漏量。
        const deltaUp = !initialized ? 0n : rolledBack ? currentUp : currentUp - previousUp;
        const deltaDown = !initialized ? 0n : rolledBack ? currentDown : currentDown - previousDown;
        const delta = deltaUp + deltaDown;
        const quota = BigInt(row.quota_remaining);
        const nextQuota = quota > delta ? quota - delta : 0n;
        const nextOffline = backendOnline ? 0n : BigInt(row.offline_used) + delta;
        const allowance = BigInt(row.offline_allowance);
        const shouldDisable = nextQuota === 0n || (!backendOnline && nextOffline >= allowance);

        update.run(generation.toString(), currentUp.toString(), currentDown.toString(), nextQuota.toString(),
          nextOffline.toString(), shouldDisable ? 0 : 1, sampledAt.toISOString(), row.binding_id);

        samples.push({
          bindingId: row.binding_id,
          counterGeneration: generation.toString(),
          uplinkBytes: currentUp.toString(),
          downlinkBytes: currentDown.toString(),
          uplinkDeltaBytes: deltaUp.toString(),
          downlinkDeltaBytes: deltaDown.toString(),
        });
        if (shouldDisable) disableEmails.push(row.email);
      }

      if (counters.length > 0) this.setMeta(baselineKey, '1');

      if (samples.length === 0) return { batch: null, disableEmails };
      const sequenceKey = this.sequenceKey(this.options.bootId);
      const sequence = BigInt(this.getMeta(sequenceKey) || '1');
      const batch: UsageBatch = {
        bootId: this.options.bootId,
        sequence: sequence.toString(),
        sampledAt: sampledAt.toISOString(),
        samples,
      };
      this.db.prepare(`INSERT INTO usage_batches_v2(boot_id, sequence, sampled_at, payload) VALUES(?, ?, ?, ?)`)
        .run(batch.bootId, batch.sequence, batch.sampledAt, JSON.stringify(batch));
      this.setMeta(sequenceKey, (sequence + 1n).toString());
      return { batch, disableEmails };
    })();
  }

  listPendingBatches(limit = 100): UsageBatch[] {
    const rows = this.db.prepare(`SELECT sequence, payload FROM usage_batches_v2
      ORDER BY rowid LIMIT ?`)
      .all(limit) as BatchRow[];
    return rows.map((row) => JSON.parse(row.payload) as UsageBatch);
  }

  ackThrough(bootId: string, ackThrough: string): number {
    const ack = BigInt(decimal(ackThrough));
    const rows = this.db.prepare('SELECT sequence FROM usage_batches_v2 WHERE boot_id = ?').all(bootId) as Array<{ sequence: string }>;
    const remove = this.db.prepare('DELETE FROM usage_batches_v2 WHERE boot_id = ? AND sequence = ?');
    return this.db.transaction(() => {
      let count = 0;
      for (const row of rows) if (BigInt(row.sequence) <= ack) count += remove.run(bootId, row.sequence).changes;
      return count;
    })();
  }

  pendingBatchCount(): number {
    return (this.db.prepare('SELECT COUNT(*) count FROM usage_batches_v2').get() as { count: number }).count;
  }

  pendingBatchWatermarks(): Array<{ bootId: string; sequenceThrough: string }> {
    const rows = this.db.prepare('SELECT boot_id, sequence FROM usage_batches_v2 ORDER BY rowid')
      .all() as Array<{ boot_id: string; sequence: string }>;
    const watermarks = new Map<string, bigint>();
    for (const row of rows) {
      const sequence = BigInt(row.sequence);
      const current = watermarks.get(row.boot_id);
      if (current === undefined || sequence > current) watermarks.set(row.boot_id, sequence);
    }
    return Array.from(watermarks, ([bootId, sequenceThrough]) => ({ bootId, sequenceThrough: sequenceThrough.toString() }));
  }

  oldestPendingSampledAt(): string | null {
    return (this.db.prepare('SELECT MIN(sampled_at) value FROM usage_batches_v2').get() as { value: string | null }).value;
  }

  beginCommand(command: AgentCommand): CommandResult | null {
    const existing = this.db.prepare('SELECT result FROM commands_v2 WHERE command_id = ?').get(command.commandId) as CommandRow | undefined;
    if (existing?.result) {
      const result = JSON.parse(existing.result) as CommandResult;
      if (result.status === 'completed') return result;
      this.db.prepare(`UPDATE commands_v2 SET command_type = ?, target_revision = ?, payload = ?, result = NULL, completed_at = NULL
        WHERE command_id = ?`).run(command.type, decimal(command.targetRevision), JSON.stringify(command), command.commandId);
      return null;
    }
    this.db.prepare(`INSERT OR IGNORE INTO commands_v2(command_id, command_type, target_revision, payload)
      VALUES(?, ?, ?, ?)`).run(command.commandId, command.type, decimal(command.targetRevision), JSON.stringify(command));
    return null;
  }

  completeCommand(result: CommandResult): void {
    this.db.prepare(`UPDATE commands_v2 SET result = ?, completed_at = ? WHERE command_id = ?`)
      .run(JSON.stringify(result), new Date().toISOString(), result.commandId);
  }

  healthSnapshot(): Record<string, unknown> {
    return {
      journalMode: this.db.pragma('journal_mode', { simple: true }),
      bootId: this.options.bootId,
      configRevision: this.getConfigRevision(),
      desiredUsers: this.listDesiredUsers().length,
      pendingBatches: this.pendingBatchCount(),
      oldestPendingSampledAt: this.oldestPendingSampledAt(),
    };
  }
}

export function decimal(value: string): string {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error(`无效的非负十进制整数字符串: ${value}`);
  return BigInt(value).toString();
}

function toDesiredUser(row: UserRow): DesiredUser {
  return {
    bindingId: row.binding_id,
    revision: row.revision,
    email: row.email,
    uuid: row.uuid,
    flow: row.flow,
    enabled: row.enabled === 1,
    quotaRemainingBytes: row.quota_remaining,
    offlineAllowanceBytes: row.offline_allowance,
  };
}
