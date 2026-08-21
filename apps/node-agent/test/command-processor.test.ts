import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CommandProcessor } from '../src/command-processor.js';
import { AgentStore } from '../src/store.js';
import type { AbsoluteCounter, AgentCommand, DesiredUser } from '../src/types.js';
import type { XrayAdapter } from '../src/xray-adapter.js';

class FakeXray implements XrayAdapter {
  users = new Map<string, string>();
  ensureCalls = 0;
  async health(): Promise<void> {}
  async readAbsoluteCounters(): Promise<AbsoluteCounter[]> { return []; }
  async listUsers(): Promise<Array<{ email: string; uuid?: string }>> { return [...this.users].map(([email, uuid]) => ({ email, uuid })); }
  async ensureUser(user: DesiredUser): Promise<void> {
    if (this.users.get(user.email) === user.uuid) return;
    this.ensureCalls += 1; this.users.set(user.email, user.uuid);
  }
  async removeUser(email: string): Promise<void> { this.users.delete(email); }
}

class FlakyXray extends FakeXray {
  failNext = true;
  override async ensureUser(user: DesiredUser): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('temporary Xray failure');
    }
    await super.ensureUser(user);
  }
}

function desired(email = 'user@example.com'): DesiredUser {
  return { bindingId: `binding-${email}`, revision: '1', email,
    uuid: '11111111-1111-4111-8111-111111111111', flow: 'xtls-rprx-vision', enabled: true,
    quotaRemainingBytes: '1000000', offlineAllowanceBytes: '67108864' };
}

function command(type: AgentCommand['type'], payload: Record<string, unknown>, id = 'command-1', targetRevision = '900719925474099312345'): AgentCommand {
  return { commandId: id, type, targetRevision, payload, createdAt: '2026-07-26T00:00:00Z' };
}

function setup(): { directory: string; store: AgentStore; xray: FakeXray; processor: CommandProcessor } {
  const directory = mkdtempSync(join(tmpdir(), 'chordv-command-'));
  const store = new AgentStore(join(directory, 'agent.db'), {
    nodeId: 'node', bootId: 'boot', defaultOfflineAllowanceBytes: 64n * 1024n * 1024n,
  });
  const xray = new FakeXray();
  return { directory, store, xray, processor: new CommandProcessor(store, xray) };
}

test('commandId 幂等且 targetRevision 保持字符串', async () => {
  const fixture = setup();
  fixture.store.replaceDesiredUsers([desired()], '1');
  const input = command('ENSURE_USER', { bindingId: desired().bindingId, email: desired().email, uuid: desired().uuid, flow: desired().flow });
  try {
    const first = await fixture.processor.execute(input, true);
    const repeated = await fixture.processor.execute(input, true);
    assert.equal(first.status, 'completed');
    assert.deepEqual(repeated, first);
    assert.equal(fixture.xray.ensureCalls, 1);
    assert.equal(first.result?.appliedRevision, input.targetRevision);
  } finally { fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true }); }
});

test('shadow_direct 拒绝写 Xray，但允许 REFRESH_QUOTA', async () => {
  const fixture = setup(); fixture.store.replaceDesiredUsers([desired()], '1');
  try {
    const write = await fixture.processor.execute(command('ENSURE_USER', { bindingId: desired().bindingId }, 'write'), false);
    const quota = await fixture.processor.execute(command('REFRESH_QUOTA', {
      bindingId: desired().bindingId, quotaRemainingBytes: '500',
    }, 'quota'), false);
    assert.equal(write.status, 'failed');
    assert.equal(quota.status, 'completed');
    assert.equal(fixture.store.listDesiredUsers()[0]?.quotaRemainingBytes, '500');
  } finally { fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true }); }
});

