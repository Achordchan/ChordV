import type { AuthSessionDto } from "@chordv/shared";
import { ADMIN_ACCESS_TOKEN_KEY, ADMIN_REFRESH_TOKEN_KEY, request } from "./base";

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
  localStorage.setItem(ADMIN_ACCESS_TOKEN_KEY, session.accessToken);
  localStorage.setItem(ADMIN_REFRESH_TOKEN_KEY, session.refreshToken);
}

export function clearAdminSession() {
  localStorage.removeItem(ADMIN_ACCESS_TOKEN_KEY);
  localStorage.removeItem(ADMIN_REFRESH_TOKEN_KEY);
}

export function hasAdminSession() {
  const adminAccessToken = localStorage.getItem(ADMIN_ACCESS_TOKEN_KEY) ?? import.meta.env.VITE_ADMIN_ACCESS_TOKEN ?? "";
  return Boolean(adminAccessToken);
}

export function getAdminRefreshToken() {
  return localStorage.getItem(ADMIN_REFRESH_TOKEN_KEY) ?? "";
}
