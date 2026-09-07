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
  isPortOwnedBy,
  listeningSocketInodes,
  resolveListenAddress,
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
  // The output holds the PRIVATE key and this error reaches the agent-readable
  // result file and the control plane, so it must never be echoed.
  const leaky = `PrivateKey: ${'s'.repeat(43)}\nUnexpectedLabel: ${'d'.repeat(43)}`;
  assert.throws(() => parseX25519(leaky), (error: Error) => {
    assert.equal(error.message.includes('s'.repeat(43)), false, '私钥不得出现在错误里');
    assert.match(error.message, /未识别的标签：.*UnexpectedLabel/);
    return true;
  });
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
    isListening: () => true,
    resolveListen: () => '::',
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

test('监听地址按主机的 IPv6 栈决定，并跟着状态一起记录', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'xray-apply-listen-'));
  try {
    // A node whose public address is IPv6 but whose inbound listens on 0.0.0.0
    // passes every tag check and hands clients an endpoint with no listener.
    assert.equal(resolveListenAddress(() => '0\n'), '::');
    assert.equal(resolveListenAddress(() => { throw new Error('ENOENT'); }), '0.0.0.0');
    assert.throws(() => resolveListenAddress(() => '1\n'), /bindv6only/);

    const applyDeps = deps(root, { resolveListen: () => '0.0.0.0' });
    const outcome = applyRequest(request(), applyDeps);
    assert.equal(outcome.listen, '0.0.0.0');
    assert.equal(JSON.parse(readFileSync(join(applyDeps.confDir, '50-inbound.json'), 'utf8')).inbounds[0].listen, '0.0.0.0');
    // A no-op repeat must still report the family it is actually serving.
    assert.equal(applyRequest(request(), applyDeps).listen, '0.0.0.0');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('重启成功但端口没起来时回滚，且回滚后的配置仍可被 xray 用户读取', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'xray-apply-ready-'));
  try {
    const applyDeps = deps(root);
    applyRequest(request(), applyDeps);
    const config = join(applyDeps.confDir, '50-inbound.json');
    const before = readFileSync(config, 'utf8');
    const beforeMode = fs.statSync(config).mode & 0o777;

    // systemctl restart returns before a Type=simple unit binds: a port taken by
    // nginx passes the config test, starts, and exits.
    const notListening = deps(root, {
      confDir: applyDeps.confDir, stateFile: applyDeps.stateFile, isListening: () => false,
    });
    assert.throws(() => applyRequest(request({ listenPort: 8443 }), notListening), /未能在端口 8443 上开始监听/);
    assert.equal(readFileSync(config, 'utf8'), before, '未确认监听就必须回滚');
    // A plain copy would restore a root-owned file the xray service cannot read,
    // turning one failure into two.
    assert.equal(fs.statSync(config).mode & 0o777, beforeMode);
    assert.equal(notListening.restarts, 2, '回滚后要再重启一次');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('首次部署失败时不留下半成品配置', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'xray-apply-first-'));
  try {
    const applyDeps = deps(root, { isListening: () => false });
    assert.throws(() => applyRequest(request(), applyDeps), /开始监听/);
    assert.equal(fs.existsSync(join(applyDeps.confDir, '50-inbound.json')), false);
    // The journal survives on purpose — it holds the generated keys so a retry
    // reuses them — but stays pending, so it is never answered with.
    assert.equal(JSON.parse(readFileSync(applyDeps.stateFile, 'utf8')).pending, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('监听探测要求端口属于 Xray 自己的进程', () => {
  // Real /proc/net/tcp column layout: sl local rem st tx:rx tr:when retrnsmt
  // uid timeout inode …
  const table = [
    '  sl  local_address rem_address   st tx_queue:rx_queue tr:tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 4242 1 0000 10 0',
    '   1: 00000000:01BB 00000000:0000 06 00000000:00000000 00:00000000 00000000     0        0 4243 1 0000 10 0',
  ].join('\n');
  const readers = (owner: string) => ({
    readFile: (file: string) => {
      if (file === '/proc/net/tcp') return table;
      if (file === '/proc/net/tcp6') throw new Error('ENOENT');
      if (file === '/proc/17/cmdline') return `${owner}\0run\0-confdir\0/etc/chordv/xray/conf.d`;
      throw new Error(`unexpected ${file}`);
    },
    readDir: (directory: string) => (directory === '/proc' ? ['17', 'self', 'net'] : ['0', '1', '2']),
    readLink: (file: string) => (file === '/proc/17/fd/1' ? 'socket:[4242]' : '/dev/null'),
  });

  assert.deepEqual(listeningSocketInodes(8080, readers('/usr/local/bin/xray')), ['4242']);
  // 443 appears, but in TIME_WAIT rather than LISTEN.
  assert.deepEqual(listeningSocketInodes(443, readers('/usr/local/bin/xray')), []);

  assert.equal(isPortOwnedBy(8080, '/usr/local/bin/xray', readers('/usr/local/bin/xray')), true);
  // nginx holding the port is exactly the case that must NOT count as ready:
  // Xray fails to bind, and committing here would leave the node offline.
  assert.equal(isPortOwnedBy(8080, '/usr/local/bin/xray', readers('/usr/sbin/nginx')), false);
  assert.equal(isPortOwnedBy(9999, '/usr/local/bin/xray', readers('/usr/local/bin/xray')), false);
});

test('配置已发布但状态未落盘时，重复下发旧规格必须重新部署', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'xray-apply-journal-'));
  try {
    const applyDeps = deps(root);
    applyRequest(request(), applyDeps);
    const state = JSON.parse(readFileSync(applyDeps.stateFile, 'utf8')) as Record<string, unknown>;
    assert.equal(state.pending, false, '成功后必须落成已提交状态');

    // Simulate the crash window: the helper published 8443 and died before
    // recording it. Xray now serves 8443 while the state describes 443.
    fs.writeFileSync(applyDeps.stateFile, JSON.stringify({ ...state, pending: true }));
    const repeat = applyRequest(request(), applyDeps);
    assert.equal(repeat.changed, true, '未提交的状态不得被当成已部署');
    assert.equal(applyDeps.restarts, 2);
    assert.equal(JSON.parse(readFileSync(applyDeps.stateFile, 'utf8')).pending, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
