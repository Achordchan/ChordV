import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { AgentApiClient } from '../src/api-client.js';
import type { AgentConfig } from '../src/config.js';
import { AgentRunner } from '../src/runner.js';
import { AgentStore } from '../src/store.js';
import type { AgentConfigSnapshot, DesiredUser } from '../src/types.js';
import type { XrayAdapter } from '../src/xray-adapter.js';

/**
 * A node can be rolled back from the Go agent to this one on the SAME data
 * directory. The Go agent does one thing this agent has no notion of: while the
 * control plane is unreachable it cuts a user off once their subscription has
 * run out. Whatever it leaves on disk for that, this agent must still be able
 * to undo — otherwise a rollback strands those users: disabled, with quota
 * left, and not recognised as a decision the node made on its own.
 *
 * The rows below are not written by hand. They are the file the Go agent's own
 * suite holds its store to (TestAnExpiryCutoffIsTheRowTheNodeAgentIsTestedAgainst
 * in apps/agent/internal/store): that side proves the file is what an offline
 * expiry really leaves, this side proves this agent releases it.
 */
const fixturePath = fileURLToPath(
  new URL('../../agent/internal/store/testdata/offline-expiry-cutoff.json', import.meta.url),
);

type FixtureRow = Record<string, string | number>;
interface Fixture {
  addedColumns: Record<string, string>;
  rows: FixtureRow[];
}

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;

const storeOptions = { nodeId: 'node-1', bootId: 'boot-node', defaultOfflineAllowanceBytes: 64n * 1024n * 1024n };

/**
 * Builds the database the way a rollback finds it: created by this agent's
 * schema, since extended and written by the Go agent.
 */
function rolledBackDatabase(directory: string): string {
  const path = join(directory, 'agent.db');
  const created = new AgentStore(path, { ...storeOptions, bootId: 'boot-before' });
  created.applyConfigSnapshot({ nodeId: 'node-1', revision: '1', controlMode: 'direct_primary', users: [] });
  created.close();

  const raw = new Database(path);
  try {
    for (const [column, definition] of Object.entries(fixture.addedColumns)) {
      assert.match(column, /^[a-z_]+$/);
      raw.exec(`ALTER TABLE desired_users_v2 ADD COLUMN ${column} ${definition}`);
    }
    for (const row of fixture.rows) {
      const columns = [...Object.keys(row), 'updated_at'];
      for (const column of columns) assert.match(column, /^[a-z_]+$/);
      raw.prepare(
        `INSERT INTO desired_users_v2(${columns.join(', ')}) VALUES(${columns.map(() => '?').join(', ')})`,
      ).run(...Object.values(row), '2026-09-09T12:00:00.000Z');
    }
  } finally {
    raw.close();
  }
  return path;
}

/** What the control plane says about the same users once it can be reached. */
function backendStatement(enabled: boolean): DesiredUser[] {
  return fixture.rows.map((row) => ({
    bindingId: String(row.binding_id),
    revision: String(row.revision),
    email: String(row.email),
    uuid: String(row.uuid),
    flow: String(row.flow) as DesiredUser['flow'],
    enabled,
    quotaRemainingBytes: String(row.quota_remaining),
    offlineAllowanceBytes: String(row.offline_allowance),
  }));
}

function withRolledBackStore(run: (store: AgentStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'chordv-agent-rollback-'));
  const store = new AgentStore(rolledBackDatabase(directory), storeOptions);
  try { run(store); }
  finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
}

test('共享样本确实是一次到期停用：有用户、全部停用、都带到期时间', () => {
  assert.equal(fixture.rows.length >= 2, true);
  for (const row of fixture.rows) {
    assert.equal(row.enabled, 0);
    assert.notEqual(row.expires_at, '');
    assert.notEqual(row.quota_remaining, '0');
  }
});

