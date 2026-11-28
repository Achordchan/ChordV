import type {
  AuthSessionDto,
  ClientBootstrapDto,
  ConnectionMode,
  GeneratedRuntimeConfigDto,
  NodeSummaryDto,
  SubscriptionStatusDto
} from "@chordv/shared";
import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  fetchBootstrap as fetchBootstrapRequest,
  fetchNodes as fetchNodesRequest,
  isAccessTokenExpiredApiError,
  isForbiddenApiError,
  isNotFoundApiError,
  isUnauthorizedApiError,
  login as loginRequest,
  logoutSession as logoutSessionRequest,
  refreshSession as refreshSessionRequest
} from "../api/client";
import type { RuntimeNodeProbeResult } from "../lib/runtime";
import type { RuntimeStatus } from "../lib/runtime";
import {
  clearStoredSession as clearStoredSessionRuntime,
  loadStoredSession as loadStoredSessionRuntime,
  refreshStoredSessionNative as refreshStoredSessionNativeRuntime,
  saveStoredSession as saveStoredSessionRuntime
} from "../lib/runtime";
import {
  type UnauthorizedRecoveryTaskRef,
  recoverDesktopSessionAfterUnauthorized
} from "../lib/desktopSessionRecovery";
import { buildProtectedAccessNotice, resolveProtectedAccessReason } from "../lib/sessionLeaseState";
import type { UserErrorContext } from "../lib/userFacingErrors";

export type GuidanceTone = "danger" | "warning" | "info";

export type ConnectionGuidanceLike = {
  code: string;
  tone: GuidanceTone;
  title: string;
  message: string;
  actionLabel: string;
  recommendedNodeId?: string | null;
  errorCode?: string | null;
};

export type UpdateCheckSource = "startup" | "login" | "manual" | "refresh";

export type RunUpdateCheckInput = {
  accessToken?: string;
  source: UpdateCheckSource;
  silent?: boolean;
  inspectOnly?: boolean;
  includeRuntimeComponents?: boolean;
  runtimeTargets?: Array<"xray" | "geo">;
  openUpdateCenter?: boolean;
};

type CredentialsState = {
  email: string;
  password: string;
};

type SetState<T> = Dispatch<SetStateAction<T>>;

export type UseAuthBootstrapOptions = {
  session: AuthSessionDto | null;
  getCurrentSession?: () => AuthSessionDto | null;
  nodes: NodeSummaryDto[];
  credentials: CredentialsState;
  rememberPassword: boolean;
  modeLocked: boolean;
  authBusy: boolean;
  refreshing: boolean;
  logoutBusy: boolean;
  setSession: SetState<AuthSessionDto | null>;
  invalidateSessionOperations?: () => void;
  setBootstrap: SetState<ClientBootstrapDto | null>;
  setNodes: SetState<NodeSummaryDto[]>;
  setSelectedNodeId: SetState<string | null>;
  setProbeResults: SetState<Record<string, RuntimeNodeProbeResult>>;
  setRuntime: SetState<GeneratedRuntimeConfigDto | null>;
  setConnectionGuidance: SetState<ConnectionGuidanceLike | null>;
  setGuidanceDialog: SetState<ConnectionGuidanceLike | null>;
  setMode: SetState<ConnectionMode>;
  setError: SetState<string | null>;
  readLoginError: (reason: unknown) => string;
  setCredentials: SetState<CredentialsState>;
  setAuthBusy: SetState<boolean>;
  setRefreshing: SetState<boolean>;
  setLogoutBusy: SetState<boolean>;
  fetchBootstrap?: typeof fetchBootstrapRequest;
  fetchNodes?: typeof fetchNodesRequest;
  login?: typeof loginRequest;
  logoutSession?: typeof logoutSessionRequest;
  refreshSession?: typeof refreshSessionRequest;
  loadStoredSession?: typeof loadStoredSessionRuntime;
  saveStoredSession?: typeof saveStoredSessionRuntime;
  refreshStoredSessionNative?: typeof refreshStoredSessionNativeRuntime;
  clearStoredSession?: typeof clearStoredSessionRuntime;
  unauthorizedRecoveryTaskRef: UnauthorizedRecoveryTaskRef;
  refreshRuntime: () => Promise<RuntimeStatus | null>;
  forceStopLocalRuntime: () => Promise<void>;
  runProbe: (nodes: NodeSummaryDto[], force: boolean, accessToken?: string) => Promise<void>;
  runUpdateCheck: (input: RunUpdateCheckInput) => Promise<void>;
  pickNode: (
    nodes: NodeSummaryDto[],
    preferredId: string | null,
    probeResults?: Record<string, RuntimeNodeProbeResult>
  ) => NodeSummaryDto | null;
  resolveDefaultMode: (bootstrap: ClientBootstrapDto) => ConnectionMode;
  clearResolvedGuidance: (
    current: ConnectionGuidanceLike | null,
    subscription: SubscriptionStatusDto,
    nodes: NodeSummaryDto[]
  ) => ConnectionGuidanceLike | null;
  showErrorToast: (reason: unknown, context?: UserErrorContext) => void;
  readError: (message: string) => string;
  saveRememberedCredentials: (email: string, password: string) => void;
  clearRememberedCredentials: () => void;
};

