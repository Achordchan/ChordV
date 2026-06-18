import type {
  AnnouncementDto,
  AuthSessionDto,
  ClientNodeProbeResultDto,
  ClientBootstrapDto,
  ClientVersionDto,
  ClientRuntimeComponentsPlanDto,
  ClientRuntimeEventDto,
  ClientRuntimeComponentFailureReportInputDto,
  ClientSupportTicketDetailDto,
  ClientSupportTicketSummaryDto,
  ConnectionMode,
  CreateClientSupportTicketInputDto,
  GeneratedRuntimeConfigDto,
  NodeSummaryDto,
  PlatformTarget,
  ReplyClientSupportTicketInputDto,
  SessionLeaseStatusDto,
  SubscriptionStatusDto,
  UploadedSupportTicketAttachmentInputDto
} from "@chordv/shared";
import type {
  ClientRuntimeComponentsPlan,
  RuntimeComponentFailureReportInput
} from "../lib/runtimeComponents";
import { loadDesktopRuntimeEnvironment } from "../lib/runtime";

const API_BASE = readApiBaseUrl();
const DEFAULT_RELEASE_CHANNEL = "stable";

export type ReleaseChannel = "stable";
export type UpdateDeliveryMode = "desktop_installer_download" | "desktop_full_replace" | "apk_download" | "external_download" | "none";
export type ReleaseArtifactType = "dmg" | "app" | "exe" | "setup.exe" | "zip" | "apk" | "ipa" | "external";

export type ClientUpdateArtifact = {
  fileType: ReleaseArtifactType;
  downloadUrl: string;
  originDownloadUrl: string | null;
  defaultMirrorPrefix: string | null;
  allowClientMirror: boolean;
  fileName: string | null;
  fileSizeBytes: number | null;
  fileHash: string | null;
  isPrimary: boolean;
  isFullPackage: boolean;
};

export type ClientUpdateCheckResult = {
  platform: PlatformTarget | "ios";
  channel: ReleaseChannel;
  currentVersion: string;
  latestVersion: string;
  minimumVersion: string;
  hasUpdate: boolean;
  forceUpgrade: boolean;
  title: string;
  changelog: string[];
  publishedAt: string | null;
  deliveryMode: UpdateDeliveryMode;
  downloadUrl: string | null;
  artifact: ClientUpdateArtifact | null;
};

type NativeApiResponse = {
  status: number;
  body: string;
  elapsedMs?: number | null;
};

type RequestResult<T> = {
  data: T;
  status: number;
  elapsedMs: number | null;
};

type NativeInvoke = (command: string, payload?: unknown) => Promise<NativeApiResponse>;
type TauriInvoke = <T = unknown>(command: string, payload?: unknown) => Promise<T>;

type ParsedServerSentEvent = {
  event: string | null;
  id: string | null;
  data: string | null;
};

type ClientRuntimeEventType = ClientRuntimeEventDto["type"];

export function createClientRuntimeFallbackRefreshEventTypes(includeVersion: boolean): ClientRuntimeEventType[] {
  return [
    "subscription_updated",
    "node_access_updated",
    "announcement_updated",
    "policy_updated",
    "ticket_updated",
    ...(includeVersion ? (["version_updated"] as const) : [])
  ];
}

export class ApiRequestError extends Error {
  status: number | null;
  rawMessage: string;

  constructor(status: number | null, message: string, rawMessage?: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.rawMessage = rawMessage ?? message;
  }
}

async function requestWithMeta<T>(path: string, init?: RequestInit): Promise<RequestResult<T>> {
  const nativeInvoke = await loadNativeInvoke();
  if (nativeInvoke) {
    const headers = normalizeHeaders(init?.headers);
    if (!headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    const response = await nativeInvoke("api_request", {
      request: {
        method: init?.method ?? "GET",
        path,
        headers,
        body: typeof init?.body === "string" ? init.body : undefined
      }
    });
    if (response.status < 200 || response.status >= 300) {
      throw createApiRequestError(path, response.status, response.body);
    }
    return {
      data: response.body ? (JSON.parse(response.body) as T) : ({} as T),
      status: response.status,
      elapsedMs: normalizeElapsedMs(response.elapsedMs)
    };
  }

  const startedAt = performance.now();
  const response = await fetch(`${API_BASE}/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw createApiRequestError(path, response.status, text);
  }

  const body = await response.text();
  return {
    data: body ? (JSON.parse(body) as T) : ({} as T),
    status: response.status,
    elapsedMs: Math.max(0, Math.round(performance.now() - startedAt))
  };
}

async function request<T>(path: string, init?: RequestInit) {
  const result = await requestWithMeta<T>(path, init);
  return result.data;
}

function readApiBaseUrl() {
  const env = (import.meta as ImportMeta & { env?: { VITE_API_BASE_URL?: string } }).env;
  return env?.VITE_API_BASE_URL ?? "https://v.baymaxgroup.com";
}

async function requestForm<T>(path: string, body: FormData, init?: Omit<RequestInit, "body">) {
  const startedAt = performance.now();
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api${path}`, {
      ...init,
      body,
      headers: {
        ...(init?.headers ?? {})
      }
    });
  } catch (error) {
    throw normalizeNetworkRequestError(error);
  }

  if (!response.ok) {
    const text = await response.text();
    throw createApiRequestError(path, response.status, text);
  }

  const responseBody = await response.text();
  return {
    data: responseBody ? (JSON.parse(responseBody) as T) : ({} as T),
    status: response.status,
    elapsedMs: Math.max(0, Math.round(performance.now() - startedAt))
  };
}

