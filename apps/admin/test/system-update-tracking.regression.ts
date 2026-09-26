import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { observeSystemOperation, parseOperationEvents } from '../src/features/system-update/operation-observer';
import { operationProgress, restartExpected, restartImminent, restartView, trackRestart, RESTART_COUNTDOWN_SECONDS,
  RESTART_OVERDUE_SECONDS, RESTART_RETRY_MS, type RestartWait } from '../src/features/system-update/operation-presentation';
import { waitForUpdatedPage, saveCompletion, readCompletion, clearCompletion, completionWarning,
  readRestartWait, saveRestartWait, clearRestartWait } from '../src/features/system-update/page-refresh';
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
  assert.equal(connections.at(-1), 'reconnecting', 'HTTP headers alone must not revive stale progress');
  stream.send(operation('succeeded')); await flush();
  assert.deepEqual(seen, ['running', 'succeeded']); assert.equal(time.size(), 0);
  stop();
}
{
  const extracting = operation('running', 'extracting');
  const disconnected = operationProgress(extracting, 'update', 'reconnecting');
  assert.equal(disconnected.title, '等待后台恢复连接');
  assert.equal(disconnected.lastConfirmed, '解压更新包');
  assert.equal(disconnected.steps.find(step => step.id === 'extracting')?.state, 'unconfirmed');
  assert.equal(disconnected.steps.find(step => step.id === 'switching')?.state, 'waiting', 'disconnect must not prove extraction completed');
  assert.equal(operationProgress(operation('running', 'downloading'), 'update', 'reconnecting').showDownloadProgress, false);
  assert.equal(operationProgress(extracting, 'update', 'connecting').steps.find(step => step.id === 'extracting')?.state, 'unconfirmed');
  for (const phase of ['draining', 'snapshotting', 'migrating', 'health-gating', 'stabilizing', 'rollback-health-gating', 'rollback-stabilizing']) {
    const view = operationProgress(operation('running', phase), 'update', 'live');
    assert.equal(view.title, '服务切换中，等待恢复');
    assert.deepEqual(view.steps.map(step => step.id), ['downloading', 'extracting', 'switching', 'result']);
    assert.equal(view.steps.find(step => step.id === 'switching')?.state, 'active');
    assert.equal(view.steps.find(step => step.id === 'result')?.state, 'waiting', 'healthy or stabilizing is not final success');
  }
  for (const kind of ['rollback', 'restart'] as const) {
    const view = operationProgress(operation('running', 'draining'), kind, 'paused');
    assert.equal(view.title, '状态观察已暂停');
    assert.deepEqual(view.steps.map(step => step.id), ['switching', 'result']);
    assert.equal(view.steps[0].state, 'unconfirmed');
  }
}
{
  const time = clock(), seen: string[] = [], connections: string[] = [];
  let openings = 0, recovered!: ReturnType<typeof streamResponse>;
  const stop = observeSystemOperation('op', { timers: time.timers,
    stream: async signal => {
      if (++openings === 1) return new Response('Service awaiting supervisor approval', { status: 503 });
      recovered = streamResponse(signal); return recovered.response;
    },
    snapshot: async () => assert.fail('promotion 503 must not switch to legacy polling'),
    onOperation: op => seen.push(op.status), onConnection: state => connections.push(state) });
  await time.advance(); assert.equal(connections.at(-1), 'reconnecting');
  await time.advance(); assert.equal(connections.at(-1), 'reconnecting');
  assert.deepEqual(seen, []);
  recovered.send(operation('rolled_back')); await flush();
  assert.deepEqual(seen, ['rolled_back']); assert.equal(time.size(), 0); stop();
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
  probes = 0;
  assert.equal(await waitForUpdatedPage('0.0.13', new AbortController().signal,
    async () => ++probes < 3 ? null : '0.0.13', async () => {}), true, 'unstamped old HTML must allow the webroot switch');
  assert.equal(probes, 3);
  probes = 0;
  assert.equal(await waitForUpdatedPage('0.0.13', new AbortController().signal, async () => { probes++; return null; }, async () => {}), false,
    'a permanently unstamped target requires explicit refresh after bounded retries');
  assert.equal(probes, 10);
  probes = 0;
  assert.equal(await waitForUpdatedPage('0.0.13', new AbortController().signal, async () => { probes++; return '0.0.12'; }, async () => {}), false);
  assert.equal(probes, 10, 'static readiness retries must terminate');
  const cancelled = new AbortController(); cancelled.abort();
  assert.equal(await waitForUpdatedPage('0.0.13', cancelled.signal, async () => assert.fail('closed panel must not probe')), false);
}
{
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  } });
  try {
    const completed = { operationId: 'rollback-migration', kind: 'update' as const, status: 'rolled_back' as const,
      version: '0.0.12', migrationApplied: true, at: Date.now() };
    saveCompletion(completed);
    const restored = readCompletion();
    assert.deepEqual(restored, completed, 'migration evidence survives page reload');
    assert.match(completionWarning(restored!)!, /数据库迁移未回滚/);
    assert.deepEqual(readCompletion(), completed, 'reading the banner must not consume it before another reload');
    assert.equal(completionWarning({ ...completed, migrationApplied: false }), null);
    assert.equal(completionWarning({ ...completed, status: 'succeeded' }), null);
    clearCompletion(); assert.equal(readCompletion(), null);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
}
// ── Expected restart: countdown instead of "等待后台恢复连接" (issue #47) ──
const update = (status: string, phase: string | null, extra: Partial<SystemUpdateOperationDto> = {}) =>
  ({ operationId: 'op', kind: 'update', status, phase, toVersion: '0.0.17', ...extra } as SystemUpdateOperationDto);
{
  const now = 1_000_000;
  // The drain closes the stream before the "draining" write is delivered, so the
  // last phase a healthy update shows is "extracting": that drop is the restart.
  const wait = trackRestart(null, update('running', 'extracting'), 'reconnecting', now);
  assert.deepEqual(wait, { operationId: 'op', kind: 'update', toVersion: '0.0.17', since: now });
  assert.equal(restartExpected(update('running', 'extracting')), true);
  assert.equal(trackRestart(wait, update('running', 'extracting'), 'reconnecting', now + 9000), wait, 'retries must not restart the countdown');
  assert.equal(trackRestart(wait, null, 'reconnecting', now + 9000), wait, 'a reloaded page without a snapshot keeps waiting');
  assert.equal(trackRestart(wait, update('running', 'extracting'), 'connecting', now + 9000), wait);
  assert.equal(trackRestart(wait, update('running', 'stabilizing'), 'live', now + 20_000), wait, 'supervisor phases continue the same restart');
  assert.equal(trackRestart(wait, update('running', 'extracting'), 'live', now + 3000), null,
    'a live snapshot still extracting proves it was only a network blip');
  assert.equal(trackRestart(wait, update('succeeded', null), 'live', now + 25_000), null, 'terminal results end the wait');
  assert.equal(trackRestart(wait, update('failed', null), 'live', now + 25_000), null, 'failures are never hidden behind the countdown');
  assert.notEqual(trackRestart(wait, update('running', 'extracting', { operationId: 'other' }), 'reconnecting', now)?.operationId, 'op');
  // Live "draining" already means the process is going down.
  assert.deepEqual(trackRestart(null, update('running', 'draining'), 'live', now)?.since, now);
  for (const phase of ['snapshotting', 'migrating', 'health-gating', 'stabilizing', 'rollback-health-gating', 'rollback-stabilizing'])
    assert.equal(restartImminent(update('running', phase)), true, phase);
  // Before extraction a drop is not an expected restart: keep "进度暂不可确认".
  for (const phase of ['checking', 'downloading', null]) {
    assert.equal(trackRestart(null, update('running', phase), 'reconnecting', now), null, String(phase));
    assert.equal(restartExpected(update('running', phase)), false);
  }
  assert.equal(operationProgress(update('running', 'downloading'), 'update', 'reconnecting').title, '等待后台恢复连接');
  assert.equal(trackRestart(null, update('running', 'extracting'), 'connecting', now), null, 'initial connect is not a disconnect');
  assert.equal(trackRestart(null, update('running', 'extracting'), 'paused', now), null);
  for (const kind of ['rollback', 'restart'] as const)
    assert.equal(trackRestart(null, update('running', 'checking', { kind }), 'reconnecting', now)?.kind, kind, 'rollback/restart always restart');
}
{
  const wait = { operationId: 'op', kind: 'update' as const, toVersion: '0.0.17', since: 0 };
  const start = restartView(wait, 0);
  assert.equal(start.title, '更新已安装，服务正在重启');
  assert.equal(start.countdown, RESTART_COUNTDOWN_SECONDS);
  assert.equal(start.description, `${RESTART_COUNTDOWN_SECONDS} 秒后自动刷新页面`);
  assert.ok(RESTART_COUNTDOWN_SECONDS >= 20 && RESTART_COUNTDOWN_SECONDS <= 45, 'countdown must cover drain + promotion + 10s stabilization');
  assert.equal(restartView(wait, 12_400).countdown, RESTART_COUNTDOWN_SECONDS - 12);
  const expired = restartView(wait, RESTART_COUNTDOWN_SECONDS * 1000);
  assert.equal(expired.countdown, 0); assert.equal(expired.overdue, false); assert.equal(expired.percent, 100);
  assert.match(expired.description, /即将完成.*自动刷新页面/);
  assert.equal(restartView(wait, (RESTART_OVERDUE_SECONDS - 1) * 1000).overdue, false);
  const overdue = restartView(wait, RESTART_OVERDUE_SECONDS * 1000);
  assert.equal(overdue.overdue, true); assert.equal(overdue.title, '服务长时间未恢复');
  assert.match(overdue.description, /已等待约 3 分钟.*检查服务器状态/);
  const restart = restartView({ ...wait, kind: 'restart' }, 0);
  assert.equal(restart.title, '服务正在重启');
  assert.doesNotMatch(restart.description, /刷新页面/, 'a same-version restart does not reload the page');
  assert.equal(restartView({ ...wait, kind: 'rollback' }, 0).title, '回滚已就绪，服务正在重启');
}
{
  // Hook wiring: extracting → drain → 502s → supervisor 503 → confirmed result.
  // During the restart the observer retries every RESTART_RETRY_MS, not 3s→30s.
  const time = clock(), delays: number[] = [];
  let wait: RestartWait | null = null, last: SystemUpdateOperationDto | null = null, openings = 0, now = 0;
  let current!: ReturnType<typeof streamResponse>;
  const results: string[] = [];
  const stop = observeSystemOperation('op', { timers: time.timers,
    stream: async signal => {
      openings++;
      if (openings === 1 || openings === 5) { current = streamResponse(signal); return current.response; }
      if (openings === 4) return new Response('Service awaiting supervisor approval', { status: 503 });
      throw new Error('502 Bad Gateway');
    },
    snapshot: async () => assert.fail('no legacy polling'),
    retryDelay: backoff => { const next = wait ? RESTART_RETRY_MS : backoff; delays.push(next); return next; },
    onConnection: state => { if (state !== 'live') wait = trackRestart(wait, last, state, now); },
    onOperation: op => {
      last = op;
      if (['succeeded', 'failed', 'rolled_back'].includes(op.status)) { results.push(op.status); wait = null; }
      else wait = trackRestart(wait, op, 'live', now);
    } });
  await time.advance(); current.send(update('running', 'downloading')); await flush();
  current.send(update('running', 'extracting')); await flush();
  assert.equal(wait, null, 'live extraction is ordinary progress');
  now = 5000; current.disconnect(); await flush();
  assert.deepEqual(wait, { operationId: 'op', kind: 'update', toVersion: '0.0.17', since: 5000 });
  assert.equal(await time.advance(), RESTART_RETRY_MS);
  assert.equal(await time.advance(), RESTART_RETRY_MS);
  assert.equal(await time.advance(), RESTART_RETRY_MS, 'the supervisor 503 is part of the restart');
  assert.equal(await time.advance(), RESTART_RETRY_MS);
  assert.equal(openings, 5);
  current.send(update('succeeded', null)); await flush();
  assert.deepEqual(results, ['succeeded']); assert.equal(wait, null); assert.equal(time.size(), 0);
  assert.ok(delays.every(ms => ms === RESTART_RETRY_MS));
  stop();
}
{
  // Without an expected restart the observer keeps its exponential backoff.
  const time = clock();
  const stop = observeSystemOperation('op', { timers: time.timers, stream: async () => { throw new Error('offline'); },
    snapshot: async () => null, retryDelay: backoff => backoff, onOperation() {}, onConnection() {} });
  assert.equal(await time.advance(), 0); assert.equal(await time.advance(), 6000); stop();
}
{
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  } });
  try {
    const wait = { operationId: 'op', kind: 'update' as const, toVersion: '0.0.17', since: Date.now() };
    saveRestartWait(wait);
    assert.deepEqual(readRestartWait(), wait, 'a reload resumes the restart view instead of a connection error');
    assert.equal(readRestartWait(wait.since + 31 * 60_000), null, 'a stale restart marker is ignored');
    values.set('chordv:system-update:restart', JSON.stringify({ ...wait, kind: 'bogus' }));
    assert.equal(readRestartWait(), null);
    values.set('chordv:system-update:restart', '{');
    assert.equal(readRestartWait(), null);
    saveRestartWait(wait); clearRestartWait(); assert.equal(readRestartWait(), null);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
}
{
  const source = readFileSync(new URL('../src/features/system-update/OperationProgress.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /暂停重连/, 'the pause-reconnect control is gone');
  const badge = readFileSync(new URL('../src/features/system-update/SystemUpdateBadge.tsx', import.meta.url), 'utf8');
  assert.match(badge, /<RestartProgress/, 'the panel renders the countdown view for an expected restart');
}
console.log('system update observer and page-refresh regressions passed');
