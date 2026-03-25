import { useCallback, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { GeneratedRuntimeConfigDto } from "@chordv/shared";
import {
  createIdleRuntimeStatus,
  disconnectRuntime,
  loadRuntimeLogs,
  loadRuntimeStatus,
  type RuntimeStatus
} from "../lib/runtime";

type UseRuntimeStatusOptions = {
  setRuntime: Dispatch<SetStateAction<GeneratedRuntimeConfigDto | null>>;
  leaseHeartbeatFailedAtRef: MutableRefObject<number | null>;
};

export function useRuntimeStatus(options: UseRuntimeStatusOptions) {
  const [desktopStatus, setDesktopStatus] = useState<RuntimeStatus>(createIdleRuntimeStatus());
  const [runtimeLog, setRuntimeLog] = useState("");
  const localStopInFlightRef = useRef<Promise<void> | null>(null);
  const runtimeRefreshRequestSeqRef = useRef(0);

  const refreshRuntime = useCallback(async () => {
    const requestId = runtimeRefreshRequestSeqRef.current + 1;
    runtimeRefreshRequestSeqRef.current = requestId;

    try {
      const [status, logs] = await Promise.all([loadRuntimeStatus(), loadRuntimeLogs()]);
      if (runtimeRefreshRequestSeqRef.current !== requestId) {
        return;
      }
      setDesktopStatus(status);
      if (!status.activeSessionId && status.status !== "connecting" && status.status !== "disconnecting") {
        options.setRuntime(null);
      }
      setRuntimeLog(logs.log);
    } catch {
      if (runtimeRefreshRequestSeqRef.current !== requestId) {
        return;
      }
      setDesktopStatus(createIdleRuntimeStatus());
      options.setRuntime(null);
      setRuntimeLog("");
    }
  }, [options]);

  const forceStopLocalRuntime = useCallback(async () => {
    if (localStopInFlightRef.current) {
      await localStopInFlightRef.current;
      return;
    }

    const task = (async () => {
      try {
        await disconnectRuntime();
      } catch {
        // 本地断开兜底不向外抛，避免阻断后续清理。
      } finally {
        options.leaseHeartbeatFailedAtRef.current = null;
        options.setRuntime(null);
        await refreshRuntime().catch(() => {
          setDesktopStatus(createIdleRuntimeStatus());
          setRuntimeLog("");
        });
      }
    })();

    localStopInFlightRef.current = task;
    try {
      await task;
    } finally {
      localStopInFlightRef.current = null;
    }
  }, [options, refreshRuntime]);

  return {
    desktopStatus,
    setDesktopStatus,
    runtimeLog,
    refreshRuntime,
    forceStopLocalRuntime
  };
}
