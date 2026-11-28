import React from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { mockBootstrap, mockNodes, mockRuntimeConfig } from "../../../../packages/shared/src/mock";
import { App } from "../../src/App";
import { createIdleRuntimeStatus } from "../../src/lib/nativeRuntime";
import { toastContainerClassNames } from "../../src/components/Toast";
import { TOAST_AUTO_CLOSE_MS, TOAST_LIMIT, TOAST_WIDTH } from "../../src/lib/toast";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "../../src/styles.css";

// Test-only native/HTTP boundaries around the complete App; never touches host proxy or disk credentials.
const platform = new URLSearchParams(location.search).get("platform") === "web" ? "web" : "macos";
const config = { ...mockRuntimeConfig(mockNodes[0].id), leaseHeartbeatIntervalSeconds: 5, leaseGraceSeconds: 30 };
const session = {
  accessToken: "test-only-access", refreshToken: "test-only-refresh",
  accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
  refreshTokenExpiresAt: new Date(Date.now() + 86400_000).toISOString(),
  user: { ...mockBootstrap.user, id: "test-only-user", displayName: "心跳测试用户" }
};
const freshSession = { ...session, accessToken: "test-only-new-access", refreshToken: "test-only-new-refresh",
  user: { ...session.user, id: "test-only-new-user", displayName: "新登录用户" } };
const rotatedSession = { ...session, accessToken: "test-only-old-rotated-access", refreshToken: "test-only-old-rotated-refresh" };
let releaseRefresh: () => void = () => {}, refreshOutcome = "success";
let refreshBarrier = Promise.resolve(), completedRefreshes = 0;
let stored: typeof session | null = session;
let connected = true, heartbeat = "active", renewals = 0, releases: Array<() => void> = [];
const runtimeStatus = () => ({ ...createIdleRuntimeStatus(platform), ...(connected ? { status: "connected", activeSessionId: config.sessionId,
  activeNodeId: config.node.id, activePid: 12345, vpnActive: true } : {}) });
