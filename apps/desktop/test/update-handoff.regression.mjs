import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Plain-JS stand-in for userFacingErrors.isCustomerSafeText (only the branches these reports hit).
const isCustomerSafeText = text => /[\u3400-\u9fff]/.test(text) && !/[A-Za-z]{2,}(?:[\s-]+[A-Za-z]{2,}){2,}/.test(text);

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
    installWindowsUpdate: native('apply'),
    openDesktopInstaller: native('installer'),
    quitForUpdate: native('quit'),
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

const reportCallback = source.match(/const consumeUpdateInstallReport = useCallback\((async \(\) => \{[\s\S]*?\n  \}), \[/)?.[1];
assert.ok(reportCallback);
for (const input of ['read-error', { ok: false, summary: '自动更新失败，已恢复旧版本。' }, { ok: false, summary: 'Start-Process failed with exit code 5' }, { ok: true }, null]) {
  const notices = [];
  const run = new Function('consumeDesktopUpdateInstallReport', 'options', 'isCustomerSafeText', `return (${reportCallback});`)(
    async () => { if (input === 'read-error') throw new Error('invalid report'); return input; },
    { notify: notice => notices.push(notice) },
    isCustomerSafeText
  );
  await run();
  assert.equal(notices.length, input === 'read-error' || input?.ok === false ? 1 : 0);
  if (input === 'read-error') assert.equal(notices[0].title, '无法读取更新结果');
  if (input?.ok === false) {
    assert.equal(notices[0].title, '更新安装未完全成功');
    assert.equal(notices[0].message, /[\u3400-\u9fff]/.test(input.summary) ? input.summary : '更新没有安装完成。请重新检查更新后再试，或到官网下载安装包手动安装。', 'raw English summaries are replaced');
  }
}
console.log('installation report failures are visible; successful and absent reports stay silent');
