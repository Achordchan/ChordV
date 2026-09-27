import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AdminPresenceSessionDto, AdminPresenceSnapshotDto, AdminUserPresenceDto } from "@chordv/shared";
import type { AdminRuntimeEventDto } from "../src/api/client";
import { createPresenceStore, PRESENCE_POLL_MS } from "../src/features/presence/presence-store";
import { adminEventSections } from "../src/utils/admin-runtime-events";
import {
  formatConnectionMode,
  formatNodeProtocol,
  formatPresenceBrief,
  formatPresenceDuration,
  formatTeamPresence,
  listOnlineUsers,
  presenceByUserId,
  summarizeNodeConnections,
  summarizeTeamPresence
} from "../src/utils/presence";

const now = Date.parse("2026-09-27T12:00:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function session(overrides: Partial<AdminPresenceSessionDto> = {}): AdminPresenceSessionDto {
  return {
    sessionId: "session_1",
    connectedAt: ago(12 * MINUTE),
    lastHeartbeatAt: ago(20_000),
    connectionMode: "rule",
    node: { id: "node_hk", name: "香港 01", region: "香港", countryCode: "HK", provider: "p", protocol: "vless", security: "reality" },
    subscription: null,
    ...overrides
  };
}

function entry(overrides: Partial<AdminUserPresenceDto>): AdminUserPresenceDto {
  return {
    userId: "user_1",
    displayName: "张三",
    email: "a@example.com",
    teamId: null,
    teamName: null,
    state: "offline",
    onlineSince: null,
    lastOnlineAt: ago(3 * HOUR),
    client: null,
    sessions: [],
    ...overrides
  };
}

// 文案与格式
assert.equal(formatPresenceBrief(entry({ state: "connected", sessions: [session()] }), now), "已连接 · 香港 01");
assert.equal(formatPresenceBrief(entry({ state: "connected", sessions: [session(), session({ sessionId: "s2" })] }), now), "已连接 · 香港 01 等 2 个连接");
assert.equal(formatPresenceBrief(entry({ state: "online" }), now), "在线 · 未连接节点");
assert.equal(formatPresenceBrief(entry({}), now), "离线 · 最近在线 3 小时前");
assert.equal(formatPresenceBrief(entry({ lastOnlineAt: null }), now), "离线");
assert.equal(formatPresenceBrief(undefined, now), "暂无在线记录");
assert.equal(formatConnectionMode("rule"), "规则模式", "与策略页的模式名称一致");
assert.equal(formatConnectionMode("global"), "全局代理");
assert.equal(formatConnectionMode(null), "模式未记录", "升级前建立的连接没有模式记录");
assert.equal(formatNodeProtocol({ protocol: "vless", security: "reality" }), "VLESS · Reality");
assert.equal(formatNodeProtocol({ protocol: "vless", security: "none" }), "VLESS");
assert.equal(formatPresenceDuration(ago(30_000), now), "不到 1 分钟");
assert.equal(formatPresenceDuration(ago(12 * MINUTE), now), "12 分钟");
assert.equal(formatPresenceDuration(ago(2 * HOUR + 5 * MINUTE), now), "2 小时 5 分钟");
assert.equal(formatPresenceDuration(ago(2 * HOUR), now), "2 小时");
assert.equal(formatPresenceDuration(ago(50 * HOUR), now), "2 天");
assert.equal(formatPresenceDuration(null, now), "时长未知");
assert.equal(formatPresenceDuration(new Date(now + 5_000).toISOString(), now), "不到 1 分钟", "浏览器时钟略慢时不出现负数");

// 团队汇总：已连接同时计入在线；重复成员只算一次
const snapshot: AdminPresenceSnapshotDto = {
  generatedAt: new Date(now).toISOString(),
  connectedWindowSeconds: 120,
  onlineWindowSeconds: 150,
  counts: { online: 3, connected: 2, idle: 1 },
  users: [
    entry({ userId: "u_connected_late", displayName: "乙", state: "connected", onlineSince: ago(5 * MINUTE), sessions: [session({ sessionId: "a" })] }),
    entry({ userId: "u_idle", displayName: "丙", state: "online", onlineSince: ago(HOUR) }),
    entry({ userId: "u_connected_early", displayName: "甲", state: "connected", onlineSince: ago(2 * HOUR), sessions: [
      session({ sessionId: "b" }),
      session({ sessionId: "c", node: { ...session().node, id: "node_jp", name: "日本 02", countryCode: "JP" } })
    ] }),
    entry({ userId: "u_offline" })
  ]
};
const byUser = presenceByUserId(snapshot);
const team = summarizeTeamPresence(["u_connected_late", "u_idle", "u_offline", "u_unknown", "u_idle"], byUser);
assert.deepEqual(team, { members: 4, online: 2, connected: 1 });
assert.equal(formatTeamPresence(team), "2 人在线 · 1 人已连接");
assert.equal(formatTeamPresence({ members: 3, online: 1, connected: 0 }), "1 人在线");
assert.equal(formatTeamPresence({ members: 3, online: 0, connected: 0 }), "成员均离线");