function normalizeNetworkRequestError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/Failed to fetch|NetworkError|fetch failed|Load failed/i.test(message)) {
    return new ApiRequestError(null, "网络请求失败，请检查后台服务或网络连接后重试。", message);
  }
  return error;
}

async function loadNativeInvoke(): Promise<NativeInvoke | null> {
  if (!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
    return null;
  }
  const module = await import("@tauri-apps/api/core");
  return module.invoke as NativeInvoke;
}

async function loadTauriInvoke(): Promise<TauriInvoke | null> {
  if (!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
    return null;
  }
  const module = await import("@tauri-apps/api/core");
  return module.invoke as TauriInvoke;
}

export async function recordClientDiagnosticLog(category: string, message: string) {
  try {
    const invoke = await loadTauriInvoke();
    if (!invoke) {
      return;
    }
    await invoke("record_client_diagnostic", {
      input: {
        category,
        message
      }
    });
  } catch {
    // Diagnostics must never break client runtime behavior.
  }
}

function normalizeHeaders(headers?: HeadersInit) {
  const result: Record<string, string> = {};
  if (!headers) {
    return result;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      result[key] = value;
    }
    return result;
  }
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }
  return { ...headers };
}

function extractApiErrorMessage(rawMessage: string | null | undefined) {
  const trimmed = rawMessage?.trim();
  if (!trimmed) {
    return "";
  }

  try {
    const parsed = JSON.parse(trimmed) as { message?: string[] | string };
    if (Array.isArray(parsed.message)) {
      return parsed.message.filter(Boolean).join("，");
    }
    if (typeof parsed.message === "string") {
      return parsed.message.trim();
    }
  } catch {
    return trimmed;
  }

  return trimmed;
}

function createApiRequestError(path: string, status: number | null, rawMessage: string | null | undefined) {
  const normalizedStatus = typeof status === "number" && Number.isFinite(status) ? status : null;
  const parsedMessage = extractApiErrorMessage(rawMessage);
  const fallbackMessage = parsedMessage || (normalizedStatus ? `HTTP ${normalizedStatus}` : "请求失败");
  if (normalizedStatus === 401) {
    if (path === "/auth/login") {
      return new ApiRequestError(normalizedStatus, fallbackMessage, fallbackMessage);
    }
    return new ApiRequestError(normalizedStatus, "登录状态已失效，请重新登录。", fallbackMessage);
  }
  return new ApiRequestError(normalizedStatus, fallbackMessage, fallbackMessage);
}

export function getApiErrorStatus(reason: unknown) {
  if (reason instanceof ApiRequestError) {
    return reason.status;
  }
  return null;
}

export function getApiErrorRawMessage(reason: unknown) {
  if (reason instanceof ApiRequestError) {
    return reason.rawMessage;
  }
  if (reason instanceof Error) {
    return reason.message;
  }
  return "";
}

function isApiStatusError(reason: unknown, ...statuses: number[]) {
  const status = getApiErrorStatus(reason);
  return status !== null && statuses.includes(status);
}

export function isUnauthorizedApiError(reason: unknown) {
  const status = getApiErrorStatus(reason);
  return status === 401;
}

export function isNotFoundApiError(reason: unknown) {
  const status = getApiErrorStatus(reason);
  return status === 404;
}

export function isAccessTokenExpiredApiError(reason: unknown) {
  return getApiErrorStatus(reason) === 401;
}

export function isForbiddenApiError(reason: unknown) {
  return getApiErrorStatus(reason) === 403;
}

export function login(email: string, password: string) {
  return request<AuthSessionDto>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });
}

