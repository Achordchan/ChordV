import type {
  AdminSupportTicketDetailDto as SharedAdminSupportTicketDetailDto,
  AdminSupportTicketSummaryDto as SharedAdminSupportTicketSummaryDto,
  AdminImageBedConfigDto,
  AdminImageBedFileListDto,
  AdminUploadLimitsDto,
  DeleteAdminImageBedFileResultDto,
  ReplyClientSupportTicketInputDto,
  SupportTicketStatus,
  UpdateAdminImageBedConfigInputDto,
  UploadedSupportTicketAttachmentInputDto
} from "@chordv/shared";
import { API_BASE, captureAdminSession, clearStoredAdminSession, getStoredAdminAccessToken, refreshAdminAccessToken, request } from "./base";

const IMAGE_BED_MANAGE_TIMEOUT_MS = 60 * 1000;
const IMAGE_BED_CONFIG_TIMEOUT_MS = 8 * 1000;
const IMAGE_BED_LIST_TIMEOUT_MS = 10 * 1000;
const IMAGE_BED_LIST_TIMEOUT_MESSAGE = "图床文件列表加载超时，请稍后重试或缩小搜索范围。";
const IMAGE_BED_CONFIG_SAVE_TIMEOUT_MESSAGE = "图床配置保存请求仍在处理，请稍后刷新图床配置确认结果。";
const IMAGE_BED_MANAGE_TIMEOUT_MESSAGE = "图床管理请求仍在处理，请稍后刷新文件列表确认结果。";
const TICKET_ATTACHMENT_TIMEOUT_MS = 90 * 1000;
const ADMIN_READ_TIMEOUT_MS = 60 * 1000;
const ADMIN_ACTION_TIMEOUT_MS = 60 * 1000;
const ADMIN_EVENT_STREAM_STALE_MS = 60 * 1000;

export * from "./announcements";
export * from "./auth";
export * from "./nodes";
export * from "./plans";
export * from "./policies";
export * from "./subscriptions";
export * from "./support-integration";
export * from "./teams";
export * from "./users";
export type AdminSupportTicketSummaryDto = SharedAdminSupportTicketSummaryDto;
export type AdminSupportTicketDetailDto = SharedAdminSupportTicketDetailDto;
export type { AdminUploadLimitsDto };
export type ReplyAdminSupportTicketInputDto = ReplyClientSupportTicketInputDto;
export type AdminRuntimeEventDto = {
  type:
    | "keepalive"
    | "resync"
    | "ticket_updated"
    | "subscription_updated"
    | "node_access_updated"
    | "image_bed_updated"
    | "account_updated"
    | "announcement_updated"
    | "announcement_read_state_updated"
    | "policy_updated"
    | "sync_queue_updated"
    | "presence_updated";
  occurredAt: string;
  reason?: "connected" | "replay_gap";
  ticketId?: string | null;
  ticketStatus?: SupportTicketStatus | null;
  announcementId?: string | null;
  subscriptionId?: string | null;
  subscriptionState?: string | null;
  nodeId?: string | null;
  state?: string | null;
  platform?: "macos" | "windows" | "android" | "ios" | null;
  channel?: "stable" | "beta" | null;
};

export async function fetchAdminUploadLimits() {
  return request<AdminUploadLimitsDto>("/admin/upload-limits", {
    timeoutMs: ADMIN_READ_TIMEOUT_MS
  });
}

export type FetchAdminSupportTicketsFilters = {
  status?: SupportTicketStatus;
  ownerType?: "personal" | "team";
  userEmail?: string;
  keyword?: string;
};

export type FetchAdminImageBedFilesInput = {
  start?: number;
  count?: number;
  search?: string;
  dir?: string;
  recursive?: boolean;
};
type AdminImageBedManageRequestOptions = RequestInit & {
  timeoutMs?: number;
  timeoutMessage?: string;
};

function isBackendHttpErrorMessage(message: string) {
  try {
    const parsed = JSON.parse(message) as { statusCode?: unknown; status?: unknown; message?: unknown };
    return typeof parsed.statusCode === "number" || typeof parsed.status === "number" || parsed.message !== undefined;
  } catch {
    return false;
  }
}

function readRequestIdFromErrorMessage(message: string) {
  try {
    const parsed = JSON.parse(message) as { requestId?: unknown };
    if (typeof parsed.requestId === "string" && parsed.requestId.trim()) {
      return parsed.requestId.trim();
    }
  } catch {
    const match = /\brequestId=([A-Za-z0-9._:-]+)/.exec(message);
    return match?.[1] ?? null;
  }
  const match = /\brequestId=([A-Za-z0-9._:-]+)/.exec(message);
  return match?.[1] ?? null;
}

