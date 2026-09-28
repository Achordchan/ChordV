import "reflect-metadata";
import assert from "node:assert/strict";
import { SUPPORT_CONTACT_PROFILE_FIELDS } from "@chordv/shared";
import {
  SUPPORT_LAUNCH_CONTEXT_MAX_BYTES,
  buildSupportContactAttributes,
  describeConnection,
  describeNode,
  describePlan,
  describeRecentErrors,
  formatDuration,
  parseSupportLaunchContext,
  sanitizeClientText,
  truncateUnits
} from "../src/modules/support/support-contact-context";
import { SupportContactContextService } from "../src/modules/support/support-contact-context.service";

/**
 * 打开工单时附带的联系人资料：客户端诊断信息的白名单校验、后台补齐的连接与套餐、
 * 以及发给 Achord Connect 的资料字段格式（键名、个数、长度）。
 */

const NOW = new Date("2026-09-28T02:30:00.000Z");
// 与 Achord Connect 连接配置的资料字段校验一致（src/modules/integrations/universal/schemas.ts、profile.ts）。
const ACHORD_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const ACHORD_RESERVED_KEYS = new Set(["id", "name", "email", "username", "avatar_url", "token", "secret", "password", "api_key", "client_secret"]);

function testFieldListMatchesAchordRules() {
  assert.equal(SUPPORT_CONTACT_PROFILE_FIELDS.length, 10, "Achord Connect 每个连接最多 10 个资料字段");
  const keys = new Set<string>();
  for (const field of SUPPORT_CONTACT_PROFILE_FIELDS) {
    assert.match(field.key, ACHORD_KEY_PATTERN, `${field.key}：键名只能是小写字母开头的小写字母、数字、下划线`);
    assert.ok(field.key.length <= 40);
    assert.ok(!ACHORD_RESERVED_KEYS.has(field.key), `${field.key} 是工单系统保留字段`);
    assert.ok(field.label.length >= 1 && field.label.length <= 60);
    assert.equal(field.type, "text");
    keys.add(field.key);
  }
  assert.equal(keys.size, 10, "键名不重复");
}

