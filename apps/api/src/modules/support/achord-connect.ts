import { BadRequestException } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Achord Connect（新工单系统）接入的纯函数部分：地址与凭据校验、对工单系统的 HTTP 请求、Webhook 验签。
 * 这里不接触数据库，便于回归测试直接调用；Client Secret、Webhook Secret 不得出现在任何日志或错误信息里。
 */

export const ACHORD_CONNECT_WEBHOOK_PATH = "/api/integrations/achord-connect/webhook";
export const ACHORD_CONNECT_WEBHOOK_TOLERANCE_SECONDS = 300;
export const ACHORD_CONNECT_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const LAUNCH_TICKETS_PATH = "/api/v1/integrations/universal/launch-tickets";
const RESPONSE_MAX_CHARS = 256 * 1024;
const USER_NAME_MAX_CHARS = 160;
const EXTERNAL_ID_MAX_CHARS = 191;

export type AchordConnectCredentials = {
  /** 工单系统站点来源，例如 https://support.achord.cn（不带路径）。 */
  baseUrl: string;
  clientId: string;
  clientSecret: string;
};

export type AchordConnectFetch = (input: string, init: RequestInit) => Promise<Response>;

export type AchordConnectFailureKind = "timeout" | "network" | "http" | "invalid_response";

/** 工单系统请求失败。message 只含状态与错误码，可写日志；不含凭据和工单系统返回的原文。 */
export class AchordConnectRequestError extends Error {
  constructor(
    readonly kind: AchordConnectFailureKind,
    readonly status: number | null,
    readonly code: string | null,
    detail: string
  ) {
    super(detail);
    this.name = "AchordConnectRequestError";
  }
}

/** 工单系统地址只接受 HTTPS 站点来源；本地开发允许 http://localhost。 */
export function normalizeAchordConnectBaseUrl(value: string, allowLoopbackHttp = process.env.NODE_ENV !== "production"): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new BadRequestException("请填写完整的工单系统地址，例如 https://support.achord.cn");
  }
  const loopbackHttp = allowLoopbackHttp && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((!loopbackHttp && url.protocol !== "https:") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new BadRequestException("工单系统地址必须是 HTTPS 域名，不能包含账号、路径、查询参数或片段");
  }
  return url.origin;
}

/** Client ID 会拼进 Basic 认证，不能含冒号或空白。 */
export function normalizeAchordConnectClientId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 191 || !/^[\x21-\x7e]+$/.test(trimmed) || trimmed.includes(":")) {
    throw new BadRequestException("Client ID 格式不正确，请从工单系统连接配置中完整复制");
  }
  return trimmed;
}

export function normalizeAchordConnectSecret(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512 || !/^[\x21-\x7e]+$/.test(trimmed)) {
    throw new BadRequestException(`${label} 格式不正确，请从工单系统连接配置中完整复制`);
  }
  return trimmed;
}

/** 原始正文解析器的匹配条件：只处理 POST 到 Webhook 路径的请求（忽略查询参数）。 */
export function isAchordConnectWebhookRequest(request: { method?: string; url?: string }) {
  return request.method === "POST" && (request.url ?? "").split("?")[0] === ACHORD_CONNECT_WEBHOOK_PATH;
}

export function buildAchordConnectWebhookUrl(siteOrigin: string) {
  return `${siteOrigin.replace(/\/+$/, "")}${ACHORD_CONNECT_WEBHOOK_PATH}`;
}

export type AchordConnectLaunchUser = { id: string; email: string; displayName: string };

/** 创建票据的请求体：用 ChordV 用户 ID 作为外部 ID，原生窗口模式，不传 returnOrigin。 */
export function buildLaunchTicketBody(user: AchordConnectLaunchUser) {
  const email = user.email.trim();
  const localPart = email.split("@")[0]?.trim() ?? "";
  const name = truncateChars(user.displayName.trim() || localPart || "ChordV 用户", USER_NAME_MAX_CHARS);
  return {
    user: { id: user.id, name, email: email || null },
    context: { theme: "system", locale: "zh-CN", launchMode: "native" }
  };
}

