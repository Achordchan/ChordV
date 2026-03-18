import type {
  AuthSessionDto,
  ClientBootstrapDto,
  ConnectionMode,
  GeneratedRuntimeConfigDto,
  NodeSummaryDto
} from "@chordv/shared";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";

async function request<T>(path: string, init?: RequestInit) {
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

export function logoutSession() {
  return request<{ ok: boolean }>("/auth/logout", {
    method: "POST"
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

export function disconnectSession(accessToken: string) {
  return request<{ ok: boolean; previousSessionId: string | null }>("/client/session/disconnect", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
}
