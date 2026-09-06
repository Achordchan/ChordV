import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentStore } from '../src/store.js';

const desiredUser = {
  bindingId: 'binding-1',
  revision: '1',
  email: 'user@example.com',
  uuid: '11111111-1111-4111-8111-111111111111',
  flow: 'xtls-rprx-vision' as const,
  enabled: true,
  quotaRemainingBytes: '1073741824',
  offlineAllowanceBytes: '67108864',
};

function createStore(directory: string, bootId: string) {
  return new AgentStore(join(directory, 'agent.db'), {
    bootId,
    nodeId: 'node-1',
    defaultOfflineAllowanceBytes: 64n * 1024n * 1024n,
  });
}

test('每个新 boot 都发送全量绝对基线，即使计数没有变化', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chordv-agent-boot-baseline-'));
  const first = createStore(directory, 'boot-1');
  first.replaceDesiredUsers([desiredUser], '1');
  first.recordSample(
    [{ email: desiredUser.email, uplinkBytes: '10', downlinkBytes: '20' }],
    new Date('2026-07-26T00:00:00Z'),
    true,
  );
  first.close();

  const restarted = createStore(directory, 'boot-2');
  try {
    const baseline = restarted.recordSample(
      [{ email: desiredUser.email, uplinkBytes: '10', downlinkBytes: '20' }],
      new Date('2026-07-26T00:00:05Z'),
      true,
    );
    assert.equal(baseline.batch?.bootId, 'boot-2');
    assert.equal(baseline.batch?.sequence, '1');
    assert.deepEqual(baseline.batch?.samples, [{
      bindingId: desiredUser.bindingId,
      counterGeneration: '0',
      uplinkBytes: '10',
      downlinkBytes: '20',
      uplinkDeltaBytes: '0',
      downlinkDeltaBytes: '0',
    }]);
  } finally {
    restarted.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
