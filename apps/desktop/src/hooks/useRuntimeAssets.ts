import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchRuntimeComponentsPlan,
  isUnauthorizedApiError,
  reportRuntimeComponentFailure
} from "../api/client";
import {
  checkRuntimeComponentFile,
  downloadRuntimeComponent,
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
  type RuntimeDownloadFailureReason
} from "../lib/runtimeComponents";

type NoticeInput = {
  color: "green" | "yellow" | "red" | "blue";
  title: string;
  message: string;
};

type EnsureRuntimeAssetsOptions = {
  source: "startup" | "connect" | "retry";
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

export function useRuntimeAssets(options: UseRuntimeAssetsOptions) {
  const [runtimeAssets, setRuntimeAssets] = useState<RuntimeAssetsUiState>(createIdleRuntimeAssetsState);
  const [runtimeAssetsDialogOpened, setRuntimeAssetsDialogOpened] = useState(false);
  const runtimeAssetsTaskRef = useRef<Promise<boolean> | null>(null);

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

  const ensureRuntimeAssetsReady = useCallback(
    async (ensureOptions: EnsureRuntimeAssetsOptions) => {
      if (options.platformTarget === "android" || options.platformTarget === "web") {
        return true;
      }
      if (!ensureOptions.forceCheck && runtimeAssets.phase === "ready") {
        return true;
      }
      if (runtimeAssetsTaskRef.current) {
        return runtimeAssetsTaskRef.current;
      }

      const silentStartupCheck =
        ensureOptions.source === "startup" && !ensureOptions.interactive && !ensureOptions.blockConnection;

      const task = (async () => {
        if (!silentStartupCheck) {
          setRuntimeAssets((current) => ({
            ...current,
            phase: "checking",
            message: "正在检查必要内核组件，请稍候。",
            blocking: ensureOptions.blockConnection,
            errorCode: null,
            errorMessage: null
          }));
        }

        try {
          const environment = await loadDesktopRuntimeEnvironment().catch(() => null);
          const plan = await fetchRuntimeComponentsPlan({
            accessToken: options.accessToken ?? null,
            clientMirrorPrefix: options.runtimeMirrorPrefix
          });

          if (!plan || !plan.components.length) {
            return failRuntimeAssets(
              {
                code: "plan_missing",
                message: "服务端尚未配置必要内核组件，当前暂时不能连接。",
                component: "xray",
                effectiveUrl: null,
                platform: environment?.platform ?? resolveRuntimePlanPlatform(options.platformTarget),
                architecture: environment?.architecture ?? "arm64"
              },
              ensureOptions
            );
          }

          const pendingComponents = [];
          for (const component of plan.components) {
            const status = await checkRuntimeComponentFile(component).catch(() => null);
            if (!status?.ready) {
              pendingComponents.push(component);
            }
          }

          if (pendingComponents.length === 0) {
            setRuntimeAssets({
              phase: "ready",
              currentComponent: null,
              fileName: null,
              downloadedBytes: 0,
              totalBytes: null,
              message: "连接所需组件已准备完成。",
              errorCode: null,
              errorMessage: null,
              blocking: false
            });
            setRuntimeAssetsDialogOpened(false);
            return true;
          }

          for (const component of pendingComponents) {
            const candidate = resolveRuntimeComponentCandidate(component, options.runtimeMirrorPrefix);
            if (!candidate) {
              return failRuntimeAssets(
                {
                  code: "plan_missing",
                  message: `${component.displayName} 没有可用下载地址，当前暂时不能连接。`,
                  component: component.component,
                  effectiveUrl: null,
                  platform: plan.platform,
                  architecture: plan.architecture
                },
                ensureOptions,
                component.id
              );
            }

            setRuntimeAssets({
              phase: "downloading",
              currentComponent: component.component,
              fileName: component.fileName,
              downloadedBytes: 0,
              totalBytes: component.fileSizeBytes,
              message: `正在准备 ${component.displayName}，完成后即可继续连接。`,
              errorCode: null,
              errorMessage: null,
              blocking: true
            });

            try {
              await downloadRuntimeComponent({
                component,
                url: candidate.url
              });
            } catch (reason) {
              const rawMessage = reason instanceof Error ? reason.message : String(reason);
              return failRuntimeAssets(
                {
                  code: extractRuntimeAssetsErrorCode(rawMessage),
                  message: stripRuntimeAssetsErrorPrefix(rawMessage),
                  component: component.component,
                  effectiveUrl: candidate.url,
                  platform: plan.platform,
                  architecture: plan.architecture
                },
                ensureOptions,
                component.id
              );
            }
          }

          setRuntimeAssets({
            phase: "completed",
            currentComponent: null,
            fileName: null,
            downloadedBytes: pendingComponents
              .reduce((total, component) => total + (component.fileSizeBytes ?? 0), 0),
            totalBytes: pendingComponents
              .reduce((total, component) => total + (component.fileSizeBytes ?? 0), 0),
            message: "连接所需组件已准备完成，即将继续连接。",
            errorCode: null,
            errorMessage: null,
            blocking: false
          });
          await new Promise((resolve) => window.setTimeout(resolve, 900));
          setRuntimeAssets({
            phase: "ready",
            currentComponent: null,
            fileName: null,
            downloadedBytes: 0,
            totalBytes: null,
            message: "连接所需组件已准备完成。",
            errorCode: null,
            errorMessage: null,
            blocking: false
          });
          setRuntimeAssetsDialogOpened(false);
          options.notify?.({
            color: "green",
            title: "必要内核组件已准备完成",
            message: "现在可以开始连接了。"
          });
          return true;
        } catch (reason) {
          if (isUnauthorizedApiError(reason)) {
            await options.onUnauthorized?.();
            return false;
          }
          const rawMessage = reason instanceof Error ? reason.message : "必要内核组件下载失败";
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
    [failRuntimeAssets, options, runtimeAssets.currentComponent, runtimeAssets.phase]
  );

  const handleRetryRuntimeAssets = useCallback(() => {
    if (options.mirrorPrefixStorageKey) {
      localStorage.setItem(options.mirrorPrefixStorageKey, options.runtimeMirrorPrefix.trim());
    }
    void ensureRuntimeAssetsReady({
      source: "retry",
      interactive: true,
      blockConnection: true
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
    failRuntimeAssets,
    handleRetryRuntimeAssets
  };
}
