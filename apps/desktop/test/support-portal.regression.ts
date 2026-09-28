import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import type { ClientSupportLaunchDto, ClientSupportStatusDto } from "@chordv/shared";
import { fetchSupportStatus, launchSupportPortal } from "../src/api/client";
import { closeSupportWindow, focusSupportWindow, openSupportWindow } from "../src/lib/runtime";
import * as supportPortal from "../src/lib/supportPortal";
import {
  createSupportPortalOpener,
  formatSupportUnreadBadge,
  isSupportDisabledError,
  normalizeSupportUnreadCount,
  SUPPORT_DISABLED_MESSAGE,
  type SupportPortalDeps
} from "../src/lib/supportPortal";
import { describeUserError } from "../src/lib/userFacingErrors";

// Windows 检出时可能是 CRLF 换行，统一成 LF 再匹配。
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const LAUNCH: ClientSupportLaunchDto = {
  launchUrl: "https://support.achord.cn/embed/connect/pub_1#ticket=act_secret&mode=native",
  expiresAt: "2026-09-28T00:01:00.000Z",
  supportOrigin: "https://support.achord.cn"
};
const ENABLED: ClientSupportStatusDto = { enabled: true, unreadCount: 3, supportOrigin: "https://support.achord.cn" };
const DISABLED: ClientSupportStatusDto = { enabled: false, unreadCount: 0, supportOrigin: null };

async function flush(turns = 20) {
  for (let turn = 0; turn < turns; turn++) await Promise.resolve();
}

function apiError(status: number, message: string) {
  return Object.assign(new Error(message), { status, rawMessage: JSON.stringify({ statusCode: status, message }) });
}

type FakeNative = {
  calls: Array<[string, unknown]>;
  handlers: Record<string, (args: any) => unknown>;
};

