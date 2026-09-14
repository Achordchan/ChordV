import { isSuccessfulComponentSync } from "../lib/runtimeAssetsState";
import type { RuntimeAssetsCheckSummary } from "./useRuntimeAssets";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientRuntimeEventDto } from "@chordv/shared";
import { loadRuntimeStatus, type RuntimeStatus } from "../lib/runtime";

function runtimeInUse(status: RuntimeStatus) {
  return Boolean(status.activePid || status.activeSessionId || status.tunName)
    || ["connected", "connecting", "starting", "disconnecting"].includes(status.status);
}

type Options = {
  enabled: boolean;
  accessToken: string | null;
  status: RuntimeStatus;
  assetsBusy: boolean;
  applicationUpdateBusy: boolean;
  ensure: (options: {source:"update_check";interactive:boolean;blockConnection:boolean;forceCheck:boolean;inspectOnly:boolean}) => Promise<boolean>;
  onStatus: (status: RuntimeStatus) => void;
};

/** Events invalidate a desired-state snapshot, not individual download jobs.
 * At most one follow-up runs after an in-flight check, always reading the latest
 * server plan. Active connections keep their running files until disconnected. */
export function useComponentVersionSync(options: Options) {
  const current = useRef(options); current.current = options;
  const alive = useRef(true), completed = useRef(0), running = useRef(false);
  const sessionEpoch = useRef(0);
  const [requested, setRequested] = useState(0), [settled, setSettled] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; sessionEpoch.current++; }; }, []);
  useEffect(() => {
    sessionEpoch.current++;
    setSyncError(null);
    if (options.accessToken) setRequested(value => value + 1);
  }, [options.accessToken]);
  const requestSync = useCallback((event?: ClientRuntimeEventDto) => {
    const value = current.current;
    if (!value.accessToken || !["macos", "windows"].includes(value.status.platformTarget)) return;
    if (event?.platform && event.platform !== value.status.platformTarget) return;
    setRequested(count => count + 1);
  }, []);
  const reportManualSyncResult = useCallback((token: string | null, success: boolean, summary: RuntimeAssetsCheckSummary | null) => {
    if (alive.current && token === current.current.accessToken && isSuccessfulComponentSync(success, summary)) setSyncError(null);
  }, []);
  const blocked = !options.enabled || runtimeInUse(options.status) || options.assetsBusy || options.applicationUpdateBusy;
  // Legacy upstream latest URLs have no ChordV event publisher. A 12-hour
  // check uses the same single-flight, idle-only path and ends with the session.
  useEffect(() => {
    if (!options.accessToken || !["macos", "windows"].includes(options.status.platformTarget)) return;
    const timer = window.setInterval(() => requestSync(), 12 * 60 * 60_000);
    return () => window.clearInterval(timer);
  }, [options.accessToken, options.status.platformTarget, requestSync]);
  useEffect(() => {
    if (!options.accessToken || !["macos", "windows"].includes(options.status.platformTarget)
      || blocked || running.current || requested <= completed.current) return;
    const epoch = sessionEpoch.current, target = requested;
    running.current = true; setProcessing(true); setSyncError(null);
    void (async () => {
      try {
        // Re-read native state: a tray action can run ahead of React's snapshot.
        const native = await loadRuntimeStatus();
        if (!alive.current || epoch !== sessionEpoch.current) return;
        if (runtimeInUse(native)) { current.current.onStatus(native); return; }
        const success = await current.current.ensure({ source:"update_check", interactive:false, blockConnection:false, forceCheck:true, inspectOnly:false });
        if (alive.current && epoch === sessionEpoch.current) {
          completed.current = target; setSettled(target);
          if (!success) setSyncError("组件暂未同步，可在更新中心查看原因并重试。");
        }
      } catch {
        if (alive.current && epoch === sessionEpoch.current) {
          completed.current = target; setSettled(target);
          setSyncError("暂时无法检查组件，可在更新中心重试。");
        }
      } finally {
        running.current = false;
        if (alive.current) setProcessing(false);
      }
    })();
  }, [requested, blocked, options.accessToken, options.status.platformTarget, processing]);
  return { requestSync, reportManualSyncResult, syncError, deferred: Boolean(options.accessToken) && requested > settled && runtimeInUse(options.status) };
}
