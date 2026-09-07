import assert from 'node:assert/strict';
import fs, { type PathLike } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { mock } from 'node:test';
import { resolveCredentials } from '../src/credentials.js';
import { AGENT_VERSION } from '../src/agent-version.js';
import type { AgentConfig } from '../src/config.js';
import type { AgentRegisterRequest } from '../src/api-client.js';

function config(file: string): AgentConfig {
  return { credentialsPath: file, registerToken: 'chordv_register_fixture', agentId: '', nodeId: '', token: '',
    apiBaseUrl: 'http://127.0.0.1:1', xrayApiAddress: '127.0.0.1:10085', xrayInboundTag: 'in',
    databasePath: join(dirname(file), 'agent.db'), sampleIntervalMs: 5000, heartbeatIntervalMs: 15000, offlineAllowanceBytes: 1n };
}
const identity = { accepted: true, agentId: 'agent-original', nodeId: 'node-original' };
const mode = (file: string) => fs.statSync(file).mode & 0o777;

test('missing parents are created and the durable retry secret precedes the first request', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'agent-credential-replay-'));
  const file = join(root, 'nested', 'private', 'credentials.json');
  const requests: AgentRegisterRequest[] = [];
  try {
    await assert.rejects(resolveCredentials(config(file), async (_base, payload) => {
      requests.push(payload);
      assert.equal(JSON.parse(fs.readFileSync(file + '.pending', 'utf8')).agentToken, payload.agentToken);
      assert.equal(mode(file + '.pending'), 0o600); assert.equal(mode(dirname(file)), 0o700);
      assert.equal(payload.agentVersion, AGENT_VERSION);
      throw new Error('response lost after commit');
    }), /response lost/);
    const saved = await resolveCredentials(config(file), async (_base, payload) => { requests.push(payload); return identity; });
    assert.equal(requests[1].agentToken, requests[0].agentToken);
    assert.equal(saved.token, requests[0].agentToken);
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual({ agentId: persisted.agentId, nodeId: persisted.nodeId, token: persisted.token }, saved);
    // The one-time registration token is never stored, only its fingerprint.
    assert.match(persisted.registerTokenFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(fs.readFileSync(file, 'utf8').includes(config(file).registerToken as string), false);
    assert.equal(mode(file), 0o600);
    assert.deepEqual(await resolveCredentials(config(file), async () => { assert.fail('restart must use final credentials'); }), saved);
    assert.equal(fs.readdirSync(dirname(file)).some(name => name.includes('.tmp.')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('real parent-path failure rejects before any request', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'agent-credential-parent-'));
  fs.writeFileSync(join(root, 'blocked'), 'file, not directory');
  try {
    await assert.rejects(resolveCredentials(config(join(root, 'blocked', 'credentials.json')), async () => { assert.fail('must not register'); }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const method of ['mkdirSync', 'openSync', 'writeFileSync', 'fchmodSync', 'fsyncSync', 'renameSync'] as const) {
  test(`${method} failure cannot consume a registration token`, async () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'agent-credential-write-fail-'));
    let calls = 0;
    const failure = mock.method(fs, method, (() => { throw Object.assign(new Error('storage failure'), { code: 'EIO' }); }) as never);
    try {
      await assert.rejects(resolveCredentials(config(join(root, 'credentials.json')), async () => { calls++; return identity; }), /storage failure/);
      assert.equal(calls, 0);
    } finally { failure.mock.restore(); fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test('failure saving final credentials retains the same client secret for the next boot', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'agent-credential-final-fail-'));
  const file = join(root, 'credentials.json');
  const original = fs.renameSync;
  const failure = mock.method(fs, 'renameSync', (from: PathLike, to: PathLike) => {
    if (to === file) throw new Error('final rename failed');
    return original(from, to);
  });
  let firstToken = '';
  try {
    await assert.rejects(resolveCredentials(config(file), async (_base, payload) => { firstToken = payload.agentToken; return identity; }), /final rename failed/);
    failure.mock.restore();
    const saved = await resolveCredentials(config(file), async (_base, payload) => { assert.equal(payload.agentToken, firstToken); return identity; });
    assert.equal(saved.token, firstToken);
  } finally { failure.mock.restore(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('directory sync failure after rename must be retried before registration', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'agent-credential-directory-sync-'));
  const file = join(root, 'credentials.json');
  const original = fs.fsyncSync;
  const failure = mock.method(fs, 'fsyncSync', (fd: number) => {
    if (fs.fstatSync(fd).isDirectory()) throw new Error('directory sync failed');
    return original(fd);
  });
  const noRequest = async () => { assert.fail('visible pending file is not proof of durable sync'); };
  try {
    await assert.rejects(resolveCredentials(config(file), noRequest), /directory sync failed/);
    const first = JSON.parse(fs.readFileSync(file + '.pending', 'utf8')).agentToken;
    await assert.rejects(resolveCredentials(config(file), noRequest), /directory sync failed/);
    failure.mock.restore();
    await resolveCredentials(config(file), async (_base, payload) => { assert.equal(payload.agentToken, first); return identity; });
  } finally { failure.mock.restore(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('corrupt pending credentials do not silently generate another identity', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'agent-credential-corrupt-'));
  const file = join(root, 'credentials.json');
  try {
    for (const content of ['{', '{"agentToken":""}', '{"agentToken":42}']) {
      fs.writeFileSync(file + '.pending', content);
      await assert.rejects(resolveCredentials(config(file), async () => { assert.fail('must not register with a replacement secret'); }), /凭据文件损坏/);
      assert.equal(fs.readFileSync(file + '.pending', 'utf8'), content);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('real HTTP response loss replays the persisted credential on the next boot', async () => {
  const { createServer } = await import('node:http');
  const root = fs.mkdtempSync(join(tmpdir(), 'agent-credential-http-'));
  const file = join(root, 'new-parent', 'credentials.json');
  const requests: AgentRegisterRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString()) as AgentRegisterRequest;
    requests.push(payload);
    assert.equal(request.url, '/api/agent/v1/register');
    assert.equal(JSON.parse(fs.readFileSync(file + '.pending', 'utf8')).agentToken, payload.agentToken);
    assert.equal(mode(file + '.pending'), 0o600);
    if (requests.length === 1) { response.destroy(); return; }
    assert.equal(payload.agentToken, requests[0].agentToken);
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(identity));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const options = { ...config(file), apiBaseUrl: `http://127.0.0.1:${address.port}` };
  try {
    await assert.rejects(resolveCredentials(options), /fetch failed/);
    const saved = await resolveCredentials(options);
    assert.equal(saved.token, requests[0].agentToken);
    assert.deepEqual(await resolveCredentials(options), saved);
    assert.equal(requests.length, 2);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('visible newly-created parents must be re-synced after a previous failure', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'agent-credential-parent-sync-'));
  const parent = join(root, 'new-parent');
  const file = join(parent, 'nested', 'credentials.json');
  const original = fs.fsyncSync;
  const failure = mock.method(fs, 'fsyncSync', (fd: number) => {
    const stat = fs.fstatSync(fd);
    if (stat.isDirectory() && fs.existsSync(parent) && stat.ino === fs.statSync(parent).ino) throw new Error('parent sync failed');
    return original(fd);
  });
  try {
    const rejectRequest = async () => { assert.fail('must not register before ancestor durability'); };
    await assert.rejects(resolveCredentials(config(file), rejectRequest), /parent sync failed/);
    await assert.rejects(resolveCredentials(config(file), rejectRequest), /parent sync failed/);
    failure.mock.restore();
    await resolveCredentials(config(file), async () => identity);
  } finally { failure.mock.restore(); fs.rmSync(root, { recursive: true, force: true }); }
});


test('complete environment credentials override saved or damaged credentials without rewriting them', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'agent-credential-rotation-'));
  const file = join(root, 'credentials.json');
  const replacement = { agentId: 'rotated-agent', nodeId: 'rotated-node', token: 'rotated-secret' };
  const options = { ...config(file), ...replacement, registerToken: undefined };
  try {
    for (const previous of [JSON.stringify({ agentId: 'old', nodeId: 'old', token: 'revoked' }), '{corrupt']) {
      fs.writeFileSync(file, previous);
      assert.deepEqual(await resolveCredentials(options, async () => { assert.fail('explicit rotation must not register'); }), replacement);
      assert.equal(fs.readFileSync(file, 'utf8'), previous);
    }
    await assert.rejects(resolveCredentials({ ...options, token: '' }), /环境凭据必须完整/);
    await assert.rejects(resolveCredentials({ ...options, registerToken: 'register' }), /不能与注册令牌/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('a different registration token must not silently reuse the saved identity', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'agent-credential-reonboard-'));
  const file = join(root, 'credentials.json');
  try {
    const saved = await resolveCredentials(config(file), async () => identity);
    const fresh = { ...config(file), registerToken: 'chordv_register_second_node' };
    await assert.rejects(
      resolveCredentials(fresh, async () => { assert.fail('must not register while a stale identity is present'); }),
      /已存在其他注册令牌签发的 Agent 身份/
    );
    // The saved identity is untouched, so the original node keeps working.
    assert.deepEqual(await resolveCredentials(config(file), async () => { assert.fail('same token must not re-register'); }), saved);
    // Same token, unchanged host: still no reset, still the same identity.
    assert.deepEqual(await resolveCredentials({ ...config(file), resetIdentity: true }, async () => { assert.fail('no reset needed'); }), saved);

    const replacement = { accepted: true, agentId: 'agent-second', nodeId: 'node-second' };
    const requests: AgentRegisterRequest[] = [];
    const reset = await resolveCredentials({ ...fresh, resetIdentity: true }, async (_base, payload) => { requests.push(payload); return replacement; });
    assert.deepEqual(reset, { agentId: 'agent-second', nodeId: 'node-second', token: requests[0].agentToken });
    // A new node never inherits the previous node's client secret.
    assert.notEqual(reset.token, saved.token);
    const archived = fs.readdirSync(root).filter(name => name.includes('.replaced.'));
    assert.equal(archived.length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(join(root, archived[0]), 'utf8')).agentId, saved.agentId);
    // After the reset the new identity is stable without the flag.
    assert.deepEqual(await resolveCredentials(fresh, async () => { assert.fail('reset identity must persist'); }), reset);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a pending secret is never replayed under a different registration token', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'agent-credential-pending-rebind-'));
  const file = join(root, 'credentials.json');
  const first: AgentRegisterRequest[] = [];
  try {
    await assert.rejects(resolveCredentials(config(file), async (_base, payload) => { first.push(payload); throw new Error('response lost'); }), /response lost/);
    const second = { ...config(file), registerToken: 'chordv_register_other_node' };
    const rebound: AgentRegisterRequest[] = [];
    await resolveCredentials(second, async (_base, payload) => { rebound.push(payload); return identity; });
    assert.notEqual(rebound[0].agentToken, first[0].agentToken);
    assert.equal(JSON.parse(fs.readFileSync(file + '.pending', 'utf8')).agentToken, rebound[0].agentToken);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
