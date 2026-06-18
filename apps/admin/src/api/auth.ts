import type { AdminSecurityUpdateResultDto, AuthSessionDto, UpdateCurrentAdminSecurityInputDto } from "@chordv/shared";
import {
  clearStoredAdminSession,
  getStoredAdminProfile,
  getStoredAdminRefreshToken,
  hasStoredAdminSession,
  persistAdminSessionTokens,
  request
} from "./base";

const ADMIN_ACTION_TIMEOUT_MS = 60 * 1000;

export function loginAdmin(account: string, password: string) {
  return request<AuthSessionDto>(
    "/auth/admin/login",
    {
      method: "POST",
      body: JSON.stringify({ email: account, password })
    },
    false
  );
}

export function refreshAdminSession(refreshToken?: string) {
  return request<AuthSessionDto>(
    "/auth/refresh",
    {
      method: "POST",
      body: JSON.stringify(refreshToken ? { refreshToken } : {})
    },
    false
  );
}

export function logoutAdminSession() {
  return request<{ ok: boolean }>("/auth/logout", {
    method: "POST",
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
}

export function updateCurrentAdminSecurity(input: UpdateCurrentAdminSecurityInputDto) {
  return request<AdminSecurityUpdateResultDto>("/admin/me/security", {
    method: "PUT",
    body: JSON.stringify(input),
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
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

export function getAdminProfile() {
  return getStoredAdminProfile();
}
