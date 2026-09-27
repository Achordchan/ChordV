import "reflect-metadata";
import assert from "node:assert/strict";
import { Subject } from "rxjs";
import {
  buildAdminPresenceSnapshot,
  buildOnlineStartResetCondition,
  ClientPresenceService,
  isLeaseConnected,
  isStreamLive,
  normalizeConnectionMode,
  PRESENCE_CONNECTED_WINDOW_SECONDS,
  PRESENCE_HEARTBEAT_HISTORY_MS,
  PRESENCE_ONLINE_WINDOW_SECONDS,
  PRESENCE_STREAM_STALE_CLEANUP_MS,
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

  assert.equal(isStreamLive({ lastSeenAt: ago(30) }, now), true);
  assert.equal(isStreamLive({ lastSeenAt: ago(PRESENCE_ONLINE_WINDOW_SECONDS + 1) }, now), false, "进程异常退出后超过窗口按离线处理");

  const since = ago(3600);
  assert.equal(resolveOnlineSince({ onlineSince: since, lastSeenAt: ago(20) }, now), since, "短暂断线重连沿用原在线起始时间");
  assert.equal(resolveOnlineSince({ onlineSince: since, lastSeenAt: ago(PRESENCE_ONLINE_WINDOW_SECONDS + 5) }, now), now, "离线较久后重新计时");
  assert.equal(resolveOnlineSince({ onlineSince: later(10), lastSeenAt: ago(5) }, now), now, "起始时间晚于现在（时钟回拨）时重新计时");
  assert.equal(resolveOnlineSince({ onlineSince: null, lastSeenAt: ago(5) }, now), now, "只有心跳记录（从未打开推送连接）时从现在算起");
  assert.equal(resolveOnlineSince(null, now), now);

  // 数据库条件与 resolveOnlineSince 同一规则：命中条件时重置在线开始时间。
  const samples = [
    { onlineSince: since, lastSeenAt: ago(20) },
    { onlineSince: since, lastSeenAt: ago(PRESENCE_ONLINE_WINDOW_SECONDS) },
    { onlineSince: since, lastSeenAt: ago(PRESENCE_ONLINE_WINDOW_SECONDS + 1) },
    { onlineSince: later(10), lastSeenAt: ago(5) },
    { onlineSince: now, lastSeenAt: ago(5) },
    { onlineSince: null, lastSeenAt: ago(5) },
    { onlineSince: since, lastSeenAt: later(30) }
  ];
  for (const sample of samples) {
    const reset = matches({ userId: "user_1", ...sample }, buildOnlineStartResetCondition("user_1", now));
    assert.equal(reset, resolveOnlineSince(sample, now) === now && sample.onlineSince?.getTime() !== now.getTime(), `条件与规则一致：${JSON.stringify(sample)}`);
  }
  assert.equal(matches({ userId: "user_2", onlineSince: null, lastSeenAt: ago(5) }, buildOnlineStartResetCondition("user_1", now)), false, "只作用于指定用户");

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
    { id: "user_5", displayName: "孙七", email: "e@example.com", teamMemberships: [] },
    { id: "user_6", displayName: "周八", email: "f@example.com", teamMemberships: [] }
  ];
  const snapshot = buildAdminPresenceSnapshot({
    now,
    users,
    presence: [
      { userId: "user_1", onlineSince: ago(1800), lastSeenAt: ago(40) },
      { userId: "user_2", onlineSince: ago(300), lastSeenAt: ago(10) },
      { userId: "user_3", onlineSince: ago(9000), lastSeenAt: ago(7200) },
      { userId: "user_4", onlineSince: ago(9000), lastSeenAt: ago(PRESENCE_ONLINE_WINDOW_SECONDS + 60) }
    ],
    streams: [
      { userId: "user_1", connectedAt: ago(1800), lastSeenAt: ago(40) },
      // 同一用户在两个进程上各有一台设备：任一进程的记录在窗口内即为在线。
      { userId: "user_2", connectedAt: ago(300), lastSeenAt: ago(PRESENCE_ONLINE_WINDOW_SECONDS + 30) },
      { userId: "user_2", connectedAt: ago(200), lastSeenAt: ago(10) },
      // 只剩异常退出进程留下的过期记录。
      { userId: "user_4", connectedAt: ago(9000), lastSeenAt: ago(PRESENCE_ONLINE_WINDOW_SECONDS + 60) },
      // 没有最近在线记录（例如写库失败）时，在线起始取推送连接开始时间。
      { userId: "user_6", connectedAt: ago(90), lastSeenAt: ago(20) }
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

  assert.deepEqual(snapshot.counts, { online: 4, connected: 2, idle: 2 });
  assert.equal(snapshot.connectedWindowSeconds, PRESENCE_CONNECTED_WINDOW_SECONDS);
  assert.deepEqual(snapshot.users.map((user) => [user.userId, user.state]), [
    ["user_1", "connected"],
    ["user_5", "connected"],
    ["user_2", "online"],
    ["user_6", "online"],
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

  const connectedWithoutStream = snapshot.users[1];
  assert.equal(connectedWithoutStream.onlineSince, ago(600).toISOString(), "没有推送连接时以节点连接建立时间为在线起始");
  assert.equal(connectedWithoutStream.sessions[0].connectionMode, null, "未知模式按未记录处理");
  assert.equal(connectedWithoutStream.sessions[0].subscription?.ownerType, "team");
  assert.equal(connectedWithoutStream.sessions[0].subscription?.teamName, "市场部");

  const idle = snapshot.users[2];
  assert.equal(idle.teamName, "设计部");
  assert.equal(idle.onlineSince, ago(300).toISOString());
  assert.deepEqual(idle.sessions, []);
  assert.equal(snapshot.users[3].onlineSince, ago(90).toISOString());

  const staleOnline = snapshot.users.find((user) => user.userId === "user_4")!;
  assert.equal(staleOnline.onlineSince, null);
  assert.equal(staleOnline.lastOnlineAt, ago(PRESENCE_ONLINE_WINDOW_SECONDS + 60).toISOString());

  const offline = snapshot.users.find((user) => user.userId === "user_3")!;
  assert.equal(offline.lastOnlineAt, ago(7200).toISOString(), "心跳已超时的旧连接不再显示为已连接，最近在线取最近在线记录");
  assert.deepEqual(offline.sessions, []);

  const onlyVersion = buildAdminPresenceSnapshot({
    now,
    users: [users[0], users[2]],
    presence: [],
    streams: [],
    leases: [],
    clientVersions: [{ userId: "user_1", platform: "macos", version: "1.1.10", build: null, channel: "stable", lastSeenAt: ago(86_400) }]
  });
  assert.deepEqual(onlyVersion.users.map((user) => [user.userId, user.state, user.lastOnlineAt]), [["user_1", "offline", ago(86_400).toISOString()]],
    "上线前没有在线记录的用户，用检查更新时间作为最近在线；从未出现过的用户不列出");
}

type PresenceRowState = { userId: string; onlineSince: Date | null; lastSeenAt: Date };
type StreamRowState = { userId: string; instanceId: string; connectedAt: Date; lastSeenAt: Date };

// 按 Prisma/SQL 的语义求值条件（NULL 与比较运算不相等），用来验证条件本身而不是测试替身。
function matchesValue(value: any, condition: any): boolean {
  if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime();
  if (condition === null || typeof condition !== "object") return value === condition;
  if ("in" in condition) return condition.in.includes(value);
  if ("not" in condition) return value !== null && value !== condition.not;
  if (value === null || value === undefined) return false;
  const time = value instanceof Date ? value.getTime() : value;
  const bound = (input: any) => (input instanceof Date ? input.getTime() : input);
  if ("lte" in condition) return time <= bound(condition.lte);
  if ("gte" in condition) return time >= bound(condition.gte);
  if ("lt" in condition) return time < bound(condition.lt);
  if ("gt" in condition) return time > bound(condition.gt);
  throw new Error("unsupported condition");
}

function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([key, condition]) =>
    key === "OR" ? (condition as any[]).some((item) => matches(row, item)) : matchesValue(row[key], condition)
  );
}

/** 两张表共用的内存库，可以让多个服务实例（模拟多个 API 进程）同时读写。 */
function createStore() {
  const presence = new Map<string, PresenceRowState>();
  const streams = new Map<string, StreamRowState>();
  const calls = { presenceUpserts: 0, presenceUpdateMany: 0, streamUpserts: 0, streamUpdateMany: 0 };
  const prisma = {
    userClientPresence: {
      findUnique: async ({ where }: any) => {
        const row = presence.get(where.userId);
        return row ? { ...row } : null;
      },
      upsert: async ({ where, create, update }: any) => {
        calls.presenceUpserts += 1;
        const existing = presence.get(where.userId);
        presence.set(where.userId, existing ? { ...existing, ...update } : { ...create });
      },
      updateMany: async ({ where, data }: any) => {
        calls.presenceUpdateMany += 1;
        let count = 0;
        for (const row of presence.values()) {
          if (!matches(row, where)) continue;
          Object.assign(row, data);
          count += 1;
        }
        return { count };
      },
      createMany: async ({ data, skipDuplicates }: any) => {
        assert.equal(skipDuplicates, true);
        let count = 0;
        for (const row of data) {
          if (presence.has(row.userId)) continue;
          presence.set(row.userId, { ...row });
          count += 1;
        }
        return { count };
      }
    },
    userClientPresenceStream: {
      count: async ({ where }: any) => [...streams.values()].filter((row) => matches(row, where)).length,
      upsert: async ({ where, create, update }: any) => {
        calls.streamUpserts += 1;
        const key = `${where.userId_instanceId.userId}:${where.userId_instanceId.instanceId}`;
        const existing = streams.get(key);
        streams.set(key, existing ? { ...existing, ...update } : { ...create });
      },
      updateMany: async ({ where, data }: any) => {
        calls.streamUpdateMany += 1;
        let count = 0;
        for (const row of streams.values()) {
          if (!matches(row, where)) continue;
          Object.assign(row, data);
          count += 1;
        }
        return { count };
      },
      findMany: async ({ where }: any) => [...streams.values()].filter((row) => matches(row, where)).map((row) => ({ userId: row.userId })),
      deleteMany: async ({ where }: any) => {
        let count = 0;
        for (const [key, row] of streams) {
          if (!matches(row, where)) continue;
          streams.delete(key);
          count += 1;
        }
        return { count };
      }
    }
  };
  const liveStreams = (userId: string, at: Date) => [...streams.values()].filter((row) => row.userId === userId && isStreamLive(row, at));
  return { prisma, presence, streams, calls, liveStreams };
}

function createService(store = createStore()) {
  const events: string[] = [];
  const service = new ClientPresenceService(store.prisma as never, { publishPresenceUpdated: () => events.push("presence_updated") } as never);
  (service as unknown as { logger: { warn(): void } }).logger = { warn: () => undefined };
  service.offlineGraceMs = 20;
  return { service, events, ...store };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function testStreamTracking() {
  const { service, presence, streams, calls, events, liveStreams } = createService();
  service.streamOpened("user_1", now);
  await settle();
  assert.deepEqual(presence.get("user_1"), { userId: "user_1", onlineSince: now, lastSeenAt: now }, "第一条推送连接打开即记录在线开始时间");
  assert.equal(liveStreams("user_1", now).length, 1, "本进程为该用户保留一条推送连接记录");
  assert.deepEqual(events, ["presence_updated"], "上线通知后台刷新");

  service.streamOpened("user_1", later(5));
  await settle();
  assert.equal(calls.streamUpserts, 1, "同一用户第二台设备打开不重复写库");

  service.streamClosed("user_1", later(10));
  await wait(40);
  assert.equal(liveStreams("user_1", later(10)).length, 1, "还有一条连接时保持在线");

  service.streamClosed("user_1", later(20));
  service.streamOpened("user_1", later(21));
  await wait(40);
  assert.equal(liveStreams("user_1", later(21)).length, 1, "断开后很快重连不记离线");
  assert.equal(calls.streamUpserts, 1, "快速重连不重复写库");

  service.streamClosed("user_1", later(30));
  await wait(40);
  assert.equal(streams.size, 0, "全部断开且超过宽限后删除本进程的记录");
  assert.equal(presence.get("user_1")?.lastSeenAt.getTime(), later(30).getTime(), "最近在线时间推进到断开时刻");
  assert.deepEqual(events, ["presence_updated", "presence_updated"]);

  // 重新上线：距上次在线超过窗口则重新计时。
  const reopenAt = later(30 + PRESENCE_ONLINE_WINDOW_SECONDS + 1);
  service.streamOpened("user_1", reopenAt);
  await settle();
  assert.equal(presence.get("user_1")?.onlineSince?.getTime(), reopenAt.getTime());
  service.streamClosed("user_1", reopenAt);
  service.onModuleDestroy();
}

async function testMultipleInstances() {
  const store = createStore();
  const first = createService(store);
  const second = createService(store);
  assert.notEqual(first.service.instanceId, second.service.instanceId);

  // 手机连在实例一，电脑连在实例二。
  first.service.streamOpened("user_m", ago(60));
  await settle();
  second.service.streamOpened("user_m", ago(30));
  await settle();
  assert.equal(second.events.length, 0, "另一进程已记在线时不重复推送上线");
  assert.equal(store.presence.get("user_m")?.onlineSince?.getTime(), ago(60).getTime(), "第二台设备沿用在线开始时间");

  // 实例二已把最近在线推进到更晚的时间，实例一此后才处理一条更早的上线：最近在线不能倒退。
  store.presence.get("user_m")!.lastSeenAt = later(5);
  await (first.service as unknown as { advancePresenceOrThrow(userId: string, at: Date): Promise<void> }).advancePresenceOrThrow("user_m", ago(1));
  assert.equal(store.presence.get("user_m")?.lastSeenAt.getTime(), later(5).getTime(), "跨进程写入由数据库条件保证只前进不后退");
  store.presence.get("user_m")!.lastSeenAt = ago(30);

  // 实例二上的电脑断开：实例一上的手机仍在线，不能被记成离线。
  second.service.streamClosed("user_m", now);
  await wait(40);
  assert.equal(store.liveStreams("user_m", now).length, 1, "只删除本进程的记录，另一进程的仍在");
  const snapshot = buildAdminPresenceSnapshot({
    now,
    users: [{ id: "user_m", displayName: "多设备", email: "m@example.com", teamMemberships: [] }],
    presence: [...store.presence.values()],
    streams: [...store.streams.values()],
    leases: [],
    clientVersions: []
  });
  assert.equal(snapshot.users[0].state, "online", "另一实例仍保持推送连接，用户保持在线");

  // 异常退出的进程留下的过期记录由其他进程定期清理。
  store.streams.set("user_x:dead", { userId: "user_x", instanceId: "dead", connectedAt: ago(7200), lastSeenAt: new Date(now.getTime() - PRESENCE_STREAM_STALE_CLEANUP_MS - 1000) });
  await first.service.refreshOnlineUsers(now);
  assert.equal(store.streams.has("user_x:dead"), false);
  first.service.onModuleDestroy();
  second.service.onModuleDestroy();
}

async function testTrackStream() {
  const { service, streams, liveStreams } = createService();
  const source = new Subject<string>();
  const received: string[] = [];
  const subscription = service.trackStream("user_9", source.asObservable()).subscribe((value) => received.push(value));
  await settle();
  assert.equal(service.localOnlineUserCount(), 1, "订阅推送流即计为在线");
  assert.equal(liveStreams("user_9", new Date()).length, 1);
  source.next("keepalive");
  assert.deepEqual(received, ["keepalive"], "包装后事件照常转发");
  subscription.unsubscribe();
  assert.equal(service.localOnlineUserCount(), 0, "取消订阅即计为断开");
  await wait(40);
  assert.equal(streams.size, 0);
  service.onModuleDestroy();
}

async function testRefresh() {
  const { service, presence, streams, calls } = createService();
  service.streamOpened("user_a", ago(120));
  service.streamOpened("user_b", ago(120));
  await settle();
  streams.delete(`user_b:${service.instanceId}`);
  calls.streamUpserts = 0;
  await service.refreshOnlineUsers(now);
  assert.equal(streams.get(`user_a:${service.instanceId}`)?.lastSeenAt.getTime(), now.getTime(), "保持连接的用户刷新推送连接记录");
  assert.equal(presence.get("user_a")?.lastSeenAt.getTime(), now.getTime(), "并推进最近在线时间");
  assert.equal(presence.get("user_a")?.onlineSince?.getTime(), ago(120).getTime(), "刷新不改变在线起始时间");
  assert.ok(streams.has(`user_b:${service.instanceId}`), "记录缺失（之前写库失败或被清理）时补写");
  assert.equal(calls.streamUpserts, 1, "只有缺失的记录逐个补写");

  calls.streamUpserts = 0;
  calls.streamUpdateMany = 0;
  calls.presenceUpdateMany = 0;
  await service.refreshOnlineUsers(later(60));
  assert.equal(calls.streamUpdateMany, 1, "稳定状态下每次刷新只有两条批量更新");
  assert.equal(calls.presenceUpdateMany, 1);
  assert.equal(calls.streamUpserts, 0);
  service.onModuleDestroy();
}

async function testHeartbeatHistory() {
  const { service, presence, streams, calls, events } = createService();
  // 推送连接断开后仍在用节点：最近在线时间跟随心跳前进，但不改变在线判定。
  presence.set("user_h", { userId: "user_h", onlineSince: ago(3600), lastSeenAt: ago(600) });
  service.noteHeartbeat("user_h", ago(30));
  await settle();
  assert.equal(presence.get("user_h")?.lastSeenAt.getTime(), ago(30).getTime(), "心跳时刻计入最近在线");
  assert.equal(presence.get("user_h")?.onlineSince?.getTime(), ago(30).getTime(), "离线一段时间后恢复心跳，在线开始时间从心跳算起");
  assert.equal(streams.size, 0, "心跳不产生推送连接记录，不会被当成在线");
  const writes = calls.presenceUpdateMany;
  service.noteHeartbeat("user_h", ago(10));
  await settle();
  assert.equal(calls.presenceUpdateMany, writes, "每位用户每分钟最多写一次");
  service.noteHeartbeat("user_h", later(40));
  await settle();
  assert.equal(presence.get("user_h")?.lastSeenAt.getTime(), later(40).getTime());

  service.noteHeartbeat("user_new", now);
  await settle();
  assert.deepEqual(presence.get("user_new"), { userId: "user_new", onlineSince: now, lastSeenAt: now }, "没有记录时补一条");

  // 进程异常退出后留下的旧记录同样会被心跳推进（记录里没有在线标记，不存在“卡在在线”的情况）。
  presence.set("user_crash", { userId: "user_crash", onlineSince: ago(9000), lastSeenAt: ago(9000) });
  service.noteHeartbeat("user_crash", now);
  await settle();
  assert.equal(presence.get("user_crash")?.lastSeenAt.getTime(), now.getTime());
  assert.equal(presence.get("user_crash")?.onlineSince?.getTime(), now.getTime());

  // 最近在线时间只前进不后退。
  presence.set("user_ahead", { userId: "user_ahead", onlineSince: null, lastSeenAt: later(5) });
  service.noteHeartbeat("user_ahead", now);
  await settle();
  assert.equal(presence.get("user_ahead")?.lastSeenAt.getTime(), later(5).getTime());

  // 长时间离线后先恢复节点心跳、之后才连上推送连接：在线时长从恢复心跳时算起，不接着几天前的开始时间。
  presence.set("user_resume", { userId: "user_resume", onlineSince: ago(5 * 86_400), lastSeenAt: ago(4 * 86_400) });
  service.noteHeartbeat("user_resume", ago(100));
  await settle();
  service.streamOpened("user_resume", now);
  await settle();
  assert.equal(presence.get("user_resume")?.onlineSince?.getTime(), ago(100).getTime());
  const resumed = buildAdminPresenceSnapshot({
    now,
    users: [{ id: "user_resume", displayName: "恢复", email: "r@example.com", teamMemberships: [] }],
    presence: [...presence.values()],
    streams: [...streams.values()],
    leases: [],
    clientVersions: []
  });
  assert.equal(resumed.users[0].state, "online");
  assert.equal(resumed.users[0].onlineSince, ago(100).toISOString(), "后台显示的在线时长约 100 秒，而不是几天");
  service.streamClosed("user_resume", now);

  // 本进程保持着推送连接的用户由定时刷新负责，心跳不额外写库。
  service.streamOpened("user_s", ago(5));
  await settle();
  const before = calls.presenceUpdateMany;
  service.noteHeartbeat("user_s", now);
  await settle();
  assert.equal(calls.presenceUpdateMany, before);
  assert.equal(events.length, 2, "心跳记录不推送上下线事件（两次均来自推送连接上线）");
  service.streamClosed("user_s", now);
  service.onModuleDestroy();
}

async function testAdminQuery() {
  const seen: Record<string, any> = {};
  const prisma = {
    userClientPresence: { findMany: async (args: any) => { seen.presence = args; return [{ userId: "user_1", onlineSince: ago(60), lastSeenAt: ago(5) }]; } },
    userClientPresenceStream: { findMany: async (args: any) => { seen.streams = args; return [{ userId: "user_1", connectedAt: ago(60), lastSeenAt: ago(5) }]; } },
    nodeSessionLease: {
      findMany: async (args: any) => { seen.leases = args; return [lease({ userId: "user_2" })]; },
      groupBy: async (args: any) => { seen.heartbeats = args; return [{ userId: "user_3", _max: { lastHeartbeatAt: ago(900) } }]; }
    },
    userClientVersion: { findMany: async (args: any) => { seen.versions = args; return []; } },
    user: {
      findMany: async (args: any) => {
        seen.users = args;
        return [
          { id: "user_1", displayName: "张三", email: "a@example.com", teamMemberships: [] },
          { id: "user_2", displayName: "李四", email: "b@example.com", teamMemberships: [] },
          { id: "user_3", displayName: "王五", email: "c@example.com", teamMemberships: [] }
        ];
      }
    }
  };
  const service = new ClientPresenceService(prisma as never, { publishPresenceUpdated: () => undefined } as never);
  const snapshot = await service.getAdminPresenceSnapshot(now);
  assert.equal(seen.streams.where.lastSeenAt.gte.getTime(), ago(PRESENCE_ONLINE_WINDOW_SECONDS).getTime(), "推送连接记录只查判定窗口内的");
  assert.equal(seen.leases.where.status, "active", "只查活跃连接");
  assert.equal(seen.leases.where.lastHeartbeatAt.gte.getTime(), ago(PRESENCE_CONNECTED_WINDOW_SECONDS).getTime(), "只查心跳窗口内的连接，走 lastHeartbeatAt 索引");
  assert.deepEqual(seen.heartbeats.by, ["userId"]);
  assert.equal(seen.heartbeats.where.status, undefined, "最后心跳不限租约状态：已撤销或已超时的连接也算");
  assert.equal(seen.heartbeats.where.lastHeartbeatAt.gte.getTime(), now.getTime() - PRESENCE_HEARTBEAT_HISTORY_MS, "只聚合近一天的连接，不扫全部历史租约");
  assert.equal(seen.leases.where.expiresAt.gt.getTime(), ago(LEASE_GRACE_SECONDS).getTime());
  assert.equal(seen.leases.select.node.select.serverHost, undefined, "不向后台列表带出节点连接凭据");
  assert.equal(seen.leases.select.xrayUserUuid, undefined);
  assert.deepEqual([...seen.users.where.id.in].sort(), ["user_1", "user_2", "user_3"], "用户资料一次批量查询，不逐个查");
  const recentlyDisconnected = snapshot.users.find((user) => user.userId === "user_3")!;
  assert.equal(recentlyDisconnected.state, "offline");
  assert.equal(recentlyDisconnected.lastOnlineAt, ago(900).toISOString(), "连接已撤销或超时后，最近在线取最后一次心跳");
  assert.equal(seen.users.select.passwordHash, undefined);
  assert.deepEqual(snapshot.counts, { online: 2, connected: 1, idle: 1 });

  const failing = new ClientPresenceService({
    userClientPresence: { findMany: async () => { throw Object.assign(new Error("connection terminated"), { code: "P1001" }); } },
    userClientPresenceStream: { findMany: async () => [] },
    nodeSessionLease: { findMany: async () => [], groupBy: async () => [] },
    userClientVersion: { findMany: async () => [] },
    user: { findMany: async () => [] }
  } as never, { publishPresenceUpdated: () => undefined } as never);
  await assert.rejects(failing.getAdminPresenceSnapshot(now), (error: any) => error?.getStatus?.() === 503, "数据库暂不可用时返回 503 而不是 500");
}

async function testRuntimeSessionRecordsModeAndNotifies() {
  const leases: any[] = [];
  const heartbeats: Array<[string, Date]> = [];
  let presenceEvents = 0;
  const service = Object.assign(Object.create(RuntimeSessionService.prototype), {
    logger: { warn: () => undefined, log: () => undefined },
    prisma: {
      nodeSessionLease: {
        create: async ({ data }: any) => { leases.push({ ...data }); return data; },
        findUnique: async ({ where }: any) => {
          const row = leases.find((item) => (where.id ? item.id === where.id : item.sessionId === where.sessionId));
          return row ? { ...row, node: { id: row.nodeId, flow: "xtls-rprx-vision" } } : null;
        },
        updateMany: async ({ where, data }: any) => {
          const statuses = typeof where.status === "string" ? [where.status] : where.status.in;
          const row = leases.find((item) => item.id === where.id && statuses.includes(item.status));
          if (!row) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        }
      },
      securityEvent: { create: async () => undefined }
    },
    adminRuntimeEventsService: { publishPresenceUpdated: () => { presenceEvents += 1; } },
    clientPresenceService: { noteHeartbeat: (userId: string, at: Date) => heartbeats.push([userId, at]) },
    resolveActiveUserFromToken: async () => ({ id: "user_1" }),
    assertLeaseCanHeartbeat: async () => undefined,
    refreshActiveRuntimeLease: () => undefined,
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

  await service.heartbeatSession(leases[0].sessionId, "Bearer token");
  assert.equal(heartbeats.length, 1, "心跳成功后记录最近在线时间");
  assert.equal(heartbeats[0][0], "user_1");

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
  await testMultipleInstances();
  await testTrackStream();
  await testRefresh();
  await testHeartbeatHistory();
  await testAdminQuery();
  await testRuntimeSessionRecordsModeAndNotifies();
  console.log("client presence regression checks passed");
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