test('失败命令使用相同 commandId 重投后会重新执行，完成命令仍保持幂等', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chordv-command-retry-'));
  const store = new AgentStore(join(directory, 'agent.db'), {
    nodeId: 'node', bootId: 'boot', defaultOfflineAllowanceBytes: 64n * 1024n * 1024n,
  });
  const xray = new FlakyXray();
  const processor = new CommandProcessor(store, xray);
  store.replaceDesiredUsers([desired()], '1');
  const input = command('ENSURE_USER', {
    bindingId: desired().bindingId,
    email: desired().email,
    uuid: desired().uuid,
    flow: desired().flow,
  }, 'retry-command');
  try {
    assert.equal((await processor.execute(input, true)).status, 'failed');
    assert.equal((await processor.execute(input, true)).status, 'completed');
    assert.equal((await processor.execute(input, true)).status, 'completed');
    assert.equal(xray.ensureCalls, 1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('过期用户命令不得对 Xray 产生副作用', async () => {
  const fixture = setup();
  const disabled = { ...desired(), revision: '10', enabled: false };
  fixture.store.replaceDesiredUsers([disabled], '10');
  try {
    const staleEnable = await fixture.processor.execute(command('ENSURE_USER', {
      bindingId: disabled.bindingId,
      email: disabled.email,
      uuid: disabled.uuid,
      flow: disabled.flow,
    }, 'stale-enable', '9'), true);
    assert.equal(staleEnable.status, 'completed');
    assert.equal(fixture.xray.users.has(disabled.email), false, '过期 ENSURE_USER 不得重新添加已停用用户');
    assert.equal(fixture.store.listDesiredUsers()[0]?.enabled, false);
    await fixture.processor.execute(command('ENABLE_USER', {
      bindingId: disabled.bindingId,
      email: disabled.email,
      uuid: disabled.uuid,
      flow: disabled.flow,
    }, 'equal-enable', '10'), true);
    assert.equal(fixture.xray.users.has(disabled.email), false, '相同 revision 的启用命令不得绕过本地配额停用');

    const enabled = { ...disabled, revision: '20', enabled: true };
    fixture.store.replaceDesiredUsers([enabled], '20');
    fixture.xray.users.set(enabled.email, enabled.uuid);
    await fixture.processor.execute(command('DISABLE_USER', { bindingId: enabled.bindingId }, 'stale-disable', '19'), true);
    await fixture.processor.execute(command('REMOVE_USER', { bindingId: enabled.bindingId }, 'stale-remove', '18'), true);
    assert.equal(fixture.xray.users.has(enabled.email), true, '过期停用或删除命令不得移除较新 revision 的用户');
    assert.equal(fixture.store.listDesiredUsers()[0]?.enabled, true);
  } finally { fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true }); }
});

test('用户已被新配置删除后旧启用命令仍不得重新创建', async () => {
  const fixture = setup();
  fixture.store.applyConfigSnapshot({ nodeId: 'node', revision: '10', controlMode: 'direct_primary', users: [] });
  try {
    const staleEnable = await fixture.processor.execute(command('ENABLE_USER', {
      bindingId: desired().bindingId,
      email: desired().email,
      uuid: desired().uuid,
      flow: desired().flow,
      quotaRemainingBytes: desired().quotaRemainingBytes,
      offlineAllowanceBytes: desired().offlineAllowanceBytes,
    }, 'removed-stale-enable', '9'), true);
    assert.equal(staleEnable.status, 'completed');
    assert.equal(fixture.store.listDesiredUsers().length, 0);
    assert.equal(fixture.xray.users.size, 0);
  } finally { fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true }); }
});

test('RECONCILE_USERS 清除未知用户', async () => {
  const fixture = setup(); fixture.xray.users.set('unknown@example.com', 'unknown');
  try {
    const result = await fixture.processor.execute(command('RECONCILE_USERS', {
      controlMode: 'direct_primary', users: [desired()],
    }), true);
    assert.equal(result.status, 'completed');
    assert.deepEqual([...fixture.xray.users], [[desired().email, desired().uuid]]);
  } finally { fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true }); }
});

test('非 direct 模式 RECONCILE 只更新本地状态，不写 Xray', async () => {
  for (const controlMode of ['shadow_direct', 'xui_primary', 'rollback_pending'] as const) {
    const fixture = setup();
    fixture.xray.users.set('untouched@example.com', 'existing');
    try {
      const result = await fixture.processor.execute(command('RECONCILE_USERS', {
        controlMode, users: [desired()],
      }, `reconcile-${controlMode}`), false);
      assert.equal(result.status, 'completed');
      assert.equal(fixture.store.getConfigSnapshot().controlMode, controlMode);
      assert.deepEqual([...fixture.xray.users], [['untouched@example.com', 'existing']]);
    } finally { fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true }); }
  }
});
