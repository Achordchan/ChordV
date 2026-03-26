import { useCallback, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  AuthSessionDto,
  ClientBootstrapDto,
  ClientRuntimeEventDto,
  ClientVersionDto,
  ConnectionMode,
  GeneratedRuntimeConfigDto,
  NodeSummaryDto,
  SubscriptionStatusDto
} from "@chordv/shared";
import type { ServerProbeState } from "./useClientEvents";
import {
  connectSession,
  disconnectSession,
  fetchAnnouncements,
  fetchClientRuntime,
  fetchNodes,
  fetchSubscription,
  getApiErrorRawMessage,
  heartbeatSession,
  isAccessTokenExpiredApiError,
  isForbiddenApiError,
  isUnauthorizedApiError
} from "../api/client";
import {
  connectRuntime,
  createIdleRuntimeStatus,
  focusDesktopWindow,
  type RuntimeNodeProbeResult,
  type RuntimeStatus
} from "../lib/runtime";
import type { RuntimeAssetsUiState } from "../lib/runtimeComponents";
import { toneToToastColor } from "../lib/appState";
import { buildProtectedAccessNotice, resolveProtectedAccessReason } from "../lib/sessionLeaseState";
import {
  composeRuntimeFailureText,
  deriveGuidanceFromConnectFailure,
  deriveGuidanceFromMessage,
  deriveGuidanceFromRuntimeEvent,
  deriveGuidanceFromRuntimeFailure,
  deriveGuidanceFromSubscription,
  describeForegroundSyncFailure,
  formatGuidanceMessage,
  guidanceKey,
  type ConnectionGuidance,
  type GuidanceTone,
  isDialogOnlyGuidance,
  loadConnectFailureRuntimeStatus,
  pickAlternativeNode,
  sameGuidance
} from "../lib/connectionGuidance";

type NoticeInput = {
  color: "green" | "yellow" | "red" | "blue" | "cyan";
  title: string;
  message: string;
  autoClose?: number;
};

type EnsureRuntimeAssetsOptions = {
  source: "startup" | "connect" | "retry";
  interactive: boolean;
  blockConnection: boolean;
};

type RunUpdateCheckInput = {
  accessToken?: string;
  bootstrapVersion?: ClientVersionDto | null;
  source: "startup" | "login" | "manual" | "refresh";
  silent?: boolean;
};

