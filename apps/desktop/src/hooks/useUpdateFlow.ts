import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClientVersionDto } from "@chordv/shared";
import {
  checkClientUpdate,
  type ClientUpdateArtifact,
  type ClientUpdateCheckResult,
  isUnauthorizedApiError,
  type ReleaseChannel
} from "../api/client";
import {
  applyDesktopFullUpdate,
  downloadDesktopFullUpdatePackage,
  downloadDesktopInstaller,
  focusDesktopWindow,
  openDesktopInstaller,
  openExternalLink,
  quitForUpdate,
  subscribeDesktopUpdateDownloadProgress,
  type RuntimeStatus
} from "../lib/runtime";
import {
  compareVersion,
  createIdleUpdateDownloadState,
  createLegacyUpdateResult,
  describeUpdateDownload,
  displayUpdateDownloadProgress,
  formatVersionLabel,
  hasKnownTotalBytes,
  inferInstallerFileName,
  normalizeUpdateDownloadProgress,
  preferredArtifactType,
  resolveUpdateDownloadUrl,
  resolveUpdatePlatform,
  type ResolvedUpdatePlatform,
  type UpdateDownloadState
} from "../lib/updateState";

type NoticeInput = {
  color: "green" | "yellow" | "red" | "blue";
  title: string;
  message: string;
};

type RunUpdateCheckOptions = {
  accessToken?: string | null;
  bootstrapVersion?: ClientVersionDto | null;
  source: "startup" | "login" | "manual" | "refresh";
  silent?: boolean;
};

type RuntimeAssetsCheckSummary = {
  checked: boolean;
  updated: string[];
  failed: string[];
  current: boolean;
  releaseTag: string | null;
};

type UseUpdateFlowOptions = {
  appVersion: string;
  platformTarget: RuntimeStatus["platformTarget"];
  accessToken?: string | null;
  bootstrapVersion?: ClientVersionDto | null;
  runtimeMirrorPrefix?: string;
  updateChannel?: ReleaseChannel;
  readError?: (message: string) => string;
  notify?: (notice: NoticeInput) => void;
  showError?: (message: string) => void;
  onUnauthorized?: () => Promise<unknown> | unknown;
  isPromptBlocked?: () => boolean;
  checkRuntimeComponents?: (input: {
    source: "startup" | "login" | "manual" | "refresh";
    silent?: boolean;
  }) => Promise<RuntimeAssetsCheckSummary | null | void>;
};

function defaultReadError(message: string) {
  return message;
}

function isDesktopManagedUpdate(mode: ClientUpdateCheckResult["deliveryMode"], platform: ResolvedUpdatePlatform) {
  return mode === "desktop_installer_download" || (mode === "desktop_full_replace" && platform === "windows");
}

function isFullReplaceUpdate(update: ClientUpdateCheckResult, platform: ResolvedUpdatePlatform) {
  return update.deliveryMode === "desktop_full_replace" && platform === "windows";
}

export function hasActionableUpdate(result: ClientUpdateCheckResult | null, appVersion: string) {
  if (!result) {
    return false;
  }
  return (
    (result.hasUpdate && compareVersion(result.latestVersion, appVersion) > 0) ||
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
    update.deliveryMode,
    update.downloadUrl ?? "",
    artifact?.originDownloadUrl ?? "",
    artifact?.fileName ?? "",
    artifact?.fileType ?? "",
    artifact?.fileSizeBytes ?? "",
    artifact?.fileHash ?? ""
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
    accessToken: next.accessToken ?? current.accessToken,
    bootstrapVersion: next.bootstrapVersion ?? current.bootstrapVersion,
    source: current.source === "manual" || next.source === "manual" ? "manual" : next.source,
    silent: Boolean(current.silent && next.silent)
  };
}

