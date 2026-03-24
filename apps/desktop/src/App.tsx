import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Checkbox, LoadingOverlay, Modal, Progress, Stack, Text, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type {
  AnnouncementDto,
  AuthSessionDto,
  ClientBootstrapDto,
  ClientSupportTicketDetailDto,
  ClientSupportTicketSummaryDto,
  ClientVersionDto,
  ClientRuntimeEventDto,
  ConnectionMode,
  GeneratedRuntimeConfigDto,
  NodeSummaryDto,
  SubscriptionStatusDto
} from "@chordv/shared";
import {
  checkClientUpdate,
  type ClientUpdateArtifact,
  type ClientUpdateCheckResult,
  connectSession,
  disconnectSession,
  fetchBootstrap,
  fetchClientRuntime,
  fetchNodeProbes,
  fetchNodes,
  fetchRuntimeComponentsPlan,
  fetchSupportTicketDetail,
  fetchSupportTickets,
  markAnnouncementsRead,
  markSupportTicketRead,
  probeClientServerLatency,
  reportRuntimeComponentFailure,
  fetchSubscription,
  heartbeatSession,
  login,
  logoutSession,
  createSupportTicket,
  refreshSession,
  replySupportTicket,
  subscribeClientEvents
} from "./api/client";
import { AnnouncementDrawer } from "./components/AnnouncementDrawer";
import { ControlPanel } from "./components/ControlPanel";
import { LogDrawer } from "./components/LogDrawer";
import { LoginScreen } from "./components/LoginScreen";
import { NodeListPanel } from "./components/NodeListPanel";
import { RuntimeAssetsBanner } from "./components/RuntimeAssetsBanner";
import { SubscriptionPanel, type SubscriptionServerProbe } from "./components/SubscriptionPanel";
import { TicketCenterModal } from "./components/TicketCenterModal";
import {
  appReady,
  clearStoredSession,
  connectRuntime,
  createIdleRuntimeStatus,
  downloadRuntimeComponent,
  detectRuntimePlatform,
  downloadDesktopInstaller,
  disconnectRuntime,
  focusDesktopWindow,
  hasActivePlatformRuntime,
  checkRuntimeComponentFile,
  loadDesktopRuntimeEnvironment,
  loadRuntimeLogs,
  loadRuntimeStatus,
  openDesktopInstaller,
  openExternalLink,
  loadStoredSession,
  saveStoredSession,
  subscribeDesktopShellActions,
  subscribeRuntimeComponentDownloadProgress,
  subscribeDesktopUpdateDownloadProgress,
  updateDesktopShellSummary,
  type RuntimeNodeProbeResult,
  type RuntimeStatus,
  type DesktopUpdateDownloadProgress
} from "./lib/runtime";
import { resolveDesktopPlatformVersion } from "./lib/platformVersion";
import {
  createIdleRuntimeAssetsState,
  type RuntimeAssetsUiState,
  type RuntimeComponentDownloadItem,
  type RuntimeComponentDownloadProgress,
  type RuntimeDownloadFailureReason
} from "./lib/runtimeComponents";
const PROBE_COOLDOWN_MS = 25000;
const LAST_NODE_KEY = "chordv_last_node_id";
const REMEMBER_CREDENTIALS_KEY = "chordv_remember_credentials";
const DESKTOP_CLOSE_HINT_KEY = "chordv_desktop_close_hint_ack";
const RUNTIME_COMPONENT_MIRROR_PREFIX_KEY = "chordv_runtime_component_mirror_prefix";
const UPDATE_CHANNEL = "stable";

type GuidanceTone = "danger" | "warning" | "info";
type ConnectionGuidanceCode =
  | "admin_paused"
  | "node_access_revoked"
  | "node_unavailable"
  | "subscription_expired"
  | "subscription_exhausted"
  | "subscription_paused"
  | "session_replaced"
  | "session_expired"
  | "session_invalid"
  | "team_access_revoked"
  | "account_disabled"
  | "client_rotated"
  | "desktop_external_vpn_conflict"
  | "desktop_external_proxy_conflict"
  | "windows_proxy_failed"
  | "windows_local_proxy_failed"
  | "android_vpn_permission_denied"
  | "android_vpn_setup_failed"
  | "android_runtime_start_failed"
  | "android_connectivity_failed"
  | "runtime_exited";

type ConnectionGuidance = {
  code: ConnectionGuidanceCode;
  tone: GuidanceTone;
  title: string;
  message: string;
  actionLabel: string;
  recommendedNodeId?: string | null;
  errorCode?: string | null;
};

type UpdateDownloadState = {
  phase: "idle" | "preparing" | "downloading" | "completed" | "failed";
  fileName: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  localPath: string | null;
  message: string | null;
};

