import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  AUTO_DOWNLOAD_UPDATE_KEY,
  formatSilentUpdateFailureLog,
  isSilentUpdateCandidate,
  isUpdateReadyIndicatorVisible,
  readAutoDownloadPreference,
  shouldStartSilentUpdateDownload,
  SILENT_UPDATE_LOG_CATEGORY,
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

// 后台静默下载：只针对用户本来就会收到的普通更新；同一个包只自动试一次；
// 失败只记诊断日志、不弹提示；完成后才显示“新版本已就绪 · 重启更新”。

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

function candidate(update: any, overrides: Partial<Parameters<typeof isSilentUpdateCandidate>[0]> = {}) {
  const appVersion = overrides.appVersion ?? "1.1.10";
  return isSilentUpdateCandidate({
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

function testStartOncePerArtifact() {
  const base = { enabled: true, allowed: true, candidate: true, phase: "idle" as const, artifactIdentity: "1.1.11|50|abc", attemptedIdentities: new Set<string>() };
  assert.equal(shouldStartSilentUpdateDownload(base), true);
  assert.equal(shouldStartSilentUpdateDownload({ ...base, enabled: false }), false, "toggle off disables background downloads");
  assert.equal(shouldStartSilentUpdateDownload({ ...base, allowed: false }), false, "login / window transition waits");
  assert.equal(shouldStartSilentUpdateDownload({ ...base, candidate: false }), false);
  assert.equal(shouldStartSilentUpdateDownload({ ...base, attemptedIdentities: new Set([base.artifactIdentity]) }), false, "the same artifact is not retried");
  assert.equal(shouldStartSilentUpdateDownload({ ...base, attemptedIdentities: new Set(["1.1.11|49|old"]) }), true, "a new artifact is tried once");
  assert.equal(shouldStartSilentUpdateDownload({ ...base, attemptedIdentities: new Set(["beta|1.1.12", base.artifactIdentity]) }), false, "every attempted artifact is remembered, not just the latest");
  for (const phase of ["preparing", "downloading", "verifying", "completed", "failed"] as const) {
    assert.equal(shouldStartSilentUpdateDownload({ ...base, phase }), false, `${phase}: reuse the existing download state`);
  }
  assert.equal(shouldStartSilentUpdateDownload({ ...base, artifactIdentity: null }), false);
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

function testReadyIndicator() {
  const ready = { download: { phase: "completed" as const, localPath: "/cache/ChordV.dmg" }, readyIdentity: "a", artifactIdentity: "a", forceUpdateRequired: false };
  assert.equal(isUpdateReadyIndicatorVisible(ready), true);
  assert.equal(isUpdateReadyIndicatorVisible({ ...ready, download: { phase: "downloading", localPath: null } }), false, "not while downloading");
  assert.equal(isUpdateReadyIndicatorVisible({ ...ready, download: { phase: "completed", localPath: null } }), false);
  assert.equal(isUpdateReadyIndicatorVisible({ ...ready, readyIdentity: null }), false, "user-started downloads keep the existing panel");
  assert.equal(isUpdateReadyIndicatorVisible({ ...ready, artifactIdentity: "b" }), false, "a stale package is never offered");
  assert.equal(isUpdateReadyIndicatorVisible({ ...ready, forceUpdateRequired: true }), false, "forced updates keep their own flow");
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
    setSilentReadyIdentity: (value: string | null) => calls.ready.push(value),
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
  const result = await run(scenario.silent ? { silent: true } : undefined);
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
  const promoted = await runDownload({ silent: true, outcome: "throw", duringDownload: (context) => { context.backgroundDownloadRef.current = false; } });
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
  assert.deepEqual(foreground.calls.ready, [null]);
}

async function testStalePackageDiscarded() {
  const run = await runDownload({ silent: true, outcome: "success", duringDownload: (context) => { context.artifactIdentityRef.current = "artifact-b"; } });
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

function testTriggerEffectRunsOncePerArtifact() {
  const effect = compileHookSnippet(/useEffect\((\(\) => \{\s*if \(silentDownloadInFlightRef\.current\) return;[\s\S]*?\n  \}), \[/, "background download trigger");
  const starts: unknown[] = [];
  const context: Record<string, any> = {
    silentDownloadInFlightRef: { current: false },
    silentAttemptedIdentitiesRef: { current: new Set<string>() },
    shouldStartSilentUpdateDownload,
    options: { autoDownloadUpdates: true, backgroundDownloadAllowed: true },
    silentUpdateCandidate: true,
    updateDownload: { phase: "idle" },
    updateArtifactIdentity: "artifact-a",
    handleUpdateDownload: (request: unknown) => { starts.push(request); return Promise.resolve(true); }
  };
  const trigger = () => new Function(...Object.keys(context), `${effect}; return action;`)(...Object.values(context))();
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
  context.options = { autoDownloadUpdates: false, backgroundDownloadAllowed: true };
  trigger();
  assert.equal(starts.length, 2, "turning the toggle off stops background downloads");
  // 稳定版失败 → 切到测试版失败 → 切回稳定版：原来的包不会再自动下载。
  context.options = { autoDownloadUpdates: true, backgroundDownloadAllowed: true };
  context.updateArtifactIdentity = "artifact-a";
  trigger();
  assert.equal(starts.length, 2, "switching back to an earlier artifact does not download it again");
  context.updateArtifactIdentity = "artifact-c";
  trigger();
  assert.equal(starts.length, 3);
}

function testWiring() {
  // 开启后台下载时普通更新不再自动弹窗；手动检查、强制更新不受影响。
  assert.match(hookSource, /const handledSilently =\s*runOptions\.source !== "manual" &&\s*options\.autoDownloadUpdates === true &&\s*isSilentUpdateCandidate\(/);
  assert.match(hookSource, /if \(shouldPrompt && handledSilently\) \{[\s\S]*?\} else if \(shouldPrompt\) \{/);
  assert.match(hookSource, /if \(updateDialogOpened && inProgress && backgroundDownloadRef\.current\) \{\s*markBackgroundDownload\(false\);/, "opening the dialog takes over the background download");
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /updateDownload\.phase !== "idle" && !updateDialogOpened && !backgroundUpdateDownload/, "background downloads show no floating panel");
  assert.match(app, /autoDownloadUpdates,\s*\/\/[^\n]*\n[^\n]*\n\s*backgroundDownloadAllowed: !booting && !windowTransitioning && mainLayoutReady && Boolean\(session && bootstrap\)/);
  assert.match(app, /onInstallUpdate=\{\(\) => void handleQuitForUpdate\(\)\}/, "the indicator runs the existing install flow");
  assert.match(app, /readAutoDownloadPreference\(localStorage\)/);
  const panel = readFileSync(new URL("../src/components/SubscriptionPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /新版本已就绪 · 重启更新/);
  const center = readFileSync(new URL("../src/components/UpdateCenterModal.tsx", import.meta.url), "utf8");
  assert.match(center, /label="自动在后台下载更新"/);
}

async function main() {
  testCandidateOnlyForOfferedOptionalUpdates();
  testStartOncePerArtifact();
  testPreference();
  testReadyIndicator();
  await testSilentFailureIsLoggedNotShown();
  await testForegroundFailureStillShown();
  await testSilentSuccessOnlyMarksReady();
  await testStalePackageDiscarded();
  await testSilentNeverOpensExternalPages();
  testTriggerEffectRunsOncePerArtifact();
  testWiring();
  console.log("silent update download: eligibility, once per artifact, toggle, silent failure logging and ready indicator passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
