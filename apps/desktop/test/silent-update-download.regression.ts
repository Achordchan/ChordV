import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  AUTO_DOWNLOAD_UPDATE_KEY,
  FORCED_INSTALL_COUNTDOWN_SECONDS,
  formatSilentUpdateFailureLog,
  isForcedAutoUpdateCandidate,
  isSilentUpdateCandidate,
  isUpdateReadyIndicatorVisible,
  readAutoDownloadPreference,
  shouldStartAutoUpdateDownload,
  shouldStartForcedInstallCountdown,
  SILENT_UPDATE_LOG_CATEGORY,
  stepForcedInstallCountdown,
  writeAutoDownloadPreference
} from "../src/lib/silentUpdate";
import {
  createIdleUpdateDownloadState,
  inferInstallerFileName,
  normalizeUpdateDownloadProgress,
  preferredArtifactType,
  type UpdateDownloadState
} from "../src/lib/updateState";
import { describeUserError, formatUserError, isCustomerSafeText } from "../src/lib/userFacingErrors";
import { hasActionableUpdate } from "../src/hooks/useUpdateFlow";

// 普通更新：后台静默下载，同一个包只自动试一次；失败只记诊断日志、不弹提示；
// 完成后“检查更新”按钮变为“重启更新”，由用户点击安装，永不自动安装。
// 强制更新：自动下载，下载校验后不可取消的倒计时结束即自动安装；测试版永不强制；
// 自动下载失败回到原有的强制更新界面手动重试。

const optional = {
  platform: "macos",
  channel: "stable",
  currentVersion: "1.1.10",
  latestVersion: "1.1.11",
  latestBuild: 50,
  minimumVersion: "0.0.0",
  hasUpdate: true,
  forceUpgrade: false,
  title: "发现新版本",
  changelog: [],
  publishedAt: null,
  deliveryMode: "desktop_installer_download",
  downloadUrl: "https://example.com/ChordV_1.1.11.dmg",
  artifact: { fileName: "ChordV_1.1.11.dmg", fileType: "dmg", fileSizeBytes: 100, fileHash: "abc" }
} as any;

function candidate(update: any, overrides: Partial<Parameters<typeof isSilentUpdateCandidate>[0]> = {}, check = isSilentUpdateCandidate) {
  const appVersion = overrides.appVersion ?? "1.1.10";
  return check({
    update,
    channel: "stable",
    appVersion,
    actionable: hasActionableUpdate(update, appVersion, 49),
    platform: "macos",
    ...overrides
  });
}

function testCandidateOnlyForOfferedOptionalUpdates() {
  assert.equal(candidate(optional), true, "a normal update the user is offered downloads silently");
  assert.equal(candidate(optional, { platform: "windows" }), true, "Windows NSIS installer is also eligible");
  assert.equal(candidate({ ...optional, forceUpgrade: true }), false, "forced updates keep their blocking flow");
  assert.equal(candidate({ ...optional, minimumVersion: "1.1.11" }), false, "below the minimum version is a forced update");
  assert.equal(candidate(null), false);
  assert.equal(candidate({ ...optional, latestVersion: "1.1.10", latestBuild: 49 }), false, "nothing to download when already current");
  assert.equal(candidate({ ...optional, latestVersion: "1.1.10", latestBuild: 50 }), true, "a newer build of the same version counts, via hasActionableUpdate");
  // 关掉测试版后，残留的 beta 结果不能再触发下载；打开测试版的用户才会下载测试版。
  assert.equal(candidate({ ...optional, channel: "beta", releaseChannel: "beta" }), false, "a beta result never downloads for a stable user");
  assert.equal(candidate({ ...optional, channel: "beta", releaseChannel: "beta" }, { channel: "beta" }), true, "opted-in beta users get beta downloads");
  assert.equal(candidate(optional, { platform: "android" }), false, "APK installs always need the user");
  assert.equal(candidate({ ...optional, deliveryMode: "external_download" }), false, "external download pages are never opened silently");
  assert.equal(candidate({ ...optional, downloadUrl: null }), false);
}