export async function probeClientServerLatency(_accessToken?: string) {
  const platform = detectUpdatePlatform();
  const result = await requestWithMeta<ClientVersionDto>(`/client/version?platform=${encodeURIComponent(platform)}`);
  return {
    ok: true,
    serverTime: null,
    elapsedMs: result.elapsedMs
  };
}

export function refreshSession(refreshToken: string) {
  return request<AuthSessionDto>("/auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refreshToken })
  });
}

export function logoutSession(accessToken: string, refreshToken?: string | null) {
  return request<{ ok: boolean }>("/auth/logout", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({ refreshToken: refreshToken ?? null })
  });
}

export function fetchBootstrap(accessToken: string, platform: PlatformTarget | "ios" = detectUpdatePlatform()) {
  return request<ClientBootstrapDto>(`/client/bootstrap?platform=${encodeURIComponent(platform)}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
}

export function fetchAnnouncements(accessToken: string) {
  return request<AnnouncementDto[]>("/client/announcements", {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
}

export function markAnnouncementsRead(
  accessToken: string,
  input: {
    announcementIds: string[];
    action: "seen" | "ack";
  }
) {
  return request<{ ok: boolean }>("/client/announcements/read", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify(input)
  });
}

export async function checkClientUpdate(input: {
  currentVersion: string;
  platform?: PlatformTarget | "ios";
  channel?: ReleaseChannel;
  artifactType?: ReleaseArtifactType;
  clientMirrorPrefix?: string;
  accessToken?: string;
}) {
  const platform = input.platform ?? detectUpdatePlatform();
  const channel = input.channel ?? DEFAULT_RELEASE_CHANNEL;
  const artifactType = input.artifactType ?? inferPreferredArtifact(platform);

  try {
    const result = await request<ClientUpdateCheckResult | Record<string, unknown>>("/client/update/check", {
      method: "POST",
      headers: {
        ...(input.accessToken ? { Authorization: `Bearer ${input.accessToken}` } : {})
      },
      body: JSON.stringify({
        currentVersion: input.currentVersion,
        platform,
        channel,
        artifactType,
        clientMirrorPrefix: input.clientMirrorPrefix?.trim() || null
      })
    });
    return normalizeUpdateCheckResult(result, {
      currentVersion: input.currentVersion,
      platform,
      channel,
      artifactType
    });
  } catch (reason) {
    if (isApiStatusError(reason, 404, 405)) {
      return null;
    }
    throw reason;
  }
}

export function fetchNodes(accessToken: string) {
  return request<NodeSummaryDto[]>("/client/nodes", {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
}

export function fetchNodeProbes(accessToken: string, nodeIds: string[]) {
  return request<ClientNodeProbeResultDto[]>("/client/nodes/probe", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({ nodeIds })
  });
}

export function fetchSubscription(accessToken: string) {
  return request<SubscriptionStatusDto>("/client/subscription", {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
}

export async function fetchSupportTickets(accessToken: string) {
  try {
    const tickets = await request<ClientSupportTicketSummaryDto[]>("/client/tickets", {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });
    const unreadCount = tickets.filter((ticket) => ticket.hasUnreadMessages || ticket.unreadCount > 0).length;
    void recordClientDiagnosticLog("client-ticket", `loaded ${tickets.length} tickets, unread=${unreadCount}`);
    return tickets;
  } catch (error) {
    void recordClientDiagnosticLog(
      "client-ticket",
      `list failed: ${error instanceof Error ? error.message : String(error)}`
    );
    throw error;
  }
}

export function fetchSupportTicketDetail(accessToken: string, ticketId: string) {
  return request<ClientSupportTicketDetailDto>(`/client/tickets/${encodeURIComponent(ticketId)}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
}

export function markSupportTicketRead(accessToken: string, ticketId: string) {
  return request<{ ok: boolean }>(`/client/tickets/${encodeURIComponent(ticketId)}/read`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
}

export function createSupportTicket(accessToken: string, input: CreateClientSupportTicketInputDto) {
  return request<ClientSupportTicketDetailDto>("/client/tickets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify(input)
  });
}

export function replySupportTicket(accessToken: string, ticketId: string, input: ReplyClientSupportTicketInputDto) {
  return request<ClientSupportTicketDetailDto>(`/client/tickets/${encodeURIComponent(ticketId)}/replies`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify(input)
  });
}