function appendRequestIdToErrorMessage(message: string, requestId?: string | null) {
  const trimmed = requestId?.trim();
  if (!trimmed || message.includes(trimmed)) {
    return message;
  }
  return `${message} requestId=${trimmed}`;
}

export async function fetchAdminImageBedConfig() {
  return request<AdminImageBedConfigDto>("/admin/image-bed/config", {
    timeoutMs: IMAGE_BED_CONFIG_TIMEOUT_MS
  });
}

export async function updateAdminImageBedConfig(input: UpdateAdminImageBedConfigInputDto) {
  return requestAdminImageBedManage<AdminImageBedConfigDto>("/admin/image-bed/config", {
    method: "PATCH",
    body: JSON.stringify(input),
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS,
    timeoutMessage: IMAGE_BED_CONFIG_SAVE_TIMEOUT_MESSAGE
  });
}

async function requestAdminImageBedManage<T>(path: string, init?: AdminImageBedManageRequestOptions) {
  try {
    const { timeoutMessage, ...requestInit } = init ?? {};
    return await request<T>(path, {
      ...requestInit,
      timeoutMs: init?.timeoutMs ?? IMAGE_BED_MANAGE_TIMEOUT_MS
    });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    if (!isBackendHttpErrorMessage(message) && /请求超时|AbortError|aborted|timeout|timed out/i.test(message)) {
      throw new Error(appendRequestIdToErrorMessage(init?.timeoutMessage ?? IMAGE_BED_MANAGE_TIMEOUT_MESSAGE, readRequestIdFromErrorMessage(message)));
    }
    throw reason;
  }
}

export async function fetchAdminImageBedFiles(input?: FetchAdminImageBedFilesInput) {
  const params = new URLSearchParams();
  if (input?.start !== undefined) params.set("start", String(input.start));
  if (input?.count !== undefined) params.set("count", String(input.count));
  if (input?.search?.trim()) params.set("search", input.search.trim());
  if (input?.dir?.trim()) params.set("dir", input.dir.trim());
  if (input?.recursive !== undefined) params.set("recursive", String(input.recursive));
  const query = params.toString();
  return requestAdminImageBedManage<AdminImageBedFileListDto>(`/admin/image-bed/files${query ? `?${query}` : ""}`, {
    timeoutMs: IMAGE_BED_LIST_TIMEOUT_MS,
    timeoutMessage: IMAGE_BED_LIST_TIMEOUT_MESSAGE
  });
}

export async function deleteAdminImageBedFile(path: string, folder?: boolean) {
  const params = new URLSearchParams({ path });
  if (folder) params.set("folder", "true");
  return requestAdminImageBedManage<DeleteAdminImageBedFileResultDto>(`/admin/image-bed/files?${params.toString()}`, {
    method: "DELETE"
  });
}

export async function fetchAdminSupportTickets() {
  return request<SharedAdminSupportTicketSummaryDto[]>("/admin/tickets", {
    timeoutMs: ADMIN_READ_TIMEOUT_MS
  });
}

const adminEventSubscribers = new Set<(event: AdminRuntimeEventDto) => void>();
let stopAdminEventTransport: (() => void) | null = null;

/** All admin consumers share one transport. Opening a node dialog must not
 * establish another stream and trigger another application-wide resync. */
export function subscribeAdminRuntimeEvents(onEvent: (event: AdminRuntimeEventDto) => void) {
  const listener = (event: AdminRuntimeEventDto) => onEvent(event);
  adminEventSubscribers.add(listener);
  if (!stopAdminEventTransport) {
    stopAdminEventTransport = connectAdminRuntimeEvents(event => {
      for (const subscriber of [...adminEventSubscribers]) {
        try { subscriber(event); } catch (error) { console.error("Admin event subscriber failed", error); }
      }
    });
  }
  return () => {
    adminEventSubscribers.delete(listener);
    if (!adminEventSubscribers.size) { stopAdminEventTransport?.(); stopAdminEventTransport = null; }
  };
}