function testContextWhitelistAndPerFieldValidation() {
  assert.deepEqual(parseSupportLaunchContext(undefined), { context: null, dropped: [], oversized: false }, "旧版客户端没有请求体");
  assert.deepEqual(parseSupportLaunchContext({}), { context: null, dropped: [], oversized: false });
  assert.equal(parseSupportLaunchContext({ context: [1, 2] }).context, null);
  assert.equal(parseSupportLaunchContext({ context: "x" }).context, null);

  const parsed = parseSupportLaunchContext({
    context: {
      appVersion: " 1.1.11（构建 21）· 待安装 1.1.12 ",
      os: "Windows 11 23H2（22631.4317，x64）",
      timezone: "Asia/Shanghai（UTC+8）",
      locale: "zh-CN",
      updateChannel: "正式版 · 自动下载开",
      connectionState: "error",
      connectionErrorCode: "runtime_exited",
      sessionId: "sess_abc-123",
      lineStatus: "正常（180 ms）",
      recentErrors: [{ code: "runtime_exited", at: "2026-09-28T02:21:00.000Z" }, { code: "http_5xx", at: "2026-09-28T02:18:00.000Z" }],
      components: "Xray 25.8.3 · 规则库 2026-09-20 · 完整",
      // 以下都不在白名单：客户端不能提供套餐、连接文字，也不能夹带其他内容。
      plan: "伪造的套餐",
      connection: "伪造的连接",
      accessToken: "should-not-pass"
    }
  });
  assert.deepEqual(parsed.context, {
    appVersion: "1.1.11（构建 21）· 待安装 1.1.12",
    os: "Windows 11 23H2（22631.4317，x64）",
    timezone: "Asia/Shanghai（UTC+8）",
    locale: "zh-CN",
    updateChannel: "正式版 · 自动下载开",
    connectionState: "error",
    connectionErrorCode: "runtime_exited",
    sessionId: "sess_abc-123",
    lineStatus: "正常（180 ms）",
    recentErrors: [{ code: "runtime_exited", at: "2026-09-28T02:21:00.000Z" }, { code: "http_5xx", at: "2026-09-28T02:18:00.000Z" }],
    components: "Xray 25.8.3 · 规则库 2026-09-20 · 完整"
  });
  assert.deepEqual(parsed.dropped, []);

  // 不合格的字段只丢弃该项。
  const partial = parseSupportLaunchContext({
    context: {
      appVersion: "1.1.11",
      os: 42,
      locale: "中文",
      connectionState: "hacked",
      connectionErrorCode: "Runtime Exited: /Users/me/xray",
      sessionId: "../../etc",
      lineStatus: "x".repeat(81),
      recentErrors: [{ code: "ok_code", at: "2026-09-28T02:21:00.000Z" }, { code: "bad code", at: "2026-09-28T02:21:00.000Z" }],
      components: "Xray 25.8.3"
    }
  });
  assert.deepEqual(partial.context, { appVersion: "1.1.11", components: "Xray 25.8.3" });
  assert.deepEqual(new Set(partial.dropped), new Set(["os", "locale", "connectionState", "connectionErrorCode", "sessionId", "lineStatus", "recentErrors"]));
  assert.equal(parseSupportLaunchContext({ context: { recentErrors: new Array(4).fill({ code: "a", at: "2026-09-28T02:21:00.000Z" }) } }).context?.recentErrors, undefined, "最多 3 条");
  assert.equal(parseSupportLaunchContext({ context: { recentErrors: [{ code: "a", at: "yesterday" }] } }).context?.recentErrors, undefined);
  assert.equal(parseSupportLaunchContext({ context: { recentErrors: [{ code: "a", at: "2026-09-28T02:21:00.000Z", message: "raw text" }] } }).context?.recentErrors?.[0] && Object.keys(parseSupportLaunchContext({ context: { recentErrors: [{ code: "a", at: "2026-09-28T02:21:00.000Z", message: "raw text" }] } }).context!.recentErrors![0]).join(), "code,at", "错误条目只保留编号和时间");

  // 整体超过 4 KB 丢弃。
  const oversized = parseSupportLaunchContext({ context: { appVersion: "1", padding: "x".repeat(SUPPORT_LAUNCH_CONTEXT_MAX_BYTES) } });
  assert.equal(oversized.context, null);
  assert.equal(oversized.oversized, true);
}

function testSensitiveTextIsDropped() {
  for (const value of [
    "https://sub.example.com/abc",
    "vless://uuid@host:443",
    "连接 1.2.3.4 失败",
    "server 2001:db8::1:2:3",
    "user@example.com",
    "/Users/me/Library/xray",
    "C:\\Users\\me\\AppData",
    "~/Library",
    "token abcdefghijklmnopqrstuvwxyz0123456789ABCD"
  ]) {
    assert.equal(sanitizeClientText(value), null, `${value} 应被丢弃`);
    assert.equal(parseSupportLaunchContext({ context: { os: value } }).context?.os, undefined);
  }
  for (const value of [
    "macOS 15.1（24B83，arm64）",
    "Windows 11 23H2（22631.4317，x64）",
    "Asia/Shanghai（UTC+8）",
    "Xray 25.8.3 · 规则库 2026-09-20 · 完整",
    "1.1.11（构建 21）· 待安装 1.1.12",
    "正常（180 ms）"
  ]) {
    assert.equal(sanitizeClientText(value), value, `${value} 应保留`);
  }
  assert.equal(sanitizeClientText("a\u0000b\u202ec\n d"), "a b c d", "去掉控制字符与方向控制符");
}