export async function replySupportTicketWithAttachment(
  accessToken: string,
  ticketId: string,
  input: UploadedSupportTicketAttachmentInputDto,
  file: File
) {
  const body = new FormData();
  if (input.body?.trim()) {
    body.set("body", input.body.trim());
  }
  body.set("file", file);
  const result = await requestForm<ClientSupportTicketDetailDto>(`/client/tickets/${encodeURIComponent(ticketId)}/attachments`, body, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
  return result.data;
}

export function fetchClientRuntime(accessToken: string, sessionId?: string | null) {
  const params = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
  return request<GeneratedRuntimeConfigDto | null>(`/client/runtime${params}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
}

export function connectSession(input: {
  accessToken: string;
  nodeId: string;
  mode: ConnectionMode;
  strategyGroupId?: string;
}) {
  return request<GeneratedRuntimeConfigDto>("/client/session/connect", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.accessToken}`
    },
    body: JSON.stringify({
      nodeId: input.nodeId,
      mode: input.mode,
      strategyGroupId: input.strategyGroupId
    })
  });
}

export function disconnectSession(accessToken: string, sessionId: string) {
  return request<{ ok: boolean; previousSessionId: string | null }>("/client/session/disconnect", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({ sessionId })
  });
}

export function heartbeatSession(accessToken: string, sessionId: string) {
  return request<SessionLeaseStatusDto>("/client/session/heartbeat", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({ sessionId })
  });
}

export async function fetchRuntimeComponentsPlan(input?: {
  accessToken?: string | null;
  clientMirrorPrefix?: string | null;
}) {
  const environment = await loadDesktopRuntimeEnvironment();
  if (!environment) {
    return null;
  }
  try {
    const query = new URLSearchParams({
      platform: environment.platform,
      architecture: environment.architecture
    });
    const mirrorPrefix = input?.clientMirrorPrefix?.trim();
    if (mirrorPrefix) {
      query.set("clientMirrorPrefix", mirrorPrefix);
    }
    const result = await request<ClientRuntimeComponentsPlanDto>(`/client/runtime-components/plan?${query.toString()}`, {
      headers: {
        ...(input?.accessToken ? { Authorization: `Bearer ${input.accessToken}` } : {})
      }
    });
    return normalizeRuntimeComponentsPlan(result, environment);
  } catch (reason) {
    if (isApiStatusError(reason, 404, 405)) {
      return null;
    }
    throw reason;
  }
}

export async function reportRuntimeComponentFailure(
  input: RuntimeComponentFailureReportInput & { accessToken?: string | null }
) {
  const payload: ClientRuntimeComponentFailureReportInputDto = {
    componentId: input.componentId,
    platform: input.platform,
    architecture: input.architecture,
    kind: input.component,
    reason: input.failureReason,
    message: input.message,
    effectiveUrl: input.effectiveUrl,
    appVersion: input.appVersion
  };
  try {
    return await request<{ ok: boolean }>("/client/runtime-components/report-failure", {
      method: "POST",
      headers: {
        ...(input.accessToken ? { Authorization: `Bearer ${input.accessToken}` } : {})
      },
      body: JSON.stringify(payload)
    });
  } catch (reason) {
    if (isApiStatusError(reason, 404, 405)) {
      return null;
    }
    throw reason;
  }
}


type ClientEventSubscriber = {
  onEvent: (event: ClientRuntimeEventDto) => void;
  onError?: (error: Error, meta: { authError: boolean; status: number | null }) => void;
  onOpen?: (meta: { elapsedMs: number | null }) => void;
};

