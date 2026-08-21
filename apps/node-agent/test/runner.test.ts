import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentApiClient } from '../src/api-client.js';
import type { AgentConfig } from '../src/config.js';
import { AgentRunner } from '../src/runner.js';
import { AgentStore } from '../src/store.js';
import type { AgentConfigSnapshot, DesiredUser } from '../src/types.js';
import type { XrayAdapter } from '../src/xray-adapter.js';

test('后台恢复且离线批次已确认后重新启用 Direct 用户', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chordv-agent-runner-'));
  const store = new AgentStore(join(directory, 'agent.db'), {
    nodeId: 'node-1',
    bootId: 'boot-1',
    defaultOfflineAllowanceBytes: 64n * 1024n * 1024n,
  });
  const desired = user();
  const snapshot: AgentConfigSnapshot = {
    nodeId: 'node-1',
    revision: '1',
    controlMode: 'direct_primary',
    users: [desired],
  };
  store.applyConfigSnapshot(snapshot);
  store.recordSample([{ email: desired.email, uplinkBytes: '0', downlinkBytes: '0' }], new Date(), false);
  store.recordSample([{ email: desired.email, uplinkBytes: '0', downlinkBytes: '67108864' }], new Date(), false);
  store.ackThrough('boot-1', '2');
  assert.equal(store.hasOfflineDisabledUsers(), true);

  let users: Array<{ email: string; uuid?: string }> = [];
  const ensured: string[] = [];
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
    readAbsoluteCounters: async () => [],
    listUsers: async () => users,
    ensureUser: async (input) => {
      ensured.push(input.email);
      users = [{ email: input.email, uuid: input.uuid }];
    },
    removeUser: async (email) => { users = users.filter((item) => item.email !== email); },
  };
  const config: AgentConfig = {
    agentId: 'agent-1',
    nodeId: 'node-1',
    token: 'token',
    apiBaseUrl: 'http://127.0.0.1:3000',
    xrayApiAddress: '127.0.0.1:10085',
    xrayInboundTag: 'test-in',
    databasePath: join(directory, 'agent.db'),
    sampleIntervalMs: 60_000,
    heartbeatIntervalMs: 60_000,
    offlineAllowanceBytes: 64n * 1024n * 1024n,
  };
  const runner = new AgentRunner(config, store, api, xray);

  try {
    await runner.start();
    await waitFor(() => consumeCalls === 1);
    assert.equal(ensured.length >= 1, true);
    assert.equal(ensured.every((email) => email === desired.email), true);
    assert.equal(store.hasOfflineDisabledUsers(), false);
    assert.equal(store.getUserByBindingId(desired.bindingId)?.enabled, 1);
  } finally {
    await runner.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Shadow 心跳发现更高 revision 后刷新完整用户快照且不写 Xray', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chordv-agent-shadow-refresh-'));
  const store = new AgentStore(join(directory, 'agent.db'), {
    nodeId: 'node-1',
    bootId: 'boot-1',
    defaultOfflineAllowanceBytes: 64n * 1024n * 1024n,
  });
  const first = user();
  const second = { ...user(), bindingId: 'binding-2', email: 'second@example.com', uuid: '22222222-2222-4222-8222-222222222222', revision: '2' };
  const initial: AgentConfigSnapshot = { nodeId: 'node-1', revision: '1', controlMode: 'shadow_direct', users: [first] };
  const refreshed: AgentConfigSnapshot = { nodeId: 'node-1', revision: '2', controlMode: 'shadow_direct', users: [first, second] };
  let heartbeatSeen = false;
  let xrayWrites = 0;
  const api = {
    getConfig: async () => heartbeatSeen ? refreshed : initial,
    uploadBatch: async () => ({ ackThrough: '0' }),
    heartbeat: async () => {
      heartbeatSeen = true;
      return { ackThrough: '0', configRevision: '2' };
    },
    reportCommandResult: async () => undefined,
    consumeEvents: async (_handler: unknown, signal: AbortSignal) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
  } as unknown as AgentApiClient;
  const xray: XrayAdapter = {
    health: async () => undefined,
    readAbsoluteCounters: async () => [],
    listUsers: async () => [],
    ensureUser: async () => { xrayWrites += 1; },
    removeUser: async () => { xrayWrites += 1; },
  };
  const runner = new AgentRunner({
    agentId: 'agent-1', nodeId: 'node-1', token: 'token', apiBaseUrl: 'http://127.0.0.1:3000',
    xrayApiAddress: '127.0.0.1:10085', xrayInboundTag: 'test-in', databasePath: join(directory, 'agent.db'),
    sampleIntervalMs: 60_000, heartbeatIntervalMs: 10, offlineAllowanceBytes: 64n * 1024n * 1024n,
  }, store, api, xray);

  try {
    await runner.start();
    await waitFor(() => store.getConfigRevision() === '2');
    assert.equal(store.listDesiredUsers().length, 2);
    assert.equal(xrayWrites, 0);
  } finally {
    await runner.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Direct 配置缩减时先从 Xray 清理已移除用户再替换本地快照', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chordv-agent-direct-reconcile-'));
  const store = new AgentStore(join(directory, 'agent.db'), {
    nodeId: 'node-1', bootId: 'boot-1', defaultOfflineAllowanceBytes: 64n * 1024n * 1024n,
  });
  const kept = user();
  const removed = { ...user(), bindingId: 'binding-2', email: 'removed@example.com', uuid: '22222222-2222-4222-8222-222222222222' };
  store.applyConfigSnapshot({ nodeId: 'node-1', revision: '1', controlMode: 'direct_primary', users: [kept, removed] });
  const snapshot: AgentConfigSnapshot = { nodeId: 'node-1', revision: '2', controlMode: 'direct_primary', users: [{ ...kept, revision: '2' }] };
  let users = [
    { email: kept.email, uuid: kept.uuid },
    { email: removed.email, uuid: removed.uuid },
  ];
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
    readAbsoluteCounters: async () => [],
    listUsers: async () => users,
    ensureUser: async (input) => {
      if (!users.some((item) => item.email === input.email)) users.push({ email: input.email, uuid: input.uuid });
    },
    removeUser: async (email) => { users = users.filter((item) => item.email !== email); },
  };
  const runner = new AgentRunner({
    agentId: 'agent-1', nodeId: 'node-1', token: 'token', apiBaseUrl: 'http://127.0.0.1:3000',
    xrayApiAddress: '127.0.0.1:10085', xrayInboundTag: 'test-in', databasePath: join(directory, 'agent.db'),
    sampleIntervalMs: 60_000, heartbeatIntervalMs: 60_000, offlineAllowanceBytes: 64n * 1024n * 1024n,
  }, store, api, xray);

  try {
    await runner.start();
    await waitFor(() => consumeCalls === 1);
    assert.deepEqual(users.map((item) => item.email), [kept.email]);
    assert.deepEqual(store.listDesiredUsers().map((item) => item.email), [kept.email]);
    assert.equal(store.getConfigRevision(), '2');
  } finally {
    await runner.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('采样耗尽与配置刷新串行执行，最终 Xray 状态保持停用', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chordv-agent-sample-refresh-race-'));
  const store = new AgentStore(join(directory, 'agent.db'), {
    nodeId: 'node-1', bootId: 'boot-1', defaultOfflineAllowanceBytes: 64n * 1024n * 1024n,
  });
  const desired = { ...user(), quotaRemainingBytes: '50' };
  const snapshot: AgentConfigSnapshot = { nodeId: 'node-1', revision: '1', controlMode: 'direct_primary', users: [desired] };
  store.applyConfigSnapshot(snapshot);
  store.recordSample([{ email: desired.email, uplinkBytes: '0', downlinkBytes: '0' }], new Date(), true);
  let releaseListUsers!: () => void;
  const listUsersBlocked = new Promise<void>((resolve) => { releaseListUsers = resolve; });
  let listUsersStarted = false;
  let responseRevision = '1';
  let users: Array<{ email: string; uuid?: string }> = [];
  const api = {
    getConfig: async () => ({
      ...snapshot,
      revision: responseRevision,
      users: snapshot.users.map((item) => ({ ...item, revision: responseRevision }))
    })
  } as unknown as AgentApiClient;
  const xray: XrayAdapter = {
    health: async () => undefined,
    readAbsoluteCounters: async () => [{ email: desired.email, uplinkBytes: '100', downlinkBytes: '0' }],
    listUsers: async () => {
      listUsersStarted = true;
      await listUsersBlocked;
      return users;
    },
    ensureUser: async (input) => { users = [{ email: input.email, uuid: input.uuid }]; },
    removeUser: async (email) => { users = users.filter((item) => item.email !== email); },
  };
  const runner = new AgentRunner({
    agentId: 'agent-1', nodeId: 'node-1', token: 'token', apiBaseUrl: 'http://127.0.0.1:3000',
    xrayApiAddress: '127.0.0.1:10085', xrayInboundTag: 'test-in', databasePath: join(directory, 'agent.db'),
    sampleIntervalMs: 60_000, heartbeatIntervalMs: 60_000, offlineAllowanceBytes: 64n * 1024n * 1024n,
  }, store, api, xray);

  try {
    const refresh = (runner as any).refreshConfig();
    await waitFor(() => listUsersStarted);
    const sample = (runner as any).sample();
    releaseListUsers();
    await Promise.all([refresh, sample]);
    responseRevision = '2';
    await (runner as any).refreshConfig();
    assert.equal(store.listDesiredUsers()[0]?.enabled, false);
    assert.equal(store.getConfigRevision(), '2');
    assert.equal(users.length, 0, '未确认的在线配额耗尽批次存在时，后续配置刷新不得重新启用 Xray 用户');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function user(): DesiredUser {
  return {
    bindingId: 'binding-1',
    revision: '1',
    email: 'user@example.com',
    uuid: '11111111-1111-4111-8111-111111111111',
    flow: 'xtls-rprx-vision',
    enabled: true,
    quotaRemainingBytes: '1073741824',
    offlineAllowanceBytes: '67108864',
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待条件超时');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
