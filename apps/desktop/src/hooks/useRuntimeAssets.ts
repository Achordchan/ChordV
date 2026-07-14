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
  isInstalledGeoTagCurrent,
  isLocalGeoCurrent,
  parseGithubReleasePayload,
  clearStoredGeoInstalledTag,
  clearStoredGeoLastCheckAt,
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
  basenamePath,
  buildXrayInstalledIdentityFromPlan,
  clearStoredXrayInstalledIdentity,
  isXrayIdentityCurrent,
  readStoredXrayInstalledIdentity,
  resolveXrayVersionLabel,
  writeStoredXrayInstalledIdentity
} from "../lib/xrayInstall";
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
  xray: {
    localVersion: string | null;
    remoteVersion: string | null;
    current: boolean;
    available: boolean;
    message: string;
  };
  geo: {
    localVersion: string | null;
    remoteVersion: string | null;
    current: boolean;
    available: boolean;
    message: string;
  };
};

type EnsureRuntimeAssetsOptions = {
  source: "startup" | "connect" | "retry" | "update_check";
  interactive: boolean;
  blockConnection: boolean;
  forceCheck?: boolean;
  /** 仅检查版本，不下载 */
  inspectOnly?: boolean;
  /** 指定更新目标；默认全部 */
  targets?: Array<"xray" | "geo">;
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


async function refreshLocalRuntimeInfos() {
  const localExists = await Promise.all([
    getRuntimeComponentLocalInfo("xray").catch(() => null),
    getRuntimeComponentLocalInfo("geoip").catch(() => null),
    getRuntimeComponentLocalInfo("geosite").catch(() => null)
  ]);
  return {
    xray: localExists[0],
    geoip: localExists[1],
    geosite: localExists[2]
  };
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
    releaseTag: null,
    xray: {
      localVersion: null,
      remoteVersion: null,
      current: true,
      available: false,
      message: "尚未检查"
    },
    geo: {
      localVersion: null,
      remoteVersion: null,
      current: true,
      available: false,
      message: "尚未检查"
    }
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

  const runtimeAssetsReady = useMemo(() => {
    if (options.platformTarget === "android" || options.platformTarget === "web") {
      return true;
    }
    // idle 也允许点连接：真正缺组件时由连接流程 ensure；failed/checking/downloading 才灰掉。
    return (
      runtimeAssets.phase === "ready" ||
      runtimeAssets.phase === "idle" ||
      runtimeAssets.phase === "completed"
    );
  }, [options.platformTarget, runtimeAssets.phase]);

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

  const fetchFirstRemoteText = useCallback(async (urls: string[]) => {
    if (!urls.length) {
      return null;
    }
    type RemoteTextResult = Awaited<ReturnType<typeof fetchRemoteText>>;
    // 多镜像并行竞速，谁先返回有效内容用谁（含加速域名）
    return await new Promise<RemoteTextResult | null>((resolve) => {
      let pending = urls.length;
      let settled = false;
      for (const url of urls) {
        void fetchRemoteText(url)
          .then((response) => {
            if (settled) {
              return;
            }
            if (response?.body) {
              settled = true;
              resolve(response);
              return;
            }
            pending -= 1;
            if (pending <= 0) {
              resolve(null);
            }
          })
          .catch(() => {
            if (settled) {
              return;
            }
            pending -= 1;
            if (pending <= 0) {
              resolve(null);
            }
          });
      }
    });
  }, []);

  const loadGeoReleaseMeta = useCallback(async () => {
    const releaseApi = buildGithubReleaseLatestApiUrl();
    const response = await fetchFirstRemoteText([
      `https://ghfast.top/${releaseApi}`,
      `https://mirror.ghproxy.com/${releaseApi}`,
      releaseApi
    ]);
    if (!response?.body) {
      return null;
    }
    return parseGithubReleasePayload(response.body);
  }, [fetchFirstRemoteText]);


  const loadGeoRemotePlan = useCallback(async (): Promise<GeoRemotePlan | null> => {
    const release = await loadGeoReleaseMeta();
    if (!release) {
      return null;
    }
    return buildGeoRemoteAssetsFromRelease(release);
  }, [loadGeoReleaseMeta]);


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
        lastSummaryRef.current = emptySummary();
        lastSummaryRef.current.checked = true;
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

      // 本地已就绪时，版本巡检默认静默；只有缺件/下载/连接阻塞才展示横幅
      const preferSilentUi =
        (ensureOptions.source === "startup" || ensureOptions.source === "update_check") &&
        !ensureOptions.blockConnection;

      const task = (async () => {
        cancelRequestedRef.current = false;
        const summary: RuntimeAssetsCheckSummary = {
          checked: true,
          updated: [],
          failed: [],
          current: true,
          releaseTag: null,
          xray: {
            localVersion: null,
            remoteVersion: null,
            current: true,
            available: false,
            message: "本地已就绪"
          },
          geo: {
            localVersion: readStoredGeoInstalledTag(),
            remoteVersion: null,
            current: true,
            available: false,
            message: "本地已就绪"
          }
        };
        const targetSet = new Set(ensureOptions.targets?.length ? ensureOptions.targets : ["xray", "geo"]);
        const inspectOnly = Boolean(ensureOptions.inspectOnly);
        let silentBackground = preferSilentUi && !ensureOptions.interactive;

        const showCheckingBanner = (message: string) => {
          if (silentBackground) {
            return;
          }
          setRuntimeAssets((current) => ({
            ...current,
            phase: "checking",
            message,
            blocking: ensureOptions.blockConnection,
            errorCode: null,
            errorMessage: null
          }));
        };

        try {
          const environment = await loadDesktopRuntimeEnvironment().catch(() => null);
          const platform = environment?.platform ?? resolveRuntimePlanPlatform(options.platformTarget);
          const architecture = environment?.architecture ?? "arm64";

          // 先快速确认本地文件是否存在，避免一上来就做大文件 sha256
                    // 启动/静默巡检：只查本地存在性，不触发 bundle 复制（大文件 sha256 会卡 UI）。
          // 连接/重试/强制检查时才 ensure 内置组件。
          const needsBundleEnsure =
            !inspectOnly ||
            ensureOptions.blockConnection ||
            ensureOptions.interactive ||
            ensureOptions.forceCheck ||
            ensureOptions.source === "connect" ||
            ensureOptions.source === "retry";
          let localExists = await Promise.all([
            getRuntimeComponentLocalInfo("xray").catch(() => null),
            getRuntimeComponentLocalInfo("geoip").catch(() => null),
            getRuntimeComponentLocalInfo("geosite").catch(() => null)
          ]);
          let bundled: Awaited<ReturnType<typeof ensureBundledRuntimeComponents>> = null;
          if (needsBundleEnsure) {
            bundled = await ensureBundledRuntimeComponents().catch(() => null);
            // 内置包是打包时的旧 GEO；一旦从 bundle 回填，必须清掉“远端已最新”标记。
            const copied = bundled?.copiedComponents ?? [];
            if (copied.some((name) => name === "geoip" || name === "geosite")) {
              clearStoredGeoInstalledTag();
              clearStoredGeoLastCheckAt();
            }
            if (copied.some((name) => name === "xray")) {
              clearStoredXrayInstalledIdentity();
            }
            // 回填后重新读取本地大小，避免沿用删除前的空状态或旧缓存。
            localExists = await Promise.all([
              getRuntimeComponentLocalInfo("xray").catch(() => null),
              getRuntimeComponentLocalInfo("geoip").catch(() => null),
              getRuntimeComponentLocalInfo("geosite").catch(() => null)
            ]);
          }

          let localInfos = {
            xray: localExists[0],
            geoip: localExists[1],
            geosite: localExists[2]
          };
          const localFilesReady = Boolean(
            localInfos.xray?.exists &&
              (localInfos.xray.sizeBytes ?? 0) > 0 &&
              localInfos.geoip?.exists &&
              (localInfos.geoip.sizeBytes ?? 0) > 0 &&
              localInfos.geosite?.exists &&
              (localInfos.geosite.sizeBytes ?? 0) > 0
          );
          const localReady = Boolean(bundled?.ready || localFilesReady);

          // 启动空闲巡检：本地已齐且未到 GEO 远端检查周期时直接返回，不打远程、不复制 bundle。
          if (
            inspectOnly &&
            preferSilentUi &&
            !ensureOptions.forceCheck &&
            localReady &&
            !shouldCheckGeoUpdate(readStoredGeoLastCheckAt())
          ) {
            summary.xray.localVersion = localInfos.xray?.exists
              ? (readStoredXrayInstalledIdentity()?.versionLabel
                ?? resolveXrayVersionLabel({
                  fileName: basenamePath(localInfos.xray.path, "xray"),
                  checksumSha256: localInfos.xray.checksumSha256
                }))
              : null;
            summary.geo.localVersion = readStoredGeoInstalledTag() ?? (localInfos.geoip?.exists ? "已安装" : null);
            summary.xray.current = Boolean(localInfos.xray?.exists);
            summary.geo.current = Boolean(localInfos.geoip?.exists && localInfos.geosite?.exists);
            summary.current = summary.xray.current && summary.geo.current;
            summary.xray.message = summary.xray.current ? "本地已就绪" : "本地缺少 Xray";
            summary.geo.message = summary.geo.current ? "本地已就绪" : "本地缺少 GEO 数据";
            lastSummaryRef.current = summary;
            // 本地已齐必须立刻置 ready，否则连接按钮会一直灰。
            markReady(summary.current ? "核心组件已就绪。" : "核心组件待补齐。");
            return true;
          }


          // 本地已齐：手动检测更新也先静默比对版本，只有需要下载时再显示横幅
          if (preferSilentUi && localReady) {
            silentBackground = true;
          } else if (!silentBackground) {
            showCheckingBanner("正在检查必要核心组件，请稍候。");
          }

          summary.xray.localVersion = localInfos.xray?.exists
              ? (readStoredXrayInstalledIdentity()?.versionLabel
                ?? resolveXrayVersionLabel({
                  fileName: basenamePath(localInfos.xray.path, "xray"),
                  checksumSha256: localInfos.xray.checksumSha256
                }))
              : null;
          summary.geo.localVersion = readStoredGeoInstalledTag() ?? (localInfos.geoip?.exists ? "已安装" : null);
          if (!localInfos.xray?.exists) {
            summary.xray.current = false;
            summary.xray.message = "本地缺少 Xray";
          }
          if (!localInfos.geoip?.exists || !localInfos.geosite?.exists) {
            summary.geo.current = false;
            summary.geo.message = "本地缺少 GEO 数据";
          }

          // 启动空闲巡检只确认本地是否就位；远端版本留给手动检测更新 / 半天周期任务。
          const shouldRefreshRemote =
            ensureOptions.forceCheck ||
            ensureOptions.source === "retry" ||
            (ensureOptions.source !== "startup" && shouldCheckGeoUpdate(readStoredGeoLastCheckAt()));

          // Missing local files: fall back to server plan for first install.
          // 仅检查模式不在这里直接下载，先进入版本检查结果。
          if (!localReady && !inspectOnly) {
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
                continue;
              }
              // Xray readiness alone is not version identity; refresh when installed plan identity is missing/mismatched.
              if (component.component === "xray") {
                const identityCurrent = isXrayIdentityCurrent(
                  readStoredXrayInstalledIdentity(),
                  component,
                  localInfos.xray?.sizeBytes ?? null
                );
                if (!identityCurrent) {
                  pendingComponents.push(component);
                }
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
                if (component.component === "xray") {
                  localInfos = await refreshLocalRuntimeInfos();
                  writeStoredXrayInstalledIdentity(
                    buildXrayInstalledIdentityFromPlan(component, localInfos.xray?.sizeBytes ?? null)
                  );
                }
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

            let sharedPlan: Awaited<ReturnType<typeof fetchRuntimeComponentsPlan>> = null;
            try {
              const [mirrorPlan, releaseMeta] = await Promise.all([
                targetSet.has("xray") || targetSet.has("geo")
                  ? fetchRuntimeComponentsPlan({
                      accessToken: options.accessToken ?? null,
                      clientMirrorPrefix: options.runtimeMirrorPrefix
                    }).catch(() => null)
                  : Promise.resolve(null),
                targetSet.has("geo") ? loadGeoReleaseMeta() : Promise.resolve(null)
              ]);
              sharedPlan = mirrorPlan;
              const serverMirrorPrefixes = collectServerMirrorPrefixes(mirrorPlan);
              const installedGeoTag = readStoredGeoInstalledTag();
              const localGeoReady = Boolean(
                localInfos.geoip?.exists &&
                  (localInfos.geoip.sizeBytes ?? 0) > 0 &&
                  localInfos.geosite?.exists &&
                  (localInfos.geosite.sizeBytes ?? 0) > 0
              );

              if (targetSet.has("geo")) {
                if (!releaseMeta) {
                  summary.failed.push("GEO 数据源");
                  summary.geo.current = false;
                  summary.geo.available = false;
                  summary.geo.message = "GEO 数据源不可用";
                } else {
                  const remoteGeoip = releaseMeta.assets.find((asset) => asset.name === "geoip.dat");
                  const remoteGeosite = releaseMeta.assets.find((asset) => asset.name === "geosite.dat");
                  const sizesMatchRemote =
                    localGeoReady &&
                    Boolean(remoteGeoip?.size) &&
                    Boolean(remoteGeosite?.size) &&
                    localInfos.geoip?.sizeBytes === remoteGeoip?.size &&
                    localInfos.geosite?.sizeBytes === remoteGeosite?.size;

                  // 标签只是缓存：必须本地文件大小也与远端一致，才能跳过下载。
                  if (isInstalledGeoTagCurrent(installedGeoTag, releaseMeta.tag) && sizesMatchRemote) {
                    summary.releaseTag = releaseMeta.tag;
                    summary.geo.localVersion = releaseMeta.tag;
                    summary.geo.remoteVersion = releaseMeta.tag;
                    summary.geo.current = true;
                    summary.geo.available = false;
                    summary.geo.message = `GEO ${releaseMeta.tag} 已是最新版本。`;
                    writeStoredGeoInstalledTag(releaseMeta.tag);
                  } else {
                    if (installedGeoTag && !sizesMatchRemote) {
                      clearStoredGeoInstalledTag();
                    }

                    const geoPlan = buildGeoRemoteAssetsFromRelease(releaseMeta);
                    if (!geoPlan) {
                      summary.failed.push("GEO 数据源");
                      summary.geo.current = false;
                      summary.geo.available = false;
                      summary.geo.message = "GEO 数据源不可用";
                    } else {
                      summary.releaseTag = geoPlan.releaseTag;
                      summary.geo.remoteVersion = geoPlan.releaseTag;
                      // localVersion 在确认文件是否与远端一致后再写，避免缓存 tag 误导 UI

                      const geoNeedsUpdate = geoPlan.assets.some((asset) => {
                        const local = localInfos[asset.kind] as RuntimeComponentLocalInfo | null;
                        return !isLocalGeoCurrent(local, asset);
                      });

                      if (!geoNeedsUpdate) {
                        summary.geo.current = true;
                        summary.geo.available = false;
                        summary.geo.localVersion = geoPlan.releaseTag;
                        summary.geo.message = `GEO ${geoPlan.releaseTag} 已是最新版本。`;
                        writeStoredGeoInstalledTag(geoPlan.releaseTag);
                      } else if (inspectOnly) {
                        summary.geo.current = false;
                        summary.geo.available = true;
                        // 本地版本不能再显示成远端 tag，否则会出现“可更新但本地=远端”
                        summary.geo.localVersion = localGeoReady
                          ? (isInstalledGeoTagCurrent(installedGeoTag, geoPlan.releaseTag)
                              ? "本地文件过旧"
                              : (installedGeoTag ?? "已安装(未同步)"))
                          : "未安装";
                        summary.geo.remoteVersion = geoPlan.releaseTag;
                        summary.geo.message = localGeoReady
                          ? `本地文件与远端不一致，可更新至 ${geoPlan.releaseTag}`
                          : `有新版本可用：${geoPlan.releaseTag}`;
                        summary.current = false;
                      } else {
                        for (const asset of geoPlan.assets) {
                          const local = localInfos[asset.kind] as RuntimeComponentLocalInfo | null;
                          if (isLocalGeoCurrent(local, asset)) {
                            continue;
                          }
                          silentBackground = false;
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
                              checksumSha256: null
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

                        const bothCurrent =
                          isLocalGeoCurrent(localInfos.geoip, geoPlan.assets[0]) &&
                          isLocalGeoCurrent(localInfos.geosite, geoPlan.assets[1]);
                        if (bothCurrent) {
                          writeStoredGeoInstalledTag(geoPlan.releaseTag);
                          summary.geo.localVersion = geoPlan.releaseTag;
                          summary.geo.remoteVersion = geoPlan.releaseTag;
                          summary.geo.current = true;
                          summary.geo.available = false;
                          summary.geo.message = summary.updated.some((name) => /geo/i.test(name))
                            ? `GEO 已更新到 ${geoPlan.releaseTag}`
                            : `GEO ${geoPlan.releaseTag} 已是最新版本。`;
                        } else if (summary.updated.some((name) => /geo/i.test(name))) {
                          summary.geo.localVersion = geoPlan.releaseTag;
                          summary.geo.remoteVersion = geoPlan.releaseTag;
                          summary.geo.current = false;
                          summary.geo.available = true;
                          summary.geo.message = `GEO 部分更新失败，远端 ${geoPlan.releaseTag}`;
                        } else {
                          summary.geo.localVersion = readStoredGeoInstalledTag() ?? summary.geo.localVersion;
                          summary.geo.remoteVersion = geoPlan.releaseTag;
                          summary.geo.current = false;
                          summary.geo.available = true;
                          summary.geo.message = `有新版本可用：${geoPlan.releaseTag}`;
                        }
                      }
                    }
                  }
                }
              }
            } catch {
              summary.failed.push("GEO 数据源");
              summary.geo.current = false;
              summary.geo.available = false;
              summary.geo.message = "GEO 数据源检查失败";
            }

            // xray remains server-managed; refresh when plan hash differs.
            if (targetSet.has("xray")) {
              try {
                const plan =
                  sharedPlan ??
                  (await fetchRuntimeComponentsPlan({
                    accessToken: options.accessToken ?? null,
                    clientMirrorPrefix: options.runtimeMirrorPrefix
                  }));
                const xrayItem = plan?.components.find((item) => item.component === "xray") ?? null;
                if (xrayItem) {
                  const remoteLabel = resolveXrayVersionLabel(xrayItem);
                  summary.xray.remoteVersion = remoteLabel;
                  const installedIdentity = readStoredXrayInstalledIdentity();
                  if (!summary.xray.localVersion) {
                    summary.xray.localVersion =
                      installedIdentity?.versionLabel
                      ?? (localInfos.xray?.exists
                        ? resolveXrayVersionLabel({
                            fileName: basenamePath(localInfos.xray.path, "xray"),
                            checksumSha256: localInfos.xray.checksumSha256
                          })
                        : null);
                  }
                  const status = await checkRuntimeComponentFile(xrayItem).catch(() => null);
                  const identityCurrent = isXrayIdentityCurrent(
                    installedIdentity,
                    xrayItem,
                    localInfos.xray?.sizeBytes ?? null
                  );
                  if (status?.ready && identityCurrent) {
                    summary.xray.current = true;
                    summary.xray.available = false;
                    summary.xray.message = remoteLabel
                      ? `Xray ${remoteLabel} 已是最新版本。`
                      : "Xray 已是最新版本。";
                  } else if (inspectOnly) {
                    summary.xray.current = false;
                    summary.xray.available = true;
                    summary.xray.message = remoteLabel
                      ? `有新版本可用：${remoteLabel}`
                      : "检测到 Xray 可更新";
                    summary.current = false;
                  } else {
                    const candidate = resolveRuntimeComponentCandidate(xrayItem, options.runtimeMirrorPrefix);
                    silentBackground = false;
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
                      localInfos = await refreshLocalRuntimeInfos();
                      summary.updated.push(xrayItem.displayName);
                      summary.current = false;
                      summary.xray.current = true;
                      summary.xray.available = false;
                      summary.xray.localVersion = remoteLabel;
                      writeStoredXrayInstalledIdentity(
                        buildXrayInstalledIdentityFromPlan(xrayItem, localInfos.xray?.sizeBytes ?? null)
                      );
                      summary.xray.remoteVersion = remoteLabel;
                      summary.xray.message = remoteLabel
                        ? `Xray 已更新到 ${remoteLabel}`
                        : "Xray 已更新";
                    } catch (reason) {
                      const message = reason instanceof Error ? reason.message : String(reason);
                      summary.failed.push(xrayItem.displayName);
                      summary.current = false;
                      summary.xray.current = Boolean(localInfos.xray?.exists);
                      summary.xray.available = true;
                      summary.xray.message = "Xray 更新失败";
                      if (!localInfos.xray?.exists && ensureOptions.blockConnection) {
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
                } else {
                  summary.xray.message = localInfos.xray?.exists ? "服务端未配置 Xray 组件" : "本地缺少 Xray";
                  summary.xray.current = Boolean(localInfos.xray?.exists);
                  summary.xray.available = false;
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
                summary.xray.current = Boolean(localInfos.xray?.exists);
                summary.xray.available = false;
                summary.xray.message = localInfos.xray?.exists ? "Xray 检查失败，继续使用本地文件" : "Xray 检查失败";
              }
            }
          }

          if (inspectOnly) {
            summary.current = !summary.xray.available && !summary.geo.available;
            lastSummaryRef.current = summary;
            // 静默巡检也要置 ready，避免启动后连接按钮长期灰色。
            markReady(summary.current ? "核心组件已就绪。" : "组件版本检查完成。");
            return true;
          }

          // Downloads may have completed after the pre-download snapshot; re-read disk before final readiness.
          if (summary.updated.length > 0) {
            localInfos = await refreshLocalRuntimeInfos();
          }
          const finalLocalReady = Boolean(
            localInfos.xray?.exists &&
              (localInfos.xray.sizeBytes ?? 0) > 0 &&
              localInfos.geoip?.exists &&
              (localInfos.geoip.sizeBytes ?? 0) > 0 &&
              localInfos.geosite?.exists &&
              (localInfos.geosite.sizeBytes ?? 0) > 0
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
      loadGeoReleaseMeta,
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
      if (!shouldCheckGeoUpdate(readStoredGeoLastCheckAt())) {
        return;
      }
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