function testServerFilledFields() {
  const lease = { connectionMode: "rule", issuedAt: new Date(NOW.getTime() - 72 * 60_000), node: { name: "香港 02", protocol: "vless", security: "reality" } };
  assert.equal(describeConnection({ state: "connected", errorCode: null, lease, now: NOW }), "已连接 · 规则模式 · 香港 02（VLESS Reality） · 1 小时 12 分");
  assert.equal(describeConnection({ state: "connected", errorCode: null, lease: null, now: NOW }), "已连接（后台没有对应的有效会话）");
  assert.equal(describeConnection({ state: "connected", errorCode: null, lease: "unknown", now: NOW }), "已连接");
  assert.equal(describeConnection({ state: "connecting", errorCode: null, lease, now: NOW }), "正在连接 · 规则模式 · 香港 02（VLESS Reality）");
  assert.equal(describeConnection({ state: "disconnected", errorCode: null, lease, now: NOW }), "未连接");
  assert.equal(describeConnection({ state: "error", errorCode: "runtime_exited", lease: null, now: NOW }), "连接失败（runtime_exited）");
  assert.equal(describeConnection({ state: "error", errorCode: null, lease: null, now: NOW }), "连接失败");
  assert.equal(describeConnection({ state: null, errorCode: null, lease, now: NOW }), "未知（后台有进行中的会话 · 规则模式 · 香港 02（VLESS Reality） · 1 小时 12 分）");
  assert.equal(describeConnection({ state: null, errorCode: null, lease: null, now: NOW }), "未知");
  assert.equal(describeNode({ name: "东京", protocol: "vless", security: "tls" }), "东京（VLESS TLS）");
  assert.equal(describeNode({ name: "东京", protocol: "vless", security: "none" }), "东京（VLESS）");
  assert.equal(describeNode({ name: " ", protocol: "bad proto!", security: "" }), "未命名节点");
  assert.equal(formatDuration(30_000), "不到 1 分钟");
  assert.equal(formatDuration(12 * 60_000), "12 分钟");
  assert.equal(formatDuration(120 * 60_000), "2 小时");
  assert.equal(formatDuration((51 * 60) * 60_000), "2 天 3 小时");

  assert.equal(describePlan({ scope: "personal", planName: "标准版", state: "active", expireAt: new Date("2026-12-31T08:00:00.000Z"), remainingTrafficGb: 120.54 }), "个人 · 标准版 · 正常 · 2026-12-31 到期 · 剩余 120.5 GB");
  assert.equal(describePlan({ scope: "personal", planName: "标准版", state: "active", expireAt: new Date("2026-12-30T17:00:00.000Z"), remainingTrafficGb: 12.5 }), "个人 · 标准版 · 正常 · 2026-12-31 到期 · 剩余 12.5 GB", "到期日按北京时间");
  assert.equal(describePlan({ scope: "team", planName: "团队版", state: "exhausted", expireAt: new Date("2026-12-31T08:00:00.000Z"), remainingTrafficGb: -1 }), "团队 · 团队版 · 流量已用尽 · 2026-12-31 到期 · 团队剩余 0 GB");
  assert.equal(describePlan(null), "无订阅");

  assert.equal(describeRecentErrors([{ code: "http_5xx", at: "2026-09-28T02:18:00.000Z" }, { code: "runtime_exited", at: "2026-09-28T02:21:00.000Z" }], "Asia/Shanghai（UTC+8）", NOW), "runtime_exited 10:21、http_5xx 10:18", "新的在前，按客户端时区显示");
  assert.equal(describeRecentErrors([{ code: "runtime_exited", at: "2026-09-27T02:21:00.000Z" }], "Asia/Shanghai", NOW), "runtime_exited 09-27 10:21", "不是今天的带日期");
  assert.equal(describeRecentErrors([{ code: "runtime_exited", at: "2026-09-28T02:21:00.000Z" }], "Not/AZone", NOW), "runtime_exited 10:21", "时区无效时按北京时间");
  assert.equal(describeRecentErrors([], "Asia/Shanghai", NOW), "无");
  assert.equal(describeRecentErrors(undefined, undefined, NOW), "未知");
}

