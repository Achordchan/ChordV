import type {
  AuthSessionDto,
  ClientNodeProbeResultDto,
  ClientBootstrapDto,
  ClientPingDto,
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
  SubscriptionStatusDto
} from "@chordv/shared";
import type {
  ClientRuntimeComponentsPlan,
  RuntimeComponentFailureReportInput
} from "../lib/runtimeComponents";
import { loadDesktopRuntimeEnvironment } from "../lib/runtime";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "https://v.baymaxgroup.com";
const DEFAULT_RELEASE_CHANNEL = "stable";

export type ReleaseChannel = "stable";
export type UpdateDeliveryMode = "desktop_installer_download" | "apk_download" | "external_download" | "none";
export type ReleaseArtifactType = "dmg" | "app" | "exe" | "setup.exe" | "apk" | "ipa" | "external";

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
      throw new Error(response.body || `HTTP ${response.status}`);
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
    throw new Error(text || `HTTP ${response.status}`);
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

async function loadNativeInvoke(): Promise<NativeInvoke | null> {
  if (!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
    return null;
  }
  const module = await import("@tauri-apps/api/core");
  return module.invoke as NativeInvoke;
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

export function login(email: string, password: string) {
  return request<AuthSessionDto>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });
}

export async function probeClientServerLatency(accessToken: string) {
  const result = await requestWithMeta<ClientPingDto>("/client/ping", {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
  return {
    ...result.data,
    elapsedMs: result.elapsedMs
  };
}

export function refreshSession(refreshToken: string) {
  return request<AuthSessionDto>("/auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refreshToken })
  });
}

export function logoutSession(accessToken: string) {
  return request<{ ok: boolean }>("/auth/logout", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
}

export function fetchBootstrap(accessToken: string) {
  return request<ClientBootstrapDto>("/client/bootstrap", {
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
    const message = reason instanceof Error ? reason.message : String(reason);
    if (message.includes("HTTP 404") || message.includes("HTTP 405")) {
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

export function fetchSupportTickets(accessToken: string) {
  return request<ClientSupportTicketSummaryDto[]>("/client/tickets", {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
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

export function fetchClientRuntime(accessToken: string) {
  return request<GeneratedRuntimeConfigDto | null>("/client/runtime", {
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
    const message = reason instanceof Error ? reason.message : String(reason);
    if (message.includes("HTTP 404") || message.includes("HTTP 405")) {
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
    const message = reason instanceof Error ? reason.message : String(reason);
    if (message.includes("HTTP 404") || message.includes("HTTP 405")) {
      return null;
    }
    throw reason;
  }
}


type ClientEventSubscriber = {
  onEvent: (event: ClientRuntimeEventDto) => void;
  onError?: (error: Error) => void;
  onOpen?: () => void;
};

export function subscribeClientEvents(accessToken: string, subscriber: ClientEventSubscriber) {
  const controller = new AbortController();
  let disposed = false;
  let reconnectTimer: number | null = null;

  const scheduleReconnect = () => {
    if (disposed) {
      return;
    }
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, 3000);
  };

  const connect = async () => {
    try {
      const response = await fetch(`${API_BASE}/api/client/events/stream`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "text/event-stream"
        },
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error((await response.text()) || `HTTP ${response.status}`);
      }

      if (!response.body) {
        throw new Error("事件流未返回内容");
      }

      subscriber.onOpen?.();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!disposed) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";

        for (const chunk of chunks) {
          const lines = chunk
            .split("\n")
            .map((line) => line.replace(/\r$/, ""))
            .filter(Boolean);
          if (lines.length === 0) {
            continue;
          }

          const dataLines: string[] = [];

          for (const line of lines) {
            if (line.startsWith("data:")) {
              dataLines.push(line.slice(5).trim());
            }
          }

          if (dataLines.length === 0) {
            continue;
          }

          try {
            const payload = JSON.parse(dataLines.join("\n")) as ClientRuntimeEventDto;
            subscriber.onEvent(payload);
          } catch (error) {
            subscriber.onError?.(error instanceof Error ? error : new Error("事件解析失败"));
          }
        }
      }

      scheduleReconnect();
    } catch (error) {
      if (disposed || controller.signal.aborted) {
        return;
      }
      subscriber.onError?.(error instanceof Error ? error : new Error("事件流连接失败"));
      scheduleReconnect();
    }
  };

  void connect();

  return () => {
    disposed = true;
    controller.abort();
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
    }
  };
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
      return "setup.exe";
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
  const artifactRecord = artifactSource ?? record;
  const artifact = artifactRecord
    ? (() => {
        const artifactUrl = resolvePublicUrl(
          readString(artifactRecord.downloadUrl) ?? readString(record.downloadUrl) ?? ""
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
              readString(artifactRecord.downloadUrl) ??
              readString(record.downloadUrl)
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
  const downloadUrl = resolvePublicUrl(readString(record.downloadUrl)) ?? artifact?.downloadUrl ?? null;
  const latestVersion = readString(record.latestVersion) ?? readString(record.currentVersion) ?? fallback.currentVersion;
  const minimumVersion = readString(record.minimumVersion) ?? fallback.currentVersion;
  const forceUpgrade = readBoolean(record.forceUpgrade) ?? false;
  const hasUpdate = readBoolean(record.hasUpdate) ?? latestVersion !== fallback.currentVersion;

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
    deliveryMode: readDeliveryMode(record.deliveryMode) ?? inferDeliveryMode(fallback.platform),
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

function inferDeliveryMode(platform: PlatformTarget | "ios"): UpdateDeliveryMode {
  if (platform === "android") {
    return "apk_download";
  }
  if (platform === "ios") {
    return "external_download";
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
    value === "apk" ||
    value === "ipa" ||
    value === "external"
    ? value
    : null;
}
