import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import type { AdminPresenceSessionDto, AdminPresenceSnapshotDto, AdminUserPresenceDto } from "@chordv/shared";
import type { AdminRuntimeEventDto } from "../src/api/client";
import { createPresenceStore } from "../src/features/presence/presence-store";
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

function createStoreHarness() {
  let visible = true;
  let active = 0, maxActive = 0, eventStarts = 0, eventStops = 0;
  const events = new Set<(event: { type: string }) => void>();
  const visibility = new Set<() => void>();
  const requests: Array<{ resolve: (value: AdminPresenceSnapshotDto) => void; reject: (error: Error) => void }> = [];
  const store = createPresenceStore({
    fetch: () => {
      active++; maxActive = Math.max(active, maxActive);
      return new Promise((resolvePromise, rejectPromise) => {
        requests.push({ resolve(value) { active--; resolvePromise(value); }, reject(error) { active--; rejectPromise(error); } });
      });
    },
    subscribeEvents: listener => {
      eventStarts++; events.add(listener);
      return () => { eventStops++; events.delete(listener); };
    },
    visible: () => visible,
    onVisibilityChange: listener => { visibility.add(listener); return () => { visibility.delete(listener); }; }
  });
  return {
    store, requests, events, visibility,
    counts: () => ({ active, maxActive, eventStarts, eventStops }),
    emit: (type: string) => { for (const listener of [...events]) listener({ type }); },
    setVisible: (value: boolean) => { visible = value; for (const listener of [...visibility]) listener(); }
  };
}
const flush = () => new Promise<void>(resolvePromise => setImmediate(resolvePromise));

await test("共享在线状态初次只读一次，事件合并补读，隐藏暂停、恢复和resync刷新", async () => {
  const h = createStoreHarness(), { store, requests } = h;
  let renders = 0;
  const stopA = store.subscribe(() => { renders += 1; });
  const stopB = store.subscribe(() => undefined);
  assert.equal(requests.length, 1, "两个组件同时使用只拉一次");
  assert.equal(h.counts().eventStarts, 1, "只订阅一份共享事件传输");
  assert.equal(store.getState().loading, true);
  h.emit("presence_updated"); h.emit("presence_updated"); h.emit("resync"); h.emit("ticket_updated");
  assert.equal(requests.length, 1, "请求进行中再次触发不并发");
  requests[0].resolve(snapshot);
  await flush();
  assert.equal(store.getState().snapshot, snapshot);
  const lookup = store.getState().byUser;
  assert.equal(lookup.get("u_idle")?.state, "online", "查找表随快照建好，列表各行直接取用");
  assert.equal(store.getState().byUser, lookup, "同一份快照只建一次查找表");
  assert.equal(requests.length, 2, "请求期间多次在线变化和resync合并成一次补读");
  requests[1].resolve(snapshot);
  await flush();
  assert.ok(renders > 0);
  assert.equal(store.getState().loading, false);
  h.emit("ticket_updated"); h.emit("keepalive");
  await flush();
  assert.equal(requests.length, 2, "无关事件或空闲不产生业务读取");
  h.setVisible(false); h.emit("presence_updated"); h.emit("resync"); await store.refresh();
  assert.equal(requests.length, 2, "页面隐藏不发请求");
  h.setVisible(true);
  assert.equal(requests.length, 3, "回到页面立即核对在线状态");
  requests[2].resolve(snapshot);
  await flush();
  h.emit("resync");
  assert.equal(requests.length, 4, "流重连resync独立刷新presence，不依赖App整套快照");
  requests[3].resolve(snapshot);
  await flush();
  assert.equal(h.counts().maxActive, 1);
  stopA(); stopA();
  assert.equal(h.events.size, 1, "重复退订不能误停另一个组件的订阅");
  stopB(); stopB();
  assert.equal(h.events.size, 0); assert.equal(h.visibility.size, 0);
  assert.equal(h.counts().eventStops, 1, "最后一个组件卸载只清理一次");
  await store.refresh(); assert.equal(requests.length, 4, "无订阅时显式refresh也不发请求");
});

await test("卸载后在途结果隔离，新订阅等待同一请求结束并只补读一次", async () => {
  const h = createStoreHarness(), { store, requests } = h;
  const stopA = store.subscribe(() => undefined);
  const oldEvent = [...h.events][0], oldVisibility = [...h.visibility][0];
  h.emit("presence_updated"); stopA();
  assert.equal(store.getState().loading, false);
  const stopB = store.subscribe(() => undefined);
  assert.equal(requests.length, 1, "跨挂载代次仍保持单飞");
  assert.equal(store.getState().loading, true);
  const stale = { ...snapshot, generatedAt: "2026-01-01T00:00:00Z" };
  requests[0].resolve(stale); await flush();
  assert.equal(store.getState().snapshot, null, "旧代次结果不能写入新订阅");
  assert.equal(store.getState().error, null);
  assert.equal(store.getState().loading, true, "旧请求finally不能清除新请求loading");
  assert.equal(requests.length, 2);
  oldEvent({ type: "presence_updated" }); oldVisibility();
  requests[1].resolve(snapshot); await flush();
  assert.equal(requests.length, 2, "已退订代次的迟到回调不能排入额外补读");
  assert.equal(store.getState().snapshot, snapshot); assert.equal(store.getState().loading, false);
  assert.equal(h.counts().maxActive, 1); stopB();
});