export async function createAchordConnectLaunchTicket(
  fetchImpl: AchordConnectFetch,
  credentials: AchordConnectCredentials,
  user: AchordConnectLaunchUser,
  timeoutMs: number
): Promise<{ launchUrl: string; expiresAt: string }> {
  const { payload } = await requestAchordConnect(fetchImpl, credentials, {
    method: "POST",
    path: LAUNCH_TICKETS_PATH,
    body: buildLaunchTicketBody(user),
    timeoutMs
  });
  const data = readRecord(readRecord(payload)?.data);
  const launchUrl = typeof data?.launchUrl === "string" ? data.launchUrl : "";
  const expiresAt = typeof data?.expiresAt === "string" ? Date.parse(data.expiresAt) : Number.NaN;
  if (!isSameOriginUrl(launchUrl, credentials.baseUrl) || !Number.isFinite(expiresAt)) {
    throw new AchordConnectRequestError("invalid_response", null, null, "launch ticket response is missing a same-origin launchUrl or a valid expiresAt");
  }
  return { launchUrl, expiresAt: new Date(expiresAt).toISOString() };
}

export type AchordConnectContactUnread = {
  unreadCount: number;
  requests: Array<{ id: string; unreadCount: number }>;
  /** 工单系统响应头 Date 给出的服务器时间（工单系统的时钟，精确到秒）；没有或无法解析时为 null。 */
  serverTime: Date | null;
};

export async function fetchAchordConnectContactUnread(
  fetchImpl: AchordConnectFetch,
  credentials: AchordConnectCredentials,
  externalUserId: string,
  timeoutMs: number
): Promise<AchordConnectContactUnread> {
  const { payload, serverTime } = await requestAchordConnect(fetchImpl, credentials, {
    method: "GET",
    path: `/api/v1/integrations/universal/contacts/${encodeURIComponent(externalUserId)}/unread`,
    timeoutMs
  });
  const data = readRecord(readRecord(payload)?.data);
  const unreadCount = readUnreadCount(data?.unreadCount);
  if (unreadCount === null) {
    throw new AchordConnectRequestError("invalid_response", null, null, "contact unread response is missing unreadCount");
  }
  const requests: AchordConnectContactUnread["requests"] = [];
  for (const item of Array.isArray(data?.requests) ? data.requests : []) {
    const record = readRecord(item);
    const id = readExternalId(record?.id);
    const count = readUnreadCount(record?.unreadCount);
    if (id && count !== null) {
      requests.push({ id, unreadCount: count });
    }
  }
  return { unreadCount, requests, serverTime };
}

async function requestAchordConnect(
  fetchImpl: AchordConnectFetch,
  credentials: AchordConnectCredentials,
  input: { method: "GET" | "POST"; path: string; body?: unknown; timeoutMs: number }
): Promise<{ payload: unknown; serverTime: Date | null }> {
  const url = new URL(input.path, credentials.baseUrl).toString();
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64")}`
  };
  if (input.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const signal = AbortSignal.timeout(input.timeoutMs);
  let response: Response;
  let text: string;
  try {
    // 不跟随跳转：带着 Basic 凭据跳到别的地址既不安全，也说明地址配置有误。
    response = await fetchImpl(url, {
      method: input.method,
      headers,
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      redirect: "manual",
      signal
    });
    text = await response.text();
  } catch (error) {
    if (signal.aborted) {
      throw new AchordConnectRequestError("timeout", null, null, `${input.method} ${input.path} timed out after ${input.timeoutMs}ms`);
    }
    throw new AchordConnectRequestError("network", null, null, `${input.method} ${input.path} failed: ${readErrorName(error)}`);
  }
  if (text.length > RESPONSE_MAX_CHARS) {
    throw new AchordConnectRequestError("invalid_response", response.status, null, `${input.method} ${input.path} response is too large`);
  }
  const payload = parseJson(text);
  if (response.status < 200 || response.status >= 300) {
    const code = readErrorCode(payload);
    throw new AchordConnectRequestError("http", response.status, code, `${input.method} ${input.path} returned HTTP ${response.status}${code ? ` ${code}` : ""}`);
  }
  const serverTimeMs = Date.parse(response.headers.get("date") ?? "");
  return { payload, serverTime: Number.isFinite(serverTimeMs) ? new Date(serverTimeMs) : null };
}

