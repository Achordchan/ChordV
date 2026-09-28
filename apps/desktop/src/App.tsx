import { canApplyNativeSessionRefresh } from "./lib/nativeSessionRefresh";
import { ClientUpdateProgressPanel } from "./components/ClientUpdateProgressPanel";
import { ClientUpdateModal } from "./components/ClientUpdateModal";
import { lazy, Suspense } from "react";
import { shouldReportNodeAccessRevoked } from "./lib/startupReadiness";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Button, Checkbox, LoadingOverlay, Stack, Text, ThemeIcon, UnstyledButton } from "@mantine/core";
import { showToast } from "./components/Toast";
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
  getApiErrorRawMessage,
  heartbeatSession,
  isAccessTokenExpiredApiError,
  isForbiddenApiError,
  isUnauthorizedApiError,
  probeClientServerLatency,
  type ReleaseChannel
} from "./api/client";
import { AnnouncementDrawer } from "./components/AnnouncementDrawer";
import { AppDialog, DialogText } from "./components/AppDialog";
import { GuidanceDialog } from "./components/GuidanceDialog";
import { NoticeRow } from "./components/NoticeRow";
import { ControlPanel } from "./components/ControlPanel";
import { LocalFilesDialog } from "./components/LocalFilesDialog";
import { LogDrawer } from "./components/LogDrawer";
import { LoginScreen } from "./components/LoginScreen";
import { MeteringFloatingBanner } from "./components/MeteringFloatingBanner";
import { NodeListPanel } from "./components/NodeListPanel";
import { RuntimeAssetsBanner } from "./components/RuntimeAssetsBanner";
import { RoutingRulesModal } from "./components/RoutingRulesModal";
import { SubscriptionPanel } from "./components/SubscriptionPanel";
import { UpdateCenterModal } from "./components/UpdateCenterModal";
import {
  appReady,
  focusDesktopWindow,
  hasActivePlatformRuntime,
  loadActiveRuntimeConfig,
  loadDesktopOsLabel,
  revealLocalFile,
  subscribeDesktopShellActions,
  subscribeNativeLeaseHeartbeat,
  subscribeNativeSessionRefreshed,
  subscribeNativeExitFailure,
  updateDesktopShellSummary,
  type RuntimeNodeProbeResult,
  type RuntimeStatus
} from "./lib/runtime";
import { resolveDesktopPlatformVersion } from "./lib/platformVersion";
import { APP_BUILD_NUMBER } from "./lib/buildInfo";
import { readRecentErrorCodes, recordRecentErrorCode } from "./lib/recentErrorCodes";
import { collectSupportLaunchContext, type SupportContextSnapshot } from "./lib/supportContext";
import { loadSupportComponentsInfo } from "./lib/supportContextSources";
import { localFileKindForComponent, resolveLocalFileVersions, supportsLocalFiles, type LocalFileKind, type LocalFileVersions } from "./lib/localFiles";
import { readStoredGeoVersionLabel } from "./lib/geoUpdate";
import { readStoredXrayInstalledIdentity } from "./lib/xrayInstall";
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
import { toUserMessage } from "./lib/userFacingErrors";
import {
  clearRememberedCredentials as clearRememberedCredentialsStorage,
  loadRememberedCredentials as loadRememberedCredentialsFromStorage,
  pickNode,
  primaryButtonLabel,
  resolveDefaultMode,
  saveRememberedCredentials as saveRememberedCredentialsToStorage,
  showErrorToast,
  createLoggedUserErrorReader,
  toSubscriptionServerProbe,
  formatTrayTrafficLine
} from "./lib/appState";
import {
  recoverDesktopSessionAfterUnauthorized,
  resolveProactiveAccessTokenRefreshDelay
} from "./lib/desktopSessionRecovery";
import { buildProtectedAccessNotice, resolveProtectedAccessReason } from "./lib/sessionLeaseState";
import {
  formatVersionLabel,
  updateActionLabel
} from "./lib/updateState";
import { useAnnouncements } from "./hooks/useAnnouncements";
import { flushSync } from "react-dom";
import { useDesktopWindowLayout } from "./hooks/useDesktopWindowLayout";
import { useAuthBootstrap } from "./hooks/useAuthBootstrap";
import { createIdleServerProbeState, type ServerProbeState, useClientEvents } from "./hooks/useClientEvents";
import { useNodeProbe } from "./hooks/useNodeProbe";
import { useRuntimeActions } from "./hooks/useRuntimeActions";
import { useComponentVersionSync } from "./hooks/useComponentVersionSync";
import { useRuntimeAssets, type RuntimeAssetsCheckSummary } from "./hooks/useRuntimeAssets";
import { useRuntimeStatus } from "./hooks/useRuntimeStatus";
import { useSupportPortal } from "./hooks/useSupportPortal";
import { buildUpdatePromptKey, hasActionableUpdate, useUpdateFlow } from "./hooks/useUpdateFlow";
import { describeRequiredUpdate } from "./lib/updateState";
import { readAutoDownloadPreference, writeAutoDownloadPreference } from "./lib/silentUpdate";
const REMEMBER_CREDENTIALS_KEY = "chordv_remember_credentials";
const DESKTOP_CLOSE_HINT_KEY = "chordv_desktop_close_hint_ack";
const RUNTIME_COMPONENT_MIRROR_PREFIX_KEY = "chordv_runtime_component_mirror_prefix";
const UPDATE_CHANNEL_KEY = "chordv_update_channel";

declare global {
  interface Window {
    __CHORDV_DESKTOP_SHELL__?: {
      toggleConnection: () => void;
      openLogs: () => void;
      setMode: (mode: string) => void;
      selectNode: (nodeId: string) => void;
    };
  }
}

const DownloadProgressDebug = (import.meta.env.DEV || import.meta.env.VITE_CHORDV_LOCAL_PREVIEW === "1")
  ? lazy(() => import("./dev/DownloadProgressDebug").then(module => ({ default: module.DownloadProgressDebug }))) : null;
// 只负责展示的 hook 使用面向客户的错误读取器：原始错误不会直接出现在界面上。
// 读取器接收完整错误对象（保留 HTTP 状态），被隐藏的原文会写入诊断日志。
const readAnnouncementError = createLoggedUserErrorReader("announcement");
const readNodeProbeError = createLoggedUserErrorReader("node_probe");
const readServerProbeError = createLoggedUserErrorReader("server_probe");