test('回退后本 Agent 把 Go Agent 的到期停用认作本机停用', () => withRolledBackStore((store) => {
  // Both of the predicates this agent classifies a disabled row by.
  assert.equal(store.hasUsageDisabledUsers(), true);
  assert.equal(store.hasOfflineDisabledUsers(), true);
  // And it reads the rows at all: the extra column is not in its way.
  assert.deepEqual(
    store.listDesiredUsers().map((user) => [user.bindingId, user.enabled]),
    backendStatement(false).map((user) => [user.bindingId, false]).sort(),
  );
}));

test('回退后后台仍要这些用户时，同一 revision 即可恢复', () => withRolledBackStore((store) => {
  store.restoreBackendConfirmedUsers(backendStatement(true));
  for (const row of fixture.rows) {
    const restored = store.getUserByBindingId(String(row.binding_id));
    assert.equal(restored?.enabled, 1);
    assert.equal(restored?.offline_used, '0');
    assert.equal(restored?.revision, row.revision);
    // What was metered before the cutoff is still billed.
    assert.equal(restored?.quota_remaining, row.quota_remaining);
  }
  assert.equal(store.hasUsageDisabledUsers(), false);
  assert.equal(store.hasOfflineDisabledUsers(), false);
}));

test('回退后后台确认停用时，用户保持停用且不再算本机停用', () => withRolledBackStore((store) => {
  store.restoreBackendConfirmedUsers(backendStatement(false));
  for (const row of fixture.rows) {
    assert.equal(store.getUserByBindingId(String(row.binding_id))?.enabled, 0);
  }
  assert.equal(store.hasUsageDisabledUsers(), false);
}));

test('回退后本 Agent 照常写入带额外列的表', () => withRolledBackStore((store) => {
  // Its statements name their columns, so the Go agent's one has to default.
  const [first] = backendStatement(true);
  store.applyConfigSnapshot({
    nodeId: 'node-1', revision: '2', controlMode: 'direct_primary',
    users: [
      { ...first, revision: '2' },
      { ...first, bindingId: 'binding-new', email: 'new@chordv', uuid: '33333333-3333-4333-8333-333333333333', revision: '2' },
    ],
  });
  assert.equal(store.getUserByBindingId(first.bindingId)?.enabled, 1);
  assert.equal(store.getUserByBindingId('binding-new')?.enabled, 1);
  assert.equal(store.listDesiredUsers().length, 2);
  const result = store.recordSample(
    [{ email: 'new@chordv', uplinkBytes: '1', downlinkBytes: '2' }], new Date('2026-09-09T12:00:05Z'), true,
  );
  assert.equal(result.disableEmails.length, 0);
}));

/**
 * The other direction. The Go agent's date is tied to the revision it was
 * stated at (expires_revision), because this agent will go on applying commands
 * — a renewal among them — without knowing the date is there. What makes that
 * work is a property of THIS agent's statements, so it is held here, against
 * the real store: every write that moves a binding's revision leaves the Go
 * agent's columns exactly as they were, and therefore no longer equal to it.
 * apps/agent's TestARenewalTheNodeAgentAppliedDoesNotLeaveItsOldExpiryInForce
 * is what the Go agent then does with such a row.
 */
function goAgentColumns(path: string, bindingId: string): Record<string, string> {
  const raw = new Database(path, { readonly: true });
  try {
    const columns = ['revision', ...Object.keys(fixture.addedColumns)];
    return raw.prepare(`SELECT ${columns.join(', ')} FROM desired_users_v2 WHERE binding_id = ?`)
      .get(bindingId) as Record<string, string>;
  } finally {
    raw.close();
  }
}

test('共享样本带有到期时间所属的 revision，且与行的 revision 一致', () => {
  assert.equal('expires_revision' in fixture.addedColumns, true);
  for (const row of fixture.rows) assert.equal(row.expires_revision, row.revision);
});

