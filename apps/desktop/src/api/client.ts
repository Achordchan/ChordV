import type {
  AuthSessionDto,
  ClientBootstrapDto,
  ConnectionMode,
  GeneratedRuntimeConfigDto,
  NodeSummaryDto,
  SessionLeaseStatusDto,
  SubscriptionStatusDto
} from "@chordv/shared";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";
type NativeInvoke = (command: string, payload?: unknown) => Promise<{ status: number; body: string }>;

async function request<T>(path: string, init?: RequestInit) {
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
    if (!response.body) {
      return {} as T;
    }
    return JSON.parse(response.body) as T;
  }

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

  return response.json() as Promise<T>;
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

export function fetchNodes(accessToken: string) {
  return request<NodeSummaryDto[]>("/client/nodes", {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
}

export function fetchSubscription(accessToken: string) {
  return request<SubscriptionStatusDto>("/client/subscription", {
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
