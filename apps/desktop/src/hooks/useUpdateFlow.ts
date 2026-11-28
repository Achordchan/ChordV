import { checkGitHubClientUpdate } from "../lib/githubReleases";
import { GitHubReleaseConfigurationError } from "../lib/githubReleaseSource";
import { cancelPreparedDesktopUpdate } from "../lib/nativeInstaller";
import { downloadWithMirrorFallback, rankDownloadUrls, rememberProbeResults, urlsNeedingProbe } from "../lib/downloadMirrorRanking";
import { probeDownloadCandidates } from "../lib/runtime";
import { initialUpdateCheckState, reduceUpdateCheckState } from "../lib/updateCheckState";
import { APP_BUILD_NUMBER } from "../lib/buildInfo";
import { describeUserError, isCustomerSafeText, type UserErrorContext } from "../lib/userFacingErrors";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  type ClientUpdateCheckResult,
  recordClientDiagnosticLog,
  type ReleaseChannel
} from "../api/client";
import {
  installWindowsUpdate,
  downloadDesktopInstaller,
  focusDesktopWindow,
  openDesktopInstaller,
  openExternalUrl,
  quitForUpdate,
  consumeDesktopUpdateInstallReport,
  subscribeDesktopUpdateDownloadProgress,
  type RuntimeStatus
} from "../lib/runtime";
import {
  compareVersion,
  createIdleUpdateDownloadState,
  formatVersionLabel,
  inferInstallerFileName,
  normalizeUpdateDownloadProgress,
  preferredArtifactType,
  resolveUpdateDownloadUrl,
  resolveUpdatePlatform,
  type ResolvedUpdatePlatform,
  type UpdateDownloadState
} from "../lib/updateState";
import {
  buildAppUpdateCenterItem,
  createDefaultUpdateCenterItems,
  createIdleUpdateCenterState,
  type UpdateCenterItem,
  type UpdateCenterItemKey,
  type UpdateCenterState
} from "../lib/updateCenter";
import {
  FORCED_INSTALL_COUNTDOWN_SECONDS,
  formatSilentUpdateFailureLog,
  isForcedAutoUpdateCandidate,
  isSilentUpdateCandidate,
  isUpdateReadyIndicatorVisible,
  shouldStartAutoUpdateDownload,
  shouldStartForcedInstallCountdown,
  SILENT_UPDATE_LOG_CATEGORY,
  stepForcedInstallCountdown
} from "../lib/silentUpdate";
import type { ToastInput } from "../lib/toast";

type RunUpdateCheckOptions = {
  source: "startup" | "login" | "manual" | "refresh";
  silent?: boolean;
  /** 手动检测默认仅检查；需要下载时再显式关闭 */
  inspectOnly?: boolean;
  includeRuntimeComponents?: boolean;
  runtimeTargets?: Array<"xray" | "geo">;
  openUpdateCenter?: boolean;
};

type RuntimeAssetsCheckSummary = {
  sourceConfigured?: boolean;
  checked: boolean;
  updated: string[];
  failed: string[];
  current: boolean;
  releaseTag: string | null;
  xray?: {
    localVersion: string | null;
    remoteVersion: string | null;
    current: boolean;
    available: boolean;
    message: string;
  };
  geo?: {
    localVersion: string | null;
    remoteVersion: string | null;
    current: boolean;
    available: boolean;
    message: string;
  };
};

type UseUpdateFlowOptions = {
  appVersion: string;
  platformTarget: RuntimeStatus["platformTarget"];
  updateChannel?: ReleaseChannel;
  /** 「自动在后台下载更新」偏好：开启后普通更新会静默下载，完成后只显示“新版本已就绪”标记。 */
  autoDownloadUpdates?: boolean;
  /** 当前是否适合开始后台下载（已进入主界面、窗口没有在切换）。 */
  backgroundDownloadAllowed?: boolean;
  /** 强制更新能否自动下载并倒计时安装（启动完成、窗口没有在切换；登录界面也会执行）。 */
  forcedUpdateAllowed?: boolean;
  notify?: (notice: ToastInput) => void;
  showError?: (reason: unknown, context?: UserErrorContext) => void;
  isPromptBlocked?: () => boolean;
  checkRuntimeComponents?: (input: {
    source: "startup" | "login" | "manual" | "refresh";
    silent?: boolean;
    inspectOnly?: boolean;
    targets?: Array<"xray" | "geo">;
  }) => Promise<RuntimeAssetsCheckSummary | null | void>;
};

function isDesktopManagedUpdate(mode: ClientUpdateCheckResult["deliveryMode"], platform: ResolvedUpdatePlatform) {
  return mode === "desktop_installer_download";
}


export function hasActionableUpdate(result: ClientUpdateCheckResult | null, appVersion: string, appBuild: number | null = APP_BUILD_NUMBER) {
  if (!result) {
    return false;
  }
  // Same version, newer installer: only when both builds are known.
  const newerBuild = compareVersion(result.latestVersion, appVersion) === 0
    && appBuild !== null && (result.latestBuild ?? 0) > appBuild;
  return (
    (result.hasUpdate && (compareVersion(result.latestVersion, appVersion) > 0 || newerBuild)) ||
    result.forceUpgrade ||
    compareVersion(result.minimumVersion, appVersion) > 0
  );
}