for (const [name, write] of Object.entries({
  '续费（ENSURE_USER，新 revision）': (store: AgentStore, user: DesiredUser) =>
    store.upsertDesiredUser({ ...user, revision: '2', quotaRemainingBytes: '2147483648' }),
  '配置快照带来新 revision': (store: AgentStore, user: DesiredUser) =>
    store.applyConfigSnapshot({ nodeId: 'node-1', revision: '2', controlMode: 'direct_primary', users: [{ ...user, revision: '2' }] }),
  'REFRESH_QUOTA': (store: AgentStore, user: DesiredUser) => store.updateQuota(user.bindingId, '2147483648', '2'),
  '启用命令': (store: AgentStore, user: DesiredUser) => store.setUserEnabled(user.bindingId, true, '2'),
})) {
  test(`回退期间本 Agent 的写入（${name}）改了 revision，但不碰 Go Agent 的到期列`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'chordv-agent-rollback-'));
    const path = rolledBackDatabase(directory);
    const store = new AgentStore(path, storeOptions);
    try {
      const [user] = backendStatement(true);
      const before = goAgentColumns(path, user.bindingId);
      write(store, user);
      const after = goAgentColumns(path, user.bindingId);
      assert.equal(after.revision, '2');
      assert.equal(after.expires_at, before.expires_at);
      assert.equal(after.expires_revision, before.expires_revision);
      // Which is what tells the Go agent the date is from before this write.
      assert.notEqual(after.expires_revision, after.revision);
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}

test('回退后启动本 Agent：后台可达即把到期停用的用户装回 Xray', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chordv-agent-rollback-runner-'));
  const store = new AgentStore(rolledBackDatabase(directory), storeOptions);
  const snapshot: AgentConfigSnapshot = {
    nodeId: 'node-1', revision: '1', controlMode: 'direct_primary', users: backendStatement(true),
  };
  let live: Array<{ email: string; uuid?: string }> = [];
  let consumeCalls = 0;
  const api = {
    getConfig: async () => snapshot,
    uploadBatch: async () => ({ ackThrough: '0' }),
    heartbeat: async () => ({ ackThrough: '0' }),
    reportCommandResult: async () => undefined,
    consumeEvents: async (_handler: unknown, signal: AbortSignal) => {
      consumeCalls += 1;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
  } as unknown as AgentApiClient;
  const xray: XrayAdapter = {
    health: async () => undefined,
    uptimeSeconds: async () => 1,
    inboundLive: async () => true,
    readAbsoluteCounters: async () => [],
    listUsers: async () => live,
    ensureUser: async (input) => {
      live = [...live.filter((item) => item.email !== input.email), { email: input.email, uuid: input.uuid }];
    },
    removeUser: async (email) => { live = live.filter((item) => item.email !== email); },
  };
  const config: AgentConfig = {
    agentId: 'agent-1', nodeId: 'node-1', token: 'token', apiBaseUrl: 'http://127.0.0.1:3000',
    xrayApiAddress: '127.0.0.1:10085', xrayInboundTag: 'test-in',
    databasePath: join(directory, 'agent.db'), credentialsPath: join(directory, 'credentials.json'),
    inboundRequestDir: join(directory, 'xray'), inboundResultDir: join(directory, 'xray-out'), restartToleranceMs: 2_000,
    sampleIntervalMs: 60_000, heartbeatIntervalMs: 60_000, offlineAllowanceBytes: 64n * 1024n * 1024n,
  };
  const runner = new AgentRunner(config, store, api, xray);

  try {
    await runner.start();
    await waitFor(() => consumeCalls === 1);
    assert.deepEqual(
      live.map((item) => item.email).sort(),
      fixture.rows.map((row) => String(row.email)).sort(),
    );
    for (const row of fixture.rows) {
      assert.equal(store.getUserByBindingId(String(row.binding_id))?.enabled, 1);
    }
    assert.equal(store.hasUsageDisabledUsers(), false);
  } finally {
    await runner.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待条件超时');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
