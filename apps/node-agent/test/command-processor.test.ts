import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CommandProcessor } from '../src/command-processor.js';
import { AgentStore } from '../src/store.js';
import type { AbsoluteCounter, AgentCommand, DesiredUser } from '../src/types.js';
import type { XrayAdapter } from '../src/xray-adapter.js';
import type { HelperResult, InboundApplier } from '../src/xray-inbound.js';
import type { InboundSpec } from '../src/types.js';

class FakeXray implements XrayAdapter {
  users = new Map<string, string>();
  ensureCalls = 0;
  uptime = 1;
  live = true;
  async health(): Promise<void> {}
  async uptimeSeconds(): Promise<number> { return this.uptime; }
  async inboundLive(): Promise<boolean> { return this.live; }
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

test('本地用户已被缩减配置删除后移除命令仍可幂等执行', async () => {
  const fixture = setup();
  fixture.store.applyConfigSnapshot({ nodeId: 'node', revision: '10', controlMode: 'direct_primary', users: [] });
  fixture.xray.users.set(desired().email, desired().uuid);
  try {
    const result = await fixture.processor.execute(command('REMOVE_USER', {
      bindingId: desired().bindingId,
      userKey: desired().email,
      email: desired().email,
      uuid: desired().uuid,
    }, 'remove-after-config', '10'), true);
    assert.equal(result.status, 'completed');
    assert.equal(fixture.xray.users.size, 0);
    assert.equal(fixture.store.listDesiredUsers().length, 0);
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

/**
 * Models the real helper closely enough to be worth asserting against: it keeps
 * the deployed spec, so re-issuing the same one is a genuine no-op (no restart)
 * while a different one redeploys. The AGENT no longer decides that — the
 * helper is the only side that can see what is actually deployed.
 */
class FakeApplier implements InboundApplier {
  calls: InboundSpec[] = [];
  commandIds: string[] = [];
  restarts = 0;
  outcome: Partial<HelperResult> = {};
  failure?: Error;
  private deployed?: string;
  async apply(spec: InboundSpec, requestId: string, commandId: string): Promise<HelperResult> {
    this.calls.push(spec);
    this.commandIds.push(commandId);
    if (this.failure) throw this.failure;
    const identity = JSON.stringify({ ...spec, rotateKeys: false });
    const changed = this.deployed !== identity || spec.rotateKeys;
    if (changed) { this.deployed = identity; this.restarts += 1; }
    return {
      requestId, ok: true, changed, restarted: changed,
      realityPublicKey: 'k'.repeat(43), shortId: '0123456789abcdef',
      serverName: spec.serverNames[0], listen: '::', listenPort: spec.listenPort, xrayVersion: 'Xray 1.8.24',
      ...this.outcome,
    };
  }
  async reset(requestId: string): Promise<HelperResult> {
    return { requestId, ok: true, changed: true, restarted: true, realityPublicKey: '', shortId: '', serverName: '', listen: '', listenPort: 0, xrayVersion: '' };
  }
}

function inboundSetup() {
  const fixture = setup();
  const applier = new FakeApplier();
  const processor = new CommandProcessor(fixture.store, fixture.xray, {
    applier, inboundTag: 'vless-in', resolvePublicHost: async () => '203.0.113.7',
    verifyAttempts: 3, verifyDelayMs: 1,
  });
  return { ...fixture, applier, processor };
}

const inboundPayload = {
  inboundTag: 'vless-in', listenPort: 443, dest: 'www.microsoft.com:443',
  serverNames: ['www.microsoft.com'], flow: 'xtls-rprx-vision', fingerprint: 'chrome', spiderX: '/',
};

test('ENSURE_INBOUND 上报可用连接参数，重复下发不再重启 Xray', async () => {
  const fixture = inboundSetup();
  fixture.store.replaceDesiredUsers([desired()], '1');
  try {
    const result = await fixture.processor.execute(command('ENSURE_INBOUND', inboundPayload), true);
    assert.equal(result.status, 'completed');
    const inbound = result.result?.inbound as Record<string, unknown>;
    assert.equal(result.result?.appliedRevision, '900719925474099312345');
    assert.equal(inbound.serverHost, '203.0.113.7');
    assert.equal(inbound.serverPort, 443);
    assert.equal(inbound.serverName, 'www.microsoft.com');
    assert.equal(inbound.flow, 'xtls-rprx-vision');
    assert.equal(inbound.changed, true);
    // A restart empties Xray's in-memory user table, so the users must be
    // re-pushed before the command reports success.
    assert.equal(fixture.xray.users.get(desired().email), desired().uuid);

    const repeat = await fixture.processor.execute(command('ENSURE_INBOUND', inboundPayload, 'command-2'), true);
    // The request still goes to the helper — only it can tell a real no-op from
    // "someone restored an older config" — but nothing restarts.
    assert.equal(fixture.applier.restarts, 1, '同一规格不得再次重启 Xray');
    // The helper needs the command identity to recognise a redelivery.
    assert.deepEqual(fixture.applier.commandIds, ['command-1', 'command-2']);
    assert.equal((repeat.result?.inbound as Record<string, unknown>).changed, false);
    assert.equal((repeat.result?.inbound as Record<string, unknown>).realityPublicKey, 'k'.repeat(43));
  } finally { fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true }); }
});

test('入站部署失败必须响亮失败，且不留下已部署状态', async () => {
  const fixture = inboundSetup();
  try {
    fixture.applier.failure = new Error('Xray 入站部署失败（阶段 config-test）：端口冲突');
    const failed = await fixture.processor.execute(command('ENSURE_INBOUND', inboundPayload), true);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error ?? '', /端口冲突/);
    // The intent is recorded before the hand-off — once the helper has the
    // request the machine may change regardless of what this process learns —
    // but never as a complete deployment, so it can only be re-applied from.
    assert.equal(fixture.store.getInboundState()?.complete, false);

    // Live verification is part of success: a helper that claims to have
    // applied while the tag never appears must not report completed.
    const other = inboundSetup();
    try {
      other.xray.live = false;
      const unverified = await other.processor.execute(command('ENSURE_INBOUND', inboundPayload), true);
      assert.equal(unverified.status, 'failed');
      assert.match(unverified.error ?? '', /未能确认生效/);
      // The helper DID change the machine before verification failed, so the
      // spec is recorded — but marked incomplete, so it can never be answered
      // with and a repeat re-deploys.
      assert.equal(other.store.getInboundState()?.complete, false);
    } finally { other.store.close(); rmSync(other.directory, { recursive: true, force: true }); }
  } finally { fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true }); }
});

