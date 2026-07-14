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

  const refreshRuntime = useCallback(async (optionsInput?: { includeLogs?: boolean }) => {
    const requestId = runtimeRefreshRequestSeqRef.current + 1;
    runtimeRefreshRequestSeqRef.current = requestId;
    const includeLogs = optionsInput?.includeLogs ?? true;

    try {
      const status = await loadRuntimeStatus();
      if (runtimeRefreshRequestSeqRef.current !== requestId) {
        return null;
      }
      setDesktopStatus(status);
      if (!status.activeSessionId && status.status !== "connecting" && status.status !== "disconnecting") {
        options.setRuntime(null);
      }
      // 空闲态不必每次读日志文件；有活跃会话/连接中才拉日志，降低同步 IPC 压力。
      const shouldLoadLogs =
        includeLogs &&
        (Boolean(status.activeSessionId) ||
          status.status === "connecting" ||
          status.status === "connected" ||
          status.status === "disconnecting" ||
          Boolean(status.lastError));
      if (shouldLoadLogs) {
        const logs = await loadRuntimeLogs();
        if (runtimeRefreshRequestSeqRef.current !== requestId) {
          return null;
        }
        setRuntimeLog(logs.log);
      }
      return status;
    } catch {
      if (runtimeRefreshRequestSeqRef.current !== requestId) {
        return null;
      }
      const idleStatus = createIdleRuntimeStatus();
      setDesktopStatus(idleStatus);
      options.setRuntime(null);
      setRuntimeLog("");
      return idleStatus;
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
