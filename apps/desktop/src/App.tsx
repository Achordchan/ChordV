import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, LoadingOverlay, Modal, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type {
  AnnouncementDto,
  AuthSessionDto,
  ClientBootstrapDto,
  ClientRuntimeEventDto,
  ConnectionMode,
  GeneratedRuntimeConfigDto,
  NodeSummaryDto,
  SubscriptionStatusDto
} from "@chordv/shared";
import {
  connectSession,
  disconnectSession,
  fetchBootstrap,
  fetchClientRuntime,
  fetchNodeProbes,
  fetchNodes,
  fetchSubscription,
  heartbeatSession,
  login,
  logoutSession,
  refreshSession,
  subscribeClientEvents
} from "./api/client";
import { AnnouncementDrawer } from "./components/AnnouncementDrawer";
import { ControlPanel } from "./components/ControlPanel";
import { LogDrawer } from "./components/LogDrawer";
import { LoginScreen } from "./components/LoginScreen";
import { NodeListPanel } from "./components/NodeListPanel";
import { SubscriptionPanel } from "./components/SubscriptionPanel";
import {
  appReady,
  clearStoredSession,
  connectRuntime,
  createIdleRuntimeStatus,
  disconnectRuntime,
  focusDesktopWindow,
  loadRuntimeLogs,
  loadRuntimeStatus,
  loadStoredSession,
  saveStoredSession,
  type RuntimeNodeProbeResult,
  type RuntimeStatus
} from "./lib/runtime";

