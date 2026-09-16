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
      if (!status.activeSessionId && status.status !== "starting" && status.status !== "connecting" && status.status !== "disconnecting") {
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
      // A failed status read does not prove that the native proxy has stopped.
      setDesktopStatus(current=>({...current,lastError:"暂时无法读取本机运行状态，请重试。"}));
      return null;
    }
  }, []);

  const forceStopLocalRuntime = useCallback(async () => {
    if (localStopInFlightRef.current) {
      await localStopInFlightRef.current;
      return;
    }

    const task = (async () => {
      let failure: Error | null = null;
      try {
        const result=await disconnectRuntime();
        if(result && typeof result === "object" && "ok" in result && result.ok === false) {
          throw new Error("本机连接停止失败，请重试。");
        }
      } catch (reason) { failure=reason instanceof Error?reason:new Error(String(reason||"本机连接停止失败，请重试。")); }
      // Confirmation is an independent native read; normal UI refresh sequencing
      // may supersede rendering but cannot invalidate this operation's evidence.
      let status: RuntimeStatus | null = null;
      try { status=await loadRuntimeStatus(); } catch { /* Report lack of confirmation below. */ }
      void refreshRuntime();
      if(failure) throw failure;
      if(!status) throw new Error("无法确认本机连接已停止，请重试。");
      if(status.activePid || status.activeSessionId || status.vpnActive || ["starting","connecting","connected","disconnecting"].includes(status.status)) {
        throw new Error("本机连接尚未停止，请重试。");
      }
      leaseFailedAtRef.current.current = null;
      setRuntimeRef.current(null);
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