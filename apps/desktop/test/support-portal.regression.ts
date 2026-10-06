import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import type { ClientSupportLaunchDto, ClientSupportStatusDto } from "@chordv/shared";
import { fetchSupportStatus, launchSupportPortal } from "../src/api/client";
import { closeSupportWindow, createSupportWindowTarget } from "../src/lib/runtime";
import * as supportPortal from "../src/lib/supportPortal";
import {
  createSupportPortalOpener,
  formatSupportUnreadBadge,
  isSupportDisabledError,
  normalizeSupportUnreadCount,
  SUPPORT_CONTACT_EMAIL,
  SUPPORT_DISABLED_MESSAGE,
  SUPPORT_UPGRADING_MESSAGE,
  type SupportPortalDeps,
  type SupportPortalTarget
} from "../src/lib/supportPortal";
import { describeUserError } from "../src/lib/userFacingErrors";
import * as recentErrorCodes from "../src/lib/recentErrorCodes";

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
  const context = { appVersion: "1.1.11（构建 21）", connectionState: "disconnected" as const, recentErrors: [] };
  await withNative("Macintosh", native, async () => {
    assert.deepEqual(await fetchSupportStatus("token-1"), ENABLED);
    assert.deepEqual(await launchSupportPortal("token-1"), LAUNCH);
    assert.deepEqual(await launchSupportPortal("token-1", context), LAUNCH);
    assert.deepEqual(await launchSupportPortal("token-1", null), LAUNCH);
  });
  const requests = native.calls.map(([, args]) => (args as { request: { method: string; path: string; headers: Record<string, string>; body?: string } }).request);
  assert.deepEqual(requests.map((request) => `${request.method} ${request.path}`), ["GET /client/support/status", "POST /client/support/launch", "POST /client/support/launch", "POST /client/support/launch"]);
  assert.ok(requests.every((request) => request.headers.Authorization === "Bearer token-1"));
  assert.equal(requests[1].body, undefined, "没有诊断信息时不带请求体（与旧版一致）");
  assert.deepEqual(JSON.parse(requests[2].body ?? "null"), { context }, "诊断信息放在 { context } 里");
  assert.equal(requests[3].body, undefined);
}

function realDeps(overrides: Partial<SupportPortalDeps> = {}): SupportPortalDeps {
  return {
    prepareTarget: createSupportWindowTarget,
    getAccountGeneration: () => 1,
    getKnownEnabled: () => true,
    refreshStatus: async () => ENABLED,
    launch: () => launchSupportPortal("token-1"),
    notifyDisabled: () => assert.fail("not disabled"),
    notifyUpgrading: () => assert.fail("not upgrading"),
    showError: (reason) => assert.fail(`unexpected error ${String(reason)}`),
    ...overrides
  };
}

async function testLaunchOpensSupportWindowWithLaunchUrl() {
  const native: FakeNative = {
    calls: [],
    handlers: {
      focus_support_window: () => ({ focused: false, epoch: 4 }),
      open_support_window: () => null,
      api_request: apiResponder({ "POST /client/support/launch": () => ({ status: 201, body: LAUNCH }) })
    }
  };
  const result = await withNative("Macintosh", native, () => createSupportPortalOpener(realDeps()).open());
  assert.equal(result, "opened");
  assert.deepEqual(native.calls.map(([command]) => command), ["focus_support_window", "api_request", "open_support_window"]);
  assert.deepEqual(native.calls[2][1], { launchUrl: LAUNCH.launchUrl, supportOrigin: LAUNCH.supportOrigin, epoch: 4 },
    "the native open carries the epoch from the focus check so a logout in between is rejected");
}

async function testOpenWindowFocusesExistingWithoutNewTicket() {
  const native: FakeNative = { calls: [], handlers: { focus_support_window: () => ({ focused: true, epoch: 0 }) } };
  let launches = 0;
  const result = await withNative("Windows", native, () =>
    createSupportPortalOpener(realDeps({ launch: async () => { launches += 1; return LAUNCH; } })).open()
  );
  assert.equal(result, "focused");
  assert.equal(launches, 0, "an open support window is focused, never re-launched");
  assert.deepEqual(native.calls.map(([command]) => command), ["focus_support_window"]);
}

const ORIGIN_DEPS = { getSupportOrigin: () => "https://support.achord.cn" };

