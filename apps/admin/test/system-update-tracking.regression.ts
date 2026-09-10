import assert from 'node:assert/strict';
import { observeSystemOperation, parseOperationEvents } from '../src/features/system-update/operation-observer';
import { waitForUpdatedPage } from '../src/features/system-update/page-refresh';
import type { SystemUpdateOperationDto } from '@chordv/shared';

const operation = (status: string, phase = 'extracting') => ({ operationId: 'op', kind: 'update', status, phase } as SystemUpdateOperationDto);
const flush = async () => { for (let n = 0; n < 60; n++) await Promise.resolve(); };
function clock() {
  let next = 0;
  const tasks = new Map<number, { callback: () => void; ms: number }>();
  return {
    timers: { set: ((callback: () => void, ms: number) => { const id = ++next; tasks.set(id, { callback, ms }); return id; }) as never,
      clear: ((id: number) => tasks.delete(id)) as never },
    async advance() {
      const item = [...tasks].sort((a, b) => a[1].ms - b[1].ms)[0]; assert.ok(item, 'a bounded observer timer must exist');
      tasks.delete(item[0]); item[1].callback(); await flush(); return item[1].ms;
    }, size: () => tasks.size
  };
}
function streamResponse(signal: AbortSignal) {
  let control!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { control = controller; } });
  signal.addEventListener('abort', () => { try { control.error(new Error('aborted')); } catch {} }, { once: true });
  return { response: new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    send(op: SystemUpdateOperationDto) { control.enqueue(new TextEncoder().encode(`event: operation\ndata: ${JSON.stringify({ operation: op })}\n\n`)); },
    disconnect() { control.close(); }
  };
}
{
  const time = clock(), seen: string[] = [], connections: string[] = [];
  let stream!: ReturnType<typeof streamResponse>, openings = 0;
  const stop = observeSystemOperation('op', { timers: time.timers,
    stream: async signal => { openings++; stream = streamResponse(signal); return stream.response; },
    snapshot: async () => assert.fail('modern backend must not poll the old status route'),
    onOperation: op => seen.push(op.status), onConnection: state => connections.push(state) });
  await time.advance(); stream.send(operation('running')); await flush();
  assert.deepEqual(seen, ['running']);
  stream.disconnect(); await flush(); assert.equal(connections.at(-1), 'reconnecting');
  await time.advance(); assert.equal(openings, 2);
  stream.send(operation('succeeded')); await flush();
  assert.deepEqual(seen, ['running', 'succeeded']); assert.equal(time.size(), 0);
  stop();
}
{
  const time = clock(), seen: string[] = []; let calls = 0;
  const stop = observeSystemOperation('op', { timers: time.timers,
    stream: async () => new Response('older backend', { status: 404 }),
    snapshot: async () => { calls++; return calls === 1 ? operation('running') : operation('rolled_back'); },
    onOperation: op => seen.push(op.status), onConnection() {} });
  await time.advance(); await time.advance(); assert.deepEqual(seen, ['running']);
  await time.advance(); assert.deepEqual(seen, ['running', 'rolled_back']); assert.equal(time.size(), 0); stop();
}
{
  const time = clock(), seen: unknown[] = [];
  const stop = observeSystemOperation('op', { timers: time.timers, stream: async () => { throw new Error('offline'); },
    snapshot: async () => null, onOperation: op => seen.push(op), onConnection() {} });
  assert.equal(await time.advance(), 0); assert.equal(await time.advance(), 6000); assert.equal(await time.advance(), 12000);
  assert.equal(await time.advance(), 24000); assert.equal(await time.advance(), 30000);
  assert.deepEqual(seen, [], 'network failure must not invent a terminal outcome'); stop(); assert.equal(time.size(), 0);
}
{
  const observed: unknown[] = [];
  const first = parseOperationEvents('event: operation\r\ndata: {"operation":', value => observed.push(value));
  assert.equal(observed.length, 0);
  const tail = parseOperationEvents(first + '{"operationId":"op","status":"running"}}\r\n\r\n', value => observed.push(value));
  assert.equal(tail, ''); assert.equal(observed.length, 1);
}
{
  let probes = 0;
  assert.equal(await waitForUpdatedPage('0.0.13', new AbortController().signal,
    async () => ++probes < 3 ? '0.0.12' : '0.0.13', async () => {}), true);
  assert.equal(probes, 3, 'do not reload while nginx still serves the old HTML');
  assert.equal(await waitForUpdatedPage('0.0.13', new AbortController().signal, async () => null, async () => {}), false,
    'an unstamped rollback target requires explicit refresh');
  probes = 0;
  assert.equal(await waitForUpdatedPage('0.0.13', new AbortController().signal, async () => { probes++; return '0.0.12'; }, async () => {}), false);
  assert.equal(probes, 10, 'static readiness retries must terminate');
  const cancelled = new AbortController(); cancelled.abort();
  assert.equal(await waitForUpdatedPage('0.0.13', cancelled.signal, async () => assert.fail('closed panel must not probe')), false);
}
console.log('system update observer and page-refresh regressions passed');