function connectAdminRuntimeEvents(onEvent: (event: AdminRuntimeEventDto) => void) {
  let stopped = false;
  let reconnectTimer: ReturnType<typeof window.setTimeout> | null = null;
  let controller: AbortController | null = null;
  let lastEventId: string | null = null;

  let retryDelay = 3000;
  let usedImmediateAuthRetry = false;
  const scheduleReconnect = (immediate = false) => {
    if (stopped || reconnectTimer !== null) {
      return;
    }
    const delayMs = immediate ? 0 : Math.min(30_000, retryDelay + Math.floor(Math.random() * 501));
    if (!immediate) retryDelay = Math.min(30_000, retryDelay * 2);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delayMs);
  };

  const connect = async () => {
    if (stopped) {
      return;
    }
    const assertCurrent = captureAdminSession();
    controller = new AbortController();
    let openedAt: number | null = null;
    let receivedEvent = false;
    try {
      const headers: Record<string, string> = {};
      const token = getStoredAdminAccessToken();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      if (lastEventId) {
        headers["Last-Event-ID"] = lastEventId;
      }

      const response = await fetch(`${API_BASE}/api/admin/events/stream`, {
        method: "GET",
        credentials: "include",
        headers,
        signal: controller.signal
      });
      if (stopped) return;
      assertCurrent();
      if (response.status === 401 || response.status === 403) {
        const refreshedAccessToken = await refreshAdminAccessToken();
        if (stopped) return;
        assertCurrent();
        if (refreshedAccessToken) {
          scheduleReconnect(!usedImmediateAuthRetry);
          usedImmediateAuthRetry = true;
          return;
        }
        clearStoredAdminSession({ notify: true });
        stopped = true;
        return;
      }

      if (!response.ok || !response.body) {
        throw new Error(`Admin event stream failed: HTTP ${response.status}`);
      }

      openedAt = Date.now();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let lastChunkAt = Date.now();
      const watchdog = window.setInterval(() => {
        if (Date.now() - lastChunkAt > ADMIN_EVENT_STREAM_STALE_MS) {
          controller?.abort(new Error("Admin event stream heartbeat timed out"));
        }
      }, ADMIN_EVENT_STREAM_STALE_MS);
      try {
        while (!stopped) {
          const { done, value } = await reader.read();
          if (stopped) return;
          assertCurrent();
          if (done) {
            break;
          }
          lastChunkAt = Date.now();
          buffer += decoder.decode(value, { stream: true });
          const parsed = parseAdminEventStreamBuffer(buffer, (eventId, event) => {
            receivedEvent = true;
            if (eventId) {
              lastEventId = eventId;
            }
            onEvent(event);
          });
          buffer = parsed.remaining;
        }
      } finally {
        window.clearInterval(watchdog);
        reader.releaseLock();
      }
    } catch (error) {
      if (!stopped) {
        console.warn(error);
      }
    } finally {
      if (receivedEvent && openedAt !== null && Date.now() - openedAt >= ADMIN_EVENT_STREAM_STALE_MS) {
        retryDelay = 3000;
        usedImmediateAuthRetry = false;
      }
      controller?.abort();
      controller = null;
      scheduleReconnect();
    }
  };

  void connect();

  return () => {
    stopped = true;
    if (reconnectTimer) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    controller?.abort();
    controller = null;
  };
}

function parseAdminEventStreamBuffer(
  input: string,
  onEvent: (eventId: string | null, event: AdminRuntimeEventDto) => void
) {
  const normalized = input.replace(/\r\n/g, "\n");
  const chunks = normalized.split("\n\n");
  const remaining = chunks.pop() ?? "";
  for (const chunk of chunks) {
    let eventId: string | null = null;
    const dataLines: string[] = [];
    for (const line of chunk.split("\n")) {
      if (line.startsWith("id:")) {
        eventId = line.slice(3).trim();
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    const data = dataLines.join("\n").trim();
    if (!data) {
      continue;
    }
    try {
      onEvent(eventId, JSON.parse(data) as AdminRuntimeEventDto);
    } catch (error) {
      console.warn(error);
    }
  }
  return { remaining };
}

export async function fetchAdminSupportTicketDetail(ticketId: string) {
  return request<SharedAdminSupportTicketDetailDto>(`/admin/tickets/${ticketId}`, {
    timeoutMs: ADMIN_READ_TIMEOUT_MS
  });
}

export async function replyAdminSupportTicket(ticketId: string, input: ReplyAdminSupportTicketInputDto) {
  return request<SharedAdminSupportTicketDetailDto>(`/admin/tickets/${ticketId}/replies`, {
    method: "POST",
    body: JSON.stringify(input),
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
}

export async function replyAdminSupportTicketWithAttachment(
  ticketId: string,
  input: UploadedSupportTicketAttachmentInputDto,
  file: File
) {
  const body = new FormData();
  if (input.body?.trim()) {
    body.set("body", input.body.trim());
  }
  body.set("file", file);
  return request<SharedAdminSupportTicketDetailDto>(`/admin/tickets/${ticketId}/attachments`, {
    method: "POST",
    body,
    timeoutMs: TICKET_ATTACHMENT_TIMEOUT_MS
  });
}

export async function closeAdminSupportTicket(ticketId: string) {
  return request<SharedAdminSupportTicketDetailDto>(`/admin/tickets/${ticketId}/close`, {
    method: "POST",
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
}

export async function reopenAdminSupportTicket(ticketId: string) {
  return request<SharedAdminSupportTicketDetailDto>(`/admin/tickets/${ticketId}/reopen`, {
    method: "POST",
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
}