async function testPlaceholderWindowOpensBeforeTheTicketArrives() {
  // 点击后先 begin（占位窗口），票据到手后再 open；open 带 prepared，窗口复用而不是新建。
  const native: FakeNative = {
    calls: [],
    handlers: {
      focus_support_window: () => ({ focused: false, epoch: 4 }),
      begin_support_window: () => null,
      open_support_window: () => null,
      api_request: apiResponder({ "POST /client/support/launch": () => ({ status: 201, body: LAUNCH }) })
    }
  };
  const result = await withNative("Macintosh", native, () =>
    createSupportPortalOpener(realDeps({ prepareTarget: () => createSupportWindowTarget(ORIGIN_DEPS) })).open()
  );
  assert.equal(result, "opened");
  const commands = native.calls.map(([command]) => command);
  assert.equal(commands[0], "focus_support_window");
  assert.equal(commands.at(-1), "open_support_window");
  assert.ok(commands.includes("begin_support_window") && commands.includes("api_request"));
  assert.ok(commands.indexOf("begin_support_window") < commands.indexOf("open_support_window"), "the placeholder is requested before the ticket is used");
  assert.deepEqual(native.calls.find(([command]) => command === "begin_support_window")?.[1], { supportOrigin: "https://support.achord.cn", epoch: 4 });
  assert.deepEqual(native.calls.at(-1)?.[1], { launchUrl: LAUNCH.launchUrl, supportOrigin: LAUNCH.supportOrigin, epoch: 4, prepared: true });
  assert.ok(!commands.includes("cancel_support_loading_window"), "a successful open keeps the window");
}

async function testPlaceholderWindowFallsBackAndCleansUp() {
  // 没有站点来源（旧后台/状态未取到）：不预开，行为与以前完全一致。
  const noOrigin: FakeNative = {
    calls: [],
    handlers: {
      focus_support_window: () => ({ focused: false, epoch: 4 }),
      open_support_window: () => null,
      api_request: apiResponder({ "POST /client/support/launch": () => ({ status: 201, body: LAUNCH }) })
    }
  };
  await withNative("Macintosh", noOrigin, () =>
    createSupportPortalOpener(realDeps({ prepareTarget: () => createSupportWindowTarget({ getSupportOrigin: () => null }) })).open()
  );
  assert.deepEqual(noOrigin.calls.map(([command]) => command), ["focus_support_window", "api_request", "open_support_window"]);
  assert.deepEqual(noOrigin.calls[2][1], { launchUrl: LAUNCH.launchUrl, supportOrigin: LAUNCH.supportOrigin, epoch: 4 });

  // 占位窗口建不起来：照常在拿到票据后开窗。
  const beginFails: FakeNative = {
    calls: [],
    handlers: {
      focus_support_window: () => ({ focused: false, epoch: 4 }),
      begin_support_window: () => { throw "占位失败"; },
      open_support_window: () => null,
      api_request: apiResponder({ "POST /client/support/launch": () => ({ status: 201, body: LAUNCH }) })
    }
  };
  const fallback = await withNative("Windows", beginFails, () =>
    createSupportPortalOpener(realDeps({ prepareTarget: () => createSupportWindowTarget(ORIGIN_DEPS) })).open()
  );
  assert.equal(fallback, "opened");
  assert.deepEqual(beginFails.calls.at(-1)?.[1], { launchUrl: LAUNCH.launchUrl, supportOrigin: LAUNCH.supportOrigin, epoch: 4 }, "no prepared flag when the placeholder failed");

  // 票据没拿到：关掉占位窗口，并按原样提示失败。
  const launchFails: FakeNative = {
    calls: [],
    handlers: {
      focus_support_window: () => ({ focused: false, epoch: 4 }),
      begin_support_window: () => null,
      cancel_support_loading_window: () => null,
      api_request: apiResponder({ "POST /client/support/launch": () => ({ status: 502, body: { message: "工单系统暂时不可用，请稍后再试" } }) })
    }
  };
  const errors: unknown[] = [];
  const failed = await withNative("Macintosh", launchFails, async () => {
    const outcome = await createSupportPortalOpener(realDeps({
      prepareTarget: () => createSupportWindowTarget(ORIGIN_DEPS),
      showError: (reason) => { errors.push(reason); }
    })).open();
    await new Promise((resolve) => setTimeout(resolve, 30)); // 关闭占位窗口是异步清理
    return outcome;
  });
  assert.equal(failed, "failed");
  assert.equal(errors.length, 1);
  assert.deepEqual(launchFails.calls.find(([command]) => command === "cancel_support_loading_window")?.[1], { epoch: 4 });

  // 用户在占位窗口等待期间把它关了：静默结束，不提示错误、不再弹出。
  const closedByUser: FakeNative = {
    calls: [],
    handlers: {
      focus_support_window: () => ({ focused: false, epoch: 4 }),
      begin_support_window: () => null,
      open_support_window: () => { throw "support_window_closed"; },
      cancel_support_loading_window: () => null,
      api_request: apiResponder({ "POST /client/support/launch": () => ({ status: 201, body: LAUNCH }) })
    }
  };
  const closed = await withNative("Macintosh", closedByUser, () =>
    createSupportPortalOpener(realDeps({ prepareTarget: () => createSupportWindowTarget(ORIGIN_DEPS) })).open()
  );
  assert.equal(closed, "stale");

  // 已有窗口直接聚焦：不预开占位窗口。
  const focused: FakeNative = { calls: [], handlers: { focus_support_window: () => ({ focused: true, epoch: 0 }) } };
  assert.equal(await withNative("Macintosh", focused, () =>
    createSupportPortalOpener(realDeps({ prepareTarget: () => createSupportWindowTarget(ORIGIN_DEPS) })).open()
  ), "focused");
  assert.deepEqual(focused.calls.map(([command]) => command), ["focus_support_window"]);
}