export function useAuthBootstrap(options: UseAuthBootstrapOptions) {
  const authOperationEpoch = useRef(0);
  const latestSession = useRef(options.session);
  latestSession.current = options.session;
  const sessionWrite = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => () => { authOperationEpoch.current++; }, []);
  const writeSession = useCallback((operation: () => Promise<unknown>, current: () => boolean = () => true) => {
    const task = sessionWrite.current.catch(() => undefined).then(async () => {
      if (current()) await operation();
    });
    sessionWrite.current = task;
    return task;
  }, []);
  const {
    session,
    getCurrentSession = () => latestSession.current,
    nodes,
    credentials,
    rememberPassword,
    modeLocked,
    authBusy,
    refreshing,
    logoutBusy,
    setSession,
    invalidateSessionOperations,
    setBootstrap,
    setNodes,
    setSelectedNodeId,
    setProbeResults,
    setRuntime,
    setConnectionGuidance,
    setGuidanceDialog,
    setMode,
    setError,
    readLoginError,
    setCredentials,
    setAuthBusy,
    setRefreshing,
    setLogoutBusy,
    fetchBootstrap = fetchBootstrapRequest,
    fetchNodes = fetchNodesRequest,
    login = loginRequest,
    logoutSession = logoutSessionRequest,
    refreshSession = refreshSessionRequest,
    loadStoredSession = loadStoredSessionRuntime,
    saveStoredSession = saveStoredSessionRuntime,
    refreshStoredSessionNative = refreshStoredSessionNativeRuntime,
    clearStoredSession = clearStoredSessionRuntime,
    unauthorizedRecoveryTaskRef,
    refreshRuntime,
    forceStopLocalRuntime,
    runProbe,
    runUpdateCheck,
    pickNode,
    resolveDefaultMode,
    clearResolvedGuidance,
    showErrorToast,
    readError,
    saveRememberedCredentials,
    clearRememberedCredentials
  } = options;

  const clearSession = useCallback(
    async (stopRuntime = true) => {
      const epoch = ++authOperationEpoch.current;
      const current = () => authOperationEpoch.current === epoch;
      setCredentials((current) => current.password ? { ...current, password: "" } : current);
      invalidateSessionOperations?.();
      if (stopRuntime) {
        await forceStopLocalRuntime();
      }
      if (!current()) return;
      await writeSession(clearStoredSession, current);
      if (!current()) return;
      setSession(null);
      setBootstrap(null);
      setNodes([]);
      setSelectedNodeId(null);
      setProbeResults({});
      setRuntime(null);
      setConnectionGuidance(null);
      setGuidanceDialog(null);
      setMode("rule");
    },
    [
      clearStoredSession,
      invalidateSessionOperations,
      forceStopLocalRuntime,
      setBootstrap,
      setConnectionGuidance,
      setCredentials,
      setGuidanceDialog,
      setMode,
      setNodes,
      setProbeResults,
      setRuntime,
      setSelectedNodeId,
      setSession,
      writeSession
    ]
  );

  const bootstrapSession = useCallback(
    async (
      nextSession: AuthSessionDto,
      allowRefresh: boolean,
      preserveMode: boolean,
      autoProbe: boolean,
      isCurrent: () => boolean = () => true
    ) => {
      if (!isCurrent()) return false;
      try {
        const [nextBootstrap, nextNodes] = await Promise.all([
          fetchBootstrap(nextSession.accessToken),
          fetchNodes(nextSession.accessToken)
        ]);
        if (!isCurrent()) return false;

        setSession(nextSession);
        setBootstrap(nextBootstrap);
        setNodes(nextNodes);
        setConnectionGuidance((current) => {
          const nextGuidance = clearResolvedGuidance(current, nextBootstrap.subscription, nextNodes);
          if (!nextGuidance) {
            setGuidanceDialog(null);
          }
          return nextGuidance;
        });
        if (!preserveMode) {
          setMode(resolveDefaultMode(nextBootstrap));
        }
        setError(null);

        const preferred = pickNode(nextNodes, null);
        setSelectedNodeId(preferred?.id ?? null);

        if (autoProbe && nextNodes.length > 0) {
          try {
            await runProbe(nextNodes, true, nextSession.accessToken);
          } catch (reason) {
            if (isCurrent()) showErrorToast(reason || "节点测速没有完成，请稍后重试。", "node_probe");
          }
        } else if (nextNodes.length > 0) {
          setProbeResults((current) =>
            Object.fromEntries(
              Object.entries(current).filter(([nodeId]) => nextNodes.some((node) => node.id === nodeId))
            )
          );
        } else {
          setProbeResults({});
        }

        if (!isCurrent()) return false;
        if (!allowRefresh) {
          try {
            await runUpdateCheck({
              accessToken: nextSession.accessToken,
              source: "login",
              silent: true,
              includeRuntimeComponents: false
            });
          } catch (reason) {
            showErrorToast(reason || "暂时无法检查更新，请稍后重试。", "update_check");
          }
        }

        return true;
      } catch (reason) {
        if (!isCurrent()) return false;
        if (allowRefresh && nextSession.refreshToken && isAccessTokenExpiredApiError(reason)) {
          try {
            const refreshed = await recoverDesktopSessionAfterUnauthorized({
              taskRef: unauthorizedRecoveryTaskRef,
              currentSession: nextSession,
              isCurrent,
              scope: JSON.stringify([authOperationEpoch.current, nextSession.user.id]),
              bootstrapSession: (refreshedSession) =>
                bootstrapSession(refreshedSession, false, preserveMode, autoProbe, isCurrent),
              clearSession: async stop => { if (isCurrent()) await clearSession(stop); },
              refreshSession,
              refreshSessionNative: refreshStoredSessionNative,
              saveStoredSession: next => writeSession(() => saveStoredSession(next), isCurrent),
              loadStoredSession
            });
            return isCurrent() && Boolean(refreshed);
          } catch (refreshReason) {
            if (!isCurrent()) return false;
            if (isUnauthorizedApiError(refreshReason)) {
              await clearSession(true);
              showErrorToast("登录状态已失效，请重新登录。", "session");
              return false;
            }
            if (isForbiddenApiError(refreshReason)) {
              const accessReason = resolveProtectedAccessReason(
                refreshReason instanceof Error ? readError(refreshReason.message) : ""
              );
              if (accessReason) {
                const notice = buildProtectedAccessNotice(accessReason);
                await clearSession(true);
                showErrorToast(notice.message, "session");
                return false;
              }
              await clearSession(true);
              showErrorToast(refreshReason || "登录未成功，请稍后重试。", "login");
              return false;
            }
            if (session) {
              setSession(nextSession);
              await writeSession(() => saveStoredSession(nextSession), isCurrent).catch(() => null);
              if (!isCurrent()) return false;
              showErrorToast("账号信息暂时无法同步，已保留当前登录状态，请稍后刷新。", "session");
              return true;
            }
            showErrorToast("登录未成功，请稍后重试。", "login");
            return false;
          }
        }

        if (isUnauthorizedApiError(reason)) {
          await clearSession(true);
          showErrorToast(reason || "登录状态已失效，请重新登录。", "session");
          return false;
        }

        if (isForbiddenApiError(reason)) {
          const accessReason = resolveProtectedAccessReason(
            reason instanceof Error ? reason.message : ""
          );
          if (accessReason) {
            const notice = buildProtectedAccessNotice(accessReason);
            await clearSession(true);
            showErrorToast(notice.message, "session");
            return false;
          }
          const message = reason instanceof Error ? readError(reason.message) : "当前账号无法继续使用";
          if (message.includes("当前没有可用订阅") || message.includes("失去可用订阅")) {
            await clearSession(true);
            showErrorToast("当前账号暂无可用订阅，请续费或联系客服后再使用。", "session");
            return false;
          }
        }

        if (isNotFoundApiError(reason)) {
          const message = reason instanceof Error ? readError(reason.message) : "";
          if (message.includes("当前没有可用订阅")) {
            await clearSession(true);
            showErrorToast("当前账号暂无可用订阅，请续费或联系客服后再使用。", "session");
            return false;
          }
        }

        if (session) {
          setSession(nextSession);
          await writeSession(() => saveStoredSession(nextSession), isCurrent).catch(() => null);
          if (!isCurrent()) return false;
          showErrorToast(reason || "账号信息暂时无法同步，已保留当前登录状态，请稍后刷新。", "session");
          return true;
        }

        showErrorToast(reason || "登录未成功，请稍后重试。", "login");
        return false;
      }
    },
    [
      clearResolvedGuidance,
      clearSession,
      fetchBootstrap,
      fetchNodes,
      session,
      isAccessTokenExpiredApiError,
      isForbiddenApiError,
      isUnauthorizedApiError,
      pickNode,
      readError,
      refreshStoredSessionNative,
      refreshSession,
      resolveDefaultMode,
      resolveProtectedAccessReason,
      runProbe,
      runUpdateCheck,
      buildProtectedAccessNotice,
      saveStoredSession,
      writeSession,
      setBootstrap,
      setConnectionGuidance,
      setError,
      setGuidanceDialog,
      setMode,
      setNodes,
      setProbeResults,
      setSelectedNodeId,
      setSession,
      showErrorToast
    ]
  );

  const recoverSessionAfterUnauthorized = useCallback(async () => {
    const epoch = authOperationEpoch.current;
    const currentSession = getCurrentSession();
    const current = () => authOperationEpoch.current === epoch &&
      getCurrentSession()?.user.id === currentSession?.user.id;
    return recoverDesktopSessionAfterUnauthorized({
      taskRef: unauthorizedRecoveryTaskRef,
      currentSession,
      isCurrent: current,
      scope: JSON.stringify([epoch, currentSession?.user.id]),
      bootstrapSession: next => bootstrapSession(next, false, true, false, current),
      clearSession: async stop => { if (current()) await clearSession(stop); },
      refreshSession,
      refreshSessionNative: refreshStoredSessionNative,
      saveStoredSession: next => writeSession(() => saveStoredSession(next), current),
      loadStoredSession
    });
  }, [bootstrapSession, clearSession, getCurrentSession, loadStoredSession, refreshSession,
    refreshStoredSessionNative, saveStoredSession, unauthorizedRecoveryTaskRef, writeSession]);

  const handleLogin = useCallback(async () => {
    if (authBusy) {
      return;
    }

    const epoch = ++authOperationEpoch.current;
    const current = () => authOperationEpoch.current === epoch;

    try {
      setAuthBusy(true);
      setError(null);
      const normalizedEmail = credentials.email.trim();
      const nextSession = await login(normalizedEmail, credentials.password);
      if (!current()) return;
      await writeSession(() => saveStoredSession(nextSession), current);
      if (!current()) return;
      if (rememberPassword) {
        saveRememberedCredentials(normalizedEmail, credentials.password);
      } else {
        clearRememberedCredentials();
      }
      setCredentials((current) => ({ ...current, email: normalizedEmail }));
      const ok = await bootstrapSession(nextSession, false, false, true, current);
      if (!ok && current()) {
        await writeSession(clearStoredSession, current).catch(() => null);
      }
    } catch (reason) {
      if (current()) setError(readLoginError(reason || "登录未成功，请稍后重试。"));
    } finally {
      setAuthBusy(false);
    }
  }, [
    authBusy,
    bootstrapSession,
    clearRememberedCredentials,
    credentials.email,
    credentials.password,
    login,
    readLoginError,
    setError,
    rememberPassword,
    saveRememberedCredentials,
    saveStoredSession,
    writeSession,
    setAuthBusy,
    setCredentials
  ]);

  const handleRefresh = useCallback(async () => {
    const currentSession = getCurrentSession();
    if (!currentSession || refreshing) {
      return;
    }
    const epoch = authOperationEpoch.current;
    const current = () => authOperationEpoch.current === epoch &&
      getCurrentSession()?.user.id === currentSession.user.id;

    try {
      setRefreshing(true);
      await refreshRuntime();
      if (!current()) return;
      const ok = await bootstrapSession(currentSession, true, modeLocked, false, current);
      if (!current()) return;
      if (!ok) {
        await forceStopLocalRuntime();
      }
    } catch (reason) {
      if (!current()) return;
      showErrorToast(reason || "刷新失败", "refresh");
      // 本机停止失败单独提醒，不与刷新失败合并成一条。
      try { await forceStopLocalRuntime(); }
      catch (stopReason) { showErrorToast(stopReason || "本机连接停止失败", "local_stop"); }
    } finally {
      setRefreshing(false);
    }
  }, [
    bootstrapSession,
    forceStopLocalRuntime,
    getCurrentSession,
    modeLocked,
    readError,
    refreshing,
    refreshRuntime,
    setRefreshing,
    showErrorToast
  ]);

  const handleLogout = useCallback(async () => {
    if (logoutBusy) {
      return;
    }

    authOperationEpoch.current++;

    try {
      setCredentials((current) => current.password ? { ...current, password: "" } : current);
      setLogoutBusy(true);
      invalidateSessionOperations?.();
      const accessToken = session?.accessToken ?? null;
      try {
        await forceStopLocalRuntime();
      } catch (stopReason) {
        // 本机连接没停下来时不清除会话：明确告诉用户连接可能仍在运行，而不是泛泛的“退出失败”。
        showErrorToast(stopReason || "本机连接停止失败", "local_stop");
        return;
      }
      if (session) {
        void logoutSession(accessToken ?? session.accessToken, session.refreshToken).catch(() => null);
      }
      await clearSession(false);
    } catch (reason) {
      showErrorToast(reason || "退出失败，请重试。", "logout");
    } finally {
      setLogoutBusy(false);
    }
  }, [
    clearSession,
    invalidateSessionOperations,
    forceStopLocalRuntime,
    logoutBusy,
    logoutSession,
    session,
    setCredentials,
    setLogoutBusy,
    readError,
    showErrorToast
  ]);

  const mergeSubscriptionState = useCallback(
    (subscription: SubscriptionStatusDto) => {
      setBootstrap((current) => (current ? { ...current, subscription } : current));
      setConnectionGuidance((current) => {
        const nextGuidance = clearResolvedGuidance(current, subscription, nodes);
        if (!nextGuidance) {
          setGuidanceDialog(null);
        }
        return nextGuidance;
      });
    },
    [clearResolvedGuidance, nodes, setBootstrap, setConnectionGuidance, setGuidanceDialog]
  );

  const restoreStoredSession = useCallback(async () => {
    if (authOperationEpoch.current !== 0) return null;
    const current = () => authOperationEpoch.current === 0;
    const storedSession = await loadStoredSession();
    if (!storedSession || !current()) {
      return null;
    }
    const ok = await bootstrapSession(storedSession, true, false, true, current);
    if (!ok || !current()) {
      return null;
    }
    const latest = (await loadStoredSession().catch(() => null)) ?? storedSession;
    return current() ? latest : null;
  }, [bootstrapSession, loadStoredSession]);

  return {
    recoverSessionAfterUnauthorized,
    bootstrapSession,
    clearSession,
    handleLogin,
    handleLogout,
    handleRefresh,
    mergeSubscriptionState,
    restoreStoredSession
  };
}