export function subscribeClientEvents(accessToken: string, subscriber: ClientEventSubscriber) {
  let disposed = false;
  let reconnectTimer: number | null = null;
  let fallbackRefreshTimer: number | null = null;
  let fallbackVersionTimer: number | null = null;
  let activeController: AbortController | null = null;
  let nativeCleanup: (() => void) | null = null;
  let lastEventId: string | null = null;
  const handshakeTimeoutMs = 25_000;
  const streamIdleTimeoutMs = 45_000;
  const fallbackRefreshMs = 15_000;
  const fallbackVersionRefreshMs = 60_000;

  const isReplayableEventId = (eventId: string | null) => Boolean(eventId && /^\d+-\d+$/.test(eventId));

  const scheduleReconnect = () => {
    if (disposed || reconnectTimer !== null) {
      return;
    }
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, 3000);
  };

  const connectNative = async () => {
    const invoke = await loadTauriInvoke();
    if (!invoke) {
      void recordClientDiagnosticLog("client-sse-js", "native invoke unavailable");
      return false;
    }

    const startedAt = performance.now();
    const { listen } = await import("@tauri-apps/api/event");
    const streamId =
      typeof crypto.randomUUID === "function"
        ? `client-events-${crypto.randomUUID()}`
        : `client-events-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let opened = false;
    let failedBeforeOpen = false;
    let cleanup = () => undefined;
    const unlistenOpen = await listen<{
      streamId?: string;
    }>("chordv://client-runtime-event-open", (event) => {
      if (event.payload?.streamId !== streamId || opened) {
        return;
      }
      opened = true;
      subscriber.onOpen?.({
        elapsedMs: Math.max(0, Math.round(performance.now() - startedAt))
      });
      void recordClientDiagnosticLog("client-sse-js", "native stream opened");
      stopFallbackRefresh();
    });
    const unlistenEvent = await listen<{
      streamId?: string;
      eventId?: string | null;
      event?: ClientRuntimeEventDto;
    }>("chordv://client-runtime-event", (event) => {
      const payload = event.payload;
      if (!payload?.event || payload.streamId !== streamId) {
        return;
      }
      if (payload.event.type !== "keepalive") {
        void recordClientDiagnosticLog(
          "client-sse-js",
          `native event ${payload.event.type} stream=${payload.streamId ?? "-"} id=${payload.eventId ?? "-"}`
        );
      }
      if (isReplayableEventId(payload.eventId ?? null)) {
        lastEventId = payload.eventId ?? null;
      }
      stopFallbackRefresh();
      subscriber.onEvent(payload.event);
    });
    const unlistenError = await listen<{
      streamId?: string;
      message?: string;
      status?: number | null;
      authError?: boolean;
    }>("chordv://client-runtime-event-error", (event) => {
      const payload = event.payload;
      if (!payload || payload.streamId !== streamId) {
        return;
      }
      const error = new ApiRequestError(payload.status ?? null, payload.message || "事件流连接失败");
      subscriber.onError?.(error, {
        authError: Boolean(payload.authError) || payload.status === 401,
        status: payload.status ?? null
      });
      failedBeforeOpen = true;
      cleanup();
      if (!payload.authError && payload.status !== 401 && payload.status !== 403) {
        startFallbackRefresh();
        scheduleReconnect();
      }
    });

    cleanup = () => {
      unlistenOpen();
      unlistenEvent();
      unlistenError();
      void invoke("stop_client_event_stream", { streamId }).catch(() => null);
      if (nativeCleanup === cleanup) {
        nativeCleanup = null;
      }
    };
    nativeCleanup = cleanup;

    try {
      const response = await invoke<{ streamId: string }>("start_client_event_stream", {
        input: {
          streamId,
          accessToken,
          lastEventId
        }
      });
      if (response.streamId !== streamId) {
        throw new Error("native SSE stream id mismatch");
      }
      if (disposed || failedBeforeOpen) {
        cleanup();
        return true;
      }
      return true;
    } catch (error) {
      cleanup();
      subscriber.onError?.(error instanceof Error ? error : new Error("事件流连接失败"), {
        authError: false,
        status: null
      });
      return false;
    }
  };

  const emitSyntheticEvent = (type: ClientRuntimeEventType) => {
    subscriber.onEvent({
      type,
      occurredAt: new Date().toISOString(),
      synthetic: true
    } as ClientRuntimeEventDto);
  };

  const emitFallbackRefresh = (includeVersion: boolean) => {
    for (const type of createClientRuntimeFallbackRefreshEventTypes(includeVersion)) {
      emitSyntheticEvent(type);
    }
  };

  const startFallbackRefresh = () => {
    if (disposed || fallbackRefreshTimer !== null) {
      return;
    }
    emitFallbackRefresh(false);
    fallbackRefreshTimer = window.setInterval(() => {
      emitFallbackRefresh(false);
    }, fallbackRefreshMs);
    fallbackVersionTimer = window.setInterval(() => {
      emitSyntheticEvent("version_updated");
    }, fallbackVersionRefreshMs);
  };

  const stopFallbackRefresh = () => {
    if (fallbackRefreshTimer !== null) {
      window.clearInterval(fallbackRefreshTimer);
      fallbackRefreshTimer = null;
    }
    if (fallbackVersionTimer !== null) {
      window.clearInterval(fallbackVersionTimer);
      fallbackVersionTimer = null;
    }
  };

  const handleEventBlock = (chunk: string) => {
    const parsedEvent = parseServerSentEventBlock(chunk);
    if (!parsedEvent.data) {
      if (isReplayableEventId(parsedEvent.id)) {
        lastEventId = parsedEvent.id;
      }
      return;
    }

    try {
      const payload = parseClientRuntimeEvent(parsedEvent);
      if (isReplayableEventId(parsedEvent.id)) {
        lastEventId = parsedEvent.id;
      }
      subscriber.onEvent(payload);
    } catch (error) {
      subscriber.onError?.(error instanceof Error ? error : new Error("事件解析失败"), {
        authError: false,
        status: null
      });
    }
  };

  const connect = async () => {
    let nativeHandled = false;
    try {
      nativeHandled = await connectNative();
    } catch (error) {
      void recordClientDiagnosticLog(
        "client-sse-js",
        `native connect crashed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (nativeHandled || disposed) {
      return;
    }

    void recordClientDiagnosticLog("client-sse-js", "fetch fallback begin");
    const startedAt = performance.now();
    const controller = new AbortController();
    activeController = controller;
    let idleAbort = false;
    let handshakeTimer: number | null = window.setTimeout(() => {
      idleAbort = true;
      controller.abort();
    }, handshakeTimeoutMs);
    let idleTimer: number | null = null;
    const armIdleWatchdog = () => {
      if (idleTimer !== null) {
        window.clearTimeout(idleTimer);
      }
      idleTimer = window.setTimeout(() => {
        idleAbort = true;
        controller.abort();
      }, streamIdleTimeoutMs);
    };
    const clearIdleWatchdog = () => {
      if (idleTimer !== null) {
        window.clearTimeout(idleTimer);
        idleTimer = null;
      }
    };
    const clearHandshakeWatchdog = () => {
      if (handshakeTimer !== null) {
        window.clearTimeout(handshakeTimer);
        handshakeTimer = null;
      }
    };
    try {
      const response = await fetch(`${API_BASE}/api/client/events/stream`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "text/event-stream",
          ...(lastEventId ? { "Last-Event-ID": lastEventId } : {})
        },
        signal: controller.signal
      });
      clearHandshakeWatchdog();

      if (!response.ok) {
        throw createApiRequestError("/client/events/stream", response.status, await response.text());
      }

      if (!response.body) {
        throw new Error("事件流未返回内容");
      }

      subscriber.onOpen?.({
        elapsedMs: Math.max(0, Math.round(performance.now() - startedAt))
      });
      void recordClientDiagnosticLog("client-sse-js", "fetch stream opened");
      stopFallbackRefresh();
      armIdleWatchdog();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!disposed) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        armIdleWatchdog();
        buffer += decoder.decode(value, { stream: true });
        const chunks = splitServerSentEventBlocks(buffer);
        buffer = chunks.pop() ?? "";

        for (const chunk of chunks) {
          const parsedEvent = parseServerSentEventBlock(chunk);
          if (!parsedEvent.data) {
            if (isReplayableEventId(parsedEvent.id)) {
              lastEventId = parsedEvent.id;
            }
            continue;
          }

          try {
            const payload = parseClientRuntimeEvent(parsedEvent);
            if (payload.type !== "keepalive") {
              void recordClientDiagnosticLog("client-sse-js", `fetch event ${payload.type} id=${parsedEvent.id ?? "-"}`);
            }
            if (isReplayableEventId(parsedEvent.id)) {
              lastEventId = parsedEvent.id;
            }
            subscriber.onEvent(payload);
          } catch (error) {
            subscriber.onError?.(error instanceof Error ? error : new Error("事件解析失败"), {
              authError: false,
              status: null
            });
          }
        }
      }

      if (buffer.trim()) {
        handleEventBlock(buffer);
      }
      startFallbackRefresh();
      scheduleReconnect();
    } catch (error) {
      if (disposed) {
        return;
      }
      if (controller.signal.aborted && !idleAbort) {
        return;
      }
      const normalizedError = error instanceof Error ? error : new Error("事件流连接失败");
      const status = getApiErrorStatus(normalizedError);
      const authError = isAccessTokenExpiredApiError(normalizedError) || status === 403;
      subscriber.onError?.(normalizedError, {
        authError,
        status
      });
      if (authError) {
        return;
      }
      startFallbackRefresh();
      scheduleReconnect();
    } finally {
      clearHandshakeWatchdog();
      clearIdleWatchdog();
      if (activeController === controller) {
        activeController = null;
      }
    }
  };

  void connect();

  return () => {
    disposed = true;
    stopFallbackRefresh();
    nativeCleanup?.();
    activeController?.abort();
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
    }
  };
}