async function testOpenerPreparesOnlyWhenATicketIsRequested() {
  const events: string[] = [];
  const target: Partial<SupportPortalTarget> = { prepare: () => { events.push("begin"); } };
  const ok = createDeps({ events, target });
  assert.equal(await createSupportPortalOpener(ok).open(), "opened");
  assert.deepEqual(events, ["prepare", "focus", "begin", "launch", "open https://support.achord.cn"]);

  // 未开放：不预开占位窗口。
  const disabledEvents: string[] = [];
  const disabled = createDeps({ events: disabledEvents, getKnownEnabled: () => false, target: { prepare: () => { disabledEvents.push("begin"); } } });
  disabled.refreshStatus = async () => { disabledEvents.push("status"); return DISABLED; };
  assert.equal(await createSupportPortalOpener(disabled).open(), "disabled");
  assert.ok(!disabledEvents.includes("begin"));

  // 窗口已打开直接聚焦：不预开。
  const focusEvents: string[] = [];
  const focused = createDeps({ events: focusEvents, target: { focusExisting: async () => { focusEvents.push("focus"); return true; }, prepare: () => { focusEvents.push("begin"); } } });
  assert.equal(await createSupportPortalOpener(focused).open(), "focused");
  assert.ok(!focusEvents.includes("begin"));
}

function createDeps(overrides: Partial<SupportPortalDeps> & { events?: string[]; target?: Partial<SupportPortalTarget> } = {}) {
  const events = overrides.events ?? [];
  const target: SupportPortalTarget = {
    focusExisting: async () => { events.push("focus"); return false; },
    open: async (launch) => { events.push(`open ${launch.supportOrigin}`); },
    dispose: () => { events.push("dispose"); },
    ...overrides.target
  };
  const deps: SupportPortalDeps & { events: string[] } = {
    events,
    prepareTarget: () => { events.push("prepare"); return target; },
    getAccountGeneration: () => 1,
    getKnownEnabled: () => true,
    refreshStatus: async () => { events.push("status"); return ENABLED; },
    launch: async () => { events.push("launch"); return LAUNCH; },
    notifyDisabled: () => { events.push("disabled"); },
    notifyUpgrading: () => { events.push("upgrading"); },
    showError: (reason) => { events.push(`error ${describeUserError(reason, { context: "support" }).message}`); },
    ...overrides
  };
  return deps;
}

async function testDisabledSupportShowsNotice() {
  // 状态显示未启用：重新确认一次仍未启用，就只提示，不申请票据。
  const deps = createDeps({ getKnownEnabled: () => false });
  deps.refreshStatus = async () => { deps.events.push("status"); return DISABLED; };
  assert.equal(await createSupportPortalOpener(deps).open(), "disabled");
  assert.deepEqual(deps.events, ["prepare", "focus", "status", "disabled", "dispose"]);

  // 后台刚刚开启：重新查询到 enabled=true 后照常打开。
  const enabledNow = createDeps({ getKnownEnabled: () => false });
  assert.equal(await createSupportPortalOpener(enabledNow).open(), "opened");
  assert.deepEqual(enabledNow.events, ["prepare", "focus", "status", "launch", "open https://support.achord.cn"]);

  // 状态重查失败（不确定）不等于未开放：照常申请票据。
  const unknownStatus = createDeps({ getKnownEnabled: () => false });
  unknownStatus.refreshStatus = async () => { unknownStatus.events.push("status"); return null; };
  assert.equal(await createSupportPortalOpener(unknownStatus).open(), "opened");
  assert.deepEqual(unknownStatus.events, ["prepare", "focus", "status", "launch", "open https://support.achord.cn"]);

  // 打开接口返回 503“暂未开放”：同样是提示而不是错误。
  const unavailable = createDeps({ launch: async () => { throw apiError(503, SUPPORT_DISABLED_MESSAGE); } });
  assert.equal(await createSupportPortalOpener(unavailable).open(), "disabled");
  assert.deepEqual(unavailable.events, ["prepare", "focus", "disabled", "dispose"]);
  assert.equal(isSupportDisabledError(apiError(503, SUPPORT_DISABLED_MESSAGE)), true);
  assert.equal(isSupportDisabledError(apiError(502, "工单系统暂时不可用，请稍后再试")), false);
  assert.equal(isSupportDisabledError(apiError(503, "服务暂时不可用")), false);
}

