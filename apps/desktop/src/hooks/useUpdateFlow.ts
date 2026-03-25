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
  downloadDesktopInstaller,
  openDesktopInstaller,
  openExternalLink,
  subscribeDesktopUpdateDownloadProgress,
  type RuntimeStatus
} from "../lib/runtime";
import {
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
};

function defaultReadError(message: string) {
  return message;
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
            effectiveUpdate.minimumVersion.localeCompare(options.appVersion, undefined, {
              numeric: true,
              sensitivity: "base"
            }) > 0)
      ),
    [effectiveUpdate, options.appVersion]
  );

  useEffect(() => {
    if (options.platformTarget === "android" || options.platformTarget === "web") {
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
  }, [options.platformTarget]);

  useEffect(() => {
    setUpdateDownload(createIdleUpdateDownloadState());
  }, [effectiveUpdate?.latestVersion, effectiveUpdate?.downloadUrl]);

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

    if (effectiveUpdate.deliveryMode !== "desktop_installer_download" || updatePlatform === "android") {
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

    if (updateDownload.phase === "completed" && updateDownload.localPath) {
      try {
        await openDesktopInstaller(updateDownload.localPath);
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
        result = await downloadDesktopInstaller({
          url: resolvedDownloadUrl,
          fileName: preferredFileName,
          expectedTotalBytes: effectiveUpdate.artifact?.fileSizeBytes ?? null,
          expectedHash: effectiveUpdate.artifact?.fileHash ?? null
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
        result = await downloadDesktopInstaller({
          url: originDownloadUrl,
          fileName: preferredFileName,
          expectedTotalBytes: effectiveUpdate.artifact?.fileSizeBytes ?? null,
          expectedHash: effectiveUpdate.artifact?.fileHash ?? null
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
        message: "安装器下载完成，正在打开安装程序…"
      });

      await openDesktopInstaller(result.localPath);
      options.notify?.({
        color: "green",
        title: "安装器已打开",
        message: usedFallback
          ? "已自动回退到原始下载地址，并成功打开安装器。请按安装向导完成升级。"
          : "请按安装向导完成升级，安装完成后重新打开 ChordV。"
      });
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
      if (updateCheckBusy) {
        return null;
      }

      try {
        setUpdateCheckBusy(true);
        const result =
          (await checkClientUpdate({
            currentVersion: options.appVersion,
            platform: updatePlatform,
            channel: options.updateChannel ?? "stable",
            artifactType: preferredArtifactType(updatePlatform),
            clientMirrorPrefix: options.runtimeMirrorPrefix,
            accessToken: runOptions.accessToken ?? options.accessToken ?? undefined
          })) ??
          createLegacyUpdateResult(
            runOptions.bootstrapVersion ?? options.bootstrapVersion ?? null,
            updatePlatform,
            options.appVersion,
            options.runtimeMirrorPrefix,
            lastKnownUpdateArtifactRef.current,
            options.updateChannel ?? "stable"
          );

        setUpdateCheckResult(result);

        if (!result || !result.hasUpdate) {
          if (runOptions.source === "manual" && !runOptions.silent) {
            options.notify?.({
              color: "green",
              title: "当前已是最新版本",
              message: `你当前使用的是 ${formatVersionLabel(options.appVersion)}。`
            });
          }
          return result;
        }

        const promptKey = `${result.latestVersion}:${result.forceUpgrade ? "force" : "optional"}`;
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
        setUpdateCheckBusy(false);
      }
    },
    [options, updateCheckBusy, updatePlatform]
  );

  const handleManualUpdateCheck = useCallback(async () => {
    return runUpdateCheck({
      accessToken: options.accessToken,
      bootstrapVersion: options.bootstrapVersion ?? null,
      source: "manual"
    });
  }, [options.accessToken, options.bootstrapVersion, runUpdateCheck]);

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
    handleManualUpdateCheck,
    handleUpdateDownload
  };
}
