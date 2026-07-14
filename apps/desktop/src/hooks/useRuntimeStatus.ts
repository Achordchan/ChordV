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
  const setRuntimeRef = useRef(options.setRuntime);
  const leaseFailedAtRef = useRef(options.leaseHeartbeatFailedAtRef);

  setRuntimeRef.current = options.setRuntime;
  leaseFailedAtRef.current = options.leaseHeartbeatFailedAtRef;

  const refreshRuntime = useCallback(async (optionsInput?: { includeLogs?: boolean }) => {
    const requestId = runtimeRefreshRequestSeqRef.current + 1;
    runtimeRefreshRequestSeqRef.current = requestId;
    // Keep logs off by default so the 5s poll does not push large text into React state.
    const includeLogs = optionsInput?.includeLogs ?? false;

    try {
      const status = await loadRuntimeStatus();
      if (runtimeRefreshRequestSeqRef.current !== requestId) {
        return null;
      }
      setDesktopStatus((current) => {
        if (
          current.status === status.status &&
          current.activeSessionId === status.activeSessionId &&
          current.activePid === status.activePid &&
          current.activeNodeId === status.activeNodeId &&
          current.lastError === status.lastError &&
          current.configPath === status.configPath &&
          current.logPath === status.logPath &&
          current.xrayBinaryPath === status.xrayBinaryPath &&
          current.tunName === status.tunName &&
          current.lastStartedAt === status.lastStartedAt &&
          current.reasonCode === status.reasonCode &&
          current.recoveryHint === status.recoveryHint &&
          current.vpnActive === status.vpnActive &&
          current.connectivityVerified === status.connectivityVerified &&
          current.platformTarget === status.platformTarget
        ) {
          return current;
        }
        return status;
      });
      if (!status.activeSessionId && status.status !== "connecting" && status.status !== "disconnecting") {
        setRuntimeRef.current(null);
      }
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
        setRuntimeLog((current) => (current === logs.log ? current : logs.log));
      }
      return status;
    } catch {
      if (runtimeRefreshRequestSeqRef.current !== requestId) {
        return null;
      }
      const idleStatus = createIdleRuntimeStatus();
      setDesktopStatus(idleStatus);
      setRuntimeRef.current(null);
      setRuntimeLog("");
      return idleStatus;
    }
  }, []);

  const forceStopLocalRuntime = useCallback(async () => {
    if (localStopInFlightRef.current) {
      await localStopInFlightRef.current;
      return;
    }

    const task = (async () => {
      try {
        await disconnectRuntime();
      } catch {
        // Best-effort local disconnect must not block later cleanup.
      } finally {
        leaseFailedAtRef.current.current = null;
        setRuntimeRef.current(null);
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
  }, [refreshRuntime]);

  return {
    desktopStatus,
    setDesktopStatus,
    runtimeLog,
    refreshRuntime,
    forceStopLocalRuntime
  };
}