async function testLaunchErrorsAreMapped() {
  const cases: Array<[unknown, string]> = [
    [apiError(429, "工单打开过于频繁，请稍后再试"), "工单打开过于频繁，请稍后再试"],
    [apiError(502, "Upstream UNIVERSAL_RATE_LIMITED"), "服务器暂时繁忙"],
    [apiError(403, "Forbidden resource"), "工单系统暂时无法打开，请稍后重试。"],
    [new Error("Failed to fetch"), "暂时无法连接到 ChordV 服务，请检查网络后重试。"],
    // 原生层拒绝打开（例如站点不是 https）时以字符串 reject。
    ["工单地址必须使用 https", "工单系统暂时无法打开，请稍后重试。"]
  ];
  for (const [reason, expected] of cases) {
    const deps = createDeps({ launch: async () => { throw reason; } });
    assert.equal(await createSupportPortalOpener(deps).open(), "failed");
    assert.deepEqual(deps.events.slice(0, 2), ["prepare", "focus"]);
    assert.ok(deps.events[2].startsWith(`error ${expected}`), `${String(reason)} → ${deps.events[2]}`);
    assert.doesNotMatch(deps.events[2], /act_|https?:\/\/|UNIVERSAL|Cannot POST/);
    assert.equal(deps.events[3], "dispose", "a reserved browser window is released on failure");
  }

  // 旧版后台没有新工单接口（404）：提示升级中并给出客服邮箱，而不是报错。
  const oldBackend = createDeps({ launch: async () => { throw apiError(404, "Cannot POST /api/client/support/launch"); } });
  assert.equal(await createSupportPortalOpener(oldBackend).open(), "upgrading");
  assert.deepEqual(oldBackend.events, ["prepare", "focus", "upgrading", "dispose"]);
  assert.match(SUPPORT_UPGRADING_MESSAGE, /工单系统正在升级/);
  assert.ok(SUPPORT_UPGRADING_MESSAGE.includes(SUPPORT_CONTACT_EMAIL), "users keep a support channel on older backends");
  assert.match(read("../src/components/LoginScreen.tsx"), /SUPPORT_CONTACT_EMAIL as SUPPORT_EMAIL/, "one support email for the whole app");

  const windowFailure = createDeps({ target: { open: async () => { throw "无法打开工单窗口：webview error"; } } });
  assert.equal(await createSupportPortalOpener(windowFailure).open(), "failed");
  assert.deepEqual(windowFailure.events, ["prepare", "focus", "launch", "error 工单系统暂时无法打开，请稍后重试。", "dispose"]);
}

async function testAccountChangeCancelsPendingLaunch() {
  // 票据还在路上时退出登录 / 换账号：不打开窗口、不提示错误。
  let generation = 1;
  let releaseLaunch!: () => void;
  const gate = new Promise<void>((resolve) => { releaseLaunch = resolve; });
  const deps = createDeps({
    getAccountGeneration: () => generation,
    launch: async () => { deps.events.push("launch"); await gate; return LAUNCH; }
  });
  const pending = createSupportPortalOpener(deps).open();
  await flush();
  generation = 2;
  releaseLaunch();
  assert.equal(await pending, "stale");
  assert.deepEqual(deps.events, ["prepare", "focus", "launch", "dispose"], "no window is opened for the previous account");

  // 打开失败发生在账号变化之后：同样静默结束。
  let failGeneration = 1;
  const failing = createDeps({
    getAccountGeneration: () => failGeneration,
    launch: async () => { failGeneration = 2; throw apiError(502, "工单系统暂时不可用"); }
  });
  assert.equal(await createSupportPortalOpener(failing).open(), "stale");
  assert.ok(!failing.events.some((event) => event.startsWith("error")));

  // 账号在聚焦检查期间变化：不申请票据。
  let focusGeneration = 1;
  const focusing = createDeps({
    target: { focusExisting: async () => { focusGeneration = 2; return false; } },
    getAccountGeneration: () => focusGeneration
  });
  assert.equal(await createSupportPortalOpener(focusing).open(), "stale");
  assert.ok(!focusing.events.includes("launch"));
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
  assert.equal(deps.events.filter((event) => event === "prepare").length, 1, "a repeated click does not reserve another window");
  assert.equal(opener.isBusy(), false);
}

