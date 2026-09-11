import concurrently from 'concurrently';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.CHORDV_ADMIN_PORT || 5174);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('后台页面端口必须为 1..65535');
const origin = `http://127.0.0.1:${port}`;
const lifetime = new AbortController();
let interrupted = false;
let startupFailed = false;
let forceStop;

// Reuse concurrently's process-tree handling on Windows and Unix. A stopped
// child ends the whole session. Agent opt-in is passed by start.sh only after
// shared configuration and dependencies are ready.
const childCommands = [
  { name: 'api', prefixColor: 'blue', command: 'corepack pnpm --filter @chordv/api dev:prepared' },
  { name: 'admin', prefixColor: 'green', command: `corepack pnpm --filter @chordv/admin dev --host 127.0.0.1 --port ${port} --strictPort --logLevel warn` }
];
if (process.env.CHORDV_DEV_WITH_AGENT === '1') childCommands.push({name:'node-agent',prefixColor:'cyan',command:'node ./scripts/local-node-agent-dev.mjs'});
const { commands, result } = concurrently(childCommands, { cwd: root, prefix: 'name', killOthersOn: ['success', 'failure'], killSignal: 'SIGTERM', killTimeout: 10_000, successCondition: 'all' });
const finished = result.then(() => { lifetime.abort(); return 0; }, () => { lifetime.abort(); return 1; });

function armStopDeadline() {
  if (forceStop) return;
  forceStop = setTimeout(() => commands.forEach(command => command.kill('SIGKILL')), 10_000);
  forceStop.unref();
}
function onSignal() {
  // concurrently already forwards the original signal; do not send it twice.
  interrupted = true;
  lifetime.abort();
  armStopDeadline();
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, onSignal);

async function pageReady() {
  const response = await fetch(origin, { signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(1500)]), redirect: 'error' });
  const ready = response.ok && response.headers.get('content-type')?.includes('text/html');
  await response.body?.cancel();
  return ready;
}
async function apiReady() {
  // Check through the browser's same-origin route, not merely the API port.
  const response = await fetch(`${origin}/api/health/ready`, { signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(1500)]), redirect: 'error' });
  if (!response.ok) { await response.body?.cancel(); return false; }
  return (await response.json()).status === 'ready';
}

try {
  const deadline = Date.now() + 90_000;
  let ready = false;
  // Startup-only readiness wait, bounded and cancelled on process exit. It
  // stops permanently after readiness; live application state still uses SSE.
  while (!lifetime.signal.aborted && Date.now() < deadline) {
    const results = await Promise.allSettled([pageReady(), apiReady()]);
    if (results.every(item => item.status === 'fulfilled' && item.value === true)) { ready = true; break; }
    await sleep(500, undefined, { signal: lifetime.signal });
  }
  if (ready && !lifetime.signal.aborted) {
    console.log(`\n后台服务已就绪：${origin}\n页面和 API 共用此访问地址。按 Ctrl+C 停止。\n`);
  } else if (!lifetime.signal.aborted) {
    throw new Error('后台在 90 秒内未就绪，请查看上方 [api] 或 [admin] 错误；本次进程将停止。');
  }
} catch (error) {
  if (!lifetime.signal.aborted) {
    startupFailed = true;
    console.error(error instanceof Error ? error.message : String(error));
    lifetime.abort();
    commands.forEach(command => command.kill('SIGTERM'));
    armStopDeadline();
  }
}
const exitCode = await finished;
clearTimeout(forceStop);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, onSignal);
process.exitCode = interrupted ? 0 : startupFailed ? 1 : exitCode;
