import 'reflect-metadata';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SystemUpdateService } from '../src/modules/common/system-update.service';
import { SystemUpdateStreamService } from '../src/modules/system/system-update-stream.service';

async function waitUntil(test: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!test()) { if (Date.now() > deadline) assert.fail('stream event deadline exceeded'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function main() {
  const directory = mkdtempSync(path.join(tmpdir(), 'chordv-update-stream-'));
  const row: any = { id: 'record', operationId: 'op', kind: 'update', status: 'running', phase: 'checking', progress: null,
    fromVersion: '0.0.12', toVersion: '0.0.13', startedAt: new Date(), finishedAt: null, actorLabel: null, actorUserId: null,
    failureReason: null, migrationApplied: false };
  const updates = new SystemUpdateService({ systemUpdateOperation: {
    findUnique: async () => ({ ...row }), update: async ({ data }: any) => { Object.assign(row, data); return row; }
  } } as never, {} as never);
  (updates as any).config.stateDir = directory;
  let allowed = true;
  const transport = new SystemUpdateStreamService(updates, { authenticateAccessToken: async () => ({ role: allowed ? 'admin' : 'user' }) } as never);
  const messages: any[] = [], errors: unknown[] = [];
  let subscription = transport.stream('op', 'test-only').subscribe({ next: message => {
    const data = JSON.parse(String(message.data)); if (data.operation) messages.push(data.operation);
  }, error: error => errors.push(error) });
  try {
    await waitUntil(() => messages.length > 0);
    assert.equal(messages.at(-1).phase, 'checking');
    await (updates as any).markPhase('op', 'downloading', 45);
    await waitUntil(() => messages.at(-1)?.progress === 45);
    writeFileSync(path.join(directory, 'phase.json'), JSON.stringify({ operationId: 'op', phases: ['snapshotting', 'migrating', 'health-gating'] }));
    await waitUntil(() => messages.at(-1)?.phase === 'health-gating');
    assert.ok(messages.at(-1).observedPhases.includes('snapshotting'));
    writeFileSync(path.join(directory, 'operation-result.op.json'), JSON.stringify({ operationId: 'op', status: 'success', version: '0.0.13' }));
    await waitUntil(() => subscription.closed);
    assert.equal(messages.at(-1).status, 'succeeded'); assert.deepEqual(errors, []);
    const reconnected: any[] = [];
    subscription = transport.stream('op', 'test-only').subscribe({ next: event => { const data = JSON.parse(String(event.data)); if (data.operation) reconnected.push(data.operation); }, error: e => errors.push(e) });
    await waitUntil(() => subscription.closed);
    assert.equal(reconnected[0].status, 'succeeded', 'new stream must read completed state without replay history');
    row.status = 'running'; row.phase = 'checking'; rmSync(path.join(directory, 'phase.json'));
    subscription = transport.stream('op', 'test-only').subscribe({ next() {}, error: e => errors.push(e) });
    await new Promise(resolve => setTimeout(resolve, 20));
    allowed = false;
    await (updates as any).markPhase('op', 'downloading', 55);
    await waitUntil(() => subscription.closed);
    assert.equal((errors.at(-1) as { getStatus(): number }).getStatus(), 403, 'role must be revalidated on subsequent events');
  } finally { subscription.unsubscribe(); updates.onModuleDestroy(); rmSync(directory, { recursive: true, force: true }); }
  console.log('system update SSE passed: persisted progress, supervisor file notification, terminal completion, reconnect, auth revalidation');
}
void main();