test('非 direct 模式与不可用能力都拒绝部署入站', async () => {
  const fixture = inboundSetup();
  const bare = setup();
  try {
    const gated = await fixture.processor.execute(command('ENSURE_INBOUND', inboundPayload), false);
    assert.equal(gated.status, 'failed');
    assert.equal(fixture.applier.calls.length, 0);

    const missing = await bare.processor.execute(command('ENSURE_INBOUND', inboundPayload), true);
    assert.equal(missing.status, 'failed');
    assert.match(missing.error ?? '', /配置助手/);
  } finally {
    fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true });
    bare.store.close(); rmSync(bare.directory, { recursive: true, force: true });
  }
});

test('对外地址是 IPv6 但入站只监听 IPv4 时拒绝上报', async () => {
  const fixture = setup();
  const applier = new FakeApplier();
  applier.outcome = { listen: '0.0.0.0' };
  const processor = new CommandProcessor(fixture.store, fixture.xray, {
    applier, inboundTag: 'vless-in', resolvePublicHost: async () => '2001:db8::1',
    verifyAttempts: 3, verifyDelayMs: 1,
  });
  try {
    // Such a node passes every tag-based check and hands each client an endpoint
    // with nothing listening on it.
    const result = await processor.execute(command('ENSURE_INBOUND', inboundPayload), true);
    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /IPv6/);
    assert.equal(fixture.store.getInboundState()?.complete, false, '未完成的部署不得被当作可用状态');
  } finally { fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true }); }
});

