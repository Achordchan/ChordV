import { spawn } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function execute(command, args, cwd) {
  return new Promise((yes, no) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: process.env });
    child.once('error', no);
    child.once('exit', (code, signal) => code === 0 ? yes() : no(new Error(`${command} ${args.join(' ')} failed (${signal || code})`)));
  });
}

// These branches have disjoint outputs: Node tests generate shared/Prisma files;
// Go writes only its caches and agent-go-dist. Package assembly starts afterwards.
export async function verifyBackendRelease({ run = execute, log = console.log, summaryFile = process.env.GITHUB_STEP_SUMMARY } = {}) {
  const started = performance.now();
  const timed = async (name, task) => {
    const start = performance.now(); log(`[release:${name}] started`);
    try { await task(); return { name, seconds: (performance.now() - start) / 1000, passed: true }; }
    catch (error) { return { name, seconds: (performance.now() - start) / 1000, passed: false, error }; }
  };
  const results = await Promise.all([
    timed('api', () => run('pnpm', ['test:api'], root)),
    timed('go', async () => {
      await run('go', ['test', '-race', './...'], resolve(root, 'apps/agent'));
      await run('go', ['vet', './...'], resolve(root, 'apps/agent'));
      await run(process.execPath, ['scripts/build-go-agent.mjs'], root);
    })
  ]);
  for (const result of results) log(`[release:${result.name}] ${result.passed ? 'passed' : 'failed'} in ${result.seconds.toFixed(1)}s`);
  if (summaryFile) await appendFile(summaryFile, `\n| 检查分支 | 结果 | 耗时 |\n| --- | --- | --- |\n${results.map(r => `| ${r.name} | ${r.passed ? '通过' : '失败'} | ${r.seconds.toFixed(1)}s |`).join('\n')}\n\n并行阶段总耗时：${((performance.now() - started) / 1000).toFixed(1)}s。\n`);
  const errors = results.filter(result => !result.passed).map(result => result.error);
  if (errors.length) throw new AggregateError(errors, 'Release verification failed; do not package or publish');
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  verifyBackendRelease().catch(error => { console.error(error); process.exitCode = 1; });
}