export function App() {
  const [session, setSessionState] = useState<AuthSessionDto | null>(null);
  const [bootstrap, setBootstrap] = useState<ClientBootstrapDto | null>(null);
  const [nodes, setNodes] = useState<NodeSummaryDto[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [mode, setMode] = useState<ConnectionMode>("rule");
  const [runtime, setRuntime] = useState<GeneratedRuntimeConfigDto | null>(null);
  const [booting, setBooting] = useState(true);
  const startupInspectionKeyRef = useRef<string | null>(null);
  const { mainLayoutReady, windowTransitioning, prepareStartupLayout, windowLayoutError, windowResizeBusy, retryWindowLayout } = useDesktopWindowLayout(Boolean(session && bootstrap), booting);
  const [authBusy, setAuthBusy] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logDrawerOpened, setLogDrawerOpened] = useState(false);
  const [routingRulesOpened, setRoutingRulesOpened] = useState(false);
  const [announcementDrawerOpened, setAnnouncementDrawerOpened] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credentials, setCredentials] = useState({ email: "", password: "" });
  const [rememberPassword, setRememberPassword] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [connectionGuidance, setConnectionGuidance] = useState<ConnectionGuidance | null>(null);
  // 连接指引可能只弹对话框、不弹提示条：出现时把错误编号记入“最近错误”（只有编号和时间），打开工单时附带给客服。
  useEffect(() => {
    if (connectionGuidance && connectionGuidance.tone !== "info") {
      recordRecentErrorCode(connectionGuidance.errorCode ?? connectionGuidance.code);
    }
  }, [connectionGuidance]);
  // 提前取一次系统版本（原生层缓存），点“工单”时不必等待。
  useEffect(() => {
    void loadDesktopOsLabel();
  }, []);
  const [guidanceDialog, setGuidanceDialog] = useState<ConnectionGuidance | null>(null);
  const [closeHintOpened, setCloseHintOpened] = useState(false);
  const [localFilesOpened, setLocalFilesOpened] = useState(false);
  const [rememberCloseHint, setRememberCloseHint] = useState(true);
  const [mobileTab, setMobileTab] = useState<"home" | "nodes" | "profile">("home");
  const [serverProbe, setServerProbe] = useState<ServerProbeState>(createIdleServerProbeState());
  const [serverProbeBusy, setServerProbeBusy] = useState(false);
  const leaseHeartbeatFailedAtRef = useRef<number | null>(null);
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
  const shellActionRef = useRef<(() => Promise<void>) | null>(null);
  const openLogsActionRef = useRef<(() => void) | null>(null);
  const trayModeActionRef = useRef<((mode: string) => Promise<void>) | null>(null);
  const trayNodeActionRef = useRef<((nodeId: string) => Promise<void>) | null>(null);
  const sessionRef = useRef<AuthSessionDto | null>(null);
  const sessionGenerationRef = useRef(0);
  const invalidateSessionOperations = useCallback(() => { sessionGenerationRef.current += 1; }, []);
  const setSession = useCallback<Dispatch<SetStateAction<AuthSessionDto | null>>>((update) => {
    const previous = sessionRef.current;
    const next = typeof update === "function" ? update(previous) : update;
    if (!next || previous?.user.id !== next.user.id) sessionGenerationRef.current += 1;
    sessionRef.current = next;
    setSessionState(next);
  }, []);
  const unauthorizedRecoveryTaskRef = useRef<Promise<AuthSessionDto | null> | null>(null);
  const lastShellSummaryRef = useRef("");
  const pendingShellSummaryRef = useRef("");
  const shellSummaryRequestSeqRef = useRef(0);
  const { desktopStatus, setDesktopStatus, runtimeLog, refreshRuntime, forceStopLocalRuntime, getRuntimeSyncEpoch, isRuntimeStopping } = useRuntimeStatus({
    setRuntime,
    leaseHeartbeatFailedAtRef
  });
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
    markAnnouncementSeen,
    acknowledgeAnnouncement: syncAcknowledgeAnnouncement
  } = useAnnouncements({
    accessToken: session?.accessToken ?? null,
    announcements: bootstrap?.announcements ?? [],
    patchAnnouncements: (updater) => {
      setBootstrap((current) => (current ? { ...current, announcements: updater(current.announcements) } : current));
    },
    onUnauthorized: recoverSessionAfterUnauthorized,
    readError: readAnnouncementError,
    notify: showToast
  });
  // 打开工单时附带给客服的诊断信息：快照在下面各状态就绪后每次渲染更新（见 supportContextSnapshotRef.current 的赋值）。
  const supportContextSnapshotRef = useRef<(() => SupportContextSnapshot) | null>(null);
  const { supportUnreadCount, supportOpening, openSupportPortal, refreshSupportStatus, applySupportUnreadCount } =
    useSupportPortal({
      accessToken: session?.accessToken ?? null,
      userId: session?.user.id ?? null,
      onUnauthorized: recoverSessionAfterUnauthorized,
      notify: showToast,
      showError: (reason) => showErrorToast(reason, "support"),
      collectContext: () =>
        collectSupportLaunchContext({
          snapshot: () => supportContextSnapshotRef.current!(),
          loadOsLabel: loadDesktopOsLabel,
          loadComponents: loadSupportComponentsInfo,
          readRecentErrors: readRecentErrorCodes
        })
    });
  const runtimeComponentsCheckRef = useRef<
    | ((input: {
        source: "startup" | "login" | "manual" | "refresh";
        silent?: boolean;
        inspectOnly?: boolean;
        targets?: Array<"xray" | "geo">;
      }) => Promise<import("./hooks/useRuntimeAssets").RuntimeAssetsCheckSummary | null>)
    | null
  >(null);
  // Only legacy mirror-eligible downloads consume this saved override.
  const [runtimeMirrorPrefix, setRuntimeMirrorPrefix] = useState(() => {
    try { return localStorage.getItem(RUNTIME_COMPONENT_MIRROR_PREFIX_KEY) ?? ""; } catch { return ""; }
  });
  const clearLegacyDownloadMirror = () => {
    localStorage.removeItem(RUNTIME_COMPONENT_MIRROR_PREFIX_KEY);
    setRuntimeMirrorPrefix("");
    showToast({message:"旧下载镜像已清除，请重新下载。",tone:"success"});
  };
  const [updateChannel, setUpdateChannel] = useState<ReleaseChannel>(() => {
    try { return localStorage.getItem(UPDATE_CHANNEL_KEY) === "beta" ? "beta" : "stable"; } catch { return "stable"; }
  });
  const changeUpdateChannel = (channel: ReleaseChannel) => {
    try { localStorage.setItem(UPDATE_CHANNEL_KEY, channel); } catch { /* keep the in-memory choice */ }
    setUpdateChannel(channel);
  };
  const [autoDownloadUpdates, setAutoDownloadUpdates] = useState(() => {
    try { return readAutoDownloadPreference(localStorage); } catch { return true; }
  });
  const changeAutoDownloadUpdates = (enabled: boolean) => {
    try { writeAutoDownloadPreference(localStorage, enabled); } catch { /* keep the in-memory choice */ }
    setAutoDownloadUpdates(enabled);
  };
  const updateFlow = useUpdateFlow({
    runtimeMirrorPrefix,
    appVersion,
    platformTarget: desktopStatus.platformTarget,
    accessToken: session?.accessToken ?? null,
    bootstrapVersion: bootstrap?.version ?? null,
    updateChannel,
    autoDownloadUpdates,
    // Only download in the background once the main window is up; the login
    // window has no place for the ready indicator.
    backgroundDownloadAllowed: !booting && !windowTransitioning && mainLayoutReady && Boolean(session && bootstrap),
    // Forced updates install on their own (after a visible countdown), even from the login window.
    forcedUpdateAllowed: !booting && !windowTransitioning,
    notify: showToast,
    showError: showErrorToast,
    onUnauthorized: recoverSessionAfterUnauthorized,
    isPromptBlocked: () =>
      booting || windowTransitioning || runtimeAssetsBusy || announcementDrawerOpened || Boolean(forcedAnnouncement),
    checkRuntimeComponents: async (input) => {
      const runner = runtimeComponentsCheckRef.current;
      if (!runner) {
        return null;
      }
      return runner(input);
    }
  });
  const {
    updatePlatform,
    updateCheckBusy,
    updateCheckStatus,
    effectiveUpdate,
    forceUpdateRequired,
    updateDialogOpened,
    setUpdateDialogOpened,
    updateDownload,
    backgroundUpdateDownload,
    updateReadyToInstall,
    forcedInstallCountdown,
    installForcedUpdateNow,
    deferredUpdatePromptKeyRef,
    lastUpdatePromptVersionRef,
    runUpdateCheck: runUpdateCheckFromHook,
    runUpdateCheckAndFocus,
    handleManualUpdateCheck,
    handleUpdateDownload,
    handleQuitForUpdate,
    updateCenter,
    closeUpdateCenter,
    handleUpdateCenterCheckOnly,
    handleUpdateCenterUpdateOne,
    consumeUpdateInstallReport
  } = updateFlow;
  const effectiveUpdateActionable = hasActionableUpdate(effectiveUpdate, appVersion);
  const updateChannelChecked = useRef(updateChannel);
  useEffect(() => {
    // Re-check once the new channel is in effect so the result matches the switch.
    if (updateChannelChecked.current === updateChannel) return;
    updateChannelChecked.current = updateChannel;
    void handleUpdateCenterCheckOnly();
  }, [handleUpdateCenterCheckOnly, updateChannel]);
  const runUpdateCheck = runUpdateCheckFromHook;
  const runUpdateCheckForAuth = async (input: import("./hooks/useAuthBootstrap").RunUpdateCheckInput) => {
    await runUpdateCheckFromHook(input);
  };
  const {
    runtimeAssets,
    runtimeAssetsReady,
    runtimeAssetsBusy,
    ensureRuntimeAssetsReady,
    getLastRuntimeAssetsCheckSummary,
    handleCancelRuntimeAssets,
    handleRetryRuntimeAssets
  } = useRuntimeAssets({
    runtimeMirrorPrefix,
    appVersion,
    platformTarget: desktopStatus.platformTarget,
    accessToken: session?.accessToken ?? null,
    notify: showToast,
    onUnauthorized: recoverSessionAfterUnauthorized,
    readError
  });
  const componentVersionSync = useComponentVersionSync({
    enabled: !booting && mainLayoutReady && !windowTransitioning && !forceUpdateRequired && (updateCheckStatus === "ready" || updateCheckStatus === "failed"),
    accessToken: session?.accessToken ?? null, status: desktopStatus, assetsBusy: runtimeAssetsBusy,
    applicationUpdateBusy: ["preparing", "downloading", "verifying"].includes(updateDownload.phase),
    ensure: ensureRuntimeAssetsReady, onStatus: setDesktopStatus
  });
  runtimeComponentsCheckRef.current = async (input) => {
    const forceCheck = input.source === "manual" || input.source === "refresh";
    const success = await ensureRuntimeAssetsReady({
      source: "update_check",
      interactive: false,
      blockConnection: false,
      forceCheck,
      inspectOnly: input.inspectOnly,
      targets: input.targets
    });
    const summary = getLastRuntimeAssetsCheckSummary();
    componentVersionSync.reportManualSyncResult(session?.accessToken ?? null, success, summary);
    return summary;
  };
  supportContextSnapshotRef.current = () => {
    const summary = getLastRuntimeAssetsCheckSummary();
    return {
      appVersion,
      appBuild: APP_BUILD_NUMBER,
      pendingUpdate: effectiveUpdateActionable && effectiveUpdate
        ? { version: effectiveUpdate.latestVersion, ready: updateReadyToInstall }
        : null,
      updateChannel,
      autoDownload: autoDownloadUpdates,
      runtimeStatus: desktopStatus.status,
      runtimeErrorCode: connectionGuidance?.errorCode ?? connectionGuidance?.code ?? desktopStatus.reasonCode ?? null,
      sessionId: runtime?.sessionId ?? desktopStatus.activeSessionId ?? null,
      serverProbe: { status: serverProbe.status, elapsedMs: serverProbe.elapsedMs },
      cachedComponents: { xrayVersion: summary.xray.localVersion, geoVersion: summary.geo.localVersion }
    };
  };
  const {
    probeBusy,
    probeCooldownLeft,
    probeResults,
    setProbeResults,
    runProbe
  } = useNodeProbe({
    sessionIdentity: session ? `${sessionGenerationRef.current}:${session.user.id}` : null,
    getCurrentSessionIdentity: () => sessionRef.current ? `${sessionGenerationRef.current}:${sessionRef.current.user.id}` : null,
    getCurrentAccessToken: () => sessionRef.current?.accessToken ?? null,
    accessToken: session?.accessToken ?? null,
    nowMs: now,
    selectedNodeId: selectedNodeId ?? runtime?.node.id ?? null,
    readError: readNodeProbeError,
    onUnauthorized: recoverSessionAfterUnauthorized,
    // 用原始错误映射一次：4xx 业务提示（如“拒绝访问该节点”）没有编号，二次映射会被误判为本机权限问题。
    onError: (message, reason) => showErrorToast(reason || message, "node_probe"),
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
    await runUpdateCheckAndFocus(input);
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
    const rawFailure = desktopStatus.recoveryHint ?? desktopStatus.lastError;
    return (
      deriveGuidanceFromRuntimeFailure(runtimeFailureText, fallbackNode?.id ?? null)?.message ??
      (rawFailure ? toUserMessage(readError(rawFailure), { context: "connect" }) : null)
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
    invalidateSessionOperations,
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
    handleReconnect,
    handleSwitchConnection,
    handleEmergencyDisconnect,
    handleForcedGuidance,
    syncForegroundState,
    dismissGuidanceDialog
  } = useRuntimeActions({
    session,
    bootstrap,
    setBootstrap,
    setMode,
    nodes,
    setNodes,
    selectedNode,
    selectedNodeId,
    setSelectedNodeId,
    mode,
    resolveDefaultMode,
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
    leaseHeartbeatFailedAtRef,
    lastGuidanceToastRef,
    lastForegroundSyncErrorRef,
    connectionGuidance,
    setConnectionGuidance,
    guidanceDialog,
    setGuidanceDialog,
    readError,
    showErrorToast,
    notify: showToast,
    setServerProbe,
    mergeSubscriptionState,
    recoverSessionAfterUnauthorized,
    getRuntimeSyncEpoch,
    isRuntimeStopping,
    getCurrentAccessToken: () => sessionRef.current?.accessToken ?? null,
    getCurrentSessionIdentity: () => sessionRef.current ? `${sessionGenerationRef.current}:${sessionRef.current.user.id}` : null,
    clearSession,
    runUpdateCheck: runUpdateCheckForActions,
    refreshRuntime,
    forceStopLocalRuntime,
    pickNode
  });

  useClientEvents({
    session,
    setServerProbe,
    handleRuntimeEvent: (event, accessToken) => {
      if (event.type === "runtime_component_updated") { componentVersionSync.requestSync(event); return Promise.resolve(); }
      if (event.type === "support_unread_updated") {
        if (sessionRef.current?.accessToken === accessToken) applySupportUnreadCount(event.supportUnreadCount);
        return Promise.resolve();
      }
      return handleRuntimeEvent(event, accessToken);
    },
    syncConnectedState: syncForegroundState,
    runUpdateCheckOnOpen: async () => {
      componentVersionSync.requestSync();
      await runUpdateCheck({
        bootstrapVersion: bootstrap?.version ?? null,
        source: "refresh",
        silent: true,
        includeRuntimeComponents: false
      });
    },
    syncOnOpen: refreshSupportStatus,
    recoverSessionAfterUnauthorized,
    readError: readServerProbeError
  });

  useEffect(() => {
    let disposed=false;
    let unlisten:(()=>void)|undefined;
    void subscribeNativeExitFailure(message=>{
      if(!disposed)showToast({id:"native-exit-failure",title:"退出未完成",tone:"danger",autoClose:false,
        message:`${message}。请稍后再次选择“退出 ChordV”重试。`});
    }).then(cleanup=>{if(disposed)cleanup();else unlisten=cleanup;}).catch(()=>null);
    return ()=>{disposed=true;unlisten?.();};
  }, []);

  useEffect(() => {
    const refreshDelayMs = resolveProactiveAccessTokenRefreshDelay(session);
    if (refreshDelayMs === null) {
      return;
    }

    const timer = window.setTimeout(() => {
      void recoverSessionAfterUnauthorized();
    }, refreshDelayMs);
    return () => window.clearTimeout(timer);
  }, [session?.accessToken, session?.accessTokenExpiresAt, session?.refreshToken]);

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
      showToast({
        tone: "warning",
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
    probeResultsRef.current = probeResults;
  }, [probeResults]);


  useEffect(() => {
    if (session) {
      return;
    }
    startupInspectionKeyRef.current = null;
    setServerProbe(createIdleServerProbeState());
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
        status: "healthy",
        elapsedMs: result.elapsedMs,
        checkedAt: Date.now(),
        errorMessage: null
      });
    } catch (reason) {
      setServerProbe({
        status: "failed",
        elapsedMs: null,
        checkedAt: Date.now(),
        errorMessage: readServerProbeError(reason)
      });
    } finally {
      setServerProbeBusy(false);
    }
  };

  useEffect(() => {
    shellActionRef.current = async () => {
      if (!sessionRef.current) {
        showToast({
          tone: "info",
          title: "请先登录",
          message: "登录后才可以连接节点。"
        });
        void focusDesktopWindow();
        return;
      }
      await handlePrimaryAction();
    };
  });

  const handleSelectNode = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    setConnectionGuidance((current) => {
      const nextGuidance =
        current && (current.code === "node_access_revoked" || current.code === "node_unavailable") ? null : current;
      if (!nextGuidance) {
        setGuidanceDialog(null);
      }
      return nextGuidance;
    });
  };

  // Tray switches take effect immediately: a live connection reconnects with the choice.
  useEffect(() => {
    trayModeActionRef.current = async (requestedMode) => {
      const nextMode = bootstrap?.policies.modes.find((item) => item === requestedMode);
      if (!sessionRef.current || !nextMode || nextMode === mode || actionBusy) {
        return;
      }
      setMode(nextMode);
      await handleSwitchConnection({ mode: nextMode });
    };
    trayNodeActionRef.current = async (nodeId) => {
      if (!sessionRef.current || actionBusy || !nodes.some((node) => node.id === nodeId)) {
        return;
      }
      handleSelectNode(nodeId);
      if ((runtime?.node.id ?? desktopStatus.activeNodeId) !== nodeId) {
        await handleSwitchConnection({ nodeId });
      }
    };
  });

  useEffect(() => {
    openLogsActionRef.current = () => {
      if (!sessionRef.current) {
        showToast({
          tone: "info",
          title: "请先登录",
          message: "登录后才可以查看连接诊断。"
        });
        void focusDesktopWindow();
        return;
      }
      openRuntimeLogs();
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
      },
      setMode: (nextMode) => {
        void trayModeActionRef.current?.(nextMode);
      },
      selectNode: (nodeId) => {
        void trayNodeActionRef.current?.(nodeId);
      }
    };

    return () => {
      delete window.__CHORDV_DESKTOP_SHELL__;
    };
  }, [desktopStatus.platformTarget]);

  useEffect(() => {
    const preventContextMenu = (event: MouseEvent) => {
      if (isEditableContextTarget(event.target) || hasSelectedText()) {
        return;
      }
      event.preventDefault();
    };

    window.addEventListener("contextmenu", preventContextMenu);
    return () => window.removeEventListener("contextmenu", preventContextMenu);
  }, []);

  useEffect(() => {
    void initializeApp();

    // 启动动画/首屏交互优先；运行态轮询延后，避免与启动 IPC 叠压。
    let runtimeTimer: number | null = null;
    const startRuntimePolling = window.setTimeout(() => {
      runtimeTimer = window.setInterval(() => {
        void refreshRuntime({ includeLogs: false });
      }, 5000);
    }, 5000);

    return () => {
      window.clearTimeout(startRuntimePolling);
      if (runtimeTimer !== null) {
        window.clearInterval(runtimeTimer);
      }
    };
  }, []);

  const openRuntimeLogs = () => {
    setLogDrawerOpened(true);
    void refreshRuntime({ includeLogs: true }).catch(() => null);
  };

  // 本地文件入口只在 macOS / Windows 提供；Android 没有可浏览的应用目录。
  const localFilesAvailable = supportsLocalFiles(desktopStatus.platformTarget);
  const localFileVersions = useMemo(
    () => (localFilesOpened ? readLocalFileVersions(getLastRuntimeAssetsCheckSummary()) : {}),
    [getLastRuntimeAssetsCheckSummary, localFilesOpened]
  );
  const handleRevealLocalFile = useCallback((kind: LocalFileKind) => {
    void revealLocalFile(kind).catch((reason) => showErrorToast(reason, "local_files"));
  }, []);
  // 退出登录后不保留打开状态，免得重新登录时弹窗自己冒出来。
  useEffect(() => {
    if (!session) setLocalFilesOpened(false);
  }, [session]);

  useEffect(() => {
    const needsClock = countdown > 0 || probeCooldownLeft > 0;
    if (!needsClock) {
      return;
    }
    const clockTimer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(clockTimer);
    };
  }, [countdown, probeCooldownLeft]);

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

    const summary = {
      status: session ? desktopStatus.status : "signed-out",
      signedIn: Boolean(session),
      nodeName,
      primaryActionLabel: summaryLabel,
      ...(session && bootstrap ? {
        mode,
        modes: bootstrap.policies.modes,
        nodes: nodes.map((node) => {
          const probe = Object.hasOwn(probeResults, node.id) ? probeResults[node.id] : undefined;
          // The native side reads whole milliseconds; a fractional value would reject the summary.
          const latencyMs = typeof probe?.latencyMs === "number" ? Math.round(probe.latencyMs) : null;
          return { id: node.id, name: node.name, latencyMs, status: probe?.status ?? "unknown" };
        }),
        selectedNodeId: runtime?.node.id ?? selectedNodeId,
        trafficLine: formatTrayTrafficLine(bootstrap.subscription)
      } : {})
    };
    const summaryKey = JSON.stringify(summary);
    if (lastShellSummaryRef.current === summaryKey || pendingShellSummaryRef.current === summaryKey) {
      return;
    }
    const requestId = shellSummaryRequestSeqRef.current + 1;
    shellSummaryRequestSeqRef.current = requestId;
    pendingShellSummaryRef.current = summaryKey;

    void updateDesktopShellSummary(summary)
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
    runtime?.node.id,
    selectedNode?.name,
    selectedNodeOffline,
    selectedNodeId,
    bootstrap,
    mode,
    nodes,
    probeResults
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
    const epoch = getRuntimeSyncEpoch();
    void loadActiveRuntimeConfig().then((localRuntime) => {
      if (cancelled || isRuntimeStopping() || getRuntimeSyncEpoch() !== epoch ||
          !localRuntime || localRuntime.sessionId !== desktopStatus.activeSessionId) return;
      setRuntime(localRuntime);
    }).catch(() => null);

    return () => { cancelled = true; };
  }, [desktopStatus.activeSessionId, desktopStatus.platformTarget, runtime,
      session?.accessToken, getRuntimeSyncEpoch, isRuntimeStopping]);

  useEffect(() => {
    if (desktopStatus.platformTarget === "android" || desktopStatus.platformTarget === "web") {
      return;
    }

    let disposed = false;
    let unlistenLease: (() => void) | null = null;
    let unlistenSession: (() => void) | null = null;

    void subscribeNativeLeaseHeartbeat((event) => {
      if (disposed || isRuntimeStopping() || !event.sessionId) {
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
        const epoch = getRuntimeSyncEpoch();
        void (async () => {
          const recoveredSession = await recoverSessionAfterUnauthorized();
          if (disposed || isRuntimeStopping() || getRuntimeSyncEpoch() !== epoch) return;
          if (recoveredSession) {
            leaseHeartbeatFailedAtRef.current = null;
            return;
          }
          await clearSession(true);
          showToast({
            tone: "warning",
            title: "登录已失效",
            message: "当前登录态无法继续续租连接，请重新登录。"
          });
        })();
        return;
      }

      // 403/404 属于明确失效；网络抖动/5xx 等 heartbeat_failed 必须先走宽限，避免闲置一会儿就弹“连接已失效”。
      const definitiveInvalid =
        event.reasonCode === "session_invalid" ||
        event.reasonCode === "session_expired" ||
        event.reasonCode === "session_replaced";
      if (!definitiveInvalid) {
        const graceSeconds = Math.max(30, runtimeRef.current?.leaseGraceSeconds ?? 300);
        const nowMs = Date.now();
        if (!leaseHeartbeatFailedAtRef.current) {
          leaseHeartbeatFailedAtRef.current = nowMs;
          return;
        }
        if (nowMs - leaseHeartbeatFailedAtRef.current < graceSeconds * 1000) {
          return;
        }
      }

      const guidance =
        deriveGuidanceFromMessage(event.message ?? "", {
          fallbackNodeId: fallbackNode?.id ?? null
        }) ??
        ({
          code: "session_invalid" as const,
          tone: "warning" as const,
          title: "连接已失效",
          message: "当前连接已失效，请重新连接。",
          actionLabel: "重新连接",
          recommendedNodeId: fallbackNode?.id ?? null
        });
      leaseHeartbeatFailedAtRef.current = null;
      void handleForcedGuidance(guidance);
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
      if (disposed || !canApplyNativeSessionRefresh(sessionRef.current,nextSession)) {
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
    if (booting || !session || actionBusy || desktopStatus.status !== "connected" || !bootstrap?.subscription) {
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
    booting,
    session,
    desktopStatus.status,
    fallbackNode?.id
  ]);

  useEffect(() => {
    if (booting || !session || !bootstrap || actionBusy || desktopStatus.status !== "connected" || !runtime) {
      return;
    }
    if (!shouldReportNodeAccessRevoked({
      booting, sessionReady: Boolean(session), bootstrapReady: Boolean(bootstrap),
      activeNodeId: runtime.node.id, nodes
    })) return;

    void handleForcedGuidance({
      code: "node_access_revoked",
      tone: "warning",
      title: "节点已不可用",
      message: "当前节点已不在你的订阅范围内，请切换其他节点后重新连接。",
      actionLabel: "切换节点后重连",
      recommendedNodeId: fallbackNode?.id ?? null
    });
  }, [booting, session, bootstrap, actionBusy, desktopStatus.status, fallbackNode?.id, nodes, runtime]);

  useEffect(() => {
    if (booting || !session || !bootstrap || !runtime || desktopStatus.status !== "connected" || actionBusy) {
      return;
    }
    const runtimeProbe = probeResults[runtime.node.id];
    if (!runtimeProbe || runtimeProbe.status !== "offline") {
      return;
    }

    void handleForcedGuidance({
      code: "node_unavailable",
      tone: "warning",
      title: "节点暂不可用",
      message: "当前节点暂时无法连接，请切换其他节点后重新连接。",
      actionLabel: "切换节点后重连",
      recommendedNodeId: fallbackNode?.id ?? null
    });
  }, [booting, session, bootstrap, actionBusy, desktopStatus.status, fallbackNode?.id, probeResults, runtime]);

  useEffect(() => {
    if (booting || !session || !bootstrap) return;
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
  }, [booting, session, bootstrap, actionBusy, desktopStatus, fallbackNode?.id, runtime?.sessionId]);

  useEffect(() => {
    if (!deferredUpdatePromptKeyRef.current) {
      return;
    }
    if (booting || windowTransitioning || updateDialogOpened || runtimeAssetsBusy || forcedAnnouncement || announcementDrawerOpened) {
      return;
    }
    if (!effectiveUpdateActionable) {
      deferredUpdatePromptKeyRef.current = null;
      return;
    }
    const promptKey = buildUpdatePromptKey(effectiveUpdate);
    if (deferredUpdatePromptKeyRef.current !== promptKey) {
      deferredUpdatePromptKeyRef.current = null;
      return;
    }
    lastUpdatePromptVersionRef.current = promptKey;
    deferredUpdatePromptKeyRef.current = null;
    setUpdateDialogOpened(true);
  }, [
    announcementDrawerOpened,
    effectiveUpdate,
    effectiveUpdateActionable,
    booting,
    windowTransitioning,
    forcedAnnouncement,
    runtimeAssetsBusy,
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
    showToast({
      tone: "warning",
      title: "本地连接仍在运行",
      message: "登录态暂时不可用，请重新登录后继续接管当前连接，或手动断开。"
    });
  }, [booting, emergencyRuntimeActive, session]);

  useEffect(() => {
    if (booting || windowTransitioning || desktopStatus.status !== "error" || !desktopStatus.lastError || actionBusy === "disconnect") {
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

    showErrorToast(desktopStatus.lastError, "connect");
  }, [booting, windowTransitioning, actionBusy, desktopStatus.lastError, desktopStatus.status]);

  useEffect(() => {
    if (booting || !session || !bootstrap) {
      return;
    }
    if (desktopStatus.platformTarget === "android" || desktopStatus.platformTarget === "web") {
      return;
    }
    // One local inspection per login; render churn must not restart the same task.
    if (startupInspectionKeyRef.current === session.accessToken) return;
    const timer = window.setTimeout(() => {
      startupInspectionKeyRef.current = session.accessToken;
      void ensureRuntimeAssetsReady({
        source: "startup",
        interactive: false,
        blockConnection: false,
        inspectOnly: true,
        forceCheck: false
      });
    }, 200);
    return () => {
      window.clearTimeout(timer);
    };
  }, [booting, bootstrap, desktopStatus.platformTarget, ensureRuntimeAssetsReady, session]);

  async function initializeApp() {
    let restoredAccessToken: string | undefined;
    try {
      const rememberedCredentials = loadRememberedCredentials();
      if (rememberedCredentials) {
        setCredentials(rememberedCredentials);
        setRememberPassword(true);
      }
      // 首屏只做轻量状态恢复；软件版本检查放到可交互之后，避免启动卡死拖动/点击。
      await refreshRuntime({ includeLogs: false });
      const localRuntime = await loadActiveRuntimeConfig().catch(() => null);
      if (localRuntime?.sessionId) {
        setRuntime(localRuntime);
      }
      const restoredSession = await restoreStoredSession();
      restoredAccessToken = restoredSession?.accessToken;
      if (restoredSession?.accessToken && localRuntime?.sessionId) {
        await syncForegroundState(restoredSession.accessToken).catch(() => null);
      }
    } finally {
      await prepareStartupLayout(Boolean(restoredAccessToken)).catch(() => null);
      // Commit the correctly sized page before showing/focusing the native window.
      flushSync(() => setBooting(false));
      await appReady().catch(() => null);
      void focusDesktopWindow();
      window.setTimeout(() => {
        void consumeUpdateInstallReport();
      }, 200);
      window.setTimeout(() => {
        void runUpdateCheck({
          accessToken: restoredAccessToken,
          source: "startup",
          silent: true,
          includeRuntimeComponents: false
        });
      }, 300);
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
  // macOS draws the web content under a transparent title bar so the title can be centred.
  const macTitleBar = desktopStatus.platformTarget === "macos";
  const appClassName = `desktop-app${macTitleBar ? " desktop-app--mac-titlebar" : ""}${windowTransitioning ? " desktop-app--window-transition" : ""}${!mainLayoutReady ? " desktop-app--login" : ""}${mobilePlatformClassName ? ` ${mobilePlatformClassName}` : ""}${loginMobileClassName}`;
  const mobileHomeMode = Boolean(session && bootstrap && mobilePlatformClassName);
  const updateStatusDescription = updateCheckStatus === "failed"
    ? "暂时无法获取版本信息，点击检查更新重试。"
    : componentVersionSync.syncError ?? (componentVersionSync.deferred ? "组件待同步，将在断开连接后自动更新。" : undefined);
  // Desktop keeps no inline banner: the window is fixed-size, and the orange
  // "必须更新" button plus the floating progress card already cover this.
  const forceUpdateNotice =
    forceUpdateRequired && effectiveUpdateActionable && effectiveUpdate && !updateDialogOpened ? (
      <NoticeRow
        tone="warning"
        role="status"
        action={
          <Button size="compact-xs" variant="light" color="orange" onClick={() => setUpdateDialogOpened(true)}>
            {updateDownload.phase === "idle" ? "立即更新" : "查看进度"}
          </Button>
        }
      >
        <span className="force-update-strip__text">{describeRequiredUpdate(effectiveUpdate, appVersion)}</span>
      </NoticeRow>
    ) : null;

  return (
    <div className={appClassName}>
      {macTitleBar ? (
        <div className="app-titlebar" data-tauri-drag-region>
          <span className="app-titlebar__title">ChordV v{appVersion.replace(/^v/i, "")}</span>
        </div>
      ) : null}
      {DownloadProgressDebug ? <Suspense fallback={null}><DownloadProgressDebug realDownloadVisible={(runtimeAssets.phase !== "idle" && runtimeAssets.phase !== "ready") || updateDownload.phase !== "idle"}/></Suspense> : null}
      <LoadingOverlay visible={booting} zIndex={200} overlayProps={{ color: "#fff", backgroundOpacity: 1 }} />
      {bootstrap && !windowTransitioning ? (
        <MeteringFloatingBanner
          status={bootstrap.subscription.meteringStatus}
          message={bootstrap.subscription.meteringMessage ?? null}
        />
      ) : null}
      {!windowTransitioning && ((runtimeAssets.phase !== "idle" && runtimeAssets.phase !== "ready") || (updateDownload.phase !== "idle" && !updateDialogOpened && !backgroundUpdateDownload)) ? (
        <div className="desktop-runtime-overlay" data-metering-notice={bootstrap?.subscription.meteringStatus === "degraded" && Boolean(bootstrap.subscription.meteringMessage) || undefined}>
          <div className="desktop-runtime-overlay__inner">
            <RuntimeAssetsBanner onResetLegacyMirror={runtimeMirrorPrefix ? clearLegacyDownloadMirror : null} state={runtimeAssets} onRetry={handleRetryRuntimeAssets} onCancel={handleCancelRuntimeAssets}/>
            {!updateDialogOpened && !backgroundUpdateDownload ? <ClientUpdateProgressPanel onResetLegacyMirror={runtimeMirrorPrefix ? clearLegacyDownloadMirror : null} state={updateDownload} version={effectiveUpdate?.latestVersion} onRetry={()=>void handleUpdateDownload()} onInstall={()=>void handleQuitForUpdate()}/> : null}
          </div>
        </div>
      ) : null}

      {!mainLayoutReady || !session || !bootstrap ? (
        <LoginScreen
          email={credentials.email}
          password={credentials.password}
          rememberPassword={rememberPassword}
          loading={authBusy || windowTransitioning || Boolean(session && bootstrap)}
          error={null}
          windowLayoutError={windowLayoutError}
          windowResizeBusy={windowResizeBusy}
          onRetryWindowLayout={retryWindowLayout}
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
          {forceUpdateNotice ? <div className="desktop-mobile-home__notice">{forceUpdateNotice}</div> : null}

          <div className="desktop-mobile-home__screen">
            {mobileTab === "home" ? (
              <div className="desktop-mobile-home__stack">
                <ControlPanel
                  modes={bootstrap.policies.modes}
                  mode={mode}
                  canConnect={canConnect}
                  modeLocked={modeLocked}
                  primaryBusy={actionBusy !== null}
                  busyAction={actionBusy}
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
                  onOpenRoutingRules={() => setRoutingRulesOpened(true)}
                  onOpenLogs={openRuntimeLogs}
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
                  onSelect={handleSelectNode}
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
                  supportUnreadCount={supportUnreadCount}
                  supportOpening={supportOpening}
                  refreshing={refreshing}
                  updateBusy={updateCheckBusy}
              updateStatusDescription={updateStatusDescription}
                  hasUpdate={effectiveUpdateActionable}
                  forceUpdate={forceUpdateRequired && effectiveUpdateActionable}
                  serverProbe={subscriptionServerProbe}
                  serverProbeBusy={serverProbeBusy}
                  onRefreshServerProbe={() => void handleManualServerProbe()}
                  onOpenAnnouncements={openAnnouncementDrawer}
                  onOpenTickets={() => void openSupportPortal()}
                  onRefresh={() => void handleRefresh()}
                  onCheckUpdate={() => void handleManualUpdateCheck()}
                  onOpenLocalFiles={localFilesAvailable ? () => setLocalFilesOpened(true) : undefined}
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
              supportUnreadCount={supportUnreadCount}
              supportOpening={supportOpening}
              refreshing={refreshing}
              updateBusy={updateCheckBusy}
              updateStatusDescription={updateStatusDescription}
              hasUpdate={effectiveUpdateActionable}
              forceUpdate={forceUpdateRequired && effectiveUpdateActionable}
              updateReady={updateReadyToInstall ? { version: effectiveUpdate?.latestVersion ?? null } : null}
              serverProbe={subscriptionServerProbe}
              serverProbeBusy={serverProbeBusy}
              onRefreshServerProbe={() => void handleManualServerProbe()}
              onOpenAnnouncements={openAnnouncementDrawer}
              onOpenTickets={() => void openSupportPortal()}
              onRefresh={() => void handleRefresh()}
              onCheckUpdate={() => void handleManualUpdateCheck()}
              onInstallUpdate={() => void handleQuitForUpdate()}
              onOpenLocalFiles={localFilesAvailable ? () => setLocalFilesOpened(true) : undefined}
              onLogout={() => void handleLogout()}
            />
          </Stack>

          <div className="desktop-content">
            <NodeListPanel
              nodes={nodes}
              selectedNodeId={selectedNodeId}
              probeResults={probeResults}
              probeBusy={probeBusy}
              probeCooldownLeft={probeCooldownLeft}
              onSelect={handleSelectNode}
              onProbe={() => void runProbe(nodes, false)}
            />

            <ControlPanel
              modes={bootstrap.policies.modes}
              mode={mode}
              canConnect={canConnect}
              modeLocked={modeLocked}
              primaryBusy={actionBusy !== null}
              busyAction={actionBusy}
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
              onOpenRoutingRules={() => setRoutingRulesOpened(true)}
              onOpenLogs={openRuntimeLogs}
            />
          </div>
        </div>
      )}

      <AnnouncementDrawer
        opened={announcementDrawerOpened}
        announcements={bootstrap?.announcements ?? []}
        onSeen={markAnnouncementSeen}
        onAcknowledge={syncAcknowledgeAnnouncement}
        onClose={() => setAnnouncementDrawerOpened(false)}
      />
      {session && bootstrap ? (
        <RoutingRulesModal
          opened={routingRulesOpened}
          accessToken={session.accessToken}
          connected={desktopStatus.status === "connected" || desktopStatus.status === "connecting"}
          mode={mode}
          policies={bootstrap.policies}
          reconnecting={actionBusy === "connect" || actionBusy === "disconnect" || desktopStatus.status === "connecting" || desktopStatus.status === "disconnecting"}
          onClose={() => setRoutingRulesOpened(false)}
          onApplyWhileConnected={async () => {
            return await handleReconnect();
          }}
        />
      ) : null}
      <LogDrawer opened={logDrawerOpened} log={runtimeLog} onClose={() => setLogDrawerOpened(false)} />

      <AppDialog
        opened={closeHintOpened && !windowTransitioning}
        onClose={() => setCloseHintOpened(false)}
        title="关闭窗口说明"
        closeLabel="关闭说明"
        footerStart={
          <Checkbox
            size="xs"
            checked={rememberCloseHint}
            onChange={(event) => setRememberCloseHint(event.currentTarget.checked)}
            label="下次不再提示"
          />
        }
        actions={<Button data-autofocus onClick={() => void acknowledgeCloseHint()}>我知道了</Button>}
      >
        <DialogText>
          {desktopStatus.platformTarget === "windows"
            ? "点击窗口关闭按钮后，ChordV 会缩到系统托盘继续运行。你可以从右下角托盘重新打开，真正退出请使用托盘菜单里的“退出 ChordV”。"
            : "点击窗口关闭按钮后，ChordV 会隐藏窗口并继续在后台运行。你可以从顶部菜单栏或 Dock 恢复窗口，真正退出请使用菜单里的“退出 ChordV”。"}
        </DialogText>
      </AppDialog>

      <GuidanceDialog guidance={guidanceDialog} onClose={dismissGuidanceDialog} />

      <UpdateCenterModal
        state={updateCenter}
        appVersion={appVersion}
        runtimeBusy={runtimeAssetsBusy}
        runtimeInUse={Boolean(desktopStatus.activePid || desktopStatus.activeSessionId || desktopStatus.tunName) || ["connected", "connecting", "starting", "disconnecting"].includes(desktopStatus.status)}
        syncDeferred={componentVersionSync.deferred}
        syncError={componentVersionSync.syncError}
        busy={updateCheckBusy || runtimeAssetsBusy || updateCenter.checking || Boolean(updateCenter.updatingKey)}
        onClose={closeUpdateCenter}
        betaChannel={updateChannel === "beta"}
        onBetaChannelChange={(enabled) => changeUpdateChannel(enabled ? "beta" : "stable")}
        autoDownload={autoDownloadUpdates}
        onAutoDownloadChange={changeAutoDownloadUpdates}
        appReady={updateReadyToInstall}
        onInstallApp={() => void handleQuitForUpdate()}
        onCheckOnly={() => void handleUpdateCenterCheckOnly()}
        onUpdateOne={(key) => void handleUpdateCenterUpdateOne(key)}
        onRevealComponent={localFilesAvailable ? (key) => handleRevealLocalFile(localFileKindForComponent(key)) : undefined}
      />

      {localFilesAvailable ? (
        <LocalFilesDialog
          opened={localFilesOpened && Boolean(session) && !windowTransitioning}
          versions={localFileVersions}
          onClose={() => setLocalFilesOpened(false)}
          onReveal={handleRevealLocalFile}
        />
      ) : null}

      <ClientUpdateModal
        opened={updateDialogOpened && effectiveUpdate !== null && !windowTransitioning}
        update={effectiveUpdate}
        appVersion={appVersion}
        forceRequired={forceUpdateRequired}
        autoInstallCountdown={forcedInstallCountdown}
        downloadBusy={updateDownload.phase === "preparing" || updateDownload.phase === "downloading" || updateDownload.phase === "verifying"}
        onClose={() => {
          if (!forceUpdateRequired) {
            setUpdateDialogOpened(false);
          }
        }}
        progress={updateDownload.phase === "idle" ? null : (
          <ClientUpdateProgressPanel onResetLegacyMirror={runtimeMirrorPrefix ? clearLegacyDownloadMirror : null} state={updateDownload} version={effectiveUpdate?.latestVersion} onRetry={()=>void handleUpdateDownload()} onInstall={forcedInstallCountdown !== null ? installForcedUpdateNow : ()=>void handleQuitForUpdate()}/>
        )}
        primaryAction={effectiveUpdate?.downloadUrl ? (
          updateDownload.phase === "completed" ? (
            forcedInstallCountdown !== null ? (
              <Button color="orange" data-autofocus onClick={installForcedUpdateNow}>
                立即更新（{forcedInstallCountdown} 秒）
              </Button>
            ) : (
              <Button color="green" data-autofocus onClick={() => void handleQuitForUpdate()}>
                安装并重启
              </Button>
            )
          ) : (
            <Button
              data-autofocus
              loading={updateDownload.phase === "preparing" || updateDownload.phase === "downloading" || updateDownload.phase === "verifying"}
              onClick={() => void handleUpdateDownload()}
            >
              {updateActionLabel(effectiveUpdate, updateDownload)}
            </Button>
          )
        ) : (
          <Button disabled>暂无下载地址</Button>
        )}
      />

      <AppDialog
        opened={forcedAnnouncement !== null && !windowTransitioning}
        onClose={() => {}}
        dismissible={false}
        title={forcedAnnouncement?.title ?? ""}
        size={460}
        actions={
          <Button
            data-autofocus
            disabled={forcedAnnouncement?.displayMode === "modal_countdown" && countdown > 0}
            onClick={acknowledgeAnnouncement}
          >
            {forcedAnnouncement?.displayMode === "modal_countdown" && countdown > 0 ? `请等待 ${countdown}s` : "我知道了"}
          </Button>
        }
      >
        <DialogText>{forcedAnnouncement?.body}</DialogText>
      </AppDialog>
    </div>
  );
}

/** 版本只用已有的组件检查结果与本地记录，不额外请求服务端。 */
function readLocalFileVersions(summary: RuntimeAssetsCheckSummary | null): LocalFileVersions {
  let storedXray: string | null = null;
  let storedGeo: string | null = null;
  try {
    storedXray = readStoredXrayInstalledIdentity()?.versionLabel ?? null;
    storedGeo = readStoredGeoVersionLabel();
  } catch {
    // 本地记录不可读时只是不显示版本。
  }
  return resolveLocalFileVersions({
    summaryXray: summary?.xray.localVersion,
    summaryGeo: summary?.geo.localVersion,
    storedXray,
    storedGeo
  });
}

function isEditableContextTarget(target: EventTarget | null) {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (!element) {
    return false;
  }
  return Boolean(element.closest("input, textarea, [contenteditable]"));
}

function hasSelectedText() {
  const selection = window.getSelection();
  return Boolean(selection && selection.toString().trim().length > 0);
}
