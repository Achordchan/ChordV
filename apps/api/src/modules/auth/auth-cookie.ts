import type { Response } from "express";

export const ADMIN_REFRESH_COOKIE_NAME = "chordv_admin_refresh";

export function setRefreshCookie(response: Response | undefined, refreshToken: string, refreshTokenExpiresAt: string) {
  response?.setHeader("Set-Cookie", buildRefreshCookie(encodeURIComponent(refreshToken), new Date(refreshTokenExpiresAt)));
}

export function clearRefreshCookie(response: Response | undefined) {
  response?.setHeader("Set-Cookie", buildRefreshCookie("", new Date(0)));
}

export function readCookie(cookieHeader: string | undefined, name: string) {
  const pair = cookieHeader
    ?.split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`));
  if (!pair) {
    return "";
  }
  try {
    return decodeURIComponent(pair.slice(name.length + 1));
  } catch {
    return "";
  }
}

function buildRefreshCookie(value: string, expires: Date) {
  const secure = process.env.NODE_ENV === "production" || (process.env.CHORDV_AUTH_COOKIE_SECURE ?? "false").toLowerCase() === "true";
  const sameSite = process.env.CHORDV_AUTH_COOKIE_SAMESITE ?? "Lax";
  return [
    `${ADMIN_REFRESH_COOKIE_NAME}=${value}`,
    "Path=/api/auth",
    "HttpOnly",
    `SameSite=${sameSite}`,
    `Expires=${expires.toUTCString()}`,
    secure ? "Secure" : ""
  ].filter(Boolean).join("; ");
}