/** 用假的 Tauri IPC 驱动真实的 API 客户端和原生适配层（不打开任何窗口）。 */
async function withNative<T>(userAgent: string, native: FakeNative, run: () => Promise<T>, extra: Record<string, unknown> = {}) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const testWindow = {
    navigator: { userAgent },
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: unknown) => {
        native.calls.push([command, args]);
        const handler = native.handlers[command];
        if (!handler) throw new Error(`unexpected command ${command}`);
        return handler(args);
      },
      transformCallback: () => 0
    },
    ...extra
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: testWindow });
  try {
    return await run();
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

function apiResponder(routes: Record<string, () => { status: number; body: unknown }>) {
  return (args: { request: { method: string; path: string; headers: Record<string, string> } }) => {
    const key = `${args.request.method} ${args.request.path}`;
    const route = routes[key];
    if (!route) throw new Error(`unexpected request ${key}`);
    const result = route();
    return { status: result.status, body: JSON.stringify(result.body), elapsedMs: 1 };
  };
}

async function testApiClientUsesSupportEndpoints() {
  const native: FakeNative = {
    calls: [],
    handlers: {
      api_request: apiResponder({
        "GET /client/support/status": () => ({ status: 200, body: ENABLED }),
        "POST /client/support/launch": () => ({ status: 201, body: LAUNCH })
      })
    }
  };
  await withNative("Macintosh", native, async () => {
    assert.deepEqual(await fetchSupportStatus("token-1"), ENABLED);
    assert.deepEqual(await launchSupportPortal("token-1"), LAUNCH);
  });
  const requests = native.calls.map(([, args]) => (args as { request: { method: string; path: string; headers: Record<string, string> } }).request);
  assert.deepEqual(requests.map((request) => `${request.method} ${request.path}`), ["GET /client/support/status", "POST /client/support/launch"]);
  assert.ok(requests.every((request) => request.headers.Authorization === "Bearer token-1"));
}

async function testLaunchOpensSupportWindowWithLaunchUrl() {
  const native: FakeNative = {
    calls: [],
    handlers: {
      focus_support_window: () => false,
      open_support_window: () => null,
      api_request: apiResponder({ "POST /client/support/launch": () => ({ status: 201, body: LAUNCH }) })
    }
  };
  const errors: unknown[] = [];
  let disabledNotices = 0;
  const result = await withNative("Macintosh", native, () =>
    createSupportPortalOpener({
      getKnownEnabled: () => true,
      refreshStatus: async () => ENABLED,
      launch: () => launchSupportPortal("token-1"),
      focusExisting: focusSupportWindow,
      openWindow: openSupportWindow,
      notifyDisabled: () => { disabledNotices += 1; },
      showError: (reason) => errors.push(reason)
    }).open()
  );
  assert.equal(result, "opened");
  assert.deepEqual(errors, []);
  assert.equal(disabledNotices, 0);
  assert.deepEqual(native.calls.map(([command]) => command), ["focus_support_window", "api_request", "open_support_window"]);
  assert.deepEqual(native.calls[2][1], { launchUrl: LAUNCH.launchUrl, supportOrigin: LAUNCH.supportOrigin });
}

async function testOpenWindowFocusesExistingWithoutNewTicket() {
  const native: FakeNative = { calls: [], handlers: { focus_support_window: () => true } };
  let launches = 0;
  const result = await withNative("Windows", native, () =>
    createSupportPortalOpener({
      getKnownEnabled: () => true,
      refreshStatus: async () => ENABLED,
      launch: async () => { launches += 1; return LAUNCH; },
      focusExisting: focusSupportWindow,
      openWindow: openSupportWindow,
      notifyDisabled: () => assert.fail("not disabled"),
      showError: () => assert.fail("no error")
    }).open()
  );
  assert.equal(result, "focused");
  assert.equal(launches, 0, "an open support window is focused, never re-launched");
  assert.deepEqual(native.calls.map(([command]) => command), ["focus_support_window"]);
}

function createDeps(overrides: Partial<SupportPortalDeps> & { events?: string[] } = {}): SupportPortalDeps & { events: string[] } {
  const events = overrides.events ?? [];
  return {
    events,
    getKnownEnabled: () => true,
    refreshStatus: async () => { events.push("status"); return ENABLED; },
    launch: async () => { events.push("launch"); return LAUNCH; },
    focusExisting: async () => { events.push("focus"); return false; },
    openWindow: async (launch) => { events.push(`open ${launch.supportOrigin}`); },
    notifyDisabled: () => { events.push("disabled"); },
    showError: (reason) => { events.push(`error ${describeUserError(reason, { context: "support" }).message}`); },
    ...overrides
  };
}

async function testDisabledSupportShowsNotice() {
  // 状态显示未启用：重新确认一次仍未启用，就只提示，不申请票据。
  const deps = createDeps({ getKnownEnabled: () => false });
  deps.refreshStatus = async () => { deps.events.push("status"); return DISABLED; };
  assert.equal(await createSupportPortalOpener(deps).open(), "disabled");
  assert.deepEqual(deps.events, ["focus", "status", "disabled"]);

  // 后台刚刚开启：重新查询到 enabled=true 后照常打开。
  const enabledNow = createDeps({ getKnownEnabled: () => false });
  assert.equal(await createSupportPortalOpener(enabledNow).open(), "opened");
  assert.deepEqual(enabledNow.events, ["focus", "status", "launch", "open https://support.achord.cn"]);

  // 打开接口返回 503“暂未开放”：同样是提示而不是错误。
  const unavailable = createDeps({ launch: async () => { throw apiError(503, SUPPORT_DISABLED_MESSAGE); } });
  assert.equal(await createSupportPortalOpener(unavailable).open(), "disabled");
  assert.deepEqual(unavailable.events, ["focus", "disabled"]);
  assert.equal(isSupportDisabledError(apiError(503, SUPPORT_DISABLED_MESSAGE)), true);
  assert.equal(isSupportDisabledError(apiError(502, "工单系统暂时不可用，请稍后再试")), false);
  assert.equal(isSupportDisabledError(apiError(503, "服务暂时不可用")), false);
}

async function testLaunchErrorsAreMapped() {
  const cases: Array<[unknown, string]> = [
    [apiError(429, "工单打开过于频繁，请稍后再试"), "工单打开过于频繁，请稍后再试"],
    [apiError(502, "Upstream UNIVERSAL_RATE_LIMITED"), "服务器暂时繁忙"],
    [apiError(404, "Cannot POST /api/client/support/launch"), "工单系统暂时无法打开，请稍后重试。"],
    [new Error("Failed to fetch"), "暂时无法连接到 ChordV 服务，请检查网络后重试。"],
    // 原生层拒绝打开（例如站点不是 https）时以字符串 reject。
    ["工单地址必须使用 https", "工单系统暂时无法打开，请稍后重试。"]
  ];
  for (const [reason, expected] of cases) {
    const deps = createDeps({ launch: async () => { throw reason; } });
    assert.equal(await createSupportPortalOpener(deps).open(), "failed");
    assert.equal(deps.events.length, 2);
    assert.ok(deps.events[1].startsWith(`error ${expected}`), `${String(reason)} → ${deps.events[1]}`);
    assert.doesNotMatch(deps.events[1], /act_|https?:\/\/|UNIVERSAL|Cannot POST/);
  }

  const windowFailure = createDeps({ openWindow: async () => { throw "无法打开工单窗口：webview error"; } });
  assert.equal(await createSupportPortalOpener(windowFailure).open(), "failed");
  assert.deepEqual(windowFailure.events, ["focus", "launch", "error 工单系统暂时无法打开，请稍后重试。"]);
}

async function testRepeatedClicksLaunchOnce() {
  let releaseLaunch!: () => void;
  const gate = new Promise<void>((resolve) => { releaseLaunch = resolve; });
  const deps = createDeps({ launch: async () => { deps.events.push("launch"); await gate; return LAUNCH; } });
  const opener = createSupportPortalOpener(deps);
  const first = opener.open();
  const second = opener.open();
  await flush();
  assert.equal(opener.isBusy(), true);
  releaseLaunch();
  assert.deepEqual(await Promise.all([first, second]), ["opened", "busy"]);
  assert.equal(deps.events.filter((event) => event === "launch").length, 1, "one click = one single-use ticket");
  assert.equal(opener.isBusy(), false);
}

async function testNativeAdaptersRouteByPlatform() {
  const desktop: FakeNative = {
    calls: [],
    handlers: { focus_support_window: () => true, open_support_window: () => null, close_support_window: () => null }
  };
  await withNative("Windows", desktop, async () => {
    assert.equal(await focusSupportWindow(), true);
    await openSupportWindow({ launchUrl: LAUNCH.launchUrl, supportOrigin: LAUNCH.supportOrigin });
    await closeSupportWindow();
  });
  assert.deepEqual(desktop.calls.map(([command]) => command), ["focus_support_window", "open_support_window", "close_support_window"]);

  // 安卓端没有独立窗口：交给系统浏览器，且不调用原生工单命令。
  const android: FakeNative = { calls: [], handlers: {} };
  const visited: string[] = [];
  const popup = { opener: {} as unknown, location: { replace: (url: string) => { visited.push(url); } }, close: () => {} };
  await withNative("Linux; Android 14", android, async () => {
    assert.equal(await focusSupportWindow(), false);
    await openSupportWindow({ launchUrl: LAUNCH.launchUrl, supportOrigin: LAUNCH.supportOrigin });
  }, { open: () => popup });
  assert.deepEqual(visited, [LAUNCH.launchUrl]);
  assert.deepEqual(android.calls, []);

  const blocked: FakeNative = { calls: [], handlers: {} };
  await withNative("Linux; Android 14", blocked, async () => {
    await assert.rejects(
      openSupportWindow({ launchUrl: LAUNCH.launchUrl, supportOrigin: LAUNCH.supportOrigin }),
      (error: Error) => !error.message.includes("act_secret") && error.message.includes("无法打开工单页面")
    );
  }, { open: () => null });
}

function testUnreadBadgeFormatting() {
  assert.equal(normalizeSupportUnreadCount(0), 0);
  assert.equal(normalizeSupportUnreadCount(7), 7);
  assert.equal(normalizeSupportUnreadCount(1_000_000), 99_999);
  for (const invalid of [-1, 1.5, Number.NaN, "3", null, undefined, {}]) {
    assert.equal(normalizeSupportUnreadCount(invalid), null, String(invalid));
  }
  assert.equal(formatSupportUnreadBadge(0), null);
  assert.equal(formatSupportUnreadBadge(1), "1");
  assert.equal(formatSupportUnreadBadge(99), "99");
  assert.equal(formatSupportUnreadBadge(100), "99+");
}

/** 最小的同步 hook 运行器：够驱动 useState/useRef/useCallback/useEffect。 */
function createHookHarness() {
  const slots: unknown[] = [];
  let cursor = 0;
  let pendingEffects: Array<() => void> = [];
  const depsChanged = (previous: unknown[] | undefined, next: unknown[] | undefined) =>
    !previous || !next || previous.length !== next.length || next.some((value, index) => !Object.is(value, previous[index]));
  const react = {
    useState<T>(initial: T | (() => T)) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      const setState = (value: T | ((current: T) => T)) => {
        slots[index] = typeof value === "function" ? (value as (current: T) => T)(slots[index] as T) : value;
      };
      return [slots[index] as T, setState] as const;
    },
    useRef<T>(initial: T) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index] as { current: T };
    },
    useCallback<T>(fn: T, deps?: unknown[]) {
      const index = cursor++;
      const previous = slots[index] as { fn: T; deps?: unknown[] } | undefined;
      if (!previous || depsChanged(previous.deps, deps)) slots[index] = { fn, deps };
      return (slots[index] as { fn: T }).fn;
    },
    useEffect(effect: () => void | (() => void), deps?: unknown[]) {
      const index = cursor++;
      const previous = slots[index] as { deps?: unknown[]; cleanup?: void | (() => void) } | undefined;
      if (previous && !depsChanged(previous.deps, deps)) return;
      pendingEffects.push(() => {
        if (previous?.cleanup) previous.cleanup();
        slots[index] = { deps, cleanup: effect() };
      });
      if (!previous) slots[index] = { deps, cleanup: undefined };
    }
  };
  return {
    react,
    render<P, R>(hook: (props: P) => R, props: P) {
      cursor = 0;
      const result = hook(props);
      const effects = pendingEffects;
      pendingEffects = [];
      effects.forEach((run) => run());
      return result;
    }
  };
}

