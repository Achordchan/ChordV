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
};

export type RefreshDesktopSessionWithFallbackOptions = {
  refreshToken: string;
  refreshSession?: typeof refreshSessionRequest;
  refreshSessionNative?: typeof refreshStoredSessionNativeRuntime;
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
    refreshSessionNative = refreshStoredSessionNativeRuntime
  } = options;

  try {
    const refreshed = await refreshSessionNative(refreshToken);
    if (refreshed) {
      return refreshed;
    }
  } catch {
    // 原生刷新失败时回退到 HTTP refresh。
  }

  return refreshSession(refreshToken);
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
    loadStoredSession = loadStoredSessionRuntime
  } = options;

  if (taskRef.current) {
    return taskRef.current;
  }

  if (!currentSession?.refreshToken) {
    await clearSession(true);
    return null;
  }

  const task = (async () => {
    try {
      const refreshed = await refreshDesktopSessionWithFallback({
        refreshToken: currentSession.refreshToken,
        refreshSession,
        refreshSessionNative
      });
      await saveStoredSession(refreshed);
      const bootstrapped = await bootstrapSession(refreshed);
      if (bootstrapped) {
        return refreshed;
      }
      const persistedSession = await loadStoredSession().catch(() => null);
      return persistedSession?.accessToken === refreshed.accessToken ? refreshed : null;
    } catch (reason) {
      if (isUnauthorizedApiError(reason) || isForbiddenApiError(reason)) {
        await clearSession(true);
        return null;
      }
      return currentSession;
    } finally {
      taskRef.current = null;
    }
  })();

  taskRef.current = task;
  return task;
}
