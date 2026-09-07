import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { AGENT_VERSION, readAgentVersion } from '../src/agent-version.js';

test('direct execution reports the packaged agent version instead of npm or dev', () => {
  const original = process.env.npm_package_version;
  try {
    delete process.env.npm_package_version;
    const sourcePackage = new URL('../package.json', import.meta.url);
    const packageFile = existsSync(sourcePackage) ? sourcePackage : new URL('../../package.json', import.meta.url);
    const expected = JSON.parse(readFileSync(packageFile, 'utf8')).version;
    assert.equal(readAgentVersion(), expected); assert.equal(AGENT_VERSION, expected);
    process.env.npm_package_version = '999.0.0';
    assert.equal(readAgentVersion(), expected);
  } finally {
    if (original === undefined) delete process.env.npm_package_version; else process.env.npm_package_version = original;
  }
});

test('relocated dist/src module resolves its own release package', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-version-package-'));
  try {
    mkdirSync(join(root, 'dist', 'src'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@chordv/node-agent', version: '4.5.6' }));
    assert.equal(readAgentVersion(pathToFileURL(join(root, 'dist', 'src', 'agent-version.js'))), '4.5.6');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('heartbeat uses the same packaged version as registration', async () => {
  const { AgentRunner } = await import('../src/runner.js');
  let version: string | undefined;
  const runner = Object.assign(Object.create(AgentRunner.prototype), {
    store: { healthSnapshot: () => ({ bootId: 'boot' }), getConfigRevision: () => '1', pendingBatchCount: () => 0, ackThrough: () => undefined },
    api: { heartbeat: async (payload: { version: string }) => { version = payload.version; return { ackThrough: '0', configRevision: '1' }; } },
    currentConfig: { controlMode: 'direct_primary' }
  }) as any;
  await runner.sendHeartbeat();
  assert.equal(version, AGENT_VERSION);
});
