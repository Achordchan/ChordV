import { useCallback, useEffect, useRef, useState } from "react";
import { notifications } from "@mantine/notifications";
import type { SystemUpdateCheckDto, SystemUpdateOperationDto, SystemUpdateRollbackVersionDto } from "@chordv/shared";
import { checkSystemUpdate, fetchRollbackVersions, fetchSystemOperation, fetchSystemOperations, fetchSystemVersion,
  openSystemOperationStream, startSystemRestart, startSystemRollback, startSystemUpdate, type SystemRuntimeStatusDto } from "./api";
import { observeSystemOperation, type UpdateConnection } from "./operation-observer";
import { clearCompletion, readCompletion, saveCompletion, waitForUpdatedPage, type UpdateCompletion } from "./page-refresh";
import { kindLabel } from "./operation-presentation";

export type BusyKind = "update" | "rollback" | "restart";
export function parseErrorMessage(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  try { const parsed = JSON.parse(raw); if (typeof parsed.message === "string") return parsed.message; } catch { /* plain transport error */ }
  return raw;
}

export function useSystemUpdate(opened: boolean) {
  const [runtime, setRuntime] = useState<SystemRuntimeStatusDto | null>(null);
  const [check, setCheck] = useState<SystemUpdateCheckDto | null>(null);
  const [checking, setChecking] = useState(false);
  const [operations, setOperations] = useState<SystemUpdateOperationDto[]>([]);
  const [versions, setVersions] = useState<SystemUpdateRollbackVersionDto[]>([]);
  const [auxLoading, setAuxLoading] = useState(false);
  const [auxError, setAuxError] = useState("");
  const [busy, setBusy] = useState<BusyKind | null>(null);
  const [connection, setConnection] = useState<UpdateConnection>("connecting");
  const [activeOp, setActiveOp] = useState<SystemUpdateOperationDto | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [error, setError] = useState("");
  const [completion, setCompletion] = useState<UpdateCompletion | null>(readCompletion);
  const [observedPhases, setObservedPhases] = useState<ReadonlySet<string>>(new Set());
  const mounted = useRef(true), mutation = useRef(false), finishingRef = useRef(false);
  const stopObserver = useRef<(() => void) | null>(null);
  const epoch = useRef(0), runtimeEpoch = useRef(0), checkEpoch = useRef(0);
  const activeId = useRef<string | null>(null);
  const refreshAbort = useRef<AbortController | null>(null);

  const stop = useCallback(() => { epoch.current++; stopObserver.current?.(); stopObserver.current = null; }, []);
  useEffect(() => {
    mounted.current = true; clearCompletion();
    return () => { mounted.current = false; stop(); refreshAbort.current?.abort(); };
  }, [stop]);

  const loadRuntime = useCallback(async () => {
    const sequence = ++runtimeEpoch.current;
    const value = await fetchSystemVersion();
    if (mounted.current && sequence === runtimeEpoch.current) setRuntime(value);
    return value;
  }, []);
  const runCheck = useCallback(async (force: boolean) => {
    const sequence = ++checkEpoch.current;
    setChecking(true);
    try {
      const value = await checkSystemUpdate(force);
      if (mounted.current && sequence === checkEpoch.current) setCheck(value);
    } catch (reason) {
      if (mounted.current && sequence === checkEpoch.current) { setCheck(null); setError(parseErrorMessage(reason)); }
    } finally { if (mounted.current && sequence === checkEpoch.current) setChecking(false); }
  }, []);
  const loadAux = useCallback(async () => {
    setAuxLoading(true); setAuxError("");
    try {
      const [items, history] = await Promise.all([fetchRollbackVersions(), fetchSystemOperations(20)]);
      if (mounted.current) { setVersions(items); setOperations(history); }
    } catch (reason) { if (mounted.current) setAuxError(parseErrorMessage(reason)); }
    finally { if (mounted.current) setAuxLoading(false); }
  }, []);

  const finishOperation = useCallback(async (operation: SystemUpdateOperationDto) => {
    if (!mounted.current || finishingRef.current) return;
    finishingRef.current = true; stop();
    const sequence = epoch.current;
    setActiveOp(operation); setFinishing(true); setRefreshRequired(false); setCheck(null); setError("");
    checkEpoch.current++; setChecking(false);
    const controller = new AbortController(); refreshAbort.current = controller;
    const deadline = setTimeout(() => controller.abort(), 20_000);
    const valid = () => mounted.current && sequence === epoch.current && !controller.signal.aborted;
    try {
      const status = await loadRuntime();
      if (!valid()) return;
      if (operation.status === "failed") {
        setError(operation.failureReason || "操作未成功，请查看操作记录。");
        activeId.current = null; setBusy(null); return;
      }
      if (operation.status === "succeeded" && operation.kind !== "restart" && operation.toVersion && status.currentVersion !== operation.toVersion) {
        setError(`操作记录已完成，但当前服务仍报告 v${status.currentVersion}，请重新确认版本。`);
        setRefreshRequired(true); return;
      }
      const next = { operationId: operation.operationId, kind: operation.kind, status: operation.status, version: status.currentVersion, at: Date.now() };
      setCompletion(next);
      if (operation.kind === "restart") {
        activeId.current = null; setBusy(null);
        notifications.show({ color: "teal", title: "服务已重启", message: `当前运行 v${status.currentVersion}` });
        return;
      }
      if (await waitForUpdatedPage(status.currentVersion, controller.signal)) {
        if (!valid()) return;
        saveCompletion(next);
        window.location.reload();
      } else if (mounted.current && sequence === epoch.current) {
        setRefreshRequired(true);
      }
    } catch (reason) {
      if (mounted.current && sequence === epoch.current) { setError(parseErrorMessage(reason)); setRefreshRequired(true); }
    } finally {
      clearTimeout(deadline); finishingRef.current = false;
      if (mounted.current && sequence === epoch.current) {
        setFinishing(false);
        // A timeout cannot silently leave a confirmed operation in a spinner.
        if (controller.signal.aborted) setRefreshRequired(true);
      }
    }
  }, [loadRuntime, stop]);

  const watchOperation = useCallback((operationId: string) => {
    stop(); activeId.current = operationId;
    const sequence = epoch.current;
    setError(""); setRefreshRequired(false);
    stopObserver.current = observeSystemOperation(operationId, {
      stream: signal => openSystemOperationStream(operationId, signal),
      snapshot: signal => fetchSystemOperation(operationId, signal),
      onConnection: state => { if (mounted.current && sequence === epoch.current) setConnection(state); },
      onError: message => { if (mounted.current && sequence === epoch.current) setError(message); },
      onOperation: operation => {
        if (!mounted.current || sequence !== epoch.current) return;
        setActiveOp(operation); setBusy(operation.kind);
        setObservedPhases(previous => new Set([...previous, ...(operation.observedPhases ?? []), ...(operation.phase ? [operation.phase] : [])]));
        if (["succeeded", "failed", "rolled_back"].includes(operation.status)) void finishOperation(operation);
      }
    });
  }, [finishOperation, stop]);

  const resume = useCallback(async () => {
    if (activeId.current || mutation.current) return;
    const history = await fetchSystemOperations(5);
    if (!mounted.current || activeId.current || mutation.current) return;
    const running = history.find(item => item.status === "running" || item.status === "pending");
    if (running) {
      setCompletion(null); setObservedPhases(new Set(running.observedPhases ?? []));
      setActiveOp(running); setBusy(running.kind); watchOperation(running.operationId);
    }
  }, [watchOperation]);

  useEffect(() => {
    void loadRuntime().then(status => {
      if (!mounted.current || !status.enabled) return;
      void resume().catch(() => undefined); void runCheck(false);
    }).catch(reason => { if (mounted.current) setError(parseErrorMessage(reason)); });
  }, [loadRuntime, resume, runCheck]);
  useEffect(() => {
    if (!opened || activeId.current) return;
    void loadRuntime().then(status => {
      if (mounted.current && status.enabled && !activeId.current) { void resume().catch(() => undefined); void runCheck(true); }
    }).catch(reason => { if (mounted.current) setError(parseErrorMessage(reason)); });
  }, [opened, loadRuntime, resume, runCheck]);

  const beginOperation = useCallback(async (kind: BusyKind, version?: string) => {
    if (mutation.current || activeId.current) return;
    mutation.current = true; setBusy(kind); setError(""); setCompletion(null); setActiveOp(null); setObservedPhases(new Set());
    checkEpoch.current++; setCheck(null); setChecking(false);
    try {
      const result = kind === "update" ? await startSystemUpdate(version) : kind === "rollback" ? await startSystemRollback(version) : await startSystemRestart();
      if (!mounted.current) return;
      watchOperation(result.operationId);
    } catch (reason) {
      if (mounted.current) { setBusy(null); setError(parseErrorMessage(reason)); }
    } finally { mutation.current = false; }
  }, [watchOperation]);
  const reconnect = () => {
    if (activeOp && ["succeeded", "failed", "rolled_back"].includes(activeOp.status)) { void finishOperation(activeOp); return; }
    if (activeId.current) watchOperation(activeId.current);
    else void loadRuntime().then(async status => {
      await resume();
      if (mounted.current && !activeId.current) { setError(""); if (status.enabled) void runCheck(true); }
    }).catch(reason => { if (mounted.current) setError(parseErrorMessage(reason)); });
  };
  const pause = () => { stop(); setConnection("paused"); };
  const canUpdate = Boolean(runtime?.enabled && !busy && !checking && check?.hasUpdate && check.release && !check.cached && !check.warning);
  return { runtime, check, checking, operations, versions, auxLoading, auxError, busy, connection, activeOp, finishing,
    refreshRequired, completion, observedPhases, error, canUpdate, runCheck, loadAux, beginOperation, reconnect, pause,
    reloadPage: () => window.location.reload(), dismissCompletion: () => setCompletion(null), kindLabel };
}
