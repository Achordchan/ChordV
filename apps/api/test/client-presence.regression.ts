import "reflect-metadata";
import assert from "node:assert/strict";
import { Subject } from "rxjs";
import {
  buildAdminPresenceSnapshot,
  ClientPresenceService,
  isLeaseConnected,
  isPresenceOnline,
  normalizeConnectionMode,
  PRESENCE_CONNECTED_WINDOW_SECONDS,
  PRESENCE_ONLINE_WINDOW_SECONDS,
  resolveOnlineSince,
  type PresenceLeaseRow
} from "../src/modules/common/client-presence.service";
import { LEASE_GRACE_SECONDS } from "../src/modules/common/runtime-session.utils";
import { RuntimeSessionService } from "../src/modules/common/runtime-session.service";

const now = new Date("2026-09-27T12:00:00Z");
const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);
const later = (seconds: number) => new Date(now.getTime() + seconds * 1000);

function lease(overrides: Partial<PresenceLeaseRow> = {}): PresenceLeaseRow {
  return {
    sessionId: "session_1",
    userId: "user_1",
    status: "active",
    issuedAt: ago(600),
    expiresAt: later(1200),
    lastHeartbeatAt: ago(20),
    connectionMode: "rule",
    node: { id: "node_hk", name: "香港 01", region: "香港", countryCode: "HK", provider: "云厂商", protocol: "vless", security: "reality" },
    subscription: {
      id: "sub_1",
      teamId: null,
      state: "active",
      expireAt: later(86_400 * 10),
      totalTrafficGb: 100,
      usedTrafficGb: 12.3456,
      remainingTrafficGb: 87.6544,
      plan: { name: "标准版" },
      team: null
    },
    ...overrides
  };
}

function testDerivation() {
  assert.equal(isLeaseConnected(lease(), now), true, "活跃且近期心跳的连接算已连接");
  assert.equal(isLeaseConnected(lease({ lastHeartbeatAt: ago(PRESENCE_CONNECTED_WINDOW_SECONDS + 1) }), now), false, "超过心跳窗口不再算已连接");
  assert.equal(isLeaseConnected(lease({ status: "revoked" }), now), false, "已撤销的连接不算");
  assert.equal(isLeaseConnected(lease({ expiresAt: ago(LEASE_GRACE_SECONDS + 1) }), now), false, "超过宽限期的租约不算");
  assert.ok(PRESENCE_CONNECTED_WINDOW_SECONDS >= 90, "至少容忍连续错过两次 30 秒心跳");

  assert.equal(isPresenceOnline({ online: true, lastSeenAt: ago(30) }, now), true);
  assert.equal(isPresenceOnline({ online: false, lastSeenAt: ago(1) }, now), false, "已记离线");
  assert.equal(isPresenceOnline({ online: true, lastSeenAt: ago(PRESENCE_ONLINE_WINDOW_SECONDS + 1) }, now), false, "进程异常退出后超过窗口按离线处理");
  assert.equal(isPresenceOnline(null, now), false);

  const since = ago(3600);
  assert.equal(resolveOnlineSince({ onlineSince: since, lastSeenAt: ago(20) }, now), since, "短暂断线重连沿用原在线起始时间");
  assert.equal(resolveOnlineSince({ onlineSince: since, lastSeenAt: ago(PRESENCE_ONLINE_WINDOW_SECONDS + 5) }, now), now, "离线较久后重新计时");
  assert.equal(resolveOnlineSince({ onlineSince: later(10), lastSeenAt: ago(5) }, now), now, "起始时间晚于现在（时钟回拨）时重新计时");
  assert.equal(resolveOnlineSince(null, now), now);

  assert.equal(normalizeConnectionMode("global"), "global");
  assert.equal(normalizeConnectionMode("rule"), "rule");
  assert.equal(normalizeConnectionMode(null), null);
  assert.equal(normalizeConnectionMode("<script>"), null, "未知模式不透传到后台");
}

