import { invokeNative, isNativeDesktop } from "../lib/nativeBridge";
import { resolveClientApiBase } from "../lib/localEndpoint";

export const API_BASE = readApiBaseUrl();

const JSON_REQUEST_TIMEOUT_MS = 60_000;

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

export async function requestWithMeta<T>(path: string, init?: RequestInit): Promise<RequestResult<T>> {
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

  return requestBrowserWithMeta<T>(API_BASE, path, init);
}

export async function requestBrowserWithMeta<T>(apiBase: string, path: string, init?: RequestInit, timeoutMs = JSON_REQUEST_TIMEOUT_MS): Promise<RequestResult<T>> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("请求超时配置无效");
  const startedAt = performance.now();
  const controller = new AbortController();
  const external = init?.signal;
  const cancel = () => controller.abort(external?.reason);
  if (external?.aborted) cancel();
  else external?.addEventListener("abort", cancel, { once: true });
  const timeout = globalThis.setTimeout(() => controller.abort(new Error("请求超时")), timeoutMs);
  try {
    const response = await fetch(`${apiBase}/api${path}`, {
      ...init,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...normalizeHeaders(init?.headers) }
    });
    const body = await response.text();
    if (!response.ok) throw createApiRequestError(path, response.status, body);
    return {
      data: body ? JSON.parse(body) as T : {} as T,
      status: response.status,
      elapsedMs: Math.max(0, Math.round(performance.now() - startedAt))
    };
  } catch (error) {
    if (external?.aborted) {
      throw external.reason instanceof Error ? external.reason : new DOMException("请求已取消", "AbortError");
    }
    throw normalizeNetworkRequestError(error);
  } finally {
    globalThis.clearTimeout(timeout);
    external?.removeEventListener("abort", cancel);
  }
}

export async function request<T>(path: string, init?: RequestInit) {
  const result = await requestWithMeta<T>(path, init);
  return result.data;
}

function readApiBaseUrl() {
  const env = (import.meta as ImportMeta & { env?: { VITE_API_BASE_URL?: string; VITE_CHORDV_BUILD_MODE?: string } }).env;
  return resolveClientApiBase(env?.VITE_API_BASE_URL, env?.VITE_CHORDV_BUILD_MODE === "release");
}

function normalizeNetworkRequestError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/AbortError|请求超时|timeout|timed out/i.test(message)) {
    return new ApiRequestError(null, "请求超时，请检查网络后重试。", message);
  }
  if (/Failed to fetch|NetworkError|fetch failed|Load failed/i.test(message)) {
    return new ApiRequestError(null, "网络连接失败，请检查网络后重试。", message);
  }
  return error;
}

async function loadNativeInvoke(): Promise<NativeInvoke | null> {
  return isNativeDesktop() ? invokeNative as NativeInvoke : null;
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

export function createApiRequestError(path: string, status: number | null, rawMessage: string | null | undefined) {
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
  if (typeof reason === "string") {
    return reason;
  }
  return "";
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

function normalizeElapsedMs(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.round(value);
}