await test("错误只显示中文状态，下一次事件恢复，不定时重试且旧代次失败不污染新订阅", async () => {
  const h = createStoreHarness(), { store, requests } = h;
  const stopA = store.subscribe(() => undefined);
  stopA(); const stopB = store.subscribe(() => undefined);
  requests[0].reject(new Error("test-only stale request failed")); await flush();
  assert.equal(store.getState().error, null, "过期请求失败不能污染新订阅");
  requests[1].reject(new Error("HTTP 503")); await flush();
  assert.equal(store.getState().error, "在线状态暂时不可用，状态变化或返回页面时将重试。");
  assert.equal(store.getState().loading, false);
  await flush(); assert.equal(requests.length, 2, "失败不触发后台重试循环");
  h.emit("presence_updated"); requests[2].resolve(snapshot); await flush();
  assert.equal(store.getState().snapshot, snapshot); assert.equal(store.getState().error, null);
  stopB();
});

await test("相同回调的多个订阅相互独立，最后卸载时丢弃待补读", async () => {
  const h = createStoreHarness(); let renders = 0;
  const listener = () => { renders++; };
  const stopA = h.store.subscribe(listener), stopB = h.store.subscribe(listener);
  stopA(); stopA(); const before = renders;
  h.requests[0].resolve(snapshot); await flush();
  assert.ok(renders > before, "相同函数的第一个订阅退出不移除第二个订阅");
  h.emit("presence_updated"); h.emit("resync"); stopB(); stopB();
  const previous = h.store.getState().snapshot;
  h.requests[1].resolve({ ...snapshot, counts: { online: 0, connected: 0, idle: 0 } }); await flush();
  assert.equal(h.requests.length, 2, "最后卸载清除待补读，不发第三个请求");
  assert.equal(h.store.getState().snapshot, previous, "无订阅时在途响应不能覆盖快照");
  assert.equal(h.store.getState().loading, false);
});

await test("隐藏页面初次订阅不读取，隐藏期间合并事件在恢复可见时一次核对", async () => {
  const h = createStoreHarness(); h.setVisible(false);
  const stop = h.store.subscribe(() => undefined);
  h.emit("presence_updated"); h.emit("resync");
  assert.equal(h.requests.length, 0); assert.equal(h.store.getState().loading, false);
  h.setVisible(true); assert.equal(h.requests.length, 1);
  h.emit("presence_updated"); h.setVisible(false);
  h.requests[0].resolve(snapshot); await flush();
  assert.equal(h.requests.length, 1, "响应期间页面隐藏时不执行待补读");
  h.emit("resync"); h.emit("presence_updated");
  h.setVisible(true); assert.equal(h.requests.length, 2, "恢复页面只拉一份最新状态");
  stop(); h.requests[1].reject(new Error("test-only request completed after unsubscribe")); await flush();
  assert.equal(h.store.getState().loading, false); assert.equal(h.store.getState().error, null);
  assert.equal(h.events.size, 0); assert.equal(h.visibility.size, 0);
});

// 页面接入
const read = (path: string) => readFileSync(resolve(import.meta.dirname, path), "utf8");
for (const path of ["../src/features/presence/presence-store.ts", "../src/features/presence/usePresence.ts"]) {
  assert.doesNotMatch(read(path), /\b(?:setInterval|clearInterval|setTimeout|PRESENCE_POLL_MS)\b/, "presence不允许业务轮询或自动重试定时器");
}
const panel = read("../src/features/presence/OnlineUsersPanel.tsx");
assert.doesNotMatch(panel, /30\s*秒自动刷新|十几分钟|connectedMinutes/);
assert.match(panel, /snapshot\?\.connectedWindowSeconds/);
assert.match(panel, /snapshot\?\.onlineWindowSeconds/);
assert.match(panel, /上下线和心跳超时由服务端推送更新，返回页面时重新核对/);
const app = read("../src/App.tsx");
assert.match(app, /sections\.has\("resync"\)[\s\S]*?await loadFullSnapshot\(\)/, "App仍独立处理整套数据resync");
const overview = read("../src/pages/OverviewPage.tsx");
assert.match(overview, /<OnlineUsersPanel onOpenCustomers=\{props\.onOpenCustomers\}\/>/, "首页显示在线用户");
const workspace = read("../src/features/customers/CustomerWorkspace.tsx");
assert.match(workspace, /<CustomerPresenceBrief customer=\{customer\}\/>/, "客户列表显示在线状态");
assert.match(workspace, /<CustomerPresenceFacts customer=\{customer\}\/>/, "账号/团队资料显示在线详情");
const members = read("../src/features/customers/CustomerMembers.tsx");
assert.match(members, /<Table\.Th>在线状态<\/Table\.Th>/, "团队成员表显示在线状态");
assert.match(members, /<MemberPresenceDetails userId=\{member\.userId\}\/>/, "成员详情显示在线详情");

console.log("admin presence checks passed");