// 首页列表：只列在线，已连接在前，在线更久的在前
assert.deepEqual(listOnlineUsers(snapshot).map(item => item.userId), ["u_connected_early", "u_connected_late", "u_idle"]);
assert.deepEqual(listOnlineUsers(null), []);
assert.deepEqual(summarizeNodeConnections(snapshot), [
  { nodeId: "node_hk", name: "香港 01", countryCode: "HK", sessions: 2, users: 2 },
  { nodeId: "node_jp", name: "日本 02", countryCode: "JP", sessions: 1, users: 1 }
]);

// 在线状态变化不触发整套后台数据刷新，由在线状态自己的轻量接口处理
const presenceEvent: AdminRuntimeEventDto = { type: "presence_updated", occurredAt: new Date(now).toISOString() };
assert.deepEqual(adminEventSections(presenceEvent), []);

// 共享数据：多个组件只拉一份；收到事件即刷新；页面隐藏不拉；最后一个组件卸载后停止
async function testStore() {
  let fetches = 0;
  let visible = true;
  let eventListener: ((event: { type: string }) => void) | null = null;
  let visibilityListener: (() => void) | null = null;
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  let resolveFetch: ((value: AdminPresenceSnapshotDto) => void) | null = null;
  const store = createPresenceStore({
    fetch: () => {
      fetches += 1;
      return new Promise(resolvePromise => { resolveFetch = resolvePromise; });
    },
    subscribeEvents: listener => { eventListener = listener; return () => { eventListener = null; }; },
    visible: () => visible,
    onVisibilityChange: listener => { visibilityListener = listener; return () => { visibilityListener = null; }; },
    setInterval: (task, ms) => { assert.equal(ms, PRESENCE_POLL_MS); const id = nextTimer++; timers.set(id, task); return id; },
    clearInterval: handle => { timers.delete(handle as number); }
  });
  const flush = () => new Promise(resolvePromise => setTimeout(resolvePromise, 0));
  let renders = 0;
  const stopA = store.subscribe(() => { renders += 1; });
  const stopB = store.subscribe(() => undefined);
  assert.equal(fetches, 1, "两个组件同时使用只拉一次");
  assert.equal(store.getState().loading, true);
  eventListener!({ type: "presence_updated" });
  eventListener!({ type: "ticket_updated" });
  assert.equal(fetches, 1, "请求进行中再次触发不并发");
  resolveFetch!(snapshot);
  await flush();
  assert.equal(store.getState().snapshot, snapshot);
  assert.equal(fetches, 2, "请求期间的在线变化在结束后补拉一次");
  resolveFetch!(snapshot);
  await flush();
  assert.ok(renders > 0);

  visible = false;
  [...timers.values()].forEach(task => task());
  assert.equal(fetches, 2, "页面隐藏时不轮询");
  visible = true;
  visibilityListener!();
  assert.equal(fetches, 3, "回到页面立即刷新");
  resolveFetch!(snapshot);
  await flush();

  stopA();
  assert.equal(timers.size, 1, "仍有组件在用时保持轮询");
  stopB();
  assert.equal(timers.size, 0, "最后一个组件卸载后停止轮询");
  assert.equal(eventListener, null, "并取消事件订阅");

  const failing = createPresenceStore({
    fetch: async () => { throw new Error("HTTP 503"); },
    subscribeEvents: () => () => undefined,
    visible: () => true,
    onVisibilityChange: () => () => undefined,
    setInterval: () => 0,
    clearInterval: () => undefined
  });
  const stop = failing.subscribe(() => undefined);
  await flush();
  assert.equal(failing.getState().error, "在线状态暂时不可用，稍后会自动重试。", "失败只给中文提示，不透出原始错误");
  assert.equal(failing.getState().loading, false);
  stop();
}

await testStore();

// 页面接入
const read = (path: string) => readFileSync(resolve(import.meta.dirname, path), "utf8");
const overview = read("../src/pages/OverviewPage.tsx");
assert.match(overview, /<OnlineUsersPanel onOpenCustomers=\{props\.onOpenCustomers\}\/>/, "首页显示在线用户");
const workspace = read("../src/features/customers/CustomerWorkspace.tsx");
assert.match(workspace, /<CustomerPresenceBrief customer=\{customer\}\/>/, "客户列表显示在线状态");
assert.match(workspace, /<CustomerPresenceFacts customer=\{customer\}\/>/, "账号/团队资料显示在线详情");
const members = read("../src/features/customers/CustomerMembers.tsx");
assert.match(members, /<Table\.Th>在线状态<\/Table\.Th>/, "团队成员表显示在线状态");
assert.match(members, /<MemberPresenceDetails userId=\{member\.userId\}\/>/, "成员详情显示在线详情");

console.log("admin presence checks passed");