export function splitServerSentEventBlocks(input: string) {
  return input.split(/\r\n\r\n|\n\n|\r\r/);
}

export function parseServerSentEventBlock(block: string): ParsedServerSentEvent {
  const dataLines: string[] = [];
  let eventName: string | null = null;
  let eventId: string | null = null;

  for (const rawLine of block.split(/\r\n|\r|\n/)) {
    if (!rawLine || rawLine.startsWith(":")) {
      continue;
    }

    const separatorIndex = rawLine.indexOf(":");
    const field = separatorIndex >= 0 ? rawLine.slice(0, separatorIndex) : rawLine;
    const rawValue = separatorIndex >= 0 ? rawLine.slice(separatorIndex + 1) : "";
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

    if (field === "data") {
      dataLines.push(value);
    } else if (field === "event") {
      eventName = value.trim() || null;
    } else if (field === "id") {
      eventId = value.trim() || null;
    }
  }

  return {
    event: eventName,
    id: eventId,
    data: dataLines.length > 0 ? dataLines.join("\n") : null
  };
}

export function parseClientRuntimeEvent(event: ParsedServerSentEvent): ClientRuntimeEventDto {
  if (!event.data) {
    throw new Error("事件内容为空");
  }
  const parsed = JSON.parse(event.data) as Partial<ClientRuntimeEventDto>;
  const parsedType = typeof parsed.type === "string" ? (parsed.type as string) : "";
  if (event.event && (!parsedType || parsedType === "message")) {
    parsed.type = event.event as ClientRuntimeEventDto["type"];
  }
  if (!parsed.type) {
    throw new Error("事件类型为空");
  }
  return parsed as ClientRuntimeEventDto;
}