function testForcedCandidate() {
  const forced = (update: any, overrides: Partial<Parameters<typeof isSilentUpdateCandidate>[0]> = {}) => candidate(update, overrides, isForcedAutoUpdateCandidate);
  assert.equal(forced({ ...optional, forceUpgrade: true }), true, "a pushed forced update installs automatically");
  assert.equal(forced({ ...optional, minimumVersion: "1.1.11" }), true, "below the minimum version counts as forced");
  assert.equal(forced({ ...optional, forceUpgrade: true }, { platform: "windows" }), true);
  assert.equal(forced(optional), false, "normal updates are never installed automatically");
  // 测试版永不强制：即使服务端误标，也不会自动安装测试版。
  assert.equal(forced({ ...optional, forceUpgrade: true, channel: "beta", releaseChannel: "beta" }, { channel: "beta" }), false, "beta is never auto-installed");
  assert.equal(forced({ ...optional, forceUpgrade: true, channel: "beta", releaseChannel: "stable" }, { channel: "beta" }), true, "a forced stable release still applies to beta testers");
  assert.equal(forced({ ...optional, forceUpgrade: true, channel: "beta" }), false, "stale results of another channel never install");
  assert.equal(forced({ ...optional, forceUpgrade: true }, { platform: "android" }), false);
  assert.equal(forced({ ...optional, forceUpgrade: true, deliveryMode: "external_download" }), false);
  assert.equal(candidate({ ...optional, forceUpgrade: true }), false, "forced updates never take the silent path");
}

function testStartOncePerArtifact() {
  const base = { enabled: true, allowed: true, candidate: true, phase: "idle" as const, artifactIdentity: "1.1.11|50|abc", attemptedIdentities: new Set<string>() };
  assert.equal(shouldStartAutoUpdateDownload(base), true);
  assert.equal(shouldStartAutoUpdateDownload({ ...base, enabled: false }), false, "toggle off disables background downloads");
  assert.equal(shouldStartAutoUpdateDownload({ ...base, allowed: false }), false, "login / window transition waits");
  assert.equal(shouldStartAutoUpdateDownload({ ...base, candidate: false }), false);
  assert.equal(shouldStartAutoUpdateDownload({ ...base, attemptedIdentities: new Set([base.artifactIdentity]) }), false, "the same artifact is not retried");
  assert.equal(shouldStartAutoUpdateDownload({ ...base, attemptedIdentities: new Set(["1.1.11|49|old"]) }), true, "a new artifact is tried once");
  assert.equal(shouldStartAutoUpdateDownload({ ...base, attemptedIdentities: new Set(["beta|1.1.12", base.artifactIdentity]) }), false, "every attempted artifact is remembered, not just the latest");
  for (const phase of ["preparing", "downloading", "verifying", "completed", "failed"] as const) {
    assert.equal(shouldStartAutoUpdateDownload({ ...base, phase }), false, `${phase}: reuse the existing download state`);
  }
  assert.equal(shouldStartAutoUpdateDownload({ ...base, artifactIdentity: null }), false);
}

function testPreference() {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
  assert.equal(readAutoDownloadPreference(storage), true, "default ON");
  writeAutoDownloadPreference(storage, false);
  assert.equal(values.get(AUTO_DOWNLOAD_UPDATE_KEY), "off");
  assert.equal(readAutoDownloadPreference(storage), false);
  writeAutoDownloadPreference(storage, true);
  assert.equal(readAutoDownloadPreference(storage), true);
  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
  assert.equal(readAutoDownloadPreference(broken), true, "unreadable storage keeps the default");
  assert.doesNotThrow(() => writeAutoDownloadPreference(broken, false));
  assert.equal(readAutoDownloadPreference(null), true);
}

const readyBase = {
  download: { phase: "completed" as const, localPath: "/cache/ChordV.dmg" },
  readyIdentity: "a",
  artifactIdentity: "a",
  resultChannel: "stable" as const,
  channel: "stable" as const
};

function testReadyIndicator() {
  const ready = { ...readyBase, forceUpdateRequired: false };
  assert.equal(isUpdateReadyIndicatorVisible(ready), true);
  assert.equal(isUpdateReadyIndicatorVisible({ ...ready, download: { phase: "downloading", localPath: null } }), false, "not while downloading");
  assert.equal(isUpdateReadyIndicatorVisible({ ...ready, download: { phase: "completed", localPath: null } }), false);
  assert.equal(isUpdateReadyIndicatorVisible({ ...ready, readyIdentity: null }), false, "only a verified download is ready");
  assert.equal(isUpdateReadyIndicatorVisible({ ...ready, artifactIdentity: "b" }), false, "a stale package is never offered");
  assert.equal(isUpdateReadyIndicatorVisible({ ...ready, forceUpdateRequired: true }), false, "forced updates keep their own flow");
  // 关掉测试版后，已下载的测试版包不能再被“重启更新”装上。
  assert.equal(isUpdateReadyIndicatorVisible({ ...ready, resultChannel: "beta" }), false, "readiness follows the selected channel");
  assert.equal(isUpdateReadyIndicatorVisible({ ...ready, resultChannel: null }), false);
}

