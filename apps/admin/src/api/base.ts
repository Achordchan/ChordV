const RAW_API_BASE = import.meta.env.VITE_API_BASE_URL;
const API_BASE =
  typeof RAW_API_BASE === "string" && RAW_API_BASE.trim().length > 0
    ? RAW_API_BASE.trim().replace(/\/+$/, "")
    : window.location.origin;
export const ADMIN_ACCESS_TOKEN_KEY = "chordv_admin_access_token";
export const ADMIN_REFRESH_TOKEN_KEY = "chordv_admin_refresh_token";
export const ADMIN_SESSION_EXPIRED_EVENT = "chordv:admin-session-expired";
export const ADMIN_SESSION_EXPIRED_MESSAGE = "登录态已失效，请重新登录";

type RequestOptions = RequestInit & {
  timeoutMs?: number;
};

type AuthSessionResponse = {
  accessToken: string;
  refreshToken: string;
  user?: {
    role?: string;
  } | null;
};

let refreshPromise: Promise<string | null> | null = null;

export function getStoredAdminAccessToken() {
  return localStorage.getItem(ADMIN_ACCESS_TOKEN_KEY) ?? import.meta.env.VITE_ADMIN_ACCESS_TOKEN ?? "";
}

export function getStoredAdminRefreshToken() {
  return localStorage.getItem(ADMIN_REFRESH_TOKEN_KEY) ?? "";
}

export function persistAdminSessionTokens(session: Pick<AuthSessionResponse, "accessToken" | "refreshToken">) {
  localStorage.setItem(ADMIN_ACCESS_TOKEN_KEY, session.accessToken);
  localStorage.setItem(ADMIN_REFRESH_TOKEN_KEY, session.refreshToken);
}

export function clearStoredAdminSession(options?: { notify?: boolean }) {
  localStorage.removeItem(ADMIN_ACCESS_TOKEN_KEY);
  localStorage.removeItem(ADMIN_REFRESH_TOKEN_KEY);
  if (options?.notify) {
    window.dispatchEvent(new CustomEvent(ADMIN_SESSION_EXPIRED_EVENT));
  }
}

export function hasStoredAdminSession() {
  return Boolean(getStoredAdminAccessToken() || getStoredAdminRefreshToken());
}

export function isAdminSessionExpiredMessage(message: string) {
  return (
    message.includes("缺少访问令牌") ||
    message.includes("访问令牌无效") ||
    message.includes("登录态已失效")
  );
}

function isAccessTokenError(status: number, message: string) {
  return (
    status === 401 ||
    isAdminSessionExpiredMessage(message)
  );
}

async function requestOnce(path: string, init?: RequestOptions, useAuth = true, accessTokenOverride?: string) {
  const controller = new AbortController();
  const timeoutMs = init?.timeoutMs ?? 15000;
  const timer = window.setTimeout(() => controller.abort(new Error("请求超时")), timeoutMs);
  const adminAccessToken = useAuth ? accessTokenOverride ?? getStoredAdminAccessToken() : "";
  const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData;

  try {
    return await fetch(`${API_BASE}/api${path}`, {
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
}

async function refreshAdminAccessToken() {
  if (refreshPromise) {
    return refreshPromise;
  }

  const refreshToken = getStoredAdminRefreshToken();
  if (!refreshToken) {
    return null;
  }

  refreshPromise = (async () => {
    try {
      const response = await requestOnce(
        "/auth/refresh",
        {
          method: "POST",
          body: JSON.stringify({ refreshToken })
        },
        false
      );

      if (!response.ok) {
        clearStoredAdminSession();
        return null;
      }

      const session = (await response.json()) as AuthSessionResponse;
      if (!session?.accessToken || !session?.refreshToken || session.user?.role !== "admin") {
        clearStoredAdminSession();
        return null;
      }

      persistAdminSessionTokens(session);
      return session.accessToken;
    } catch {
      clearStoredAdminSession();
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

export async function request<T>(path: string, init?: RequestOptions, useAuth = true) {
  let response = await requestOnce(path, init, useAuth);

  if (!response.ok) {
    const text = await response.text();
    if (useAuth && isAccessTokenError(response.status, text)) {
      const refreshedAccessToken = await refreshAdminAccessToken();
      if (refreshedAccessToken) {
        response = await requestOnce(path, init, useAuth, refreshedAccessToken);
      } else {
        clearStoredAdminSession({ notify: true });
        throw new Error(ADMIN_SESSION_EXPIRED_MESSAGE);
      }
    } else {
      throw new Error(text || `HTTP ${response.status}`);
    }
  }

  if (!response.ok) {
    const text = await response.text();
    if (useAuth && isAccessTokenError(response.status, text)) {
      clearStoredAdminSession({ notify: true });
      throw new Error(ADMIN_SESSION_EXPIRED_MESSAGE);
    }
    throw new Error(text || `HTTP ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}
