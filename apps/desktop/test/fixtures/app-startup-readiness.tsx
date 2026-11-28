import React from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { mockBootstrap, mockNodes } from "../../../../packages/shared/src/mock";
import { App } from "../../src/App";
import { createIdleRuntimeStatus } from "../../src/lib/nativeRuntime";
import { toastContainerClassNames } from "../../src/components/Toast";
import { TOAST_AUTO_CLOSE_MS, TOAST_LIMIT, TOAST_WIDTH } from "../../src/lib/toast";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "../../src/styles.css";

// Test-only native boundary around the complete production App, never an installer.
const mode = new URLSearchParams(location.search).get("mode") ?? "no-session";
const session = (name: string) => ({
  accessToken: `test-only-access-${name}`, refreshToken: `test-only-refresh-${name}`,
  accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  refreshTokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  user: { ...mockBootstrap.user, id: `test-only-${name}`, displayName: name === "new" ? "新登录用户" : "旧会话用户" }
});
let stored: ReturnType<typeof session> | null = ["no-session", "release-unavailable", "recovery-pending", "recovery-failed", "ack-failed", "resize-failed", "resize-pending"].includes(mode) ? null : session("old");
let releaseRestore: () => void = () => {};
const restoreBarrier = new Promise<void>(resolve => { releaseRestore = resolve; });
let releaseResize: () => void = () => {};
const resizeBarrier = new Promise<void>(resolve => { releaseResize = resolve; });
const calls: string[] = [];
const acknowledgements: unknown[] = [];
const network: string[] = [];
const completedNetwork: string[] = [];
const savedSessions: unknown[] = [];
const announcements = {
  old: mockBootstrap.announcements.map(item => ({ ...item })),
  new: mockBootstrap.announcements.map(item => ({ ...item }))
};
const listeners = new Map<string, Set<(payload: unknown) => void>>();
const native = {
  platform: "macos",
  on: (name: string, handler: (payload: unknown) => void) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(handler);
    return () => listeners.get(name)?.delete(handler);
  },
  call: async (_method: string, command: string, payload: any) => {
    calls.push(command);
    switch (command) {
      case "consume_desktop_update_install_report":
        if (mode === "recovery-failed") return { ok: false, recoveryPending: true, platform: "macos", mode: "replace", summary: "更新失败，原版本已保留。" };
        return mode === "recovery-pending" ? { state: "pending_recovery" } : null;
      case "runtime_status": return createIdleRuntimeStatus("macos");
      case "runtime_snapshot": return { runtime: null };
      case "desktop_os_label": return "macOS test-only";
      case "load_session": return stored;
      case "save_session": stored = payload.session; savedSessions.push(stored); return { ok: true };
      case "clear_session": stored = null; return { ok: true };
      case "refresh_session_native": return stored;
      case "transition_main_window":
        if (mode === "resize-failed") throw new Error("test-only native resize failure");
        if (mode === "resize-pending") await resizeBarrier;
        return null;
      case "app_ready": {
        const root = document.querySelector(".desktop-app");
        const field = document.querySelector<HTMLInputElement>('input[aria-label="邮箱"]');
        acknowledgements.push({ payload, loginCommitted: Boolean(root?.querySelector(".auth-screen form")), emailEnabled: Boolean(field && !field.disabled) });
        if (mode === "ack-failed") throw new Error("test-only native readiness rejection");
        return { ok: true };
      }
      case "release_configuration": return { repository: "", publicKey: "", buildMode: "local", apiBase: "http://127.0.0.1:9" };
      case "api_request": {
        const request = payload.request;
        const path = (request.path.startsWith("/api/") ? request.path : "/api" + request.path).split("?")[0];
        network.push(path);
        if (path === "/api/auth/login") return { status: 200, body: JSON.stringify(session("new")), elapsedMs: 0 };
        const old = request.headers?.Authorization === "Bearer test-only-access-old";
        if (old && ["/api/client/bootstrap", "/api/client/nodes"].includes(path)) {
          await restoreBarrier;
          completedNetwork.push(path);
        }
        if (path === "/api/client/bootstrap") {
          const owner = old ? session("old") : session("new");
          return { status: 200, body: JSON.stringify({ ...mockBootstrap, version: mode === "release-unavailable" ? null : mockBootstrap.version, user: owner.user, announcements: announcements[old ? "old" : "new"] }), elapsedMs: 0 };
        }
        if (path === "/api/client/nodes") return { status: 200, body: JSON.stringify(mockNodes), elapsedMs: 0 };
        if (path === "/api/client/announcements") return { status: 200, body: JSON.stringify(announcements[old ? "old" : "new"]), elapsedMs: 0 };
        if (path === "/api/client/announcements/read") {
          const input = JSON.parse(request.body);
          const key = old ? "old" : "new";
          announcements[key] = announcements[key].map(item => !input.announcementIds.includes(item.id) ? item : {
            ...item,
            ...(input.action === "ack" ? { acknowledgedAt: new Date().toISOString(), isUnread: false }
              : { passiveSeenAt: new Date().toISOString(), isUnread: item.displayMode === "passive" ? false : item.isUnread })
          });
          return { status: 200, body: JSON.stringify({ ok: true, updatedIds: input.announcementIds }), elapsedMs: 0 };
        }
        if (path === "/api/client/subscription") return { status: 200, body: JSON.stringify(mockBootstrap.subscription), elapsedMs: 0 };
        return { status: 200, body: "{}", elapsedMs: 0 };
      }
      case "probe_nodes": return [];
      case "check_runtime_component_file": return { exists: false, valid: false, path: "/test-only/missing" };
      case "get_runtime_component_local_info": return { exists: false, valid: false };
      default: return { ok: true };
    }
  }
};
Object.assign(window, { mygo: native, startupReadinessFixture: { calls, acknowledgements, network, completedNetwork, savedSessions, releaseRestore, releaseResize, stored: () => stored } });

createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={{ primaryColor: "cyan" }}>
    <Notifications position="top-right" autoClose={TOAST_AUTO_CLOSE_MS} limit={TOAST_LIMIT}
      containerWidth={TOAST_WIDTH} classNames={toastContainerClassNames} />
    <App />
  </MantineProvider>
);
