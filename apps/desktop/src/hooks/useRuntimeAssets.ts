import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchRuntimeComponentsPlan,
  isUnauthorizedApiError,
  reportRuntimeComponentFailure
} from "../api/client";
import {
  buildGeoComponentItem,
  buildGeoRemoteAssetsFromRelease,
  buildGithubReleaseLatestApiUrl,
  isLocalGeoCurrent,
  parseGithubReleasePayload,
  parseSha256Sum,
  readStoredGeoInstalledTag,
  readStoredGeoLastCheckAt,
  shouldCheckGeoUpdate,
  writeStoredGeoInstalledTag,
  writeStoredGeoLastCheckAt,
  GEO_CHECK_INTERVAL_MS,
  type GeoRemotePlan,
  type RuntimeComponentLocalInfo
} from "../lib/geoUpdate";
import {
  cancelRuntimeComponentDownload,
  checkRuntimeComponentFile,
  downloadRuntimeComponent,
  ensureBundledRuntimeComponents,
  fetchRemoteText,
  getRuntimeComponentLocalInfo,
  loadDesktopRuntimeEnvironment,
  subscribeRuntimeComponentDownloadProgress,
  type RuntimeStatus
} from "../lib/runtime";
import {
  canOpenRuntimeAssetsDialog,
  extractRuntimeAssetsErrorCode,
  normalizeRuntimeAssetsProgress,
  resolveRuntimeComponentCandidate,
  resolveRuntimePlanPlatform,
  stripRuntimeAssetsErrorPrefix
} from "../lib/runtimeAssetsState";
import {
  createIdleRuntimeAssetsState,
  type RuntimeAssetsUiState,
  type RuntimeComponentDownloadItem,
  type RuntimeDownloadFailureReason
} from "../lib/runtimeComponents";

type NoticeInput = {
  color: "green" | "yellow" | "red" | "blue";
  title: string;
  message: string;
};

export type RuntimeAssetsCheckSummary = {
  checked: boolean;
  updated: string[];
  failed: string[];
  current: boolean;
  releaseTag: string | null;
};

type EnsureRuntimeAssetsOptions = {
  source: "startup" | "connect" | "retry" | "update_check";
  interactive: boolean;
  blockConnection: boolean;
  forceCheck?: boolean;
};

type UseRuntimeAssetsOptions = {
  appVersion: string;
  platformTarget: RuntimeStatus["platformTarget"];
  accessToken?: string | null;
  runtimeMirrorPrefix: string;
  forceUpdateRequired?: boolean;
  forcedAnnouncementActive?: boolean;
  updateDialogOpened?: boolean;
  announcementDrawerOpened?: boolean;
  updateDownloadPhase?: "idle" | "preparing" | "downloading" | "completed" | "failed";
  mirrorPrefixStorageKey?: string;
  notify?: (notice: NoticeInput) => void;
  onUnauthorized?: () => Promise<unknown> | unknown;
  readError?: (message: string) => string;
};

function defaultReadError(message: string) {
  return message;
}

function hasRequiredRuntimeComponents(plan: { components: Array<{ component: string }> }) {
  const kinds = new Set(plan.components.map((component) => component.component));
  return kinds.has("xray") && kinds.has("geoip") && kinds.has("geosite");
}

function emptySummary(): RuntimeAssetsCheckSummary {
  return {
    checked: false,
    updated: [],
    failed: [],
    current: true,
    releaseTag: null
  };
}

async function downloadComponentWithFallback(component: RuntimeComponentDownloadItem, preferredUrl?: string | null) {
  const urls = [
    preferredUrl,
    ...component.candidates.map((candidate) => candidate.url)
  ].filter((value, index, list): value is string => Boolean(value) && list.indexOf(value) === index);

  let lastError: unknown = new Error(`${component.displayName} 没有可用下载地址`);
  for (const url of urls) {
    try {
      await downloadRuntimeComponent({ component, url });
      return url;
    } catch (reason) {
      lastError = reason;
    }
  }
  throw lastError;
}

