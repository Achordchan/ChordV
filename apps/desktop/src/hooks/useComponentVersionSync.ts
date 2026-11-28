import { isSuccessfulComponentSync } from "../lib/runtimeAssetsState";
import type { RuntimeAssetsCheckSummary } from "./useRuntimeAssets";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientRuntimeEventDto } from "@chordv/shared";
import { loadRuntimeStatus, type RuntimeStatus } from "../lib/runtime";
import { readGitHubReleaseConfiguration } from "../lib/githubReleases";
import { createComponentSyncLoop, componentRuntimeInUse, type ComponentSyncState } from "../lib/componentSyncLoop";

type Options = {
  enabled: boolean;
  accessToken: string | null;
  status: RuntimeStatus;
  assetsBusy: boolean;
  applicationUpdateBusy: boolean;
  ensure: (options: {source:"update_check";interactive:boolean;blockConnection:boolean;forceCheck:boolean;inspectOnly:boolean}) => Promise<boolean>;
  onStatus: (status: RuntimeStatus) => void;
};

/** GitHub 无客户端 SSE/WebSocket：正常每 12 小时检查，事件至少间隔 30 秒；
 * 失败按 5/10/20/40/60 分钟退避。隐藏、忙碌或连接中暂停，登出/卸载清理。
 * 未配置仓库时不启动远端巡检；本地组件事实检查仍由 App 独立执行。 */
export function useComponentVersionSync(options: Options) {
  const current = useRef(options); current.current = options;
  const loop = useRef<ReturnType<typeof createComponentSyncLoop> | null>(null);
  const [state, setState] = useState<ComponentSyncState>({ syncError: null, deferred: false });
  useEffect(() => {
    const active = createComponentSyncLoop({
      context: () => {
        const value = current.current;
        return { accessToken: value.accessToken, platform: value.status.platformTarget, enabled: value.enabled,
          blocked: value.assetsBusy || value.applicationUpdateBusy, inUse: componentRuntimeInUse(value.status),
          visible: document.visibilityState !== "hidden" };
      },
      configured: () => { try { readGitHubReleaseConfiguration(); return true; } catch { return false; } },
      loadStatus: loadRuntimeStatus,
      onStatus: status => current.current.onStatus(status),
      ensure: () => current.current.ensure({ source: "update_check", interactive: false, blockConnection: false, forceCheck: true, inspectOnly: false }),
      onState: setState, now: () => Date.now(),
      setTimeout: (callback, delay) => window.setTimeout(callback, delay),
      clearTimeout: handle => window.clearTimeout(handle as number)
    });
    loop.current = active; active.update();
    const resume = () => { if (document.visibilityState === "hidden") active.update(); else active.request(); };
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      active.stop(); if (loop.current === active) loop.current = null;
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, []);
  useEffect(() => { loop.current?.update(); }, [options.accessToken, options.enabled, options.assetsBusy, options.applicationUpdateBusy,
    options.status.platformTarget, options.status.status, options.status.activePid, options.status.activeSessionId, options.status.tunName]);
  const requestSync = useCallback((event?: ClientRuntimeEventDto) => {
    const value = current.current;
    if (!value.accessToken || !["macos", "windows"].includes(value.status.platformTarget)) return;
    if (event?.platform && event.platform !== value.status.platformTarget) return;
    loop.current?.request();
  }, []);
  const reportManualSyncResult = useCallback((token: string | null, success: boolean, summary: RuntimeAssetsCheckSummary | null) => {
    if (token === current.current.accessToken && isSuccessfulComponentSync(success, summary)) loop.current?.manualSuccess();
  }, []);
  return { requestSync, reportManualSyncResult, ...state };
}