type ServerProbeState = {
  status: "idle" | "checking" | "healthy" | "slow" | "failed";
  elapsedMs: number | null;
  checkedAt: number | null;
  errorMessage: string | null;
};

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
  const [desktopStatus, setDesktopStatus] = useState<RuntimeStatus>(createIdleRuntimeStatus());
  const [runtimeLog, setRuntimeLog] = useState("");
  const [booting, setBooting] = useState(true);
  const [authBusy, setAuthBusy] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState<"connect" | "disconnect" | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);
  const [probeCooldownUntil, setProbeCooldownUntil] = useState(0);
  const [probeResults, setProbeResults] = useState<Record<string, RuntimeNodeProbeResult>>({});
  const [logDrawerOpened, setLogDrawerOpened] = useState(false);
  const [announcementDrawerOpened, setAnnouncementDrawerOpened] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credentials, setCredentials] = useState({ email: "", password: "" });
  const [rememberPassword, setRememberPassword] = useState(false);
  const [forcedAnnouncement, setForcedAnnouncement] = useState<AnnouncementDto | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [announcementReadRevision, setAnnouncementReadRevision] = useState(0);
  const [connectionGuidance, setConnectionGuidance] = useState<ConnectionGuidance | null>(null);
  const [guidanceDialog, setGuidanceDialog] = useState<ConnectionGuidance | null>(null);
  const [closeHintOpened, setCloseHintOpened] = useState(false);
  const [rememberCloseHint, setRememberCloseHint] = useState(true);
  const [updateCheckBusy, setUpdateCheckBusy] = useState(false);
  const [updateCheckResult, setUpdateCheckResult] = useState<ClientUpdateCheckResult | null>(null);
  const [updateDialogOpened, setUpdateDialogOpened] = useState(false);
  const [updateDownload, setUpdateDownload] = useState<UpdateDownloadState>(createIdleUpdateDownloadState());
  const [indeterminateUpdateProgress, setIndeterminateUpdateProgress] = useState(18);
  const [serverProbe, setServerProbe] = useState<ServerProbeState>(createIdleServerProbeState());
  const [runtimeAssets, setRuntimeAssets] = useState<RuntimeAssetsUiState>(createIdleRuntimeAssetsState());
  const [runtimeAssetsDialogOpened, setRuntimeAssetsDialogOpened] = useState(false);
  const [runtimeMirrorPrefix, setRuntimeMirrorPrefix] = useState("");
  const [ticketCenterOpened, setTicketCenterOpened] = useState(false);
  const [ticketCreateMode, setTicketCreateMode] = useState(false);
  const [ticketList, setTicketList] = useState<ClientSupportTicketSummaryDto[]>([]);
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [ticketDetail, setTicketDetail] = useState<ClientSupportTicketDetailDto | null>(null);
  const [ticketListBusy, setTicketListBusy] = useState(false);
  const [ticketDetailBusy, setTicketDetailBusy] = useState(false);
  const [ticketSubmitting, setTicketSubmitting] = useState(false);
  const [ticketCenterError, setTicketCenterError] = useState<string | null>(null);
  const [ticketDraft, setTicketDraft] = useState({ title: "", body: "" });
  const [ticketReplyDraft, setTicketReplyDraft] = useState("");
  const leaseHeartbeatFailedAtRef = useRef<number | null>(null);
  const lastMeteringToastRef = useRef<string | null>(null);
  const lastGuidanceToastRef = useRef<string | null>(null);
  const lastRuntimeSignalKeyRef = useRef<string | null>(null);
  const lastForegroundSyncErrorRef = useRef<string | null>(null);
  const lastForegroundSyncAtRef = useRef(0);
  const lastServerProbeForegroundAtRef = useRef(0);
  const localStopInFlightRef = useRef<Promise<void> | null>(null);
  const runtimeRescueTriggeredRef = useRef(false);
  const runtimeRef = useRef<GeneratedRuntimeConfigDto | null>(null);
  const nodesRef = useRef<NodeSummaryDto[]>([]);
  const selectedNodeIdRef = useRef<string | null>(null);
  const probeResultsRef = useRef<Record<string, RuntimeNodeProbeResult>>({});
  const shellActionRef = useRef<(() => Promise<void>) | null>(null);
  const openLogsActionRef = useRef<(() => void) | null>(null);
  const sessionRef = useRef<AuthSessionDto | null>(null);
  const lastUpdatePromptVersionRef = useRef<string | null>(null);
  const runtimeAssetsTaskRef = useRef<Promise<boolean> | null>(null);
  const deferredUpdatePromptKeyRef = useRef<string | null>(null);
  const lastShellSummaryRef = useRef("");
  const pendingShellSummaryRef = useRef("");
  const shellSummaryRequestSeqRef = useRef(0);
  const runtimeRefreshRequestSeqRef = useRef(0);
  const serverProbeRequestSeqRef = useRef(0);
  const lastKnownUpdateArtifactRef = useRef<ClientUpdateArtifact | null>(null);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId]
  );
  const currentRuntimeNodeId = runtime?.node.id ?? null;
  const fallbackNode = useMemo(
    () => pickAlternativeNode(nodes, currentRuntimeNodeId ?? selectedNodeId, probeResults),
    [currentRuntimeNodeId, nodes, probeResults, selectedNodeId]
  );
  const probeCooldownLeft = Math.max(0, Math.ceil((probeCooldownUntil - now) / 1000));
  const updatePlatform = resolveUpdatePlatform(desktopStatus.platformTarget);
  const appVersion = resolveDesktopPlatformVersion(desktopStatus.platformTarget);
  const effectiveUpdate = useMemo(
    () =>
      updateCheckResult ??
      createLegacyUpdateResult(
        bootstrap?.version ?? null,
        updatePlatform,
        appVersion,
        runtimeMirrorPrefix,
        lastKnownUpdateArtifactRef.current
      ),
    [appVersion, bootstrap?.version, runtimeMirrorPrefix, updateCheckResult, updatePlatform]
  );
  const forceUpdateRequired = Boolean(
    effectiveUpdate &&
      (effectiveUpdate.forceUpgrade || compareVersion(effectiveUpdate.minimumVersion, appVersion) > 0)
  );
  const subscriptionBlocked = isSubscriptionBlocked(bootstrap?.subscription ?? null);
  const selectedNodeOffline = selectedNode ? probeResults[selectedNode.id]?.status === "offline" : false;
  const runtimeAssetsReady = desktopStatus.platformTarget === "android" || desktopStatus.platformTarget === "web"
    ? true
    : runtimeAssets.phase === "ready";
  const runtimeAssetsBusy = runtimeAssets.phase === "checking" || runtimeAssets.phase === "downloading";
  const canAttemptConnect =
    Boolean(selectedNode) &&
    nodes.length > 0 &&
    !forceUpdateRequired &&
    !subscriptionBlocked &&
    !selectedNodeOffline &&
    desktopStatus.status !== "connected" &&
    desktopStatus.status !== "connecting";
  const canConnect = canAttemptConnect && runtimeAssetsReady;
  const modeLocked = desktopStatus.status === "connecting" || desktopStatus.status === "connected" || desktopStatus.status === "disconnecting";
  const emergencyRuntimeActive =
    desktopStatus.status === "connected" ||
    desktopStatus.status === "connecting" ||
    desktopStatus.status === "disconnecting" ||
    desktopStatus.status === "error" ||
    Boolean(desktopStatus.activeSessionId) ||
    Boolean(desktopStatus.activePid);
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
  const passiveAnnouncements = useMemo(
    () => bootstrap?.announcements.filter((item) => item.displayMode === "passive") ?? [],
    [bootstrap]
  );
  const hasUnreadAnnouncements = useMemo(
    () =>
      !forcedAnnouncement &&
      passiveAnnouncements.some((item) => isPassiveAnnouncementUnread(item)),
    [announcementReadRevision, forcedAnnouncement, passiveAnnouncements]
  );
  const hasUnreadTickets = useMemo(() => ticketList.some((ticket) => isTicketUnread(ticket)), [ticketList]);
  const subscriptionServerProbe = useMemo<SubscriptionServerProbe>(
    () => toSubscriptionServerProbe(serverProbe),
    [serverProbe]
  );

  useEffect(() => {
    runtimeRef.current = runtime;
  }, [runtime]);

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
    probeResultsRef.current = probeResults;
  }, [probeResults]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

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
    void runServerLatencyProbe(session.accessToken);
  }, [session?.accessToken]);

  useEffect(() => {
    if (!session) {
      return;
    }
    const timer = window.setInterval(() => {
      void runServerLatencyProbe(session.accessToken);
    }, 20_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [session?.accessToken]);

  useEffect(() => {
    if (!session) {
      return;
    }

    const probeOnForeground = () => {
      if (document.visibilityState === "hidden") {
        return;
      }
      const nowMs = Date.now();
      if (nowMs - lastServerProbeForegroundAtRef.current < 3000) {
        return;
      }
      lastServerProbeForegroundAtRef.current = nowMs;
      void runServerLatencyProbe(session.accessToken);
    };

    document.addEventListener("visibilitychange", probeOnForeground);
    window.addEventListener("focus", probeOnForeground);
    return () => {
      document.removeEventListener("visibilitychange", probeOnForeground);
      window.removeEventListener("focus", probeOnForeground);
    };
  }, [session?.accessToken]);

  useEffect(() => {
    if (!ticketCenterOpened || !session) {
      return;
    }
    void loadTicketList();
  }, [ticketCenterOpened, session?.accessToken]);

  useEffect(() => {
    if (!session) {
      return;
    }
    void loadTicketList();
    const timer = window.setInterval(() => {
      void loadTicketList();
    }, 30_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [session?.accessToken]);

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
    if (desktopStatus.platformTarget === "android" || desktopStatus.platformTarget === "web") {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;

    void subscribeDesktopUpdateDownloadProgress((progress) => {
      if (disposed) {
        return;
      }
      setUpdateDownload((current) => normalizeUpdateDownloadProgress(current, progress));
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

    let disposed = false;
    let unlisten: (() => void) | null = null;

    void subscribeRuntimeComponentDownloadProgress((progress) => {
      if (disposed) {
        return;
      }
      setRuntimeAssets((current) => normalizeRuntimeAssetsProgress(current, progress));
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
    setUpdateDownload(createIdleUpdateDownloadState());
  }, [effectiveUpdate?.latestVersion, effectiveUpdate?.downloadUrl]);

  useEffect(() => {
    if (updateCheckResult?.artifact) {
      lastKnownUpdateArtifactRef.current = updateCheckResult.artifact;
    }
  }, [updateCheckResult?.artifact]);

  useEffect(() => {
    if (updateDownload.phase !== "downloading" || hasKnownTotalBytes(updateDownload.totalBytes)) {
      setIndeterminateUpdateProgress(18);
      return;
    }

    let currentValue = 18;
    let direction = 1;
    const timer = window.setInterval(() => {
      currentValue += direction * 9;
      if (currentValue >= 78) {
        currentValue = 78;
        direction = -1;
      } else if (currentValue <= 18) {
        currentValue = 18;
        direction = 1;
      }
      setIndeterminateUpdateProgress(currentValue);
    }, 180);

    return () => window.clearInterval(timer);
  }, [updateDownload.phase, updateDownload.totalBytes]);

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
    if (!bootstrap) {
      setForcedAnnouncement(null);
      setCountdown(0);
      return;
    }

    const pending = bootstrap.announcements.find((item) => {
      if (item.displayMode === "passive") {
        return false;
      }
      return isForcedAnnouncementPending(item);
    });

    setForcedAnnouncement(pending ?? null);
    setCountdown(pending?.displayMode === "modal_countdown" ? pending.countdownSeconds : 0);
  }, [bootstrap]);

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
    if (!session) {
      return;
    }

    const timer = window.setInterval(() => {
      void syncSubscriptionState(session.accessToken);
    }, 30_000);

    return () => window.clearInterval(timer);
  }, [session]);

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
    if (!session) {
      return;
    }

    return subscribeClientEvents(session.accessToken, {
      onEvent: (event) => {
        void handleRuntimeEvent(event, session.accessToken);
      }
    });
  }, [session]);

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
    if (!session || !runtime || desktopStatus.status !== "connected") {
      leaseHeartbeatFailedAtRef.current = null;
      return;
    }

    const tick = async () => {
      try {
        const lease = await heartbeatSession(session.accessToken, runtime.sessionId);
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
          current && current.sessionId === runtime.sessionId ? { ...current, leaseExpiresAt: lease.leaseExpiresAt } : current
        );
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
    desktopStatus.status,
    runtime?.sessionId,
    runtime?.leaseHeartbeatIntervalSeconds,
    runtime?.leaseGraceSeconds,
    session?.accessToken,
    fallbackNode?.id
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
      message: "登录态已失效，正在自动停止本地内核。"
    });
    void forceStopLocalRuntime();
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
    if (booting) {
      return;
    }
    if (desktopStatus.platformTarget === "android" || desktopStatus.platformTarget === "web") {
      return;
    }
    if (runtimeAssets.phase !== "idle") {
      return;
    }
    void ensureRuntimeAssetsReady({
      source: "startup",
      interactive: false,
      blockConnection: false
    });
  }, [booting, desktopStatus.platformTarget, runtimeAssets.phase]);

  async function runServerLatencyProbe(accessToken: string) {
    const requestId = serverProbeRequestSeqRef.current + 1;
    serverProbeRequestSeqRef.current = requestId;
    setServerProbe((current) => ({
      status: "checking",
      elapsedMs: current.elapsedMs,
      checkedAt: current.checkedAt,
      errorMessage: null
    }));

    try {
      const result = await probeClientServerLatency(accessToken);
      if (serverProbeRequestSeqRef.current !== requestId) {
        return;
      }
      setServerProbe({
        status: result.elapsedMs !== null && result.elapsedMs >= 200 ? "slow" : "healthy",
        elapsedMs: result.elapsedMs ?? null,
        checkedAt: Date.now(),
        errorMessage: null
      });
    } catch (reason) {
      if (serverProbeRequestSeqRef.current !== requestId) {
        return;
      }
      setServerProbe({
        status: "failed",
        elapsedMs: null,
        checkedAt: Date.now(),
        errorMessage: reason instanceof Error ? readError(reason.message) : "当前无法连接服务端"
      });
    }
  }

  async function loadTicketList(preferredTicketId?: string | null) {
    const accessToken = sessionRef.current?.accessToken;
    if (!accessToken) {
      return;
    }

    try {
      setTicketListBusy(true);
      setTicketCenterError(null);
      const nextTickets = await fetchSupportTickets(accessToken);
      setTicketList(nextTickets);
      setSelectedTicketId((current) => pickTicketId(nextTickets, preferredTicketId ?? current));
      if (nextTickets.length === 0) {
        setTicketDetail(null);
      }
    } catch (reason) {
      setTicketCenterError(reason instanceof Error ? readError(reason.message) : "工单列表加载失败");
    } finally {
      setTicketListBusy(false);
    }
  }

  async function loadTicketDetail(ticketId: string) {
    const accessToken = sessionRef.current?.accessToken;
    if (!accessToken) {
      return;
    }

    try {
      setTicketDetailBusy(true);
      setTicketCenterError(null);
      const detail = await fetchSupportTicketDetail(accessToken, ticketId);
      setTicketDetail(detail);
      if (isTicketUnread(detail)) {
        void markTicketAsRead(ticketId, accessToken);
      }
    } catch (reason) {
      setTicketCenterError(reason instanceof Error ? readError(reason.message) : "工单详情加载失败");
    } finally {
      setTicketDetailBusy(false);
    }
  }

  async function markTicketAsRead(ticketId: string, accessToken: string) {
    try {
      await markSupportTicketRead(accessToken, ticketId);
      setTicketList((current) => current.map((ticket) => markTicketRecordAsRead(ticket, ticketId)));
      setTicketDetail((current) => (current ? markTicketRecordAsRead(current, ticketId) : current));
    } catch {
      return;
    }
  }

  function openTicketCenter() {
    setTicketCenterOpened(true);
    setTicketCreateMode(false);
  }

  async function markPassiveAnnouncementsSeen() {
    const accessToken = sessionRef.current?.accessToken;
    if (!accessToken) {
      return;
    }
    const unreadIds = passiveAnnouncements.filter((item) => isPassiveAnnouncementUnread(item)).map((item) => item.id);
    if (unreadIds.length === 0) {
      return;
    }

    try {
      await markAnnouncementsRead(accessToken, {
        announcementIds: unreadIds,
        action: "seen"
      });
      patchAnnouncementReadState(unreadIds, "seen");
    } catch {
      return;
    }
  }

  function patchAnnouncementReadState(announcementIds: string[], action: "seen" | "ack") {
    const touchedAt = new Date().toISOString();
    setBootstrap((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        announcements: current.announcements.map((item) => {
          if (!announcementIds.includes(item.id)) {
            return item;
          }
          return patchAnnouncementRecord(item, action, touchedAt);
        })
      };
    });
    setAnnouncementReadRevision((current) => current + 1);
  }

  function openTicketComposer() {
    setTicketCreateMode(true);
    setTicketCenterError(null);
    setTicketReplyDraft("");
  }

  function closeTicketComposer() {
    setTicketCreateMode(false);
    setTicketCenterError(null);
  }

  async function handleCreateTicket() {
    const accessToken = sessionRef.current?.accessToken;
    if (!accessToken || ticketSubmitting) {
      return;
    }

    try {
      setTicketSubmitting(true);
      setTicketCenterError(null);
      const detail = await createSupportTicket(accessToken, {
        title: ticketDraft.title.trim(),
        body: ticketDraft.body.trim()
      });
      setTicketDraft({ title: "", body: "" });
      setTicketReplyDraft("");
      setTicketCreateMode(false);
      setTicketDetail(detail);
      setSelectedTicketId(detail.id);
      await loadTicketList(detail.id);
      notifications.show({
        color: "green",
        title: "工单已提交",
        message: "你的问题已经提交成功，可以在这里继续补充信息。"
      });
    } catch (reason) {
      setTicketCenterError(reason instanceof Error ? readError(reason.message) : "工单提交失败");
    } finally {
      setTicketSubmitting(false);
    }
  }

  async function handleReplyTicket() {
    const accessToken = sessionRef.current?.accessToken;
    if (!accessToken || !selectedTicketId || ticketSubmitting || !ticketReplyDraft.trim()) {
      return;
    }

    try {
      setTicketSubmitting(true);
      setTicketCenterError(null);
      const detail = await replySupportTicket(accessToken, selectedTicketId, {
        body: ticketReplyDraft.trim()
      });
      setTicketDetail(detail);
      setTicketReplyDraft("");
      await loadTicketList(detail.id);
      notifications.show({
        color: "green",
        title: "回复已发送",
        message: "客服看到后会继续在这条工单里回复你。"
      });
    } catch (reason) {
      setTicketCenterError(reason instanceof Error ? readError(reason.message) : "发送回复失败");
    } finally {
      setTicketSubmitting(false);
    }
  }

  async function initializeApp() {
    try {
      const rememberedCredentials = loadRememberedCredentials();
      if (rememberedCredentials) {
        setCredentials(rememberedCredentials);
        setRememberPassword(true);
      }
      const startupPlatform = detectRuntimePlatform();
      if (startupPlatform !== "android" && startupPlatform !== "web") {
        void ensureRuntimeAssetsReady({ source: "startup", interactive: false, blockConnection: false });
      }
      await refreshRuntime();
      const storedSession = await loadStoredSession();
      if (storedSession) {
        await bootstrapSession(storedSession, true, false, true);
      } else {
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

  async function refreshRuntime() {
    const requestId = runtimeRefreshRequestSeqRef.current + 1;
    runtimeRefreshRequestSeqRef.current = requestId;

    try {
      const [status, logs] = await Promise.all([loadRuntimeStatus(), loadRuntimeLogs()]);
      if (runtimeRefreshRequestSeqRef.current !== requestId) {
        return;
      }
      setDesktopStatus(status);
      if (!status.activeSessionId && status.status !== "connecting" && status.status !== "disconnecting") {
        setRuntime(null);
      }
      setRuntimeLog(logs.log);
    } catch {
      if (runtimeRefreshRequestSeqRef.current !== requestId) {
        return;
      }
      setDesktopStatus(createIdleRuntimeStatus());
      setRuntime(null);
      setRuntimeLog("");
    }
  }

  async function forceStopLocalRuntime() {
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
        leaseHeartbeatFailedAtRef.current = null;
        setRuntime(null);
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
  }

  async function syncSubscriptionState(accessToken: string) {
    try {
      const subscription = await fetchSubscription(accessToken);
      mergeSubscriptionState(subscription);
    } catch {
      return;
    }
  }

  async function syncForegroundState(accessToken: string) {
    await refreshRuntime().catch(() => null);

    const activeRuntime = runtimeRef.current;
    const [subscriptionResult, nodesResult, runtimeResult] = await Promise.allSettled([
      fetchSubscription(accessToken),
      fetchNodes(accessToken),
      activeRuntime ? fetchClientRuntime(accessToken) : Promise.resolve(null)
    ]);

    let nextSubscription = bootstrap?.subscription ?? null;
    let nextNodes = nodesRef.current;

    if (subscriptionResult.status === "fulfilled") {
      nextSubscription = subscriptionResult.value;
      mergeSubscriptionState(subscriptionResult.value);
      lastForegroundSyncErrorRef.current = null;
    }

    if (nodesResult.status === "fulfilled") {
      nextNodes = nodesResult.value;
      setNodes(nextNodes);
      setSelectedNodeId((current) => pickNode(nextNodes, current ?? loadLastNodeId(), probeResultsRef.current)?.id ?? null);
      lastForegroundSyncErrorRef.current = null;
    }

    if (activeRuntime && runtimeResult.status === "fulfilled") {
      const serverRuntime = runtimeResult.value;
      const fallbackNodeId =
        pickAlternativeNode(nextNodes, activeRuntime.node.id, probeResultsRef.current)?.id ?? null;

      if (!serverRuntime || serverRuntime.sessionId !== activeRuntime.sessionId) {
        const guidance =
          (nextSubscription ? deriveGuidanceFromSubscription(nextSubscription, fallbackNodeId) : null) ??
          deriveGuidanceFromMessage("当前连接已失效，请重新连接", { fallbackNodeId });
        if (guidance) {
          await handleForcedGuidance(guidance);
          return;
        }
      }
    }

    if (subscriptionResult.status === "rejected" && nodesResult.status === "rejected") {
      const message = describeForegroundSyncFailure(subscriptionResult.reason);
      if (lastForegroundSyncErrorRef.current === message) {
        return;
      }
      lastForegroundSyncErrorRef.current = message;
      notifications.show({
        color: "yellow",
        title: "网络连接已中断",
        message,
        autoClose: 4000
      });
    }
  }

  async function handleRuntimeEvent(event: ClientRuntimeEventDto, accessToken: string) {
    if (!event) {
      return;
    }

    if (
      event.type === "subscription_updated" ||
      event.reasonCode === "subscription_expired" ||
      event.reasonCode === "subscription_exhausted" ||
      event.reasonCode === "subscription_paused" ||
      event.reasonCode === "account_disabled" ||
      event.reasonCode === "team_access_revoked"
    ) {
      await syncSubscriptionState(accessToken);
    }

    if (
      event.type === "node_access_updated" ||
      event.reasonCode === "node_access_revoked" ||
      event.reasonCode === "admin_paused_connection"
    ) {
      try {
        const nextNodes = await fetchNodes(accessToken);
        setNodes(nextNodes);
        setSelectedNodeId((current) => pickNode(nextNodes, current ?? loadLastNodeId(), probeResultsRef.current)?.id ?? null);
      } catch {
        // 节点列表刷新失败时保留心跳兜底。
      }
    }

    const activeRuntime = runtimeRef.current;
    if (!activeRuntime) {
      return;
    }
    if (event.sessionId && event.sessionId !== activeRuntime.sessionId) {
      return;
    }

    const fallbackNodeId = pickAlternativeNode(
      nodesRef.current,
      activeRuntime.node.id ?? selectedNodeIdRef.current,
      probeResultsRef.current
    )?.id ?? null;
    const guidance =
      deriveGuidanceFromRuntimeEvent(event, fallbackNodeId) ??
      (event.reasonMessage
        ? deriveGuidanceFromMessage(event.reasonMessage, { fallbackNodeId })
        : null);

    if (guidance) {
      await handleForcedGuidance(guidance);
    }
  }

  async function bootstrapSession(
    nextSession: AuthSessionDto,
    allowRefresh: boolean,
    preserveMode: boolean,
    autoProbe: boolean
  ) {
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
          Object.fromEntries(Object.entries(current).filter(([nodeId]) => nextNodes.some((node) => node.id === nodeId)))
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
  }

  async function handleLogin() {
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
  }

  async function handleRefresh() {
    if (!session || refreshing) {
      return;
    }

    try {
      setRefreshing(true);
      await refreshRuntime();
      const ok = await bootstrapSession(session, true, modeLocked, false);
      if (!ok) {
        await forceStopLocalRuntime();
      } else {
        await runServerLatencyProbe(sessionRef.current?.accessToken ?? session.accessToken);
      }
    } catch (reason) {
      await forceStopLocalRuntime();
      showErrorToast(reason instanceof Error ? readError(reason.message) : "刷新失败");
    } finally {
      setRefreshing(false);
    }
  }

  async function handleLogout() {
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
  }

  async function clearSession(stopRuntime = true) {
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
  }

  function mergeSubscriptionState(subscription: SubscriptionStatusDto) {
    setBootstrap((current) => (current ? { ...current, subscription } : current));
    setConnectionGuidance((current) => {
      const nextGuidance = clearResolvedGuidance(current, subscription, nodes);
      if (!nextGuidance) {
        setGuidanceDialog(null);
      }
      return nextGuidance;
    });
  }

  async function ensureRuntimeAssetsReady(options: {
    source: "startup" | "connect" | "retry";
    interactive: boolean;
    blockConnection: boolean;
  }) {
    if (desktopStatus.platformTarget === "android" || desktopStatus.platformTarget === "web") {
      return true;
    }
    if (runtimeAssets.phase === "ready") {
      return true;
    }
    if (runtimeAssetsTaskRef.current) {
      return runtimeAssetsTaskRef.current;
    }

    const task = (async () => {
      setRuntimeAssets((current) => ({
        ...current,
        phase: "checking",
        message: "正在检查必要内核组件，请稍候。",
        blocking: options.blockConnection,
        errorCode: null,
        errorMessage: null
      }));

      try {
        const environment = await loadDesktopRuntimeEnvironment().catch(() => null);
        const plan = await fetchRuntimeComponentsPlan({
          accessToken: sessionRef.current?.accessToken ?? null,
          clientMirrorPrefix: runtimeMirrorPrefix
        });
        if (!plan || !plan.components.length) {
          return await failRuntimeAssets(
            {
              code: "plan_missing",
              message: "服务端尚未配置必要内核组件，当前暂时不能连接。",
              component: "xray",
              effectiveUrl: null,
              platform: environment?.platform ?? resolveRuntimePlanPlatform(desktopStatus.platformTarget),
              architecture: environment?.architecture ?? "arm64"
            },
            options
          );
        }

        const pendingComponents: RuntimeComponentDownloadItem[] = [];
        for (const component of plan.components) {
          const status = await checkRuntimeComponentFile(component).catch(() => null);
          if (!status?.ready) {
            pendingComponents.push(component);
          }
        }
        if (pendingComponents.length === 0) {
          setRuntimeAssets({
            phase: "ready",
            currentComponent: null,
            fileName: null,
            downloadedBytes: 0,
            totalBytes: null,
            message: "连接所需组件已准备完成。",
            errorCode: null,
            errorMessage: null,
            blocking: false
          });
          setRuntimeAssetsDialogOpened(false);
          return true;
        }

        for (const component of pendingComponents) {
          const candidate = resolveRuntimeComponentCandidate(component, runtimeMirrorPrefix);
          if (!candidate) {
            return await failRuntimeAssets(
              {
                code: "plan_missing",
                message: `${component.displayName} 没有可用下载地址，当前暂时不能连接。`,
                component: component.component,
                effectiveUrl: null,
                platform: plan.platform,
                architecture: plan.architecture
              },
              options,
              component.id
            );
          }

          setRuntimeAssets({
            phase: "downloading",
            currentComponent: component.component,
            fileName: component.fileName,
            downloadedBytes: 0,
            totalBytes: component.fileSizeBytes,
            message: `正在准备 ${component.displayName}，完成后即可继续连接。`,
            errorCode: null,
            errorMessage: null,
            blocking: true
          });

          try {
            await downloadRuntimeComponent({
              component,
              url: candidate.url
            });
          } catch (reason) {
            const rawMessage = reason instanceof Error ? reason.message : String(reason);
            return await failRuntimeAssets(
              {
                code: extractRuntimeAssetsErrorCode(rawMessage),
                message: stripRuntimeAssetsErrorPrefix(rawMessage),
                component: component.component,
                effectiveUrl: candidate.url,
                platform: plan.platform,
                architecture: plan.architecture
              },
              options,
              component.id
            );
          }
        }

        setRuntimeAssets({
          phase: "ready",
          currentComponent: null,
          fileName: null,
          downloadedBytes: 0,
          totalBytes: null,
          message: "连接所需组件已准备完成。",
          errorCode: null,
          errorMessage: null,
          blocking: false
        });
        setRuntimeAssetsDialogOpened(false);
        notifications.show({
          color: "green",
          title: "必要内核组件已准备完成",
          message: "现在可以开始连接了。"
        });
        return true;
      } catch (reason) {
        const rawMessage = reason instanceof Error ? reason.message : "必要内核组件下载失败";
        const message = stripRuntimeAssetsErrorPrefix(readError(rawMessage));
        const errorCode = extractRuntimeAssetsErrorCode(rawMessage);
        return failRuntimeAssets(
          {
            code: errorCode,
            message,
            component: runtimeAssets.currentComponent ?? "xray",
            effectiveUrl: null,
            platform: resolveRuntimePlanPlatform(desktopStatus.platformTarget),
            architecture: "arm64"
          },
          options
        );
      }
    })();

    runtimeAssetsTaskRef.current = task;
    try {
      return await task;
    } finally {
      runtimeAssetsTaskRef.current = null;
    }
  }

  async function failRuntimeAssets(
    failure: {
      code: RuntimeDownloadFailureReason;
      message: string;
      component: "xray" | "geoip" | "geosite";
      effectiveUrl: string | null;
      platform: "macos" | "windows";
      architecture: "x64" | "arm64";
    },
    options: { source: "startup" | "connect" | "retry"; interactive: boolean; blockConnection: boolean },
    componentId?: string | null
  ) {
    setRuntimeAssets({
      phase: "failed",
      currentComponent: failure.component,
      fileName: null,
      downloadedBytes: 0,
      totalBytes: null,
      message: null,
      errorCode: failure.code,
      errorMessage: failure.message,
      blocking: options.blockConnection
    });

    void reportRuntimeComponentFailure({
      accessToken: sessionRef.current?.accessToken ?? null,
      componentId,
      component: failure.component,
      platform: failure.platform,
      architecture: failure.architecture,
      failureReason: failure.code,
      message: failure.message,
      effectiveUrl: failure.effectiveUrl,
      appVersion
    }).catch(() => null);

    if (
      options.interactive ||
      (options.source !== "startup" &&
        canOpenRuntimeAssetsDialog(
          forceUpdateRequired,
          forcedAnnouncement,
          updateDialogOpened,
          announcementDrawerOpened,
          updateDownload.phase
        ))
    ) {
      setRuntimeAssetsDialogOpened(true);
    }
    return false;
  }

  function handleRetryRuntimeAssets() {
    localStorage.setItem(RUNTIME_COMPONENT_MIRROR_PREFIX_KEY, runtimeMirrorPrefix.trim());
    void ensureRuntimeAssetsReady({
      source: "retry",
      interactive: true,
      blockConnection: true
    });
  }

  async function handlePrimaryAction() {
    if (forceUpdateRequired && desktopStatus.status !== "connected" && desktopStatus.status !== "error") {
      setUpdateDialogOpened(true);
      return;
    }
    if (desktopStatus.status === "connected" || desktopStatus.status === "error") {
      await handleDisconnect();
      return;
    }

    if (!runtimeAssetsReady) {
      const ready = await ensureRuntimeAssetsReady({
        source: runtimeAssets.phase === "failed" ? "retry" : "connect",
        interactive: true,
        blockConnection: true
      });
      if (!ready) {
        return;
      }
    }

    await handleConnect();
  }

  async function handleConnect() {
    if (!session || !selectedNode || actionBusy || !canAttemptConnect) {
      return;
    }
    if (!runtimeAssetsReady) {
      const ready = await ensureRuntimeAssetsReady({
        source: runtimeAssets.phase === "failed" ? "retry" : "connect",
        interactive: true,
        blockConnection: true
      });
      if (!ready) {
        return;
      }
    }
    if (!canConnect) {
      return;
    }

    try {
      setActionBusy("connect");
      setDesktopStatus((current) => ({ ...current, status: "connecting", lastError: null }));
      const config = await connectSession({
        accessToken: session.accessToken,
        nodeId: selectedNode.id,
        mode
      });
      await connectRuntime(config);
      localStorage.setItem(LAST_NODE_KEY, selectedNode.id);
      setRuntime(config);
      setConnectionGuidance(null);
      setGuidanceDialog(null);
      leaseHeartbeatFailedAtRef.current = null;
      await refreshRuntime();
    } catch (reason) {
      const runtimeStatus = await loadConnectFailureRuntimeStatus().catch(() => null);
      if (runtimeStatus) {
        setDesktopStatus(runtimeStatus);
      }
      const runtimeGuidance = runtimeStatus ? deriveGuidanceFromRuntimeStatus(runtimeStatus, fallbackNode?.id ?? null) : null;
      await forceStopLocalRuntime();
      const message = reason instanceof Error ? readError(reason.message) : "连接失败";
      const connectGuidance =
        runtimeGuidance ??
        deriveGuidanceFromConnectFailure(message, fallbackNode?.id ?? null, runtimeStatus?.platformTarget ?? desktopStatus.platformTarget);
      if (connectGuidance) {
        applyGuidance(connectGuidance, true, true);
      } else {
        showErrorToast(message);
      }
    } finally {
      setActionBusy(null);
    }
  }

  async function handleDisconnect() {
    if (
      actionBusy ||
      (desktopStatus.status !== "connected" &&
        desktopStatus.status !== "error" &&
        desktopStatus.status !== "connecting" &&
        !desktopStatus.activePid)
    ) {
      return;
    }
    setConnectionGuidance(null);
    await disconnectCurrentRuntime({ notifyServer: true });
  }

  async function handleEmergencyDisconnect() {
    if (actionBusy === "disconnect") {
      return;
    }

    try {
      setActionBusy("disconnect");
      setDesktopStatus((current) => ({ ...current, status: "disconnecting", lastError: null }));
      await forceStopLocalRuntime();
      setConnectionGuidance(null);
      notifications.show({
        color: "green",
        title: "本地内核已停止",
        message: session
          ? "当前连接已在本机断开，系统代理已恢复。"
          : "登录态缺失时，已优先停止本地内核并恢复系统代理。"
      });
    } catch (reason) {
      showErrorToast(reason instanceof Error ? readError(reason.message) : "断开失败");
    } finally {
      setActionBusy(null);
    }
  }

  async function runProbe(targetNodes: NodeSummaryDto[], auto: boolean, accessTokenOverride?: string) {
    const accessToken = accessTokenOverride ?? session?.accessToken ?? null;
    if (probeBusy || targetNodes.length === 0 || !accessToken) {
      return;
    }

    try {
      setProbeBusy(true);
      const result = await fetchNodeProbes(
        accessToken,
        targetNodes.map((node) => node.id)
      );
      const nextResults = Object.fromEntries(result.map((item) => [item.nodeId, item]));
      setProbeResults(nextResults);
      setProbeCooldownUntil(Date.now() + PROBE_COOLDOWN_MS);

      setSelectedNodeId((current) => {
        const saved = loadLastNodeId();
        if (current && nextResults[current]?.status === "healthy") {
          return current;
        }
        return pickNode(targetNodes, saved, nextResults)?.id ?? current ?? targetNodes[0]?.id ?? null;
      });
      const currentSelectedId = selectedNodeId ?? runtime?.node.id ?? null;
      if (currentSelectedId && nextResults[currentSelectedId]?.status === "offline") {
        const recommended = pickAlternativeNode(targetNodes, currentSelectedId, nextResults);
        applyGuidance(
          {
            code: "node_unavailable",
            tone: "warning",
            title: "节点暂不可用",
            message: "当前节点测速失败，请切换其他可用节点后重新连接。",
            actionLabel: "切换节点后重连",
            recommendedNodeId: recommended?.id ?? null
          },
          !auto,
          true
        );
      }

    } catch (reason) {
      if (!auto) {
        showErrorToast(reason instanceof Error ? readError(reason.message) : "测速失败");
      }
    } finally {
      setProbeBusy(false);
    }
  }

  async function handleForcedGuidance(guidance: ConnectionGuidance) {
    applyGuidance(guidance, true, true);
    if (actionBusy === "disconnect") {
      return;
    }
    await disconnectCurrentRuntime({ notifyServer: false, guidance });
  }

  async function disconnectCurrentRuntime(options?: {
    notifyServer?: boolean;
    guidance?: ConnectionGuidance | null;
  }) {
    const sessionId = runtime?.sessionId ?? desktopStatus.activeSessionId;
    const accessToken = session?.accessToken ?? null;

    try {
      setActionBusy("disconnect");
      setDesktopStatus((current) => ({
        ...current,
        status: "disconnecting",
        lastError: options?.guidance?.message ?? null
      }));
      await forceStopLocalRuntime();
      if (options?.notifyServer !== false && sessionId && accessToken) {
        await disconnectSession(accessToken, sessionId).catch(() => null);
      }
    } catch (reason) {
      showErrorToast(reason instanceof Error ? readError(reason.message) : "断开失败");
    } finally {
      await refreshRuntime();
      setActionBusy(null);
    }
  }

  function applyGuidance(guidance: ConnectionGuidance, toast = true, autoSelect = false) {
    setConnectionGuidance((current) => (sameGuidance(current, guidance) ? current : guidance));
    setGuidanceDialog((current) => (sameGuidance(current, guidance) ? current : guidance));
    if (autoSelect && guidance.recommendedNodeId) {
      setSelectedNodeId(guidance.recommendedNodeId);
    }
    void focusDesktopWindow();
    if (toast && !isDialogOnlyGuidance(guidance.code)) {
      showGuidanceToast(guidance);
    }
  }

  function dismissGuidanceDialog() {
    setGuidanceDialog(null);
  }

  function showGuidanceToast(guidance: ConnectionGuidance) {
    const key = guidanceKey(guidance);
    if (lastGuidanceToastRef.current === key) {
      return;
    }
    lastGuidanceToastRef.current = key;
    notifications.show({
      color: toneToToastColor(guidance.tone),
      title: guidance.title,
      message: formatGuidanceMessage(guidance),
      autoClose: 4000
    });
  }

  function openAnnouncementDrawer() {
    setAnnouncementDrawerOpened(true);
    void markPassiveAnnouncementsSeen();
  }

  async function acknowledgeAnnouncement() {
    if (!forcedAnnouncement) {
      return;
    }

    const accessToken = sessionRef.current?.accessToken;
    if (!accessToken) {
      return;
    }

    try {
      await markAnnouncementsRead(accessToken, {
        announcementIds: [forcedAnnouncement.id],
        action: "ack"
      });
      patchAnnouncementReadState([forcedAnnouncement.id], "ack");
      setForcedAnnouncement(null);
      setCountdown(0);
    } catch (reason) {
      notifications.show({
        color: "red",
        title: "公告状态同步失败",
        message: reason instanceof Error ? readError(reason.message) : "当前无法保存公告已读状态"
      });
    }
  }

  async function acknowledgeCloseHint() {
    if (rememberCloseHint) {
      localStorage.setItem(DESKTOP_CLOSE_HINT_KEY, "ack");
    }
    setCloseHintOpened(false);
  }

  async function handleManualUpdateCheck() {
    await runUpdateCheck({
      accessToken: session?.accessToken ?? undefined,
      bootstrapVersion: bootstrap?.version ?? null,
      source: "manual"
    });
  }

  async function handleUpdateDownload() {
    const resolvedDownloadUrl = resolveUpdateDownloadUrl(effectiveUpdate?.downloadUrl ?? null);
    const originDownloadUrl = resolveUpdateDownloadUrl(effectiveUpdate?.artifact?.originDownloadUrl ?? null);
    if (!resolvedDownloadUrl || !effectiveUpdate) {
      notifications.show({
        color: "yellow",
        title: "暂无下载地址",
        message: "当前版本没有配置可用下载地址，请联系管理员补充发布产物。"
      });
      return;
    }
    if (effectiveUpdate.deliveryMode !== "desktop_installer_download" || updatePlatform === "android") {
      await openExternalLink(resolvedDownloadUrl);
      notifications.show({
        color: "blue",
        title: effectiveUpdate.deliveryMode === "apk_download" ? "已打开 APK 下载链接" : "已打开更新下载链接",
        message:
          effectiveUpdate.deliveryMode === "apk_download"
            ? "请在浏览器或系统下载器中完成安装包下载。"
            : "请根据打开的下载页面完成安装包下载。"
      });
      return;
    }
    if (updateDownload.phase === "preparing" || updateDownload.phase === "downloading") {
      return;
    }
    if (updateDownload.phase === "completed" && updateDownload.localPath) {
      try {
        await openDesktopInstaller(updateDownload.localPath);
        notifications.show({
          color: "green",
          title: "安装器已打开",
          message: "已复用本地安装器，请按安装向导完成升级。"
        });
        return;
      } catch (reason) {
        setUpdateDownload(createIdleUpdateDownloadState());
        notifications.show({
          color: "yellow",
          title: "本地安装器不可用",
          message: reason instanceof Error ? readError(reason.message) : "已切换为重新下载安装器。"
        });
      }
    }

    const preferredFileName =
      effectiveUpdate.artifact?.fileName ??
      inferInstallerFileName(resolvedDownloadUrl, effectiveUpdate.artifact?.fileType ?? preferredArtifactType(updatePlatform));

    setUpdateDownload({
      phase: "preparing",
      fileName: preferredFileName,
      downloadedBytes: 0,
      totalBytes: effectiveUpdate.artifact?.fileSizeBytes ?? null,
      localPath: null,
      message: "正在准备下载安装器…"
    });

    try {
      let usedFallback = false;
      let result;
      try {
        result = await downloadDesktopInstaller({
          url: resolvedDownloadUrl,
          fileName: preferredFileName,
          expectedTotalBytes: effectiveUpdate.artifact?.fileSizeBytes ?? null,
          expectedHash: effectiveUpdate.artifact?.fileHash ?? null
        });
      } catch (reason) {
        if (!originDownloadUrl || originDownloadUrl === resolvedDownloadUrl) {
          throw reason;
        }
        usedFallback = true;
        setUpdateDownload((current) => ({
          ...current,
          phase: "preparing",
          message: "加速下载失败，正在回退到原始下载地址…"
        }));
        result = await downloadDesktopInstaller({
          url: originDownloadUrl,
          fileName: preferredFileName,
          expectedTotalBytes: effectiveUpdate.artifact?.fileSizeBytes ?? null,
          expectedHash: effectiveUpdate.artifact?.fileHash ?? null
        });
      }
      if (!result?.localPath) {
        throw new Error("安装器下载失败");
      }

      setUpdateDownload({
        phase: "completed",
        fileName: result.fileName,
        downloadedBytes: result.totalBytes ?? effectiveUpdate.artifact?.fileSizeBytes ?? 0,
        totalBytes: result.totalBytes ?? effectiveUpdate.artifact?.fileSizeBytes ?? null,
        localPath: result.localPath,
        message: "安装器下载完成，正在打开安装程序…"
      });

      await openDesktopInstaller(result.localPath);
      notifications.show({
        color: "green",
        title: "安装器已打开",
        message: usedFallback
          ? "已自动回退到原始下载地址，并成功打开安装器。请按安装向导完成升级。"
          : "请按安装向导完成升级，安装完成后重新打开 ChordV。"
      });
    } catch (reason) {
      const message = reason instanceof Error ? readError(reason.message) : "安装器下载失败";
      setUpdateDownload((current) => ({
        phase: "failed",
        fileName: current.fileName,
        downloadedBytes: current.downloadedBytes,
        totalBytes: current.totalBytes,
        localPath: current.localPath,
        message
      }));
      showErrorToast(message);
    }
  }

  async function runUpdateCheck(options: {
    accessToken?: string;
    bootstrapVersion?: ClientVersionDto | null;
    source: "startup" | "login" | "manual" | "refresh";
    silent?: boolean;
  }) {
    if (updateCheckBusy) {
      return;
    }

    try {
      setUpdateCheckBusy(true);
      const result =
        (await checkClientUpdate({
          currentVersion: appVersion,
          platform: updatePlatform,
          channel: UPDATE_CHANNEL,
          artifactType: preferredArtifactType(updatePlatform),
          clientMirrorPrefix: runtimeMirrorPrefix,
          accessToken: options.accessToken
        })) ?? createLegacyUpdateResult(options.bootstrapVersion ?? null, updatePlatform, appVersion);

      setUpdateCheckResult(result);

      if (!result || !result.hasUpdate) {
        if (options.source === "manual" && !options.silent) {
          notifications.show({
            color: "green",
            title: "当前已是最新版本",
            message: `你当前使用的是 ${formatVersionLabel(appVersion)}。`
          });
        }
        return;
      }

      const promptKey = `${result.latestVersion}:${result.forceUpgrade ? "force" : "optional"}`;
      const shouldPrompt =
        options.source === "manual" ||
        result.forceUpgrade ||
        lastUpdatePromptVersionRef.current !== promptKey;

      if (shouldPrompt) {
        if (
          options.source !== "manual" &&
          (runtimeAssetsBusy || runtimeAssetsDialogOpened || updateDownload.phase === "preparing" || updateDownload.phase === "downloading")
        ) {
          deferredUpdatePromptKeyRef.current = promptKey;
        } else {
          deferredUpdatePromptKeyRef.current = null;
          lastUpdatePromptVersionRef.current = promptKey;
          setUpdateDialogOpened(true);
        }
      }

      if (options.source !== "manual" && !options.silent) {
        notifications.show({
          color: result.forceUpgrade ? "red" : "blue",
          title: result.forceUpgrade ? "发现强制更新" : "发现新版本",
          message: `${formatVersionLabel(result.latestVersion)} 已发布。`
        });
      }
    } catch (reason) {
      if (!options.silent || options.source === "manual") {
        showErrorToast(reason instanceof Error ? readError(reason.message) : "检查更新失败");
      }
    } finally {
      setUpdateCheckBusy(false);
    }
  }

  return (
    <div className={desktopStatus.platformTarget === "android" ? "desktop-app desktop-app--android" : "desktop-app"}>
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
              onOpenAnnouncements={openAnnouncementDrawer}
              onOpenTickets={openTicketCenter}
              onRefresh={() => void handleRefresh()}
              onCheckUpdate={() => void handleManualUpdateCheck()}
              onLogout={() => void handleLogout()}
            />
            {forceUpdateRequired && effectiveUpdate?.hasUpdate ? (
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
            ) : null}
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
                runtimeAssets
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
              : "发现可用新版本，ChordV 会先在应用内下载完整安装器，下载完成后自动打开安装程序，再由你手动完成安装。"}
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
            发布渠道：正式版
          </Text>
          {effectiveUpdate?.deliveryMode === "desktop_installer_download" && updateDownload.phase !== "idle" ? (
            <Stack gap={6}>
              <Text fw={600}>安装器下载</Text>
              <Text size="sm" c="dimmed">
                新版本会先在应用内下载完整安装器，下载完成后自动打开 {updatePlatform === "windows" ? "Setup 安装程序" : "DMG 安装包"}，再由你手动完成安装。
              </Text>
              <Progress
                value={displayUpdateDownloadProgress(updateDownload, indeterminateUpdateProgress)}
                animated={updateDownload.phase === "downloading"}
                striped={updateDownload.phase === "downloading"}
              />
              <Text size="sm" c="dimmed">
                {describeUpdateDownload(updateDownload)}
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

function primaryButtonLabel(
  status: string,
  subscription: SubscriptionStatusDto,
  guidance: ConnectionGuidance | null,
  selectedNodeOffline: boolean,
  runtimeAssets: RuntimeAssetsUiState
) {
  if (status === "connecting") return "连接中";
  if (status === "disconnecting") return "断开中";
  if (status === "connected" || status === "error") return "断开连接";
  if (subscription.state === "expired") return "订阅已到期";
  if (subscription.state === "exhausted" || subscription.remainingTrafficGb <= 0) return "流量已用尽";
  if (subscription.state === "paused") return "订阅已暂停";
  if (runtimeAssets.phase === "checking" || runtimeAssets.phase === "downloading") return "正在准备组件";
  if (runtimeAssets.phase === "failed") return "重试下载组件";
  if (selectedNodeOffline) return "切换节点后重连";
  if (guidance) return guidance.actionLabel;
  return "启动连接";
}

function pickNode(
  nodes: NodeSummaryDto[],
  preferredId: string | null,
  probeResults?: Record<string, RuntimeNodeProbeResult>
) {
  if (preferredId) {
    const preferred = nodes.find((node) => node.id === preferredId);
    if (preferred) {
      return preferred;
    }
  }

  if (probeResults) {
    const healthy = nodes.find((node) => probeResults[node.id]?.status === "healthy");
    if (healthy) {
      return healthy;
    }
  }

  return nodes[0] ?? null;
}

function loadLastNodeId() {
  return localStorage.getItem(LAST_NODE_KEY);
}

function resolveDefaultMode(bootstrap: ClientBootstrapDto) {
  return bootstrap.policies.modes.includes(bootstrap.policies.defaultMode)
    ? bootstrap.policies.defaultMode
    : (bootstrap.policies.modes[0] ?? "rule");
}

function loadRememberedCredentials() {
  const raw = localStorage.getItem(REMEMBER_CREDENTIALS_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as { email?: string; password?: string };
    if (typeof parsed.email === "string" && typeof parsed.password === "string") {
      return {
        email: parsed.email,
        password: parsed.password
      };
    }
  } catch {
    return null;
  }

  return null;
}

function saveRememberedCredentials(email: string, password: string) {
  localStorage.setItem(
    REMEMBER_CREDENTIALS_KEY,
    JSON.stringify({
      email,
      password
    })
  );
}

function clearRememberedCredentials() {
  localStorage.removeItem(REMEMBER_CREDENTIALS_KEY);
}

function compareVersion(left: string, right: string) {
  const leftSemver = parseSemver(left);
  const rightSemver = parseSemver(right);

  if (!leftSemver || !rightSemver) {
    return left.localeCompare(right);
  }

  for (const key of ["major", "minor", "patch"] as const) {
    if (leftSemver[key] > rightSemver[key]) {
      return 1;
    }
    if (leftSemver[key] < rightSemver[key]) {
      return -1;
    }
  }

  if (leftSemver.prerelease.length === 0 && rightSemver.prerelease.length > 0) {
    return 1;
  }
  if (leftSemver.prerelease.length > 0 && rightSemver.prerelease.length === 0) {
    return -1;
  }

  const length = Math.max(leftSemver.prerelease.length, rightSemver.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftSemver.prerelease[index];
    const rightPart = rightSemver.prerelease[index];
    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }
    if (leftPart === rightPart) {
      continue;
    }
    const leftNumber = Number(leftPart);
    const rightNumber = Number(rightPart);
    const leftNumeric = Number.isFinite(leftNumber) && leftPart.trim() !== "";
    const rightNumeric = Number.isFinite(rightNumber) && rightPart.trim() !== "";

    if (leftNumeric && rightNumeric) {
      return leftNumber > rightNumber ? 1 : -1;
    }
    if (leftNumeric) {
      return -1;
    }
    if (rightNumeric) {
      return 1;
    }
    return leftPart.localeCompare(rightPart);
  }

  return 0;
}

function parseSemver(version: string) {
  const match = version.trim().match(
    /^v?(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-(?<prerelease>[0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
  );
  if (!match?.groups) {
    return null;
  }
  return {
    major: Number(match.groups.major),
    minor: Number(match.groups.minor),
    patch: Number(match.groups.patch),
    prerelease: match.groups.prerelease ? match.groups.prerelease.split(".") : []
  };
}

function resolveUpdatePlatform(platformTarget: RuntimeStatus["platformTarget"]) {
  if (platformTarget === "web") {
    const detected = detectRuntimePlatform();
    return detected === "web" ? "macos" : detected;
  }
  return platformTarget;
}

function preferredArtifactType(platformTarget: ReturnType<typeof resolveUpdatePlatform>) {
  if (platformTarget === "windows") {
    return "setup.exe" as const;
  }
  if (platformTarget === "android") {
    return "apk" as const;
  }
  return "dmg" as const;
}

function formatVersionLabel(version: string) {
  return version;
}

function resolveUpdateDownloadUrl(downloadUrl: string | null) {
  if (!downloadUrl) {
    return null;
  }
  if (/^https?:\/\//i.test(downloadUrl)) {
    return downloadUrl;
  }
  return new URL(downloadUrl, import.meta.env.VITE_API_BASE_URL ?? "https://v.baymaxgroup.com").toString();
}

function applyUpdateMirrorPrefix(originUrl: string, mirrorPrefix?: string | null) {
  const normalizedPrefix = normalizeMirrorPrefix(mirrorPrefix);
  if (!normalizedPrefix) {
    return originUrl;
  }
  if (normalizedPrefix.includes("{url}")) {
    return normalizedPrefix.replaceAll("{url}", originUrl);
  }
  return `${normalizedPrefix}${originUrl}`;
}

function normalizeMirrorPrefix(mirrorPrefix?: string | null) {
  const normalized = mirrorPrefix?.trim();
  return normalized ? normalized : null;
}

function createLegacyUpdateResult(
  version: ClientVersionDto | null,
  platformTarget: ReturnType<typeof resolveUpdatePlatform>,
  currentVersion: string,
  clientMirrorPrefix?: string | null,
  fallbackArtifact?: ClientUpdateArtifact | null
): ClientUpdateCheckResult | null {
  if (!version) {
    return null;
  }

  const hasUpdate =
    compareVersion(version.currentVersion, currentVersion) > 0 ||
    compareVersion(version.minimumVersion, currentVersion) > 0 ||
    version.forceUpgrade;

  if (!hasUpdate) {
    return null;
  }

  const originDownloadUrl = resolveUpdateDownloadUrl(version.downloadUrl ?? null);
  const downloadUrl = originDownloadUrl ? applyUpdateMirrorPrefix(originDownloadUrl, clientMirrorPrefix) : null;
  const fileType = preferredArtifactType(platformTarget);
  const compatibleFallbackArtifact =
    fallbackArtifact &&
    fallbackArtifact.fileType === fileType &&
    (fallbackArtifact.originDownloadUrl === originDownloadUrl || fallbackArtifact.downloadUrl === downloadUrl)
      ? fallbackArtifact
      : null;

  return {
    platform: platformTarget,
    channel: UPDATE_CHANNEL,
    currentVersion,
    latestVersion: version.currentVersion,
    minimumVersion: version.minimumVersion,
    hasUpdate: true,
    forceUpgrade: version.forceUpgrade || compareVersion(version.minimumVersion, currentVersion) > 0,
    title: `发现新版本 ${formatVersionLabel(version.currentVersion)}`,
    changelog: version.changelog,
    publishedAt: null,
    deliveryMode: platformTarget === "android" ? "apk_download" : "desktop_installer_download",
    downloadUrl,
    artifact: downloadUrl
        ? {
          fileType,
          downloadUrl,
          originDownloadUrl,
          defaultMirrorPrefix: normalizeMirrorPrefix(clientMirrorPrefix) ?? compatibleFallbackArtifact?.defaultMirrorPrefix ?? null,
          allowClientMirror: compatibleFallbackArtifact?.allowClientMirror ?? true,
          fileName: compatibleFallbackArtifact?.fileName ?? inferInstallerFileName(downloadUrl, fileType),
          fileSizeBytes: compatibleFallbackArtifact?.fileSizeBytes ?? null,
          fileHash: compatibleFallbackArtifact?.fileHash ?? null,
          isPrimary: true,
          isFullPackage: true
        }
      : null
  };
}

function updateActionLabel(update: ClientUpdateCheckResult, downloadState?: UpdateDownloadState) {
  if (downloadState?.phase === "preparing") {
    return "正在准备下载";
  }
  if (downloadState?.phase === "downloading") {
    return "正在下载安装器";
  }
  if (downloadState?.phase === "completed") {
    return "重新打开安装器";
  }
  if (update.deliveryMode === "apk_download") {
    return "下载 APK 安装包";
  }
  if (update.deliveryMode === "external_download") {
    return "打开下载页";
  }
  return "下载并安装更新";
}

function createIdleUpdateDownloadState(): UpdateDownloadState {
  return {
    phase: "idle",
    fileName: null,
    downloadedBytes: 0,
    totalBytes: null,
    localPath: null,
    message: null
  };
}

function createIdleServerProbeState(): ServerProbeState {
  return {
    status: "idle",
    elapsedMs: null,
    checkedAt: null,
    errorMessage: null
  };
}

function toSubscriptionServerProbe(serverProbe: ServerProbeState): SubscriptionServerProbe {
  switch (serverProbe.status) {
    case "healthy":
      return {
        status: "healthy",
        label: "连接服务器正常",
        detail: serverProbe.elapsedMs !== null ? `连接服务器延迟 ${serverProbe.elapsedMs} ms` : "服务器连接正常"
      };
    case "slow":
      return {
        status: "slow",
        label: "连接服务器较慢",
        detail: serverProbe.elapsedMs !== null ? `连接服务器延迟 ${serverProbe.elapsedMs} ms` : "服务器有响应，但速度偏慢"
      };
    case "failed":
      return {
        status: "failed",
        label: "无法连接服务器",
        detail: serverProbe.errorMessage ?? "当前无法连接服务器，请检查网络或服务端状态"
      };
    default:
      return {
        status: "checking",
        label: "正在检查服务器连接",
        detail: "首次打开后会自动检查一次服务器连接"
      };
  }
}

function pickTicketId(
  tickets: ClientSupportTicketSummaryDto[],
  preferredId: string | null | undefined
) {
  if (preferredId && tickets.some((ticket) => ticket.id === preferredId)) {
    return preferredId;
  }
  return tickets[0]?.id ?? null;
}

function patchAnnouncementRecord(item: AnnouncementDto, action: "seen" | "ack", touchedAt: string) {
  const current = item as AnnouncementDto & {
    seenAt?: string | null;
    acknowledgedAt?: string | null;
    isSeen?: boolean;
    isAcknowledged?: boolean;
    readState?: {
      seenAt?: string | null;
      acknowledgedAt?: string | null;
      isSeen?: boolean;
      isAcknowledged?: boolean;
    } | null;
  };
  const nextReadState = {
    ...(current.readState ?? {}),
    seenAt: action === "seen" ? touchedAt : (current.readState?.seenAt ?? current.seenAt ?? touchedAt),
    acknowledgedAt:
      action === "ack" ? touchedAt : (current.readState?.acknowledgedAt ?? current.acknowledgedAt ?? null),
    isSeen: true,
    isAcknowledged: action === "ack" ? true : (current.readState?.isAcknowledged ?? current.isAcknowledged ?? false)
  };
  return {
    ...current,
    seenAt: nextReadState.seenAt,
    acknowledgedAt: nextReadState.acknowledgedAt,
    isSeen: nextReadState.isSeen,
    isAcknowledged: nextReadState.isAcknowledged,
    readState: nextReadState
  };
}

function isPassiveAnnouncementUnread(item: AnnouncementDto) {
  const current = item as AnnouncementDto & {
    seenAt?: string | null;
    isSeen?: boolean;
    readState?: {
      seenAt?: string | null;
      isSeen?: boolean;
    } | null;
  };
  if (current.readState?.isSeen === true || Boolean(current.readState?.seenAt)) {
    return false;
  }
  if (current.isSeen === true || Boolean(current.seenAt)) {
    return false;
  }
  return true;
}

function isForcedAnnouncementPending(item: AnnouncementDto) {
  const current = item as AnnouncementDto & {
    acknowledgedAt?: string | null;
    isAcknowledged?: boolean;
    readState?: {
      acknowledgedAt?: string | null;
      isAcknowledged?: boolean;
    } | null;
  };
  if (current.readState?.isAcknowledged === true || Boolean(current.readState?.acknowledgedAt)) {
    return false;
  }
  if (current.isAcknowledged === true || Boolean(current.acknowledgedAt)) {
    return false;
  }
  return true;
}

function isTicketUnread(ticket: ClientSupportTicketSummaryDto | ClientSupportTicketDetailDto) {
  const current = ticket as ClientSupportTicketSummaryDto & {
    unread?: boolean;
    hasUnread?: boolean;
    unreadMessageCount?: number | null;
    lastReadAt?: string | null;
    unreadAt?: string | null;
  };
  if (typeof current.unread === "boolean") {
    return current.unread;
  }
  if (typeof current.hasUnread === "boolean") {
    return current.hasUnread;
  }
  if (typeof current.unreadMessageCount === "number") {
    return current.unreadMessageCount > 0;
  }
  if (current.unreadAt) {
    return true;
  }
  return false;
}

function markTicketRecordAsRead<T extends ClientSupportTicketSummaryDto | ClientSupportTicketDetailDto>(ticket: T, ticketId: string): T {
  if (ticket.id !== ticketId) {
    return ticket;
  }
  return {
    ...ticket,
    unread: false,
    hasUnread: false,
    unreadMessageCount: 0,
    unreadAt: null,
    lastReadAt: new Date().toISOString()
  } as T;
}

function normalizeUpdateDownloadProgress(
  current: UpdateDownloadState,
  progress: DesktopUpdateDownloadProgress
): UpdateDownloadState {
  const totalBytes = mergeKnownTotalBytes(current.totalBytes, progress.totalBytes);
  return {
    phase: progress.phase,
    fileName: progress.fileName ?? current.fileName,
    downloadedBytes: mergeKnownDownloadedBytes(current.downloadedBytes, progress.downloadedBytes, totalBytes, progress.phase),
    totalBytes,
    localPath: progress.localPath ?? current.localPath,
    message: progress.message ?? current.message
  };
}

function downloadProgressPercent(downloadState: UpdateDownloadState) {
  if (!hasKnownTotalBytes(downloadState.totalBytes)) {
    return downloadState.phase === "completed" ? 100 : 0;
  }
  return Math.max(0, Math.min(100, (downloadState.downloadedBytes / downloadState.totalBytes) * 100));
}

function displayUpdateDownloadProgress(downloadState: UpdateDownloadState, indeterminateValue: number) {
  if (downloadState.phase === "completed") {
    return 100;
  }
  if (downloadState.phase === "failed") {
    return hasKnownTotalBytes(downloadState.totalBytes) ? downloadProgressPercent(downloadState) : 0;
  }
  if (!hasKnownTotalBytes(downloadState.totalBytes)) {
    if (downloadState.phase === "preparing") {
      return 12;
    }
    if (downloadState.phase === "downloading") {
      return indeterminateValue;
    }
    return 0;
  }
  return downloadProgressPercent(downloadState);
}

function describeUpdateDownload(downloadState: UpdateDownloadState) {
  if (downloadState.phase === "idle") {
    return "点击下方按钮后，系统会先下载完整安装器。";
  }
  const amount = hasKnownTotalBytes(downloadState.totalBytes)
    ? `${formatByteSize(downloadState.downloadedBytes)} / ${formatByteSize(downloadState.totalBytes)}`
    : downloadState.downloadedBytes > 0
      ? `已下载 ${formatByteSize(downloadState.downloadedBytes)}`
      : null;
  const prefix = downloadState.fileName ? `${downloadState.fileName} · ` : "";
  const message = downloadState.message ?? phaseMessage(downloadState.phase);
  return `${prefix}${message}${
    amount && (downloadState.phase === "downloading" || downloadState.phase === "completed") ? `（${amount}）` : ""
  }`;
}

function phaseMessage(phase: UpdateDownloadState["phase"]) {
  switch (phase) {
    case "preparing":
      return "正在准备下载";
    case "downloading":
      return "正在下载安装器";
    case "completed":
      return "安装器已下载完成";
    case "failed":
      return "安装器下载失败";
    default:
      return "等待开始下载";
  }
}

function formatByteSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

function resolveRuntimePlanPlatform(platformTarget: RuntimeStatus["platformTarget"]): "macos" | "windows" {
  return platformTarget === "windows" ? "windows" : "macos";
}

function resolveRuntimeComponentCandidate(
  component: RuntimeComponentDownloadItem,
  customPrefix: string
) {
  const normalizedPrefix = customPrefix.trim();
  if (normalizedPrefix) {
    const originCandidate = component.candidates.find((candidate) => candidate.source === "origin") ?? component.candidates[0];
    if (originCandidate?.url) {
      return {
        url: `${trimTrailingSlash(normalizedPrefix)}/${originCandidate.url}`,
        source: "client_override" as const
      };
    }
  }
  const selectedCandidate =
    component.candidates.find((candidate) => candidate.url === component.selectedUrl) ??
    component.candidates[0];
  return selectedCandidate ? { url: selectedCandidate.url, source: selectedCandidate.source } : null;
}

function canOpenRuntimeAssetsDialog(
  forceUpdateRequired: boolean,
  forcedAnnouncement: AnnouncementDto | null,
  updateDialogOpened: boolean,
  announcementDrawerOpened: boolean,
  updateDownloadPhase: UpdateDownloadState["phase"]
) {
  if (forcedAnnouncement) {
    return false;
  }
  if (updateDialogOpened) {
    return false;
  }
  if (updateDownloadPhase === "preparing" || updateDownloadPhase === "downloading") {
    return false;
  }
  if (announcementDrawerOpened) {
    return false;
  }
  return true;
}

function normalizeRuntimeAssetsProgress(
  current: RuntimeAssetsUiState,
  progress: RuntimeComponentDownloadProgress
): RuntimeAssetsUiState {
  const phase = normalizeRuntimeAssetsPhase(progress.phase, current);
  const downloadedBytes = normalizeRuntimeAssetsDownloadedBytes(current.downloadedBytes, progress.downloadedBytes, phase);
  const totalBytes = mergeKnownTotalBytes(current.totalBytes, progress.totalBytes);
  return {
    phase,
    currentComponent: progress.component,
    fileName: progress.fileName ?? current.fileName,
    downloadedBytes,
    totalBytes,
    message: resolveRuntimeAssetsProgressMessage(progress, phase, downloadedBytes, totalBytes, current.message),
    errorCode: progress.phase === "failed" ? current.errorCode : null,
    errorMessage: progress.phase === "failed" ? progress.message ?? current.errorMessage : null,
    blocking: progress.phase !== "completed"
  };
}

function mergeKnownTotalBytes(currentTotalBytes: number | null, nextTotalBytes: number | null) {
  if (hasKnownTotalBytes(nextTotalBytes)) {
    return nextTotalBytes;
  }
  return currentTotalBytes;
}

function mergeKnownDownloadedBytes(
  currentDownloadedBytes: number,
  nextDownloadedBytes: number,
  totalBytes: number | null,
  phase: UpdateDownloadState["phase"]
) {
  const currentValue = normalizeDownloadedBytes(currentDownloadedBytes);
  const nextValue = normalizeDownloadedBytes(nextDownloadedBytes);
  if (phase === "completed") {
    if (hasKnownTotalBytes(totalBytes)) {
      return totalBytes;
    }
    return Math.max(currentValue, nextValue);
  }
  if (nextValue > 0) {
    return hasKnownTotalBytes(totalBytes) ? Math.min(nextValue, totalBytes) : nextValue;
  }
  if (phase === "downloading" && currentValue > 0) {
    return currentValue;
  }
  return nextValue;
}

function normalizeDownloadedBytes(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function hasKnownTotalBytes(totalBytes: number | null): totalBytes is number {
  return typeof totalBytes === "number" && Number.isFinite(totalBytes) && totalBytes > 0;
}

function normalizeRuntimeAssetsDownloadedBytes(
  currentDownloadedBytes: number,
  nextDownloadedBytes: number,
  phase: RuntimeAssetsUiState["phase"]
) {
  if (phase === "failed") {
    return currentDownloadedBytes;
  }
  if (!Number.isFinite(nextDownloadedBytes) || nextDownloadedBytes < 0) {
    return currentDownloadedBytes;
  }
  return Math.max(currentDownloadedBytes, nextDownloadedBytes);
}

function normalizeRuntimeAssetsPhase(
  phase: RuntimeComponentDownloadProgress["phase"],
  current: RuntimeAssetsUiState
): RuntimeAssetsUiState["phase"] {
  if (phase === "failed") {
    return "failed";
  }
  if (phase === "completed") {
    return "ready";
  }
  if (phase === "downloading" || phase === "extracting") {
    return "downloading";
  }
  if (phase === "preparing" && current.phase === "downloading") {
    return "downloading";
  }
  return "checking";
}

function resolveRuntimeAssetsProgressMessage(
  progress: RuntimeComponentDownloadProgress,
  phase: RuntimeAssetsUiState["phase"],
  downloadedBytes: number,
  totalBytes: number | null,
  fallbackMessage: string | null
) {
  if (progress.message?.trim()) {
    return progress.message;
  }
  if (phase === "downloading") {
    if (progress.phase === "extracting") {
      return "正在写入并校验组件文件…";
    }
    if (!totalBytes || totalBytes <= 0) {
      if (downloadedBytes > 0) {
        return "已连接下载源，正在持续接收数据…";
      }
      return "正在建立下载连接…";
    }
  }
  return fallbackMessage;
}

function extractRuntimeAssetsErrorCode(message: string): RuntimeDownloadFailureReason {
  const prefixed = message.match(/^runtime_component_error:([a-z_]+):/i);
  if (prefixed?.[1]) {
    return prefixed[1] as RuntimeDownloadFailureReason;
  }
  if (message.includes("hash")) {
    return "hash_mismatch";
  }
  if (message.includes("extract")) {
    return "extract_failed";
  }
  if (message.includes("write")) {
    return "write_failed";
  }
  if (message.includes("download")) {
    return "download_failed";
  }
  if (message.includes("not found") || message.includes("404")) {
    return "component_missing";
  }
  return "unknown";
}

function stripRuntimeAssetsErrorPrefix(message: string) {
  return message.replace(/^runtime_component_error:[a-z_]+:/i, "").trim();
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function inferInstallerFileName(downloadUrl: string, fileType: string) {
  try {
    const url = new URL(downloadUrl);
    const lastSegment = url.pathname.split("/").filter(Boolean).pop();
    if (lastSegment) {
      return decodeURIComponent(lastSegment);
    }
  } catch {
    // ignore
  }
  if (fileType === "setup.exe") {
    return "ChordV-setup.exe";
  }
  if (fileType === "apk") {
    return "ChordV.apk";
  }
  if (fileType === "ipa") {
    return "ChordV.ipa";
  }
  return "ChordV.dmg";
}

function readError(message: string) {
  try {
    const parsed = JSON.parse(message) as { message?: string[] | string };
    if (Array.isArray(parsed.message)) {
      return parsed.message.join("，");
    }
    if (typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    return message;
  }

  return message;
}

function sameGuidance(left: ConnectionGuidance | null, right: ConnectionGuidance | null) {
  if (!left || !right) {
    return left === right;
  }
  return guidanceKey(left) === guidanceKey(right);
}

function guidanceKey(guidance: ConnectionGuidance) {
  return [guidance.code, guidance.message, guidance.recommendedNodeId ?? ""].join(":");
}

function isSubscriptionBlocked(subscription: SubscriptionStatusDto | null) {
  if (!subscription) {
    return false;
  }
  return (
    subscription.state === "expired" ||
    subscription.state === "exhausted" ||
    subscription.state === "paused" ||
    subscription.remainingTrafficGb <= 0 ||
    subscription.stateReasonCode === "account_disabled" ||
    subscription.stateReasonCode === "team_access_revoked"
  );
}

function deriveGuidanceFromSubscription(
  subscription: SubscriptionStatusDto,
  fallbackNodeId: string | null
): ConnectionGuidance | null {
  const stateReasonGuidance = deriveGuidanceFromSubscriptionStateReason(subscription, fallbackNodeId);
  if (stateReasonGuidance) {
    return stateReasonGuidance;
  }
  if (subscription.state === "expired") {
    return {
      code: "subscription_expired",
      tone: "danger",
      title: "订阅已到期",
      message: "当前订阅已到期，连接已停止，请联系服务商续期后再使用。",
      actionLabel: "订阅已到期",
      recommendedNodeId: fallbackNodeId
    };
  }
  if (subscription.state === "exhausted" || subscription.remainingTrafficGb <= 0) {
    return {
      code: "subscription_exhausted",
      tone: "danger",
      title: "流量已用尽",
      message: "当前订阅流量已用尽，连接已停止，请重置或续费后再使用。",
      actionLabel: "流量已用尽",
      recommendedNodeId: fallbackNodeId
    };
  }
  if (subscription.state === "paused") {
    return {
      code: "subscription_paused",
      tone: "warning",
      title: "订阅已暂停",
      message: "当前订阅已暂停，连接已停止，请联系服务商恢复后再使用。",
      actionLabel: "订阅已暂停",
      recommendedNodeId: fallbackNodeId
    };
  }
  return null;
}

function deriveGuidanceFromMessage(
  message: string,
  options: { fallbackNodeId: string | null }
): ConnectionGuidance | null {
  if (message.includes("当前节点授权已取消") || message.includes("当前节点已被取消授权")) {
    return {
      code: "node_access_revoked",
      tone: "warning",
      title: "当前节点已撤权",
      message: "当前节点已被取消授权，请切换其他可用节点后重新连接。",
      actionLabel: "切换节点后重连",
      recommendedNodeId: options.fallbackNodeId
    };
  }
  if (
    message.includes("当前节点客户端已停用") ||
    message.includes("管理员已暂停当前连接") ||
    message.includes("连接已被管理员暂停")
  ) {
    return {
      code: "admin_paused",
      tone: "danger",
      title: "连接已被管理员暂停",
      message: "管理员已暂停你的当前连接，请联系服务商或稍后重试。",
      actionLabel: "重新连接",
      recommendedNodeId: options.fallbackNodeId
    };
  }
  if (message.includes("当前节点客户端凭据已更新") || message.includes("当前连接凭据已更新")) {
    return {
      code: "client_rotated",
      tone: "warning",
      title: "连接凭据已更新",
      message: "当前连接凭据已更新，请重新连接以恢复使用。",
      actionLabel: "重新连接",
      recommendedNodeId: options.fallbackNodeId
    };
  }
  if (message.includes("当前连接已被其他设备接管")) {
    return {
      code: "session_replaced",
      tone: "warning",
      title: "连接已被其他设备接管",
      message: "当前连接已被其他设备接管，请在当前设备重新连接。",
      actionLabel: "重新连接",
      recommendedNodeId: options.fallbackNodeId
    };
  }
  if (message.includes("当前订阅已到期")) {
    return {
      code: "subscription_expired",
      tone: "danger",
      title: "订阅已到期",
      message: "当前订阅已到期，连接已停止，请联系服务商续期后再使用。",
      actionLabel: "订阅已到期",
      recommendedNodeId: options.fallbackNodeId
    };
  }
  if (message.includes("当前订阅流量已用尽")) {
    return {
      code: "subscription_exhausted",
      tone: "danger",
      title: "流量已用尽",
      message: "当前订阅流量已用尽，连接已停止，请重置或续费后再使用。",
      actionLabel: "流量已用尽",
      recommendedNodeId: options.fallbackNodeId
    };
  }
  if (message.includes("当前订阅已暂停")) {
    return {
      code: "subscription_paused",
      tone: "warning",
      title: "订阅已暂停",
      message: "当前订阅已暂停，连接已停止，请联系服务商恢复后再使用。",
      actionLabel: "订阅已暂停",
      recommendedNodeId: options.fallbackNodeId
    };
  }
  if (message.includes("当前成员已失去团队访问权限")) {
    return {
      code: "team_access_revoked",
      tone: "danger",
      title: "团队访问权限已失效",
      message: "你已失去当前团队的访问权限，请联系团队负责人处理。",
      actionLabel: "返回并刷新",
      recommendedNodeId: options.fallbackNodeId
    };
  }
  if (message.includes("当前账号已禁用")) {
    return {
      code: "account_disabled",
      tone: "danger",
      title: "账号已禁用",
      message: "当前账号已被禁用，连接已停止，请联系服务商处理。",
      actionLabel: "返回并刷新",
      recommendedNodeId: options.fallbackNodeId
    };
  }
  if (message.includes("会话已过期") || message.includes("当前连接已过期")) {
    return {
      code: "session_expired",
      tone: "warning",
      title: "连接已超时",
      message: "当前连接已超时，请重新连接。",
      actionLabel: "重新连接",
      recommendedNodeId: options.fallbackNodeId
    };
  }
  if (message.includes("会话已失效") || message.includes("当前连接已失效") || message.includes("当前连接已断开")) {
    return {
      code: "session_invalid",
      tone: "warning",
      title: "连接已失效",
      message: "当前连接已失效，请重新连接。",
      actionLabel: "重新连接",
      recommendedNodeId: options.fallbackNodeId
    };
  }
  return null;
}

function deriveGuidanceFromConnectFailure(
  message: string,
  fallbackNodeId: string | null,
  platformTarget: RuntimeStatus["platformTarget"] = "web"
): ConnectionGuidance | null {
  const existing = deriveGuidanceFromMessage(message, { fallbackNodeId });
  if (existing) {
    return existing;
  }
  const runtimeFailure = deriveGuidanceFromRuntimeFailure(message, fallbackNodeId);
  if (runtimeFailure) {
    return runtimeFailure;
  }
  if (message.includes("当前订阅未开通该节点")) {
    return {
      code: "node_access_revoked",
      tone: "warning",
      title: "当前节点未开通",
      message: "当前节点未开通，请切换其他可用节点后重新连接。",
      actionLabel: "切换节点后重连",
      recommendedNodeId: fallbackNodeId
    };
  }
  if (platformTarget === "android" && looksLikeGenericConnectFailure(message)) {
    return {
      code: "android_runtime_start_failed",
      tone: "danger",
      title: "安卓运行时启动失败",
      message: "安卓本地连接链没有成功建立，当前连接未生效。请重新连接，若仍失败请明天接真机后继续排查。",
      actionLabel: "重新连接",
      recommendedNodeId: fallbackNodeId,
      errorCode: extractRuntimeReasonCode(message) ?? "android_runtime_start_failed"
    };
  }
  if (looksLikeNodeUnavailable(message)) {
    return {
      code: "node_unavailable",
      tone: "warning",
      title: "节点暂不可用",
      message: "当前节点连接失败，请切换其他可用节点后重试。",
      actionLabel: "切换节点后重连",
      recommendedNodeId: fallbackNodeId,
      errorCode: "node_unavailable"
    };
  }
  if (platformTarget === "android") {
    return {
      code: "android_runtime_start_failed",
      tone: "danger",
      title: "安卓运行时启动失败",
      message: "安卓本地连接链没有成功建立，当前连接未生效。请重新连接后再试。",
      actionLabel: "重新连接",
      recommendedNodeId: fallbackNodeId,
      errorCode: extractRuntimeReasonCode(message) ?? "android_runtime_start_failed"
    };
  }
  return null;
}

function looksLikeGenericConnectFailure(message: string) {
  return (
    message.includes("连接失败") ||
    message.includes("超时") ||
    message === "连接失败" ||
    message.includes("当前节点连接失败")
  );
}

function looksLikeNodeUnavailable(message: string) {
  return (
    message.includes("节点暂不可用") ||
    message.includes("节点不可用") ||
    message.includes("节点探测失败") ||
    message.includes("节点连接超时") ||
    message.includes("节点测速失败") ||
    message.includes("当前节点已离线") ||
    message.includes("当前节点已下线") ||
    message.includes("节点离线") ||
    message.includes("节点被禁用")
  );
}

function deriveGuidanceFromRuntimeFailure(
  rawMessage: string,
  fallbackNodeId: string | null
): ConnectionGuidance | null {
  const message = readError(rawMessage);
  const runtimeReasonCode = extractRuntimeReasonCode(message);
  if (
    message.includes("external_vpn_conflict") ||
    message.includes("已有 VPN 正在运行") ||
    message.includes("请先断开后再连接 ChordV")
  ) {
    return {
      code: "desktop_external_vpn_conflict",
      tone: "warning",
      title: "检测到其他 VPN 正在运行",
      message: "系统里已经有其他 VPN 处于连接状态。请先断开那个 VPN，再连接 ChordV。",
      actionLabel: "重试连接",
      recommendedNodeId: fallbackNodeId,
      errorCode: runtimeReasonCode ?? "external_vpn_conflict"
    };
  }

  if (
    message.includes("external_proxy_conflict") ||
    message.includes("系统代理已由其他应用占用")
  ) {
    return {
      code: "desktop_external_proxy_conflict",
      tone: "warning",
      title: "检测到其他代理正在运行",
      message: "系统代理已经被其他应用占用。请先关闭那个代理软件，再连接 ChordV。",
      actionLabel: "重试连接",
      recommendedNodeId: fallbackNodeId,
      errorCode: runtimeReasonCode ?? "external_proxy_conflict"
    };
  }

  if (
    message.includes("config_missing") ||
    message.includes("start_args_missing") ||
    message.includes("geo_resource_missing")
  ) {
    return {
      code: "android_runtime_start_failed",
      tone: "danger",
      title: "安卓运行配置不完整",
      message: "安卓本地运行所需资源或配置不完整，当前连接未生效。请联系管理员检查安卓资源包。",
      actionLabel: "重试连接",
      recommendedNodeId: fallbackNodeId,
      errorCode: runtimeReasonCode ?? "config_missing"
    };
  }
  if (
    message.includes("vpn_permission_denied") ||
    message.includes("vpn_permission_lost") ||
    message.includes("未授予 Android VPN 权限") ||
    message.includes("Android VPN 权限") ||
    message.includes("需要授权 VPN")
  ) {
    const permissionLost = message.includes("vpn_permission_lost") || message.includes("系统回收了 VPN 权限");
    return {
      code: "android_vpn_permission_denied",
      tone: "warning",
      title: permissionLost ? "VPN 权限已失效" : "需要 VPN 权限",
      message: permissionLost
        ? "安卓系统已回收 VPN 权限，当前连接已失效。请重新连接，并在系统弹窗里重新允许。"
        : "安卓需要系统 VPN 权限才能连接。请重新连接，并在系统弹窗里点击允许。",
      actionLabel: "重新连接",
      recommendedNodeId: fallbackNodeId,
      errorCode: runtimeReasonCode ?? "vpn_permission_denied"
    };
  }

  if (
    message.includes("建立 Android VPN 接口失败") ||
    message.includes("VPN 接口建立失败") ||
    message.includes("vpn_interface_establish_failed") ||
    message.includes("vpn_interface_not_ready") ||
    message.includes("Android VPN/TUN 启动失败") ||
    message.includes("调用 Android VPN/TUN 运行时失败")
  ) {
    return {
      code: "android_vpn_setup_failed",
      tone: "danger",
      title: "VPN 接口建立失败",
      message: "安卓未能建立系统 VPN 接口，当前连接未生效。请关闭同类 VPN 应用后重试。",
      actionLabel: "重新连接",
      recommendedNodeId: fallbackNodeId,
      errorCode: runtimeReasonCode ?? "vpn_interface_establish_failed"
    };
  }

  if (
    message.includes("service_start_failed") ||
    message.includes("android_runtime_start_failed") ||
    message.includes("libv2ray_start_failed") ||
    message.includes("Android 运行时插件未注册") ||
    message.includes("Android xray 进程未启动") ||
    message.includes("Android 运行时启动失败") ||
    message.includes("缺少 Android")
  ) {
    return {
      code: "android_runtime_start_failed",
      tone: "danger",
      title: "安卓运行时启动失败",
      message: "安卓本地运行时没有成功启动，当前连接未生效。请重新连接，若仍失败请联系管理员处理。",
      actionLabel: "重新连接",
      recommendedNodeId: fallbackNodeId,
      errorCode: runtimeReasonCode ?? "android_runtime_start_failed"
    };
  }

  if (
    message.includes("runtime_stopped") ||
    message.includes("runtime_mismatch") ||
    message.includes("connectivity_check_failed") ||
    message.includes("Android VPN/TUN 尚未进入已连接状态") ||
    message.includes("连通性自检失败") ||
    message.includes("连接自检失败") ||
    message.includes("当前连接未生效")
  ) {
    return {
      code: "android_connectivity_failed",
      tone: "danger",
      title: "连接未真正生效",
      message: message.includes("runtime_stopped") || message.includes("runtime_mismatch")
        ? "安卓后台运行时已停止，当前连接已失效。请重新连接，若仍失败请更换节点。"
        : "安卓虽然完成了启动，但当前连接没有通过自检。请重新连接，若仍失败请更换节点。",
      actionLabel: "重新连接",
      recommendedNodeId: fallbackNodeId,
      errorCode: runtimeReasonCode ?? "android_connectivity_failed"
    };
  }

  if (
    message.includes("系统代理设置失败") ||
    message.includes("Windows 系统代理设置失败") ||
    message.includes("代理接管失败") ||
    message.includes("InternetSetOption") ||
    message.includes("WinINET")
  ) {
    return {
      code: "windows_proxy_failed",
      tone: "danger",
      title: "系统代理设置失败",
      message: "Windows 未能接管系统代理，当前连接未生效。请关闭安全软件拦截后重试，或联系管理员处理。",
      actionLabel: "重新连接",
      recommendedNodeId: fallbackNodeId,
      errorCode: runtimeReasonCode ?? "windows_proxy_failed"
    };
  }

  if (
    message.includes("本地代理启动失败") ||
    message.includes("本地代理未就绪") ||
    message.includes("本地代理端口未就绪") ||
    message.includes("连通性检查失败") ||
    message.includes("代理连通性检查失败")
  ) {
    return {
      code: "windows_local_proxy_failed",
      tone: "danger",
      title: "本地代理启动失败",
      message: "本地代理端口没有成功启动，当前连接未生效。请重新连接，若仍失败请联系管理员处理。",
      actionLabel: "重新连接",
      recommendedNodeId: fallbackNodeId,
      errorCode: runtimeReasonCode ?? "windows_local_proxy_failed"
    };
  }

  if (
    message.includes("内核已退出") ||
    message.includes("xray 已退出") ||
    message.includes("核心已退出") ||
    message.includes("内核进程已退出") ||
    message.includes("spawn") ||
    message.includes("启动 xray 失败")
  ) {
    return {
      code: "runtime_exited",
      tone: "danger",
      title: "内核已退出",
      message: "本地内核未能持续运行，连接已停止。请重新连接，若仍失败请联系管理员处理。",
      actionLabel: "重新连接",
      recommendedNodeId: fallbackNodeId,
      errorCode: runtimeReasonCode ?? "runtime_exited"
    };
  }

  return null;
}

function composeRuntimeFailureText(status: RuntimeStatus) {
  const fragments = [status.reasonCode, status.lastError, status.recoveryHint];

  if (status.platformTarget === "android") {
    if (status.vpnActive === false) {
      fragments.push("Android VPN 接口未建立");
    }
    if (status.connectivityVerified === false) {
      fragments.push("connectivity_check_failed");
      fragments.push("连接自检失败");
    }
  }

  return fragments.filter(Boolean).join(" ");
}

function deriveGuidanceFromRuntimeStatus(
  status: RuntimeStatus,
  fallbackNodeId: string | null
): ConnectionGuidance | null {
  if (status.platformTarget !== "android") {
    return null;
  }
  if (!status.reasonCode && !status.lastError && status.vpnActive !== false && status.connectivityVerified !== false) {
    return null;
  }
  return deriveGuidanceFromRuntimeFailure(composeRuntimeFailureText(status), fallbackNodeId);
}

async function loadConnectFailureRuntimeStatus() {
  const first = await loadRuntimeStatus();
  if (!shouldRetryAndroidRuntimeStatus(first)) {
    return first;
  }

  let latest = first;
  for (let index = 0; index < 3; index += 1) {
    await waitForRuntimeStatus(180);
    latest = await loadRuntimeStatus();
    if (!shouldRetryAndroidRuntimeStatus(latest)) {
      return latest;
    }
  }

  return latest;
}

function shouldRetryAndroidRuntimeStatus(status: RuntimeStatus) {
  if (status.platformTarget !== "android") {
    return false;
  }

  const hasSpecificFailure =
    Boolean(status.reasonCode) ||
    Boolean(status.lastError) ||
    status.vpnActive === false ||
    status.connectivityVerified === false;

  if (hasSpecificFailure) {
    return false;
  }

  return status.status === "idle" || status.status === "starting" || status.status === "connecting";
}

function formatGuidanceMessage(guidance: ConnectionGuidance) {
  if (!guidance.errorCode) {
    return guidance.message;
  }
  return `${guidance.message}\n错误代码：${guidance.errorCode}`;
}

function isDialogOnlyGuidance(code: ConnectionGuidanceCode) {
  return code === "desktop_external_vpn_conflict" || code === "desktop_external_proxy_conflict";
}

function extractRuntimeReasonCode(message: string) {
  const knownCodes = [
    "vpn_permission_denied",
    "vpn_permission_lost",
    "vpn_interface_establish_failed",
    "vpn_interface_not_ready",
    "libv2ray_start_failed",
    "connectivity_check_failed",
    "config_missing",
    "geo_resource_missing",
    "start_args_missing",
    "service_start_failed",
    "android_runtime_start_failed",
    "service_stop_failed",
    "android_runtime_stop_failed",
    "runtime_stopped",
    "runtime_mismatch",
    "service_task_removed",
    "external_vpn_conflict",
    "external_proxy_conflict",
    "windows_proxy_failed",
    "windows_local_proxy_failed"
  ];

  return knownCodes.find((code) => message.includes(code)) ?? null;
}

function waitForRuntimeStatus(delayMs: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

function deriveGuidanceFromRuntimeEvent(
  event: ClientRuntimeEventDto,
  fallbackNodeId: string | null
): ConnectionGuidance | null {
  const message = event.reasonMessage;

  switch (event.reasonCode) {
    case "admin_paused_connection":
      return {
        code: "admin_paused",
        tone: "danger",
        title: "连接已被管理员暂停",
        message: message ?? "管理员已暂停你的当前连接，请联系服务商或稍后重试。",
        actionLabel: "重新连接",
        recommendedNodeId: fallbackNodeId,
        errorCode: event.reasonCode ?? "admin_paused_connection"
      };
    case "node_access_revoked":
      return {
        code: "node_access_revoked",
        tone: "warning",
        title: "当前节点已撤权",
        message: message ?? "当前节点已被取消授权，请切换其他可用节点后重新连接。",
        actionLabel: "切换节点后重连",
        recommendedNodeId: fallbackNodeId,
        errorCode: event.reasonCode ?? "node_access_revoked"
      };
    case "subscription_expired":
      return {
        code: "subscription_expired",
        tone: "danger",
        title: "订阅已到期",
        message: message ?? "当前订阅已到期，连接已停止，请联系服务商续期后再使用。",
        actionLabel: "订阅已到期",
        recommendedNodeId: fallbackNodeId,
        errorCode: event.reasonCode ?? "subscription_expired"
      };
    case "subscription_exhausted":
      return {
        code: "subscription_exhausted",
        tone: "danger",
        title: "流量已用尽",
        message: message ?? "当前订阅流量已用尽，连接已停止，请重置或续费后再使用。",
        actionLabel: "流量已用尽",
        recommendedNodeId: fallbackNodeId,
        errorCode: event.reasonCode ?? "subscription_exhausted"
      };
    case "subscription_paused":
      return {
        code: "subscription_paused",
        tone: "warning",
        title: "订阅已暂停",
        message: message ?? "当前订阅已暂停，连接已停止，请联系服务商恢复后再使用。",
        actionLabel: "订阅已暂停",
        recommendedNodeId: fallbackNodeId,
        errorCode: event.reasonCode ?? "subscription_paused"
      };
    case "connection_taken_over":
      return {
        code: "session_replaced",
        tone: "warning",
        title: "连接已被其他设备接管",
        message: message ?? "当前连接已被其他设备接管，请在当前设备重新连接。",
        actionLabel: "重新连接",
        recommendedNodeId: fallbackNodeId,
        errorCode: event.reasonCode ?? "connection_taken_over"
      };
    case "account_disabled":
      return {
        code: "account_disabled",
        tone: "danger",
        title: "账号已禁用",
        message: message ?? "当前账号已被禁用，连接已停止，请联系服务商处理。",
        actionLabel: "返回并刷新",
        recommendedNodeId: fallbackNodeId,
        errorCode: event.reasonCode ?? "account_disabled"
      };
    case "team_access_revoked":
      return {
        code: "team_access_revoked",
        tone: "danger",
        title: "团队访问权限已失效",
        message: message ?? "你已失去当前团队的访问权限，请联系团队负责人处理。",
        actionLabel: "返回并刷新",
        recommendedNodeId: fallbackNodeId,
        errorCode: event.reasonCode ?? "team_access_revoked"
      };
    case "runtime_credentials_rotated":
      return {
        code: "client_rotated",
        tone: "warning",
        title: "连接凭据已更新",
        message: message ?? "当前连接凭据已更新，请重新连接以恢复使用。",
        actionLabel: "重新连接",
        recommendedNodeId: fallbackNodeId,
        errorCode: event.reasonCode ?? "runtime_credentials_rotated"
      };
    case "session_expired":
      return {
        code: "session_expired",
        tone: "warning",
        title: "连接已超时",
        message: message ?? "当前连接已过期，请重新连接。",
        actionLabel: "重新连接",
        recommendedNodeId: fallbackNodeId,
        errorCode: event.reasonCode ?? "session_expired"
      };
    case "session_invalid":
    case "auth_invalid":
      return {
        code: "session_invalid",
        tone: "warning",
        title: "连接已失效",
        message: message ?? "当前连接已失效，请重新连接。",
        actionLabel: "重新连接",
        recommendedNodeId: fallbackNodeId,
        errorCode: event.reasonCode ?? "session_invalid"
      };
    default:
      return null;
  }
}

function clearResolvedGuidance(
  current: ConnectionGuidance | null,
  subscription: SubscriptionStatusDto,
  nodes: NodeSummaryDto[]
) {
  if (!current) {
    return current;
  }
  if (
    current.code === "subscription_expired" &&
    subscription.state !== "expired" &&
    subscription.remainingTrafficGb > 0
  ) {
    return null;
  }
  if (
    current.code === "subscription_exhausted" &&
    subscription.state !== "exhausted" &&
    subscription.remainingTrafficGb > 0
  ) {
    return null;
  }
  if (current.code === "subscription_paused" && subscription.state !== "paused") {
    return null;
  }
  if (current.code === "account_disabled" && subscription.stateReasonCode !== "account_disabled") {
    return null;
  }
  if (current.code === "team_access_revoked" && subscription.stateReasonCode !== "team_access_revoked") {
    return null;
  }
  if ((current.code === "node_access_revoked" || current.code === "node_unavailable") && current.recommendedNodeId) {
    return nodes.some((node) => node.id === current.recommendedNodeId) ? current : null;
  }
  return current;
}

function pickAlternativeNode(
  nodes: NodeSummaryDto[],
  currentNodeId: string | null,
  probeResults: Record<string, RuntimeNodeProbeResult>
) {
  const healthyAlternative =
    nodes.find((node) => node.id !== currentNodeId && probeResults[node.id]?.status === "healthy") ??
    nodes.find((node) => node.id !== currentNodeId);
  return healthyAlternative ?? null;
}

function deriveGuidanceFromSubscriptionStateReason(
  subscription: SubscriptionStatusDto,
  fallbackNodeId: string | null
) {
  if (!subscription.stateReasonCode && !subscription.stateReasonMessage) {
    return null;
  }

  return (
    deriveGuidanceFromRuntimeEvent(
      {
        type: "subscription_updated",
        occurredAt: subscription.lastSyncedAt,
        reasonCode: subscription.stateReasonCode ?? null,
        reasonMessage: subscription.stateReasonMessage ?? null
      },
      fallbackNodeId
    ) ??
    (subscription.stateReasonMessage
      ? deriveGuidanceFromMessage(subscription.stateReasonMessage, { fallbackNodeId })
      : null)
  );
}

function shouldAutoHandleRuntimeGuidance(status: RuntimeStatus, sessionId: string | null) {
  if (status.platformTarget !== "android") {
    return false;
  }
  if (!sessionId && !status.activeSessionId) {
    return false;
  }
  return (
    status.status !== "idle" &&
    status.status !== "connecting" &&
    status.status !== "starting" &&
    status.status !== "disconnecting"
  );
}

function describeForegroundSyncFailure(reason: unknown) {
  const raw = reason instanceof Error ? readError(reason.message) : "应用回到前台后未能同步最新状态，请检查网络后重试。";
  if (
    raw.includes("Failed to fetch") ||
    raw.includes("Load failed") ||
    raw.includes("NetworkError") ||
    raw.includes("fetch")
  ) {
    return "应用回到前台后发现网络已中断，暂时无法同步最新状态。请检查网络后重试。";
  }
  return "应用回到前台后未能同步最新状态，请检查网络后重试。";
}

function showErrorToast(message: string) {
  notifications.show({
    color: "red",
    title: "操作失败",
    message
  });
}

function toneToToastColor(tone: GuidanceTone) {
  if (tone === "danger") return "red";
  if (tone === "warning") return "yellow";
  return "cyan";
}
