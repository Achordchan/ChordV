import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyRequest,
  assertRequestOwnership,
  parseRequest,
  parseX25519,
  renderInbound,
  requestHash,
  type ApplyDeps,
  type InboundRequest,
} from '../src/xray-apply.js';

const request = (overrides: Partial<InboundRequest> = {}): InboundRequest => ({
  requestId: '11111111-2222-4333-8444-555555555555',
  mode: 'ensure',
  inboundTag: 'vless-in',
  listenPort: 443,
  dest: 'www.microsoft.com:443',
  serverNames: ['www.microsoft.com'],
  flow: 'xtls-rprx-vision',
  fingerprint: 'chrome',
  spiderX: '/',
  rotateKeys: false,
  ...overrides,
});

const keys = { privateKey: 'p'.repeat(43), publicKey: 'P'.repeat(43), shortId: '0123456789abcdef' };

test('root 助手把 agent 请求当作不可信输入逐字段校验', () => {
  assert.deepEqual(parseRequest(JSON.stringify(request())), request());
  assert.equal(parseRequest(JSON.stringify({ requestId: request().requestId, mode: 'reset' })).mode, 'reset');

  assert.throws(() => parseRequest('{'), /不是合法 JSON/);
  assert.throws(() => parseRequest('[]'), /格式错误/);
  assert.throws(() => parseRequest(JSON.stringify({ ...request(), requestId: 'x' })), /requestId/);
  assert.throws(() => parseRequest(JSON.stringify({ ...request(), inboundTag: 'a b' })), /inboundTag/);
  assert.throws(() => parseRequest(JSON.stringify({ ...request(), listenPort: 70_000 })), /端口/);
  assert.throws(() => parseRequest(JSON.stringify({ ...request(), dest: 'evil host:443' })), /dest/);
  assert.throws(() => parseRequest(JSON.stringify({ ...request(), spiderX: '/"' })), /spiderX/);
  assert.throws(() => parseRequest(`{"pad":"${'x'.repeat(9000)}"}`), /过大/);
});

test('入站配置由 root 自行渲染，agent 提供的字段进不了结构里', () => {
  const rendered = renderInbound({ ...request(), serverNames: ['a.example.com', 'b.example.com'] }, keys) as {
    inbounds: Array<Record<string, any>>;
  };
  assert.equal(rendered.inbounds.length, 1);
  const inbound = rendered.inbounds[0];
  assert.equal(inbound.protocol, 'vless');
  assert.equal(inbound.tag, 'vless-in');
  assert.equal(inbound.port, 443);
  assert.deepEqual(inbound.settings, { clients: [], decryption: 'none' });
  assert.equal(inbound.streamSettings.security, 'reality');
  assert.deepEqual(inbound.streamSettings.realitySettings.serverNames, ['a.example.com', 'b.example.com']);
  assert.equal(inbound.streamSettings.realitySettings.privateKey, keys.privateKey);
  assert.deepEqual(inbound.streamSettings.realitySettings.shortIds, [keys.shortId]);
  // Only the validated scalars are used; a request key the helper does not know
  // cannot appear anywhere in what root will run.
  const withExtra = renderInbound({ ...request(), ...({ log: { access: '/etc/shadow' } } as object) } as InboundRequest, keys);
  assert.equal(JSON.stringify(withExtra).includes('/etc/shadow'), false);
});

test('x25519 输出跨版本标签都能解析，解析不出则带原文报错', () => {
  assert.deepEqual(parseX25519(`Private key: ${'a'.repeat(43)}\nPublic key: ${'b'.repeat(43)}`),
    { privateKey: 'a'.repeat(43), publicKey: 'b'.repeat(43) });
  assert.deepEqual(parseX25519(`PrivateKey: ${'c'.repeat(43)}\nPassword: ${'d'.repeat(43)}`),
    { privateKey: 'c'.repeat(43), publicKey: 'd'.repeat(43) });
  assert.throws(() => parseX25519('Key: ???'), /无法解析 xray x25519 输出：Key: \?\?\?/);
});

function deps(root: string, overrides: Partial<ApplyDeps> = {}): ApplyDeps & { restarts: number } {
  const confDir = join(root, 'conf.d');
  fs.mkdirSync(confDir, { recursive: true });
  fs.writeFileSync(join(confDir, '10-api.json'), JSON.stringify({ api: { tag: 'api' } }));
  const state = { restarts: 0 };
  return Object.assign(state, {
    confDir,
    stateFile: join(root, 'inbound-state.json'),
    // A stub that accepts any config; the real one is `xray run -test`.
    xrayBin: '/usr/bin/true',
    xrayUser: 'root',
    restart: () => { state.restarts += 1; },
    generateKeys: () => keys,
    now: () => '2026-09-07T00:00:00.000Z',
    ...overrides,
  }) as ApplyDeps & { restarts: number };
}