function testForcedInstallCountdownRules() {
  const due = { ...readyBase, forcedCandidate: true, allowed: true, attemptedIdentities: new Set<string>() };
  assert.equal(shouldStartForcedInstallCountdown(due), true, "a downloaded forced update starts the countdown");
  assert.equal(shouldStartForcedInstallCountdown({ ...due, forcedCandidate: false }), false, "normal or beta updates never auto-install");
  assert.equal(shouldStartForcedInstallCountdown({ ...due, allowed: false }), false, "waits while the window is switching");
  assert.equal(shouldStartForcedInstallCountdown({ ...due, attemptedIdentities: new Set(["a"]) }), false, "one automatic install per package; a failed install falls back to the manual button");
  assert.equal(shouldStartForcedInstallCountdown({ ...due, download: { phase: "failed", localPath: null } }), false, "a failed download goes back to manual retry");
  assert.equal(shouldStartForcedInstallCountdown({ ...due, resultChannel: "beta" }), false);
  assert.deepEqual(stepForcedInstallCountdown({ countdown: null, valid: true, visible: true }), { type: "idle" });
  assert.deepEqual(stepForcedInstallCountdown({ countdown: 3, valid: false, visible: true }), { type: "cancel" }, "a package that is no longer forced cancels the countdown");
  assert.deepEqual(stepForcedInstallCountdown({ countdown: 3, valid: true, visible: false }), { type: "pause" }, "never counts down while the notice is hidden");
  assert.deepEqual(stepForcedInstallCountdown({ countdown: 3, valid: true, visible: true }), { type: "tick", next: 2 });
  assert.deepEqual(stepForcedInstallCountdown({ countdown: 0, valid: true, visible: true }), { type: "install" });
  assert.equal(FORCED_INSTALL_COUNTDOWN_SECONDS, 10);
}

const hookSource = readFileSync(new URL("../src/hooks/useUpdateFlow.ts", import.meta.url), "utf8");