test('助手已改动但命令未完成时，重复下发旧规格必须重新部署', async () => {
  const fixture = setup();
  const applier = new FakeApplier();
  let host = '203.0.113.7';
  const processor = new CommandProcessor(fixture.store, fixture.xray, {
    applier,
    inboundTag: 'vless-in',
    resolvePublicHost: async () => { if (!host) throw new Error('控制面未能返回本机公网地址'); return host; },
    verifyAttempts: 3, verifyDelayMs: 1,
  });
  try {
    await processor.execute(command('ENSURE_INBOUND', inboundPayload), true);
    assert.equal(applier.calls.length, 1);

    // The helper deploys 8443, then the command fails afterwards: the machine
    // now serves 8443 while the last COMPLETE state still says 443.
    host = '';
    const moved = await processor.execute(command('ENSURE_INBOUND', { ...inboundPayload, listenPort: 8443 }, 'command-2'), true);
    assert.equal(moved.status, 'failed');
    assert.equal(applier.calls.length, 2);

    // Re-issuing 443 must actually restore it, not answer from the cache.
    host = '203.0.113.7';
    const restored = await processor.execute(command('ENSURE_INBOUND', inboundPayload, 'command-3'), true);
    assert.equal(restored.status, 'completed');
    assert.equal(applier.calls.length, 3, '状态与机器不一致时必须重新部署');
    assert.equal((restored.result?.inbound as Record<string, unknown>).serverPort, 443);
  } finally { fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true }); }
});

test('无需改动 Xray 时也要刷新对外地址', async () => {
  const fixture = setup();
  const applier = new FakeApplier();
  let host = '203.0.113.7';
  const processor = new CommandProcessor(fixture.store, fixture.xray, {
    applier, inboundTag: 'vless-in', resolvePublicHost: async () => host,
    verifyAttempts: 3, verifyDelayMs: 1,
  });
  try {
    await processor.execute(command('ENSURE_INBOUND', inboundPayload), true);
    // The VPS address changed (or the operator corrected the override). Xray
    // needs no change, but the control plane must stop handing out the old one.
    host = '198.51.100.9';
    const repeat = await processor.execute(command('ENSURE_INBOUND', inboundPayload, 'command-2'), true);
    const inbound = repeat.result?.inbound as Record<string, unknown>;
    assert.equal(inbound.serverHost, '198.51.100.9');
    assert.equal(inbound.changed, false);
    assert.equal(applier.restarts, 1, '仅地址变化不该重启 Xray');

    // The family check still applies on the shortcut path.
    host = '2001:db8::1';
    applier.outcome = { listen: '0.0.0.0' };
    const other = setup();
    try {
      const v4Only = new CommandProcessor(other.store, other.xray, {
        applier, inboundTag: 'vless-in', resolvePublicHost: async () => '2001:db8::1',
        verifyAttempts: 3, verifyDelayMs: 1,
      });
      await v4Only.execute(command('ENSURE_INBOUND', inboundPayload), true);
      const failed = await v4Only.execute(command('ENSURE_INBOUND', inboundPayload, 'command-3'), true);
      assert.equal(failed.status, 'failed');
      assert.match(failed.error ?? '', /IPv6/);
    } finally { other.store.close(); rmSync(other.directory, { recursive: true, force: true }); }
  } finally { fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true }); }
});

test('每次真正部署都重新下发用户，并把新的 flow 应用到已有用户', async () => {
  const fixture = inboundSetup();
  fixture.store.replaceDesiredUsers([desired()], '1');
  try {
    await fixture.processor.execute(command('ENSURE_INBOUND', inboundPayload), true);
    assert.equal(fixture.xray.users.get(desired().email), desired().uuid);

    // A repeat that the helper answers with restarted:false still reconciles:
    // an earlier attempt may have restarted Xray and then failed before (or
    // during) its own reconcile, leaving users missing.
    fixture.applier.outcome = { changed: true, restarted: false };
    fixture.xray.users.clear();
    await fixture.processor.execute(command('ENSURE_INBOUND', { ...inboundPayload, listenPort: 8443 }, 'command-2'), true);
    assert.equal(fixture.xray.users.get(desired().email), desired().uuid, '未重启也必须补齐用户');

    // Changing the ordered flow rewrites Node.flow for every client config, so
    // the users installed in Xray must be reinstalled with that flow too.
    const before = fixture.xray.ensureCalls;
    await fixture.processor.execute(command('ENSURE_INBOUND', { ...inboundPayload, flow: '' }, 'command-3'), true);
    assert.equal(fixture.store.listDesiredUsers()[0].flow, '');
    assert.ok(fixture.xray.ensureCalls > before, 'flow 变更必须重新安装用户');
  } finally { fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true }); }
});

