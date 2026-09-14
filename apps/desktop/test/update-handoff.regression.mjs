import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Execute the production callback with isolated native adapters; no installer runs.
const source = readFileSync(fileURLToPath(new URL('../src/hooks/useUpdateFlow.ts', import.meta.url)), 'utf8');
const callback = source.match(/const handleQuitForUpdate = useCallback\((async \(\) => \{[\s\S]*?\n  \}), \[/)?.[1];
assert.ok(callback, 'production update handoff callback must be found');

function scenario(platform, failAt, waitForApply) {
  const mandatory = { forceUpgrade: true };
  let confirmed = mandatory;
  const calls = [];
  const native = name => async () => {
    calls.push(name);
    if (name === 'apply' && waitForApply) await waitForApply;
    if (failAt === name) throw new Error(`${name} failed`);
  };
  const context = {
    updateDownload: { phase: 'completed', localPath: 'test-package' },
    options: { showError: message => calls.push(message) },
    effectiveUpdate: mandatory,
    updatePlatform: platform,
    isFullReplaceUpdate: () => platform === 'windows',
    applyDesktopFullUpdate: native('apply'),
    openDesktopInstaller: native('installer'),
    quitForUpdate: native('quit'),
    defaultReadError: value => value,
    dispatchUpdateCheck: event => { assert.equal(event.type, 'reset'); confirmed = null; calls.push('reset'); }
  };
  return {
    run: new Function(...Object.keys(context), `return (${callback});`)(...Object.values(context)),
    calls, confirmed: () => confirmed, mandatory
  };
}
for (const [platform, failAt] of [['windows', 'apply'], ['macos', 'installer'], ['macos', 'quit']]) {
  const state = scenario(platform, failAt);
  assert.equal(await state.run(), false);
  assert.equal(state.confirmed(), state.mandatory, `${platform}/${failAt} must retain confirmed update policy`);
  assert.ok(!state.calls.includes('reset'));
}
let finish;
const wait = new Promise(resolve => { finish = resolve; });
const pending = scenario('windows', null, wait);
const result = pending.run();
assert.equal(pending.confirmed(), pending.mandatory, 'in-flight handoff retains policy');
finish();
assert.equal(await result, true);
assert.deepEqual(pending.calls, ['apply', 'reset']);
const mac = scenario('macos');
assert.equal(await mac.run(), true);
assert.deepEqual(mac.calls, ['installer', 'quit', 'reset']);
console.log('update handoff regression checks passed (3 failures and 2 successes)');