function compileHookSnippet(pattern: RegExp, name: string) {
  const snippet = hookSource.match(pattern)?.[1];
  assert.ok(snippet, `production ${name} must be found`);
  return ts.transpileModule(`const action = ${snippet};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

const downloadAction = compileHookSnippet(/const handleUpdateDownload = useCallback\((async \([^)]*\) => \{[\s\S]*?\n  \}), \[/, "download action");

type Scenario = {
  silent: boolean;
  keepDialogOpen?: boolean;
  platform?: "macos" | "windows";
  outcome: "success" | "throw";
  update?: any;
  duringDownload?: (context: any) => void;
};

async function runDownload(scenario: Scenario) {
  let state: UpdateDownloadState = createIdleUpdateDownloadState();
  const calls = { notify: [] as any[], showError: [] as any[], logs: [] as Array<[string, string]>, dialog: [] as boolean[], ready: [] as Array<string | null>, background: [] as boolean[] };
  const context: Record<string, any> = {
    effectiveUpdate: scenario.update ?? optional,
    options: {
      appVersion: "1.1.10",
      updateChannel: "stable",
      notify: (notice: unknown) => calls.notify.push(notice),
      showError: (reason: unknown) => calls.showError.push(reason)
    },
    updateDownload: state,
    updatePlatform: scenario.platform ?? "macos",
    updateArtifactIdentity: "artifact-a",
    artifactIdentityRef: { current: "artifact-a" },
    completedDownloadIdentityRef: { current: null },
    backgroundDownloadRef: { current: false },
    silentDownloadInFlightRef: { current: false },
    markBackgroundDownload: (value: boolean) => { context.backgroundDownloadRef.current = value; calls.background.push(value); },
    setReadyIdentity: (value: string | null) => calls.ready.push(value),
    setUpdateDialogOpened: (value: boolean) => calls.dialog.push(value),
    setUpdateDownload: (next: UpdateDownloadState | ((current: UpdateDownloadState) => UpdateDownloadState)) => {
      state = typeof next === "function" ? next(state) : next;
    },
    resolveUpdateDownloadUrl: (value: string | null) => value,
    isDesktopManagedUpdate: (mode: string) => mode === "desktop_installer_download",
    openExternalUrl: async () => { calls.notify.push("external-opened"); return { ok: true }; },
    isCustomerSafeText,
    openDesktopInstaller: async () => ({ ok: true }),
    downloadDesktopInstaller: async () => {
      scenario.duringDownload?.(context);
      if (scenario.outcome === "throw") throw new Error("error sending request for url (https://mirror.example.com/ChordV.dmg)");
      return { fileName: "ChordV_1.1.11.dmg", localPath: "/cache/ChordV_1.1.11.dmg", totalBytes: 100 };
    },
    normalizeUpdateDownloadProgress,
    createIdleUpdateDownloadState,
    describeUserError,
    formatUserError,
    recordUpdateDiagnostic: () => {},
    inferInstallerFileName,
    preferredArtifactType,
    recordClientDiagnosticLog: async (category: string, message: string) => { calls.logs.push([category, message]); },
    SILENT_UPDATE_LOG_CATEGORY,
    formatSilentUpdateFailureLog
  };
  const run = new Function(...Object.keys(context), `${downloadAction}; return action;`)(...Object.values(context));
  const result = await run(scenario.silent ? { silent: true } : scenario.keepDialogOpen ? { keepDialogOpen: true } : undefined);
  return { result, state: () => state, calls, context };
}

async function testSilentFailureIsLoggedNotShown() {
  const run = await runDownload({ silent: true, outcome: "throw" });
  assert.equal(run.result, false);
  assert.equal(run.calls.showError.length, 0, "no error toast for a background failure");
  assert.equal(run.calls.notify.length, 0, "no notification for a background failure");
  assert.equal(run.state().phase, "idle", "no failed panel and no ready indicator");
  assert.equal(run.calls.ready.at(-1), null);
  assert.equal(run.context.backgroundDownloadRef.current, false);
  assert.equal(run.context.silentDownloadInFlightRef.current, false, "in-flight guard is released");
  const failureLog = run.calls.logs.find(([category]) => category === SILENT_UPDATE_LOG_CATEGORY);
  assert.ok(failureLog, "the failure is written to the diagnostic log");
  assert.match(failureLog[1], /version=1\.1\.11/);
  assert.match(failureLog[1], /code=network_offline/);
  assert.match(failureLog[1], /mirror\.example\.com/, "the raw cause is kept for support");
  assert.deepEqual(run.calls.dialog, [], "a background download never touches the update dialog");
}

async function testForegroundFailureStillShown() {
  const run = await runDownload({ silent: false, outcome: "throw" });
  assert.equal(run.calls.showError.length, 1, "user-started downloads still report failures");
  assert.equal(run.state().phase, "failed");
  // 用户中途打开弹窗接管了后台下载：失败按正常流程提示。
  const promoted = await runDownload({ silent: true, outcome: "throw", duringDownload: (context: any) => { context.backgroundDownloadRef.current = false; } });
  assert.equal(promoted.calls.showError.length, 1, "a download the user is watching reports its failure");
  assert.equal(promoted.state().phase, "failed");
}

async function testSilentSuccessOnlyMarksReady() {
  for (const platform of ["macos", "windows"] as const) {
    const run = await runDownload({ silent: true, outcome: "success", platform });
    assert.equal(run.result, true);
    assert.equal(run.state().phase, "completed");
    assert.equal(run.state().localPath, "/cache/ChordV_1.1.11.dmg");
    assert.deepEqual(run.calls.ready, [null, "artifact-a"], `${platform}: ready indicator is keyed to the downloaded artifact`);
    assert.equal(run.calls.notify.length, 0, `${platform}: no popup when the package is ready`);
    assert.deepEqual(run.calls.dialog, []);
    assert.equal(run.context.backgroundDownloadRef.current, true, "the floating progress panel stays hidden");
    assert.equal(run.context.completedDownloadIdentityRef.current, "artifact-a", "the verified package is reused by the install flow");
  }
  const foreground = await runDownload({ silent: false, outcome: "success" });
  assert.equal(foreground.calls.notify.length, 1, "user-started downloads keep their notification");
  assert.deepEqual(foreground.calls.ready, [null, "artifact-a"], "a finished manual download also turns the button into 重启更新");
  assert.deepEqual(foreground.calls.dialog, [false]);
}

async function testForcedAutoDownloadKeepsDialogAndFallsBackToManual() {
  const ok = await runDownload({ silent: false, keepDialogOpen: true, outcome: "success" });
  assert.equal(ok.result, true);
  assert.deepEqual(ok.calls.dialog, [], "the blocking 需要更新 dialog stays open and shows progress");
  assert.deepEqual(ok.calls.ready, [null, "artifact-a"], "the forced package becomes ready for the countdown");
  const failed = await runDownload({ silent: false, keepDialogOpen: true, outcome: "throw" });
  assert.equal(failed.result, false);
  assert.equal(failed.state().phase, "failed", "the forced dialog shows the failure with 重新下载");
  assert.equal(failed.calls.showError.length, 1, "a forced download failure is reported like before");
  assert.deepEqual(failed.calls.dialog, []);
  assert.deepEqual(failed.calls.ready, [null], "a failed download never auto-installs");
}

async function testStalePackageDiscarded() {
  const run = await runDownload({ silent: true, outcome: "success", duringDownload: (context: any) => { context.artifactIdentityRef.current = "artifact-b"; } });
  assert.equal(run.result, false);
  assert.equal(run.state().phase, "idle", "a package for an outdated release is not offered for install");
  assert.equal(run.context.completedDownloadIdentityRef.current, null);
  assert.deepEqual(run.calls.ready, [null]);
}

async function testSilentNeverOpensExternalPages() {
  const run = await runDownload({ silent: true, outcome: "success", update: { ...optional, deliveryMode: "external_download" } });
  assert.equal(run.result, false);
  assert.deepEqual(run.calls.notify, [], "external links are never opened in the background");
  const noUrl = await runDownload({ silent: true, outcome: "success", update: { ...optional, downloadUrl: null } });
  assert.deepEqual(noUrl.calls.notify, []);
}

function triggerHarness() {
  const effect = compileHookSnippet(/useEffect\((\(\) => \{\s*if \(silentDownloadInFlightRef\.current\) return;[\s\S]*?\n  \}), \[/, "automatic download trigger");
  const starts: unknown[] = [];
  const context: Record<string, any> = {
    silentDownloadInFlightRef: { current: false },
    silentAttemptedIdentitiesRef: { current: new Set<string>() },
    forcedDownloadAttemptedRef: { current: new Set<string>() },
    shouldStartAutoUpdateDownload,
    options: { autoDownloadUpdates: true, backgroundDownloadAllowed: true, forcedUpdateAllowed: true },
    silentUpdateCandidate: true,
    forcedAutoUpdateCandidate: false,
    updateDownload: { phase: "idle" },
    updateArtifactIdentity: "artifact-a",
    handleUpdateDownload: (request: unknown) => { starts.push(request); return Promise.resolve(true); }
  };
  const trigger = () => new Function(...Object.keys(context), `${effect}; return action;`)(...Object.values(context))();
  return { context, starts, trigger };
}

function testTriggerEffectRunsOncePerArtifact() {
  const { context, starts, trigger } = triggerHarness();
  trigger();
  assert.deepEqual(starts, [{ silent: true }]);
  trigger();
  assert.equal(starts.length, 1, "rerenders and later checks of the same artifact do not download again");
  context.updateArtifactIdentity = "artifact-b";
  context.silentDownloadInFlightRef.current = true;
  trigger();
  assert.equal(starts.length, 1, "never two downloads at once");
  context.silentDownloadInFlightRef.current = false;
  trigger();
  assert.equal(starts.length, 2, "a newly published artifact is downloaded once");
  context.updateArtifactIdentity = "artifact-c";
  context.options = { ...context.options, autoDownloadUpdates: false };
  trigger();
  assert.equal(starts.length, 2, "turning the toggle off stops background downloads");
  // 稳定版失败 → 切到测试版失败 → 切回稳定版：原来的包不会再自动下载。
  context.options = { ...context.options, autoDownloadUpdates: true };
  context.updateArtifactIdentity = "artifact-a";
  trigger();
  assert.equal(starts.length, 2, "switching back to an earlier artifact does not download it again");
  context.updateArtifactIdentity = "artifact-c";
  trigger();
  assert.equal(starts.length, 3);
}

function testForcedTriggerDownloadsOnce() {
  const { context, starts, trigger } = triggerHarness();
  context.silentUpdateCandidate = false;
  context.forcedAutoUpdateCandidate = true;
  context.options = { autoDownloadUpdates: false, backgroundDownloadAllowed: false, forcedUpdateAllowed: true };
  trigger();
  assert.deepEqual(starts, [{ keepDialogOpen: true }], "forced updates download automatically, even with the toggle off or on the login window");
  // 下载失败：状态为 failed，不自动重试；回到空闲后同一个包也不再自动下载，由用户手动重试。
  context.updateDownload = { phase: "failed" };
  trigger();
  context.updateDownload = { phase: "idle" };
  trigger();
  assert.equal(starts.length, 1, "a failed forced download is retried by the user, not automatically");
  context.updateArtifactIdentity = "artifact-b";
  context.options = { ...context.options, forcedUpdateAllowed: false };
  trigger();
  assert.equal(starts.length, 1, "waits while booting or switching windows");
  context.options = { ...context.options, forcedUpdateAllowed: true };
  trigger();
  assert.equal(starts.length, 2);
  // 普通更新静默失败过的包，变成强制更新后仍会自动下载一次。
  const silentFirst = triggerHarness();
  silentFirst.trigger();
  silentFirst.context.silentUpdateCandidate = false;
  silentFirst.context.forcedAutoUpdateCandidate = true;
  silentFirst.trigger();
  assert.deepEqual(silentFirst.starts, [{ silent: true }, { keepDialogOpen: true }]);
}

function testForcedCountdownInstallsAutomatically() {
  const start = compileHookSnippet(/useEffect\((\(\) => \{\s*if \(!forcedInstallDue[\s\S]*?\n  \}), \[/, "forced install countdown start");
  const tick = compileHookSnippet(/useEffect\((\(\) => \{\s*const step = stepForcedInstallCountdown[\s\S]*?\n  \}), \[/, "forced install countdown tick");
  const run = (valid: boolean, hiddenTicks = 0) => {
    const installs: string[] = [];
    const focus: string[] = [];
    let hidden = hiddenTicks;
    const dialog: boolean[] = [];
    let countdown: number | null = null;
    let timer: (() => void) | null = null;
    const attempted = new Set<string>();
    const setCountdown = (value: number | null) => { countdown = value; };
    const startContext = () => ({
      forcedInstallDue: valid && !attempted.has("artifact-a"),
      forcedInstallCountdown: countdown,
      updateArtifactIdentity: "artifact-a",
      forcedInstallAttemptedRef: { current: attempted },
      setForcedInstallCountdown: setCountdown,
      setUpdateDialogOpened: (value: boolean) => dialog.push(value),
      focusDesktopWindow: async () => { focus.push("show"); },
      FORCED_INSTALL_COUNTDOWN_SECONDS
    });
    const tickContext = () => ({
      stepForcedInstallCountdown,
      forcedInstallCountdown: countdown,
      forcedInstallStillValid: valid,
      updateDialogOpened: dialog.at(-1) === true,
      options: { forcedUpdateAllowed: true },
      pageVisible: hidden <= 0,
      setForcedInstallCountdown: setCountdown,
      installForcedUpdateNowRef: { current: () => { countdown = null; installs.push("install"); } },
      window: { setTimeout: (fn: () => void) => { timer = fn; return 1; }, clearTimeout: () => {} }
    });
    const exec = (code: string, context: Record<string, any>) => new Function(...Object.keys(context), `${code}; return action;`)(...Object.values(context))();
    exec(start, startContext());
    const seen: Array<number | null> = [countdown];
    for (let guard = 0; guard < 40 && countdown !== null; guard += 1) {
      timer = null;
      exec(tick, tickContext());
      hidden -= 1;
      const pending = timer as (() => void) | null;
      if (pending) pending();
      seen.push(countdown);
      exec(start, startContext());
    }
    return { installs, dialog, seen, focus };
  };
  const forced = run(true);
  assert.deepEqual(forced.dialog, [true], "the countdown notice is always shown before installing");
  assert.deepEqual(forced.focus, ["show"], "the main window is brought back from the tray before counting down");
  // 窗口被隐藏时暂停：隐藏的几轮里倒计时停在 10，恢复可见后才继续。
  const paused = run(true, 3);
  assert.deepEqual(paused.seen.slice(0, 4), [10, 10, 10, 10], "no countdown while the page is hidden");
  assert.deepEqual(paused.installs, ["install"]);
  assert.equal(forced.seen[0], 10);
  assert.deepEqual(forced.installs, ["install"], "the forced update installs itself exactly once when the countdown ends");
  assert.ok(forced.seen.includes(1) && forced.seen.includes(0), "counts down one second at a time");
  const optionalRun = run(false);
  assert.deepEqual(optionalRun.installs, [], "normal updates never install automatically");
  assert.deepEqual(optionalRun.dialog, []);
  assert.match(hookSource, /const installForcedUpdateNow = useCallback\(\(\) => \{\s*setForcedInstallCountdown\(null\);\s*void handleQuitForUpdate\(\);/, "立即更新 and the countdown use the existing install flow");
}

function testWiring() {
  // 开启后台下载时普通更新不再自动弹窗；手动检查、强制更新不受影响。
  assert.match(hookSource, /const handledSilently =\s*runOptions\.source !== "manual" &&\s*options\.autoDownloadUpdates === true &&\s*isSilentUpdateCandidate\(/);
  assert.match(hookSource, /if \(shouldPrompt && handledSilently\) \{[\s\S]*?\} else if \(shouldPrompt\) \{/);
  assert.match(hookSource, /if \(updateDialogOpened && inProgress && backgroundDownloadRef\.current\) \{\s*markBackgroundDownload\(false\);/, "opening the dialog takes over the background download");
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /updateDownload\.phase !== "idle" && !updateDialogOpened && !backgroundUpdateDownload/, "background downloads show no floating panel");
  assert.match(app, /backgroundDownloadAllowed: !booting && !windowTransitioning && mainLayoutReady && Boolean\(session && bootstrap\)/);
  assert.match(app, /forcedUpdateAllowed: !booting && !windowTransitioning,/);
  assert.match(app, /onInstallUpdate=\{\(\) => void handleQuitForUpdate\(\)\}/, "重启更新 runs the existing install flow");
  assert.match(app, /onInstallApp=\{\(\) => void handleQuitForUpdate\(\)\}/);
  assert.match(app, /forcedInstallCountdown !== null \? \(\s*<Button color="orange" data-autofocus onClick=\{installForcedUpdateNow\}>\s*立即更新（\{forcedInstallCountdown\} 秒）/);
  assert.match(app, /readAutoDownloadPreference\(localStorage\)/);
  const panel = readFileSync(new URL("../src/components/SubscriptionPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /onClick=\{updateReady \? props\.onInstallUpdate : props\.onCheckUpdate\}/, "the existing update button becomes 重启更新; no new toolbar element");
  assert.match(panel, /updateReady \? "重启更新"/);
  assert.doesNotMatch(panel, /新版本已就绪 · 重启更新/);
  const center = readFileSync(new URL("../src/components/UpdateCenterModal.tsx", import.meta.url), "utf8");
  assert.match(center, /label="自动在后台下载更新"/);
  assert.match(center, /新版本已下载，可立即安装/);
  const modal = readFileSync(new URL("../src/components/ClientUpdateModal.tsx", import.meta.url), "utf8");
  assert.match(modal, /必须更新：\$\{props\.autoInstallCountdown\} 秒后自动安装并重启/);
  assert.doesNotMatch(modal + center + panel, /拖/, "both platforms install automatically; no drag instructions");
}

async function main() {
  testCandidateOnlyForOfferedOptionalUpdates();
  testForcedCandidate();
  testStartOncePerArtifact();
  testPreference();
  testReadyIndicator();
  testForcedInstallCountdownRules();
  await testSilentFailureIsLoggedNotShown();
  await testForegroundFailureStillShown();
  await testSilentSuccessOnlyMarksReady();
  await testStalePackageDiscarded();
  await testSilentNeverOpensExternalPages();
  await testForcedAutoDownloadKeepsDialogAndFallsBackToManual();
  testTriggerEffectRunsOncePerArtifact();
  testForcedTriggerDownloadsOnce();
  testForcedCountdownInstallsAutomatically();
  testWiring();
  console.log("auto update: silent optional downloads, ready button, forced auto-download and countdown install, beta never forced passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
