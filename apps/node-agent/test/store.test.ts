import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentStore } from '../src/store.js';
import type { DesiredUser } from '../src/types.js';

const MIB = 1024n * 1024n;

function createStore(directory: string, bootId = 'boot-1'): AgentStore {
  return new AgentStore(join(directory, 'agent.db'), {
    nodeId: 'node-1', bootId, defaultOfflineAllowanceBytes: 64n * MIB,
  });
}

function withStore(run: (store: AgentStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'chordv-agent-'));
  const store = createStore(directory);
  try { run(store); }
  finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
}

function user(overrides: Partial<DesiredUser> = {}): DesiredUser {
  return {
    bindingId: 'binding-1', revision: '1', email: 'user@example.com',
    uuid: '11111111-1111-4111-8111-111111111111', flow: 'xtls-rprx-vision',
    enabled: true, quotaRemainingBytes: String(1024n * MIB),
    offlineAllowanceBytes: String(64n * MIB), ...overrides,
  };
}

test('SQLite 使用 WAL，首次绝对计数只建立基线但会发送基线样本', () => withStore((store) => {
  store.replaceDesiredUsers([user()], '1');
  const result = store.recordSample([
    { email: user().email, uplinkBytes: '90071992547409930', downlinkBytes: '20' },
  ], new Date('2026-07-26T00:00:00Z'), true);
  assert.equal(store.healthSnapshot().journalMode, 'wal');
  assert.equal(result.batch?.sequence, '1');
  assert.deepEqual(result.batch?.samples[0], {
    bindingId: 'binding-1', counterGeneration: '0',
    uplinkBytes: '90071992547409930', downlinkBytes: '20',
    uplinkDeltaBytes: '0', downlinkDeltaBytes: '0',
  });
}));

test('批次包含绝对值与增量，ackThrough 使用十进制字符串', () => withStore((store) => {
  store.replaceDesiredUsers([user()], '1');
  store.recordSample([{ email: user().email, uplinkBytes: '100', downlinkBytes: '200' }], new Date('2026-07-26T00:00:00Z'), true);
  const result = store.recordSample([{ email: user().email, uplinkBytes: '130', downlinkBytes: '270' }], new Date('2026-07-26T00:00:05Z'), true);
  assert.deepEqual(result.batch?.samples[0], {
    bindingId: 'binding-1', counterGeneration: '0', uplinkBytes: '130', downlinkBytes: '270',
    uplinkDeltaBytes: '30', downlinkDeltaBytes: '70',
  });
  assert.deepEqual(store.listPendingBatches().map((batch) => batch.sequence), ['1', '2']);
  assert.equal(store.ackThrough('boot-1', '1'), 1);
  assert.deepEqual(store.listPendingBatches().map((batch) => batch.sequence), ['2']);
}));

test('计数没有变化时仍发送完整绝对快照，保证切换基线新鲜', () => withStore((store) => {
  store.replaceDesiredUsers([user()], '1');
  store.recordSample([{ email: user().email, uplinkBytes: '100', downlinkBytes: '200' }], new Date('2026-07-26T00:00:00Z'), true);
  const result = store.recordSample([{ email: user().email, uplinkBytes: '100', downlinkBytes: '200' }], new Date('2026-07-26T00:00:05Z'), true);
  assert.equal(result.batch?.sequence, '2');
  assert.deepEqual(result.batch?.samples[0], {
    bindingId: 'binding-1', counterGeneration: '0', uplinkBytes: '100', downlinkBytes: '200',
    uplinkDeltaBytes: '0', downlinkDeltaBytes: '0',
  });
}));

test('Xray 计数回退创建新 generation，并计入新代首样本', () => withStore((store) => {
  store.replaceDesiredUsers([user()], '1');
  store.recordSample([{ email: user().email, uplinkBytes: '1000', downlinkBytes: '2000' }], new Date(), true);
  const result = store.recordSample([{ email: user().email, uplinkBytes: '40', downlinkBytes: '60' }], new Date(), true);
  assert.deepEqual(result.batch?.samples[0], {
    bindingId: 'binding-1', counterGeneration: '1', uplinkBytes: '40', downlinkBytes: '60',
    uplinkDeltaBytes: '40', downlinkDeltaBytes: '60',
  });
  assert.equal(store.listDesiredUsers()[0]?.quotaRemainingBytes, String(1024n * MIB - 100n));
}));