function testAttributesShapeAndServerAuthority() {
  const context = parseSupportLaunchContext({
    context: { appVersion: "1.1.11", os: "macOS 15.1（24B83，arm64）", plan: "伪造", connection: "伪造", recentErrors: [] }
  }).context;
  const attributes = buildSupportContactAttributes({ context, connection: "未连接", plan: "个人 · 标准版 · 正常 · 2026-12-31 到期 · 剩余 120.5 GB", now: NOW });
  assert.deepEqual(Object.keys(attributes), SUPPORT_CONTACT_PROFILE_FIELDS.map((field) => field.key), "正好是声明的 10 个字段");
  assert.equal(attributes.plan, "个人 · 标准版 · 正常 · 2026-12-31 到期 · 剩余 120.5 GB", "套餐只取后台");
  assert.equal(attributes.connection, "未连接", "连接只取后台组装的结果");
  assert.equal(attributes.app_version, "1.1.11");
  assert.equal(attributes.timezone, "未知", "客户端没提供的字段显示未知");
  assert.equal(attributes.recent_errors, "无");
  for (const value of Object.values(attributes)) {
    assert.equal(typeof value, "string");
    assert.ok(value.length >= 1 && value.length <= 500);
    assert.equal(value, value.trim());
  }
  const legacy = buildSupportContactAttributes({ context: null, connection: "未知", plan: "无订阅", now: NOW });
  assert.equal(legacy.app_version, "未知（旧版客户端）");
  assert.equal(legacy.recent_errors, "未知");
  const long = buildSupportContactAttributes({ context: null, connection: "😀".repeat(400), plan: "无订阅", now: NOW });
  assert.ok(long.connection.length <= 500, "按 UTF-16 码元不超过 500");
  assert.equal(truncateUnits("😀😀", 3), "😀", "不拆开代理对");
}

type LeaseRow = { sessionId: string; userId: string; status: string; expiresAt: Date; issuedAt: Date; connectionMode: string | null; node: Record<string, unknown> };

function createFakePrisma(input: { leases?: LeaseRow[]; team?: boolean; failLease?: boolean; failPlan?: boolean; slowPlan?: boolean }) {
  const leaseQueries: unknown[] = [];
  const personal = [
    { state: "expired", expireAt: new Date("2026-06-30T08:00:00.000Z"), remainingTrafficGb: 0, createdAt: new Date(), plan: { name: "旧套餐" } },
    { state: "active", expireAt: new Date("2026-12-31T08:00:00.000Z"), remainingTrafficGb: 120.5, createdAt: new Date(), plan: { name: "标准版" } }
  ];
  const teamSubscriptions = [{ state: "active", expireAt: new Date("2026-03-01T08:00:00.000Z"), remainingTrafficGb: 50, createdAt: new Date(), plan: { name: "团队版" } }];
  const prisma = {
    nodeSessionLease: {
      findFirst: async (args: any) => {
        leaseQueries.push(args.where);
        if (input.failLease) throw new Error("connection refused");
        const rows = (input.leases ?? [])
          .filter((row) => row.userId === args.where.userId && row.status === args.where.status && row.expiresAt > args.where.expiresAt.gt)
          .filter((row) => !args.where.sessionId || row.sessionId === args.where.sessionId)
          .sort((left, right) => right.issuedAt.getTime() - left.issuedAt.getTime());
        const row = rows[0];
        if (!row) return null;
        // 只按 select 返回字段：服务不应读取节点地址、端口、UUID、密钥。
        assert.deepEqual(args.select, { connectionMode: true, issuedAt: true, node: { select: { name: true, protocol: true, security: true } } });
        return { connectionMode: row.connectionMode, issuedAt: row.issuedAt, node: { name: row.node.name, protocol: row.node.protocol, security: row.node.security } };
      }
    },
    teamMember: {
      findUnique: async () => {
        if (input.failPlan) throw new Error("db down");
        if (input.slowPlan) await new Promise((resolve) => setTimeout(resolve, 5_000));
        return input.team ? { team: { subscriptions: teamSubscriptions } } : null;
      }
    },
    subscription: { findMany: async () => personal }
  };
  return { prisma, leaseQueries };
}

const NODE = { name: "香港 02", protocol: "vless", security: "reality", serverHost: "203.0.113.9", serverPort: 443, uuid: "11111111-2222-3333-4444-555555555555", realityPublicKey: "pubkey_secret" };

