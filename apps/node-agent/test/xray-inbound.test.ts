import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileInboundApplier, inboundSpecHash, parseInboundSpec } from '../src/xray-inbound.js';

const payload = () => ({
  inboundTag: 'vless-in',
  listenPort: 443,
  dest: 'www.microsoft.com:443',
  serverNames: ['www.microsoft.com'],
  flow: 'xtls-rprx-vision',
  fingerprint: 'chrome',
  spiderX: '/',
});

test('入站规格逐字段校验，拒绝会污染 root 配置的输入', () => {
  assert.deepEqual(parseInboundSpec(payload(), 'vless-in'), { ...payload(), rotateKeys: false });

  // The metering path reads exactly one tag, so a mismatched tag would deploy a
  // live inbound whose traffic is never billed.
  assert.throws(() => parseInboundSpec({ ...payload(), inboundTag: 'other' }, 'vless-in'), /计量使用的/);
  assert.throws(() => parseInboundSpec({ ...payload(), listenPort: 0 }, 'vless-in'), /端口/);
  assert.throws(() => parseInboundSpec({ ...payload(), listenPort: 65_536 }, 'vless-in'), /端口/);
  assert.throws(() => parseInboundSpec({ ...payload(), dest: 'www.microsoft.com' }, 'vless-in'), /host:port/);
  assert.throws(() => parseInboundSpec({ ...payload(), serverNames: [] }, 'vless-in'), /1-8/);
  assert.throws(() => parseInboundSpec({ ...payload(), serverNames: Array(9).fill('a.example.com') }, 'vless-in'), /1-8/);
  assert.throws(() => parseInboundSpec({ ...payload(), serverNames: ['bad host'] }, 'vless-in'), /合法域名/);
  assert.throws(() => parseInboundSpec({ ...payload(), flow: 'xtls-rprx-direct' }, 'vless-in'), /flow/);
  assert.throws(() => parseInboundSpec({ ...payload(), fingerprint: 'Chrome!' }, 'vless-in'), /fingerprint/);
  assert.throws(() => parseInboundSpec({ ...payload(), spiderX: '/a"b' }, 'vless-in'), /spiderX/);
});

test('规格指纹与字段顺序无关，但排除 rotateKeys', () => {
  const base = parseInboundSpec(payload(), 'vless-in');
  const reordered = parseInboundSpec({ spiderX: '/', fingerprint: 'chrome', flow: 'xtls-rprx-vision',
    serverNames: ['www.microsoft.com'], dest: 'www.microsoft.com:443', listenPort: 443, inboundTag: 'vless-in' }, 'vless-in');
  assert.equal(inboundSpecHash(base), inboundSpecHash(reordered));
  // Rotation is an action, not part of the deployed identity: including it would
  // make every repeat of a rotation command look like a brand-new inbound.
  assert.equal(inboundSpecHash({ ...base, rotateKeys: true }), inboundSpecHash(base));
  assert.notEqual(inboundSpecHash({ ...base, listenPort: 8443 }), inboundSpecHash(base));
});

// The helper publishes into a root-owned directory the agent cannot write; the
// tests keep them separate for the same reason production does.
function outDir(root: string): string {
  const out = join(root, 'out');
  fs.mkdirSync(out, { recursive: true });
  return out;
}

function applier(root: string, timeoutMs = 200) {
  return new FileInboundApplier(root, outDir(root), timeoutMs, 1, () => Promise.resolve());
}