test('后台断联累计达到 64 MiB 后本地停用用户', () => withStore((store) => {
  store.replaceDesiredUsers([user()], '1');
  store.recordSample([{ email: user().email, uplinkBytes: '0', downlinkBytes: '0' }], new Date(), false);
  const result = store.recordSample([{ email: user().email, uplinkBytes: String(64n * MIB), downlinkBytes: '0' }], new Date(), false);
  assert.deepEqual(result.disableEmails, [user().email]);
  assert.equal(store.listDesiredUsers()[0]?.enabled, false);
}));

test('超大 revision 使用 BigInt 比较，重复快照不恢复本地配额', () => withStore((store) => {
  const revision = '900719925474099312345';
  store.replaceDesiredUsers([user({ revision, quotaRemainingBytes: '1000' })], revision);
  store.recordSample([{ email: user().email, uplinkBytes: '0', downlinkBytes: '0' }], new Date(), false);
  store.recordSample([{ email: user().email, uplinkBytes: '100', downlinkBytes: '0' }], new Date(), false);
  store.replaceDesiredUsers([user({ revision, quotaRemainingBytes: '1000' })], revision);
  assert.equal(store.listDesiredUsers()[0]?.quotaRemainingBytes, '900');
  assert.equal(store.getConfigRevision(), revision);
}));

test('重启保留未确认批次、控制模式和绑定配置', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chordv-agent-restart-'));
  const first = createStore(directory, 'boot-1');
  first.applyConfigSnapshot({ nodeId: 'node-1', revision: '8', controlMode: 'direct_primary', users: [user({ revision: '8' })] });
  first.recordSample([{ email: user().email, uplinkBytes: '1', downlinkBytes: '2' }], new Date(), true);
  first.close();
  const restarted = createStore(directory, 'boot-2');
  try {
    assert.equal(restarted.listPendingBatches()[0]?.bootId, 'boot-1');
    assert.equal(restarted.getConfigSnapshot().controlMode, 'direct_primary');
    assert.equal(restarted.getConfigSnapshot().users[0]?.bindingId, 'binding-1');
  } finally { restarted.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('每个 boot 的批次序号从 1 开始，旧 boot 按写入顺序优先上传且可按确认值清理', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chordv-agent-boot-sequence-'));
  const first = createStore(directory, 'boot-1');
  first.replaceDesiredUsers([user()], '1');
  first.recordSample([{ email: user().email, uplinkBytes: '10', downlinkBytes: '0' }], new Date('2026-07-26T00:00:00Z'), true);
  first.recordSample([{ email: user().email, uplinkBytes: '20', downlinkBytes: '0' }], new Date('2026-07-26T00:00:05Z'), true);
  first.close();

  const restarted = createStore(directory, 'boot-2');
  try {
    const current = restarted.recordSample(
      [{ email: user().email, uplinkBytes: '30', downlinkBytes: '0' }],
      new Date('2026-07-26T00:00:10Z'),
      true
    );
    assert.equal(current.batch?.bootId, 'boot-2');
    assert.equal(current.batch?.sequence, '1');
    assert.deepEqual(restarted.listPendingBatches().map((batch) => `${batch.bootId}:${batch.sequence}`), [
      'boot-1:1',
      'boot-1:2',
      'boot-2:1'
    ]);
    assert.equal(restarted.ackThrough('boot-1', '2'), 2);
    assert.deepEqual(restarted.listPendingBatches().map((batch) => `${batch.bootId}:${batch.sequence}`), ['boot-2:1']);
  } finally {
    restarted.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('拒绝加载其他节点的配置快照', () => withStore((store) => {
  assert.throws(() => store.applyConfigSnapshot({
    nodeId: 'other-node', revision: '1', controlMode: 'shadow_direct', users: [],
  }), /nodeId/);
}));

test('拒绝用旧 revision 配置快照覆盖较新的本地状态', () => withStore((store) => {
  store.applyConfigSnapshot({ nodeId: 'node-1', revision: '10', controlMode: 'direct_primary', users: [user({ revision: '10' })] });
  const applied = store.applyConfigSnapshot({ nodeId: 'node-1', revision: '9', controlMode: 'shadow_direct', users: [] });
  assert.equal(applied, false);
  assert.equal(store.getConfigRevision(), '10');
  assert.equal(store.getConfigSnapshot().controlMode, 'direct_primary');
  assert.equal(store.listDesiredUsers().length, 1);
}));