function loadHook(path: string, exportName: string, modules: Record<string, unknown>, react: unknown) {
  const code = ts.transpileModule(read(path), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(code, {
    exports,
    require: (id: string) => (id === "react" ? react : modules[id] ?? {})
  });
  return exports[exportName] as (props: any) => any;
}

async function testBadgeFollowsStatusEventsAndBridge() {
  const harness = createHookHarness();
  const statusResponses: Array<ClientSupportStatusDto | Promise<ClientSupportStatusDto>> = [ENABLED];
  const statusCalls: string[] = [];
  const nativeEvents: string[] = [];
  let bridgeHandler: ((count: number) => void) | null = null;
  let bridgeUnsubscribed = false;
  const opened: Array<{ launchUrl: string; supportOrigin: string }> = [];
  const launchTokens: string[] = [];
  const unauthorized = Object.assign(new Error("Unauthorized"), { status: 401 });
  const useSupportPortal = loadHook("../src/hooks/useSupportPortal.ts", "useSupportPortal", {
    "../api/client": {
      fetchSupportStatus: async (token: string) => {
        statusCalls.push(token);
        return await (statusResponses.shift() ?? ENABLED);
      },
      launchSupportPortal: async (token: string) => {
        launchTokens.push(token);
        if (token === "expired") throw unauthorized;
        return LAUNCH;
      },
      isUnauthorizedApiError: (reason: unknown) => reason === unauthorized
    },
    "../lib/runtime": {
      focusSupportWindow: async () => false,
      openSupportWindow: async (launch: { launchUrl: string; supportOrigin: string }) => { opened.push(launch); },
      closeSupportWindow: async () => { nativeEvents.push("close"); },
      subscribeSupportUnread: async (handler: (count: number) => void) => {
        bridgeHandler = handler;
        return () => { bridgeUnsubscribed = true; };
      }
    },
    "../lib/supportPortal": supportPortal
  }, harness.react);

  const notices: unknown[] = [];
  const errors: unknown[] = [];
  const baseProps = {
    onUnauthorized: async () => ({ accessToken: "fresh" }),
    notify: (notice: unknown) => notices.push(notice),
    showError: (reason: unknown) => errors.push(reason)
  };
  const render = (props: { accessToken: string | null; userId: string | null }) =>
    harness.render(useSupportPortal, { ...baseProps, ...props });

  let hook = render({ accessToken: "token-1", userId: "user-1" });
  assert.equal(hook.supportUnreadCount, 0);
  await flush();
  hook = render({ accessToken: "token-1", userId: "user-1" });
  assert.deepEqual(statusCalls, ["token-1"], "status is loaded once after login");
  assert.equal(hook.supportUnreadCount, 3, "badge comes from GET /client/support/status");

  // 推送 support_unread_updated → 立即更新；无效值不改变角标。
  hook.applySupportUnreadCount(5);
  hook = render({ accessToken: "token-1", userId: "user-1" });
  assert.equal(hook.supportUnreadCount, 5);
  for (const invalid of [-2, 1.5, "9", null]) hook.applySupportUnreadCount(invalid);
  hook = render({ accessToken: "token-1", userId: "user-1" });
  assert.equal(hook.supportUnreadCount, 5);

  // 工单窗口的原生桥接报告未读变化。
  assert.ok(bridgeHandler, "bridge unread events are subscribed");
  bridgeHandler!(0);
  hook = render({ accessToken: "token-1", userId: "user-1" });
  assert.equal(hook.supportUnreadCount, 0);

  // 推送重连（syncOnOpen）后重新同步。
  statusResponses.push({ ...ENABLED, unreadCount: 12 });
  await hook.refreshSupportStatus("token-1");
  hook = render({ accessToken: "token-1", userId: "user-1" });
  assert.equal(hook.supportUnreadCount, 12);

  // 未启用时角标清零。
  statusResponses.push(DISABLED);
  await hook.refreshSupportStatus("token-1");
  hook = render({ accessToken: "token-1", userId: "user-1" });
  assert.equal(hook.supportUnreadCount, 0);

  // 打开工单：launch 访问令牌过期时恢复登录并用新令牌重试一次。
  statusResponses.push(ENABLED);
  await hook.refreshSupportStatus("token-1");
  hook = render({ accessToken: "expired", userId: "user-1" });
  await flush();
  hook = render({ accessToken: "expired", userId: "user-1" });
  assert.equal(await hook.openSupportPortal(), "opened");
  assert.deepEqual(launchTokens, ["expired", "fresh"]);
  assert.deepEqual(opened, [{ launchUrl: LAUNCH.launchUrl, supportOrigin: LAUNCH.supportOrigin }]);
  assert.deepEqual(errors, []);

  // 过期的状态响应（已退出登录）不会写回角标。
  let resolveLate!: (status: ClientSupportStatusDto) => void;
  statusResponses.push(new Promise((resolve) => { resolveLate = resolve; }));
  const late = hook.refreshSupportStatus("expired");
  render({ accessToken: null, userId: null });
  hook = render({ accessToken: null, userId: null });
  assert.equal(hook.supportUnreadCount, 0, "logout clears the badge");
  assert.deepEqual(nativeEvents, ["close"], "logout closes the support window");
  resolveLate({ ...ENABLED, unreadCount: 40 });
  await late;
  hook = render({ accessToken: null, userId: null });
  assert.equal(hook.supportUnreadCount, 0);
  bridgeHandler!(9);
  hook = render({ accessToken: null, userId: null });
  assert.equal(hook.supportUnreadCount, 0, "bridge events after logout are ignored");
  assert.equal(bridgeUnsubscribed, false);
  assert.deepEqual(notices, []);
}

async function testClientEventsSyncSupportOnEveryOpen() {
  const harness = createHookHarness();
  let subscriber: { onOpen: (meta: { elapsedMs: number | null }) => void } | null = null;
  const useClientEvents = loadHook("../src/hooks/useClientEvents.ts", "useClientEvents", {
    "../api/client": {
      recordClientDiagnosticLog: async () => undefined,
      probeClientServerLatency: async () => ({ elapsedMs: 1 }),
      isAccessTokenExpiredApiError: () => false
    },
    "../lib/presenceNudges": { startPresenceNudges: () => () => undefined }
  }, harness.react);
  const synced: string[] = [];
  harness.render(useClientEvents, {
    session: { accessToken: "token-1" },
    setServerProbe: () => undefined,
    handleRuntimeEvent: () => undefined,
    syncOnOpen: (token: string) => { synced.push(token); },
    recoverSessionAfterUnauthorized: () => null,
    readError: () => "",
    subscribeClientEvents: (_token: string, next: typeof subscriber) => { subscriber = next; return () => undefined; },
    nudgeClientPresence: async () => undefined
  });
  assert.ok(subscriber);
  subscriber!.onOpen({ elapsedMs: 10 });
  subscriber!.onOpen({ elapsedMs: 12 });
  assert.deepEqual(synced, ["token-1", "token-1"], "status is re-synced on login and every reconnect");
}

function testAppWiring() {
  const app = read("../src/App.tsx");
  assert.match(app, /if \(event\.type === "support_unread_updated"\) \{\s*if \(sessionRef\.current\?\.accessToken === accessToken\) applySupportUnreadCount\(event\.supportUnreadCount\);/);
  assert.match(app, /syncOnOpen: refreshSupportStatus,/);
  assert.equal((app.match(/onOpenTickets=\{\(\) => void openSupportPortal\(\)\}/g) ?? []).length, 2, "desktop and mobile layouts both open the portal");
  assert.equal((app.match(/supportUnreadCount=\{supportUnreadCount\}/g) ?? []).length, 2);
  assert.doesNotMatch(app, /TicketCenterModal|useSupportTickets|hasUnreadTickets/);
  const actions = read("../src/hooks/useRuntimeActions.ts");
  assert.doesNotMatch(actions, /ticket_updated|loadTicketList|markTicketUnread/, "the old ticket unread logic is gone");
  const panel = read("../src/components/SubscriptionPanel.tsx");
  assert.equal((panel.match(/disabled=\{!supportBadge\}\s*label=\{supportBadge\}/g) ?? []).length, 2);
  // 一次性地址不能进日志。
  for (const path of ["../src/hooks/useSupportPortal.ts", "../src/lib/supportPortal.ts"]) {
    assert.doesNotMatch(read(path), /recordClientDiagnosticLog|console\./, `${path} never logs the launch url`);
  }
  const runtime = read("../src/lib/runtime.ts");
  const openBody = runtime.match(/export async function openSupportWindow[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(openBody, "openSupportWindow exists");
  assert.doesNotMatch(openBody, /recordClientDiagnosticLog|console\.|\$\{input\.launchUrl\}/);
}

async function main() {
  await testApiClientUsesSupportEndpoints();
  await testLaunchOpensSupportWindowWithLaunchUrl();
  await testOpenWindowFocusesExistingWithoutNewTicket();
  await testDisabledSupportShowsNotice();
  await testLaunchErrorsAreMapped();
  await testRepeatedClicksLaunchOnce();
  await testNativeAdaptersRouteByPlatform();
  testUnreadBadgeFormatting();
  await testBadgeFollowsStatusEventsAndBridge();
  await testClientEventsSyncSupportOnEveryOpen();
  testAppWiring();
  console.log("support portal regression checks passed");
}

await main();
