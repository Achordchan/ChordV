import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Plain-JS stand-in for userFacingErrors.isCustomerSafeText (only the branches these reports hit).
const isCustomerSafeText = text => /[\u3400-\u9fff]/.test(text) && !/[A-Za-z]{2,}(?:[\s-]+[A-Za-z]{2,}){2,}/.test(text);

// Execute the production callback with isolated native adapters; no installer runs.
const source = readFileSync(fileURLToPath(new URL('../src/hooks/useUpdateFlow.ts', import.meta.url)), 'utf8');
const callback = source.match(/const handleQuitForUpdate = useCallback\((async \(\) => \{[\s\S]*?\n  \}), \[/)?.[1];
assert.ok(callback, 'production update handoff callback must be found');

function scenario(platform, failAt, waitForApply, overrides = {}) {
  const mandatory = { forceUpgrade: true, channel: 'stable' };
  let confirmed = mandatory;
  let busy = false;
  const calls = [];
  const native = name => async () => {
    calls.push(name);
    if (name === 'apply' && waitForApply) await waitForApply;
    if (failAt === name) throw new Error(`${name} failed`);
    return { ok: true };
  };
  const context = {
    updateDownload: { phase: 'completed', localPath: 'test-package' },
    options: { showError: message => calls.push(message) },
    effectiveUpdate: mandatory,
    updateArtifactIdentity: 'artifact-a',
    artifactIdentityRef: { current: 'artifact-a' },
    completedDownloadIdentityRef: { current: 'artifact-a' },
    readyIdentity: 'artifact-a',
    updateChannel: 'stable',
    updateChannelRef: { current: 'stable' },
    updateInstallBusyRef: { current: false },
    updateCheckBusyRef: { current: false },
    setUpdateInstallBusy: value => { busy = value; },
    updatePlatform: platform,
    isFullReplaceUpdate: () => platform === 'windows',
    installWindowsUpdate: native('apply'),
    openDesktopInstaller: native('installer'),
    quitForUpdate: native('quit'),
    cancelPreparedDesktopUpdate: native('cancel'),
    dispatchUpdateCheck: event => { assert.equal(event.type, 'reset'); confirmed = null; calls.push('reset'); },
    ...overrides
  };
  return {
    run: new Function(...Object.keys(context), `return (${callback});`)(...Object.values(context)),
    calls, confirmed: () => confirmed, busy: () => busy, mandatory, context
  };
}
for (const platform of ['windows', 'macos']) {
  const stale = scenario(platform);
  stale.context.artifactIdentityRef.current = 'artifact-b';
  assert.equal(await stale.run(), false, `${platform}: 旧回调不得打开或安装已变更的更新包`);
  assert.ok(!stale.calls.includes('installer') && !stale.calls.includes('apply') && !stale.calls.includes('quit'));
  for (const overrides of [
    { completedDownloadIdentityRef: { current: 'artifact-b' } },
    { readyIdentity: 'artifact-b' },
    { updateArtifactIdentity: null },
    { effectiveUpdate: null },
    { updateChannel: 'beta' },
    { updateCheckBusyRef: { current: true } },
    { updateInstallBusyRef: { current: true } }
  ]) {
    const rejected = scenario(platform, null, null, overrides);
    assert.equal(await rejected.run(), false);
    assert.ok(!rejected.calls.includes('installer') && !rejected.calls.includes('apply') && !rejected.calls.includes('quit'));
  }
}
const changedWhileOpening = scenario('macos', null, null, {
  openDesktopInstaller: async () => {
    changedWhileOpening.calls.push('installer');
    changedWhileOpening.context.artifactIdentityRef.current = 'artifact-b';
    return { ok: true };
  }
});
assert.equal(await changedWhileOpening.run(), false, '开包等待期间身份改变不能继续退出');
assert.ok(!changedWhileOpening.calls.includes('quit') && !changedWhileOpening.calls.includes('reset'));
assert.ok(changedWhileOpening.calls.includes('cancel'), '暂存期间身份变化必须取消已准备helper');
assert.equal(changedWhileOpening.busy(), false);
const channelChangedWhileOpening = scenario('macos', null, null, {
  openDesktopInstaller: async () => {
    channelChangedWhileOpening.calls.push('installer');
    channelChangedWhileOpening.context.updateChannelRef.current = 'beta';
    return { ok: true };
  }
});
assert.equal(await channelChangedWhileOpening.run(), false, '同一包在准备期间切换渠道也必须取消');
assert.ok(channelChangedWhileOpening.calls.includes('cancel'));
assert.ok(!channelChangedWhileOpening.calls.includes('quit'));
for (const [platform, failAt] of [['windows', 'apply'], ['macos', 'installer'], ['macos', 'quit']]) {
  const state = scenario(platform, failAt);
  assert.equal(await state.run(), false);
  assert.equal(state.confirmed(), state.mandatory, `${platform}/${failAt} must retain confirmed update policy`);
  assert.ok(!state.calls.includes('reset'));
  assert.equal(state.busy(), false, `${platform}/${failAt}: 失败释放安装忙态`);
  assert.equal(state.context.updateInstallBusyRef.current, false);
  if (platform === 'macos' && failAt === 'quit') assert.ok(state.calls.includes('cancel'));
}
let finish;
const wait = new Promise(resolve => { finish = resolve; });
const pending = scenario('windows', null, wait);
const result = pending.run();
assert.equal(pending.confirmed(), pending.mandatory, 'in-flight handoff retains policy');
assert.equal(pending.busy(), true, '原生交接期间保持安装忙态');
assert.equal(await pending.run(), false, '同步ref阻止重复交接');
assert.deepEqual(pending.calls, ['apply']);
finish();
assert.equal(await result, true);
assert.deepEqual(pending.calls, ['apply', 'reset']);
assert.equal(pending.busy(), true, '成功后保持忙态直至原生退出');
assert.equal(await pending.run(), false, '成功交接后也不允许再次安装');
const mac = scenario('macos');
assert.equal(await mac.run(), true);
assert.deepEqual(mac.calls, ['installer', 'quit', 'reset']);
assert.equal(mac.busy(), true);
for (const failure of ['throw', 'false']) {
  const cleanupFailed = scenario('macos', 'quit', null, {
    cancelPreparedDesktopUpdate: async () => {
      cleanupFailed.calls.push('cancel');
      if (failure === 'throw') throw new Error('test-only cleanup failure');
      return { ok: false };
    }
  });
  assert.equal(await cleanupFailed.run(), false);
  assert.ok(cleanupFailed.calls.includes('cancel'));
  assert.ok(cleanupFailed.calls.some(value => /取消.*失败|未能取消/.test(String(value))), '取消失败必须明确告知，不能假装清理成功');
  assert.equal(cleanupFailed.confirmed(), cleanupFailed.mandatory);
  assert.equal(cleanupFailed.busy(), false);
}
let finishPrepare;
const preparing = new Promise(resolve => { finishPrepare = resolve; });
const slowMac = scenario('macos', null, null, {
  openDesktopInstaller: async () => { slowMac.calls.push('installer'); await preparing; return { ok: true }; }
});
const slowResult = slowMac.run();
assert.equal(slowMac.busy(), true, 'Mac长准备阶段立即进入忙态');
assert.equal(await slowMac.run(), false);
assert.deepEqual(slowMac.calls, ['installer']);
finishPrepare();
assert.equal(await slowResult, true);
assert.deepEqual(slowMac.calls, ['installer', 'quit', 'reset']);
assert.equal(slowMac.busy(), true);
for (const [platform, operation] of [['windows', 'installWindowsUpdate'], ['macos', 'openDesktopInstaller'], ['macos', 'quitForUpdate']]) {
  const refused = scenario(platform, null, null, { [operation]: async () => ({ ok: false }) });
  assert.equal(await refused.run(), false, `${platform}/${operation}: 原生明确拒绝不得当成交接成功`);
  assert.equal(refused.confirmed(), refused.mandatory);
  assert.equal(refused.busy(), false);
  if (platform === 'macos') assert.ok(refused.calls.includes('cancel'));
}
for (const [pattern, argument, expected] of [
  [/const handleUpdateDownload = useCallback\((async[\s\S]*?\n  \}), \[/, undefined, false],
  [/const runUpdateCheck = useCallback\(\s*(async[\s\S]*?\n    \}),\s*\[/, { source: 'manual' }, null],
  [/const handleUpdateCenterUpdateOne = useCallback\(\s*(async[\s\S]*?\n    \}),\s*\[/, 'xray', null],
  [/const closeUpdateCenter = useCallback\((\(\) => \{[\s\S]*?\n  \}), \[/, undefined, undefined]
]) {
  const snippet = source.match(pattern)?.[1];
  assert.ok(snippet, `必须找到真实生产忙态门禁：${pattern}`);
  const compiled = ts.transpileModule(`const action = ${snippet};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const run = new Function('updateInstallBusyRef', `${compiled}; return action;`)({ current: true });
  assert.equal(await run(argument), expected, '忙态时必须在启动检查/下载/组件同步或关闭前直接拒绝');
}
const installerAdapter = readFileSync(new URL('../src/lib/nativeInstaller.ts', import.meta.url), 'utf8');
const runtimeAdapter = readFileSync(new URL('../src/lib/runtime.ts', import.meta.url), 'utf8');
assert.match(installerAdapter, /invoke<\{ ok: boolean \}>\("cancel_desktop_update_install"\)/);
assert.match(source, /import \{ cancelPreparedDesktopUpdate \} from "\.\.\/lib\/nativeInstaller"/);
assert.doesNotMatch(runtimeAdapter, /cancelPreparedDesktopUpdate/, '新职责API不扩张旧runtime兼容导出基线');
console.log('update handoff regression checks passed (identity/channel cancellation, cleanup failures, synchronous busy guard and retained forced policy)');

const reportCallback = source.match(/const consumeUpdateInstallReport = useCallback\((async \(\) => \{[\s\S]*?\n  \}), \[/)?.[1];
assert.ok(reportCallback);
for (const [input, expectedTitle] of [
  [{ state: 'pending_recovery' }, '更新结果待确认'],
  ['read-error', '无法读取更新结果'],
  [{ ok: false, recoveryPending: true, summary: '更新失败，原版本已保留。' }, '更新安装未完全成功'],
  [{ ok: false, recoveryPending: true, summary: 'Start-Process failed with exit code 5' }, '更新安装未完全成功'],
  [{ ok: false, summary: '自动更新失败，已恢复旧版本。' }, '更新安装未完全成功'],
  [{ ok: false, summary: 'Start-Process failed with exit code 5' }, '更新安装未完全成功'],
  [{ state: 'unknown' }, '无法读取更新结果'],
  [{ ok: true, state: 'pending_recovery' }, null], [{ ok: true }, null], [null, null]
]) {
  const notices = [];
  const run = new Function('consumeDesktopUpdateInstallReport', 'options', 'isCustomerSafeText', `return (${reportCallback});`)(
    async () => { if (input === 'read-error') throw new Error('invalid report'); return input; },
    { notify: notice => notices.push(notice) },
    isCustomerSafeText
  );
  await run();
  assert.equal(notices.length, expectedTitle ? 1 : 0);
  if (expectedTitle) assert.equal(notices[0].title, expectedTitle);
  if (input?.ok === false) {
    assert.equal(notices[0].title, '更新安装未完全成功');
    const safeSummary = isCustomerSafeText(input.summary) ? input.summary : null;
    const advice = '暂时无法新建连接或重新安装更新。请保留更新文件并联系客服。';
    assert.equal(notices[0].message, input.recoveryPending ? (safeSummary ? `${safeSummary} ${advice}` : advice) : (safeSummary ?? '更新未完成。请在更新中心重新检查版本后再试。'), 'only the confirmed local recovery gate suppresses retry advice');
  }
}
console.log('installation report failures are visible; successful and absent reports stay silent');

// Two render-bound callbacks share the same refs, as they do across a channel switch.
const checkBody = source.match(/const runUpdateCheck = useCallback\(\s*(async[\s\S]*?\n    \}),\s*\[/)[1];
const checkJS = ts.transpileModule(`const runUpdateCheck = ${checkBody};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
for (const stage of ['manifest', 'manifest-error', 'components']) {
  const channels = [], events = [], effects = [], timers = [];
  let release, entered;
  const delayed = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const shared = {
    updateInstallBusyRef: { current: false }, updateCheckBusyRef: { current: false }, pendingUpdateCheckRef: { current: null },
    updateChannelRef: { current: 'stable' }, latestUpdateCheckRef: { current: null }, updatePlatform: 'macos',
    mergePendingUpdateCheck: (_, next) => next, dispatchUpdateCheck: e => events.push(e.result?.channel ?? e.type),
    hasActionableUpdate: () => false, buildAppUpdateCenterItem: () => ({ key: 'app' }),
    setUpdateCenter: () => effects.push('center'), setUpdateDialogOpened: () => effects.push('dialog'),
    setUpdateDownload: () => effects.push('download'), createIdleUpdateDownloadState: () => ({}),
    deferredUpdatePromptKeyRef: {}, lastUpdatePromptVersionRef: {}, GitHubReleaseConfigurationError: class extends Error {},
    window: { setTimeout: cb => timers.push(cb) },
    checkGitHubClientUpdate: async ({ channel }) => {
      channels.push(channel);
      if (channel === 'stable' && stage !== 'components') {
        entered(); await delayed;
        if (stage === 'manifest-error') throw Error('old channel failed');
      }
      return { channel };
    }
  };
  function render(channel) {
    shared.updateChannelRef.current = channel;
    const options = { updateChannel: channel, appVersion: '1', showError: () => effects.push('error'),
      checkRuntimeComponents: async () => { entered(); await delayed; } };
    const bindings = { ...shared, options, updateChannel: channel };
    return shared.latestUpdateCheckRef.current = new Function(...Object.keys(bindings), `${checkJS}; return runUpdateCheck;`)(...Object.values(bindings));
  }
  const oldRun = render('stable')({ source: 'refresh', includeRuntimeComponents: stage === 'components' });
  await started;
  await render('beta')({ source: 'refresh' });
  const before = events.length;
  release();
  assert.equal(await oldRun, null, `${stage}: stale result must not reach the window-focus caller`);
  assert.deepEqual(events.slice(before), [], `${stage}: stale completion must not publish`);
  assert.deepEqual(effects, []);
  assert.equal(timers.length, 1);
  timers[0](); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(channels, ['stable', 'beta']);
  assert.equal(events.at(-1), 'beta');
  assert.deepEqual(effects, ['center', 'dialog', 'download']);
}

// Startup checks skip the visible spinner but still report why the first check failed.
{
  class ConfigError extends Error {}
  let failure = new ConfigError('尚未配置 GitHub 发布仓库');
  let center = { items: ['app', 'geo'].map(key => ({ key, status: 'idle' })), lastCheckedAt: null };
  const bindings = {
    updateChannel: 'stable', updateChannelRef: { current: 'stable' }, updateInstallBusyRef: {},
    updateCheckBusyRef: {}, pendingUpdateCheckRef: {}, dispatchUpdateCheck() {}, updatePlatform: 'macos',
    options: { updateChannel: 'stable', appVersion: '1' }, GitHubReleaseConfigurationError: ConfigError,
    checkGitHubClientUpdate: async () => { throw failure; }, setUpdateCenter: change => { center = change(center); }
  };
  const run = new Function(...Object.keys(bindings), `${checkJS}; return runUpdateCheck;`)(...Object.values(bindings));
  for (const expected of ['unsupported', 'failed']) {
    await run({ source: 'startup', silent: true });
    assert.deepEqual(center.items.map(item => item.status), [expected, 'idle']);
    assert.equal(center.lastCheckedAt, null);
    failure = Error('offline');
  }
}
