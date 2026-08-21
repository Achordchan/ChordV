import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSseFrame } from '../src/api-client.js';
import type { AgentHeartbeat, UsageBatch } from '../src/types.js';

test('SSE keepalive 被忽略，命令使用共享 wire shape', () => {
  assert.equal(parseSseFrame('event: keepalive\ndata: {"occurredAt":"2026-07-26T00:00:00Z"}'), null);
  const command = parseSseFrame('event: command\ndata: {"commandId":"c1","type":"DISABLE_USER","targetRevision":"900719925474099312345","payload":{"bindingId":"b1"},"createdAt":"2026-07-26T00:00:00Z"}');
  assert.equal(command?.commandId, 'c1');
  assert.equal(command?.targetRevision, '900719925474099312345');
  assert.deepEqual(command?.payload, { bindingId: 'b1' });
});

test('usage 与 heartbeat 契约不使用 JavaScript number 承载序列或 revision', () => {
  const batch: UsageBatch = {
    bootId: 'boot', sequence: '900719925474099312345', sampledAt: '2026-07-26T00:00:00Z',
    samples: [{
      bindingId: 'binding-1', counterGeneration: '900719925474099312346',
      uplinkBytes: '900719925474099312347', downlinkBytes: '2',
      uplinkDeltaBytes: '3', downlinkDeltaBytes: '4',
    }],
  };
  const heartbeat: AgentHeartbeat = {
    bootId: 'boot', version: '0.1.0', configRevision: '900719925474099312345',
    queueDepth: 1, xrayStatus: 'healthy',
  };
  const wire = JSON.parse(JSON.stringify({ batch, heartbeat })) as { batch: UsageBatch; heartbeat: AgentHeartbeat };
  assert.equal(wire.batch.sequence, '900719925474099312345');
  assert.equal(wire.batch.samples[0]?.counterGeneration, '900719925474099312346');
  assert.equal(wire.heartbeat.configRevision, '900719925474099312345');
  assert.equal('email' in (wire.batch.samples[0] as unknown as Record<string, unknown>), false);
});