test('助手请求超时后，旧规格也必须重新走助手而不是读缓存', async () => {
  const fixture = setup();
  const applier = new FakeApplier();
  const processor = new CommandProcessor(fixture.store, fixture.xray, {
    applier, inboundTag: 'vless-in', resolvePublicHost: async () => '203.0.113.7',
    verifyAttempts: 3, verifyDelayMs: 1,
  });
  try {
    await processor.execute(command('ENSURE_INBOUND', inboundPayload), true);

    // The helper takes the request and may well deploy 8443; this process only
    // learns that the wait timed out. What the machine runs is now unknown.
    applier.failure = new Error('等待 Xray 配置助手超时（120 秒）');
    const timedOut = await processor.execute(command('ENSURE_INBOUND', { ...inboundPayload, listenPort: 8443 }, 'command-2'), true);
    assert.equal(timedOut.status, 'failed');

    applier.failure = undefined;
    const restored = await processor.execute(command('ENSURE_INBOUND', inboundPayload, 'command-3'), true);
    assert.equal(restored.status, 'completed');
    assert.equal(applier.calls.length, 3, '每次部署都必须经过助手确认实际部署内容');
  } finally { fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true }); }
});

test('flow 变更对 revision 更高的用户同样落地', async () => {
  const fixture = inboundSetup();
  // A newer user command has already been applied: its revision is higher than
  // this (older) deployment's, so a revision-carrying write would be rejected —
  // and Xray would end up on a flow the store does not know about, which the
  // next restart would silently undo.
  const ahead = { ...desired(), revision: '900719925474099399999', flow: 'xtls-rprx-vision' as const };
  fixture.store.replaceDesiredUsers([ahead], ahead.revision);
  try {
    const result = await fixture.processor.execute(command('ENSURE_INBOUND', { ...inboundPayload, flow: '' }), true);
    assert.equal(result.status, 'completed');
    const persisted = fixture.store.listDesiredUsers()[0];
    assert.equal(persisted.flow, '', '持久化的 flow 必须与下发一致');
    assert.equal(persisted.revision, ahead.revision, '不得压低用户自身的 revision');
  } finally { fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true }); }
});

test('对外地址不是公网单播时命令直接失败，而不是让控制面在稍后拒绝', async () => {
  for (const host of ['10.0.0.7', '127.0.0.1', 'node.example.com', '::ffff:192.168.1.1', '']) {
    const fixture = setup();
    const applier = new FakeApplier();
    const processor = new CommandProcessor(fixture.store, fixture.xray, {
      applier, inboundTag: 'vless-in', resolvePublicHost: async () => host,
      verifyAttempts: 3, verifyDelayMs: 1,
    });
    try {
      const result = await processor.execute(command('ENSURE_INBOUND', inboundPayload), true);
      assert.equal(result.status, 'failed', `${host} 不应被当作可用对外地址`);
      assert.match(result.error ?? '', /公网单播|CHORDV_NODE_PUBLIC_HOST/);
    } finally { fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true }); }
  }

  // The public ones still go through, IPv4-mapped included.
  for (const host of ['203.0.113.7', '::ffff:203.0.113.7']) {
    const fixture = setup();
    const processor = new CommandProcessor(fixture.store, fixture.xray, {
      applier: new FakeApplier(), inboundTag: 'vless-in', resolvePublicHost: async () => host,
      verifyAttempts: 3, verifyDelayMs: 1,
    });
    try {
      const result = await processor.execute(command('ENSURE_INBOUND', inboundPayload), true);
      assert.equal(result.status, 'completed', `${host} 应被接受`);
    } finally { fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true }); }
  }
});
