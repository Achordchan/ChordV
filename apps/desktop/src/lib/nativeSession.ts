import type { AuthSessionDto } from "@chordv/shared";
import { isNativeDesktop, listenNative as listen } from "./nativeBridge";
import { isAndroidPlatform, loadInvoke } from "./nativeEnvironment";

export type NativeLeaseHeartbeatEvent = {
  sessionId: string;
  status: "ok" | "error";
  terminal: boolean;
  leaseExpiresAt: string | null;
  reasonCode: string | null;
  message: string | null;
};

export type NativeSessionRefreshEvent = AuthSessionDto & { previousRefreshToken: string };

export async function subscribeNativeLeaseHeartbeat(handler: (event: NativeLeaseHeartbeatEvent) => void) {
  if (!isNativeDesktop() || isAndroidPlatform()) {
    return () => {};
  }
  const unlisten = await listen<NativeLeaseHeartbeatEvent>("chordv://native-lease-heartbeat", (event) => {
    if (event.payload) {
      handler(event.payload);
    }
  });
  return () => {
    unlisten();
  };
}

export async function subscribeNativeSessionRefreshed(handler: (session: NativeSessionRefreshEvent) => void) {
  if (!isNativeDesktop() || isAndroidPlatform()) {
    return () => {};
  }
  const unlisten = await listen<NativeSessionRefreshEvent>("chordv://native-session-refreshed", (event) => {
    if (event.payload) {
      handler(event.payload);
    }
  });
  return () => {
    unlisten();
  };
}

export async function loadStoredSession(): Promise<AuthSessionDto | null> {
  const invoke = await loadInvoke();
  if (!invoke) {
    return null;
  }

  return invoke("load_session");
}

export async function saveStoredSession(session: AuthSessionDto) {
  const invoke = await loadInvoke();
  if (!invoke) {
    return { ok: false, available: false };
  }

  return invoke("save_session", { session });
}

export async function refreshStoredSessionNative(refreshToken?: string | null) {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform()) {
    return null;
  }

  return invoke<AuthSessionDto>("refresh_session_native", {
    refreshToken: refreshToken ?? null
  });
}

export async function clearStoredSession() {
  const invoke = await loadInvoke();
  if (!invoke) {
    return { ok: false, available: false };
  }

  return invoke("clear_session");
}