const appVersion = import.meta.env.VITE_APP_VERSION ?? "0.1.0";
const PROBE_COOLDOWN_MS = 25000;
const LAST_NODE_KEY = "chordv_last_node_id";
const REMEMBER_CREDENTIALS_KEY = "chordv_remember_credentials";

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
};

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
  const [connectionGuidance, setConnectionGuidance] = useState<ConnectionGuidance | null>(null);
  const [guidanceDialog, setGuidanceDialog] = useState<ConnectionGuidance | null>(null);
  const leaseHeartbeatFailedAtRef = useRef<number | null>(null);
  const lastMeteringToastRef = useRef<string | null>(null);
  const lastGuidanceToastRef = useRef<string | null>(null);
  const lastRuntimeSignalKeyRef = useRef<string | null>(null);
  const lastForegroundSyncErrorRef = useRef<string | null>(null);
  const lastForegroundSyncAtRef = useRef(0);
  const localStopInFlightRef = useRef<Promise<void> | null>(null);
  const runtimeRescueTriggeredRef = useRef(false);
  const runtimeRef = useRef<GeneratedRuntimeConfigDto | null>(null);
  const nodesRef = useRef<NodeSummaryDto[]>([]);
  const selectedNodeIdRef = useRef<string | null>(null);
  const probeResultsRef = useRef<Record<string, RuntimeNodeProbeResult>>({});

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
  const subscriptionBlocked = isSubscriptionBlocked(bootstrap?.subscription ?? null);
  const selectedNodeOffline = selectedNode ? probeResults[selectedNode.id]?.status === "offline" : false;
  const canConnect =
    Boolean(selectedNode) &&
    nodes.length > 0 &&
    !subscriptionBlocked &&
    !selectedNodeOffline &&
    desktopStatus.status !== "connected" &&
    desktopStatus.status !== "connecting";
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
      passiveAnnouncements.some((item) => localStorage.getItem(passiveAnnouncementStorageKey(item.id)) !== "seen"),
    [forcedAnnouncement, passiveAnnouncements]
  );

  useEffect(() => {
    runtimeRef.current = runtime;
  }, [runtime]);

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
      return localStorage.getItem(announcementStorageKey(item.id)) !== "ack";
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

  async function initializeApp() {
    try {
      const rememberedCredentials = loadRememberedCredentials();
      if (rememberedCredentials) {
        setCredentials(rememberedCredentials);
        setRememberPassword(true);
      }
      await refreshRuntime();
      const storedSession = await loadStoredSession();
      if (storedSession) {
        await bootstrapSession(storedSession, true, false, true);
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
    try {
      const [status, logs] = await Promise.all([loadRuntimeStatus(), loadRuntimeLogs()]);
      setDesktopStatus(status);
      if (!status.activeSessionId && status.status !== "connecting" && status.status !== "disconnecting") {
        setRuntime(null);
      }
      setRuntimeLog(logs.log);
    } catch {
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

  async function handlePrimaryAction() {
    if (desktopStatus.status === "connected" || desktopStatus.status === "error") {
      await handleDisconnect();
      return;
    }

    await handleConnect();
  }

  async function handleConnect() {
    if (!session || !selectedNode || actionBusy || !canConnect) {
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
      await forceStopLocalRuntime();
      await refreshRuntime();
      const message = reason instanceof Error ? readError(reason.message) : "连接失败";
      const connectGuidance = deriveGuidanceFromConnectFailure(message, fallbackNode?.id ?? null);
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
    if (toast) {
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
      message: guidance.message,
      autoClose: 4000
    });
  }

  function openAnnouncementDrawer() {
    for (const item of passiveAnnouncements) {
      localStorage.setItem(passiveAnnouncementStorageKey(item.id), "seen");
    }
    setAnnouncementDrawerOpened(true);
  }

  function acknowledgeAnnouncement() {
    if (!forcedAnnouncement) {
      return;
    }

    localStorage.setItem(announcementStorageKey(forcedAnnouncement.id), "ack");
    setForcedAnnouncement(null);
    setCountdown(0);
  }

  return (
    <div className="desktop-app">
      <LoadingOverlay visible={booting} zIndex={200} overlayProps={{ blur: 1 }} />

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
              refreshing={refreshing}
              onOpenAnnouncements={openAnnouncementDrawer}
              onRefresh={() => void handleRefresh()}
              onLogout={() => void handleLogout()}
            />
            {shouldShowUpdate(bootstrap) ? (
              <Alert color={bootstrap.version.forceUpgrade ? "red" : "blue"}>
                {bootstrap.version.forceUpgrade ? "当前版本过低，请先升级客户端。" : "发现新版本，可前往下载地址更新。"}
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
              primaryLabel={primaryButtonLabel(desktopStatus.status, bootstrap.subscription, connectionGuidance, selectedNodeOffline)}
              desktopStatus={desktopStatus}
              runtime={runtime}
              error={runtimeDisplayError}
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
          <Button size="lg" onClick={dismissGuidanceDialog}>
            {guidanceDialog?.actionLabel ?? "我知道了"}
          </Button>
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
  selectedNodeOffline: boolean
) {
  if (status === "connecting") return "连接中";
  if (status === "disconnecting") return "断开中";
  if (status === "connected" || status === "error") return "断开连接";
  if (subscription.state === "expired") return "订阅已到期";
  if (subscription.state === "exhausted" || subscription.remainingTrafficGb <= 0) return "流量已用尽";
  if (subscription.state === "paused") return "订阅已暂停";
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

function announcementStorageKey(id: string) {
  return `chordv_announcement_ack_${id}`;
}

function passiveAnnouncementStorageKey(id: string) {
  return `chordv_announcement_seen_${id}`;
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

function shouldShowUpdate(bootstrap: ClientBootstrapDto) {
  return (
    compareVersion(bootstrap.version.currentVersion, appVersion) > 0 ||
    compareVersion(bootstrap.version.minimumVersion, appVersion) > 0 ||
    bootstrap.version.forceUpgrade
  );
}

function compareVersion(left: string, right: string) {
  const leftParts = left.split(".").map((item) => Number(item) || 0);
  const rightParts = right.split(".").map((item) => Number(item) || 0);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue > rightValue) return 1;
    if (leftValue < rightValue) return -1;
  }

  return 0;
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

function deriveGuidanceFromConnectFailure(message: string, fallbackNodeId: string | null): ConnectionGuidance | null {
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
  if (message.includes("节点") || message.includes("超时") || message.includes("连接失败")) {
    return {
      code: "node_unavailable",
      tone: "warning",
      title: "节点暂不可用",
      message: "当前节点连接失败，请切换其他可用节点后重试。",
      actionLabel: "切换节点后重连",
      recommendedNodeId: fallbackNodeId
    };
  }
  return null;
}

function deriveGuidanceFromRuntimeFailure(
  rawMessage: string,
  fallbackNodeId: string | null
): ConnectionGuidance | null {
  const message = readError(rawMessage);
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
      recommendedNodeId: fallbackNodeId
    };
  }

  if (
    message.includes("建立 Android VPN 接口失败") ||
    message.includes("VPN 接口建立失败") ||
    message.includes("Android VPN/TUN 启动失败") ||
    message.includes("调用 Android VPN/TUN 运行时失败")
  ) {
    return {
      code: "android_vpn_setup_failed",
      tone: "danger",
      title: "VPN 接口建立失败",
      message: "安卓未能建立系统 VPN 接口，当前连接未生效。请关闭同类 VPN 应用后重试。",
      actionLabel: "重新连接",
      recommendedNodeId: fallbackNodeId
    };
  }

  if (
    message.includes("service_start_failed") ||
    message.includes("android_runtime_start_failed") ||
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
      recommendedNodeId: fallbackNodeId
    };
  }

  if (
    message.includes("runtime_stopped") ||
    message.includes("runtime_mismatch") ||
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
      recommendedNodeId: fallbackNodeId
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
      recommendedNodeId: fallbackNodeId
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
      recommendedNodeId: fallbackNodeId
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
      recommendedNodeId: fallbackNodeId
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
        recommendedNodeId: fallbackNodeId
      };
    case "node_access_revoked":
      return {
        code: "node_access_revoked",
        tone: "warning",
        title: "当前节点已撤权",
        message: message ?? "当前节点已被取消授权，请切换其他可用节点后重新连接。",
        actionLabel: "切换节点后重连",
        recommendedNodeId: fallbackNodeId
      };
    case "subscription_expired":
      return {
        code: "subscription_expired",
        tone: "danger",
        title: "订阅已到期",
        message: message ?? "当前订阅已到期，连接已停止，请联系服务商续期后再使用。",
        actionLabel: "订阅已到期",
        recommendedNodeId: fallbackNodeId
      };
    case "subscription_exhausted":
      return {
        code: "subscription_exhausted",
        tone: "danger",
        title: "流量已用尽",
        message: message ?? "当前订阅流量已用尽，连接已停止，请重置或续费后再使用。",
        actionLabel: "流量已用尽",
        recommendedNodeId: fallbackNodeId
      };
    case "subscription_paused":
      return {
        code: "subscription_paused",
        tone: "warning",
        title: "订阅已暂停",
        message: message ?? "当前订阅已暂停，连接已停止，请联系服务商恢复后再使用。",
        actionLabel: "订阅已暂停",
        recommendedNodeId: fallbackNodeId
      };
    case "connection_taken_over":
      return {
        code: "session_replaced",
        tone: "warning",
        title: "连接已被其他设备接管",
        message: message ?? "当前连接已被其他设备接管，请在当前设备重新连接。",
        actionLabel: "重新连接",
        recommendedNodeId: fallbackNodeId
      };
    case "account_disabled":
      return {
        code: "account_disabled",
        tone: "danger",
        title: "账号已禁用",
        message: message ?? "当前账号已被禁用，连接已停止，请联系服务商处理。",
        actionLabel: "返回并刷新",
        recommendedNodeId: fallbackNodeId
      };
    case "team_access_revoked":
      return {
        code: "team_access_revoked",
        tone: "danger",
        title: "团队访问权限已失效",
        message: message ?? "你已失去当前团队的访问权限，请联系团队负责人处理。",
        actionLabel: "返回并刷新",
        recommendedNodeId: fallbackNodeId
      };
    case "runtime_credentials_rotated":
      return {
        code: "client_rotated",
        tone: "warning",
        title: "连接凭据已更新",
        message: message ?? "当前连接凭据已更新，请重新连接以恢复使用。",
        actionLabel: "重新连接",
        recommendedNodeId: fallbackNodeId
      };
    case "session_expired":
      return {
        code: "session_expired",
        tone: "warning",
        title: "连接已超时",
        message: message ?? "当前连接已过期，请重新连接。",
        actionLabel: "重新连接",
        recommendedNodeId: fallbackNodeId
      };
    case "session_invalid":
    case "auth_invalid":
      return {
        code: "session_invalid",
        tone: "warning",
        title: "连接已失效",
        message: message ?? "当前连接已失效，请重新连接。",
        actionLabel: "重新连接",
        recommendedNodeId: fallbackNodeId
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
