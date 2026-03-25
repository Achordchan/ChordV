import type { AuthSessionDto } from "@chordv/shared";
import { refreshSession as refreshSessionRequest } from "../api/client";
import { saveStoredSession as saveStoredSessionRuntime } from "./runtime";

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
  saveStoredSession?: typeof saveStoredSessionRuntime;
};

export async function recoverDesktopSessionAfterUnauthorized(
  options: RecoverDesktopSessionAfterUnauthorizedOptions
) {
  const {
    taskRef,
    currentSession,
    bootstrapSession,
    clearSession,
    refreshSession = refreshSessionRequest,
    saveStoredSession = saveStoredSessionRuntime
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
      const refreshed = await refreshSession(currentSession.refreshToken);
      await saveStoredSession(refreshed);
      const bootstrapped = await bootstrapSession(refreshed);
      return bootstrapped ? refreshed : null;
    } catch {
      await clearSession(true);
      return null;
    } finally {
      taskRef.current = null;
    }
  })();

  taskRef.current = task;
  return task;
}
