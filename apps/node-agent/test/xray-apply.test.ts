import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyRequest,
  readRequest,
  parseRequest,
  parseX25519,
  renderInbound,
  requestHash,
  isPortOwnedBy,
  isInternalDestAddress,
  assertPublicDest,
  resolveHostAddresses,
  listeningSocketInodes,
  resolveListenAddress,
  type ApplyDeps,
  type InboundRequest,
} from '../src/xray-apply.js';

// Every deployment is its own command in production; only a REDELIVERY reuses
// an id, so the fixture hands out a fresh one unless a test asks otherwise.
let commandCounter = 0;
const request = (overrides: Partial<InboundRequest> = {}): InboundRequest => ({
  requestId: '11111111-2222-4333-8444-555555555555',
  commandId: `command-${++commandCounter}`,
  mode: 'ensure',
  inboundTag: 'vless-in',
  listenPort: 443,
  dest: 'www.microsoft.com:443',
  serverNames: ['www.microsoft.com'],
  flow: 'xtls-rprx-vision',
  fingerprint: 'chrome',
  spiderX: '/',
  rotateKeys: false,
  requireListen: '',
  ...overrides,
});

const keys = { privateKey: 'p'.repeat(43), publicKey: 'P'.repeat(43), shortId: '0123456789abcdef' };

test('root 助手把 agent 请求当作不可信输入逐字段校验', () => {
  const sample = request();
  assert.deepEqual(parseRequest(JSON.stringify(sample)), sample);
  assert.equal(parseRequest(JSON.stringify({ requestId: sample.requestId, mode: 'reset' })).mode, 'reset');
  assert.throws(() => parseRequest(JSON.stringify({ ...sample, commandId: 'bad id!' })), /commandId/);

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
    // A public camouflage site for the default `www.microsoft.com` dest; the
    // address-policy tests override this with rebinding-style answers.
    resolveDest: () => ['203.0.113.10'],
    generateKeys: () => keys,
    now: () => '2026-09-07T00:00:00.000Z',
    ...overrides,
  }) as ApplyDeps & { restarts: number };
}

