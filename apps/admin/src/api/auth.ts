import type { AuthSessionDto } from "@chordv/shared";
import {
  clearStoredAdminSession,
  getStoredAdminRefreshToken,
  hasStoredAdminSession,
  persistAdminSessionTokens,
  request
} from "./base";

export function loginAdmin(account: string, password: string) {
  return request<AuthSessionDto>(
    "/auth/login",
    {
      method: "POST",
      body: JSON.stringify({ email: account, password })
    },
    false
  );
}

export function refreshAdminSession(refreshToken: string) {
  return request<AuthSessionDto>(
    "/auth/refresh",
    {
      method: "POST",
      body: JSON.stringify({ refreshToken })
    },
    false
  );
}

export function logoutAdminSession() {
  return request<{ ok: boolean }>("/auth/logout", {
    method: "POST"
  });
}

export function persistAdminSession(session: AuthSessionDto) {
  persistAdminSessionTokens(session);
}

export function clearAdminSession() {
  clearStoredAdminSession();
}

export function hasAdminSession() {
  return hasStoredAdminSession();
}

export function getAdminRefreshToken() {
  return getStoredAdminRefreshToken();
}