async function testNativeAdaptersRouteByPlatform() {
  const desktop: FakeNative = {
    calls: [],
    handlers: {
      focus_support_window: () => ({ focused: false, epoch: 7 }),
      open_support_window: () => null,
      close_support_window: () => null
    }
  };
  await withNative("Windows", desktop, async () => {
    const target = createSupportWindowTarget();
    assert.equal(await target.focusExisting(), false);
    await target.open({ launchUrl: LAUNCH.launchUrl, supportOrigin: LAUNCH.supportOrigin });
    await closeSupportWindow();
  }, { open: () => assert.fail("desktop never uses browser popups") });
  assert.deepEqual(desktop.calls.map(([command]) => command), ["focus_support_window", "open_support_window", "close_support_window"]);
  assert.deepEqual(desktop.calls[1][1], { launchUrl: LAUNCH.launchUrl, supportOrigin: LAUNCH.supportOrigin, epoch: 7 });

  // 网页预览：点击时同步预留空白窗口，拿到地址后再跳转。
  const visited: string[] = [];
  const opens: string[] = [];
  const popup = {
    opener: {} as unknown,
    closed: false,
    location: { replace: (url: string) => { assert.equal(popup.opener, null); visited.push(url); } },
    close: () => { popup.closed = true; }
  };
  await withNative("Browser", { calls: [], handlers: {} }, async () => {
    const target = createSupportWindowTarget();
    assert.deepEqual(opens, ["about:blank"], "the popup is reserved synchronously inside the click");
    assert.equal(await target.focusExisting(), false);
    await target.open({ launchUrl: LAUNCH.launchUrl, supportOrigin: LAUNCH.supportOrigin });
    target.dispose();
  }, { __TAURI_INTERNALS__: undefined, open: (url: string) => { opens.push(url); return popup; } });
  assert.deepEqual(visited, [LAUNCH.launchUrl]);
  assert.equal(popup.closed, false, "dispose after a successful open keeps the portal");

  // 没有打开时释放预留窗口。
  const unused = { closed: false, close: () => { unused.closed = true; } };
  await withNative("Browser", { calls: [], handlers: {} }, async () => {
    createSupportWindowTarget().dispose();
  }, { __TAURI_INTERNALS__: undefined, open: () => unused });
  assert.equal(unused.closed, true);

  // 安卓端：不预留弹窗，拿到地址后交给原生层用系统默认应用打开，且不调用原生工单命令。
  const android: FakeNative = { calls: [], handlers: { open_external_url: () => ({ ok: true }) } };
  const androidOpens: string[] = [];
  await withNative("Linux; Android 14", android, async () => {
    const target = createSupportWindowTarget();
    assert.equal(await target.focusExisting(), false);
    await target.open({ launchUrl: LAUNCH.launchUrl, supportOrigin: LAUNCH.supportOrigin });
  }, { open: (url: string) => { androidOpens.push(url); return null; } });
  assert.deepEqual(androidOpens, [], "android never relies on WebView popups");
  assert.deepEqual(android.calls, [["open_external_url", { url: LAUNCH.launchUrl }]]);

  // 打不开：提示不含地址。
  const failures: Array<[string, FakeNative, Record<string, unknown>]> = [
    ["Linux; Android 14", { calls: [], handlers: { open_external_url: () => { throw "没有找到可以打开链接的应用 act_secret"; } } }, {}],
    ["Linux; Android 14", { calls: [], handlers: { open_external_url: () => ({ ok: false }) } }, {}],
    ["Browser", { calls: [], handlers: {} }, { __TAURI_INTERNALS__: undefined, open: () => null }]
  ];
  for (const [userAgent, native, extra] of failures) {
    await withNative(userAgent, native, async () => {
      await assert.rejects(
        createSupportWindowTarget().open({ launchUrl: LAUNCH.launchUrl, supportOrigin: LAUNCH.supportOrigin }),
        (error: Error) => !error.message.includes("act_secret") && error.message.includes("无法打开工单页面")
      );
    }, extra);
  }
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
  type UnreadEvent = { unreadCount: number; epoch: number; window: string };
  type EndedEvent = { epoch: number; window: string };
  let bridgeHandler: ((event: UnreadEvent) => void) | null = null;
  let closedHandler: ((event: EndedEvent) => void) | null = null;
  let nativeEpoch = 1;
  const opened: Array<{ launchUrl: string; supportOrigin: string }> = [];
  const launchTokens: string[] = [];
  const launchContexts: unknown[] = [];
  let releaseSlowLaunch: (() => void) | null = null;
  const unauthorized = Object.assign(new Error("Unauthorized"), { status: 401 });
  const useSupportPortal = loadHook("../src/hooks/useSupportPortal.ts", "useSupportPortal", {
    "../api/client": {
      fetchSupportStatus: async (token: string) => {
        statusCalls.push(token);
        if (token === "expired") throw unauthorized;
        return await (statusResponses.shift() ?? ENABLED);
      },
      launchSupportPortal: async (token: string, context?: unknown) => {
        launchTokens.push(token);
        launchContexts.push(context);
        if (token === "expired") throw unauthorized;
        if (token === "slow") await new Promise<void>((resolve) => { releaseSlowLaunch = resolve; });
        return LAUNCH;
      },
      isUnauthorizedApiError: (reason: unknown) => reason === unauthorized
    },
    "../lib/runtime": {
      createSupportWindowTarget: (options: { onEpoch?: (epoch: number) => void }) => ({
        focusExisting: async () => { options.onEpoch?.(nativeEpoch); return false; },
        open: async (launch: { launchUrl: string; supportOrigin: string }) => { opened.push(launch); },
        dispose: () => undefined
      }),
      closeSupportWindow: async () => { nativeEvents.push("close"); nativeEpoch += 1; },
      subscribeSupportWindowEvents: async (handlers: {
        onUnread: (event: UnreadEvent) => void;
        onEnded: (event: EndedEvent) => void;
      }) => {
        bridgeHandler = handlers.onUnread;
        closedHandler = handlers.onEnded;
        return () => undefined;
      }
    },
    "../lib/supportPortal": supportPortal,
    "../lib/recentErrorCodes": recentErrorCodes
  }, harness.react);

  const notices: unknown[] = [];
  const errors: unknown[] = [];
  const collected = { appVersion: "1.1.11", connectionState: "connected", sessionId: "sess_1" };
  let collectCalls = 0;
  const baseProps = {
    onUnauthorized: async () => ({ accessToken: "fresh" }),
    notify: (notice: unknown) => notices.push(notice),
    showError: (reason: unknown) => errors.push(reason),
    collectContext: async () => {
      collectCalls += 1;
      return collected;
    }
  };
  const render = (props: { accessToken: string | null; userId: string | null }) =>
    harness.render(useSupportPortal, { ...baseProps, ...props });
  const settle = async (props: { accessToken: string | null; userId: string | null }) => {
    render(props);
    await flush();
    return render(props);
  };
  const user1 = { accessToken: "token-1", userId: "user-1" };

  let hook = render(user1);
  assert.equal(hook.supportUnreadCount, 0);
  hook = await settle(user1);
  assert.deepEqual(statusCalls, ["token-1"], "status is loaded once after login");
  assert.equal(hook.supportUnreadCount, 3, "badge comes from GET /client/support/status");

  // 推送 support_unread_updated → 立即更新；无效值不改变角标。
  hook.applySupportUnreadCount(5);
  hook = render(user1);
  assert.equal(hook.supportUnreadCount, 5);
  for (const invalid of [-2, 1.5, "9", null]) hook.applySupportUnreadCount(invalid);
  hook = render(user1);
  assert.equal(hook.supportUnreadCount, 5);

  // 晚到的状态查询不能覆盖更新的推送 / 桥接结果（没有轮询，覆盖后会一直错）。
  let resolveSlowStatus!: (status: ClientSupportStatusDto) => void;
  statusResponses.push(new Promise((resolve) => { resolveSlowStatus = resolve; }));
  const slowStatus = hook.refreshSupportStatus("token-1");
  hook.applySupportUnreadCount(0);
  resolveSlowStatus({ ...ENABLED, unreadCount: 8 });
  await slowStatus;
  hook = render(user1);
  assert.equal(hook.supportUnreadCount, 0, "a newer event wins over an older status query");
  // 两次查询交错：只采用最后发起的那一次。
  let resolveOlder!: (status: ClientSupportStatusDto) => void;
  statusResponses.push(new Promise((resolve) => { resolveOlder = resolve; }));
  statusResponses.push({ ...ENABLED, unreadCount: 2 });
  const older = hook.refreshSupportStatus("token-1");
  await hook.refreshSupportStatus("token-1");
  resolveOlder({ ...ENABLED, unreadCount: 30 });
  await older;
  hook = render(user1);
  assert.equal(hook.supportUnreadCount, 2, "an older query never overwrites a newer one");

  // 推送重连（syncOnOpen）后重新同步；未启用时角标清零。
  statusResponses.push({ ...ENABLED, unreadCount: 12 });
  await hook.refreshSupportStatus("token-1");
  hook = render(user1);
  assert.equal(hook.supportUnreadCount, 12);
  statusResponses.push(DISABLED);
  await hook.refreshSupportStatus("token-1");
  hook = render(user1);
  assert.equal(hook.supportUnreadCount, 0);

  // 状态查询遇到登录失效：恢复登录后用新令牌重查，而不是当成“未开放”。
  statusResponses.push(ENABLED);
  assert.deepEqual(await hook.refreshSupportStatus("expired"), ENABLED);
  assert.deepEqual(statusCalls.slice(-2), ["expired", "fresh"]);
  hook = render(user1);
  assert.equal(hook.supportUnreadCount, 3);

  // 还没打开过工单窗口：桥接消息一律不接受。
  assert.ok(bridgeHandler, "bridge unread events are subscribed");
  bridgeHandler!({ unreadCount: 44, epoch: nativeEpoch, window: "support-1" });
  hook = render(user1);
  assert.equal(hook.supportUnreadCount, 3, "bridge events are ignored until this account opens a window");

  // 打开工单：launch 访问令牌过期时恢复登录并用新令牌重试一次。
  const expiredUser1 = { accessToken: "expired", userId: "user-1" };
  statusResponses.push(ENABLED);
  hook = await settle(expiredUser1);
  assert.equal(await hook.openSupportPortal(), "opened");
  assert.deepEqual(launchTokens, ["expired", "fresh"]);
  assert.equal(collectCalls, 1, "诊断信息只收集一次");
  assert.deepEqual(launchContexts, [collected, collected], "恢复登录后重试沿用同一份诊断信息");
  assert.deepEqual(opened, [{ launchUrl: LAUNCH.launchUrl, supportOrigin: LAUNCH.supportOrigin }]);
  assert.deepEqual(errors, []);

  // 工单窗口的原生桥接报告未读变化：只接受本账号窗口的批次号。
  bridgeHandler!({ unreadCount: 0, epoch: nativeEpoch, window: "support-1" });
  hook = render(expiredUser1);
  assert.equal(hook.supportUnreadCount, 0);
  bridgeHandler!({ unreadCount: 17, epoch: nativeEpoch - 1, window: "support-1" });
  hook = render(expiredUser1);
  assert.equal(hook.supportUnreadCount, 0, "events from an older window epoch are dropped");

  // 工单窗口打开期间以桥接为准：后台推送和状态查询都不覆盖。
  hook.applySupportUnreadCount(6);
  statusResponses.push({ ...ENABLED, unreadCount: 7 });
  await hook.refreshSupportStatus("expired");
  hook = render(expiredUser1);
  assert.equal(hook.supportUnreadCount, 0, "while the portal reports unread counts, the window wins");
  // 其他账号批次的结束事件不影响。
  closedHandler!({ epoch: nativeEpoch - 1, window: "support-1" });
  hook.applySupportUnreadCount(6);
  hook = render(expiredUser1);
  assert.equal(hook.supportUnreadCount, 0);
  // 同一账号重开：新窗口已开始报告后，被取代的旧窗口晚到的结束通知不影响新窗口。
  bridgeHandler!({ unreadCount: 1, epoch: nativeEpoch, window: "support-2" });
  closedHandler!({ epoch: nativeEpoch, window: "support-1" });
  hook.applySupportUnreadCount(6);
  statusResponses.push({ ...ENABLED, unreadCount: 7 });
  await hook.refreshSupportStatus("expired");
  hook = render(expiredUser1);
  assert.equal(hook.supportUnreadCount, 1, "a superseded window's late ended event is ignored");
  // 当前窗口结束（关闭、会话过期或整页重新加载）：改回以后台为准，并立即重新查询。
  statusResponses.push({ ...ENABLED, unreadCount: 4 });
  const callsBeforeClose = statusCalls.length;
  closedHandler!({ epoch: nativeEpoch, window: "support-2" });
  await flush();
  hook = render(expiredUser1);
  assert.equal(statusCalls.length, callsBeforeClose + 2, "closing the window re-syncs from the status endpoint (after token recovery)");
  assert.equal(hook.supportUnreadCount, 4);
  hook.applySupportUnreadCount(8);
  hook = render(expiredUser1);
  assert.equal(hook.supportUnreadCount, 8, "pushes apply again once the window is closed");

  // 诊断信息收集失败：不附带，照常打开。
  baseProps.collectContext = async () => {
    throw new Error("collector broke");
  };
  hook = render(expiredUser1);
  launchContexts.length = 0;
  const openedBefore = opened.length;
  assert.equal(await hook.openSupportPortal(), "opened");
  assert.deepEqual(launchContexts, [null, null]);
  assert.equal(opened.length, openedBefore + 1);
  assert.deepEqual(errors, []);
  opened.splice(openedBefore);
  baseProps.collectContext = async () => collected;

  // 票据申请途中换账号：不为上一个账号打开工单窗口，也不报错。
  const slowUser1 = { accessToken: "slow", userId: "user-1" };
  hook = await settle(slowUser1);
  const staleEpoch = nativeEpoch;
  const pendingOpen = hook.openSupportPortal();
  await flush();
  assert.ok(releaseSlowLaunch, "launch is pending");
  statusResponses.push(Promise.reject(new Error("offline")));
  const user2 = { accessToken: "other-token", userId: "user-2" };
  recentErrorCodes.recordRecentErrorCode("runtime_exited");
  render(user2);
  hook = render(user2);
  assert.equal(hook.supportUnreadCount, 0, "the previous account's badge is cleared on account switch");
  assert.deepEqual(recentErrorCodes.readRecentErrorCodes(), [], "上一个账号的最近错误不带到下一个账号的工单里");
  releaseSlowLaunch!();
  assert.equal(await pendingOpen, "stale");
  assert.equal(opened.length, 1, "no window is opened for the previous account");
  assert.deepEqual(errors, []);
  assert.deepEqual(nativeEvents, ["close"], "switching accounts closes the support window and invalidates native opens");
  // 上一个账号窗口已排队的未读消息到达：丢弃。
  bridgeHandler!({ unreadCount: 9, epoch: staleEpoch, window: "support-2" });
  hook = await settle(user2);
  assert.equal(hook.supportUnreadCount, 0, "queued unread events from the previous account are dropped");

  // 过期的状态响应（已退出登录）不会写回角标。
  let resolveLate!: (status: ClientSupportStatusDto) => void;
  statusResponses.push(new Promise((resolve) => { resolveLate = resolve; }));
  const late = hook.refreshSupportStatus("other-token");
  const loggedOut = { accessToken: null, userId: null };
  render(loggedOut);
  hook = render(loggedOut);
  assert.equal(hook.supportUnreadCount, 0, "logout clears the badge");
  assert.deepEqual(nativeEvents, ["close", "close"], "logout closes the support window");
  resolveLate({ ...ENABLED, unreadCount: 40 });
  await late;
  hook = render(loggedOut);
  assert.equal(hook.supportUnreadCount, 0);
  bridgeHandler!({ unreadCount: 9, epoch: nativeEpoch, window: "support-3" });
  hook = render(loggedOut);
  assert.equal(hook.supportUnreadCount, 0, "bridge events after logout are ignored");
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
  // 旧工单中心已移除：生产后台没有新工单接口时禁止发布客户端。
  const release = read("../../../.github/workflows/release-desktop.yml");
  assert.match(release, /Require new support endpoints on production backend/);
  assert.match(release, /for path in client\/support\/status client\/support\/launch; do/);
  assert.match(release, /401\|403\) ;;\s*\*\) echo "生产后台的/);
  const runtime = read("../src/lib/runtime.ts");
  const openBody = runtime.match(/export function createSupportWindowTarget[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(openBody, "createSupportWindowTarget exists");
  assert.doesNotMatch(openBody, /recordClientDiagnosticLog|console\.|\$\{input\.launchUrl\}/);
}

async function main() {
  await testApiClientUsesSupportEndpoints();
  await testLaunchOpensSupportWindowWithLaunchUrl();
  await testOpenWindowFocusesExistingWithoutNewTicket();
  await testPlaceholderWindowOpensBeforeTheTicketArrives();
  await testPlaceholderWindowFallsBackAndCleansUp();
  await testOpenerPreparesOnlyWhenATicketIsRequested();
  await testDisabledSupportShowsNotice();
  await testLaunchErrorsAreMapped();
  await testAccountChangeCancelsPendingLaunch();
  await testRepeatedClicksLaunchOnce();
  await testNativeAdaptersRouteByPlatform();
  testUnreadBadgeFormatting();
  await testBadgeFollowsStatusEventsAndBridge();
  await testClientEventsSyncSupportOnEveryOpen();
  testAppWiring();
  console.log("support portal regression checks passed");
}

await main();