function buildUpdateArtifactIdentity(update: ClientUpdateCheckResult | null) {
  if (!update) {
    return null;
  }
  const artifact = update.artifact;
  return [
    update.latestVersion,
    update.latestBuild ?? "",
    update.deliveryMode,
    update.downloadUrl ?? "",
    artifact?.originDownloadUrl ?? "",
    artifact?.fileName ?? "",
    artifact?.fileType ?? "",
    artifact?.fileSizeBytes ?? "",
    artifact?.fileHash ?? "",
    artifact?.updaterSignature ?? ""
  ].join("|");
}

export function buildUpdatePromptKey(update: ClientUpdateCheckResult | null) {
  if (!update) {
    return null;
  }
  return `${update.latestVersion}:${update.forceUpgrade ? "force" : "optional"}:${buildUpdateArtifactIdentity(update) ?? "no-artifact"}`;
}

function mergePendingUpdateCheck(
  current: RunUpdateCheckOptions | null,
  next: RunUpdateCheckOptions
): RunUpdateCheckOptions {
  if (!current) {
    return next;
  }
  return {
    source: current.source === "manual" || next.source === "manual" ? "manual" : next.source,
    silent: Boolean(current.silent && next.silent),
    inspectOnly: Boolean(current.inspectOnly && next.inspectOnly),
    includeRuntimeComponents:
      current.includeRuntimeComponents === true || next.includeRuntimeComponents === true
        ? true
        : current.includeRuntimeComponents === false && next.includeRuntimeComponents === false
          ? false
          : next.includeRuntimeComponents ?? current.includeRuntimeComponents,
    runtimeTargets: next.runtimeTargets ?? current.runtimeTargets,
    openUpdateCenter: Boolean(current.openUpdateCenter || next.openUpdateCenter)
  };
}


