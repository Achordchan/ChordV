import type {
  AuthSessionDto,
  ClientBootstrapDto,
  ClientVersionDto,
  ConnectionMode,
  GeneratedRuntimeConfigDto,
  NodeSummaryDto,
  SubscriptionStatusDto
} from "@chordv/shared";
import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  fetchBootstrap as fetchBootstrapRequest,
  fetchNodes as fetchNodesRequest,
  login as loginRequest,
  logoutSession as logoutSessionRequest,
  refreshSession as refreshSessionRequest
} from "../api/client";
import type { RuntimeNodeProbeResult } from "../lib/runtime";
import {
  clearStoredSession as clearStoredSessionRuntime,
  loadStoredSession as loadStoredSessionRuntime,
  saveStoredSession as saveStoredSessionRuntime
} from "../lib/runtime";

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
  bootstrapVersion?: ClientVersionDto | null;
  source: UpdateCheckSource;
  silent?: boolean;
};

type CredentialsState = {
  email: string;
  password: string;
};

type SetState<T> = Dispatch<SetStateAction<T>>;

export type UseAuthBootstrapOptions = {
  session: AuthSessionDto | null;
  nodes: NodeSummaryDto[];
  credentials: CredentialsState;
  rememberPassword: boolean;
  modeLocked: boolean;
  authBusy: boolean;
  refreshing: boolean;
  logoutBusy: boolean;
  setSession: SetState<AuthSessionDto | null>;
  setBootstrap: SetState<ClientBootstrapDto | null>;
  setNodes: SetState<NodeSummaryDto[]>;
  setSelectedNodeId: SetState<string | null>;
  setProbeResults: SetState<Record<string, RuntimeNodeProbeResult>>;
  setRuntime: SetState<GeneratedRuntimeConfigDto | null>;
  setConnectionGuidance: SetState<ConnectionGuidanceLike | null>;
  setGuidanceDialog: SetState<ConnectionGuidanceLike | null>;
  setMode: SetState<ConnectionMode>;
  setError: SetState<string | null>;
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
  clearStoredSession?: typeof clearStoredSessionRuntime;
  refreshRuntime: () => Promise<void>;
  forceStopLocalRuntime: () => Promise<void>;
  runProbe: (nodes: NodeSummaryDto[], force: boolean, accessToken?: string) => Promise<void>;
  runUpdateCheck: (input: RunUpdateCheckInput) => Promise<void>;
  pickNode: (
    nodes: NodeSummaryDto[],
    preferredId: string | null,
    probeResults?: Record<string, RuntimeNodeProbeResult>
  ) => NodeSummaryDto | null;
  loadLastNodeId: () => string | null;
  resolveDefaultMode: (bootstrap: ClientBootstrapDto) => ConnectionMode;
  clearResolvedGuidance: (
    current: ConnectionGuidanceLike | null,
    subscription: SubscriptionStatusDto,
    nodes: NodeSummaryDto[]
  ) => ConnectionGuidanceLike | null;
  showErrorToast: (message: string) => void;
  readError: (message: string) => string;
  saveRememberedCredentials: (email: string, password: string) => void;
  clearRememberedCredentials: () => void;
};

