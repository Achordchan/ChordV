import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readExistingCredentials } from '../src/credentials.js';
import { AgentStore } from '../src/store.js';
import type { AgentConfig } from '../src/config.js';

// Resolves to src/main.ts under tsx and to dist/src/main.js when the compiled
// release is under test, so both run the code operators actually ship.
const entry = fileURLToPath(new URL('../src/main.js', import.meta.url));

function config(root: string, extra: Partial<AgentConfig> = {}): AgentConfig {
  return { credentialsPath: join(root, 'credentials.json'), registerToken: 'chordv_register_health', agentId: '', nodeId: '', token: '',
    apiBaseUrl: 'http://127.0.0.1:1', xrayApiAddress: '127.0.0.1:10085', xrayInboundTag: 'in',
    databasePath: join(root, 'agent.db'), sampleIntervalMs: 5000, heartbeatIntervalMs: 15000, offlineAllowanceBytes: 1n, ...extra };
}

test('the health probe never registers or creates files in the service data directory', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'agent-health-readonly-'));
  try {
    const probe = spawnSync(process.execPath, [...process.execArgv, entry, '--health'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CHORDV_API_BASE_URL: 'http://127.0.0.1:1',
        CHORDV_REGISTER_TOKEN: 'chordv_register_health',
        AGENT_CREDENTIALS_PATH: join(root, 'credentials.json'),
        AGENT_DATABASE_PATH: join(root, 'agent.db'),
        CHORDV_AGENT_ID: '', CHORDV_NODE_ID: '', CHORDV_AGENT_TOKEN: '',
      },
    });
    // Root-owned credentials or sqlite files here would break the unprivileged
    // service, so an unregistered host must be REPORTED, not bootstrapped.
    assert.deepEqual(fs.readdirSync(root), [], `health must not write anything: ${probe.stdout}${probe.stderr}`);
    assert.notEqual(probe.status, 0, 'an unregistered host is not healthy');
    assert.match(probe.stdout, /"ok":false/);
    assert.match(probe.stdout, /未注册/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('read-only credential lookup reports state without generating an identity', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'agent-health-credentials-'));
  const file = join(root, 'credentials.json');
  try {
    assert.equal(readExistingCredentials(config(root)), null);
    assert.deepEqual(fs.readdirSync(root), []);

    fs.writeFileSync(file, JSON.stringify({ agentId: 'a', nodeId: 'n', token: 't', registerTokenFingerprint: 'other' }));
    // A stale identity keeps the service from starting; the probe must say so
    // rather than silently reporting a healthy agent.
    assert.throws(() => readExistingCredentials(config(root)), /与当前注册令牌不匹配/);
    // Without a register token (the steady state) the saved identity is used as-is.
    assert.deepEqual(readExistingCredentials(config(root, { registerToken: undefined })), { agentId: 'a', nodeId: 'n', token: 't' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the health probe reports an interrupted reset instead of completing it', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'agent-health-reset-'));
  const file = join(root, 'credentials.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ agentId: 'a', nodeId: 'n', token: 't' }));
    fs.writeFileSync(`${file}.reset-journal`, JSON.stringify({ stamp: 1, files: [file] }));
    const before = fs.readdirSync(root).sort();
    assert.throws(() => readExistingCredentials(config(root)), /上次身份重置未完成/);
    // Completing the reset is a WRITE; the probe may only report it.
    assert.deepEqual(fs.readdirSync(root).sort(), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a read-only store refuses to create a database and cannot write', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'agent-health-store-'));
  const databasePath = join(root, 'nested', 'agent.db');
  const options = { nodeId: 'n', bootId: 'health-probe', defaultOfflineAllowanceBytes: 1n, readonly: true as const };
  try {
    assert.throws(() => new AgentStore(databasePath, options));
    assert.equal(fs.existsSync(join(root, 'nested')), false, 'a probe must not even create the data directory');

    const writable = new AgentStore(databasePath, { ...options, readonly: false });
    // A stopped service leaves no -shm: opening read-only would make SQLite
    // create it, so the probe must refuse rather than write as root.
    writable.close();
    assert.equal(fs.existsSync(`${databasePath}-shm`), false);
    assert.throws(() => new AgentStore(databasePath, options), /缺少 WAL 共享段/);
    assert.deepEqual(fs.readdirSync(join(root, 'nested')).sort(), ['agent.db']);

    const running = new AgentStore(databasePath, { ...options, readonly: false });
    const beforeProbe = fs.readdirSync(join(root, 'nested')).sort();
    const probe = new AgentStore(databasePath, options);
    try {
      const snapshot = probe.healthSnapshot();
      assert.equal(typeof snapshot.journalMode, 'string');
      assert.equal(snapshot.pendingBatches, 0);
      assert.throws(() => probe.advanceConfigRevision('1'), /readonly/i);
      // The probe adds no file of its own (no db, -wal or -shm) that the
      // service would then find owned by root.
      assert.deepEqual(fs.readdirSync(join(root, 'nested')).sort(), beforeProbe);
    } finally { probe.close(); running.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a read-only store refuses to probe a database it does not own', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'agent-health-owner-'));
  const databasePath = join(root, 'agent.db');
  const options = { nodeId: 'n', bootId: 'health-probe', defaultOfflineAllowanceBytes: 1n, readonly: true as const };
  try {
    const running = new AgentStore(databasePath, { ...options, readonly: false });
    try {
      assert.equal(fs.existsSync(`${databasePath}-shm`), true, 'the running service keeps its WAL sidecars');
      const euid = process.geteuid?.() ?? 0;
      if (euid === 0) {
        // The dangerous case in production: root probing the unprivileged
        // service's database. The -shm exists right now, so the old existence
        // check would have opened it — and had the service removed its sidecars
        // in that window, SQLite would have recreated them owned by root. The
        // ownership check refuses BEFORE SQLite is touched, which makes the
        // removal race harmless instead of merely unlikely.
        for (const suffix of ['', '-wal', '-shm']) fs.chownSync(`${databasePath}${suffix}`, 1000, 1000);
        const before = fs.readdirSync(root).sort();
        assert.throws(() => new AgentStore(databasePath, options), /必须以状态库所属用户（uid 1000）运行/);
        assert.deepEqual(fs.readdirSync(root).sort(), before, 'a refused probe creates nothing');
        for (const suffix of ['', '-wal', '-shm']) fs.chownSync(`${databasePath}${suffix}`, 0, 0);
      } else {
        // Unprivileged: a root-owned path stands in for the reverse mismatch.
        assert.throws(
          () => new AgentStore('/bin/sh', options),
          new RegExp(`必须以状态库所属用户（uid 0）运行，当前 uid ${euid}`),
        );
        // Its own database is probed normally.
        new AgentStore(databasePath, options).close();
      }
    } finally { running.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