type UseRuntimeActionsOptions = {
  session: AuthSessionDto | null;
  bootstrap: ClientBootstrapDto | null;
  setBootstrap: Dispatch<SetStateAction<ClientBootstrapDto | null>>;
  nodes: NodeSummaryDto[];
  setNodes: Dispatch<SetStateAction<NodeSummaryDto[]>>;
  selectedNode: NodeSummaryDto | null;
  selectedNodeId: string | null;
  setSelectedNodeId: Dispatch<SetStateAction<string | null>>;
  mode: ConnectionMode;
  runtime: GeneratedRuntimeConfigDto | null;
  setRuntime: Dispatch<SetStateAction<GeneratedRuntimeConfigDto | null>>;
  desktopStatus: RuntimeStatus;
  setDesktopStatus: Dispatch<SetStateAction<RuntimeStatus>>;
  runtimeAssetsReady: boolean;
  runtimeAssets: RuntimeAssetsUiState;
  ensureRuntimeAssetsReady: (options: EnsureRuntimeAssetsOptions) => Promise<boolean>;
  canAttemptConnect: boolean;
  canConnect: boolean;
  forceUpdateRequired: boolean;
  setUpdateDialogOpened: Dispatch<SetStateAction<boolean>>;
  fallbackNodeId: string | null;
  probeResults: Record<string, RuntimeNodeProbeResult>;
  nodesRef: MutableRefObject<NodeSummaryDto[]>;
  runtimeRef: MutableRefObject<GeneratedRuntimeConfigDto | null>;
  selectedNodeIdRef: MutableRefObject<string | null>;
  probeResultsRef: MutableRefObject<Record<string, RuntimeNodeProbeResult>>;
  ticketCenterOpenedRef: MutableRefObject<boolean>;
  ticketCreateModeRef: MutableRefObject<boolean>;
  selectedTicketIdRef: MutableRefObject<string | null>;
  leaseHeartbeatFailedAtRef: MutableRefObject<number | null>;
  lastGuidanceToastRef: MutableRefObject<string | null>;
  lastForegroundSyncErrorRef: MutableRefObject<string | null>;
  connectionGuidance: ConnectionGuidance | null;
  setConnectionGuidance: Dispatch<SetStateAction<ConnectionGuidance | null>>;
  guidanceDialog: ConnectionGuidance | null;
  setGuidanceDialog: Dispatch<SetStateAction<ConnectionGuidance | null>>;
  readError: (message: string) => string;
  showErrorToast: (message: string) => void;
  notify: (notice: NoticeInput) => void;
  setServerProbe: Dispatch<SetStateAction<ServerProbeState>>;
  mergeSubscriptionState: (subscription: SubscriptionStatusDto) => void;
  loadTicketList: (preferredTicketId?: string | null) => Promise<void>;
  loadTicketDetail: (ticketId: string) => Promise<void>;
  recoverSessionAfterUnauthorized: () => Promise<AuthSessionDto | null> | AuthSessionDto | null;
  getCurrentAccessToken: () => string | null;
  clearSession: (stopRuntime?: boolean) => Promise<void>;
  runUpdateCheck: (input: RunUpdateCheckInput) => Promise<void>;
  refreshRuntime: () => Promise<RuntimeStatus | null>;
  forceStopLocalRuntime: () => Promise<void>;
  loadLastNodeId: () => string | null;
  pickNode: (
    nodes: NodeSummaryDto[],
    preferredId: string | null,
    probeResults?: Record<string, RuntimeNodeProbeResult>
  ) => NodeSummaryDto | null;
};