export function useAuthBootstrap(options: UseAuthBootstrapOptions) {
  const {
    session,
    nodes,
    credentials,
    rememberPassword,
    modeLocked,
    authBusy,
    refreshing,
    logoutBusy,
    setSession,
    setBootstrap,
    setNodes,
    setSelectedNodeId,
    setProbeResults,
    setRuntime,
    setConnectionGuidance,
    setGuidanceDialog,
    setMode,
    setError,
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
    clearStoredSession = clearStoredSessionRuntime,
    refreshRuntime,
    forceStopLocalRuntime,
    runProbe,
    runUpdateCheck,
    pickNode,
    loadLastNodeId,
    resolveDefaultMode,
    clearResolvedGuidance,
    showErrorToast,
    readError,
    saveRememberedCredentials,
    clearRememberedCredentials
  } = options;

  const clearSession = useCallback(
    async (stopRuntime = true) => {
      if (stopRuntime) {
        await forceStopLocalRuntime();
      }
      await clearStoredSession().catch(() => null);
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
      forceStopLocalRuntime,
      setBootstrap,
      setConnectionGuidance,
      setGuidanceDialog,
      setMode,
      setNodes,
      setProbeResults,
      setRuntime,
      setSelectedNodeId,
      setSession
    ]
  );

  const bootstrapSession = useCallback(
    async (
      nextSession: AuthSessionDto,
      allowRefresh: boolean,
      preserveMode: boolean,
      autoProbe: boolean
    ) => {
      try {
        const [nextBootstrap, nextNodes] = await Promise.all([
          fetchBootstrap(nextSession.accessToken),
          fetchNodes(nextSession.accessToken)
        ]);

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
        if (nextNodes.length === 0) {
          showErrorToast("当前订阅未分配节点，请联系服务商处理");
        }

        const preferred = pickNode(nextNodes, loadLastNodeId());
        setSelectedNodeId(preferred?.id ?? null);

        if (autoProbe && nextNodes.length > 0) {
          await runProbe(nextNodes, true, nextSession.accessToken);
        } else if (nextNodes.length > 0) {
          setProbeResults((current) =>
            Object.fromEntries(
              Object.entries(current).filter(([nodeId]) => nextNodes.some((node) => node.id === nodeId))
            )
          );
        } else {
          setProbeResults({});
        }

        await runUpdateCheck({
          accessToken: nextSession.accessToken,
          bootstrapVersion: nextBootstrap.version,
          source: allowRefresh ? "refresh" : "login",
          silent: true
        });

        return true;
      } catch (reason) {
        if (allowRefresh && nextSession.refreshToken) {
          try {
            const refreshed = await refreshSession(nextSession.refreshToken);
            await saveStoredSession(refreshed);
            return await bootstrapSession(refreshed, false, preserveMode, autoProbe);
          } catch {
            await clearSession(true);
          }
        } else {
          await clearSession(true);
        }

        showErrorToast(reason instanceof Error ? readError(reason.message) : "登录态已失效");
        return false;
      }
    },
    [
      clearResolvedGuidance,
      clearSession,
      fetchBootstrap,
      fetchNodes,
      loadLastNodeId,
      pickNode,
      readError,
      refreshSession,
      resolveDefaultMode,
      runProbe,
      runUpdateCheck,
      saveStoredSession,
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

  const handleLogin = useCallback(async () => {
    if (authBusy) {
      return;
    }

    try {
      setAuthBusy(true);
      const normalizedEmail = credentials.email.trim();
      const nextSession = await login(normalizedEmail, credentials.password);
      await saveStoredSession(nextSession);
      if (rememberPassword) {
        saveRememberedCredentials(normalizedEmail, credentials.password);
      } else {
        clearRememberedCredentials();
      }
      setCredentials((current) => ({ ...current, email: normalizedEmail }));
      await bootstrapSession(nextSession, false, false, true);
    } catch (reason) {
      showErrorToast(reason instanceof Error ? readError(reason.message) : "登录失败");
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
    readError,
    rememberPassword,
    saveRememberedCredentials,
    saveStoredSession,
    setAuthBusy,
    setCredentials,
    showErrorToast
  ]);

  const handleRefresh = useCallback(async () => {
    if (!session || refreshing) {
      return;
    }

    try {
      setRefreshing(true);
      await refreshRuntime();
      const ok = await bootstrapSession(session, true, modeLocked, false);
      if (!ok) {
        await forceStopLocalRuntime();
      }
    } catch (reason) {
      await forceStopLocalRuntime();
      showErrorToast(reason instanceof Error ? readError(reason.message) : "刷新失败");
    } finally {
      setRefreshing(false);
    }
  }, [
    bootstrapSession,
    forceStopLocalRuntime,
    modeLocked,
    readError,
    refreshing,
    refreshRuntime,
    session,
    setRefreshing,
    showErrorToast
  ]);

  const handleLogout = useCallback(async () => {
    if (logoutBusy) {
      return;
    }

    try {
      setLogoutBusy(true);
      const accessToken = session?.accessToken ?? null;
      await forceStopLocalRuntime();
      if (session) {
        await logoutSession(accessToken ?? session.accessToken).catch(() => null);
      }
      await clearSession(false);
      if (!rememberPassword) {
        setCredentials((current) => ({ ...current, password: "" }));
      }
    } finally {
      setLogoutBusy(false);
    }
  }, [
    clearSession,
    forceStopLocalRuntime,
    logoutBusy,
    logoutSession,
    rememberPassword,
    session,
    setCredentials,
    setLogoutBusy
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
    const storedSession = await loadStoredSession();
    if (!storedSession) {
      return false;
    }
    return bootstrapSession(storedSession, true, false, true);
  }, [bootstrapSession, loadStoredSession]);

  return {
    bootstrapSession,
    clearSession,
    handleLogin,
    handleLogout,
    handleRefresh,
    mergeSubscriptionState,
    restoreStoredSession
  };
}