export function useRuntimeAssets(options: UseRuntimeAssetsOptions) {
  const [runtimeAssets, setRuntimeAssets] = useState<RuntimeAssetsUiState>(createIdleRuntimeAssetsState);
  const [runtimeAssetsDialogOpened, setRuntimeAssetsDialogOpened] = useState(false);
  const runtimeAssetsTaskRef = useRef<Promise<boolean> | null>(null);
  const cancelRequestedRef = useRef(false);
  const lastSummaryRef = useRef<RuntimeAssetsCheckSummary>(emptySummary());

  useEffect(() => {
    if (options.platformTarget === "android" || options.platformTarget === "web") {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;

    void subscribeRuntimeComponentDownloadProgress((progress) => {
      if (disposed) {
        return;
      }
      setRuntimeAssets((current) => normalizeRuntimeAssetsProgress(current, progress));
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

  const runtimeAssetsReady = useMemo(
    () =>
      options.platformTarget === "android" || options.platformTarget === "web"
        ? true
        : runtimeAssets.phase === "ready",
    [options.platformTarget, runtimeAssets.phase]
  );

  const runtimeAssetsBusy = runtimeAssets.phase === "checking" || runtimeAssets.phase === "downloading";

  const failRuntimeAssets = useCallback(
    async (
      failure: {
        code: RuntimeDownloadFailureReason;
        message: string;
        component: "xray" | "geoip" | "geosite";
        effectiveUrl: string | null;
        platform: "macos" | "windows";
        architecture: "x64" | "arm64";
      },
      ensureOptions: EnsureRuntimeAssetsOptions,
      componentId?: string | null
    ) => {
      setRuntimeAssets({
        phase: "failed",
        currentComponent: failure.component,
        fileName: null,
        downloadedBytes: 0,
        totalBytes: null,
        message: null,
        errorCode: failure.code,
        errorMessage: failure.message,
        blocking: ensureOptions.blockConnection
      });

      void reportRuntimeComponentFailure({
        accessToken: options.accessToken ?? null,
        componentId,
        component: failure.component,
        platform: failure.platform,
        architecture: failure.architecture,
        failureReason: failure.code,
        message: failure.message,
        effectiveUrl: failure.effectiveUrl,
        appVersion: options.appVersion
      }).catch(() => null);

      if (
        ensureOptions.interactive ||
        (ensureOptions.source !== "startup" &&
          ensureOptions.source !== "update_check" &&
          canOpenRuntimeAssetsDialog(
            options.forceUpdateRequired ?? false,
            options.forcedAnnouncementActive ?? false,
            options.updateDialogOpened ?? false,
            options.announcementDrawerOpened ?? false,
            options.updateDownloadPhase ?? "idle"
          ))
      ) {
        setRuntimeAssetsDialogOpened(true);
      }
      return false;
    },
    [options]
  );

  const loadGeoRemotePlan = useCallback(async (): Promise<GeoRemotePlan | null> => {
    const releaseResponse = await fetchRemoteText(buildGithubReleaseLatestApiUrl());
    if (!releaseResponse?.body) {
      return null;
    }
    const release = parseGithubReleasePayload(releaseResponse.body);
    if (!release) {
      return null;
    }

    const checksums: Partial<Record<"geoip.dat" | "geosite.dat", string>> = {};
    for (const fileName of ["geoip.dat", "geosite.dat"] as const) {
      const originSumUrl = `https://github.com/Loyalsoldier/v2ray-rules-dat/releases/download/${encodeURIComponent(release.tag)}/${fileName}.sha256sum`;
      const sumUrls = [
        originSumUrl,
        `https://cdn.jsdelivr.net/gh/Loyalsoldier/v2ray-rules-dat@${release.tag}/${fileName}.sha256sum`,
        `https://mirror.ghproxy.com/${originSumUrl}`,
        `https://ghfast.top/${originSumUrl}`
      ];
      for (const sumUrl of sumUrls) {
        try {
          const response = await fetchRemoteText(sumUrl);
          const hash = response?.body ? parseSha256Sum(response.body) : null;
          if (hash) {
            checksums[fileName] = hash;
            break;
          }
        } catch {
          // try next mirror
        }
      }
    }

    return buildGeoRemoteAssetsFromRelease(release, checksums);
  }, []);


  const collectServerMirrorPrefixes = useCallback((plan: Awaited<ReturnType<typeof fetchRuntimeComponentsPlan>>) => {
    if (!plan) return [] as string[];
    const prefixes = new Set<string>();
    if (plan.defaultMirrorPrefix) {
      for (const item of plan.defaultMirrorPrefix.split(/[\n,;]+/)) {
        const value = item.trim();
        if (value) prefixes.add(value);
      }
    }
    for (const component of plan.components) {
      const origin = component.candidates.find((item) => item.source === "origin")?.url;
      if (!origin) continue;
      for (const candidate of component.candidates) {
        if (candidate.source !== "server_mirror") continue;
        if (candidate.url.endsWith(origin)) {
          const prefix = candidate.url.slice(0, candidate.url.length - origin.length);
          if (prefix.trim()) prefixes.add(prefix);
        }
      }
    }
    return Array.from(prefixes);
  }, []);

  const markReady = useCallback((message: string) => {
    setRuntimeAssets({
      phase: "ready",
      currentComponent: null,
      fileName: null,
      downloadedBytes: 0,
      totalBytes: null,
      message,
      errorCode: null,
      errorMessage: null,
      blocking: false
    });
    setRuntimeAssetsDialogOpened(false);
  }, []);

  const ensureRuntimeAssetsReady = useCallback(
    async (ensureOptions: EnsureRuntimeAssetsOptions) => {
      if (options.platformTarget === "android" || options.platformTarget === "web") {
        lastSummaryRef.current = { checked: true, updated: [], failed: [], current: true, releaseTag: null };
        return true;
      }
      if (
        !ensureOptions.forceCheck &&
        runtimeAssets.phase === "ready" &&
        ensureOptions.source === "connect" &&
        !shouldCheckGeoUpdate(readStoredGeoLastCheckAt())
      ) {
        return true;
      }
      if (runtimeAssetsTaskRef.current) {
        if (ensureOptions.interactive || ensureOptions.blockConnection) {
          setRuntimeAssets((current) => ({
            ...current,
            blocking: current.blocking || ensureOptions.blockConnection
          }));
          if (ensureOptions.blockConnection) {
            setRuntimeAssetsDialogOpened(true);
          }
        }
        return runtimeAssetsTaskRef.current;
      }

      const silentBackground =
        (ensureOptions.source === "startup" || ensureOptions.source === "update_check") &&
        !ensureOptions.interactive &&
        !ensureOptions.blockConnection;

      const task = (async () => {
        cancelRequestedRef.current = false;
        const summary: RuntimeAssetsCheckSummary = {
          checked: true,
          updated: [],
          failed: [],
          current: true,
          releaseTag: null
        };

        if (!silentBackground) {
          setRuntimeAssets((current) => ({
            ...current,
            phase: "checking",
            message: "正在检查必要核心组件，请稍候。",
            blocking: ensureOptions.blockConnection,
            errorCode: null,
            errorMessage: null
          }));
        }

        try {
          const environment = await loadDesktopRuntimeEnvironment().catch(() => null);
          const platform = environment?.platform ?? resolveRuntimePlanPlatform(options.platformTarget);
          const architecture = environment?.architecture ?? "arm64";

          const bundled = await ensureBundledRuntimeComponents().catch(() => null);
          const localInfos = {
            xray: await getRuntimeComponentLocalInfo("xray").catch(() => null),
            geoip: await getRuntimeComponentLocalInfo("geoip").catch(() => null),
            geosite: await getRuntimeComponentLocalInfo("geosite").catch(() => null)
          };
          const localReady = Boolean(
            bundled?.ready ||
              (localInfos.xray?.exists &&
                (localInfos.xray.sizeBytes ?? 0) > 0 &&
                localInfos.geoip?.exists &&
                (localInfos.geoip.sizeBytes ?? 0) > 0 &&
                localInfos.geosite?.exists &&
                (localInfos.geosite.sizeBytes ?? 0) > 0)
          );

          const shouldRefreshRemote =
            ensureOptions.forceCheck ||
            ensureOptions.source === "retry" ||
            shouldCheckGeoUpdate(readStoredGeoLastCheckAt());

          // Missing local files: fall back to server plan for first install.
          if (!localReady) {
            const plan = await fetchRuntimeComponentsPlan({
              accessToken: options.accessToken ?? null,
              clientMirrorPrefix: options.runtimeMirrorPrefix
            });

            if (!plan || !hasRequiredRuntimeComponents(plan)) {
              return failRuntimeAssets(
                {
                  code: "plan_missing",
                  message: "服务端尚未配置必要核心组件，当前暂时不能连接。",
                  component: "xray",
                  effectiveUrl: null,
                  platform,
                  architecture
                },
                ensureOptions
              );
            }

            const pendingComponents: RuntimeComponentDownloadItem[] = [];
            for (const component of plan.components) {
              const status = await checkRuntimeComponentFile(component).catch(() => null);
              if (!status?.ready) {
                pendingComponents.push(component);
              }
            }

            for (const component of pendingComponents) {
              const candidate = resolveRuntimeComponentCandidate(component, options.runtimeMirrorPrefix);
              setRuntimeAssets({
                phase: "downloading",
                currentComponent: component.component,
                fileName: component.fileName,
                downloadedBytes: 0,
                totalBytes: component.fileSizeBytes,
                message: `正在准备 ${component.displayName}，完成后即可继续连接。`,
                errorCode: null,
                errorMessage: null,
                blocking: ensureOptions.blockConnection
              });
              if (ensureOptions.blockConnection || ensureOptions.interactive) {
                setRuntimeAssetsDialogOpened(true);
              }
              try {
                await downloadComponentWithFallback(component, candidate?.url ?? null);
                summary.updated.push(component.displayName);
              } catch (reason) {
                const rawMessage = reason instanceof Error ? reason.message : String(reason);
                return failRuntimeAssets(
                  {
                    code: extractRuntimeAssetsErrorCode(rawMessage),
                    message: stripRuntimeAssetsErrorPrefix(rawMessage),
                    component: component.component,
                    effectiveUrl: candidate?.url ?? null,
                    platform: plan.platform,
                    architecture: plan.architecture
                  },
                  ensureOptions,
                  component.id
                );
              }
            }
          }

          // Optional remote refresh for GEO (external multi-source) + xray (server plan).
          if (shouldRefreshRemote) {
            writeStoredGeoLastCheckAt(Date.now());

            try {
              const mirrorPlan = await fetchRuntimeComponentsPlan({
                accessToken: options.accessToken ?? null,
                clientMirrorPrefix: options.runtimeMirrorPrefix
              }).catch(() => null);
              const serverMirrorPrefixes = collectServerMirrorPrefixes(mirrorPlan);
              const geoPlan = await loadGeoRemotePlan();
              if (geoPlan) {
                summary.releaseTag = geoPlan.releaseTag;
                for (const asset of geoPlan.assets) {
                  const local = localInfos[asset.kind] as RuntimeComponentLocalInfo | null;
                  if (isLocalGeoCurrent(local, asset)) {
                    continue;
                  }
                  const component = buildGeoComponentItem(
                    asset,
                    options.runtimeMirrorPrefix,
                    serverMirrorPrefixes
                  );
                  setRuntimeAssets({
                    phase: "downloading",
                    currentComponent: component.component,
                    fileName: component.fileName,
                    downloadedBytes: 0,
                    totalBytes: component.fileSizeBytes,
                    message: `正在更新 ${component.displayName}…`,
                    errorCode: null,
                    errorMessage: null,
                    blocking: ensureOptions.blockConnection
                  });
              if (ensureOptions.blockConnection || ensureOptions.interactive) {
                setRuntimeAssetsDialogOpened(true);
              }
                  try {
                    await downloadComponentWithFallback(component, component.selectedUrl);
                    summary.updated.push(component.displayName);
                    summary.current = false;
                    localInfos[asset.kind] = {
                      kind: asset.kind,
                      exists: true,
                      path: local?.path ?? null,
                      sizeBytes: asset.fileSizeBytes,
                      checksumSha256: asset.checksumSha256
                    };
                  } catch (reason) {
                    const message = reason instanceof Error ? reason.message : String(reason);
                    summary.failed.push(component.displayName);
                    summary.current = false;
                    if (!localReady && ensureOptions.blockConnection) {
                      return failRuntimeAssets(
                        {
                          code: extractRuntimeAssetsErrorCode(message),
                          message: stripRuntimeAssetsErrorPrefix(message),
                          component: component.component,
                          effectiveUrl: component.selectedUrl,
                          platform,
                          architecture
                        },
                        ensureOptions,
                        component.id
                      );
                    }
                  }
                }
                if (summary.failed.length === 0) {
                  writeStoredGeoInstalledTag(geoPlan.releaseTag);
                } else if (readStoredGeoInstalledTag() !== geoPlan.releaseTag && summary.updated.length > 0) {
                  // partial update: still record tag only when both assets match remote
                }
                if (
                  isLocalGeoCurrent(localInfos.geoip, geoPlan.assets[0]) &&
                  isLocalGeoCurrent(localInfos.geosite, geoPlan.assets[1])
                ) {
                  writeStoredGeoInstalledTag(geoPlan.releaseTag);
                }
              } else {
                summary.failed.push("GEO 数据源");
              }
            } catch {
              summary.failed.push("GEO 数据源");
            }

            // xray remains server-managed; refresh when plan hash differs.
            try {
              const plan = await fetchRuntimeComponentsPlan({
                accessToken: options.accessToken ?? null,
                clientMirrorPrefix: options.runtimeMirrorPrefix
              });
              const xrayItem = plan?.components.find((item) => item.component === "xray") ?? null;
              if (xrayItem) {
                const status = await checkRuntimeComponentFile(xrayItem).catch(() => null);
                if (!status?.ready) {
                  const candidate = resolveRuntimeComponentCandidate(xrayItem, options.runtimeMirrorPrefix);
                  setRuntimeAssets({
                    phase: "downloading",
                    currentComponent: "xray",
                    fileName: xrayItem.fileName,
                    downloadedBytes: 0,
                    totalBytes: xrayItem.fileSizeBytes,
                    message: `正在更新 ${xrayItem.displayName}…`,
                    errorCode: null,
                    errorMessage: null,
                    blocking: ensureOptions.blockConnection
                  });
              if (ensureOptions.blockConnection || ensureOptions.interactive) {
                setRuntimeAssetsDialogOpened(true);
              }
                  try {
                    await downloadComponentWithFallback(xrayItem, candidate?.url ?? null);
                    summary.updated.push(xrayItem.displayName);
                    summary.current = false;
                  } catch (reason) {
                    const message = reason instanceof Error ? reason.message : String(reason);
                    summary.failed.push(xrayItem.displayName);
                    summary.current = false;
                    if (!localReady && ensureOptions.blockConnection) {
                      return failRuntimeAssets(
                        {
                          code: extractRuntimeAssetsErrorCode(message),
                          message: stripRuntimeAssetsErrorPrefix(message),
                          component: "xray",
                          effectiveUrl: candidate?.url ?? null,
                          platform: plan?.platform ?? platform,
                          architecture: plan?.architecture ?? architecture
                        },
                        ensureOptions,
                        xrayItem.id
                      );
                    }
                  }
                }
              }
            } catch (reason) {
              if (isUnauthorizedApiError(reason)) {
                await options.onUnauthorized?.();
                return false;
              }
              // non-blocking when local xray already exists
              if (!localInfos.xray?.exists && ensureOptions.blockConnection) {
                throw reason;
              }
            }
          }

          const finalLocalReady = Boolean(
            (await getRuntimeComponentLocalInfo("xray").catch(() => null))?.exists &&
              (await getRuntimeComponentLocalInfo("geoip").catch(() => null))?.exists &&
              (await getRuntimeComponentLocalInfo("geosite").catch(() => null))?.exists
          );
          if (!finalLocalReady) {
            return failRuntimeAssets(
              {
                code: "component_missing",
                message: "连接所需核心组件尚未准备完成。",
                component: "xray",
                effectiveUrl: null,
                platform,
                architecture
              },
              ensureOptions
            );
          }

          summary.current = summary.updated.length === 0 && summary.failed.length === 0;
          lastSummaryRef.current = summary;

          if (summary.updated.length > 0 && !silentBackground) {
            setRuntimeAssets({
              phase: "completed",
              currentComponent: null,
              fileName: null,
              downloadedBytes: 0,
              totalBytes: null,
              message: `已更新：${summary.updated.join("、")}`,
              errorCode: null,
              errorMessage: null,
              blocking: false
            });
            await new Promise((resolve) => window.setTimeout(resolve, 600));
          }

          markReady(
            summary.updated.length > 0
              ? `核心组件已更新：${summary.updated.join("、")}`
              : "连接所需组件已准备完成。"
          );

          if (
            summary.updated.length > 0 &&
            (ensureOptions.interactive || ensureOptions.source === "update_check")
          ) {
            options.notify?.({
              color: "green",
              title: "核心组件已更新",
              message: `${summary.updated.join("、")} 已更新到可用版本。`
            });
          } else if (
            summary.failed.length > 0 &&
            ensureOptions.interactive &&
            ensureOptions.source === "update_check"
          ) {
            options.notify?.({
              color: "yellow",
              title: "组件更新未完成",
              message: `${summary.failed.join("、")} 更新失败，将继续使用本地已有文件。`
            });
          }

          return true;
        } catch (reason) {
          if (isUnauthorizedApiError(reason)) {
            await options.onUnauthorized?.();
            return false;
          }
          const rawMessage = reason instanceof Error ? reason.message : "必要核心组件下载失败";
          const message = stripRuntimeAssetsErrorPrefix((options.readError ?? defaultReadError)(rawMessage));
          return failRuntimeAssets(
            {
              code: extractRuntimeAssetsErrorCode(rawMessage),
              message,
              component: runtimeAssets.currentComponent ?? "xray",
              effectiveUrl: null,
              platform: resolveRuntimePlanPlatform(options.platformTarget),
              architecture: "arm64"
            },
            ensureOptions
          );
        }
      })();

      runtimeAssetsTaskRef.current = task;
      try {
        return await task;
      } finally {
        runtimeAssetsTaskRef.current = null;
      }
    },
    [
      failRuntimeAssets,
      loadGeoRemotePlan,
      markReady,
      options,
      runtimeAssets.currentComponent,
      runtimeAssets.phase
    ]
  );

  const getLastRuntimeAssetsCheckSummary = useCallback(() => lastSummaryRef.current, []);


  useEffect(() => {
    if (options.platformTarget === "android" || options.platformTarget === "web") {
      return;
    }
    const timer = window.setInterval(() => {
      void ensureRuntimeAssetsReady({
        source: "update_check",
        interactive: false,
        blockConnection: false,
        forceCheck: false
      });
    }, GEO_CHECK_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [ensureRuntimeAssetsReady, options.platformTarget]);


  const handleCancelRuntimeAssets = useCallback(() => {
    cancelRequestedRef.current = true;
    void cancelRuntimeComponentDownload().catch(() => null);
    setRuntimeAssets((current) => ({
      ...current,
      phase: current.phase === "downloading" || current.phase === "checking" ? "failed" : current.phase,
      errorCode: "download_cancelled",
      errorMessage: "下载已取消",
      blocking: false,
      message: "下载已取消"
    }));
  }, []);

  const handleRetryRuntimeAssets = useCallback(() => {
    if (options.mirrorPrefixStorageKey) {
      localStorage.setItem(options.mirrorPrefixStorageKey, options.runtimeMirrorPrefix.trim());
    }
    void ensureRuntimeAssetsReady({
      source: "retry",
      interactive: true,
      blockConnection: true,
      forceCheck: true
    });
  }, [ensureRuntimeAssetsReady, options.mirrorPrefixStorageKey, options.runtimeMirrorPrefix]);

  return {
    runtimeAssets,
    setRuntimeAssets,
    runtimeAssetsReady,
    runtimeAssetsBusy,
    runtimeAssetsDialogOpened,
    setRuntimeAssetsDialogOpened,
    ensureRuntimeAssetsReady,
    getLastRuntimeAssetsCheckSummary,
    failRuntimeAssets,
    handleCancelRuntimeAssets,
    handleRetryRuntimeAssets
  };
}