async function testContextServiceUsesDatabase() {
  const now = new Date();
  const leases: LeaseRow[] = [
    { sessionId: "sess_mine", userId: "user_1", status: "active", expiresAt: new Date(now.getTime() + 60_000), issuedAt: new Date(now.getTime() - 72 * 60_000), connectionMode: "rule", node: NODE },
    { sessionId: "sess_other_device", userId: "user_1", status: "active", expiresAt: new Date(now.getTime() + 60_000), issuedAt: new Date(now.getTime() - 5 * 60_000), connectionMode: "global", node: { ...NODE, name: "东京 01" } },
    { sessionId: "sess_someone_else", userId: "user_2", status: "active", expiresAt: new Date(now.getTime() + 60_000), issuedAt: now, connectionMode: "direct", node: NODE }
  ];
  const { prisma, leaseQueries } = createFakePrisma({ leases });
  const service = new SupportContactContextService(prisma as never);
  const logs: string[] = [];
  (service as unknown as { logger: unknown }).logger = { warn: (message: string) => logs.push(message) };

  const mine = await service.buildAttributes("user_1", { connectionState: "connected", sessionId: "sess_mine" }, now);
  assert.equal(mine.connection, "已连接 · 规则模式 · 香港 02（VLESS Reality） · 1 小时 12 分", "按本机会话 ID 找会话");
  assert.equal(mine.plan, "个人 · 标准版 · 正常 · 2026-12-31 到期 · 剩余 120.5 GB");
  assert.doesNotMatch(JSON.stringify(mine), /203\.0\.113\.9|443|11111111|pubkey_secret|sess_/, "不含节点地址、端口、UUID、密钥或会话 ID");

  const otherUser = await service.buildAttributes("user_2", { connectionState: "connected", sessionId: "sess_mine" }, now);
  assert.equal(otherUser.connection, "已连接（后台没有对应的有效会话）", "会话 ID 必须属于当前用户");

  const noSession = await service.buildAttributes("user_1", { connectionState: "connected" }, now);
  assert.match(noSession.connection, /东京 01/, "没带会话 ID 时取最近的一条有效会话");

  leaseQueries.length = 0;
  const disconnected = await service.buildAttributes("user_1", { connectionState: "disconnected" }, now);
  assert.equal(disconnected.connection, "未连接");
  assert.equal(leaseQueries.length, 0, "客户端未连接时不查会话（可能是别的设备的连接）");
  const failed = await service.buildAttributes("user_1", { connectionState: "error", connectionErrorCode: "runtime_exited" }, now);
  assert.equal(failed.connection, "连接失败（runtime_exited）");

  const legacy = await service.buildAttributes("user_1", null, now);
  assert.match(legacy.connection, /^未知（后台有进行中的会话/, "旧版客户端：只能给出后台会话情况");
  assert.equal(legacy.app_version, "未知（旧版客户端）");

  const team = await new SupportContactContextService(createFakePrisma({ team: true }).prisma as never).buildAttributes("user_1", {}, now);
  assert.equal(team.plan, "团队 · 团队版 · 已到期 · 2026-03-01 到期 · 团队剩余 50 GB", "团队成员看团队订阅，状态按到期时间折算");
  assert.equal(team.connection, "未知");

  const broken = new SupportContactContextService(createFakePrisma({ failLease: true, failPlan: true }).prisma as never);
  (broken as unknown as { logger: unknown }).logger = { warn: (message: string) => logs.push(message) };
  const degraded = await broken.buildAttributes("user_1", { connectionState: "connected", appVersion: "1.1.11" }, now);
  assert.equal(degraded.connection, "已连接", "会话查询失败不说“没有会话”");
  assert.equal(degraded.plan, "未知");
  assert.equal(degraded.app_version, "1.1.11");
  assert.ok(logs.some((line) => line.includes("按未知处理")));

  const slow = new SupportContactContextService(createFakePrisma({ slowPlan: true }).prisma as never);
  (slow as unknown as { logger: unknown }).logger = { warn: () => undefined };
  const started = Date.now();
  const timedOut = await slow.buildAttributes("user_1", {}, now);
  assert.ok(Date.now() - started < 3_000, "数据库慢时不拖慢打开工单");
  assert.equal(timedOut.plan, "未知");
}

async function main() {
  testFieldListMatchesAchordRules();
  testContextWhitelistAndPerFieldValidation();
  testSensitiveTextIsDropped();
  testServerFilledFields();
  testAttributesShapeAndServerAuthority();
  await testContextServiceUsesDatabase();
  console.log("support contact context regression checks passed");
}

main().then(() => process.exit(0), (error) => {
  console.error(error);
  process.exit(1);
});
