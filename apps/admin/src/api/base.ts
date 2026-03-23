const RAW_API_BASE = import.meta.env.VITE_API_BASE_URL;
const API_BASE =
  typeof RAW_API_BASE === "string" && RAW_API_BASE.trim().length > 0
    ? RAW_API_BASE.trim().replace(/\/+$/, "")
    : window.location.origin;
export const ADMIN_ACCESS_TOKEN_KEY = "chordv_admin_access_token";
export const ADMIN_REFRESH_TOKEN_KEY = "chordv_admin_refresh_token";

type RequestOptions = RequestInit & {
  timeoutMs?: number;
};

export async function request<T>(path: string, init?: RequestOptions, useAuth = true) {
  const controller = new AbortController();
  const timeoutMs = init?.timeoutMs ?? 15000;
  const timer = window.setTimeout(() => controller.abort(new Error("请求超时")), timeoutMs);
  let response: Response;

  const adminAccessToken = useAuth
    ? localStorage.getItem(ADMIN_ACCESS_TOKEN_KEY) ?? import.meta.env.VITE_ADMIN_ACCESS_TOKEN ?? ""
    : "";

  const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData;
  try {
    response = await fetch(`${API_BASE}/api${path}`, {
      ...init,
      signal: init?.signal ?? controller.signal,
      headers: {
        ...(adminAccessToken ? { Authorization: `Bearer ${adminAccessToken}` } : {}),
        ...(!isFormData ? { "Content-Type": "application/json" } : {}),
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