export function useRuntimeActions(options: UseRuntimeActionsOptions) {
  const [actionBusy, setActionBusy] = useState<"connect" | "disconnect" | null>(null);

  const handleProtectedAccessRevoked = useCallback(
    async (reason: unknown) => {
      const accessReason = resolveProtectedAccessReason(getApiErrorRawMessage(reason));
      if (!accessReason) {
        return false;
      }
      const notice = buildProtectedAccessNotice(accessReason);
      await options.clearSession(true);
      options.notify({
        color: "yellow",
        title: notice.title,
        message: notice.message
      });
      return true;
    },
    [options]
  );

  const debugAndroidConnect = useCallback(
    (stage: string, detail?: unknown) => {
      if (options.desktopStatus.platformTarget !== "android") {
        return;
      }
      console.info("[ChordV AndroidConnect]", stage, detail ?? null);
    },
    [options.desktopStatus.platformTarget]
  );

  const showGuidanceToast = useCallback(
    (guidance: ConnectionGuidance) => {
      const key = guidanceKey(guidance);
      if (options.lastGuidanceToastRef.current === key) {
        return;
      }
      options.lastGuidanceToastRef.current = key;
      options.notify({
        color: toneToToastColor(guidance.tone),
        title: guidance.title,
        message: formatGuidanceMessage(guidance),
        autoClose: 4000
      });
    },
    [options]
  );

  const applyGuidance = useCallback(
    (guidance: ConnectionGuidance, toast = true, autoSelect = false) => {
      options.setConnectionGuidance((current) => (sameGuidance(current, guidance) ? current : guidance));
      options.setGuidanceDialog((current) => (sameGuidance(current, guidance) ? current : guidance));
      if (autoSelect && guidance.recommendedNodeId) {
        options.setSelectedNodeId(guidance.recommendedNodeId);
      }
      void focusDesktopWindow();
      if (toast && !isDialogOnlyGuidance(guidance.code)) {
        showGuidanceToast(guidance);
      }
    },
    [options, showGuidanceToast]
  );

  const disconnectCurrentRuntime = useCallback(
    async (disconnectOptions?: { notifyServer?: boolean; guidance?: ConnectionGuidance | null }) => {
      const sessionId = options.runtime?.sessionId ?? options.desktopStatus.activeSessionId;
      const accessToken = options.session?.accessToken ?? null;

      try {
        setActionBusy("disconnect");
        options.setDesktopStatus((current) => ({
          ...current,
          status: "disconnecting",
          lastError: disconnectOptions?.guidance?.message ?? null
        }));
        await options.forceStopLocalRuntime();
        if (disconnectOptions?.notifyServer !== false && sessionId && accessToken) {
          await disconnectSession(accessToken, sessionId).catch(() => null);
        }
      } catch (reason) {
        options.showErrorToast(reason instanceof Error ? options.readError(reason.message) : "断开失败");
      } finally {
        await options.refreshRuntime();
        setActionBusy(null);
      }
    },
    [options]
  );

  const handleForcedGuidance = useCallback(
    async (guidance: ConnectionGuidance) => {
      applyGuidance(guidance, true, true);
      if (actionBusy === "disconnect") {
        return;
      }
      await disconnectCurrentRuntime({ notifyServer: false, guidance });
    },
    [actionBusy, applyGuidance, disconnectCurrentRuntime]
  );

  const syncSubscriptionState = useCallback(
    async (accessToken: string) => {
      try {
        const subscription = await fetchSubscription(accessToken);
        options.mergeSubscriptionState(subscription);
      } catch (reason) {
        if (isUnauthorizedApiError(reason)) {
          await options.recoverSessionAfterUnauthorized();
          return;
        }
        if (isForbiddenApiError(reason)) {
          if (await handleProtectedAccessRevoked(reason)) {
            return;
          }
        }
        const message = reason instanceof Error ? reason.message : "";
        if (message.includes("当前没有可用订阅")) {
          await options.clearSession(true);
          options.notify({
            color: "yellow",
            title: "登录已失效",
            message: "当前账号已失去可用订阅，请重新登录或联系管理员。"
          });
        }
      }
    },
    [options]
  );

  const syncAnnouncementsState = useCallback(
    async (accessToken: string) => {
      try {
        const announcements = await fetchAnnouncements(accessToken);
        options.setBootstrap((current) => (current ? { ...current, announcements } : current));
      } catch (reason) {
        if (isUnauthorizedApiError(reason)) {
          await options.recoverSessionAfterUnauthorized();
        }
      }
    },
    [options]
  );

  const syncForegroundState = useCallback(
    async (accessToken: string) => {
      await options.refreshRuntime().catch(() => null);

      const activeRuntime = options.runtimeRef.current;
      const activeSessionId = activeRuntime?.sessionId ?? options.desktopStatus.activeSessionId;
      const [subscriptionResult, nodesResult, runtimeResult] = await Promise.allSettled([
        fetchSubscription(accessToken),
        fetchNodes(accessToken),
        activeSessionId ? fetchClientRuntime(accessToken, activeSessionId) : Promise.resolve(null)
      ]);

      if (
        (subscriptionResult.status === "rejected" && isUnauthorizedApiError(subscriptionResult.reason)) ||
        (nodesResult.status === "rejected" && isUnauthorizedApiError(nodesResult.reason)) ||
        (runtimeResult.status === "rejected" && isUnauthorizedApiError(runtimeResult.reason))
      ) {
        await options.recoverSessionAfterUnauthorized();
        return;
      }

      const forbiddenReasons = [
        subscriptionResult.status === "rejected" ? subscriptionResult.reason : null,
        nodesResult.status === "rejected" ? nodesResult.reason : null,
        runtimeResult.status === "rejected" ? runtimeResult.reason : null
      ].filter((reason): reason is unknown => Boolean(reason) && isForbiddenApiError(reason));

      for (const forbiddenReason of forbiddenReasons) {
        if (await handleProtectedAccessRevoked(forbiddenReason)) {
          return;
        }
        const message = forbiddenReason instanceof Error ? forbiddenReason.message : "";
        if (message.includes("当前没有可用订阅") || message.includes("失去可用订阅")) {
          await options.clearSession(true);
          options.notify({
            color: "yellow",
            title: "登录已失效",
            message: "当前账号已失去可用订阅，请重新登录或联系管理员。"
          });
          return;
        }
      }

      let nextSubscription = options.bootstrap?.subscription ?? null;
      let nextNodes = options.nodesRef.current;

      if (subscriptionResult.status === "fulfilled") {
        nextSubscription = subscriptionResult.value;
        options.mergeSubscriptionState(subscriptionResult.value);
        options.lastForegroundSyncErrorRef.current = null;
      }

      if (nodesResult.status === "fulfilled") {
        nextNodes = nodesResult.value;
        options.setNodes(nextNodes);
        options.setSelectedNodeId((current) =>
          options.pickNode(nextNodes, current ?? options.loadLastNodeId(), options.probeResultsRef.current)?.id ?? null
        );
        options.lastForegroundSyncErrorRef.current = null;
      }

      if (runtimeResult.status === "fulfilled" && runtimeResult.value && activeSessionId) {
        if (!activeRuntime && (options.desktopStatus.platformTarget === "android" || options.desktopStatus.platformTarget === "web")) {
          options.setRuntime(runtimeResult.value);
        }
      }

      if (activeRuntime && activeSessionId && runtimeResult.status === "fulfilled") {
        let serverRuntime = runtimeResult.value;
        const fallbackNodeId =
          pickAlternativeNode(
            nextNodes,
            activeRuntime?.node.id ?? options.desktopStatus.activeNodeId ?? options.selectedNodeIdRef.current,
            options.probeResultsRef.current
          )?.id ?? null;

        if (!serverRuntime || serverRuntime.sessionId !== activeSessionId) {
          try {
            await new Promise((resolve) => window.setTimeout(resolve, 800));
            serverRuntime = await fetchClientRuntime(accessToken, activeSessionId);
          } catch (confirmReason) {
            if (isUnauthorizedApiError(confirmReason)) {
              await options.recoverSessionAfterUnauthorized();
              return;
            }
            if (isForbiddenApiError(confirmReason)) {
              if (await handleProtectedAccessRevoked(confirmReason)) {
                return;
              }
            }
          }
        }

        if (!serverRuntime || serverRuntime.sessionId !== activeSessionId) {
          const guidance =
            (nextSubscription ? deriveGuidanceFromSubscription(nextSubscription, fallbackNodeId) : null) ??
            deriveGuidanceFromMessage("当前连接已失效，请重新连接", { fallbackNodeId });
          if (guidance) {
            if (options.desktopStatus.platformTarget === "android" || options.desktopStatus.platformTarget === "web") {
              await handleForcedGuidance(guidance);
            } else {
              options.setConnectionGuidance(guidance);
              options.notify({
                color: "yellow",
                title: guidance.title,
                message: "服务端连接状态暂时未同步，本地连接将继续保留，请稍后再试。",
                autoClose: 4000
              });
            }
            return;
          }
        }
      }

      if (subscriptionResult.status === "rejected" && nodesResult.status === "rejected") {
        if (isUnauthorizedApiError(subscriptionResult.reason) || isUnauthorizedApiError(nodesResult.reason)) {
          return;
        }
        const message = describeForegroundSyncFailure(subscriptionResult.reason);
        if (options.lastForegroundSyncErrorRef.current === message) {
          return;
        }
        options.lastForegroundSyncErrorRef.current = message;
        options.notify({
          color: "yellow",
          title: "网络连接已中断",
          message,
          autoClose: 4000
        });
      }
    },
    [handleForcedGuidance, options]
  );

  const handleRuntimeEvent = useCallback(
    async (event: ClientRuntimeEventDto, accessToken: string) => {
      if (!event) {
        return;
      }

      const eventType = event.type as string;
      const runtimeEvent = event as ClientRuntimeEventDto & {
        ticketId?: string | null;
      };

      if (eventType === "keepalive") {
        options.setServerProbe((current) => ({
          status: current.status === "idle" || current.status === "checking" ? "healthy" : current.status,
          elapsedMs: current.elapsedMs,
          checkedAt: Date.now(),
          errorMessage: null
        }));
      }

      if (
        eventType === "subscription_updated" ||
        event.reasonCode === "subscription_expired" ||
        event.reasonCode === "subscription_exhausted" ||
        event.reasonCode === "subscription_paused" ||
        event.reasonCode === "account_disabled" ||
        event.reasonCode === "team_access_revoked"
      ) {
        if (event.reasonCode === "account_disabled" || event.reasonCode === "team_access_revoked") {
          await options.clearSession(true);
          options.notify({
            color: "yellow",
            title: event.reasonCode === "account_disabled" ? "账号已禁用" : "你已被移出团队",
            message:
              event.reasonCode === "account_disabled"
                ? "当前账号已被管理员禁用，请联系管理员处理。"
                : "当前账号已失去团队订阅，请重新登录或联系管理员处理。"
          });
          return;
        }
        await syncSubscriptionState(accessToken);
      }

      if (eventType === "announcement_updated" || eventType === "announcement_read_state_updated") {
        await syncAnnouncementsState(accessToken);
      }

      if (eventType === "version_updated") {
        await options.runUpdateCheck({
          bootstrapVersion: options.bootstrap?.version ?? null,
          source: "refresh",
          silent: false
        });
      }

      if (eventType === "ticket_updated" || eventType === "ticket_read_state_updated") {
        const preferredTicketId = runtimeEvent.ticketId ?? options.selectedTicketIdRef.current;
        await options.loadTicketList(preferredTicketId);
        if (options.ticketCenterOpenedRef.current && !options.ticketCreateModeRef.current && preferredTicketId) {
          await options.loadTicketDetail(preferredTicketId);
        }
      }

      if (
        eventType === "node_access_updated" ||
        event.reasonCode === "node_access_revoked" ||
        event.reasonCode === "admin_paused_connection"
      ) {
        try {
          const nextNodes = await fetchNodes(accessToken);
          options.setNodes(nextNodes);
          options.setSelectedNodeId((current) =>
            options.pickNode(nextNodes, current ?? options.loadLastNodeId(), options.probeResultsRef.current)?.id ?? null
          );
        } catch {
          // 节点列表刷新失败时保留事件流兜底。
        }
      }

      const activeRuntime = options.runtimeRef.current;
      const activeSessionId = activeRuntime?.sessionId ?? options.desktopStatus.activeSessionId;
      if (!activeSessionId) {
        return;
      }
      if (event.sessionId && event.sessionId !== activeSessionId) {
        return;
      }

      const fallbackNodeId =
        pickAlternativeNode(
          options.nodesRef.current,
          activeRuntime?.node.id ?? options.desktopStatus.activeNodeId ?? options.selectedNodeIdRef.current,
          options.probeResultsRef.current
        )?.id ?? null;
      const guidance =
        deriveGuidanceFromRuntimeEvent(event, fallbackNodeId) ??
        (event.reasonMessage ? deriveGuidanceFromMessage(event.reasonMessage, { fallbackNodeId }) : null);

      if (guidance) {
        await handleForcedGuidance(guidance);
      }
    },
    [handleForcedGuidance, options, syncAnnouncementsState, syncSubscriptionState]
  );

  const handleConnect = useCallback(async () => {
    if (!options.session || !options.selectedNode || actionBusy || !options.canAttemptConnect) {
      debugAndroidConnect("handleConnect:skip", {
        hasSession: Boolean(options.session),
        selectedNodeId: options.selectedNode?.id ?? null,
        actionBusy,
        canAttemptConnect: options.canAttemptConnect
      });
      return;
    }
    const selectedNode = options.selectedNode;
    if (!options.runtimeAssetsReady) {
      const ready = await options.ensureRuntimeAssetsReady({
        source: options.runtimeAssets.phase === "failed" ? "retry" : "connect",
        interactive: true,
        blockConnection: true
      });
      if (!ready) {
        return;
      }
    }
    if (!options.canConnect) {
      debugAndroidConnect("handleConnect:blocked", {
        canConnect: options.canConnect,
        nodeId: selectedNode.id
      });
      return;
    }

    try {
      setActionBusy("connect");
      debugAndroidConnect("handleConnect:start", {
        status: options.desktopStatus.status,
        nodeId: selectedNode.id,
        mode: options.mode
      });
      if (options.desktopStatus.platformTarget === "android" && options.desktopStatus.status === "error") {
        const staleSessionId = options.runtime?.sessionId ?? options.desktopStatus.activeSessionId;
        debugAndroidConnect("handleConnect:clear-stale-runtime", { staleSessionId });
        await options.forceStopLocalRuntime();
        if (staleSessionId) {
          await disconnectSession(options.session.accessToken, staleSessionId).catch(() => null);
        }
        options.setDesktopStatus(createIdleRuntimeStatus(options.desktopStatus.platformTarget));
      }
      options.setDesktopStatus((current) => ({ ...current, status: "connecting", lastError: null }));
      const connectWithAccessToken = async (accessToken: string) =>
        connectSession({
          accessToken,
          nodeId: selectedNode.id,
          mode: options.mode
        });
      let config: GeneratedRuntimeConfigDto | null = null;
      try {
        debugAndroidConnect("handleConnect:connect-session:request", { nodeId: selectedNode.id, mode: options.mode });
        config = await connectWithAccessToken(options.session.accessToken);
        debugAndroidConnect("handleConnect:connect-session:success", {
          sessionId: config.sessionId,
          nodeId: config.node.id
        });
      } catch (reason) {
        debugAndroidConnect("handleConnect:connect-session:error", reason instanceof Error ? reason.message : reason);
        if (isAccessTokenExpiredApiError(reason)) {
          const recoveredSession = await options.recoverSessionAfterUnauthorized();
          const recoveredAccessToken = recoveredSession?.accessToken ?? options.getCurrentAccessToken();
          if (!recoveredAccessToken) {
            throw reason;
          }
          config = await connectWithAccessToken(recoveredAccessToken);
          debugAndroidConnect("handleConnect:connect-session:recovered", {
            sessionId: config.sessionId,
            nodeId: config.node.id
          });
        } else if (isForbiddenApiError(reason)) {
          if (await handleProtectedAccessRevoked(reason)) {
            return;
          }
          throw reason;
        } else if (!isUnauthorizedApiError(reason)) {
          throw reason;
        }
      }
      if (!config) {
        throw new Error("连接配置生成失败");
      }
      debugAndroidConnect("handleConnect:runtime:start", {
        sessionId: config.sessionId,
        nodeId: config.node.id
      });
      await connectRuntime(config);
      debugAndroidConnect("handleConnect:runtime:success", {
        sessionId: config.sessionId,
        nodeId: config.node.id
      });
      localStorage.setItem("chordv_last_node_id", selectedNode.id);
      options.setRuntime(config);
      options.setConnectionGuidance(null);
      options.setGuidanceDialog(null);
      options.leaseHeartbeatFailedAtRef.current = null;
      await options.refreshRuntime();
    } catch (reason) {
      const runtimeStatus = await loadConnectFailureRuntimeStatus().catch(() => null);
      debugAndroidConnect("handleConnect:failed", {
        reason: reason instanceof Error ? reason.message : reason,
        runtimeStatus: runtimeStatus
          ? {
              status: runtimeStatus.status,
              reasonCode: runtimeStatus.reasonCode,
              lastError: runtimeStatus.lastError
            }
          : null
      });
      if (runtimeStatus) {
        options.setDesktopStatus(runtimeStatus);
      }
      await options.forceStopLocalRuntime();
      const message = reason instanceof Error ? options.readError(reason.message) : "连接失败";
      const runtimeGuidance = runtimeStatus
        ? deriveGuidanceFromRuntimeFailure(composeRuntimeFailureText(runtimeStatus), options.fallbackNodeId)
        : null;
      const connectGuidance =
        deriveGuidanceFromConnectFailure(
          message,
          options.fallbackNodeId,
          runtimeStatus?.platformTarget ?? options.desktopStatus.platformTarget
        ) ??
        runtimeGuidance;
      if (connectGuidance) {
        applyGuidance(connectGuidance, true, true);
      } else {
        options.showErrorToast(message);
      }
    } finally {
      debugAndroidConnect("handleConnect:finish");
      setActionBusy(null);
    }
  }, [actionBusy, applyGuidance, debugAndroidConnect, options]);

  const handleDisconnect = useCallback(async () => {
    if (
      actionBusy ||
      (options.desktopStatus.status !== "connected" &&
        options.desktopStatus.status !== "error" &&
        options.desktopStatus.status !== "connecting" &&
        !options.desktopStatus.activePid)
    ) {
      return;
    }
    options.setConnectionGuidance(null);
    await disconnectCurrentRuntime({ notifyServer: true });
  }, [actionBusy, disconnectCurrentRuntime, options]);

  const handleEmergencyDisconnect = useCallback(async () => {
    if (actionBusy === "disconnect") {
      return;
    }

    try {
      setActionBusy("disconnect");
      options.setDesktopStatus((current) => ({ ...current, status: "disconnecting", lastError: null }));
      await options.forceStopLocalRuntime();
      options.setConnectionGuidance(null);
      options.notify({
        color: "green",
        title: "本地内核已停止",
        message: options.session
          ? "当前连接已在本机断开，系统代理已恢复。"
          : "登录态缺失时，已优先停止本地内核并恢复系统代理。"
      });
    } catch (reason) {
      options.showErrorToast(reason instanceof Error ? options.readError(reason.message) : "断开失败");
    } finally {
      setActionBusy(null);
    }
  }, [actionBusy, options]);

  const handlePrimaryAction = useCallback(async () => {
    debugAndroidConnect("handlePrimaryAction", {
      status: options.desktopStatus.status,
      canConnect: options.canConnect,
      canAttemptConnect: options.canAttemptConnect,
      runtimeAssetsReady: options.runtimeAssetsReady
    });
    if (options.forceUpdateRequired && options.desktopStatus.status !== "connected" && options.desktopStatus.status !== "error") {
      options.setUpdateDialogOpened(true);
      return;
    }
    if (
      options.desktopStatus.status === "connected" ||
      (options.desktopStatus.status === "error" && options.desktopStatus.platformTarget !== "android")
    ) {
      await handleDisconnect();
      return;
    }

    if (!options.runtimeAssetsReady) {
      const ready = await options.ensureRuntimeAssetsReady({
        source: options.runtimeAssets.phase === "failed" ? "retry" : "connect",
        interactive: true,
        blockConnection: true
      });
      if (!ready) {
        return;
      }
    }

    await handleConnect();
  }, [debugAndroidConnect, handleConnect, handleDisconnect, options]);

  return {
    actionBusy,
    applyGuidance,
    handleRuntimeEvent,
    handlePrimaryAction,
    handleDisconnect,
    handleEmergencyDisconnect,
    handleForcedGuidance,
    syncForegroundState,
    dismissGuidanceDialog: () => options.setGuidanceDialog(null)
  };
}
