import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { verifyBackendRelease } from './verify-backend-release.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
test('API and Go start together; Go tests/vet/build stay ordered', async () => {
  const api = deferred(), go = deferred(), calls = [];
  const pending = verifyBackendRelease({ summaryFile: '', log() {}, run: async (command, args) => {
    calls.push([command, args]);
    if (command === 'pnpm') await api.promise;
    if (command === 'go' && args[0] === 'test') await go.promise;
  } });
  assert.deepEqual(calls.map(([cmd, args]) => [cmd, args[0]]), [['pnpm', 'test:api'], ['go', 'test']]);
  go.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[2][1][0], 'vet'); assert.equal(calls[3][1][0], 'scripts/build-go-agent.mjs');
  api.resolve(); assert.ok((await pending).every(item => item.passed));
});
for (const failed of ['api', 'go']) test(`${failed} failure blocks release and observes both branches`, async () => {
  const other = deferred(), calls = [];
  const pending = verifyBackendRelease({ summaryFile: '', log() {}, run: async (command, args) => {
    calls.push([command, args[0]]);
    if ((command === 'pnpm') === (failed === 'api')) throw new Error('expected verification failure');
    await other.promise;
  } });
  const rejected = assert.rejects(pending, /do not package or publish/);
  other.resolve(); await rejected;
  if (failed === 'go') assert.equal(calls.some(([, name]) => name === 'scripts/build-go-agent.mjs'), false);
});
test('workflow joins verification before backend packaging/signing', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release-backend.yml', import.meta.url), 'utf8');
  const check = workflow.indexOf('node scripts/verify-backend-release.mjs');
  assert.ok(check > workflow.indexOf('name: Setup Go for bundled node agent'));
  assert.ok(check < workflow.indexOf('name: Assemble relocatable release tree'));
  assert.equal((workflow.match(/node scripts\/build-go-agent.mjs/g) ?? []).length, 0);
});
