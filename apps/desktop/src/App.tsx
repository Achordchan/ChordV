import { useEffect, useMemo, useState } from "react";
import { Alert, Button, LoadingOverlay, Modal, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { AnnouncementDto, AuthSessionDto, ClientBootstrapDto, ConnectionMode, GeneratedRuntimeConfigDto, NodeSummaryDto } from "@chordv/shared";
import { connectSession, disconnectSession, fetchBootstrap, fetchNodes, login, logoutSession, refreshSession } from "./api/client";
import { AnnouncementDrawer } from "./components/AnnouncementDrawer";
import { ControlPanel } from "./components/ControlPanel";
import { LogDrawer } from "./components/LogDrawer";
import { LoginScreen } from "./components/LoginScreen";
import { NodeListPanel } from "./components/NodeListPanel";
import { SubscriptionPanel } from "./components/SubscriptionPanel";
import {
  appReady,
  clearStoredSession,
  focusDesktopWindow,
  invokeDesktopConnect,
  invokeDesktopDisconnect,
  loadDesktopRuntimeLogs,
  loadDesktopRuntimeStatus,
  loadStoredSession,
  probeNodes,
  saveStoredSession,
  type DesktopNodeProbeResult,
  type DesktopRuntimeStatus
} from "./lib/runtime";

const appVersion = import.meta.env.VITE_APP_VERSION ?? "0.1.0";
const PROBE_COOLDOWN_MS = 25000;
const LAST_NODE_KEY = "chordv_last_node_id";

export function App() {
  const [session, setSession] = useState<AuthSessionDto | null>(null);
  const [bootstrap, setBootstrap] = useState<ClientBootstrapDto | null>(null);
  const [nodes, setNodes] = useState<NodeSummaryDto[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [mode, setMode] = useState<ConnectionMode>("rule");
  const [runtime, setRuntime] = useState<GeneratedRuntimeConfigDto | null>(null);
  const [desktopStatus, setDesktopStatus] = useState<DesktopRuntimeStatus>({
    status: "idle",
    activeSessionId: null,
    configPath: null,
    logPath: null,
    xrayBinaryPath: null,
    activePid: null,
    lastError: null
  });
  const [runtimeLog, setRuntimeLog] = useState("");
  const [booting, setBooting] = useState(true);
  const [authBusy, setAuthBusy] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState<"connect" | "disconnect" | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);
  const [probeCooldownUntil, setProbeCooldownUntil] = useState(0);
  const [probeResults, setProbeResults] = useState<Record<string, DesktopNodeProbeResult>>({});
  const [logDrawerOpened, setLogDrawerOpened] = useState(false);
  const [announcementDrawerOpened, setAnnouncementDrawerOpened] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credentials, setCredentials] = useState({ email: "", password: "" });
  const [forcedAnnouncement, setForcedAnnouncement] = useState<AnnouncementDto | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [now, setNow] = useState(Date.now());

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId]
  );
  const probeCooldownLeft = Math.max(0, Math.ceil((probeCooldownUntil - now) / 1000));
  const canConnect = Boolean(selectedNode) && nodes.length > 0 && desktopStatus.status !== "connected" && desktopStatus.status !== "connecting";
  const modeLocked = desktopStatus.status === "connecting" || desktopStatus.status === "connected" || desktopStatus.status === "disconnecting";
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

  async function initializeApp() {
    try {
      await focusDesktopWindow();
      await refreshRuntime();
      const storedSession = await loadStoredSession();
      if (storedSession) {
        await bootstrapSession(storedSession, true, false);
      }
    } finally {
      await appReady().catch(() => null);
      setBooting(false);
    }
  }

  async function refreshRuntime() {
    try {
      const [status, logs] = await Promise.all([loadDesktopRuntimeStatus(), loadDesktopRuntimeLogs()]);
      setDesktopStatus(status);
      if (!status.activeSessionId && status.status !== "connecting" && status.status !== "disconnecting") {
        setRuntime(null);
      }
      setRuntimeLog(logs.log);
    } catch {
      setDesktopStatus({
        status: "idle",
        activeSessionId: null,
        configPath: null,
        logPath: null,
        xrayBinaryPath: null,
        activePid: null,
        lastError: null
      });
      setRuntime(null);
      setRuntimeLog("");
    }
  }

  async function bootstrapSession(nextSession: AuthSessionDto, allowRefresh: boolean, preserveMode: boolean) {
    try {
      const [nextBootstrap, nextNodes] = await Promise.all([
        fetchBootstrap(nextSession.accessToken),
        fetchNodes(nextSession.accessToken)
      ]);

      setSession(nextSession);
      setBootstrap(nextBootstrap);
      setNodes(nextNodes);
      if (!preserveMode) {
        setMode(resolveDefaultMode(nextBootstrap));
      }
      setError(null);
      if (nextNodes.length === 0) {
        showErrorToast("当前订阅未分配节点");
      }

      const preferred = pickNode(nextNodes, loadLastNodeId());
      setSelectedNodeId(preferred?.id ?? null);

      if (nextNodes.length > 0) {
        await runProbe(nextNodes, true);
      } else {
        setProbeResults({});
      }

      return true;
    } catch (reason) {
      if (allowRefresh && nextSession.refreshToken) {
        try {
          const refreshed = await refreshSession(nextSession.refreshToken);
          await saveStoredSession(refreshed);
          return await bootstrapSession(refreshed, false, preserveMode);
        } catch {
          await clearSession();
        }
      } else {
        await clearSession();
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
      const nextSession = await login(credentials.email.trim(), credentials.password);
      await saveStoredSession(nextSession);
      await bootstrapSession(nextSession, false, false);
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
      await bootstrapSession(session, true, modeLocked);
    } catch (reason) {
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
      if (desktopStatus.status === "connected" || desktopStatus.status === "error") {
        await handleDisconnect();
      }
      await logoutSession().catch(() => null);
      await clearSession();
      setCredentials((current) => ({ ...current, password: "" }));
    } finally {
      setLogoutBusy(false);
    }
  }

  async function clearSession() {
    await clearStoredSession().catch(() => null);
    setSession(null);
    setBootstrap(null);
    setNodes([]);
    setSelectedNodeId(null);
    setProbeResults({});
    setRuntime(null);
    setMode("rule");
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
      await invokeDesktopConnect(config);
      localStorage.setItem(LAST_NODE_KEY, selectedNode.id);
      setRuntime(config);
      await refreshRuntime();
    } catch (reason) {
      await refreshRuntime();
      showErrorToast(reason instanceof Error ? readError(reason.message) : "连接失败");
    } finally {
      setActionBusy(null);
    }
  }

  async function handleDisconnect() {
    if (!session || actionBusy || (desktopStatus.status !== "connected" && desktopStatus.status !== "error")) {
      return;
    }

    try {
      setActionBusy("disconnect");
      setDesktopStatus((current) => ({ ...current, status: "disconnecting", lastError: null }));
      await disconnectSession(session.accessToken);
      await invokeDesktopDisconnect();
      setRuntime(null);
      await refreshRuntime();
    } catch (reason) {
      await refreshRuntime();
      showErrorToast(reason instanceof Error ? readError(reason.message) : "断开失败");
    } finally {
      setActionBusy(null);
    }
  }

  async function runProbe(targetNodes: NodeSummaryDto[], auto: boolean) {
    if (probeBusy || targetNodes.length === 0) {
      return;
    }

    try {
      setProbeBusy(true);
      const result = await probeNodes(targetNodes);
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

    } catch (reason) {
      if (!auto) {
        showErrorToast(reason instanceof Error ? readError(reason.message) : "测速失败");
      }
    } finally {
      setProbeBusy(false);
    }
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
          loading={authBusy}
          error={null}
          onEmailChange={(value) => setCredentials((current) => ({ ...current, email: value }))}
          onPasswordChange={(value) => setCredentials((current) => ({ ...current, password: value }))}
          onSubmit={() => void handleLogin()}
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
              onSelect={(nodeId) => setSelectedNodeId(nodeId)}
              onProbe={() => void runProbe(nodes, false)}
            />

            <ControlPanel
              modes={bootstrap.policies.modes}
              mode={mode}
              canConnect={canConnect}
              modeLocked={modeLocked}
              primaryBusy={actionBusy !== null}
              primaryLabel={primaryButtonLabel(desktopStatus.status)}
              desktopStatus={desktopStatus}
              runtime={runtime}
              error={desktopStatus.lastError}
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

function primaryButtonLabel(status: string) {
  if (status === "connecting") return "连接中";
  if (status === "disconnecting") return "断开中";
  if (status === "connected" || status === "error") return "断开连接";
  return "启动连接";
}

function pickNode(
  nodes: NodeSummaryDto[],
  preferredId: string | null,
  probeResults?: Record<string, DesktopNodeProbeResult>
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

function showErrorToast(message: string) {
  notifications.show({
    color: "red",
    title: "操作失败",
    message
  });
}
