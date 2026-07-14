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
  consumeDesktopUpdateInstallReport,
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
import {
  buildAppUpdateCenterItem,
  createDefaultUpdateCenterItems,
  createIdleUpdateCenterState,
  type UpdateCenterItem,
  type UpdateCenterItemKey,
  type UpdateCenterState
} from "../lib/updateCenter";

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
  /** 手动检测默认仅检查；需要下载时再显式关闭 */
  inspectOnly?: boolean;
  includeRuntimeComponents?: boolean;
  runtimeTargets?: Array<"xray" | "geo">;
  openUpdateCenter?: boolean;
};

type RuntimeAssetsCheckSummary = {
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
    inspectOnly?: boolean;
    targets?: Array<"xray" | "geo">;
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
    artifact?.fileSizeBytes ?? ""
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
  const [updateCheckResult, setUpdateCheckResult] = useState<ClientUpdateCheckResult | null>(null);
  const [updateDialogOpened, setUpdateDialogOpened] = useState(false);
  const [updateCenter, setUpdateCenter] = useState<UpdateCenterState>(createIdleUpdateCenterState);
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
          });
        } else {
          await openDesktopInstaller(updateDownload.localPath);
        }
        options.notify?.({
          color: "green",
          title: "准备安装",
          message: "本地更新包可用。请点击“安装并重启”完成安装。"
        });
        return true;
      } catch (reason) {
        setUpdateDownload(createIdleUpdateDownloadState());
        options.notify?.({
          color: "yellow",
          title: "本地更新包不可用",
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
        message: "更新包下载完成，点击下方按钮开始安装。"
      });

      completedDownloadIdentityRef.current = updateArtifactIdentity;
      if (fullReplaceUpdate) {
        await applyDesktopFullUpdate({
          path: result.localPath,
          expectedTotalBytes: effectiveUpdate.artifact?.fileSizeBytes ?? null,
        });
        return true;
      }

      // Mac/DMG 与安装器路径：先登记待安装文件，由用户点击“安装并重启”再退出安装。
      await openDesktopInstaller(result.localPath);
      setUpdateDownload((current) => ({
        ...current,
        phase: "completed",
        message: usedFallback
          ? "更新包已下载完成（已回退原始地址）。请点击“安装并重启”。"
          : "更新包已下载完成。请点击“安装并重启”，应用退出后自动完成替换安装。"
      }));
      options.notify?.({
        color: "green",
        title: "更新包已就绪",
        message: "下载完成。点击“安装并重启”后，应用会退出并自动完成安装。"
      });
      return true;
    } catch (reason) {
      const message = reason instanceof Error ? (options.readError ?? defaultReadError)(reason.message) : "更新包下载失败";
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


  const patchUpdateCenterItems = useCallback((patchers: Partial<Record<UpdateCenterItemKey, Partial<UpdateCenterItem>>>) => {
    setUpdateCenter((current) => ({
      ...current,
      items: current.items.map((item) => {
        const patch = patchers[item.key];
        return patch ? { ...item, ...patch } : item;
      })
    }));
  }, []);

  const openUpdateCenter = useCallback(() => {
    setUpdateCenter((current) => ({
      ...current,
      opened: true,
      items: current.items.length ? current.items : createDefaultUpdateCenterItems()
    }));
  }, []);

  const closeUpdateCenter = useCallback(() => {
    setUpdateCenter((current) => ({
      ...current,
      opened: false
    }));
  }, []);

  const setUpdateCenterItemEnabled = useCallback((key: UpdateCenterItemKey, enabled: boolean) => {
    patchUpdateCenterItems({ [key]: { enabled } });
  }, [patchUpdateCenterItems]);

  const runUpdateCheck = useCallback(
    async (runOptions: RunUpdateCheckOptions) => {
      if (updateCheckBusyRef.current) {
        pendingUpdateCheckRef.current = mergePendingUpdateCheck(pendingUpdateCheckRef.current, runOptions);
        return null;
      }

      try {
        // 启动/登录等静默检查不占用「检测更新」按钮 loading，避免一进软件就转圈、影响连接
        const isInteractiveCheck =
          runOptions.source === "manual" || Boolean(runOptions.openUpdateCenter);
        if (isInteractiveCheck) {
          updateCheckBusyRef.current = true;
          setUpdateCheckBusy(true);
          setUpdateCenter((current) => ({
            ...current,
            opened: true,
            checking: true,
            updatingKey: null,
            items: current.items.map((item) =>
              item.enabled
                ? {
                    ...item,
                    status: "checking",
                    message: "正在检查…"
                  }
                : item
            )
          }));
        }
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

        // 默认：仅手动/更新中心检查核心组件；启动只查软件版本（国内接口快）
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

        const appItem = buildAppUpdateCenterItem({
          appVersion: options.appVersion,
          update: result,
          hasActionableUpdate: effectiveHasUpdate
        });
        const xrayItem: UpdateCenterItem = {
          key: "xray",
          label: "Xray",
          enabled: true,
          status: runtimeSummary?.xray?.available
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
          enabled: true,
          status: runtimeSummary?.geo?.available
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
          const enabledMap = new Map(current.items.map((item) => [item.key, item.enabled]));
          const nextItems = [appItem, xrayItem, geoItem].map((item) => ({
            ...item,
            enabled: enabledMap.has(item.key) ? Boolean(enabledMap.get(item.key)) : item.enabled
          }));
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
          lastKnownUpdateArtifactRef.current = null;
          // 手动检测走更新中心弹窗，不再用 toast 刷屏
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
        if (runOptions.source === "manual" || runOptions.openUpdateCenter) {
          updateCheckBusyRef.current = false;
          setUpdateCheckBusy(false);
        }
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
      source: "manual",
      silent: true,
      inspectOnly: true,
      includeRuntimeComponents: true,
      openUpdateCenter: true
    });
  }, [options.accessToken, options.bootstrapVersion, runUpdateCheck]);

  const handleUpdateCenterCheckOnly = useCallback(async () => {
    return runUpdateCheck({
      accessToken: options.accessToken,
      bootstrapVersion: options.bootstrapVersion ?? null,
      source: "manual",
      silent: true,
      inspectOnly: true,
      includeRuntimeComponents: true,
      openUpdateCenter: true
    });
  }, [options.accessToken, options.bootstrapVersion, runUpdateCheck]);

  const handleUpdateCenterUpdateOne = useCallback(
    async (key: UpdateCenterItemKey) => {
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
            accessToken: options.accessToken,
            bootstrapVersion: options.bootstrapVersion ?? null,
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
          accessToken: options.accessToken,
          bootstrapVersion: options.bootstrapVersion ?? null,
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
    [options.accessToken, options.appVersion, options.bootstrapVersion, runUpdateCheck]
  );

  const handleUpdateCenterUpdateSelected = useCallback(async () => {
    const enabled = updateCenter.items.filter((item) => item.enabled);
    if (!enabled.length) {
      return null;
    }
    setUpdateCenter((current) => ({
      ...current,
      opened: true,
      updatingKey: "all",
      items: current.items.map((item) =>
        item.enabled
          ? {
              ...item,
              status: item.canUpdate || item.status === "available" || item.status === "idle" ? "updating" : item.status,
              message: item.enabled ? "正在处理…" : item.message
            }
          : item
      )
    }));
    try {
      const runtimeTargets = enabled
        .map((item) => item.key)
        .filter((key): key is "xray" | "geo" => key === "xray" || key === "geo");
      const includeApp = enabled.some((item) => item.key === "app");
      const result = await runUpdateCheck({
        accessToken: options.accessToken,
        bootstrapVersion: options.bootstrapVersion ?? null,
        source: "manual",
        silent: true,
        inspectOnly: false,
        includeRuntimeComponents: runtimeTargets.length > 0,
        runtimeTargets: runtimeTargets.length ? runtimeTargets : undefined,
        openUpdateCenter: true
      });
      if (includeApp && hasActionableUpdate(result, options.appVersion)) {
        setUpdateDialogOpened(true);
      }
      return result;
    } finally {
      setUpdateCenter((current) => ({
        ...current,
        updatingKey: null
      }));
    }
  }, [options.accessToken, options.appVersion, options.bootstrapVersion, runUpdateCheck, updateCenter.items]);

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
      options.showError?.("更新包尚未准备就绪，请先完成下载。");
      return false;
    }
    try {
      // 清空更新状态，避免重启后短暂显示旧的“有更新”提示
      setUpdateCheckResult(null);
      if (effectiveUpdate && isFullReplaceUpdate(effectiveUpdate, updatePlatform)) {
        await applyDesktopFullUpdate({
          path: updateDownload.localPath,
          expectedTotalBytes: effectiveUpdate.artifact?.fileSizeBytes ?? null,
        });
      } else {
        await openDesktopInstaller(updateDownload.localPath);
        await quitForUpdate();
      }
      return true;
    } catch (reason) {
      const message = reason instanceof Error ? (options.readError ?? defaultReadError)(reason.message) : "启动安装失败";
      options.showError?.(message);
      return false;
    }
  }, [effectiveUpdate, options, updateDownload, updatePlatform]);

  const consumeUpdateInstallReport = useCallback(async () => {
    try {
      const report = await consumeDesktopUpdateInstallReport();
      if (!report || report.ok) {
        return null;
      }
      const summary = report.summary?.trim() || "自动替换安装未成功，已改为打开安装包。";
      options.notify?.({
        color: "yellow",
        title: "更新安装未完全成功",
        message: summary
      });
      return report;
    } catch {
      return null;
    }
  }, [options]);

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
    handleQuitForUpdate,
    updateCenter,
    openUpdateCenter,
    closeUpdateCenter,
    setUpdateCenterItemEnabled,
    handleUpdateCenterCheckOnly,
    handleUpdateCenterUpdateOne,
    handleUpdateCenterUpdateSelected,
    consumeUpdateInstallReport
  };
}