export function useUpdateFlow(options: UseUpdateFlowOptions) {
  const updatePlatform = useMemo<ResolvedUpdatePlatform>(
    () => resolveUpdatePlatform(options.platformTarget),
    [options.platformTarget]
  );
  const [updateCheckBusy, setUpdateCheckBusy] = useState(false);
  const [updateCheckResult, setUpdateCheckResult] = useState<ClientUpdateCheckResult | null>(null);
  const [updateDialogOpened, setUpdateDialogOpened] = useState(false);
  const [updateDownload, setUpdateDownload] = useState<UpdateDownloadState>(createIdleUpdateDownloadState);
  const [indeterminateUpdateProgress, setIndeterminateUpdateProgress] = useState(18);
  const lastKnownUpdateArtifactRef = useRef<ClientUpdateArtifact | null>(null);
  const lastUpdatePromptVersionRef = useRef<string | null>(null);
  const deferredUpdatePromptKeyRef = useRef<string | null>(null);
  const completedDownloadIdentityRef = useRef<string | null>(null);
  const updateCheckBusyRef = useRef(false);
  const pendingUpdateCheckRef = useRef<RunUpdateCheckOptions | null>(null);

  const effectiveUpdate = useMemo(
    () =>
      updateCheckResult ??
      createLegacyUpdateResult(
        options.bootstrapVersion ?? null,
        updatePlatform,
        options.appVersion,
        options.runtimeMirrorPrefix,
        lastKnownUpdateArtifactRef.current,
        options.updateChannel ?? "stable"
      ),
    [options.appVersion, options.bootstrapVersion, options.runtimeMirrorPrefix, options.updateChannel, updateCheckResult, updatePlatform]
  );

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

  useEffect(() => {
    if (updateCheckResult?.artifact) {
      lastKnownUpdateArtifactRef.current = updateCheckResult.artifact;
    }
  }, [updateCheckResult?.artifact]);

  useEffect(() => {
    if (updateDownload.phase !== "downloading" || hasKnownTotalBytes(updateDownload.totalBytes)) {
      setIndeterminateUpdateProgress(18);
      return;
    }

    const timer = window.setInterval(() => {
      setIndeterminateUpdateProgress((current) => {
        const next = current + 7;
        return next >= 92 ? 18 : next;
      });
    }, 180);

    return () => {
      window.clearInterval(timer);
    };
  }, [updateDownload.phase, updateDownload.totalBytes]);

  const handleUpdateDownload = useCallback(async () => {
    const resolvedDownloadUrl = resolveUpdateDownloadUrl(effectiveUpdate?.downloadUrl ?? null);
    const originDownloadUrl = resolveUpdateDownloadUrl(effectiveUpdate?.artifact?.originDownloadUrl ?? null);

    if (!resolvedDownloadUrl || !effectiveUpdate) {
      options.notify?.({
        color: "yellow",
        title: "暂无下载地址",
        message: "当前版本没有配置可用下载地址，请联系管理员补充发布产物。"
      });
      return false;
    }

    const fullReplaceUpdate = isFullReplaceUpdate(effectiveUpdate, updatePlatform);
    if (!isDesktopManagedUpdate(effectiveUpdate.deliveryMode, updatePlatform) || updatePlatform === "android") {
      await openExternalLink(resolvedDownloadUrl);
      options.notify?.({
        color: "blue",
        title: effectiveUpdate.deliveryMode === "apk_download" ? "已打开 APK 下载链接" : "已打开更新下载链接",
        message:
          effectiveUpdate.deliveryMode === "apk_download"
            ? "请在浏览器或系统下载器中完成安装包下载。"
            : "请根据打开的下载页面完成安装包下载。"
      });
      return true;
    }

    if (updateDownload.phase === "preparing" || updateDownload.phase === "downloading") {
      return false;
    }

    if (
      updateDownload.phase === "completed" &&
      updateDownload.localPath &&
      completedDownloadIdentityRef.current === updateArtifactIdentity
    ) {
      try {
        if (fullReplaceUpdate) {
          await applyDesktopFullUpdate({
            path: updateDownload.localPath,
            expectedTotalBytes: effectiveUpdate.artifact?.fileSizeBytes ?? null,
            expectedHash: effectiveUpdate.artifact?.fileHash ?? null
          });
        } else {
          await openDesktopInstaller(updateDownload.localPath);
        }
        options.notify?.({
          color: "green",
          title: "安装器已打开",
          message: "已复用本地安装器，请按安装向导完成升级。"
        });
        return true;
      } catch (reason) {
        setUpdateDownload(createIdleUpdateDownloadState());
        options.notify?.({
          color: "yellow",
          title: "本地安装器不可用",
          message: reason instanceof Error ? (options.readError ?? defaultReadError)(reason.message) : "已切换为重新下载安装器。"
        });
      }
    }

    const preferredFileName =
      effectiveUpdate.artifact?.fileName ??
      inferInstallerFileName(resolvedDownloadUrl, effectiveUpdate.artifact?.fileType ?? preferredArtifactType(updatePlatform));

    setUpdateDownload({
      phase: "preparing",
      fileName: preferredFileName,
      downloadedBytes: 0,
      totalBytes: effectiveUpdate.artifact?.fileSizeBytes ?? null,
      localPath: null,
      message: "正在准备下载安装器…"
    });

    try {
      let usedFallback = false;
      let result;
      try {
        const downloadPackage = fullReplaceUpdate ? downloadDesktopFullUpdatePackage : downloadDesktopInstaller;
        result = await downloadPackage({
          url: resolvedDownloadUrl,
          fileName: preferredFileName,
          expectedTotalBytes: effectiveUpdate.artifact?.fileSizeBytes ?? null,
          expectedHash: effectiveUpdate.artifact?.fileHash ?? null,
          onProgress: (progress) => {
            setUpdateDownload((current) => normalizeUpdateDownloadProgress(current, progress));
          }
        });
      } catch (reason) {
        if (!originDownloadUrl || originDownloadUrl === resolvedDownloadUrl) {
          throw reason;
        }
        usedFallback = true;
        setUpdateDownload((current) => ({
          ...current,
          phase: "preparing",
          message: "加速下载失败，正在回退到原始下载地址…"
        }));
        const downloadPackage = fullReplaceUpdate ? downloadDesktopFullUpdatePackage : downloadDesktopInstaller;
        result = await downloadPackage({
          url: originDownloadUrl,
          fileName: preferredFileName,
          expectedTotalBytes: effectiveUpdate.artifact?.fileSizeBytes ?? null,
          expectedHash: effectiveUpdate.artifact?.fileHash ?? null,
          onProgress: (progress) => {
            setUpdateDownload((current) => normalizeUpdateDownloadProgress(current, progress));
          }
        });
      }

      if (!result?.localPath) {
        throw new Error("安装器下载失败");
      }

      setUpdateDownload({
        phase: "completed",
        fileName: result.fileName,
        downloadedBytes: result.totalBytes ?? effectiveUpdate.artifact?.fileSizeBytes ?? 0,
        totalBytes: result.totalBytes ?? effectiveUpdate.artifact?.fileSizeBytes ?? null,
        localPath: result.localPath,
        message: "安装器下载完成，点击下方按钮开始安装。"
      });

      completedDownloadIdentityRef.current = updateArtifactIdentity;
      if (fullReplaceUpdate) {
        await applyDesktopFullUpdate({
          path: result.localPath,
          expectedTotalBytes: effectiveUpdate.artifact?.fileSizeBytes ?? null,
          expectedHash: effectiveUpdate.artifact?.fileHash ?? null
        });
      } else {
        await openDesktopInstaller(result.localPath);
      }
      return true;
    } catch (reason) {
      const message = reason instanceof Error ? (options.readError ?? defaultReadError)(reason.message) : "安装器下载失败";
      setUpdateDownload((current) => ({
        phase: "failed",
        fileName: current.fileName,
        downloadedBytes: current.downloadedBytes,
        totalBytes: current.totalBytes,
        localPath: current.localPath,
        message
      }));
      options.showError?.(message);
      return false;
    }
  }, [effectiveUpdate, options, updateDownload, updatePlatform]);

  const runUpdateCheck = useCallback(
    async (runOptions: RunUpdateCheckOptions) => {
      if (updateCheckBusyRef.current) {
        pendingUpdateCheckRef.current = mergePendingUpdateCheck(pendingUpdateCheckRef.current, runOptions);
        return null;
      }

      try {
        updateCheckBusyRef.current = true;
        setUpdateCheckBusy(true);
        const checkedUpdate = await checkClientUpdate({
          currentVersion: options.appVersion,
          platform: updatePlatform,
          channel: options.updateChannel ?? "stable",
          artifactType: preferredArtifactType(updatePlatform),
          clientMirrorPrefix: options.runtimeMirrorPrefix,
          accessToken: runOptions.accessToken ?? options.accessToken ?? undefined
        });
        const result =
          checkedUpdate ??
          (updatePlatform === "windows"
            ? null
            : createLegacyUpdateResult(
                runOptions.bootstrapVersion ?? options.bootstrapVersion ?? null,
                updatePlatform,
                options.appVersion,
                options.runtimeMirrorPrefix,
                lastKnownUpdateArtifactRef.current,
                options.updateChannel ?? "stable"
              ));

        setUpdateCheckResult(result);

        // 如果服务端返回的最新版本就是当前版本，说明当前已是最新，不触发更新提示
        const effectiveHasUpdate = hasActionableUpdate(result, options.appVersion);

        let runtimeSummary: RuntimeAssetsCheckSummary | null = null;
        if (options.checkRuntimeComponents) {
          try {
            const summary = await options.checkRuntimeComponents({
              source: runOptions.source,
              silent: runOptions.silent
            });
            runtimeSummary = summary ?? null;
          } catch {
            runtimeSummary = null;
          }
        }

        if (!result || !effectiveHasUpdate) {
          setUpdateDialogOpened(false);
          setUpdateDownload(createIdleUpdateDownloadState());
          deferredUpdatePromptKeyRef.current = null;
          lastUpdatePromptVersionRef.current = null;
          lastKnownUpdateArtifactRef.current = null;
          if (runOptions.source === "manual" && !runOptions.silent) {
            if (runtimeSummary?.updated?.length) {
              options.notify?.({
                color: "green",
                title: "客户端已是最新",
                message: `软件版本 ${formatVersionLabel(options.appVersion)} 已是最新；已更新 ${runtimeSummary.updated.join("、")}。`
              });
            } else if (runtimeSummary?.failed?.length) {
              options.notify?.({
                color: "yellow",
                title: "客户端已是最新",
                message: `软件版本 ${formatVersionLabel(options.appVersion)} 已是最新；${runtimeSummary.failed.join("、")} 更新失败，将继续使用本地文件。`
              });
            } else {
              options.notify?.({
                color: "green",
                title: "当前已是最新版本",
                message: `软件版本 ${formatVersionLabel(options.appVersion)}，核心组件也已检查完毕。`
              });
            }
          }
          return result;
        }

        const promptKey = buildUpdatePromptKey(result)!;
        const shouldPrompt =
          runOptions.source === "manual" ||
          result.forceUpgrade ||
          lastUpdatePromptVersionRef.current !== promptKey;

        if (shouldPrompt) {
          if (runOptions.source !== "manual" && options.isPromptBlocked?.()) {
            deferredUpdatePromptKeyRef.current = promptKey;
          } else {
            deferredUpdatePromptKeyRef.current = null;
            lastUpdatePromptVersionRef.current = promptKey;
            setUpdateDialogOpened(true);
          }
        }

        if (runOptions.source !== "manual" && !runOptions.silent) {
          options.notify?.({
            color: result.forceUpgrade ? "red" : "blue",
            title: result.forceUpgrade ? "发现强制更新" : "发现新版本",
            message: `${formatVersionLabel(result.latestVersion)} 已发布。`
          });
        }
        return result;
      } catch (reason) {
        if (isUnauthorizedApiError(reason)) {
          await options.onUnauthorized?.();
          return null;
        }
        if (!runOptions.silent || runOptions.source === "manual") {
          options.showError?.(reason instanceof Error ? (options.readError ?? defaultReadError)(reason.message) : "检查更新失败");
        }
        return null;
      } finally {
        updateCheckBusyRef.current = false;
        setUpdateCheckBusy(false);
        const pendingRun = pendingUpdateCheckRef.current;
        pendingUpdateCheckRef.current = null;
        if (pendingRun) {
          window.setTimeout(() => {
            void runUpdateCheck(pendingRun);
          }, 0);
        }
      }
    },
    [options, updatePlatform]
  );

  const handleManualUpdateCheck = useCallback(async () => {
    return runUpdateCheck({
      accessToken: options.accessToken,
      bootstrapVersion: options.bootstrapVersion ?? null,
      source: "manual"
    });
  }, [options.accessToken, options.bootstrapVersion, runUpdateCheck]);

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
    if (updateDownload.phase !== "completed" || !updateDownload.localPath) {
      options.showError?.("安装器尚未准备就绪，请先完成下载。");
      return false;
    }
    try {
      // 清空更新状态，避免重启后短暂显示旧的"有更新"提示
      setUpdateCheckResult(null);
      if (effectiveUpdate && isFullReplaceUpdate(effectiveUpdate, updatePlatform)) {
        await applyDesktopFullUpdate({
          path: updateDownload.localPath,
          expectedTotalBytes: effectiveUpdate.artifact?.fileSizeBytes ?? null,
          expectedHash: effectiveUpdate.artifact?.fileHash ?? null
        });
      } else {
        await quitForUpdate();
      }
      return true;
    } catch (reason) {
      const message = reason instanceof Error ? (options.readError ?? defaultReadError)(reason.message) : "启动安装器失败";
      options.showError?.(message);
      return false;
    }
  }, [effectiveUpdate, options, updateDownload, updatePlatform]);

  return {
    updatePlatform,
    updateCheckBusy,
    updateCheckResult,
    setUpdateCheckResult,
    effectiveUpdate,
    forceUpdateRequired,
    updateDialogOpened,
    setUpdateDialogOpened,
    updateDownload,
    setUpdateDownload,
    indeterminateUpdateProgress,
    deferredUpdatePromptKeyRef,
    lastUpdatePromptVersionRef,
    describeUpdateDownload: () => describeUpdateDownload(updateDownload),
    displayUpdateDownloadProgress: () => displayUpdateDownloadProgress(updateDownload, indeterminateUpdateProgress),
    runUpdateCheck,
    runUpdateCheckAndFocus,
    handleManualUpdateCheck,
    handleUpdateDownload,
    handleQuitForUpdate
  };
}
