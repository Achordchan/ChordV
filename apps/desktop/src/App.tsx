import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Alert, Button, Checkbox, LoadingOverlay, Modal, Progress, Stack, Text, TextInput, ThemeIcon, UnstyledButton } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconHome2, IconStack2, IconUserCircle } from "@tabler/icons-react";
import type {
  AuthSessionDto,
  ClientBootstrapDto,
  ConnectionMode,
  GeneratedRuntimeConfigDto,
  NodeSummaryDto,
  SubscriptionStatusDto
} from "@chordv/shared";
import {
  fetchClientRuntime,
  getApiErrorRawMessage,
  heartbeatSession,
  isAccessTokenExpiredApiError,
  isForbiddenApiError,
  isUnauthorizedApiError,
  probeClientServerLatency
} from "./api/client";
import { AnnouncementDrawer } from "./components/AnnouncementDrawer";
import { ControlPanel } from "./components/ControlPanel";
import { LogDrawer } from "./components/LogDrawer";
import { LoginScreen } from "./components/LoginScreen";
import { NodeListPanel } from "./components/NodeListPanel";
import { RuntimeAssetsBanner } from "./components/RuntimeAssetsBanner";
import { SubscriptionPanel } from "./components/SubscriptionPanel";
import { TicketCenterModal } from "./components/TicketCenterModal";
import {
  appReady,
  focusDesktopWindow,
  hasActivePlatformRuntime,
  loadActiveRuntimeConfig,
  subscribeDesktopShellActions,
  subscribeNativeLeaseHeartbeat,
  subscribeNativeSessionRefreshed,
  updateDesktopShellSummary,
  type RuntimeNodeProbeResult,
  type RuntimeStatus
} from "./lib/runtime";
import { resolveDesktopPlatformVersion } from "./lib/platformVersion";
import {
  clearResolvedGuidance,
  composeRuntimeFailureText,
  ConnectionGuidance,
  deriveGuidanceFromMessage,
  deriveGuidanceFromRuntimeFailure,
  deriveGuidanceFromRuntimeStatus,
  deriveGuidanceFromSubscription,
  guidanceKey,
  GuidanceTone,
  isSubscriptionBlocked,
  pickAlternativeNode,
  readError,
  shouldAutoHandleRuntimeGuidance
} from "./lib/connectionGuidance";
import {
  clearRememberedCredentials as clearRememberedCredentialsStorage,
  loadLastNodeId as loadLastNodeIdFromStorage,
  loadRememberedCredentials as loadRememberedCredentialsFromStorage,
  pickNode,
  primaryButtonLabel,
  resolveDefaultMode,
  saveRememberedCredentials as saveRememberedCredentialsToStorage,
  showErrorToast,
  toneToToastColor,
  toSubscriptionServerProbe
} from "./lib/appState";
import { recoverDesktopSessionAfterUnauthorized } from "./lib/desktopSessionRecovery";
import { buildProtectedAccessNotice, resolveProtectedAccessReason } from "./lib/sessionLeaseState";
import {
  formatVersionLabel,
  updateActionLabel
} from "./lib/updateState";
import { useAnnouncements } from "./hooks/useAnnouncements";
import { useAuthBootstrap } from "./hooks/useAuthBootstrap";
import { createIdleServerProbeState, type ServerProbeState, useClientEvents } from "./hooks/useClientEvents";
import { useNodeProbe } from "./hooks/useNodeProbe";
import { useRuntimeActions } from "./hooks/useRuntimeActions";
import { useRuntimeAssets } from "./hooks/useRuntimeAssets";
import { useRuntimeStatus } from "./hooks/useRuntimeStatus";
import { useSupportTickets } from "./hooks/useSupportTickets";
import { useUpdateFlow } from "./hooks/useUpdateFlow";
const LAST_NODE_KEY = "chordv_last_node_id";
const REMEMBER_CREDENTIALS_KEY = "chordv_remember_credentials";
const DESKTOP_CLOSE_HINT_KEY = "chordv_desktop_close_hint_ack";
const RUNTIME_COMPONENT_MIRROR_PREFIX_KEY = "chordv_runtime_component_mirror_prefix";
const UPDATE_CHANNEL = "stable";

declare global {
  interface Window {
    __CHORDV_DESKTOP_SHELL__?: {
      toggleConnection: () => void;
      openLogs: () => void;
    };
  }
}