test('部署后写出配置与状态，重复同一规格完全不动 Xray', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'xray-apply-'));
  try {
    const applyDeps = deps(root);
    const first = applyRequest(request(), applyDeps);
    assert.equal(first.changed, true);
    assert.equal(first.restarted, true);
    assert.equal(applyDeps.restarts, 1);
    assert.equal(first.realityPublicKey, keys.publicKey);
    const config = join(applyDeps.confDir, '50-inbound.json');
    assert.equal(JSON.parse(readFileSync(config, 'utf8')).inbounds[0].port, 443);
    // The private key lives only in root-owned files, never in the report.
    assert.equal(readFileSync(config, 'utf8').includes(keys.privateKey), true);
    assert.equal(JSON.stringify(first).includes(keys.privateKey), false);
    assert.equal(fs.statSync(applyDeps.stateFile).mode & 0o777, 0o600);

    const repeat = applyRequest(request(), applyDeps);
    // Re-issuing the same spec must not restart Xray: that drops every live
    // connection and every gRPC-provisioned user for no gain.
    assert.deepEqual({ changed: repeat.changed, restarted: repeat.restarted }, { changed: false, restarted: false });
    assert.equal(applyDeps.restarts, 1);
    assert.equal(repeat.realityPublicKey, keys.publicKey);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('改端口保留密钥，只有显式轮换才换新密钥', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'xray-apply-keys-'));
  try {
    let generated = 0;
    const rotated = { privateKey: 'n'.repeat(43), publicKey: 'N'.repeat(43), shortId: 'ffeeddccbbaa9988' };
    const applyDeps = deps(root, { generateKeys: () => (generated++ === 0 ? keys : rotated) });

    applyRequest(request(), applyDeps);
    // Rotating on a port change would silently invalidate every subscription
    // already handed to a user, so the keys travel with the node.
    const moved = applyRequest(request({ listenPort: 8443 }), applyDeps);
    assert.equal(moved.realityPublicKey, keys.publicKey);
    assert.equal(moved.listenPort, 8443);
    assert.equal(applyDeps.restarts, 2);

    const rotatedOutcome = applyRequest(request({ rotateKeys: true }), applyDeps);
    assert.equal(rotatedOutcome.realityPublicKey, rotated.publicKey);
    assert.equal(rotatedOutcome.shortId, rotated.shortId);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('配置校验失败不落盘、不重启；重启失败回滚上一份配置', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'xray-apply-fail-'));
  try {
    const applyDeps = deps(root);
    applyRequest(request(), applyDeps);
    const config = join(applyDeps.confDir, '50-inbound.json');
    const before = readFileSync(config, 'utf8');

    const rejecting = deps(root, { xrayBin: '/usr/bin/false', confDir: applyDeps.confDir, stateFile: applyDeps.stateFile });
    assert.throws(() => applyRequest(request({ listenPort: 8443 }), rejecting), /配置校验失败/);
    assert.equal(readFileSync(config, 'utf8'), before, '校验失败不得改动生效中的配置');
    assert.equal(rejecting.restarts, 0);

    let attempts = 0;
    const failingRestart = deps(root, {
      confDir: applyDeps.confDir,
      stateFile: applyDeps.stateFile,
      restart: () => { if (attempts++ === 0) throw new Error('unit failed'); },
    });
    assert.throws(() => applyRequest(request({ listenPort: 9443 }), failingRestart), /已回滚上一份配置/);
    assert.equal(readFileSync(config, 'utf8'), before, '重启失败必须回滚到上一份配置');
    assert.equal(attempts, 2, '回滚后要再重启一次，让 Xray 回到可用状态');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('reset 发布空入站并清除密钥状态', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'xray-apply-reset-'));
  try {
    const applyDeps = deps(root);
    applyRequest(request(), applyDeps);
    const outcome = applyRequest(request({ mode: 'reset' }), applyDeps);
    assert.equal(outcome.changed, true);
    assert.deepEqual(JSON.parse(readFileSync(join(applyDeps.confDir, '50-inbound.json'), 'utf8')), { inbounds: [] });
    assert.equal(fs.existsSync(applyDeps.stateFile), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('请求文件的属主与权限位是助手的信任边界', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'xray-apply-own-'));
  const file = join(root, 'pending.json');
  try {
    fs.writeFileSync(file, '{}', { mode: 0o600 });
    const uid = process.getuid?.() ?? 0;
    assertRequestOwnership(file, uid);
    assert.throws(() => assertRequestOwnership(file, uid + 1), /属主/);
    fs.chmodSync(file, 0o666);
    assert.throws(() => assertRequestOwnership(file, uid), /不得被组\/其他用户写入/);
    fs.chmodSync(file, 0o600);
    fs.symlinkSync(file, join(root, 'link.json'));
    assert.throws(() => assertRequestOwnership(join(root, 'link.json'), uid), /普通文件/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('两侧对同一规格算出相同指纹', async () => {
  const { inboundSpecHash, parseInboundSpec } = await import('../src/xray-inbound.js');
  const spec = parseInboundSpec({ ...request() } as unknown as Record<string, unknown>, 'vless-in');
  // The agent decides "nothing changed" from its hash and the helper from its
  // own; if they disagree, one side would restart Xray on every command.
  assert.equal(inboundSpecHash(spec), requestHash(request()));
});

test('助手不从 agent 可写的发布目录导入任何模块', () => {
  const source = readFileSync(new URL('../src/xray-apply.ts', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import[^;]*?from '([^']+)';/gm)].map((match) => match[1]);
  // The helper is copied out of the release and run as root: a sibling import
  // would resolve back inside the agent-writable release directory.
  assert.deepEqual(imports.filter((name) => !name.startsWith('node:')), []);
});