function testSnapshot() {
  const users = [
    { id: "user_1", displayName: "张三", email: "a@example.com", teamMemberships: [] },
    { id: "user_2", displayName: "李四", email: "b@example.com", teamMemberships: [{ team: { id: "team_1", name: "设计部" } }] },
    { id: "user_3", displayName: "王五", email: "c@example.com", teamMemberships: [] },
    { id: "user_4", displayName: "赵六", email: "d@example.com", teamMemberships: [] },
    { id: "user_5", displayName: "孙七", email: "e@example.com", teamMemberships: [] }
  ];
  const snapshot = buildAdminPresenceSnapshot({
    now,
    users,
    presence: [
      { userId: "user_1", online: true, onlineSince: ago(1800), lastSeenAt: ago(40) },
      { userId: "user_2", online: true, onlineSince: ago(300), lastSeenAt: ago(10) },
      { userId: "user_3", online: false, onlineSince: ago(9000), lastSeenAt: ago(7200) },
      { userId: "user_4", online: true, onlineSince: ago(9000), lastSeenAt: ago(PRESENCE_ONLINE_WINDOW_SECONDS + 60) }
    ],
    leases: [
      lease(),
      lease({ sessionId: "session_2", issuedAt: ago(3600), node: { ...lease().node, id: "node_jp", name: "日本 02", countryCode: "JP" }, connectionMode: null }),
      lease({ sessionId: "session_stale", userId: "user_3", lastHeartbeatAt: ago(PRESENCE_CONNECTED_WINDOW_SECONDS + 30) }),
      lease({ sessionId: "session_bad_mode", userId: "user_5", connectionMode: "weird", subscription: { ...lease().subscription!, teamId: "team_9", team: { name: "市场部" } } })
    ],
    clientVersions: [
      { userId: "user_1", platform: "macos", version: "1.1.10", build: 3, channel: "stable", lastSeenAt: ago(120) },
      { userId: "user_1", platform: "windows", version: "1.1.9", build: null, channel: "stable", lastSeenAt: ago(86_400) },
      { userId: "user_5", platform: "windows", version: "1.1.10", build: null, channel: "beta", lastSeenAt: ago(30) }
    ]
  });

  assert.deepEqual(snapshot.counts, { online: 3, connected: 2, idle: 1 });
  assert.equal(snapshot.connectedWindowSeconds, PRESENCE_CONNECTED_WINDOW_SECONDS);
  assert.deepEqual(snapshot.users.map((user) => [user.userId, user.state]), [
    ["user_1", "connected"],
    ["user_5", "connected"],
    ["user_2", "online"],
    ["user_4", "offline"],
    ["user_3", "offline"]
  ], "已连接在前（在线更久的在前），其次在线，离线按最近在线倒序");

  const first = snapshot.users[0];
  assert.equal(first.sessions.length, 2, "同一用户多台设备各算一条连接");
  assert.deepEqual(first.sessions.map((session) => session.node.name), ["日本 02", "香港 01"], "连接按建立时间先后");
  assert.equal(first.sessions[1].connectionMode, "rule");
  assert.equal(first.sessions[0].connectionMode, null, "旧连接没有记录模式");
  assert.equal(first.sessions[1].subscription?.usedTrafficGb, 12.346);
  assert.equal(first.sessions[1].subscription?.ownerType, "user");
  assert.equal(first.onlineSince, ago(3600).toISOString(), "连接早于推送连接记录时，在线起始取更早的一次");
  assert.equal(first.lastOnlineAt, now.toISOString());
  assert.equal(first.client?.platform, "macos", "客户端取最近使用的平台");

  const connectedWithoutPresence = snapshot.users[1];
  assert.equal(connectedWithoutPresence.onlineSince, ago(600).toISOString(), "没有推送连接记录时以连接建立时间为在线起始");
  assert.equal(connectedWithoutPresence.sessions[0].connectionMode, null, "未知模式按未记录处理");
  assert.equal(connectedWithoutPresence.sessions[0].subscription?.ownerType, "team");
  assert.equal(connectedWithoutPresence.sessions[0].subscription?.teamName, "市场部");

  const idle = snapshot.users[2];
  assert.equal(idle.teamName, "设计部");
  assert.equal(idle.onlineSince, ago(300).toISOString());
  assert.deepEqual(idle.sessions, []);

  const staleOnline = snapshot.users.find((user) => user.userId === "user_4")!;
  assert.equal(staleOnline.onlineSince, null);
  assert.equal(staleOnline.lastOnlineAt, ago(PRESENCE_ONLINE_WINDOW_SECONDS + 60).toISOString());

  const offline = snapshot.users.find((user) => user.userId === "user_3")!;
  assert.equal(offline.lastOnlineAt, ago(7200).toISOString(), "心跳已超时的旧连接不再显示为已连接，最近在线仍取推送连接记录");
  assert.deepEqual(offline.sessions, []);

  const onlyVersion = buildAdminPresenceSnapshot({
    now,
    users: [users[0], users[2]],
    presence: [],
    leases: [],
    clientVersions: [{ userId: "user_1", platform: "macos", version: "1.1.10", build: null, channel: "stable", lastSeenAt: ago(86_400) }]
  });
  assert.deepEqual(onlyVersion.users.map((user) => [user.userId, user.state, user.lastOnlineAt]), [["user_1", "offline", ago(86_400).toISOString()]],
    "上线前没有推送连接记录的用户，用检查更新时间作为最近在线；从未出现过的用户不列出");
}