function detectUpdatePlatform(): PlatformTarget | "ios" {
  if (/android/i.test(window.navigator.userAgent)) {
    return "android";
  }
  if (/iphone|ipad|ipod/i.test(window.navigator.userAgent)) {
    return "ios";
  }
  if (/windows/i.test(window.navigator.userAgent)) {
    return "windows";
  }
  return "macos";
}

function inferPreferredArtifact(platform: PlatformTarget | "ios"): ReleaseArtifactType {
  switch (platform) {
    case "windows":
      return "zip";
    case "android":
      return "apk";
    case "ios":
      return "ipa";
    default:
      return "dmg";
  }
}

function normalizeUpdateCheckResult(
  raw: ClientUpdateCheckResult | Record<string, unknown>,
  fallback: {
    currentVersion: string;
    platform: PlatformTarget | "ios";
    channel: ReleaseChannel;
    artifactType: ReleaseArtifactType;
  }
): ClientUpdateCheckResult {
  const record = raw as Record<string, unknown>;
  const artifactSource = asRecord(record.artifact) ?? asRecord(record.recommendedArtifact);
  const artifactRecord = artifactSource ?? (fallback.platform === "windows" ? null : record);
  const artifact = artifactRecord
    ? (() => {
      const artifactUrl = resolvePublicUrl(
          readString(artifactRecord.downloadUrl) ?? ""
        );
        if (!artifactUrl) {
          return null;
        }
        return {
          fileType:
            readArtifactType(artifactRecord.fileType) ??
            readArtifactType(artifactRecord.type) ??
            fallback.artifactType,
          downloadUrl: artifactUrl,
          originDownloadUrl: resolvePublicUrl(
            readString(artifactRecord.originDownloadUrl) ??
              readString(artifactRecord.downloadUrl)
          ),
          defaultMirrorPrefix: readString(artifactRecord.defaultMirrorPrefix) ?? readString(record.defaultMirrorPrefix),
          allowClientMirror: readBoolean(artifactRecord.allowClientMirror) ?? readBoolean(record.allowClientMirror) ?? true,
          fileName: readString(artifactRecord.fileName) ?? readString(record.fileName),
          fileSizeBytes: readNumber(artifactRecord.fileSizeBytes) ?? readNumber(record.fileSizeBytes),
          fileHash: readString(artifactRecord.fileHash) ?? readString(record.fileHash),
          isPrimary: readBoolean(artifactRecord.isPrimary) ?? readBoolean(record.isPrimary) ?? true,
          isFullPackage: readBoolean(artifactRecord.isFullPackage) ?? readBoolean(record.isFullPackage) ?? true
        };
      })()
    : null;
  const deliveryMode = readDeliveryMode(record.deliveryMode) ?? inferDeliveryMode(fallback.platform, artifact?.fileType);
  const latestVersion = readString(record.latestVersion) ?? readString(record.currentVersion) ?? fallback.currentVersion;
  const minimumVersion = readString(record.minimumVersion) ?? fallback.currentVersion;
  const forceUpgrade = readBoolean(record.forceUpgrade) ?? false;
  const hasUpdate = readBoolean(record.hasUpdate) ?? latestVersion !== fallback.currentVersion;
  const requiresDownloadArtifact = hasUpdate || forceUpgrade;
  if (requiresDownloadArtifact && deliveryMode === "desktop_installer_download" && fallback.platform === "windows") {
    throw new Error("Windows installer updates are disabled; use a ZIP full replacement artifact.");
  }
  if (requiresDownloadArtifact && deliveryMode === "desktop_full_replace" && fallback.platform === "windows") {
    if (!artifact || artifact.fileType !== "zip" || !artifact.downloadUrl) {
      throw new Error("Windows full replacement updates require a ZIP artifact.");
    }
  }
  const downloadUrl =
    deliveryMode === "desktop_full_replace" && fallback.platform === "windows"
      ? artifact?.downloadUrl ?? null
      : artifact?.downloadUrl ?? resolvePublicUrl(readString(record.downloadUrl)) ?? null;

  return {
    platform: readPlatform(record.platform) ?? fallback.platform,
    channel: readChannel(record.channel) ?? fallback.channel,
    currentVersion: fallback.currentVersion,
    latestVersion,
    minimumVersion,
    hasUpdate,
    forceUpgrade,
    title: readString(record.title) ?? formatUpdateTitle(latestVersion),
    changelog: readStringArray(record.changelog),
    publishedAt: readString(record.publishedAt),
    deliveryMode,
    downloadUrl,
    artifact: artifact && artifact.downloadUrl ? artifact : null
  };
}