test('fallback 目标指向本机或内网时拒绝部署，DNS 重绑定也算', () => {
  // The fallback forwards what a NON-Reality client sends — unauthenticated,
  // from the public internet — so these addresses would tunnel into the
  // machine: 127.0.0.1:10085 is the unauthenticated Xray gRPC API,
  // 169.254.169.254 is cloud metadata.
  for (const address of [
    '127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '[fe80::1]',
  ]) {
    assert.equal(isInternalDestAddress(address), true, `${address} 应视为内部地址`);
  }
  for (const address of ['8.8.8.8', '203.0.113.7', '172.32.0.1', '172.15.255.255', '100.128.0.1', '2001:db8::1', '::ffff:8.8.8.8']) {
    assert.equal(isInternalDestAddress(address), false, `${address} 不应视为内部地址`);
  }

  const root = fs.mkdtempSync(join(tmpdir(), 'xray-apply-dest-'));
  try {
    const applyDeps = deps(root);
    for (const dest of ['127.0.0.1:10085', 'localhost:10085', '10.0.0.5:443', '169.254.169.254:80']) {
      assert.throws(() => applyRequest(request({ dest }), applyDeps), /回环|内网/, `应拒绝：${dest}`);
    }
    // Refused before anything is touched: no config, no state, no restart.
    assert.equal(applyDeps.restarts, 0);
    assert.equal(fs.existsSync(join(applyDeps.confDir, '50-inbound.json')), false);
    assert.equal(fs.existsSync(applyDeps.stateFile), false);

    // A name is judged by every address it resolves to. One public record
    // plus one loopback record is a rebinding attempt, not a pass.
    for (const [label, records] of [
      ['mixed records', ['203.0.113.5', '127.0.0.1']],
      ['private AAAA', ['2001:db8::1', 'fd00::1']],
      ['unresolvable', []],
    ] as const) {
      const rebinding = deps(root, { resolveDest: () => [...records] });
      assert.throws(() => applyRequest(request({ dest: 'camouflage.example:443' }), rebinding), /解析到/, `应拒绝：${label}`);
    }
    // The same name with only public records deploys.
    const clean = deps(root, { resolveDest: () => ['203.0.113.5', '2001:db8::1'] });
    assert.equal(applyRequest(request({ dest: 'camouflage.example:443' }), clean).changed, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('resolveHostAddresses 走系统解析器，hosts 文件里的 localhost 也算回环', () => {
  // Exercises the real spawn+getaddrinfo path (offline-safe: /etc/hosts).
  const addresses = resolveHostAddresses('localhost');
  assert.ok(addresses.length >= 1, 'localhost 必须能解析');
  assert.ok(addresses.every((address) => isInternalDestAddress(address)), 'localhost 的解析结果必须全部算内部地址');
  assert.throws(() => assertPublicDest('localhost:443', resolveHostAddresses), /回环/);
  assert.deepEqual(resolveHostAddresses('not-a-real-host.invalid'), []);
});

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

test('请求文件的属主、类型与大小都在同一个文件描述符上校验', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'xray-apply-own-'));
  const file = join(root, 'pending.json');
  const uid = process.getuid?.() ?? 0;
  try {
    fs.writeFileSync(file, '{"ok":1}', { mode: 0o600 });
    assert.equal(readRequest(file, uid), '{"ok":1}');
    assert.throws(() => readRequest(file, uid + 1), /属主/);
    fs.chmodSync(file, 0o666);
    assert.throws(() => readRequest(file, uid), /不得被组\/其他用户写入/);
    fs.chmodSync(file, 0o600);

    // An unbounded read of a file the agent controls is a memory-exhaustion
    // lever against a root process, so the limit is enforced before reading.
    fs.writeFileSync(join(root, 'big.json'), 'x'.repeat(64), { mode: 0o600 });
    assert.throws(() => readRequest(join(root, 'big.json'), uid, 16), /过大/);

    // Path-then-read is two different files when the agent owns the directory:
    // a symlink or FIFO swapped in between must not be followed or block root.
    fs.symlinkSync(file, join(root, 'link.json'));
    assert.throws(() => readRequest(join(root, 'link.json'), uid), /ELOOP|符号|not permitted|ENOENT/i);

    // A FIFO would block a root process indefinitely; O_NONBLOCK plus the
    // regular-file check on the descriptor is what prevents that.
    const fifo = join(root, 'fifo.json');
    if (spawnSync('mkfifo', [fifo]).status === 0) {
      assert.throws(() => readRequest(fifo, uid), /不是普通文件/);
    }
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
    // Nothing was committed before, so the rollback leaves no record at all:
    // a first deployment has no issued subscriptions to protect, and keeping a
    // half-written journal would only offer keys for a config that never ran.
    assert.equal(fs.existsSync(applyDeps.stateFile), false);
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

test('轮换失败回滚时，新密钥不得留在状态里', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'xray-apply-rotate-rollback-'));
  try {
    const rotated = { privateKey: 'n'.repeat(43), publicKey: 'N'.repeat(43), shortId: 'ffeeddccbbaa9988' };
    let generated = 0;
    const applyDeps = deps(root, { generateKeys: () => (generated++ === 0 ? keys : rotated) });
    applyRequest(request(), applyDeps);

    const failing = deps(root, {
      confDir: applyDeps.confDir, stateFile: applyDeps.stateFile, isListening: () => false,
      generateKeys: () => rotated,
    });
    assert.throws(() => applyRequest(request({ rotateKeys: true }), failing), /开始监听/);
    // The configuration rolled back, so the keys must roll back with it —
    // otherwise the next deployment quietly adopts the rotated keys and
    // invalidates every subscription already issued.
    const state = JSON.parse(readFileSync(applyDeps.stateFile, 'utf8')) as { keys: typeof keys; pending: boolean };
    assert.equal(state.keys.publicKey, keys.publicKey);
    assert.equal(state.pending, false);
    assert.equal(applyRequest(request(), deps(root, { confDir: applyDeps.confDir, stateFile: applyDeps.stateFile })).realityPublicKey, keys.publicKey);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('重复投递同一条命令不再轮换密钥，也不再重启', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'xray-apply-redeliver-'));
  try {
    let generated = 0;
    const rotated = { privateKey: 'n'.repeat(43), publicKey: 'N'.repeat(43), shortId: 'ffeeddccbbaa9988' };
    const applyDeps = deps(root, { generateKeys: () => (generated++ === 0 ? keys : rotated) });
    const rotate = request({ rotateKeys: true, commandId: 'command-rotate' });

    const first = applyRequest(rotate, applyDeps);
    assert.equal(first.realityPublicKey, keys.publicKey);
    assert.equal(applyDeps.restarts, 1);

    // The agent crashed before recording completion, so the same command comes
    // back. A second rotation would invalidate every subscription issued from
    // the first one.
    const redelivered = applyRequest({ ...rotate, requestId: '99999999-2222-4333-8444-555555555555' }, applyDeps);
    assert.equal(redelivered.realityPublicKey, keys.publicKey);
    assert.equal(redelivered.changed, false);
    assert.equal(applyDeps.restarts, 1);

    // A NEW rotation command still rotates.
    const next = applyRequest(request({ rotateKeys: true, commandId: 'command-rotate-2' }), applyDeps);
    assert.equal(next.realityPublicKey, rotated.publicKey);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('reset 在发布空入站之前先落盘意图', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'xray-apply-reset-journal-'));
  try {
    const applyDeps = deps(root);
    applyRequest(request(), applyDeps);
    const target = join(applyDeps.confDir, '50-inbound.json');

    // Die between publishing the empty inbound and dropping the state: the old
    // hash and keys would otherwise sit next to an empty config, and a later
    // ensure of that same spec would take the no-op branch and never restore it.
    const dying = deps(root, {
      confDir: applyDeps.confDir, stateFile: applyDeps.stateFile,
      restart: () => { throw new Error('killed'); },
    });
    assert.throws(() => applyRequest(request({ mode: 'reset' }), dying), /重启 Xray 失败/);
    assert.equal(JSON.parse(readFileSync(applyDeps.stateFile, 'utf8')).pending, false, '回滚成功则状态恢复为已提交');

    fs.writeFileSync(applyDeps.stateFile, JSON.stringify({ ...JSON.parse(readFileSync(applyDeps.stateFile, 'utf8')), pending: true }));
    fs.writeFileSync(target, JSON.stringify({ inbounds: [] }));
    const restored = applyRequest(request(), deps(root, { confDir: applyDeps.confDir, stateFile: applyDeps.stateFile }));
    assert.equal(restored.changed, true, '空入站加未提交状态必须重新部署');
    assert.equal(JSON.parse(readFileSync(target, 'utf8')).inbounds[0].port, 443);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Xray 已停时，空转分支必须先把服务拉起来', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'xray-apply-down-'));
  try {
    const applyDeps = deps(root);
    const first = applyRequest(request({ commandId: 'command-down' }), applyDeps);
    assert.equal(first.changed, true);

    // The service is stopped (or exhausted systemd's restart limit): the config
    // file and the recorded state are both still there, so answering "nothing
    // to do" would leave the node down and every retry would repeat it.
    let listening = false;
    const recovering = deps(root, {
      confDir: applyDeps.confDir, stateFile: applyDeps.stateFile,
      isListening: () => listening,
      restart: () => { listening = true; },
    });
    const repeated = applyRequest(request({ commandId: 'command-down' }), recovering);
    assert.equal(repeated.restarted, true, '服务没在跑就必须重启，而不是报无事可做');
    assert.equal(repeated.realityPublicKey, keys.publicKey, '恢复不得更换密钥');

    // Once it is serving again, the same command really is a no-op.
    const settled = applyRequest(request({ commandId: 'command-down' }), recovering);
    assert.equal(settled.restarted, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('重投的轮换命令即使 Xray 已停也不再生成新密钥', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'xray-apply-rotate-redeliver-'));
  try {
    const rotated = { privateKey: 'n'.repeat(43), publicKey: 'N'.repeat(43), shortId: 'ffeeddccbbaa9988' };
    let generated = 0;
    const applyDeps = deps(root, { generateKeys: () => (generated++ === 0 ? keys : rotated) });
    const rotate = request({ rotateKeys: true, commandId: 'command-rotate-down' });
    assert.equal(applyRequest(rotate, applyDeps).realityPublicKey, keys.publicKey);

    // The agent crashed before recording completion AND the service is down, so
    // the command-id shortcut is refused. Rotating again here would invalidate
    // every credential issued from the first rotation.
    let listening = false;
    const recovering = deps(root, {
      confDir: applyDeps.confDir, stateFile: applyDeps.stateFile,
      generateKeys: () => rotated,
      isListening: () => listening,
      restart: () => { listening = true; },
    });
    const redelivered = applyRequest({ ...rotate, requestId: '99999999-2222-4333-8444-555555555555' }, recovering);
    assert.equal(redelivered.realityPublicKey, keys.publicKey, '重投的轮换必须沿用首次生成的密钥');
    assert.equal(redelivered.restarted, true, '服务没在跑就要拉起来');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('磁盘配置被换成别的密钥时，空转分支必须重新部署', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'xray-apply-drift-'));
  try {
    const applyDeps = deps(root);
    const spec = request({ commandId: 'command-drift' });
    applyRequest(spec, applyDeps);
    const target = join(applyDeps.confDir, '50-inbound.json');

    // An operator restores an older 50-inbound.json — same port, different
    // Reality key — without restoring inbound-state.json. Existence and a
    // listening port both still look fine, so only comparing the CONTENT can
    // notice that Xray no longer serves the key we would report.
    const older = JSON.parse(readFileSync(target, 'utf8')) as { inbounds: Array<Record<string, any>> };
    older.inbounds[0].streamSettings.realitySettings.privateKey = 'z'.repeat(43);
    fs.writeFileSync(target, JSON.stringify(older, null, 2) + '\n');

    const repeated = applyRequest(spec, applyDeps);
    assert.equal(repeated.restarted, true, '磁盘配置与记录不符必须重新部署');
    assert.equal(readFileSync(target, 'utf8').includes(keys.privateKey), true, '重新部署必须写回记录中的密钥');
    // Once the file matches the record again, the same command really is a no-op.
    assert.equal(applyRequest(spec, applyDeps).restarted, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('拒绝占用其它配置片段已使用的入站 tag', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'xray-apply-tag-'));
  try {
    const applyDeps = deps(root);
    // Xray's confdir merge is BY TAG: deploying under `api-in` would replace the
    // metering inbound the agent talks to — and the agent is untrusted here, so
    // its own tag check cannot be relied on.
    fs.writeFileSync(join(applyDeps.confDir, '10-api.json'), JSON.stringify({
      api: { tag: 'api' },
      inbounds: [{ tag: 'api-in', listen: '127.0.0.1', port: 10085, protocol: 'dokodemo-door' }],
    }));
    assert.throws(() => applyRequest(request({ inboundTag: 'api-in' }), applyDeps), /已被其它配置片段占用/);
    assert.equal(fs.existsSync(join(applyDeps.confDir, '50-inbound.json')), false);
    assert.equal(applyDeps.restarts, 0);

    // The node's own tag is of course fine.
    assert.equal(applyRequest(request(), applyDeps).changed, true);

    // A fragment we cannot parse could be hiding any tag, so fail closed.
    fs.writeFileSync(join(applyDeps.confDir, '20-extra.json'), '{not json');
    assert.throws(() => applyRequest(request({ listenPort: 8443 }), applyDeps), /无法解析/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('助手在发布之前就拒绝无法满足的监听族', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'xray-apply-family-'));
  try {
    // The host has no IPv6 stack, but the node's public endpoint is IPv6:
    // publishing first and failing afterwards would restart Xray onto a
    // listener no client can reach.
    const applyDeps = deps(root, { resolveListen: () => '0.0.0.0' });
    assert.throws(() => applyRequest(request({ requireListen: '::' }), applyDeps), /无法满足节点对外地址所需的 ::/);
    assert.equal(fs.existsSync(join(applyDeps.confDir, '50-inbound.json')), false);
    assert.equal(applyDeps.restarts, 0);

    // An IPv4 endpoint imposes nothing, and a matching requirement passes.
    assert.equal(applyRequest(request(), applyDeps).changed, true);
    assert.equal(applyRequest(request({ requireListen: '0.0.0.0', listenPort: 8443 }), applyDeps).changed, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('status 把「日志未提交」也算作可能已部署', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'xray-apply-status-'));
  try {
    const applyDeps = deps(root);
    const status = () => applyRequest(request({ mode: 'status' }), applyDeps);
    assert.equal(status().deployed, false, '什么都没有时就是没有');

    applyRequest(request(), applyDeps);
    assert.equal(status().deployed, true);

    // A helper that died after publishing and restarting but before committing
    // leaves `pending` set while the inbound serves. Reading that as "nothing
    // deployed" would let a re-onboarded host keep the previous identity's
    // listener; the caller's only action is to publish an empty inbound, which
    // is harmless if there really was nothing.
    const state = JSON.parse(readFileSync(applyDeps.stateFile, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(applyDeps.stateFile, JSON.stringify({ ...state, pending: true }));
    assert.equal(status().deployed, true, '未提交的日志不能当作「没有部署」的证据');

    // Only a config file with no state at all is still evidence.
    fs.unlinkSync(applyDeps.stateFile);
    assert.equal(status().deployed, true);
    fs.unlinkSync(join(applyDeps.confDir, '50-inbound.json'));
    assert.equal(status().deployed, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('已部署的监听族不满足新要求时，空转分支必须重新部署', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'xray-apply-family-change-'));
  try {
    // Deployed while the host had no IPv6: the listener is 0.0.0.0.
    const v4Only = deps(root, { resolveListen: () => '0.0.0.0' });
    const spec = request({ commandId: 'command-family' });
    assert.equal(applyRequest(spec, v4Only).listen, '0.0.0.0');
    assert.equal(applyRequest(spec, v4Only).restarted, false, '同一命令、同一族确实是空转');

    // The operator enables IPv6 and gives the node an IPv6 endpoint. Answering
    // "nothing to do" would hand back the v4 listener, the agent would reject
    // it, and every retry would take the same shortcut forever.
    const dualStack = deps(root, {
      confDir: v4Only.confDir, stateFile: v4Only.stateFile, resolveListen: () => '::',
    });
    const redeployed = applyRequest({ ...spec, requireListen: '::' }, dualStack);
    assert.equal(redeployed.listen, '::');
    assert.equal(redeployed.restarted, true, '族变了就必须重新部署');
    assert.equal(redeployed.realityPublicKey, keys.publicKey, '换族不换密钥');
    // And now it settles into a true no-op again.
    assert.equal(applyRequest({ ...spec, requireListen: '::' }, dualStack).restarted, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