type Row = { userId: string; online: boolean; onlineSince: Date | null; lastSeenAt: Date };

function matchesDate(value: Date, condition: any) {
  if (condition instanceof Date) return value.getTime() === condition.getTime();
  if ("lte" in condition) return value.getTime() <= condition.lte.getTime();
  if ("gte" in condition) return value.getTime() >= condition.gte.getTime();
  if ("lt" in condition) return value.getTime() < condition.lt.getTime();
  throw new Error("unsupported date condition");
}

function matches(row: Row, where: any) {
  if (typeof where.userId === "string" && row.userId !== where.userId) return false;
  if (where.userId?.in && !where.userId.in.includes(row.userId)) return false;
  if (where.online !== undefined && row.online !== where.online) return false;
  if (where.lastSeenAt && !matchesDate(row.lastSeenAt, where.lastSeenAt)) return false;
  return true;
}

function createService() {
  const rows = new Map<string, Row>();
  const calls = { upserts: 0, updateMany: 0, findUnique: 0 };
  const events: string[] = [];
  const prisma = {
    userClientPresence: {
      findUnique: async ({ where }: any) => {
        calls.findUnique += 1;
        const row = rows.get(where.userId);
        return row ? { ...row } : null;
      },
      upsert: async ({ where, create, update }: any) => {
        calls.upserts += 1;
        const existing = rows.get(where.userId);
        rows.set(where.userId, existing ? { ...existing, ...update } : { ...create });
      },
      updateMany: async ({ where, data }: any) => {
        calls.updateMany += 1;
        let count = 0;
        for (const row of rows.values()) {
          if (!matches(row, where)) continue;
          Object.assign(row, data);
          count += 1;
        }
        return { count };
      },
      findMany: async ({ where }: any) => [...rows.values()].filter((row) => matches(row, where)).map((row) => ({ userId: row.userId }))
    }
  };
  const service = new ClientPresenceService(prisma as never, { publishPresenceUpdated: () => events.push("presence_updated") } as never);
  (service as unknown as { logger: { warn(): void } }).logger = { warn: () => undefined };
  service.offlineGraceMs = 20;
  return { service, rows, calls, events };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function testStreamTracking() {
  const { service, rows, calls, events } = createService();
  service.streamOpened("user_1", now);
  await settle();
  assert.deepEqual(rows.get("user_1"), { userId: "user_1", online: true, onlineSince: now, lastSeenAt: now }, "第一条推送连接打开即记为在线");
  assert.deepEqual(events, ["presence_updated"], "上线通知后台刷新");

  service.streamOpened("user_1", later(5));
  await settle();
  assert.equal(calls.upserts, 1, "同一用户第二台设备打开不重复写库");

  service.streamClosed("user_1", later(10));
  await wait(40);
  assert.equal(rows.get("user_1")?.online, true, "还有一条连接时保持在线");

  service.streamClosed("user_1", later(20));
  service.streamOpened("user_1", later(21));
  await wait(40);
  assert.equal(rows.get("user_1")?.online, true, "断开后很快重连不记离线");
  assert.equal(calls.upserts, 1, "快速重连不重复写库");

  service.streamClosed("user_1", later(30));
  await wait(40);
  assert.equal(rows.get("user_1")?.online, false, "全部断开且超过宽限后记为离线");
  assert.equal(rows.get("user_1")?.lastSeenAt.getTime(), later(30).getTime(), "离线时间取断开时刻，作为最近在线时间");
  assert.deepEqual(events, ["presence_updated", "presence_updated"]);

  // 另一实例在断开之后刷新过：说明客户端仍在线，不能被这里的离线覆盖。
  rows.set("user_2", { userId: "user_2", online: true, onlineSince: ago(100), lastSeenAt: later(60) });
  service.streamOpened("user_2", later(40));
  await settle();
  assert.equal(rows.get("user_2")?.lastSeenAt.getTime(), later(60).getTime(), "上线记录不让最近在线时间倒退");
  service.streamClosed("user_2", later(50));
  await wait(40);
  assert.equal(rows.get("user_2")?.online, true, "断开时间早于最近刷新时不写离线");

  // 重新上线：距上次在线超过窗口则重新计时，窗口内沿用。
  const reopenAt = later(30 + PRESENCE_ONLINE_WINDOW_SECONDS + 1);
  service.streamOpened("user_1", reopenAt);
  await settle();
  assert.equal(rows.get("user_1")?.onlineSince?.getTime(), reopenAt.getTime());
  service.streamClosed("user_1", reopenAt);
  service.onModuleDestroy();
}

async function testTrackStream() {
  const { service, rows } = createService();
  const source = new Subject<string>();
  const received: string[] = [];
  const subscription = service.trackStream("user_9", source.asObservable()).subscribe((value) => received.push(value));
  await settle();
  assert.equal(service.localOnlineUserCount(), 1, "订阅推送流即计为在线");
  assert.equal(rows.get("user_9")?.online, true);
  source.next("keepalive");
  assert.deepEqual(received, ["keepalive"], "包装后事件照常转发");
  subscription.unsubscribe();
  assert.equal(service.localOnlineUserCount(), 0, "取消订阅即计为断开");
  await wait(40);
  assert.equal(rows.get("user_9")?.online, false);
  service.onModuleDestroy();
}

async function testRefresh() {
  const { service, rows, calls } = createService();
  service.streamOpened("user_a", ago(120));
  service.streamOpened("user_b", ago(120));
  service.streamOpened("user_c", ago(120));
  await settle();
  rows.delete("user_b");
  rows.get("user_c")!.lastSeenAt = ago(PRESENCE_ONLINE_WINDOW_SECONDS + 10);
  calls.upserts = 0;
  await service.refreshOnlineUsers(now);
  assert.equal(rows.get("user_a")?.lastSeenAt.getTime(), now.getTime(), "保持连接的用户刷新最近在线时间");
  assert.equal(rows.get("user_a")?.onlineSince?.getTime(), ago(120).getTime(), "刷新不改变在线起始时间");
  assert.equal(rows.get("user_b")?.online, true, "记录缺失（之前写库失败）时补写");
  assert.equal(rows.get("user_c")?.onlineSince?.getTime(), now.getTime(), "已超出窗口的记录重新计时");
  assert.equal(calls.upserts, 2, "只有缺失或过期的记录逐个补写");

  calls.upserts = 0;
  calls.updateMany = 0;
  await service.refreshOnlineUsers(later(60));
  assert.equal(calls.updateMany, 1, "稳定状态下每次刷新只有一条批量更新");
  assert.equal(calls.upserts, 0);
  service.onModuleDestroy();
}

async function testAdminQuery() {
  const seen: Record<string, any> = {};
  const prisma = {
    userClientPresence: { findMany: async (args: any) => { seen.presence = args; return [{ userId: "user_1", online: true, onlineSince: ago(60), lastSeenAt: ago(5) }]; } },
    nodeSessionLease: { findMany: async (args: any) => { seen.leases = args; return [lease({ userId: "user_2" })]; } },
    userClientVersion: { findMany: async (args: any) => { seen.versions = args; return []; } },
    user: {
      findMany: async (args: any) => {
        seen.users = args;
        return [
          { id: "user_1", displayName: "张三", email: "a@example.com", teamMemberships: [] },
          { id: "user_2", displayName: "李四", email: "b@example.com", teamMemberships: [] }
        ];
      }
    }
  };
  const service = new ClientPresenceService(prisma as never, { publishPresenceUpdated: () => undefined } as never);
  const snapshot = await service.getAdminPresenceSnapshot(now);
  assert.equal(seen.leases.where.status, "active", "只查活跃连接");
  assert.equal(seen.leases.where.lastHeartbeatAt.gte.getTime(), ago(PRESENCE_CONNECTED_WINDOW_SECONDS).getTime(), "只查心跳窗口内的连接，走 (status, lastHeartbeatAt) 索引");
  assert.equal(seen.leases.where.expiresAt.gt.getTime(), ago(LEASE_GRACE_SECONDS).getTime());
  assert.equal(seen.leases.select.node.select.serverHost, undefined, "不向后台列表带出节点连接凭据");
  assert.equal(seen.leases.select.xrayUserUuid, undefined);
  assert.deepEqual([...seen.users.where.id.in].sort(), ["user_1", "user_2"], "用户资料一次批量查询，不逐个查");
  assert.equal(seen.users.select.passwordHash, undefined);
  assert.deepEqual(snapshot.counts, { online: 2, connected: 1, idle: 1 });

  const failing = new ClientPresenceService({
    userClientPresence: { findMany: async () => { throw Object.assign(new Error("connection terminated"), { code: "P1001" }); } },
    nodeSessionLease: { findMany: async () => [] },
    userClientVersion: { findMany: async () => [] },
    user: { findMany: async () => [] }
  } as never, { publishPresenceUpdated: () => undefined } as never);
  await assert.rejects(failing.getAdminPresenceSnapshot(now), (error: any) => error?.getStatus?.() === 503, "数据库暂不可用时返回 503 而不是 500");
}

async function testRuntimeSessionRecordsModeAndNotifies() {
  const leases: any[] = [];
  let presenceEvents = 0;
  const service = Object.assign(Object.create(RuntimeSessionService.prototype), {
    logger: { warn: () => undefined, log: () => undefined },
    prisma: {
      nodeSessionLease: {
        create: async ({ data }: any) => { leases.push({ ...data }); return data; },
        findUnique: async ({ where }: any) => leases.find((row) => row.id === where.id) ?? null,
        updateMany: async ({ where, data }: any) => {
          const row = leases.find((item) => item.id === where.id && where.status.in.includes(item.status));
          if (!row) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        }
      },
      securityEvent: { create: async () => undefined }
    },
    adminRuntimeEventsService: { publishPresenceUpdated: () => { presenceEvents += 1; } },
    clientRuntimeEventsService: { publishToUser: () => undefined },
    ensurePanelClientBinding: async () => ({ panelClientEmail: "user_1@lease", panelClientId: "uuid-1" }),
    readConnectInboundRuntimeBestEffort: async (node: any) => ({ ok: true, ...node }),
    updateConnectedNodeRuntimeBestEffort: async () => undefined,
    resolveNodeMeteringIncidentBestEffort: async () => undefined
  }) as any;
  const node = {
    id: "node_hk", name: "香港 01", region: "香港", provider: "p", tags: [], recommended: false, latencyMs: 0, protocol: "vless", security: "reality",
    serverHost: "hk.example.com", serverPort: 443, serverName: "sni", uuid: "u", flow: "xtls-rprx-vision", realityPublicKey: "k", shortId: "s",
    fingerprint: "chrome", spiderX: "/", mldsa65Verify: "", controlMode: "direct_primary"
  };
  const access = { subscription: { id: "sub_1", teamId: null, expireAt: later(86_400) } };
  const runtime = await service.connectWithManagedNode(node, { id: "user_1", email: "a@example.com", displayName: "张三" }, access, { nodeId: "node_hk", mode: "global" }, null, []);
  assert.equal(leases[0].connectionMode, "global", "连接时记录所选模式，供后台显示");
  assert.equal(runtime.mode, "global");
  assert.equal(presenceEvents, 1, "建立连接通知后台刷新在线列表");

  await service.revokeLease(leases[0].id, { id: "node_hk", flow: "xtls-rprx-vision" }, "revoked_by_client");
  assert.equal(leases[0].status, "revoked");
  assert.equal(presenceEvents, 2, "断开或撤销连接通知后台刷新在线列表");
  await service.revokeLease(leases[0].id, { id: "node_hk", flow: "xtls-rprx-vision" }, "revoked_by_client");
  assert.equal(presenceEvents, 2, "重复撤销不重复通知");
}

async function main() {
  testDerivation();
  testSnapshot();
  await testStreamTracking();
  await testTrackStream();
  await testRefresh();
  await testAdminQuery();
  await testRuntimeSessionRecordsModeAndNotifies();
  console.log("client presence regression checks passed");
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
