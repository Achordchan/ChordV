import type { AuthSessionDto, UpdateCurrentAdminSecurityInputDto } from "@chordv/shared";
import {
  clearStoredAdminSession,
  getStoredAdminProfile,
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

export function updateCurrentAdminSecurity(input: UpdateCurrentAdminSecurityInputDto) {
  return request<AuthSessionDto>("/admin/me/security", {
    method: "PUT",
    body: JSON.stringify(input)
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