export function App() {
  const [session, setSession] = useState<AuthSessionDto | null>(null);
  const [bootstrap, setBootstrap] = useState<ClientBootstrapDto | null>(null);
  const [nodes, setNodes] = useState<NodeSummaryDto[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [mode, setMode] = useState<ConnectionMode>("rule");
  const [runtime, setRuntime] = useState<GeneratedRuntimeConfigDto | null>(null);
  const [booting, setBooting] = useState(true);
  const [authBusy, setAuthBusy] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logDrawerOpened, setLogDrawerOpened] = useState(false);
  const [announcementDrawerOpened, setAnnouncementDrawerOpened] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credentials, setCredentials] = useState({ email: "", password: "" });
  const [rememberPassword, setRememberPassword] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [connectionGuidance, setConnectionGuidance] = useState<ConnectionGuidance | null>(null);
  const [guidanceDialog, setGuidanceDialog] = useState<ConnectionGuidance | null>(null);
  const [closeHintOpened, setCloseHintOpened] = useState(false);
  const [rememberCloseHint, setRememberCloseHint] = useState(true);
  const [mobileTab, setMobileTab] = useState<"home" | "nodes" | "profile">("home");
  const [serverProbe, setServerProbe] = useState<ServerProbeState>(createIdleServerProbeState());
  const [serverProbeBusy, setServerProbeBusy] = useState(false);
  const [runtimeMirrorPrefix, setRuntimeMirrorPrefix] = useState("");
  const leaseHeartbeatFailedAtRef = useRef<number | null>(null);
  const lastMeteringToastRef = useRef<string | null>(null);
  const lastGuidanceToastRef = useRef<string | null>(null);
  const lastRuntimeSignalKeyRef = useRef<string | null>(null);
  const lastForegroundSyncErrorRef = useRef<string | null>(null);
  const lastForegroundSyncAtRef = useRef(0);
  const lastLeaseResumeCheckAtRef = useRef(0);
  const runtimeRescueTriggeredRef = useRef(false);
  const runtimeRef = useRef<GeneratedRuntimeConfigDto | null>(null);
  const bootstrapRef = useRef<ClientBootstrapDto | null>(null);
  const nodesRef = useRef<NodeSummaryDto[]>([]);
  const selectedNodeIdRef = useRef<string | null>(null);
  const probeResultsRef = useRef<Record<string, RuntimeNodeProbeResult>>({});
  const ticketCenterOpenedRef = useRef(false);
  const ticketCreateModeRef = useRef(false);
  const selectedTicketIdRef = useRef<string | null>(null);
  const shellActionRef = useRef<(() => Promise<void>) | null>(null);
  const openLogsActionRef = useRef<(() => void) | null>(null);
  const sessionRef = useRef<AuthSessionDto | null>(null);
  const unauthorizedRecoveryTaskRef = useRef<Promise<AuthSessionDto | null> | null>(null);
  const lastShellSummaryRef = useRef("");
  const pendingShellSummaryRef = useRef("");
  const shellSummaryRequestSeqRef = useRef(0);
  const { desktopStatus, setDesktopStatus, runtimeLog, refreshRuntime, forceStopLocalRuntime } = useRuntimeStatus({
    setRuntime,
    leaseHeartbeatFailedAtRef
  });
  const loadLastNodeId = () => loadLastNodeIdFromStorage(LAST_NODE_KEY);
  const loadRememberedCredentials = () => loadRememberedCredentialsFromStorage(REMEMBER_CREDENTIALS_KEY);
  const saveRememberedCredentials = (email: string, password: string) =>
    saveRememberedCredentialsToStorage(REMEMBER_CREDENTIALS_KEY, email, password);
  const clearRememberedCredentials = () => clearRememberedCredentialsStorage(REMEMBER_CREDENTIALS_KEY);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId]
  );
  const currentRuntimeNodeId = runtime?.node.id ?? null;
  const appVersion = resolveDesktopPlatformVersion(desktopStatus.platformTarget);
  const modeLocked = desktopStatus.status === "connecting" || desktopStatus.status === "connected" || desktopStatus.status === "disconnecting";
  const emergencyRuntimeActive =
    desktopStatus.status === "connected" ||
    desktopStatus.status === "connecting" ||
    desktopStatus.status === "disconnecting" ||
    desktopStatus.status === "error" ||
    Boolean(desktopStatus.activeSessionId) ||
    Boolean(desktopStatus.activePid);
  const subscriptionServerProbe = useMemo(() => toSubscriptionServerProbe(serverProbe), [serverProbe]);
  const {
    announcementReadRevision,
    forcedAnnouncement,
    hasUnreadAnnouncements,
    markPassiveAnnouncementsSeen,
    acknowledgeAnnouncement: syncAcknowledgeAnnouncement
  } = useAnnouncements({
    accessToken: session?.accessToken ?? null,
    announcements: bootstrap?.announcements ?? [],
    patchAnnouncements: (updater) => {
      setBootstrap((current) => (current ? { ...current, announcements: updater(current.announcements) } : current));
    },
    onUnauthorized: recoverSessionAfterUnauthorized,
    readError,
    notify: notifications.show
  });
  const {
    ticketCenterOpened,
    setTicketCenterOpened,
    ticketCreateMode,
    setTicketCreateMode,
    ticketList,
    setTicketList,
    selectedTicketId,
    setSelectedTicketId,
    ticketDetail,
    setTicketDetail,
    ticketDraft,
    setTicketDraft,
    ticketReplyDraft,
    setTicketReplyDraft,
    ticketCenterError,
    setTicketCenterError,
    ticketListBusy,
    ticketDetailBusy,
    ticketSubmitting,
    hasUnreadTickets,
    loadTicketList,
    loadTicketDetail,
    openTicketCenter,
    openTicketComposer,
    closeTicketComposer,
    handleCreateTicket,
    handleReplyTicket
  } = useSupportTickets({
    accessToken: session?.accessToken ?? null,
    onUnauthorized: recoverSessionAfterUnauthorized,
    readError,
    notify: notifications.show
  });
  const updateFlow = useUpdateFlow({
    appVersion,
    platformTarget: desktopStatus.platformTarget,
    accessToken: session?.accessToken ?? null,
    bootstrapVersion: bootstrap?.version ?? null,
    runtimeMirrorPrefix,
    updateChannel: UPDATE_CHANNEL,
    readError,
    notify: notifications.show,
    showError: showErrorToast,
    onUnauthorized: recoverSessionAfterUnauthorized,
    isPromptBlocked: () =>
      runtimeAssetsBusy || runtimeAssetsDialogOpened || announcementDrawerOpened || Boolean(forcedAnnouncement)
  });
  const {
    updatePlatform,
    updateCheckBusy,
    effectiveUpdate,
    forceUpdateRequired,
    updateDialogOpened,
    setUpdateDialogOpened,
    updateDownload,
    deferredUpdatePromptKeyRef,
    lastUpdatePromptVersionRef,
    describeUpdateDownload: readUpdateDownloadDescription,
    displayUpdateDownloadProgress: readUpdateDownloadProgress,
    runUpdateCheck: runUpdateCheckFromHook,
    handleManualUpdateCheck,
    handleUpdateDownload
  } = updateFlow;
  const runUpdateCheck = runUpdateCheckFromHook;
  const runUpdateCheckForAuth = async (input: import("./hooks/useAuthBootstrap").RunUpdateCheckInput) => {
    await runUpdateCheckFromHook(input);
  };
  const {
    runtimeAssets,
    runtimeAssetsReady,
    runtimeAssetsBusy,
    runtimeAssetsDialogOpened,
    setRuntimeAssetsDialogOpened,
    ensureRuntimeAssetsReady,
    handleRetryRuntimeAssets
  } = useRuntimeAssets({
    appVersion,
    platformTarget: desktopStatus.platformTarget,
    accessToken: session?.accessToken ?? null,
    runtimeMirrorPrefix,
    forceUpdateRequired,
    forcedAnnouncementActive: Boolean(forcedAnnouncement),
    updateDialogOpened,
    announcementDrawerOpened,
    updateDownloadPhase: updateDownload.phase,
    mirrorPrefixStorageKey: RUNTIME_COMPONENT_MIRROR_PREFIX_KEY,
    notify: notifications.show,
    onUnauthorized: recoverSessionAfterUnauthorized,
    readError
  });
  const {
    probeBusy,
    probeCooldownLeft,
    probeResults,
    setProbeResults,
    runProbe
  } = useNodeProbe({
    accessToken: session?.accessToken ?? null,
    nowMs: now,
    selectedNodeId: selectedNodeId ?? runtime?.node.id ?? null,
    readError,
    onUnauthorized: recoverSessionAfterUnauthorized,
    onError: showErrorToast,
    loadLastNodeId,
    pickNodeId: (targetNodes, preferredId, results) => pickNode(targetNodes, preferredId, results)?.id ?? null,
    pickAlternativeNodeId: (targetNodes, currentNodeId, results) =>
      pickAlternativeNode(targetNodes, currentNodeId, results)?.id ?? null,
    onSelectedNodeIdChange: setSelectedNodeId,
    onGuidance: handleNodeProbeGuidance
  });
  const runProbeForAuth = async (targetNodes: NodeSummaryDto[], auto: boolean, accessTokenOverride?: string) => {
    await runProbe(targetNodes, auto, accessTokenOverride);
  };
  const runUpdateCheckForActions = async (input: import("./hooks/useAuthBootstrap").RunUpdateCheckInput) => {
    await runUpdateCheck(input);
  };
  const loadTicketListForActions = async (preferredTicketId?: string | null) => {
    await loadTicketList(preferredTicketId);
  };
  const loadTicketDetailForActions = async (ticketId: string) => {
    await loadTicketDetail(ticketId);
  };
  const fallbackNode = useMemo(
    () => pickAlternativeNode(nodes, currentRuntimeNodeId ?? selectedNodeId, probeResults),
    [currentRuntimeNodeId, nodes, probeResults, selectedNodeId]
  );
  const subscriptionBlocked = isSubscriptionBlocked(bootstrap?.subscription ?? null);
  const selectedNodeOffline = selectedNode ? probeResults[selectedNode.id]?.status === "offline" : false;
  const runtimeDisplayError = useMemo(() => {
    if (!desktopStatus.lastError && !desktopStatus.reasonCode && !desktopStatus.recoveryHint) {
      return null;
    }
    const runtimeFailureText = composeRuntimeFailureText(desktopStatus);
    return (
      deriveGuidanceFromRuntimeFailure(runtimeFailureText, fallbackNode?.id ?? null)?.message ??
      desktopStatus.recoveryHint ??
      (desktopStatus.lastError ? readError(desktopStatus.lastError) : null)
    );
  }, [desktopStatus, fallbackNode?.id]);
  const canAttemptConnect =
    Boolean(selectedNode) &&
    nodes.length > 0 &&
    !forceUpdateRequired &&
    !subscriptionBlocked &&
    !selectedNodeOffline &&
    desktopStatus.status !== "connected" &&
    desktopStatus.status !== "connecting";
  const canConnect = canAttemptConnect && runtimeAssetsReady;
  const setConnectionGuidanceForAuth = setConnectionGuidance as Dispatch<
    SetStateAction<import("./hooks/useAuthBootstrap").ConnectionGuidanceLike | null>
  >;
  const setGuidanceDialogForAuth = setGuidanceDialog as Dispatch<
    SetStateAction<import("./hooks/useAuthBootstrap").ConnectionGuidanceLike | null>
  >;
  const clearResolvedGuidanceForAuth = clearResolvedGuidance as (
    current: import("./hooks/useAuthBootstrap").ConnectionGuidanceLike | null,
    subscription: SubscriptionStatusDto,
    nodes: NodeSummaryDto[]
  ) => import("./hooks/useAuthBootstrap").ConnectionGuidanceLike | null;
  const {
    bootstrapSession,
    clearSession,
    handleLogin,
    handleLogout,
    handleRefresh,
    mergeSubscriptionState,
    restoreStoredSession
  } = useAuthBootstrap({
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
    setConnectionGuidance: setConnectionGuidanceForAuth,
    setGuidanceDialog: setGuidanceDialogForAuth,
    setMode,
    setError,
    setCredentials,
    setAuthBusy,
    setRefreshing,
    setLogoutBusy,
    unauthorizedRecoveryTaskRef,
    refreshRuntime,
    forceStopLocalRuntime,
    runProbe: runProbeForAuth,
    runUpdateCheck: runUpdateCheckForAuth,
    pickNode,
    loadLastNodeId,
    resolveDefaultMode,
    clearResolvedGuidance: clearResolvedGuidanceForAuth,
    showErrorToast,
    readError,
    saveRememberedCredentials,
    clearRememberedCredentials
  });
  const {
    actionBusy,
    applyGuidance,
    handleRuntimeEvent,
    handlePrimaryAction,
    handleDisconnect,
    handleEmergencyDisconnect,
    handleForcedGuidance,
    syncForegroundState,
    dismissGuidanceDialog
  } = useRuntimeActions({
    session,
    bootstrap,
    setBootstrap,
    nodes,
    setNodes,
    selectedNode,
    selectedNodeId,
    setSelectedNodeId,
    mode,
    runtime,
    setRuntime,
    desktopStatus,
    setDesktopStatus,
    runtimeAssetsReady,
    runtimeAssets,
    ensureRuntimeAssetsReady,
    canAttemptConnect,
    canConnect,
    forceUpdateRequired,
    setUpdateDialogOpened,
    fallbackNodeId: fallbackNode?.id ?? null,
    probeResults,
    nodesRef,
    runtimeRef,
    selectedNodeIdRef,
    probeResultsRef,
    ticketCenterOpenedRef,
    ticketCreateModeRef,
    selectedTicketIdRef,
    leaseHeartbeatFailedAtRef,
    lastGuidanceToastRef,
    lastForegroundSyncErrorRef,
    connectionGuidance,
    setConnectionGuidance,
    guidanceDialog,
    setGuidanceDialog,
    readError,
    showErrorToast,
    notify: notifications.show,
    setServerProbe,
    mergeSubscriptionState,
    loadTicketList: loadTicketListForActions,
    loadTicketDetail: loadTicketDetailForActions,
    recoverSessionAfterUnauthorized,
    getCurrentAccessToken: () => sessionRef.current?.accessToken ?? null,
    clearSession,
    runUpdateCheck: runUpdateCheckForActions,
    refreshRuntime,
    forceStopLocalRuntime,
    loadLastNodeId,
    pickNode
  });

  useClientEvents({
    session,
    setServerProbe,
    handleRuntimeEvent,
    recoverSessionAfterUnauthorized,
    readError
  });

  const applyLeaseHeartbeatSuccess = useCallback(
    (lease: Awaited<ReturnType<typeof heartbeatSession>>, sessionId: string) => {
      leaseHeartbeatFailedAtRef.current = null;
      setConnectionGuidance((current) =>
        current &&
        (current.code === "session_replaced" ||
          current.code === "session_expired" ||
          current.code === "session_invalid" ||
          current.code === "admin_paused" ||
          current.code === "client_rotated")
          ? null
          : current
      );
      setRuntime((current) =>
        current && current.sessionId === sessionId ? { ...current, leaseExpiresAt: lease.leaseExpiresAt } : current
      );
    },
    []
  );

  const handleProtectedLeaseAccessRevoked = useCallback(
    async (reason: unknown) => {
      const accessReason = resolveProtectedAccessReason(getApiErrorRawMessage(reason));
      if (!accessReason) {
        return false;
      }
      const notice = buildProtectedAccessNotice(accessReason);
      await clearSession(true);
      notifications.show({
        color: "yellow",
        title: notice.title,
        message: notice.message,
        autoClose: 4000
      });
      return true;
    },
    [clearSession]
  );

  const attemptLeaseHeartbeat = useCallback(
    async (accessToken: string, sessionId: string) => {
      try {
        const lease = await heartbeatSession(accessToken, sessionId);
        applyLeaseHeartbeatSuccess(lease, sessionId);
        return "ok" as const;
      } catch (reason) {
        if (isAccessTokenExpiredApiError(reason)) {
          const recoveredSession = await recoverSessionAfterUnauthorized();
          const recoveredAccessToken =
            recoveredSession && recoveredSession.accessToken !== accessToken
              ? recoveredSession.accessToken
              : null;
          if (!recoveredAccessToken) {
            return "handled" as const;
          }
          const recoveredLease = await heartbeatSession(recoveredAccessToken, sessionId);
          applyLeaseHeartbeatSuccess(recoveredLease, sessionId);
          return "ok" as const;
        }
        if (isForbiddenApiError(reason)) {
          if (await handleProtectedLeaseAccessRevoked(reason)) {
            return "handled" as const;
          }
          const guidance =
            deriveGuidanceFromMessage(
              reason instanceof Error ? readError(reason.message) : "当前连接已失效，请重新连接",
              {
                fallbackNodeId: fallbackNode?.id ?? null
              }
            ) ??
            deriveGuidanceFromMessage("当前连接已失效，请重新连接", {
              fallbackNodeId: fallbackNode?.id ?? null
            });
          if (guidance) {
            leaseHeartbeatFailedAtRef.current = null;
            await handleForcedGuidance(guidance);
            return "handled" as const;
          }
        }
        throw reason;
      }
    },
    [
      applyLeaseHeartbeatSuccess,
      fallbackNode?.id,
      handleForcedGuidance,
      handleProtectedLeaseAccessRevoked,
      recoverSessionAfterUnauthorized
    ]
  );

  useEffect(() => {
    runtimeRef.current = runtime;
  }, [runtime]);

  useEffect(() => {
    bootstrapRef.current = bootstrap;
  }, [bootstrap]);

  useEffect(() => {
    if (!session || !bootstrap) {
      return;
    }
    if (desktopStatus.platformTarget === "android" || desktopStatus.platformTarget === "web") {
      return;
    }
    if (localStorage.getItem(DESKTOP_CLOSE_HINT_KEY) === "ack") {
      return;
    }
    if (forcedAnnouncement || announcementDrawerOpened || updateDialogOpened) {
      setCloseHintOpened(false);
      return;
    }
    setCloseHintOpened(true);
  }, [announcementDrawerOpened, bootstrap, desktopStatus.platformTarget, forcedAnnouncement, session, updateDialogOpened]);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    selectedNodeIdRef.current = selectedNodeId;
  }, [selectedNodeId]);

  useEffect(() => {
    ticketCenterOpenedRef.current = ticketCenterOpened;
  }, [ticketCenterOpened]);

  useEffect(() => {
    ticketCreateModeRef.current = ticketCreateMode;
  }, [ticketCreateMode]);

  useEffect(() => {
    selectedTicketIdRef.current = selectedTicketId;
  }, [selectedTicketId]);

  useEffect(() => {
    probeResultsRef.current = probeResults;
  }, [probeResults]);

  sessionRef.current = session;

  useEffect(() => {
    if (session) {
      return;
    }
    setServerProbe(createIdleServerProbeState());
    setTicketCenterOpened(false);
    setTicketCreateMode(false);
    setTicketList([]);
    setSelectedTicketId(null);
    setTicketDetail(null);
    setTicketCenterError(null);
    setTicketDraft({ title: "", body: "" });
    setTicketReplyDraft("");
  }, [session]);

  useEffect(() => {
    if (!session) {
      return;
    }
    setServerProbe((current) => ({
      status: "checking",
      elapsedMs: current.elapsedMs,
      checkedAt: current.checkedAt,
      errorMessage: null
    }));
  }, [session?.accessToken]);

  useEffect(() => {
    if (!session) {
      return;
    }
    void loadTicketList();
  }, [session?.accessToken]);

  const handleManualServerProbe = async () => {
    if (serverProbeBusy) {
      return;
    }
    try {
      setServerProbeBusy(true);
      setServerProbe((current) => ({
        status: "checking",
        elapsedMs: current.elapsedMs,
        checkedAt: current.checkedAt,
        errorMessage: null
      }));
      const result = await probeClientServerLatency();
      setServerProbe({
        status: result.elapsedMs !== null && result.elapsedMs >= 200 ? "slow" : "healthy",
        elapsedMs: result.elapsedMs,
        checkedAt: Date.now(),
        errorMessage: null
      });
    } catch (reason) {
      setServerProbe({
        status: "failed",
        elapsedMs: null,
        checkedAt: Date.now(),
        errorMessage: reason instanceof Error ? readError(reason.message) : "当前无法连接服务器"
      });
    } finally {
      setServerProbeBusy(false);
    }
  };

  useEffect(() => {
    if (!ticketCenterOpened || !session || !selectedTicketId || ticketCreateMode) {
      return;
    }
    void loadTicketDetail(selectedTicketId);
  }, [selectedTicketId, session?.accessToken, ticketCenterOpened, ticketCreateMode]);

  useEffect(() => {
    shellActionRef.current = async () => {
      if (!sessionRef.current) {
        notifications.show({
          color: "blue",
          title: "请先登录",
          message: "登录后才可以连接节点。"
        });
        void focusDesktopWindow();
        return;
      }
      await handlePrimaryAction();
    };
  });

  useEffect(() => {
    openLogsActionRef.current = () => {
      if (!sessionRef.current) {
        notifications.show({
          color: "blue",
          title: "请先登录",
          message: "登录后才可以查看连接诊断。"
        });
        void focusDesktopWindow();
        return;
      }
      setLogDrawerOpened(true);
      void focusDesktopWindow();
    };
  });

  useEffect(() => {
    if (desktopStatus.platformTarget === "android" || desktopStatus.platformTarget === "web") {
      return;
    }

    window.__CHORDV_DESKTOP_SHELL__ = {
      toggleConnection: () => {
        void shellActionRef.current?.();
      },
      openLogs: () => {
        openLogsActionRef.current?.();
      }
    };

    return () => {
      delete window.__CHORDV_DESKTOP_SHELL__;
    };
  }, [desktopStatus.platformTarget]);

  useEffect(() => {
    setRuntimeMirrorPrefix(localStorage.getItem(RUNTIME_COMPONENT_MIRROR_PREFIX_KEY) ?? "");
  }, []);

  useEffect(() => {
    const preventContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };

    window.addEventListener("contextmenu", preventContextMenu);
    return () => window.removeEventListener("contextmenu", preventContextMenu);
  }, []);

  useEffect(() => {
    void initializeApp();

    const runtimeTimer = window.setInterval(() => {
      void refreshRuntime();
    }, 2000);
    const clockTimer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(runtimeTimer);
      window.clearInterval(clockTimer);
    };
  }, []);

  useEffect(() => {
    if (!forcedAnnouncement) {
      setCountdown(0);
      return;
    }
    setCountdown(forcedAnnouncement.displayMode === "modal_countdown" ? forcedAnnouncement.countdownSeconds : 0);
  }, [forcedAnnouncement]);

  useEffect(() => {
    if (!forcedAnnouncement || forcedAnnouncement.displayMode !== "modal_countdown" || countdown <= 0) {
      return;
    }

    const timer = window.setTimeout(() => {
      setCountdown((current) => current - 1);
    }, 1000);

    return () => window.clearTimeout(timer);
  }, [forcedAnnouncement, countdown]);

  useEffect(() => {
    if (desktopStatus.platformTarget === "android" || desktopStatus.platformTarget === "web") {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;

    void subscribeDesktopShellActions((action) => {
      if (disposed) {
        return;
      }
      if (action === "toggle-connection") {
        void shellActionRef.current?.();
        return;
      }
      if (action === "open-logs") {
        openLogsActionRef.current?.();
      }
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
  }, [desktopStatus.platformTarget]);

  useEffect(() => {
    if (desktopStatus.platformTarget === "android" || desktopStatus.platformTarget === "web") {
      return;
    }

    const nodeName =
      runtime?.node.name ??
      selectedNode?.name ??
      (hasActivePlatformRuntime(desktopStatus) ? "连接恢复中" : null);

    const summaryLabel =
      !session
        ? "登录后连接"
        : desktopStatus.status === "connected" || desktopStatus.status === "error"
        ? "断开连接"
        : "连接";

    const summaryKey = JSON.stringify({
      status: session ? desktopStatus.status : "signed-out",
      signedIn: Boolean(session),
      nodeName,
      primaryActionLabel: summaryLabel
    });
    if (lastShellSummaryRef.current === summaryKey || pendingShellSummaryRef.current === summaryKey) {
      return;
    }
    const requestId = shellSummaryRequestSeqRef.current + 1;
    shellSummaryRequestSeqRef.current = requestId;
    pendingShellSummaryRef.current = summaryKey;

    void updateDesktopShellSummary({
      status: session ? desktopStatus.status : "signed-out",
      signedIn: Boolean(session),
      nodeName,
      primaryActionLabel: summaryLabel
    })
      .then(() => {
        if (shellSummaryRequestSeqRef.current !== requestId) {
          return;
        }
        lastShellSummaryRef.current = summaryKey;
        pendingShellSummaryRef.current = "";
      })
      .catch(() => {
        if (shellSummaryRequestSeqRef.current !== requestId) {
          return;
        }
        pendingShellSummaryRef.current = "";
      });
  }, [
    bootstrap?.subscription,
    connectionGuidance,
    desktopStatus.platformTarget,
    desktopStatus.status,
    desktopStatus.activeSessionId,
    desktopStatus.activePid,
    session,
    runtime?.node.name,
    selectedNode?.name,
    selectedNodeOffline
  ]);

  useEffect(() => {
    if (!session || desktopStatus.platformTarget !== "android") {
      return;
    }

    const syncOnForeground = () => {
      if (document.visibilityState === "hidden" || booting || authBusy || logoutBusy || refreshing || actionBusy) {
        return;
      }

      const nowMs = Date.now();
      if (nowMs - lastForegroundSyncAtRef.current < 3000) {
        return;
      }

      lastForegroundSyncAtRef.current = nowMs;
      void syncForegroundState(session.accessToken);
    };

    document.addEventListener("visibilitychange", syncOnForeground);
    window.addEventListener("focus", syncOnForeground);

    return () => {
      document.removeEventListener("visibilitychange", syncOnForeground);
      window.removeEventListener("focus", syncOnForeground);
    };
  }, [actionBusy, authBusy, booting, desktopStatus.platformTarget, logoutBusy, refreshing, session]);

  useEffect(() => {
    if (desktopStatus.platformTarget === "android" || desktopStatus.platformTarget === "web") {
      return;
    }
    if (!session?.accessToken || runtime || !desktopStatus.activeSessionId) {
      return;
    }

    let cancelled = false;

    void (async () => {
      const localRuntime = await loadActiveRuntimeConfig().catch(() => null);
      if (!localRuntime || localRuntime.sessionId !== desktopStatus.activeSessionId || cancelled) {
        return;
      }

      setRuntime(localRuntime);

      try {
        let serverRuntime = await fetchClientRuntime(session.accessToken, desktopStatus.activeSessionId);
        if (!serverRuntime || serverRuntime.sessionId !== desktopStatus.activeSessionId) {
          await new Promise((resolve) => window.setTimeout(resolve, 800));
          if (cancelled) {
            return;
          }
          serverRuntime = await fetchClientRuntime(session.accessToken, desktopStatus.activeSessionId);
        }
        if (cancelled) {
          return;
        }
        if (!serverRuntime || serverRuntime.sessionId !== desktopStatus.activeSessionId) {
          const guidance =
            deriveGuidanceFromMessage("当前连接已失效，请重新连接", {
              fallbackNodeId: fallbackNode?.id ?? null
            }) ??
            deriveGuidanceFromMessage("当前连接已失效，请重新连接", {
              fallbackNodeId: fallbackNode?.id ?? null
            });
          if (guidance) {
            setConnectionGuidance(guidance);
            notifications.show({
              color: "yellow",
              title: guidance.title,
              message: "服务端连接状态暂时未同步，本地连接将继续保留，请稍后再试。"
            });
          }
          return;
        }
        setRuntime((current) =>
          current && current.sessionId === serverRuntime.sessionId
            ? {
                ...current,
                leaseId: serverRuntime.leaseId,
                leaseExpiresAt: serverRuntime.leaseExpiresAt,
                leaseHeartbeatIntervalSeconds: serverRuntime.leaseHeartbeatIntervalSeconds,
                leaseGraceSeconds: serverRuntime.leaseGraceSeconds
              }
            : current
        );
      } catch (reason) {
        if (cancelled) {
          return;
        }
        if (isAccessTokenExpiredApiError(reason)) {
          await recoverSessionAfterUnauthorized();
          return;
        }
        if (isForbiddenApiError(reason)) {
          if (await handleProtectedLeaseAccessRevoked(reason)) {
            return;
          }
          const guidance =
            deriveGuidanceFromMessage(
              reason instanceof Error ? readError(reason.message) : "当前连接已失效，请重新连接",
              {
                fallbackNodeId: fallbackNode?.id ?? null
              }
            ) ??
            deriveGuidanceFromMessage("当前连接已失效，请重新连接", {
              fallbackNodeId: fallbackNode?.id ?? null
            });
          if (guidance) {
            setConnectionGuidance(guidance);
            notifications.show({
              color: "yellow",
              title: guidance.title,
              message: "服务端连接状态暂时未同步，本地连接将继续保留，请稍后再试。"
            });
          }
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    desktopStatus.activeSessionId,
    desktopStatus.platformTarget,
    fallbackNode?.id,
    handleProtectedLeaseAccessRevoked,
    notifications,
    recoverSessionAfterUnauthorized,
    runtime,
    setConnectionGuidance,
    session?.accessToken
  ]);

  useEffect(() => {
    if (desktopStatus.platformTarget === "android" || desktopStatus.platformTarget === "web") {
      return;
    }

    let disposed = false;
    let unlistenLease: (() => void) | null = null;
    let unlistenSession: (() => void) | null = null;

    void subscribeNativeLeaseHeartbeat((event) => {
      if (disposed || !event.sessionId) {
        return;
      }
        if (event.status === "ok") {
          leaseHeartbeatFailedAtRef.current = null;
          if (event.leaseExpiresAt) {
            const nextLeaseExpiresAt = event.leaseExpiresAt;
            setRuntime((current) =>
              current && current.sessionId === event.sessionId
              ? { ...current, leaseExpiresAt: nextLeaseExpiresAt }
              : current
            );
          }
        return;
      }

      const activeSessionId = runtimeRef.current?.sessionId ?? desktopStatus.activeSessionId;
      if (!activeSessionId || activeSessionId !== event.sessionId) {
        return;
      }

      if (event.reasonCode === "auth_invalid") {
        void (async () => {
          const recoveredSession = await recoverSessionAfterUnauthorized();
          if (recoveredSession) {
            return;
          }
          await clearSession(true);
          notifications.show({
            color: "yellow",
            title: "登录已失效",
            message: "当前登录态无法继续续租连接，请重新登录。"
          });
        })();
        return;
      }

      const guidance =
        deriveGuidanceFromMessage(event.message ?? "当前连接已失效，请重新连接", {
          fallbackNodeId: fallbackNode?.id ?? null
        }) ??
        deriveGuidanceFromMessage("当前连接已失效，请重新连接", {
          fallbackNodeId: fallbackNode?.id ?? null
        });
      if (guidance) {
        void handleForcedGuidance(guidance);
      }
    })
      .then((cleanup) => {
        if (disposed) {
          cleanup();
          return;
        }
        unlistenLease = cleanup;
      })
      .catch(() => null);

    void subscribeNativeSessionRefreshed((nextSession) => {
      if (disposed) {
        return;
      }
      setSession(nextSession);
    })
      .then((cleanup) => {
        if (disposed) {
          cleanup();
          return;
        }
        unlistenSession = cleanup;
      })
      .catch(() => null);

    return () => {
      disposed = true;
      unlistenLease?.();
      unlistenSession?.();
    };
  }, [
    clearSession,
    desktopStatus.activeSessionId,
    desktopStatus.platformTarget,
    fallbackNode?.id,
    handleForcedGuidance,
    recoverSessionAfterUnauthorized,
    setSession
  ]);

  useEffect(() => {
    if (booting || !session || !bootstrap) {
      return;
    }
    if (desktopStatus.platformTarget === "android" || desktopStatus.platformTarget === "web") {
      return;
    }
    if (!desktopStatus.activeSessionId || runtimeRef.current) {
      return;
    }
    void syncForegroundState(session.accessToken);
  }, [
    booting,
    bootstrap,
    desktopStatus.activeSessionId,
    desktopStatus.platformTarget,
    session,
    syncForegroundState
  ]);

  useEffect(() => {
    if (!session || !runtime || desktopStatus.status !== "connected") {
      leaseHeartbeatFailedAtRef.current = null;
      return;
    }
    if (desktopStatus.platformTarget !== "android" && desktopStatus.platformTarget !== "web") {
      leaseHeartbeatFailedAtRef.current = null;
      return;
    }

    const tick = async () => {
      try {
        const result = await attemptLeaseHeartbeat(session.accessToken, runtime.sessionId);
        if (result === "handled") {
          return;
        }
      } catch (reason) {
        const message = reason instanceof Error ? readError(reason.message) : "当前连接已失效，请重新连接";
        const immediateGuidance = deriveGuidanceFromMessage(message, {
          fallbackNodeId: fallbackNode?.id ?? null
        });
        if (immediateGuidance) {
          leaseHeartbeatFailedAtRef.current = null;
          await handleForcedGuidance(immediateGuidance);
          return;
        }
        const nowMs = Date.now();
        if (!leaseHeartbeatFailedAtRef.current) {
          leaseHeartbeatFailedAtRef.current = nowMs;
          return;
        }
        if (nowMs - leaseHeartbeatFailedAtRef.current >= runtime.leaseGraceSeconds * 1000) {
          await handleForcedGuidance({
            code: "session_invalid",
            tone: "warning",
            title: "连接已失效",
            message: "当前连接已失效，请重新连接。",
            actionLabel: "重新连接"
          });
          leaseHeartbeatFailedAtRef.current = null;
        }
      }
    };

    const intervalMs = Math.max(5, runtime.leaseHeartbeatIntervalSeconds) * 1000;
    const timer = window.setInterval(() => {
      void tick();
    }, intervalMs);
    void tick();

    return () => {
      window.clearInterval(timer);
    };
  }, [
    attemptLeaseHeartbeat,
    desktopStatus.status,
    runtime?.sessionId,
    runtime?.leaseHeartbeatIntervalSeconds,
    runtime?.leaseGraceSeconds,
    session?.accessToken,
    fallbackNode?.id
  ]);

  useEffect(() => {
    if (!session || !runtime || desktopStatus.status !== "connected") {
      return;
    }
    if (desktopStatus.platformTarget !== "android" && desktopStatus.platformTarget !== "web") {
      return;
    }

    let disposed = false;
    let unlistenWindowFocus: (() => void) | null = null;

    const syncLeaseOnResume = () => {
      if (disposed || document.visibilityState === "hidden" || booting || authBusy || logoutBusy || refreshing || actionBusy) {
        return;
      }
      const nowMs = Date.now();
      if (nowMs - lastLeaseResumeCheckAtRef.current < 3000) {
        return;
      }
      lastLeaseResumeCheckAtRef.current = nowMs;

      void (async () => {
        const activeSession = sessionRef.current;
        const activeRuntime = runtimeRef.current;
        if (!activeSession?.accessToken || !activeRuntime || desktopStatus.status !== "connected") {
          return;
        }
        try {
          await attemptLeaseHeartbeat(activeSession.accessToken, activeRuntime.sessionId);
        } catch (reason) {
          const guidance = deriveGuidanceFromMessage(
            reason instanceof Error ? readError(reason.message) : "当前连接已失效，请重新连接",
            {
              fallbackNodeId: fallbackNode?.id ?? null
            }
          );
          if (guidance) {
            leaseHeartbeatFailedAtRef.current = null;
            await handleForcedGuidance(guidance);
          }
        }
      })();
    };

    document.addEventListener("visibilitychange", syncLeaseOnResume);
    window.addEventListener("focus", syncLeaseOnResume);

    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().onFocusChanged(({ payload }) => {
        if (payload) {
          syncLeaseOnResume();
        }
      }))
      .then((unlisten) => {
        unlistenWindowFocus = unlisten;
      })
      .catch(() => null);

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", syncLeaseOnResume);
      window.removeEventListener("focus", syncLeaseOnResume);
      unlistenWindowFocus?.();
    };
  }, [
    actionBusy,
    attemptLeaseHeartbeat,
    authBusy,
    booting,
    desktopStatus.platformTarget,
    desktopStatus.status,
    fallbackNode?.id,
    handleForcedGuidance,
    logoutBusy,
    refreshing,
    runtime?.sessionId,
    session?.accessToken
  ]);

  useEffect(() => {
    if (actionBusy || desktopStatus.status !== "connected" || !bootstrap?.subscription) {
      return;
    }

    const subscriptionGuidance = deriveGuidanceFromSubscription(
      bootstrap.subscription,
      fallbackNode?.id ?? null
    );
    if (!subscriptionGuidance) {
      return;
    }

    void handleForcedGuidance(subscriptionGuidance);
  }, [
    actionBusy,
    bootstrap?.subscription,
    desktopStatus.status,
    fallbackNode?.id
  ]);

  useEffect(() => {
    if (actionBusy || desktopStatus.status !== "connected" || !runtime) {
      return;
    }
    if (nodes.some((node) => node.id === runtime.node.id)) {
      return;
    }

    void handleForcedGuidance({
      code: "node_access_revoked",
      tone: "warning",
      title: "当前节点已撤权",
      message: "当前节点已被取消授权，请切换其他可用节点后重新连接。",
      actionLabel: "切换节点后重连",
      recommendedNodeId: fallbackNode?.id ?? null
    });
  }, [actionBusy, desktopStatus.status, fallbackNode?.id, nodes, runtime]);

  useEffect(() => {
    if (!runtime || desktopStatus.status !== "connected" || actionBusy) {
      return;
    }
    const runtimeProbe = probeResults[runtime.node.id];
    if (!runtimeProbe || runtimeProbe.status !== "offline") {
      return;
    }

    void handleForcedGuidance({
      code: "node_unavailable",
      tone: "warning",
      title: "当前节点暂不可用",
      message: "当前节点无法连通，请切换其他可用节点后重新连接。",
      actionLabel: "切换节点后重连",
      recommendedNodeId: fallbackNode?.id ?? null
    });
  }, [actionBusy, desktopStatus.status, fallbackNode?.id, probeResults, runtime]);

  useEffect(() => {
    const guidance = deriveGuidanceFromRuntimeStatus(desktopStatus, fallbackNode?.id ?? null);
    if (!guidance || actionBusy || !shouldAutoHandleRuntimeGuidance(desktopStatus, runtime?.sessionId ?? null)) {
      lastRuntimeSignalKeyRef.current = null;
      return;
    }

    const key = guidanceKey(guidance);
    if (lastRuntimeSignalKeyRef.current === key) {
      return;
    }

    lastRuntimeSignalKeyRef.current = key;
    void handleForcedGuidance(guidance);
  }, [actionBusy, desktopStatus, fallbackNode?.id, runtime?.sessionId]);

  useEffect(() => {
    const status = bootstrap?.subscription.meteringStatus;
    const message = bootstrap?.subscription.meteringMessage ?? "计费待同步，正在等待节点统计恢复";
    if (status !== "degraded") {
      lastMeteringToastRef.current = null;
      return;
    }
    const key = `${bootstrap?.subscription.id ?? "subscription"}:${message}`;
    if (lastMeteringToastRef.current === key) {
      return;
    }
    lastMeteringToastRef.current = key;
    notifications.show({
      color: "yellow",
      title: "计量同步提醒",
      message,
      autoClose: 4000
    });
  }, [bootstrap?.subscription.id, bootstrap?.subscription.meteringMessage, bootstrap?.subscription.meteringStatus]);

  useEffect(() => {
    if (!deferredUpdatePromptKeyRef.current) {
      return;
    }
    if (updateDialogOpened || runtimeAssetsBusy || runtimeAssetsDialogOpened || forcedAnnouncement || announcementDrawerOpened) {
      return;
    }
    if (!effectiveUpdate?.hasUpdate) {
      deferredUpdatePromptKeyRef.current = null;
      return;
    }
    const promptKey = `${effectiveUpdate.latestVersion}:${effectiveUpdate.forceUpgrade ? "force" : "optional"}`;
    if (deferredUpdatePromptKeyRef.current !== promptKey) {
      deferredUpdatePromptKeyRef.current = null;
      return;
    }
    lastUpdatePromptVersionRef.current = promptKey;
    deferredUpdatePromptKeyRef.current = null;
    setUpdateDialogOpened(true);
  }, [
    announcementDrawerOpened,
    effectiveUpdate?.forceUpgrade,
    effectiveUpdate?.hasUpdate,
    effectiveUpdate?.latestVersion,
    forcedAnnouncement,
    runtimeAssetsBusy,
    runtimeAssetsDialogOpened,
    updateDialogOpened
  ]);

  useEffect(() => {
    if (session || booting || !emergencyRuntimeActive) {
      runtimeRescueTriggeredRef.current = false;
      return;
    }
    if (runtimeRescueTriggeredRef.current) {
      return;
    }
    runtimeRescueTriggeredRef.current = true;
    notifications.show({
      color: "yellow",
      title: "本地连接仍在运行",
      message: "登录态暂时不可用，请重新登录后继续接管当前连接，或手动断开。"
    });
  }, [booting, emergencyRuntimeActive, session]);

  useEffect(() => {
    if (desktopStatus.status !== "error" || !desktopStatus.lastError || actionBusy === "disconnect") {
      return;
    }

    const fallbackNodeId = pickAlternativeNode(
      nodesRef.current,
      runtimeRef.current?.node.id ?? selectedNodeIdRef.current,
      probeResultsRef.current
    )?.id ?? null;
    if (deriveGuidanceFromRuntimeStatus(desktopStatus, fallbackNodeId)) {
      return;
    }
    const guidance = deriveGuidanceFromRuntimeFailure(composeRuntimeFailureText(desktopStatus), fallbackNodeId);
    if (guidance) {
      applyGuidance(guidance, true, false);
      return;
    }

    showErrorToast(desktopStatus.lastError);
  }, [actionBusy, desktopStatus.lastError, desktopStatus.status]);

  useEffect(() => {
    if (booting || !session || !bootstrap) {
      return;
    }
    if (desktopStatus.platformTarget === "android" || desktopStatus.platformTarget === "web") {
      return;
    }
    if (runtimeAssets.phase !== "idle") {
      return;
    }
    const timer = window.setTimeout(() => {
      void ensureRuntimeAssetsReady({
        source: "startup",
        interactive: false,
        blockConnection: false
      });
    }, 400);
    return () => {
      window.clearTimeout(timer);
    };
  }, [booting, bootstrap, desktopStatus.platformTarget, ensureRuntimeAssetsReady, runtimeAssets.phase, session]);

  async function initializeApp() {
    try {
      const rememberedCredentials = loadRememberedCredentials();
      if (rememberedCredentials) {
        setCredentials(rememberedCredentials);
        setRememberPassword(true);
      }
      await refreshRuntime();
      const localRuntime = await loadActiveRuntimeConfig().catch(() => null);
      if (localRuntime?.sessionId) {
        setRuntime(localRuntime);
      }
      const restoredSession = await restoreStoredSession();
      if (restoredSession?.accessToken && localRuntime?.sessionId) {
        await syncForegroundState(restoredSession.accessToken).catch(() => null);
      }
      if (!restoredSession) {
        await runUpdateCheck({ source: "startup", silent: true });
      }
    } finally {
      await appReady().catch(() => null);
      window.requestAnimationFrame(() => {
        setBooting(false);
        window.requestAnimationFrame(() => {
          void focusDesktopWindow();
        });
      });
    }
  }

  async function recoverSessionAfterUnauthorized() {
    return recoverDesktopSessionAfterUnauthorized({
      taskRef: unauthorizedRecoveryTaskRef,
      currentSession: sessionRef.current,
      bootstrapSession: (nextSession) => bootstrapSession(nextSession, false, true, false),
      clearSession
    });
  }

  function handleNodeProbeGuidance(
    guidance: import("./hooks/useNodeProbe").NodeProbeGuidance,
    auto: boolean
  ) {
    applyGuidance(guidance as ConnectionGuidance, !auto, true);
  }

  function openAnnouncementDrawer() {
    setAnnouncementDrawerOpened(true);
    void markPassiveAnnouncementsSeen();
  }

  async function acknowledgeAnnouncement() {
    const acknowledged = await syncAcknowledgeAnnouncement(forcedAnnouncement ?? undefined);
    if (acknowledged) {
      setCountdown(0);
    }
  }

  async function acknowledgeCloseHint() {
    if (rememberCloseHint) {
      localStorage.setItem(DESKTOP_CLOSE_HINT_KEY, "ack");
    }
    setCloseHintOpened(false);
  }

  const mobilePlatformClassName =
    desktopStatus.platformTarget === "android"
      ? "desktop-app--mobile desktop-app--android"
      : desktopStatus.platformTarget === "ios"
        ? "desktop-app--mobile desktop-app--ios"
        : "";
  const loginMobileClassName =
    mobilePlatformClassName && (!session || !bootstrap) ? " desktop-app--mobile-login" : "";
  const appClassName = `desktop-app${mobilePlatformClassName ? ` ${mobilePlatformClassName}` : ""}${loginMobileClassName}`;
  const mobileHomeMode = Boolean(session && bootstrap && mobilePlatformClassName);
  const forceUpdateBanner =
    forceUpdateRequired && effectiveUpdate?.hasUpdate ? (
      <Alert color={forceUpdateRequired ? "red" : "blue"}>
        <Stack gap={8}>
          <Text size="sm">
            {`当前版本 ${formatVersionLabel(appVersion)} 已低于最低支持版本，请先升级到 ${formatVersionLabel(
              effectiveUpdate.latestVersion
            )} 后再继续使用。`}
          </Text>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button size="xs" variant="white" onClick={() => setUpdateDialogOpened(true)}>
              查看更新说明
            </Button>
            {effectiveUpdate.downloadUrl ? (
              <Button
                size="xs"
                variant={forceUpdateRequired ? "filled" : "light"}
                loading={updateDownload.phase === "preparing" || updateDownload.phase === "downloading"}
                onClick={() => void handleUpdateDownload()}
              >
                {updateActionLabel(effectiveUpdate, updateDownload)}
              </Button>
            ) : null}
          </div>
        </Stack>
      </Alert>
    ) : null;

  return (
    <div className={appClassName}>
      <LoadingOverlay visible={booting} zIndex={200} overlayProps={{ blur: 1 }} />
      {runtimeAssets.phase !== "idle" && runtimeAssets.phase !== "ready" ? (
        <div className="desktop-runtime-overlay">
          <div className="desktop-runtime-overlay__inner">
            <RuntimeAssetsBanner
              state={runtimeAssets}
              onRetry={runtimeAssets.phase === "failed" ? handleRetryRuntimeAssets : null}
            />
          </div>
        </div>
      ) : null}

      {!session || !bootstrap ? (
        <LoginScreen
          email={credentials.email}
          password={credentials.password}
          rememberPassword={rememberPassword}
          loading={authBusy}
          error={null}
          emergencyRuntimeActive={emergencyRuntimeActive}
          emergencyRuntimeBusy={actionBusy === "disconnect"}
          emergencyRuntimeMessage={
            runtimeDisplayError
              ? `当前运行状态：${runtimeDisplayError}`
              : "登录态缺失时，你仍然可以先停止本地内核，确保代理和网络恢复正常。"
          }
          onEmailChange={(value) => setCredentials((current) => ({ ...current, email: value }))}
          onPasswordChange={(value) => setCredentials((current) => ({ ...current, password: value }))}
          onRememberPasswordChange={(checked) => {
            setRememberPassword(checked);
            if (!checked) {
              clearRememberedCredentials();
            }
          }}
          onSubmit={() => void handleLogin()}
          onEmergencyDisconnect={() => void handleEmergencyDisconnect()}
        />
      ) : mobileHomeMode ? (
        <div className="desktop-main desktop-main--mobile-home">
          {forceUpdateBanner ? <div className="desktop-mobile-home__notice">{forceUpdateBanner}</div> : null}

          <div className="desktop-mobile-home__screen">
            {mobileTab === "home" ? (
              <div className="desktop-mobile-home__stack">
                <ControlPanel
                  modes={bootstrap.policies.modes}
                  mode={mode}
                  canConnect={canConnect}
                  modeLocked={modeLocked}
                  primaryBusy={actionBusy !== null}
                  primaryLabel={primaryButtonLabel(
                    desktopStatus.status,
                    bootstrap.subscription,
                    connectionGuidance,
                    selectedNodeOffline,
                    runtimeAssets,
                    desktopStatus.platformTarget
                  )}
                  desktopStatus={desktopStatus}
                  runtime={runtime}
                  error={runtimeDisplayError}
                  runtimeAssetsPhase={runtimeAssets.phase}
                  onModeChange={setMode}
                  onPrimaryAction={() => void handlePrimaryAction()}
                  onOpenLogs={() => setLogDrawerOpened(true)}
                />
              </div>
            ) : mobileTab === "nodes" ? (
              <div className="desktop-mobile-home__stack">
                <NodeListPanel
                  nodes={nodes}
                  selectedNodeId={selectedNodeId}
                  probeResults={probeResults}
                  probeBusy={probeBusy}
                  probeCooldownLeft={probeCooldownLeft}
                  onSelect={(nodeId) => {
                    setSelectedNodeId(nodeId);
                    setConnectionGuidance((current) => {
                      const nextGuidance =
                        current && (current.code === "node_access_revoked" || current.code === "node_unavailable") ? null : current;
                      if (!nextGuidance) {
                        setGuidanceDialog(null);
                      }
                      return nextGuidance;
                    });
                  }}
                  onProbe={() => void runProbe(nodes, false)}
                />
              </div>
            ) : (
              <div className="desktop-mobile-home__stack">
                <div className="desktop-mobile-profile__header">
                  <div>
                    <Text className="desktop-mobile-profile__eyebrow">个人中心</Text>
                    <Text className="desktop-mobile-profile__title">账号与流量</Text>
                  </div>
                </div>

                <SubscriptionPanel
                  bootstrap={bootstrap}
                  hasUnreadAnnouncements={hasUnreadAnnouncements}
                  hasUnreadTickets={hasUnreadTickets}
                  refreshing={refreshing}
                  updateBusy={updateCheckBusy}
                  hasUpdate={Boolean(effectiveUpdate?.hasUpdate)}
                  serverProbe={subscriptionServerProbe}
                  serverProbeBusy={serverProbeBusy}
                  onRefreshServerProbe={() => void handleManualServerProbe()}
                  onOpenAnnouncements={openAnnouncementDrawer}
                  onOpenTickets={openTicketCenter}
                  onRefresh={() => void handleRefresh()}
                  onCheckUpdate={() => void handleManualUpdateCheck()}
                  onLogout={() => void handleLogout()}
                />
              </div>
            )}
          </div>

          <div className="desktop-mobile-nav" role="tablist" aria-label="移动端主导航">
            <UnstyledButton
              type="button"
              className={`desktop-mobile-nav__item${mobileTab === "home" ? " desktop-mobile-nav__item--active" : ""}`}
              onClick={() => setMobileTab("home")}
            >
              <ThemeIcon
                size={34}
                radius="xl"
                variant={mobileTab === "home" ? "filled" : "light"}
                color={mobileTab === "home" ? "cyan" : "gray"}
              >
                <IconHome2 size={18} />
              </ThemeIcon>
              <span className="desktop-mobile-nav__label">首页</span>
            </UnstyledButton>

            <UnstyledButton
              type="button"
              className={`desktop-mobile-nav__item${mobileTab === "nodes" ? " desktop-mobile-nav__item--active" : ""}`}
              onClick={() => setMobileTab("nodes")}
            >
              <ThemeIcon
                size={34}
                radius="xl"
                variant={mobileTab === "nodes" ? "filled" : "light"}
                color={mobileTab === "nodes" ? "cyan" : "gray"}
              >
                <IconStack2 size={18} />
              </ThemeIcon>
              <span className="desktop-mobile-nav__label">节点</span>
            </UnstyledButton>

            <UnstyledButton
              type="button"
              className={`desktop-mobile-nav__item${mobileTab === "profile" ? " desktop-mobile-nav__item--active" : ""}`}
              onClick={() => setMobileTab("profile")}
            >
              <ThemeIcon
                size={34}
                radius="xl"
                variant={mobileTab === "profile" ? "filled" : "light"}
                color={mobileTab === "profile" ? "cyan" : "gray"}
              >
                <IconUserCircle size={18} />
              </ThemeIcon>
              <span className="desktop-mobile-nav__label">个人</span>
            </UnstyledButton>
          </div>
        </div>
      ) : (
        <div className="desktop-main">
          <Stack gap="sm">
            <SubscriptionPanel
              bootstrap={bootstrap}
              hasUnreadAnnouncements={hasUnreadAnnouncements}
              hasUnreadTickets={hasUnreadTickets}
              refreshing={refreshing}
              updateBusy={updateCheckBusy}
              hasUpdate={Boolean(effectiveUpdate?.hasUpdate)}
              serverProbe={subscriptionServerProbe}
              serverProbeBusy={serverProbeBusy}
              onRefreshServerProbe={() => void handleManualServerProbe()}
              onOpenAnnouncements={openAnnouncementDrawer}
              onOpenTickets={openTicketCenter}
              onRefresh={() => void handleRefresh()}
              onCheckUpdate={() => void handleManualUpdateCheck()}
              onLogout={() => void handleLogout()}
            />
            {forceUpdateBanner}
          </Stack>

          <div className="desktop-content">
            <NodeListPanel
              nodes={nodes}
              selectedNodeId={selectedNodeId}
              probeResults={probeResults}
              probeBusy={probeBusy}
              probeCooldownLeft={probeCooldownLeft}
              onSelect={(nodeId) => {
                setSelectedNodeId(nodeId);
                setConnectionGuidance((current) => {
                  const nextGuidance =
                    current && (current.code === "node_access_revoked" || current.code === "node_unavailable") ? null : current;
                  if (!nextGuidance) {
                    setGuidanceDialog(null);
                  }
                  return nextGuidance;
                });
              }}
              onProbe={() => void runProbe(nodes, false)}
            />

            <ControlPanel
              modes={bootstrap.policies.modes}
              mode={mode}
              canConnect={canConnect}
              modeLocked={modeLocked}
              primaryBusy={actionBusy !== null}
              primaryLabel={primaryButtonLabel(
                desktopStatus.status,
                bootstrap.subscription,
                connectionGuidance,
                selectedNodeOffline,
                runtimeAssets,
                desktopStatus.platformTarget
              )}
              desktopStatus={desktopStatus}
              runtime={runtime}
              error={runtimeDisplayError}
              runtimeAssetsPhase={runtimeAssets.phase}
              onModeChange={setMode}
              onPrimaryAction={() => void handlePrimaryAction()}
              onOpenLogs={() => setLogDrawerOpened(true)}
            />
          </div>
        </div>
      )}

      <AnnouncementDrawer
        opened={announcementDrawerOpened}
        announcements={bootstrap?.announcements ?? []}
        onClose={() => setAnnouncementDrawerOpened(false)}
      />
      <LogDrawer opened={logDrawerOpened} log={runtimeLog} onClose={() => setLogDrawerOpened(false)} />
      <TicketCenterModal
        opened={ticketCenterOpened}
        email={bootstrap?.user.email ?? ""}
        tickets={ticketList}
        selectedTicketId={selectedTicketId}
        ticketDetail={ticketDetail}
        listBusy={ticketListBusy}
        detailBusy={ticketDetailBusy}
        submitting={ticketSubmitting}
        createMode={ticketCreateMode}
        error={ticketCenterError}
        createTitle={ticketDraft.title}
        createBody={ticketDraft.body}
        replyBody={ticketReplyDraft}
        onClose={() => setTicketCenterOpened(false)}
        onRefresh={() => void loadTicketList(selectedTicketId)}
        onOpenCreate={openTicketComposer}
        onCancelCreate={closeTicketComposer}
        onSelectTicket={(ticketId) => {
          setTicketCreateMode(false);
          setSelectedTicketId(ticketId);
          setTicketReplyDraft("");
        }}
        onCreateTitleChange={(value) => setTicketDraft((current) => ({ ...current, title: value }))}
        onCreateBodyChange={(value) => setTicketDraft((current) => ({ ...current, body: value }))}
        onReplyBodyChange={setTicketReplyDraft}
        onSubmitCreate={() => void handleCreateTicket()}
        onSubmitReply={() => void handleReplyTicket()}
      />

      <Modal
        opened={closeHintOpened}
        onClose={() => setCloseHintOpened(false)}
        centered
        title="关闭窗口说明"
      >
        <Stack gap="md">
          <Alert color="blue" variant="light">
            {desktopStatus.platformTarget === "windows"
              ? "点击窗口关闭按钮后，ChordV 会缩到系统托盘继续运行。你可以从右下角托盘重新打开，真正退出请使用托盘菜单里的“退出 ChordV”。"
              : "点击窗口关闭按钮后，ChordV 会隐藏窗口并继续在后台运行。你可以从顶部菜单栏或 Dock 恢复窗口，真正退出请使用菜单里的“退出 ChordV”。"}
          </Alert>
          <Checkbox
            checked={rememberCloseHint}
            onChange={(event) => setRememberCloseHint(event.currentTarget.checked)}
            label="下次不再提示"
          />
          <Button size="lg" onClick={() => void acknowledgeCloseHint()}>
            我知道了
          </Button>
        </Stack>
      </Modal>

      <Modal
        opened={guidanceDialog !== null}
        onClose={dismissGuidanceDialog}
        centered
        title={guidanceDialog?.title ?? ""}
      >
        <Stack gap="md">
          <Alert color={toneToToastColor(guidanceDialog?.tone ?? "info")} variant="light">
            {guidanceDialog?.message}
          </Alert>
          {guidanceDialog?.errorCode ? (
            <Text size="sm" c="dimmed">
              错误代码：{guidanceDialog.errorCode}
            </Text>
          ) : null}
          <Button size="lg" onClick={dismissGuidanceDialog}>
            {guidanceDialog?.actionLabel ?? "我知道了"}
          </Button>
        </Stack>
      </Modal>

      <Modal
        opened={runtimeAssetsDialogOpened}
        onClose={() => setRuntimeAssetsDialogOpened(false)}
        centered
        title="必要内核组件未就绪"
        withCloseButton
        closeOnClickOutside
        closeOnEscape
      >
        <Stack gap="md">
          <Alert color="red" variant="light">
            {runtimeAssets.errorMessage ?? "必要内核组件下载失败，当前暂时不能连接。"}
          </Alert>
          {runtimeAssets.errorCode ? (
            <Text size="sm" c="dimmed">
              错误代码：{runtimeAssets.errorCode}
            </Text>
          ) : null}
          <TextInput
            label="自定义下载加速前缀"
            placeholder="例如 https://ghfast.top/"
            value={runtimeMirrorPrefix}
            onChange={(event) => setRuntimeMirrorPrefix(event.currentTarget.value)}
          />
          <Text size="sm" c="dimmed">
            如果默认下载地址在当前网络下较慢或无法访问，可以填写自己的加速前缀后再重试。
          </Text>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <Button
              variant="default"
              onClick={async () => {
                const content = [
                  runtimeAssets.errorCode ? `错误代码：${runtimeAssets.errorCode}` : null,
                  runtimeAssets.errorMessage
                ]
                  .filter(Boolean)
                  .join("\n");
                await navigator.clipboard.writeText(content);
                notifications.show({
                  color: "blue",
                  title: "错误信息已复制",
                  message: "现在可以直接把错误信息发给管理员或开发者。"
                });
              }}
            >
              复制错误信息
            </Button>
            <Button variant="default" onClick={() => setRuntimeAssetsDialogOpened(false)}>
              稍后重试
            </Button>
            <Button onClick={handleRetryRuntimeAssets}>重试下载</Button>
          </div>
        </Stack>
      </Modal>

      <Modal
        opened={updateDialogOpened && effectiveUpdate !== null}
        onClose={() => {
          if (!forceUpdateRequired) {
            setUpdateDialogOpened(false);
          }
        }}
        centered
        title={effectiveUpdate?.title ?? "版本更新"}
        withCloseButton={!forceUpdateRequired}
        closeOnClickOutside={!forceUpdateRequired}
        closeOnEscape={!forceUpdateRequired}
      >
        <Stack gap="md">
          <Alert color={forceUpdateRequired ? "red" : "blue"} variant="light">
            {forceUpdateRequired
              ? "当前版本已低于最低支持版本，必须先升级客户端后再继续使用。"
              : "下载完成后自动打开安装程序，再由你手动完成安装。"}
          </Alert>
          <Text size="sm" c="dimmed">
            当前版本：{formatVersionLabel(appVersion)}
          </Text>
          <Text size="sm" c="dimmed">
            最新版本：{formatVersionLabel(effectiveUpdate?.latestVersion ?? appVersion)}
          </Text>
          <Text size="sm" c="dimmed">
            最低支持：{formatVersionLabel(effectiveUpdate?.minimumVersion ?? appVersion)}
          </Text>
          <Text size="sm" c="dimmed">
            发布渠道：正式版，仓库地址（<a href="https://github.com/achordchan" target="_blank" rel="noopener noreferrer">github.com/achordchan</a>）
          </Text>
          {effectiveUpdate?.deliveryMode === "desktop_installer_download" && updateDownload.phase !== "idle" ? (
            <Stack gap={6}>
              <Text fw={600}>安装器下载</Text>
              <Text size="sm" c="dimmed">
                新版本会先在应用内下载完整安装器，下载完成后自动打开 {updatePlatform === "windows" ? "Setup 安装程序" : "DMG 安装包"}，再由你手动完成安装。
              </Text>
              <Progress
                value={readUpdateDownloadProgress()}
                animated={updateDownload.phase === "downloading"}
                striped={updateDownload.phase === "downloading"}
              />
              <Text size="sm" c="dimmed">
                {readUpdateDownloadDescription()}
              </Text>
            </Stack>
          ) : null}
          <Stack gap={6}>
            <Text fw={600}>更新内容</Text>
            {effectiveUpdate?.changelog.length ? (
              effectiveUpdate.changelog.map((item, index) => (
                <Text key={`${item}-${index}`} size="sm">
                  {index + 1}. {item}
                </Text>
              ))
            ) : (
              <Text size="sm" c="dimmed">
                本次版本暂未填写更新日志。
              </Text>
            )}
          </Stack>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
            {!forceUpdateRequired ? (
              <Button
                variant="default"
                disabled={updateDownload.phase === "preparing" || updateDownload.phase === "downloading"}
                onClick={() => setUpdateDialogOpened(false)}
              >
                稍后再说
              </Button>
            ) : null}
            {effectiveUpdate?.downloadUrl ? (
              <Button
                loading={updateDownload.phase === "preparing" || updateDownload.phase === "downloading"}
                onClick={() => void handleUpdateDownload()}
              >
                {updateActionLabel(effectiveUpdate, updateDownload)}
              </Button>
            ) : (
              <Button disabled>暂无下载地址</Button>
            )}
          </div>
        </Stack>
      </Modal>

      <Modal
        opened={forcedAnnouncement !== null}
        onClose={() => {}}
        withCloseButton={false}
        closeOnEscape={false}
        closeOnClickOutside={false}
        centered
        title={forcedAnnouncement?.title ?? ""}
      >
        <Stack>
          <Text>{forcedAnnouncement?.body}</Text>
          {forcedAnnouncement?.displayMode === "modal_countdown" ? (
            <Text size="sm" c="dimmed">
              请等待 {countdown} 秒后确认
            </Text>
          ) : null}
          <Button
            size="lg"
            disabled={forcedAnnouncement?.displayMode === "modal_countdown" && countdown > 0}
            onClick={acknowledgeAnnouncement}
          >
            {forcedAnnouncement?.displayMode === "modal_countdown" && countdown > 0 ? `请等待 ${countdown}s` : "我知道了"}
          </Button>
        </Stack>
      </Modal>
    </div>
  );
}