let activeStream = "";
let announcements: Array<{ id: string; title: string; body: string; publishedAt: string; displayMode: string; countdownSeconds: number }> = [];
const calls: string[] = [], network: string[] = [];
const listeners = new Map<string, Set<(payload: unknown) => void>>();
const emit = (name: string, payload: unknown) => listeners.get("native-event")?.forEach(handler => handler({ name, payload }));
const reply = (status: number, value: unknown) => ({ status, body: JSON.stringify(value), elapsedMs: 0 });
const native = {
  platform,
  on: (name: string, handler: (payload: unknown) => void) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(handler);
    return () => listeners.get(name)?.delete(handler);
  },
  call: async (_method: string, command: string, payload: any) => {
    calls.push(command);
    switch (command) {
      case "runtime_status": return runtimeStatus();
      case "runtime_snapshot": return { runtime: connected ? config : null };
      case "disconnect_runtime": connected = false; emit("chordv://runtime-status", runtimeStatus()); return { ok: true };
      case "runtime_logs": return { log: "" };
      case "desktop_os_label": return "macOS test-only";
      case "load_session": return stored;
      case "save_session": stored = payload.session; return { ok: true };
      case "clear_session": stored = null; return { ok: true };
      case "refresh_session_native":
        if ((heartbeat === "refresh-outage" || heartbeat === "refresh-pending") && payload.refreshToken === session.refreshToken) throw new Error("test-only refresh network failure");
        return stored;
      case "start_client_event_stream": {
        const streamId = activeStream = payload.input.streamId;
        queueMicrotask(() => emit("chordv://client-runtime-event-open", { streamId }));
        return { streamId };
      }
      case "release_configuration": return { repository: "", publicKey: "", buildMode: "local", apiBase: "http://127.0.0.1:9" };
      case "api_request": {
        const request = payload.request;
        const path = (request.path.startsWith("/api/") ? request.path : "/api" + request.path).split("?")[0];
        network.push(path);
        if (path === "/api/client/session/heartbeat") {
          renewals++;
          const responseMode = heartbeat;
          if (responseMode === "pending") await new Promise<void>(resolve => releases.push(resolve));
          if (responseMode === "transient") return reply(503, { message: "当前连接已过期，请重新连接" });
          if (responseMode === "refresh-outage" || responseMode === "refresh-pending") return reply(401, { message: "access token expired" });
          const protectedReason = responseMode === "account_disabled" || responseMode === "team_access_revoked";
          return reply(200, { sessionId: config.sessionId, status: responseMode === "expired" ? "expired" : protectedReason ? "revoked" : "active",
            leaseExpiresAt: new Date(Date.now() + 1800_000).toISOString(),
            ...(responseMode === "expired" ? { reasonCode: "session_expired", reasonMessage: "当前连接已过期，请重新连接。" } : {}),
            ...(protectedReason ? { reasonCode: responseMode, reasonMessage: "访问已撤销" } : {}) });
        }
        if (path === "/api/auth/refresh") {
          const token = JSON.parse(request.body).refreshToken;
          if (token === freshSession.refreshToken) return reply(200, freshSession);
          if (token !== session.refreshToken) return reply(401, { message: "test-only unknown refresh" });
          if (heartbeat === "refresh-outage") return reply(503, { message: "test-only refresh outage" });
          await refreshBarrier; completedRefreshes++;
          return refreshOutcome === "success" ? reply(200, rotatedSession) : reply(401, { message: "test-only old refresh revoked" });
        }
        if (path === "/api/auth/login") return JSON.parse(request.body).password === "test-only-wrong-password"
          ? reply(401, { message: "邮箱或密码错误。" }) : reply(200, freshSession);
        if (path === "/api/client/runtime") return reply(200, connected ? config : null);
        if (path === "/api/client/bootstrap") return reply(200, { ...mockBootstrap, user: request.headers?.Authorization === "Bearer " + freshSession.accessToken ? freshSession.user : session.user, announcements });
        if (path === "/api/client/nodes") return reply(200, mockNodes);
        if (path === "/api/client/announcements") return reply(200, announcements);
        if (path === "/api/client/subscription") return reply(200, mockBootstrap.subscription);
        return reply(200, {});
      }
      case "probe_nodes": return [];
      case "check_runtime_component_file": return { exists: false, valid: false, path: "/test-only/missing" };
      case "get_runtime_component_local_info": return { exists: false, valid: false };
      default: return { ok: true };
    }
  }
};
localStorage.setItem("chordv_desktop_close_hint_ack", "ack");
Object.assign(window, { mygo: native, leaseFixture: {
  calls, network, config, connected: () => connected, renewals: () => renewals, stored: () => stored,
  pushCountdown: (id: string, title: string) => {
    announcements = [{ id, title, body: "倒计时回归", publishedAt: "2026-01-01T00:00:00Z", displayMode: "modal_countdown", countdownSeconds: 5 }];
    emit("chordv://client-runtime-event", { streamId: activeStream, event: { type: "announcement_updated" } });
  },
  setHeartbeat: (value: string) => { heartbeat = value; },
  beginPendingRefresh: (outcome: string) => { refreshOutcome = outcome; heartbeat = "refresh-pending";
    refreshBarrier = new Promise<void>(resolve => { releaseRefresh = resolve; }); },
  releaseRefresh: () => releaseRefresh(), refreshCompleted: () => completedRefreshes,
  release: () => { const pending = releases; releases = []; pending.forEach(done => done()); },
  emitHeartbeat: (terminal: boolean, sessionId = config.sessionId) => emit("chordv://native-lease-heartbeat", {
    sessionId, status: "error", terminal, leaseExpiresAt: null, reasonCode: "session_expired", message: "当前连接已过期，请重新连接。"
  }),
  interrupt: () => { connected = false; emit("chordv://runtime-status", { ...runtimeStatus(), status: "error" });
    emit("chordv://runtime-interrupted", { cause: "lease-ended", proxyRestored: false, message: "本机系统代理待恢复" }); }
} });

createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={{ primaryColor: "cyan" }}>
    <Notifications position="top-right" autoClose={TOAST_AUTO_CLOSE_MS} limit={TOAST_LIMIT}
      containerWidth={TOAST_WIDTH} classNames={toastContainerClassNames} />
    <App />
  </MantineProvider>
);
