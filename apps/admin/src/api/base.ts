const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";
export const ADMIN_ACCESS_TOKEN_KEY = "chordv_admin_access_token";
export const ADMIN_REFRESH_TOKEN_KEY = "chordv_admin_refresh_token";

export async function request<T>(path: string, init?: RequestInit, useAuth = true) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 15000);
  let response: Response;

  const adminAccessToken = useAuth
    ? localStorage.getItem(ADMIN_ACCESS_TOKEN_KEY) ?? import.meta.env.VITE_ADMIN_ACCESS_TOKEN ?? ""
    : "";

  try {
    response = await fetch(`${API_BASE}/api${path}`, {
      ...init,
      signal: init?.signal ?? controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(adminAccessToken ? { Authorization: `Bearer ${adminAccessToken}` } : {}),
        ...(init?.headers ?? {})
      }
    });
  } finally {
    window.clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}