test('助手应答按 requestId 关联，旧结果不算本次的答复', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'agent-inbound-'));
  try {
    const spec = parseInboundSpec(payload(), 'vless-in');
    fs.writeFileSync(join(outDir(root), 'result.json'), JSON.stringify({ requestId: 'stale', ok: true }));
    await assert.rejects(applier(root).apply(spec, 'fresh-request-id', 'command-7'), /超时/);
    // The stale answer must not have been consumed as this request's result.
    assert.equal(JSON.parse(fs.readFileSync(join(outDir(root), 'result.json'), 'utf8')).requestId, 'stale');
    // The request itself is written durably for the root helper to pick up.
    const pending = JSON.parse(fs.readFileSync(join(root, 'pending.json'), 'utf8'));
    assert.equal(pending.requestId, 'fresh-request-id');
    assert.equal(pending.mode, 'ensure');
    assert.equal(pending.commandId, 'command-7');
    assert.equal(pending.listenPort, 443);
    assert.equal(fs.statSync(join(root, 'pending.json')).mode & 0o777, 0o600);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('助手失败、畸形与超大应答都变成明确的错误', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'agent-inbound-bad-'));
  const spec = parseInboundSpec(payload(), 'vless-in');
  const result = join(outDir(root), 'result.json');
  try {
    const attempt = async (body: string) => {
      fs.writeFileSync(result, body);
      return applier(root).apply(spec, 'request-1', 'command-1');
    };
    await assert.rejects(attempt(JSON.stringify({ requestId: 'request-1', ok: false, stage: 'config-test', error: '端口冲突' })),
      /config-test.*端口冲突/);
    await assert.rejects(attempt('{not json'), /不是合法 JSON/);
    await assert.rejects(attempt(JSON.stringify({ requestId: 'request-1', ok: true, realityPublicKey: 'short', shortId: 'aabb', serverName: 'a.example.com', listen: '::', listenPort: 443 })),
      /公钥格式错误/);
    await assert.rejects(attempt(JSON.stringify({ requestId: 'request-1', ok: true, realityPublicKey: 'k'.repeat(43), shortId: 'zz', serverName: 'a.example.com', listen: '::', listenPort: 443 })),
      /shortId 格式错误/);
    await assert.rejects(attempt(JSON.stringify({ requestId: 'request-1', ok: true, realityPublicKey: 'k'.repeat(43), shortId: 'aabb', serverName: 'a.example.com', listenPort: 443 })),
      /未返回监听地址/);
    fs.writeFileSync(result, `{"requestId":"request-1","ok":true,"pad":"${'x'.repeat(20_000)}"}`);
    await assert.rejects(applier(root).apply(spec, 'request-1', 'command-1'), /结果过大/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('合法应答被完整解析', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'agent-inbound-ok-'));
  try {
    const spec = parseInboundSpec(payload(), 'vless-in');
    fs.writeFileSync(join(outDir(root), 'result.json'), JSON.stringify({
      requestId: 'request-2', ok: true, changed: true, restarted: true,
      realityPublicKey: 'k'.repeat(43), shortId: '0123456789abcdef',
      serverName: 'www.microsoft.com', listen: '::', listenPort: 443, xrayVersion: 'Xray 1.8.24',
    }));
    assert.deepEqual(await applier(root).apply(spec, 'request-2', 'command-2'), {
      requestId: 'request-2', ok: true, changed: true, restarted: true,
      realityPublicKey: 'k'.repeat(43), shortId: '0123456789abcdef',
      serverName: 'www.microsoft.com', listen: '::', listenPort: 443, xrayVersion: 'Xray 1.8.24',
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('reset 的成功应答按 reset 规则解析，不会被当成部署结果拒绝', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'agent-inbound-reset-'));
  try {
    // A successful reset carries no keys and port 0 on purpose. Validating it as
    // a deployment would reject it — and that error would surface during agent
    // startup, after the foreign configuration had already been cleared.
    fs.writeFileSync(join(outDir(root), 'result.json'), JSON.stringify({
      requestId: 'reset-1', ok: true, changed: true, restarted: true,
      realityPublicKey: '', shortId: '', serverName: '', listenPort: 0,
    }));
    const result = await applier(root).reset('reset-1');
    assert.equal(result.ok, true);
    assert.equal(result.restarted, true);
    assert.equal(JSON.parse(fs.readFileSync(join(root, 'pending.json'), 'utf8')).mode, 'reset');

    // A failed reset still fails loudly.
    fs.writeFileSync(join(outDir(root), 'result.json'), JSON.stringify({ requestId: 'reset-2', ok: false, stage: 'apply', error: '磁盘只读' }));
    await assert.rejects(applier(root).reset('reset-2'), /磁盘只读/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
