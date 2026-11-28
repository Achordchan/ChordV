import type { AuthSessionDto } from "@chordv/shared";
import {
  isForbiddenApiError,
  isUnauthorizedApiError,
  refreshSession as refreshSessionRequest
} from "../api/client";
import {
  loadStoredSession as loadStoredSessionRuntime,
  refreshStoredSessionNative as refreshStoredSessionNativeRuntime,
  saveStoredSession as saveStoredSessionRuntime
} from "./runtime";

export type UnauthorizedRecoveryTaskRef = {
  current: Promise<AuthSessionDto | null> | null;
  scope?: string | null;
};

export type DesktopUnauthorizedRecoveryRunner = (session: AuthSessionDto) => Promise<boolean>;
export type DesktopUnauthorizedSessionCleaner = (stopRuntime?: boolean) => Promise<void>;

export type RecoverDesktopSessionAfterUnauthorizedOptions = {
  taskRef: UnauthorizedRecoveryTaskRef;
  currentSession: AuthSessionDto | null;
  bootstrapSession: DesktopUnauthorizedRecoveryRunner;
  clearSession: DesktopUnauthorizedSessionCleaner;
  refreshSession?: typeof refreshSessionRequest;
  refreshSessionNative?: typeof refreshStoredSessionNativeRuntime;
  saveStoredSession?: typeof saveStoredSessionRuntime;
  loadStoredSession?: typeof loadStoredSessionRuntime;
  isCurrent?: () => boolean;
  scope?: string;
};

export type RefreshDesktopSessionWithFallbackOptions = {
  refreshToken: string;
  refreshSession?: typeof refreshSessionRequest;
  refreshSessionNative?: typeof refreshStoredSessionNativeRuntime;
  isCurrent?: () => boolean;
};

const PROACTIVE_ACCESS_TOKEN_REFRESH_SAFETY_WINDOW_MS = 2 * 60 * 1000;

export function resolveProactiveAccessTokenRefreshDelay(
  session: Pick<AuthSessionDto, "refreshToken" | "accessTokenExpiresAt"> | null,
  nowMs = Date.now()
) {
  if (!session?.refreshToken) {
    return null;
  }

  const expiresAtMs = Date.parse(session.accessTokenExpiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return null;
  }

  return Math.max(0, expiresAtMs - nowMs - PROACTIVE_ACCESS_TOKEN_REFRESH_SAFETY_WINDOW_MS);
}

export async function refreshDesktopSessionWithFallback(
  options: RefreshDesktopSessionWithFallbackOptions
) {
  const {
    refreshToken,
    refreshSession = refreshSessionRequest,
    refreshSessionNative = refreshStoredSessionNativeRuntime,
    isCurrent = () => true
  } = options;

  if (!isCurrent()) throw new Error("登录操作已变化");
  try {
    const refreshed = await refreshSessionNative(refreshToken);
    if (!isCurrent()) throw new Error("登录操作已变化");
    if (refreshed) {
      return refreshed;
    }
  } catch {
    if (!isCurrent()) throw new Error("登录操作已变化");
    // 原生刷新失败时回退到 HTTP refresh。
  }

  if (!isCurrent()) throw new Error("登录操作已变化");
  const refreshed = await refreshSession(refreshToken);
  if (!isCurrent()) throw new Error("登录操作已变化");
  return refreshed;
}

export async function recoverDesktopSessionAfterUnauthorized(
  options: RecoverDesktopSessionAfterUnauthorizedOptions
) {
  const {
    taskRef,
    currentSession,
    bootstrapSession,
    clearSession,
    refreshSession = refreshSessionRequest,
    refreshSessionNative = refreshStoredSessionNativeRuntime,
    saveStoredSession = saveStoredSessionRuntime,
    loadStoredSession = loadStoredSessionRuntime,
    isCurrent = () => true,
    scope = JSON.stringify([currentSession?.user.id, currentSession?.refreshToken])
  } = options;

  if (!isCurrent()) return null;
  if (taskRef.current && taskRef.scope === scope) {
    return taskRef.current;
  }

  if (!currentSession?.refreshToken) {
    await clearSession(true);
    return null;
  }

  const task: Promise<AuthSessionDto | null> = Promise.resolve().then(async () => {
    try {
      const refreshed = await refreshDesktopSessionWithFallback({
        refreshToken: currentSession.refreshToken,
        refreshSession,
        refreshSessionNative,
        isCurrent
      });
      if (!isCurrent()) return null;
      await saveStoredSession(refreshed);
      if (!isCurrent()) return null;
      const bootstrapped = await bootstrapSession(refreshed);
      if (!isCurrent()) return null;
      if (bootstrapped) {
        return refreshed;
      }
      const persistedSession = await loadStoredSession().catch(() => null);
      if (!isCurrent()) return null;
      return persistedSession?.accessToken === refreshed.accessToken ? refreshed : null;
    } catch (reason) {
      if (!isCurrent()) return null;
      if (isUnauthorizedApiError(reason) || isForbiddenApiError(reason)) {
        await clearSession(true);
        return null;
      }
      return currentSession;
    } finally {
      if (taskRef.current === task) {
        taskRef.current = null;
        taskRef.scope = null;
      }
    }
  });

  taskRef.current = task;
  taskRef.scope = scope;
  return task;
}