export function useUpdateFlow(options: UseUpdateFlowOptions) {
  const updatePlatform = useMemo<ResolvedUpdatePlatform>(
    () => resolveUpdatePlatform(options.platformTarget),
    [options.platformTarget]
  );
  const [updateCheckBusy, setUpdateCheckBusy] = useState(false);
  const [updateInstallBusy, setUpdateInstallBusy] = useState(false);
  const updateInstallBusyRef = useRef(false);
  const [updateCheck, dispatchUpdateCheck] = useReducer(reduceUpdateCheckState, initialUpdateCheckState);
  const updateChannel = options.updateChannel ?? "stable";
  const updateChannelRef = useRef(updateChannel);
  updateChannelRef.current = updateChannel;
  // A result confirmed for another channel (e.g. a beta build after the user
  // turned beta off, and the recheck failed) must never drive prompts or downloads.
  const updateCheckResult = updateCheck.result?.channel === updateChannel ? updateCheck.result : null;
  const updateCheckStatus = updateCheck.status;
  const [updateDialogOpened, setUpdateDialogOpened] = useState(false);
  const [updateCenter, setUpdateCenter] = useState<UpdateCenterState>(createIdleUpdateCenterState);
  const [updateDownload, setUpdateDownload] = useState<UpdateDownloadState>(createIdleUpdateDownloadState);
  const lastUpdatePromptVersionRef = useRef<string | null>(null);
  const deferredUpdatePromptKeyRef = useRef<string | null>(null);
  const completedDownloadIdentityRef = useRef<string | null>(null);
  const updateCheckBusyRef = useRef(false);
  const pendingUpdateCheckRef = useRef<RunUpdateCheckOptions | null>(null);
  const latestUpdateCheckRef = useRef<((input: RunUpdateCheckOptions) => Promise<ClientUpdateCheckResult | null>) | null>(null);
  // 后台静默下载：用户没有主动介入时不展示进度、失败只记诊断日志。
  const [backgroundUpdateDownload, setBackgroundUpdateDownload] = useState(false);
  const backgroundDownloadRef = useRef(false);
  const silentDownloadInFlightRef = useRef(false);
  const silentAttemptedIdentitiesRef = useRef<Set<string>>(new Set());
  // 强制更新：自动下载、倒计时自动安装，每个更新包各只自动执行一次。
  const forcedDownloadAttemptedRef = useRef<Set<string>>(new Set());
  const forcedInstallAttemptedRef = useRef<Set<string>>(new Set());
  const [forcedInstallCountdown, setForcedInstallCountdown] = useState<number | null>(null);
  // 最近一次下载完成（已校验）时对应的更新包身份
  const [readyIdentity, setReadyIdentity] = useState<string | null>(null);
  const markBackgroundDownload = useCallback((value: boolean) => {
    backgroundDownloadRef.current = value;
    setBackgroundUpdateDownload(value);
  }, []);

  const effectiveUpdate = updateCheckResult;

  const forceUpdateRequired = useMemo(
    () =>
      Boolean(
        effectiveUpdate &&
          (effectiveUpdate.forceUpgrade ||
            compareVersion(effectiveUpdate.minimumVersion, options.appVersion) > 0)
      ),
    [effectiveUpdate, options.appVersion]
  );

  const updateArtifactIdentity = useMemo(() => {
    return buildUpdateArtifactIdentity(effectiveUpdate);
  }, [effectiveUpdate]);
  const artifactIdentityRef = useRef(updateArtifactIdentity);
  artifactIdentityRef.current = updateArtifactIdentity;

  useEffect(() => {
    if (updatePlatform === "android") {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;

    void subscribeDesktopUpdateDownloadProgress((progress) => {
      if (disposed) {
        return;
      }
      setUpdateDownload((current) => normalizeUpdateDownloadProgress(current, progress));
    }).then((cleanup) => {
      if (disposed) {
        cleanup();
        return;
      }
      unlisten = cleanup;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [updatePlatform]);

  useEffect(() => {
    setUpdateDownload(createIdleUpdateDownloadState());
    completedDownloadIdentityRef.current = null;
  }, [updateArtifactIdentity]);

  const handleUpdateDownload = useCallback(async (request: { silent?: boolean; keepDialogOpen?: boolean } = {}) => {
    if (updateInstallBusyRef.current) return false;
    const silent = request.silent === true;
    const installationHint = updatePlatform === "macos"
      ? "安装时将校验并自动替换应用，完成后重新启动。"
      : "请按安装器提示完成安装。";
    const resolvedDownloadUrl = resolveUpdateDownloadUrl(effectiveUpdate?.downloadUrl ?? null);
    const originDownloadUrl = resolveUpdateDownloadUrl(effectiveUpdate?.artifact?.originDownloadUrl ?? null);

    if (!resolvedDownloadUrl || !effectiveUpdate) {
      if (silent) return false;
      options.notify?.({
        tone: "warning",
        title: "暂无下载地址",
        message: "当前版本暂无可用安装包，请稍后在更新中心重新检查。"
      });
      return false;
    }


    if (!isDesktopManagedUpdate(effectiveUpdate.deliveryMode, updatePlatform) || updatePlatform === "android") {
      if (silent) return false;
      try {
        const result = await openExternalUrl(resolvedDownloadUrl);
        if (!result.ok) throw new Error("无法打开系统浏览器，请检查默认浏览器设置后重试。");
      } catch (reason) {
        options.notify?.({
          tone: "danger",
          title: "无法打开下载链接",
          message: reason instanceof Error && isCustomerSafeText(reason.message) ? reason.message : "请检查默认浏览器设置后重试。"
        });
        return false;
      }
      options.notify?.({
        tone: "info",
        title: effectiveUpdate.deliveryMode === "apk_download" ? "已打开 APK 下载链接" : "已打开更新下载链接",
        message:
          effectiveUpdate.deliveryMode === "apk_download"
            ? "请在浏览器或系统下载器中完成安装包下载。"
            : "请根据打开的下载页面完成安装包下载。"
      });
      return true;
    }

    if (!updateArtifactIdentity || artifactIdentityRef.current !== updateArtifactIdentity) {
      if (!silent) options.notify?.({ tone: "warning", title: "可用版本已变化", message: "请重新检查更新后再下载。" });
      return false;
    }

    if (updateDownload.phase === "preparing" || updateDownload.phase === "downloading" || updateDownload.phase === "verifying") {
      // 用户主动点了下载：接管正在进行的后台下载，之后的进度与失败按正常流程展示。
      if (!silent && backgroundDownloadRef.current) markBackgroundDownload(false);
      return false;
    }

    if (
      updateDownload.phase === "completed" &&
      updateDownload.localPath &&
      completedDownloadIdentityRef.current === updateArtifactIdentity
    ) {
      setReadyIdentity(updateArtifactIdentity);
      if (!silent) {
        options.notify?.({
          tone: "success",
          title: "准备安装",
          message: `本地更新包已就绪。${installationHint}`
        });
      }
      return true;
    }

    const preferredFileName =
      effectiveUpdate.artifact?.fileName ??
      inferInstallerFileName(resolvedDownloadUrl, effectiveUpdate.artifact?.fileType ?? preferredArtifactType(updatePlatform));

    const targetIdentity = updateArtifactIdentity;
    setReadyIdentity(null);
    if (silent) {
      silentDownloadInFlightRef.current = true;
      markBackgroundDownload(true);
    } else {
      markBackgroundDownload(false);
      // 强制更新自动下载时保留“需要更新”弹窗，进度直接显示在弹窗里。
      if (!request.keepDialogOpen) setUpdateDialogOpened(false);
    }
    setUpdateDownload({
      phase: "preparing",
      fileName: preferredFileName,
      downloadedBytes: 0,
      totalBytes: effectiveUpdate.artifact?.fileSizeBytes ?? null,
      localPath: null,
      message: "正在准备下载安装器…"
    });

    try {
      const artifact = effectiveUpdate.artifact;
      if (!artifact?.fileHash || !artifact.fileSizeBytes) throw new Error("GitHub 安装包缺少完整性校验信息。");
      const candidates = artifact.downloadCandidates?.length
        ? artifact.downloadCandidates
        : [originDownloadUrl ?? resolvedDownloadUrl];
      const pendingProbes = urlsNeedingProbe(candidates);
      if (pendingProbes.length > 1) rememberProbeResults(await probeDownloadCandidates(pendingProbes).catch(() => []));
      const downloaded: { result: Awaited<ReturnType<typeof downloadDesktopInstaller>> } = { result: null };
      const usedUrl = await downloadWithMirrorFallback(rankDownloadUrls(candidates), async (url, minBytesPerSecond) => {
        downloaded.result = await downloadDesktopInstaller({
          url, sha256: artifact.fileHash!, fileSizeBytes: artifact.fileSizeBytes!, minBytesPerSecond,
          fileName: preferredFileName, expectedVersion: effectiveUpdate.latestVersion,
          currentVersion: options.appVersion, channel: options.updateChannel ?? "stable",
          onProgress: progress => setUpdateDownload(current => normalizeUpdateDownloadProgress(current, progress))
        });
        if (!downloaded.result?.localPath) throw new Error("安装器下载失败。");
      }, reason => /download_cancelled|cancelled|canceled|取消|AbortError/i.test(reason instanceof Error ? reason.message : String(reason)));
      const usedFallback = usedUrl === originDownloadUrl && candidates[0] !== originDownloadUrl;
      const result = downloaded.result;

      if (!result?.localPath) {
        throw new Error("安装器下载失败");
      }

      // 下载期间更新包已变化（例如切换了测试版通道）：旧包不能再拿来安装。
      // 不论是后台下载还是用户接管后的前台下载，都直接丢弃，回到空闲状态重新判断。
      const stillCurrent = artifactIdentityRef.current === targetIdentity;
      const shownInBackground = silent && backgroundDownloadRef.current;
      if (!stillCurrent) {
        completedDownloadIdentityRef.current = null;
        markBackgroundDownload(false);
        setUpdateDownload(createIdleUpdateDownloadState());
        if (!shownInBackground) {
          options.notify?.({
            tone: "warning",
            title: "可用版本已变化",
            message: "下载期间可用的新版本发生了变化，请重新下载。"
          });
        }
        return false;
      }
      setUpdateDownload({
        phase: "completed",
        fileName: result.fileName,
        downloadedBytes: result.totalBytes ?? effectiveUpdate.artifact?.fileSizeBytes ?? 0,
        totalBytes: result.totalBytes ?? effectiveUpdate.artifact?.fileSizeBytes ?? null,
        localPath: result.localPath,
        message: usedFallback
          ? `更新包已下载并校验（已回退原始地址）。${installationHint}`
          : `更新包已下载并校验。${installationHint}`
      });
      completedDownloadIdentityRef.current = targetIdentity;
      setReadyIdentity(targetIdentity);
      if (shownInBackground) {
        // 后台下载完成：不弹窗、不提示，“检查更新”按钮变为“重启更新”。
        void recordClientDiagnosticLog(SILENT_UPDATE_LOG_CATEGORY, `background download ready version=${effectiveUpdate.latestVersion}`);
        return true;
      }
      if (updatePlatform === "windows") return true;
      options.notify?.({
        tone: "success",
        title: "更新包已就绪",
        message: `下载完成。${installationHint}`
      });
      return true;
    } catch (reason) {
      const failure = describeUserError(
        reason,
        { context: "update_download" }
      );
      if (silent && backgroundDownloadRef.current) {
        // 后台下载失败不打扰用户：只写诊断日志、不显示就绪标记，用户仍可在更新中心手动更新。
        void recordClientDiagnosticLog(SILENT_UPDATE_LOG_CATEGORY, formatSilentUpdateFailureLog({
          version: effectiveUpdate.latestVersion,
          code: failure.code,
          detail: failure.detail || failure.message
        }));
        markBackgroundDownload(false);
        setUpdateDownload(createIdleUpdateDownloadState());
        return false;
      }
      setUpdateDownload((current) => ({
        phase: "failed",
        fileName: current.fileName,
        downloadedBytes: current.downloadedBytes,
        totalBytes: current.totalBytes,
        localPath: current.localPath,
        message: failure.message,
        errorCode: failure.code
      }));
      options.showError?.(reason || failure.message, "update_download");
      return false;
    } finally {
      if (silent) silentDownloadInFlightRef.current = false;
    }
  }, [effectiveUpdate, markBackgroundDownload, options, updateArtifactIdentity, updateDownload, updatePlatform]);

  const autoUpdateInput = {
    update: effectiveUpdate,
    channel: updateChannel,
    appVersion: options.appVersion,
    actionable: hasActionableUpdate(effectiveUpdate, options.appVersion),
    platform: updatePlatform
  };
  const silentUpdateCandidate = isSilentUpdateCandidate(autoUpdateInput);
  const forcedAutoUpdateCandidate = isForcedAutoUpdateCandidate(autoUpdateInput);

  useEffect(() => {
    if (silentDownloadInFlightRef.current) return;
    if (updateInstallBusyRef.current) return;
    if (forcedAutoUpdateCandidate) {
      // 强制更新：不受“自动在后台下载更新”开关影响，直接下载；失败后回到原有的强制更新界面手动重试。
      if (!shouldStartAutoUpdateDownload({
        enabled: true,
        allowed: options.forcedUpdateAllowed === true,
        candidate: true,
        phase: updateDownload.phase,
        artifactIdentity: updateArtifactIdentity,
        attemptedIdentities: forcedDownloadAttemptedRef.current
      })) {
        return;
      }
      if (updateArtifactIdentity) forcedDownloadAttemptedRef.current.add(updateArtifactIdentity);
      void handleUpdateDownload({ keepDialogOpen: true });
      return;
    }
    if (!shouldStartAutoUpdateDownload({
      enabled: options.autoDownloadUpdates === true,
      allowed: options.backgroundDownloadAllowed === true,
      candidate: silentUpdateCandidate,
      phase: updateDownload.phase,
      artifactIdentity: updateArtifactIdentity,
      attemptedIdentities: silentAttemptedIdentitiesRef.current
    })) {
      return;
    }
    // 同一个更新包本次运行只自动尝试一次，失败后不反复重试（切换通道再切回来也不重下）。
    if (updateArtifactIdentity) silentAttemptedIdentitiesRef.current.add(updateArtifactIdentity);
    void handleUpdateDownload({ silent: true });
  }, [
    forcedAutoUpdateCandidate,
    handleUpdateDownload,
    options.autoDownloadUpdates,
    options.backgroundDownloadAllowed,
    options.forcedUpdateAllowed,
    silentUpdateCandidate,
    updateArtifactIdentity,
    updateInstallBusy,
    updateDownload.phase
  ]);

  useEffect(() => {
    // 用户打开了更新弹窗在看进度：后台下载转为前台，失败时照常提示。
    const inProgress = updateDownload.phase === "preparing" || updateDownload.phase === "downloading" || updateDownload.phase === "verifying";
    if (updateDialogOpened && inProgress && backgroundDownloadRef.current) {
      markBackgroundDownload(false);
    }
  }, [markBackgroundDownload, updateDialogOpened, updateDownload.phase]);

  const readyInput = {
    download: updateDownload,
    readyIdentity,
    artifactIdentity: updateArtifactIdentity,
    resultChannel: effectiveUpdate?.channel ?? null,
    channel: updateChannel
  };
  const updateReadyToInstall = isUpdateReadyIndicatorVisible({ ...readyInput, forceUpdateRequired });
  const forcedInstallDue = shouldStartForcedInstallCountdown({
    ...readyInput,
    forcedCandidate: forcedAutoUpdateCandidate,
    allowed: options.forcedUpdateAllowed === true,
    attemptedIdentities: forcedInstallAttemptedRef.current
  });
  // 倒计时期间更新包仍有效（仍是强制更新、仍是这个已下载的包）
  const forcedInstallStillValid = forcedAutoUpdateCandidate && isUpdateReadyIndicatorVisible({ ...readyInput, forceUpdateRequired: false });

  // 窗口缩到托盘 / 被隐藏时页面不可见，倒计时必须暂停。
  const [pageVisible, setPageVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const onVisibilityChange = () => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    if (!forcedInstallDue || forcedInstallCountdown !== null || !updateArtifactIdentity) return;
    if (updateInstallBusyRef.current) return;
      // 强制更新已下载校验：显示主窗口并提示倒计时，结束后交给平台安装器。
    forcedInstallAttemptedRef.current.add(updateArtifactIdentity);
    void focusDesktopWindow();
    setForcedInstallCountdown(FORCED_INSTALL_COUNTDOWN_SECONDS);
    setUpdateDialogOpened(true);
  }, [forcedInstallCountdown, forcedInstallDue, updateArtifactIdentity, updateInstallBusy]);

  const installForcedUpdateNowRef = useRef<() => void>(() => {});
  useEffect(() => {
    const step = stepForcedInstallCountdown({
      countdown: forcedInstallCountdown,
      valid: forcedInstallStillValid,
      // 提示看不到时（弹窗被关、窗口切换中、窗口隐藏在托盘）暂停，避免毫无预兆地退出。
      visible: updateDialogOpened && options.forcedUpdateAllowed === true && pageVisible
    });
    if (step.type === "cancel") {
      setForcedInstallCountdown(null);
    } else if (step.type === "install") {
      installForcedUpdateNowRef.current();
    } else if (step.type === "tick") {
      const timer = window.setTimeout(() => setForcedInstallCountdown(step.next), 1000);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [forcedInstallCountdown, forcedInstallStillValid, options.forcedUpdateAllowed, pageVisible, updateDialogOpened]);

  const openUpdateCenter = useCallback(() => {
    setUpdateCenter((current) => ({
      ...current,
      opened: true,
      items: current.items.length ? current.items : createDefaultUpdateCenterItems()
    }));
  }, []);

  const closeUpdateCenter = useCallback(() => {
    if (updateInstallBusyRef.current) return;
    setUpdateCenter((current) => ({
      ...current,
      opened: false
    }));
  }, []);

  const runUpdateCheck = useCallback(
    async (runOptions: RunUpdateCheckOptions) => {
      if (updateInstallBusyRef.current || updateChannelRef.current !== updateChannel) return null;
      if (updateCheckBusyRef.current) {
        pendingUpdateCheckRef.current = mergePendingUpdateCheck(pendingUpdateCheckRef.current, runOptions);
        return null;
      }

      updateCheckBusyRef.current = true;
      dispatchUpdateCheck({ type: "checking" });
      try {
        // 启动/登录等静默检查不占用「检测更新」按钮 loading，避免一进软件就转圈、影响连接
        const isInteractiveCheck =
          runOptions.source === "manual" || Boolean(runOptions.openUpdateCenter);
        if (isInteractiveCheck) {
          setUpdateCheckBusy(true);
          setUpdateCenter((current) => ({
            ...current,
            opened: true,
            checking: true,
            updatingKey: null,
            items: current.items.map((item) =>
              item.key === "app" || ((runOptions.includeRuntimeComponents ?? runOptions.source === "manual") && (!runOptions.runtimeTargets || runOptions.runtimeTargets.includes(item.key)))
                ? { ...item, status: "checking", message: "正在检查…" }
                : item
            )
          }));
        }
        const result = await checkGitHubClientUpdate({
          currentVersion: options.appVersion,
          platform: updatePlatform,
          channel: updateChannel,
          force: runOptions.source === "manual"
        });

        if (updateChannelRef.current !== updateChannel) return null;

        // 如果 GitHub 发布的最新版本就是当前版本，说明当前已是最新，不触发更新提示
        const effectiveHasUpdate = hasActionableUpdate(result, options.appVersion);

        // 默认：仅手动/更新中心检查核心组件；启动只查 GitHub 软件版本
        const includeRuntime =
          runOptions.includeRuntimeComponents ?? runOptions.source === "manual";
        const inspectOnly =
          runOptions.inspectOnly ?? (runOptions.source === "manual" || runOptions.source === "startup" || runOptions.source === "login");
        const runtimeTargets = runOptions.runtimeTargets;

        let runtimeSummary: RuntimeAssetsCheckSummary | null = null;
        if (includeRuntime && options.checkRuntimeComponents) {
          try {
            const summary = await options.checkRuntimeComponents({
              source: runOptions.source,
              silent: runOptions.silent ?? !isInteractiveCheck,
              inspectOnly,
              targets: runtimeTargets
            });
            runtimeSummary = summary ?? null;
          } catch {
            runtimeSummary = null;
          }
        }

        if (updateChannelRef.current !== updateChannel) return null;
        dispatchUpdateCheck({ type: "confirmed", result });

        const appItem = buildAppUpdateCenterItem({
          appVersion: options.appVersion,
          update: result,
          hasActionableUpdate: effectiveHasUpdate
        });
        const xrayItem: UpdateCenterItem = {
          key: "xray",
          label: "Xray",
          status: runtimeSummary?.sourceConfigured === false ? "unsupported" : runtimeSummary?.xray?.available
            ? "available"
            : runtimeSummary?.xray
              ? runtimeSummary.xray.current
                ? "current"
                : "failed"
              : includeRuntime
                ? "failed"
                : "idle",
          localVersion: runtimeSummary?.xray?.localVersion ?? null,
          remoteVersion: runtimeSummary?.xray?.remoteVersion ?? null,
          message: runtimeSummary?.xray?.message ?? (includeRuntime ? "未检查" : "未检查"),
          canUpdate: Boolean(runtimeSummary?.xray?.available)
        };
        const geoItem: UpdateCenterItem = {
          key: "geo",
          label: "GEO 数据",
          status: runtimeSummary?.sourceConfigured === false ? "unsupported" : runtimeSummary?.geo?.available
            ? "available"
            : runtimeSummary?.geo
              ? runtimeSummary.geo.current
                ? "current"
                : "failed"
              : includeRuntime
                ? "failed"
                : "idle",
          localVersion: runtimeSummary?.geo?.localVersion ?? null,
          remoteVersion: runtimeSummary?.geo?.remoteVersion ?? runtimeSummary?.releaseTag ?? null,
          message: runtimeSummary?.geo?.message ?? (includeRuntime ? "未检查" : "未检查"),
          canUpdate: Boolean(runtimeSummary?.geo?.available)
        };

        const shouldOpenCenter =
          runOptions.openUpdateCenter === true ||
          (runOptions.source === "manual" && !runOptions.silent);

        setUpdateCenter((current) => {
          // A client-only check must not erase the last known component results.
          const nextItems = [appItem, xrayItem, geoItem].map((item) => {
            if (item.key === "app" || (includeRuntime && (!runtimeTargets || runtimeTargets.includes(item.key)))) return item;
            const previous = current.items.find((value) => value.key === item.key);
            return previous ? { ...previous, status: previous.status === "checking" ? "idle" as const : previous.status } : item;
          });
          return {
            ...current,
            opened: shouldOpenCenter ? true : current.opened,
            checking: false,
            updatingKey: null,
            lastCheckedAt: Date.now(),
            items: nextItems
          };
        });

        if (!result || !effectiveHasUpdate) {
          setUpdateDialogOpened(false);
          setUpdateDownload(createIdleUpdateDownloadState());
          deferredUpdatePromptKeyRef.current = null;
          lastUpdatePromptVersionRef.current = null;
          // 手动检测走更新中心弹窗，不再用 toast 刷屏
          return result;
        }


        const promptKey = buildUpdatePromptKey(result)!;
        const shouldPrompt =
          runOptions.source === "manual" ||
          result.forceUpgrade ||
          lastUpdatePromptVersionRef.current !== promptKey;
        // 开启后台下载时，普通更新不再自动弹窗：静默下载完成后只显示“新版本已就绪”标记。
        // 强制更新、手动检查、以及不能静默下载的更新仍走原来的弹窗。
        const handledSilently =
          runOptions.source !== "manual" &&
          options.autoDownloadUpdates === true &&
          isSilentUpdateCandidate({
            update: result,
            channel: updateChannel,
            appVersion: options.appVersion,
            actionable: effectiveHasUpdate,
            platform: updatePlatform
          });

        if (shouldPrompt && handledSilently) {
          deferredUpdatePromptKeyRef.current = null;
          lastUpdatePromptVersionRef.current = promptKey;
        } else if (shouldPrompt) {
          if (runOptions.source !== "manual" && options.isPromptBlocked?.()) {
            deferredUpdatePromptKeyRef.current = promptKey;
          } else {
            deferredUpdatePromptKeyRef.current = null;
            lastUpdatePromptVersionRef.current = promptKey;
            setUpdateDialogOpened(true);
          }
        }

        if (runOptions.source !== "manual" && !runOptions.silent && !handledSilently) {
          options.notify?.({
            tone: result.forceUpgrade ? "danger" : "info",
            title: result.forceUpgrade ? "发现强制更新" : "发现新版本",
            message: `${formatVersionLabel(result.latestVersion)} 已发布。`
          });
        }
        return result;
      } catch (reason) {
        if (updateChannelRef.current !== updateChannel) return null;
        dispatchUpdateCheck({ type: "failed" });
        const failureMessage = reason instanceof GitHubReleaseConfigurationError
          ? reason.message : "暂时无法获取版本信息，请稍后重试。";
        setUpdateCenter((current) => ({
          ...current, checking: false, updatingKey: null,
          items: current.items.map((item) => (item.key === "app" && (item.status === "idle" || item.status === "failed" || item.status === "unsupported")) || item.status === "checking" || item.status === "updating"
            ? { ...item, status: reason instanceof GitHubReleaseConfigurationError ? "unsupported" : "failed", canUpdate: false, message: failureMessage }
            : item)
        }));
        if (!runOptions.openUpdateCenter && (!runOptions.silent || runOptions.source === "manual")) {
          options.showError?.(reason || "暂时无法检查更新，请稍后重试。", "update_check");
        }
        return null;
      } finally {
        updateCheckBusyRef.current = false;
        if (runOptions.source === "manual" || runOptions.openUpdateCenter) {
          setUpdateCheckBusy(false);
        }
        const pendingRun = pendingUpdateCheckRef.current;
        pendingUpdateCheckRef.current = null;
        if (pendingRun) {
          window.setTimeout(() => {
            void latestUpdateCheckRef.current?.(pendingRun);
          }, 0);
        }
      }
    },
    [options, updateChannel, updatePlatform]
  );
  latestUpdateCheckRef.current = runUpdateCheck;

  const handleManualUpdateCheck = useCallback(async () => {
    return runUpdateCheck({
      source: "manual",
      silent: true,
      inspectOnly: true,
      includeRuntimeComponents: true,
      openUpdateCenter: true
    });
  }, [runUpdateCheck]);

  const handleUpdateCenterCheckOnly = useCallback(async () => {
    return runUpdateCheck({
      source: "manual",
      silent: true,
      inspectOnly: true,
      includeRuntimeComponents: true,
      openUpdateCenter: true
    });
  }, [runUpdateCheck]);

  const handleUpdateCenterUpdateOne = useCallback(
    async (key: UpdateCenterItemKey) => {
      if (updateInstallBusyRef.current) return null;
      setUpdateCenter((current) => ({
        ...current,
        opened: true,
        updatingKey: key,
        items: current.items.map((item) =>
          item.key === key
            ? {
                ...item,
                status: "updating",
                message: "正在更新…"
              }
            : item
        )
      }));
      try {
        if (key === "app") {
          const result = await runUpdateCheck({
            source: "manual",
            silent: true,
            inspectOnly: true,
            includeRuntimeComponents: false,
            openUpdateCenter: true
          });
          if (hasActionableUpdate(result, options.appVersion)) {
            setUpdateDialogOpened(true);
          }
          return result;
        }
        return runUpdateCheck({
          source: "manual",
          silent: true,
          inspectOnly: false,
          includeRuntimeComponents: true,
          runtimeTargets: [key === "xray" ? "xray" : "geo"],
          openUpdateCenter: true
        });
      } finally {
        setUpdateCenter((current) => ({
          ...current,
          updatingKey: null
        }));
      }
    },
    [options.appVersion, runUpdateCheck]
  );

  const runUpdateCheckAndFocus = useCallback(
    async (runOptions: RunUpdateCheckOptions) => {
      const result = await runUpdateCheck(runOptions);
      if (hasActionableUpdate(result, options.appVersion)) {
        await focusDesktopWindow();
      }
      return result;
    },
    [options.appVersion, runUpdateCheck]
  );

  const handleQuitForUpdate = useCallback(async () => {
    if (updateInstallBusyRef.current) return false;
    if (updateCheckBusyRef.current) {
      options.showError?.("正在检查更新，请稍后再安装。", "update_install");
      return false;
    }
    if (updateDownload.phase !== "completed" || !updateDownload.localPath) {
      options.showError?.("更新包尚未准备就绪，请先完成下载。");
      return false;
    }
    if (!updateArtifactIdentity || artifactIdentityRef.current !== updateArtifactIdentity ||
      completedDownloadIdentityRef.current !== updateArtifactIdentity || readyIdentity !== updateArtifactIdentity ||
      effectiveUpdate?.channel !== updateChannel || updateChannelRef.current !== updateChannel) {
      options.showError?.("可用版本已变化，请重新检查更新后再安装。", "update_install");
      return false;
    }
    updateInstallBusyRef.current = true;
    setUpdateInstallBusy(true);
    let macPreparationStarted = false;
    let handedOff = false;
    try {
      if (updatePlatform === "windows") {
        const result = await installWindowsUpdate();
        if (!result?.ok) throw new Error("更新安装没有成功启动，请重试。");
      } else {
        macPreparationStarted = updatePlatform === "macos";
        const prepared = await openDesktopInstaller(updateDownload.localPath);
        if (!prepared?.ok) throw new Error("更新安装没有准备完成，请重试。");
        if (artifactIdentityRef.current !== updateArtifactIdentity ||
          completedDownloadIdentityRef.current !== updateArtifactIdentity ||
          updateChannelRef.current !== updateChannel) {
          throw new Error("可用版本已变化，请重新检查更新后再安装。");
        }
        const result = await quitForUpdate();
        if (!result?.ok) throw new Error("更新安装没有成功交接，请重试。");
      }
      // Keep the confirmed policy and downloaded package retryable until native handoff succeeds.
      handedOff = true;
      dispatchUpdateCheck({ type: "reset" });
      return true;
    } catch (reason) {
      let failure = reason;
      if (macPreparationStarted) {
        try {
          const cancelled = await cancelPreparedDesktopUpdate();
          if (!cancelled?.ok) throw new Error("取消更新准备失败");
        } catch {
          failure = new Error("更新准备未能取消，请退出应用后重新打开再试。");
        }
      }
      options.showError?.(failure || "更新安装没有成功启动，请重试。", "update_install");
      return false;
    } finally {
      if (!handedOff) {
        updateInstallBusyRef.current = false;
        setUpdateInstallBusy(false);
      }
    }
  }, [effectiveUpdate, options, readyIdentity, updateArtifactIdentity, updateChannel, updateDownload, updatePlatform]);

  // “立即更新”或倒计时结束：走原有的安装流程；失败时停在强制更新界面由用户手动重试。
  const installForcedUpdateNow = useCallback(() => {
    setForcedInstallCountdown(null);
    void handleQuitForUpdate();
  }, [handleQuitForUpdate]);
  installForcedUpdateNowRef.current = installForcedUpdateNow;

  const consumeUpdateInstallReport = useCallback(async () => {
    try {
      const report = await consumeDesktopUpdateInstallReport();
      if (!report) return null;
      const recoveryAdvice = "暂时无法新建连接或重新安装更新。请保留更新文件并联系客服。";
      if (!("ok" in report)) {
        if (report.state !== "pending_recovery") throw new Error("无法识别更新结果");
        options.notify?.({ tone: "warning", title: "更新结果待确认", message: recoveryAdvice });
        return null;
      }
      if (report.ok) {
        return null;
      }
      const reportedSummary = report.summary?.trim();
      // 报告原文不可展示时不能推断安装包已打开（例如 Start-Process 本身失败），只给中性的失败说明和可操作的下一步。
      const safeSummary = reportedSummary && isCustomerSafeText(reportedSummary) ? reportedSummary : null;
      const summary = report.recoveryPending === true
        ? (safeSummary ? `${safeSummary} ${recoveryAdvice}` : recoveryAdvice)
        : (safeSummary ?? "更新未完成。请在更新中心重新检查版本后再试。");
      options.notify?.({
        tone: "warning",
        title: "更新安装未完全成功",
        message: summary
      });
      return report;
    } catch {
      options.notify?.({
        tone: "warning",
        title: "无法读取更新结果",
        message: "暂时无法读取上次更新的结果。如果更新后使用异常，请联系客服。"
      });
      return null;
    }
  }, [options]);

  return {
    updatePlatform,
    updateCheckBusy,
    updateInstallBusy,
    updateCheckResult,
    updateCheckStatus,
    effectiveUpdate,
    forceUpdateRequired,
    updateDialogOpened,
    setUpdateDialogOpened,
    updateDownload,
    setUpdateDownload,
    backgroundUpdateDownload,
    updateReadyToInstall,
    forcedInstallCountdown,
    installForcedUpdateNow,
    deferredUpdatePromptKeyRef,
    lastUpdatePromptVersionRef,
    runUpdateCheck,
    runUpdateCheckAndFocus,
    handleManualUpdateCheck,
    handleUpdateDownload,
    handleQuitForUpdate,
    updateCenter,
    openUpdateCenter,
    closeUpdateCenter,
    handleUpdateCenterCheckOnly,
    handleUpdateCenterUpdateOne,
    consumeUpdateInstallReport
  };
}