function normalizeRuntimeComponentsPlan(
  raw: ClientRuntimeComponentsPlanDto,
  environment: Awaited<ReturnType<typeof loadDesktopRuntimeEnvironment>>
): ClientRuntimeComponentsPlan {
  return {
    platform: raw.platform as Extract<PlatformTarget, "macos" | "windows">,
    architecture: raw.architecture,
    allowClientMirrorOverride: raw.components.some((item) => item.allowClientMirror),
    defaultMirrorPrefix:
      raw.components.find((item) => item.defaultMirrorPrefix)?.defaultMirrorPrefix ?? null,
    components: raw.components.map((item) => ({
      id: item.id,
      component: item.kind,
      fileName: item.fileName,
      fileSizeBytes: readNumber(item.fileSizeBytes),
      sourceFormat: item.archiveEntryName ? "zip_entry" : "direct",
      archiveEntryName: item.archiveEntryName ?? null,
      checksumSha256: item.expectedHash ?? null,
      candidates: item.candidates.map((candidate) => ({
        label: candidate.label,
        url: candidate.url,
        source:
          candidate.label === "client_mirror"
            ? "client_override"
            : candidate.label === "default_mirror"
              ? "server_mirror"
              : "origin"
      })),
      selectedUrl: item.resolvedUrl,
      displayName: runtimeComponentDisplayName(item.kind, environment?.platform ?? raw.platform)
    }))
  };
}

function runtimeComponentDisplayName(
  kind: "xray" | "geoip" | "geosite",
  platform: PlatformTarget | "ios"
) {
  if (kind === "xray") {
    return platform === "macos" ? "macOS Xray 内核" : "Windows Xray 内核";
  }
  if (kind === "geoip") {
    return "GeoIP 数据";
  }
  return "GeoSite 数据";
}

function inferDeliveryMode(platform: PlatformTarget | "ios", artifactType?: ReleaseArtifactType | null): UpdateDeliveryMode {
  if (artifactType === "zip") {
    return "desktop_full_replace";
  }
  if (artifactType === "setup.exe" || artifactType === "exe" || artifactType === "dmg" || artifactType === "app") {
    return "desktop_installer_download";
  }
  if (platform === "android") {
    return "apk_download";
  }
  if (platform === "ios") {
    return "external_download";
  }
  if (platform === "windows") {
    return "desktop_full_replace";
  }
  return "desktop_installer_download";
}

function formatUpdateTitle(version: string) {
  return `发现新版本 ${version}`;
}

function resolvePublicUrl(value: string | null | undefined) {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }
  if (/^https?:\/\//i.test(normalized)) {
    return normalized;
  }
  return new URL(normalized, API_BASE).toString();
}

function asRecord(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeElapsedMs(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.round(value);
}

function readBoolean(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function readStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function readChannel(value: unknown): ReleaseChannel | null {
  return value === "stable" ? "stable" : null;
}

function readPlatform(value: unknown): PlatformTarget | "ios" | null {
  return value === "macos" || value === "windows" || value === "android" || value === "ios" ? value : null;
}

function readDeliveryMode(value: unknown): UpdateDeliveryMode | null {
  return value === "desktop_installer_download" ||
    value === "desktop_full_replace" ||
    value === "apk_download" ||
    value === "external_download" ||
    value === "none"
    ? value
    : null;
}

function readArtifactType(value: unknown): ReleaseArtifactType | null {
  return value === "dmg" ||
    value === "app" ||
    value === "exe" ||
    value === "setup.exe" ||
    value === "zip" ||
    value === "apk" ||
    value === "ipa" ||
    value === "external"
    ? value
    : null;
}