export type WebhookSignatureInput = {
  secret: string;
  rawBody: Buffer;
  timestamp: string | undefined;
  signature: string | undefined;
  nowMs?: number;
  toleranceSeconds?: number;
};

/** X-Achord-Signature: v1=<hex>，内容为 HMAC-SHA256(secret, `${timestamp}.${原始请求体}`)；时间容差 300 秒，常量时间比较。 */
export function verifyAchordConnectWebhookSignature(input: WebhookSignatureInput): boolean {
  if (!input.secret || !input.timestamp || !input.signature || !/^\d{1,12}$/.test(input.timestamp)) {
    return false;
  }
  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - Number(input.timestamp)) > (input.toleranceSeconds ?? ACHORD_CONNECT_WEBHOOK_TOLERANCE_SECONDS)) {
    return false;
  }
  const match = /^v1=([0-9a-fA-F]{64})$/.exec(input.signature.trim());
  if (!match) {
    return false;
  }
  const expected = createHmac("sha256", input.secret)
    .update(Buffer.from(`${input.timestamp}.`, "utf8"))
    .update(input.rawBody)
    .digest();
  const actual = Buffer.from(match[1], "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export type AchordConnectUnreadChange = {
  externalUserId: string;
  requestId: string;
  unreadCount: number;
  contactUnreadCount: number | null;
};

export type AchordConnectWebhookEvent = {
  /** 正文里的事件 ID，应与 X-Achord-Event-Id 一致（请求头本身不在签名范围内）。 */
  id: string | null;
  type: string;
  createdAt: Date | null;
  unreadChange: AchordConnectUnreadChange | null;
};

/** 解析已验签的 Webhook 正文；不是合法 JSON 对象时返回 null。 */
export function parseAchordConnectWebhookEvent(rawBody: Buffer): AchordConnectWebhookEvent | null {
  const envelope = readRecord(parseJson(rawBody.toString("utf8")));
  if (!envelope || typeof envelope.type !== "string" || !envelope.type) {
    return null;
  }
  const createdAtMs = typeof envelope.createdAt === "string" ? Date.parse(envelope.createdAt) : Number.NaN;
  const createdAt = Number.isFinite(createdAtMs) ? new Date(createdAtMs) : null;
  const id = typeof envelope.id === "string" ? envelope.id : null;
  if (envelope.type !== "request.unread.changed") {
    return { id, type: envelope.type.slice(0, 80), createdAt, unreadChange: null };
  }
  const data = readRecord(envelope.data);
  const externalUserId = readExternalId(data?.externalUserId);
  const requestId = readExternalId(readRecord(data?.request)?.id);
  const unreadCount = readUnreadCount(data?.unreadCount);
  // 旧版工单系统不带 contactUnreadCount；带了但不是合法数字时整条事件视为无效，避免用坏数据覆盖总数。
  const rawContact = data?.contactUnreadCount;
  const contactUnreadCount = rawContact === undefined || rawContact === null ? null : readUnreadCount(rawContact);
  const contactInvalid = rawContact !== undefined && rawContact !== null && contactUnreadCount === null;
  return {
    id,
    type: envelope.type,
    createdAt,
    unreadChange: externalUserId && requestId && unreadCount !== null && !contactInvalid
      ? { externalUserId, requestId, unreadCount, contactUnreadCount }
      : null
  };
}

function isSameOriginUrl(value: string, origin: string) {
  try {
    const url = new URL(value);
    return url.origin === origin && (url.protocol === "https:" || url.protocol === "http:");
  } catch {
    return false;
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readUnreadCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000 ? value : null;
}

function readExternalId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= EXTERNAL_ID_MAX_CHARS ? value : null;
}

function readErrorCode(payload: unknown): string | null {
  const code = readRecord(readRecord(payload)?.error)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? code : null;
}

function readErrorName(error: unknown) {
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  if (cause && typeof cause.code === "string") {
    return cause.code;
  }
  return error instanceof Error ? error.name : "unknown error";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function truncateChars(value: string, max: number) {
  const chars = Array.from(value);
  return chars.length > max ? chars.slice(0, max).join("") : value;
}
