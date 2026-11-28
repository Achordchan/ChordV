import type { AnnouncementDto, AuthSessionDto, ClientBootstrapDto, ClientSupportLaunchContextDto, ClientSupportLaunchDto, ClientSupportStatusDto, PlatformTarget, SubscriptionStatusDto } from "@chordv/shared";
import { request, requestWithMeta } from "./http";
import { APP_BUILD_NUMBER } from "../lib/buildInfo";
import { resolveDesktopPlatformVersion } from "../lib/platformVersion";

export function login(email: string, password: string) {
  return request<AuthSessionDto>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });
}

export async function probeClientServerLatency(accessToken?: string) {
  const platform = detectUpdatePlatform();
  const params = new URLSearchParams({ platform, version: resolveDesktopPlatformVersion(platform) });
  if (APP_BUILD_NUMBER !== null) params.set("build", String(APP_BUILD_NUMBER));
  try { params.set("channel", localStorage.getItem("chordv_update_channel") === "beta" ? "beta" : "stable"); }
  catch { params.set("channel", "stable"); }
  const result = await requestWithMeta<{ ok: boolean; serverTime: string | null }>(`/client/ping?${params}`, {
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined
  });
  return {
    ok: true,
    serverTime: result.data.serverTime,
    elapsedMs: result.elapsedMs
  };
}

export function refreshSession(refreshToken: string) {
  return request<AuthSessionDto>("/auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refreshToken })
  });
}

export function logoutSession(accessToken: string, refreshToken?: string | null) {
  return request<{ ok: boolean }>("/auth/logout", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({ refreshToken: refreshToken ?? null })
  });
}

export function fetchBootstrap(accessToken: string, platform: PlatformTarget | "ios" = detectUpdatePlatform()) {
  return request<ClientBootstrapDto>(`/client/bootstrap?platform=${encodeURIComponent(platform)}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
}

export function fetchAnnouncements(accessToken: string) {
  return request<AnnouncementDto[]>("/client/announcements", {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
}

export function markAnnouncementsRead(
  accessToken: string,
  input: {
    announcementIds: string[];
    action: "seen" | "ack";
  }
) {
  return request<{ ok: boolean; updatedIds?: string[] }>("/client/announcements/read", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify(input)
  });
}

export function fetchSubscription(accessToken: string) {
  return request<SubscriptionStatusDto>("/client/subscription", {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
}

/** 兼容旧后台缺少工单接口的情况，打开流程会给出明确说明和客服入口。 */
export function fetchSupportStatus(accessToken: string) {
  return request<ClientSupportStatusDto>("/client/support/status", {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
}

/**
 * 返回一次性打开地址（票据在 URL 片段里，60 秒内有效）：只用于立即打开工单窗口，不能写进任何日志。
 * context 是附带给客服的诊断信息（见 lib/supportContext.ts）；收集失败时不传，后台按旧版客户端处理。
 */
export function launchSupportPortal(accessToken: string, context?: ClientSupportLaunchContextDto | null) {
  return request<ClientSupportLaunchDto>("/client/support/launch", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    ...(context ? { body: JSON.stringify({ context }) } : {})
  });
}

function detectUpdatePlatform(): PlatformTarget | "ios" {
  if (/android/i.test(window.navigator.userAgent)) {
    return "android";
  }
  if (/iphone|ipad|ipod/i.test(window.navigator.userAgent)) {
    return "ios";
  }
  if (/windows/i.test(window.navigator.userAgent)) {
    return "windows";
  }
  return "macos";
}
