import "reflect-metadata";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { BadRequestException, GoneException, HttpException, Module, UnauthorizedException, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  ACHORD_CONNECT_WEBHOOK_MAX_BODY_BYTES,
  AchordConnectRequestError,
  buildLaunchTicketBody,
  createAchordConnectLaunchTicket,
  isAchordConnectWebhookRequest,
  normalizeAchordConnectBaseUrl,
  parseAchordConnectWebhookEvent,
  verifyAchordConnectWebhookSignature
} from "../src/modules/support/achord-connect";
import {
  SUPPORT_UNREAD_RESYNC_AFTER_MS,
  SUPPORT_UNREAD_RESYNC_MAX_PER_MINUTE,
  SUPPORT_UNREAD_RESYNC_MIN_INTERVAL_MS,
  SupportIntegrationService
} from "../src/modules/support/support-integration.service";
import {
  AchordConnectWebhookController,
  AdminSupportIntegrationController,
  ClientSupportController,
  UpdateSupportIntegrationConfigDto
} from "../src/modules/support/support.controller";
import { AdminAuthGuard } from "../src/modules/common/admin-auth.guard";
import { AuthSessionService } from "../src/modules/common/auth-session.service";
import { ClientAuthGuard } from "../src/modules/common/client-auth.guard";
import {
  LEGACY_CLIENT_TICKET_WRITE_MESSAGE,
  LegacyAdminTicketWriteGuard,
  LegacyClientTicketWriteGuard
} from "../src/modules/common/legacy-support-tickets.guard";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// 全部为明显的假值，不是任何真实凭据。
const BASE_URL = "https://support.example.test";
const CLIENT_ID = "ac_fake_client_id";
const CLIENT_SECRET = "acs_fake_client_secret_for_tests";
const WEBHOOK_SECRET = "whsec_fake_webhook_secret_for_tests";

type Row = Record<string, any>;

/** 按 Prisma 语义实现用到的那部分接口的内存数据库；事务失败会整体回滚。 */
function createFakePrisma(options: { users?: string[] } = {}) {
  const users = new Set(options.users ?? ["user_1", "user_2"]);
  let settings = new Map<string, Row>();
  let events = new Map<string, Row>();
  let states = new Map<string, Row>();
  let requests = new Map<string, Row>();
  const locks: string[] = [];
  const failures = { stateUpdate: 0 };
  const requestKey = (userId: string, requestId: string) => `${userId}\u0000${requestId}`;
  const clone = <T extends Map<string, Row>>(map: T) => new Map([...map].map(([key, value]) => [key, { ...value }])) as T;
  const prisma: any = {
    systemSetting: {
      findUnique: async ({ where }: any) => (settings.has(where.key) ? { ...settings.get(where.key) } : null),
      findUniqueOrThrow: async ({ where }: any) => {
        if (!settings.has(where.key)) throw new Error("not found");
        return { ...settings.get(where.key) };
      },
      createMany: async ({ data, skipDuplicates }: any) => {
        let count = 0;
        for (const item of data) {
          if (settings.has(item.key)) {
            if (!skipDuplicates) throw new Error("unique violation");
            continue;
          }
          settings.set(item.key, { key: item.key, value: structuredClone(item.value), updatedAt: new Date() });
          count += 1;
        }
        return { count };
      },
      update: async ({ where, data }: any) => {
        const row = { ...settings.get(where.key), value: structuredClone(data.value), updatedAt: new Date() };
        settings.set(where.key, row);
        return { ...row };
      }
    },
    user: {
      findUnique: async ({ where }: any) => (users.has(where.id) ? { id: where.id } : null)
    },
    achordConnectWebhookEvent: {
      createMany: async ({ data, skipDuplicates }: any) => {
        let count = 0;
        for (const item of data) {
          if (events.has(item.eventId)) {
            if (!skipDuplicates) throw new Error("unique violation");
            continue;
          }
          events.set(item.eventId, { ...item, receivedAt: item.receivedAt ?? new Date() });
          count += 1;
        }
        return { count };
      },
      deleteMany: async ({ where }: any) => {
        let count = 0;
        for (const [key, row] of events) {
          if (row.receivedAt < where.receivedAt.lt) {
            events.delete(key);
            count += 1;
          }
        }
        return { count };
      }
    },
    supportUnreadState: {
      createMany: async ({ data, skipDuplicates }: any) => {
        let count = 0;
        for (const item of data) {
          if (!users.has(item.userId)) throw new Error("foreign key violation");
          if (states.has(item.userId)) {
            if (!skipDuplicates) throw new Error("unique violation");
            continue;
          }
          states.set(item.userId, { userId: item.userId, unreadCount: 0, sourceAt: null, syncedAt: null, revision: 0, requestsComplete: true });
          count += 1;
        }
        return { count };
      },
      findUnique: async ({ where }: any) => (states.has(where.userId) ? { ...states.get(where.userId) } : null),
      findUniqueOrThrow: async ({ where }: any) => {
        if (!states.has(where.userId)) throw new Error("not found");
        return { ...states.get(where.userId) };
      },
      findMany: async ({ where }: any) =>
        [...states.values()]
          .filter((row) => (where.unreadCount.gt !== undefined ? row.unreadCount > where.unreadCount.gt : row.unreadCount >= where.unreadCount.gte))
          .map((row) => ({ userId: row.userId, unreadCount: row.unreadCount, revision: row.revision })),
      updateMany: async ({ data }: any) => {
        const { revision, ...rest } = data;
        for (const [key, row] of states) {
          states.set(key, { ...row, ...rest, revision: row.revision + (revision?.increment ?? 0) });
        }
        return { count: states.size };
      },
      update: async ({ where, data }: any) => {
        if (failures.stateUpdate > 0) {
          failures.stateUpdate -= 1;
          throw new Error("database write failed");
        }
        const current = states.get(where.userId)!;
        const { revision, ...rest } = data;
        const row = { ...current, ...rest, revision: revision?.increment ? current.revision + revision.increment : current.revision };
        states.set(where.userId, row);
        return { ...row };
      }
    },
    supportRequestUnread: {
      findUnique: async ({ where }: any) => {
        const row = requests.get(requestKey(where.userId_requestId.userId, where.userId_requestId.requestId));
        return row ? { ...row } : null;
      },
      create: async ({ data }: any) => {
        requests.set(requestKey(data.userId, data.requestId), { ...data });
        return { ...data };
      },
      update: async ({ where, data }: any) => {
        const key = requestKey(where.userId_requestId.userId, where.userId_requestId.requestId);
        requests.set(key, { ...requests.get(key), ...data });
        return { ...requests.get(key) };
      },
      upsert: async ({ where, create, update }: any) => {
        const key = requestKey(where.userId_requestId.userId, where.userId_requestId.requestId);
        requests.set(key, requests.has(key) ? { ...requests.get(key), ...update } : { ...create });
        return { ...requests.get(key) };
      },

      count: async ({ where }: any) => {
        const matchesTime = (row: Row, condition: any) =>
          condition.gt !== undefined ? row.eventAt > condition.gt : row.eventAt >= condition.gte;
        const matches = (row: Row, clause: any) =>
          (clause.requestId === undefined ||
            (typeof clause.requestId === "string" ? row.requestId === clause.requestId : row.requestId !== clause.requestId.not)) &&
          matchesTime(row, clause.eventAt);
        return [...requests.values()].filter(
          (row) => row.userId === where.userId && (where.OR ? where.OR.some((clause: any) => matches(row, clause)) : matches(row, where))
        ).length;
      },
      aggregate: async ({ where }: any) => {
        let sum: number | null = null;
        for (const row of requests.values()) {
          if (row.userId === where.userId) sum = (sum ?? 0) + row.unreadCount;
        }
        return { _sum: { unreadCount: sum } };
      },
      deleteMany: async ({ where = {} }: any = {}) => {
        let count = 0;
        for (const [key, row] of requests) {
          if ((where.userId === undefined || row.userId === where.userId) && (!where.eventAt || row.eventAt <= where.eventAt.lte)) {
            requests.delete(key);
            count += 1;
          }
        }
        return { count };
      },
      createMany: async ({ data, skipDuplicates }: any) => {
        let count = 0;
        for (const item of data) {
          const key = requestKey(item.userId, item.requestId);
          if (requests.has(key)) {
            if (!skipDuplicates) throw new Error("unique violation");
            continue;
          }
          requests.set(key, { ...item });
          count += 1;
        }
        return { count };
      }
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      if (/FOR SHARE/.test(sql)) {
        assert.match(sql, /FROM "SystemSetting"/);
        locks.push(`share:${String(values[0])}`);
        const row = settings.get(String(values[0]));
        return row ? [{ value: structuredClone(row.value) }] : [];
      }
      assert.match(sql, /FOR UPDATE/);
      locks.push(String(values[0]));
      return [];
    },

    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const snapshot = { settings: clone(settings), events: clone(events), states: clone(states), requests: clone(requests) };
      try {
        return await fn(prisma);
      } catch (error) {
        ({ settings, events, states, requests } = snapshot);
        throw error;
      }
    }
  };
  return {
    prisma,
    locks,
    failures,
    state: (userId: string) => states.get(userId) ?? null,
    request: (userId: string, requestId: string) => requests.get(requestKey(userId, requestId)) ?? null,
    requestCount: () => requests.size,
    eventCount: () => events.size,
    setting: (key: string) => settings.get(key)?.value ?? null,

    seedEvent: (eventId: string, receivedAt: Date) => events.set(eventId, { eventId, type: "request.unread.changed", receivedAt })
  };
}

type FetchCall = { url: string; init: RequestInit };

function createService(options: { users?: string[] } = {}) {
  const db = createFakePrisma(options);
  const published: Array<{ userId: string; count: number }> = [];
  const logs: string[] = [];
  const fetchCalls: FetchCall[] = [];
  const service = new SupportIntegrationService(
    db.prisma,
    { get: async () => ({ primaryOrigin: "https://v.example.test", legacyOrigins: [], updatedAt: null }) } as never,
    { publishSupportUnreadUpdated: (userId: string, count: number) => published.push({ userId, count }) } as never
  );
  (service as unknown as { logger: unknown }).logger = {
    log: (message: string) => logs.push(message),
    warn: (message: string) => logs.push(message)
  };
  let responder: (call: FetchCall) => Promise<Response> = async () => {
    throw new Error("unexpected fetch");
  };
  service.fetchImpl = async (url, init) => {
    const call = { url, init };
    fetchCalls.push(call);
    return responder(call);
  };
  return {
    service,
    db,
    published,
    logs,
    fetchCalls,
    respond: (next: (call: FetchCall) => Promise<Response>) => {
      responder = next;
    }
  };
}

async function configure(service: SupportIntegrationService, extra: Record<string, unknown> = {}) {
  await service.updateAdminConfig({
    baseUrl: BASE_URL,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    webhookSecret: WEBHOOK_SECRET,
    enabled: true,
    ...extra
  });
}

/** 模拟工单系统响应；Date 头是工单系统的时钟，默认与本机一致，测试时钟偏差时单独指定。 */
function json(status: number, body: unknown, serverTime = new Date()) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", date: serverTime.toUTCString() } });
}

function sign(rawBody: string | Buffer, timestamp: string, secret = WEBHOOK_SECRET) {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex")}`;
}

let eventSequence = 0;
function unreadEvent(input: { userId?: string; requestId: string; unreadCount: number; contactUnreadCount?: number; createdAt: string; id?: string }) {
  const id = input.id ?? `evt_${++eventSequence}`;
  const data: Record<string, unknown> = {
    externalUserId: input.userId ?? "user_1",
    request: { id: input.requestId, number: 1, title: "测试请求", status: "OPEN" },
    unreadCount: input.unreadCount
  };
  if (input.contactUnreadCount !== undefined) data.contactUnreadCount = input.contactUnreadCount;
  return { id, rawBody: Buffer.from(JSON.stringify({ id, type: "request.unread.changed", createdAt: input.createdAt, data })) };
}

function webhookRequest(event: { id: string; rawBody: Buffer }, overrides: Partial<{ eventId: string; timestamp: string; signature: string }> = {}) {
  const timestamp = overrides.timestamp ?? String(Math.floor(Date.now() / 1000));
  return {
    rawBody: event.rawBody,
    eventId: overrides.eventId ?? event.id,
    timestamp,
    signature: overrides.signature ?? sign(event.rawBody, timestamp)
  };
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function rejects(promise: Promise<unknown>, type: new (...args: never[]) => Error) {
  await assert.rejects(promise, (error: unknown) => error instanceof type);
}

// ---------- 验签 ----------

function testSignatureVerification() {
  const now = Date.UTC(2026, 8, 28, 10, 0, 0);
  const timestamp = String(now / 1000);
  // 原始正文带空格、换行和中文：必须按原始字节验签，重新序列化后的 JSON 验不过。
  const rawBody = Buffer.from('{ "id": "evt_raw",\n  "type": "connector.test", "data": { "note": "中文 ✓" } }');
  const signature = sign(rawBody, timestamp);
  const base = { secret: WEBHOOK_SECRET, rawBody, timestamp, signature, nowMs: now };
  assert.equal(verifyAchordConnectWebhookSignature(base), true, "正确签名应通过");
  assert.equal(verifyAchordConnectWebhookSignature({ ...base, signature: signature.toUpperCase().replace("V1=", "v1=") }), true, "十六进制大小写不影响");
  assert.equal(verifyAchordConnectWebhookSignature({ ...base, secret: "whsec_other_fake" }), false, "密钥不同应拒绝");
  assert.equal(verifyAchordConnectWebhookSignature({ ...base, rawBody: Buffer.from(JSON.stringify(JSON.parse(rawBody.toString()))) }), false, "不能用重新序列化的 JSON 验签");
  assert.equal(verifyAchordConnectWebhookSignature({ ...base, signature: `v1=${"0".repeat(64)}` }), false);
  assert.equal(verifyAchordConnectWebhookSignature({ ...base, signature: signature.slice(3) }), false, "缺少 v1= 前缀应拒绝");
  assert.equal(verifyAchordConnectWebhookSignature({ ...base, signature: `${signature}00` }), false, "长度不对应拒绝");
  assert.equal(verifyAchordConnectWebhookSignature({ ...base, signature: undefined }), false);
  assert.equal(verifyAchordConnectWebhookSignature({ ...base, secret: "" }), false, "未配置密钥时一律拒绝");
  assert.equal(verifyAchordConnectWebhookSignature({ ...base, nowMs: now + 300_000 }), true, "300 秒内有效");
  assert.equal(verifyAchordConnectWebhookSignature({ ...base, nowMs: now + 301_000 }), false, "超过 300 秒的时间戳应拒绝");
  assert.equal(verifyAchordConnectWebhookSignature({ ...base, nowMs: now - 301_000 }), false, "未来太远的时间戳也应拒绝");
  const stale = String(now / 1000 - 301);
  assert.equal(verifyAchordConnectWebhookSignature({ ...base, timestamp: stale, signature: sign(rawBody, stale) }), false, "签名正确但时间戳过期仍拒绝");
  assert.equal(verifyAchordConnectWebhookSignature({ ...base, timestamp: `${timestamp}.5`, signature: sign(rawBody, `${timestamp}.5`) }), false, "时间戳必须是整数秒");
}

function testWebhookEventParsing() {
  const withContact = unreadEvent({ requestId: "req_1", unreadCount: 2, contactUnreadCount: 5, createdAt: "2026-09-28T10:00:00.000Z" });
  assert.deepEqual(parseAchordConnectWebhookEvent(withContact.rawBody)?.unreadChange, {
    externalUserId: "user_1",
    requestId: "req_1",
    unreadCount: 2,
    contactUnreadCount: 5
  });
  const withoutContact = unreadEvent({ requestId: "req_1", unreadCount: 0, createdAt: "2026-09-28T10:00:00.000Z" });
  assert.equal(parseAchordConnectWebhookEvent(withoutContact.rawBody)?.unreadChange?.contactUnreadCount, null);
  const badContact = Buffer.from(JSON.stringify({ id: "e", type: "request.unread.changed", data: { externalUserId: "u", request: { id: "r" }, unreadCount: 1, contactUnreadCount: -1 } }));
  assert.equal(parseAchordConnectWebhookEvent(badContact)?.unreadChange, null, "非法的 contactUnreadCount 不能被当成总数");
  const badCount = Buffer.from(JSON.stringify({ id: "e", type: "request.unread.changed", data: { externalUserId: "u", request: { id: "r" }, unreadCount: "3" } }));
  assert.equal(parseAchordConnectWebhookEvent(badCount)?.unreadChange, null);
  assert.equal(parseAchordConnectWebhookEvent(Buffer.from("not json")), null);
  assert.equal(parseAchordConnectWebhookEvent(Buffer.from("[]")), null);
  assert.equal(parseAchordConnectWebhookEvent(Buffer.from('{"id":"e","type":"connector.test","data":{}}'))?.type, "connector.test");
  assert.equal(isAchordConnectWebhookRequest({ method: "POST", url: "/api/integrations/achord-connect/webhook?x=1" }), true);
  assert.equal(isAchordConnectWebhookRequest({ method: "POST", url: "/api/client/support/launch" }), false);
  assert.equal(isAchordConnectWebhookRequest({ method: "GET", url: "/api/integrations/achord-connect/webhook" }), false);
}

// ---------- Webhook：去重与未读汇总 ----------

async function testWebhookIdempotencyAndAggregation() {
  const { service, db, published, logs } = createService();
  await configure(service);

  // 不带 contactUnreadCount：按请求求和。
  const first = unreadEvent({ requestId: "req_a", unreadCount: 2, createdAt: "2026-09-28T10:00:00.000Z" });
  assert.equal(await service.handleWebhook(webhookRequest(first)), "accepted");
  assert.equal(await service.handleWebhook(webhookRequest(first)), "duplicate", "同一事件 ID 重试只处理一次");
  assert.equal(await service.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_b", unreadCount: 3, createdAt: "2026-09-28T10:01:00.000Z" }))), "accepted");
  assert.equal(db.state("user_1")?.unreadCount, 5);
  assert.equal(await service.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_a", unreadCount: 0, createdAt: "2026-09-28T10:02:00.000Z" }))), "accepted");
  assert.equal(db.state("user_1")?.unreadCount, 3);
  assert.deepEqual(published, [
    { userId: "user_1", count: 2 },
    { userId: "user_1", count: 5 },
    { userId: "user_1", count: 3 }
  ], "总数变化时推送 support_unread_updated，重复事件不重复推送");
  assert.ok(db.locks.includes("achord-connect"), "保存设置时对设置行加锁");
  assert.ok(db.locks.filter((key) => key !== "achord-connect" && !key.startsWith("share:")).every((userId) => userId === "user_1"), "按用户加行锁串行处理");
  // 加锁顺序：每次写入都先拿设置行的共享锁，再锁用户未读状态。
  const firstUserLock = db.locks.indexOf("user_1");
  assert.ok(firstUserLock > 0 && db.locks[firstUserLock - 1] === "share:achord-connect", "先锁设置行，再锁用户未读状态");

  // 晚到的旧事件（重试）不能覆盖更新的请求未读数。
  assert.equal(await service.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_a", unreadCount: 9, createdAt: "2026-09-28T09:59:00.000Z" }))), "accepted");
  assert.equal(db.request("user_1", "req_a")?.unreadCount, 0);
  assert.equal(db.state("user_1")?.unreadCount, 3);
  assert.equal(published.length, 3, "总数没变不推送");

  // 带 contactUnreadCount：以它为权威总数，即使与本地求和不同。
  assert.equal(await service.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_c", unreadCount: 1, contactUnreadCount: 7, createdAt: "2026-09-28T10:03:00.000Z" }))), "accepted");
  assert.equal(db.state("user_1")?.unreadCount, 7);
  assert.ok(db.state("user_1")?.syncedAt instanceof Date, "权威总数视为已校准");
  // 更早的权威总数不覆盖更新的。
  assert.equal(await service.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_c", unreadCount: 1, contactUnreadCount: 4, createdAt: "2026-09-28T10:02:30.000Z" }))), "accepted");
  assert.equal(db.state("user_1")?.unreadCount, 7);
  assert.deepEqual(published.at(-1), { userId: "user_1", count: 7 });

  // 不存在的用户：200 忽略，不写任何数据。
  const eventsBefore = db.eventCount();
  assert.equal(await service.handleWebhook(webhookRequest(unreadEvent({ userId: "user_missing", requestId: "req_x", unreadCount: 1, createdAt: "2026-09-28T10:04:00.000Z" }))), "ignored");
  assert.equal(db.state("user_missing"), null);
  assert.equal(db.eventCount(), eventsBefore);
  assert.ok(logs.some((line) => line.includes("不存在的用户")));

  // 测试事件与其他事件类型：200 忽略。
  const testEvent = { id: "evt_test", rawBody: Buffer.from('{"id":"evt_test","type":"connector.test","createdAt":"2026-09-28T10:00:00.000Z","data":{}}') };
  assert.equal(await service.handleWebhook(webhookRequest(testEvent)), "ignored");
  const statusEvent = { id: "evt_status", rawBody: Buffer.from('{"id":"evt_status","type":"request.status.changed","data":{"externalUserId":"user_1"}}') };
  assert.equal(await service.handleWebhook(webhookRequest(statusEvent)), "ignored");

  // 验签失败、过期、事件 ID 与正文不一致。
  const bad = unreadEvent({ requestId: "req_a", unreadCount: 5, createdAt: "2026-09-28T10:05:00.000Z" });
  await rejects(service.handleWebhook(webhookRequest(bad, { signature: sign(bad.rawBody, String(Math.floor(Date.now() / 1000)), "whsec_attacker_fake") })), UnauthorizedException);
  const staleTimestamp = String(Math.floor(Date.now() / 1000) - 3600);
  await rejects(service.handleWebhook(webhookRequest(bad, { timestamp: staleTimestamp, signature: sign(bad.rawBody, staleTimestamp) })), UnauthorizedException);
  await rejects(service.handleWebhook(webhookRequest(bad, { eventId: "evt_other" })), BadRequestException);
  await rejects(service.handleWebhook({ ...webhookRequest(bad), eventId: undefined }), BadRequestException);
  assert.equal(db.request("user_1", "req_a")?.unreadCount, 0, "被拒绝的请求不改变数据");

  // 未配置 Webhook Secret 时一律拒绝。
  await rejects(service.updateAdminConfig({ webhookSecret: null }), BadRequestException);
  await service.updateAdminConfig({ webhookSecret: null, enabled: false });
  await rejects(service.handleWebhook(webhookRequest(bad)), UnauthorizedException);
}

async function testWebhookFailureRollsBackEventId() {
  const { service, db, published } = createService();
  await configure(service);
  const event = unreadEvent({ requestId: "req_a", unreadCount: 4, createdAt: "2026-09-28T10:00:00.000Z" });
  db.failures.stateUpdate = 1;
  await assert.rejects(service.handleWebhook(webhookRequest(event)), /database write failed/);
  assert.equal(db.eventCount(), 0, "处理失败时事件 ID 随事务回滚，工单系统重试时会重新处理");
  assert.equal(db.request("user_1", "req_a"), null);
  assert.equal(await service.handleWebhook(webhookRequest(event)), "accepted");
  assert.equal(db.state("user_1")?.unreadCount, 4);
  assert.deepEqual(published, [{ userId: "user_1", count: 4 }]);
}

async function testWebhookEventPruning() {
  const { service, db } = createService();
  const now = new Date("2026-09-28T10:00:00.000Z");
  db.seedEvent("old", new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000));
  db.seedEvent("recent", new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000));
  assert.equal(await service.pruneWebhookEvents(now), 1);
  assert.equal(db.eventCount(), 1);
}

// ---------- 创建票据 ----------

async function testLaunchTicketRequestAndErrorMapping() {
  const { service, fetchCalls, respond, logs } = createService();
  await rejects(service.launchForClient({ id: "user_1", email: "a@example.test", displayName: "A" }), HttpException);
  await service.launchForClient({ id: "user_1", email: "a@example.test", displayName: "A" }).catch((error: HttpException) => {
    assert.equal(error.getStatus(), 503);
    assert.equal((error.getResponse() as { message: string }).message, "工单系统暂未开放，请稍后再试");
  });
  assert.equal(fetchCalls.length, 0, "未启用时不请求工单系统");

  await configure(service);
  respond(async () => json(201, { data: { launchUrl: `${BASE_URL}/embed/connect/pub_fake#ticket=act_fake&mode=native`, expiresAt: "2026-09-28T10:01:00.000Z" } }));
  const launched = await service.launchForClient({ id: "user_1", email: "alice@example.test", displayName: "" });
  assert.deepEqual(launched, {
    launchUrl: `${BASE_URL}/embed/connect/pub_fake#ticket=act_fake&mode=native`,
    expiresAt: "2026-09-28T10:01:00.000Z",
    supportOrigin: BASE_URL
  });
  const call = fetchCalls.at(-1)!;
  assert.equal(call.url, `${BASE_URL}/api/v1/integrations/universal/launch-tickets`);
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.redirect, "manual", "带凭据的请求不跟随跳转");
  assert.ok(call.init.signal, "请求必须带超时");
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`);
  assert.equal(headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(String(call.init.body)), {
    user: { id: "user_1", name: "alice", email: "alice@example.test" },
    context: { theme: "system", locale: "zh-CN", launchMode: "native" }
  }, "显示名为空时用邮箱前缀；native 模式不传 returnOrigin");

  assert.equal(buildLaunchTicketBody({ id: "u", email: "b@example.test", displayName: "  张三  " }).user.name, "张三");
  assert.equal(Array.from(buildLaunchTicketBody({ id: "u", email: "", displayName: "名".repeat(200) }).user.name).length, 160);
  assert.equal(buildLaunchTicketBody({ id: "u", email: "", displayName: "" }).user.email, null);

  const expectLaunchError = async (status: number, message: string) => {
    const error = await service.launchForClient({ id: "user_1", email: "a@example.test", displayName: "A" }).then(
      () => assert.fail("launch should fail"),
      (reason: unknown) => reason as HttpException
    );
    assert.ok(error instanceof HttpException);
    assert.equal(error.getStatus(), status);
    const body = JSON.stringify(error.getResponse());
    assert.match(body, new RegExp(message));
    assert.doesNotMatch(body, /acs_|whsec_|UNIVERSAL_|upstream detail/, "不能把凭据或工单系统原文返回给客户端");
  };
  respond(async () => json(429, { error: { code: "UNIVERSAL_RATE_LIMITED", message: "upstream detail" } }));
  await expectLaunchError(429, "操作太频繁，请稍后再试");
  respond(async () => json(401, { error: { code: "UNIVERSAL_CREDENTIAL_INVALID", message: "upstream detail" } }));
  await expectLaunchError(502, "工单系统暂时无法连接，请稍后再试");
  respond(async () => json(403, { error: { code: "UNIVERSAL_NATIVE_LAUNCH_DISABLED", message: "upstream detail" } }));
  await expectLaunchError(502, "工单系统暂时无法连接，请稍后再试");
  respond(async () => new Response("<html>bad gateway</html>", { status: 502 }));
  await expectLaunchError(502, "工单系统暂时无法连接，请稍后再试");
  respond(async () => {
    throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
  });
  await expectLaunchError(502, "工单系统暂时无法连接，请稍后再试");
  respond(async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example.test/" } }));
  await expectLaunchError(502, "工单系统暂时无法连接，请稍后再试");
  respond(async () => json(201, { data: { launchUrl: "https://evil.example.test/embed#ticket=act_fake", expiresAt: "2026-09-28T10:01:00.000Z" } }));
  await expectLaunchError(502, "工单系统暂时无法连接，请稍后再试");
  respond(async () => json(201, { data: { launchUrl: `${BASE_URL}/embed#ticket=act_fake`, expiresAt: "not a date" } }));
  await expectLaunchError(502, "工单系统暂时无法连接，请稍后再试");
  assert.ok(logs.some((line) => line.includes("UNIVERSAL_RATE_LIMITED")), "服务端日志保留状态与错误码便于排查");
  assert.ok(logs.some((line) => line.includes("UNIVERSAL_CREDENTIAL_INVALID") && line.includes("后台配置问题")), "401 在日志里提示是后台配置问题");
  assert.ok(logs.some((line) => line.includes("UNIVERSAL_NATIVE_LAUNCH_DISABLED") && line.includes("没有开启原生窗口打开")), "403 在日志里提示连接未开启原生窗口");
  assert.ok(logs.every((line) => !line.includes(CLIENT_SECRET) && !line.includes(WEBHOOK_SECRET) && !line.includes("upstream detail")), "日志不含密钥与工单系统原文");

  // 超时：请求在超时后被中止。AbortSignal.timeout 的计时器不占住事件循环，测试里另开一个计时器保活。
  const keepAlive = setInterval(() => undefined, 1000);
  await assert.rejects(
    createAchordConnectLaunchTicket(
      (_url, init) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
      { baseUrl: BASE_URL, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      { id: "user_1", email: "", displayName: "A" },
      20
    ),
    (error: unknown) => error instanceof AchordConnectRequestError && error.kind === "timeout"
  ).finally(() => clearInterval(keepAlive));
}

// ---------- 状态与未读校准 ----------

async function testStatusFallbackAndResync() {
  const { service, db, fetchCalls, respond, published, logs } = createService();
  assert.deepEqual(await service.getClientStatus("user_1"), { enabled: false, unreadCount: 0, supportOrigin: null });
  await configure(service, { enabled: false });
  assert.deepEqual(await service.getClientStatus("user_1"), { enabled: false, unreadCount: 0, supportOrigin: null }, "未启用时不报错也不暴露地址");
  await service.updateAdminConfig({ enabled: true });

  // 未读查询接口返回 404：用 Webhook 维护的值，只记一次日志。
  await service.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_a", unreadCount: 2, createdAt: new Date(Date.now() - 60_000).toISOString() })));
  respond(async () => json(404, { error: { code: "NOT_FOUND", message: "missing" } }));
  assert.deepEqual(await service.getClientStatus("user_1"), { enabled: true, unreadCount: 2, supportOrigin: BASE_URL });
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, `${BASE_URL}/api/v1/integrations/universal/contacts/user_1/unread`);
  assert.equal(fetchCalls[0].init.method, "GET");
  assert.equal(await service.getClientStatus("user_1").then((status) => status.unreadCount), 2);
  assert.equal(fetchCalls.length, 1, `同一用户 ${SUPPORT_UNREAD_RESYNC_MIN_INTERVAL_MS / 1000} 秒内不重复校准`);
  (service as unknown as { resyncAttempts: Map<string, number> }).resyncAttempts.clear();
  await service.getClientStatus("user_1");
  assert.equal(logs.filter((line) => line.includes("HTTP 404")).length, 1, "404 只记一次");

  // 工单系统不可用：状态接口照常返回本地值。
  (service as unknown as { resyncAttempts: Map<string, number> }).resyncAttempts.clear();
  respond(async () => {
    throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
  });
  assert.deepEqual(await service.getClientStatus("user_1"), { enabled: true, unreadCount: 2, supportOrigin: BASE_URL });

  // 校准成功：写回总数并推送变化。
  (service as unknown as { resyncAttempts: Map<string, number> }).resyncAttempts.clear();
  respond(async () => json(200, { data: { externalUserId: "user_1", unreadCount: 6, requests: [{ id: "req_b", number: 2, title: "t", status: "WAITING_CUSTOMER", unreadCount: 6, updatedAt: "2026-09-28T10:00:00.000Z" }] } }));
  assert.equal((await service.getClientStatus("user_1")).unreadCount, 6);
  assert.equal(db.state("user_1")?.unreadCount, 6);
  assert.equal(db.state("user_1")?.requestsComplete, false, "接受过权威总数后，不再由按请求记录推算");
  assert.deepEqual(published.at(-1), { userId: "user_1", count: 6 });

  // 刚校准过：不再请求工单系统。
  const callsBefore = fetchCalls.length;
  (service as unknown as { resyncAttempts: Map<string, number> }).resyncAttempts.clear();
  assert.equal((await service.getClientStatus("user_1")).unreadCount, 6);
  assert.equal(fetchCalls.length, callsBefore, `${SUPPORT_UNREAD_RESYNC_AFTER_MS / 60_000} 分钟内已校准的值直接使用`);

  // 校准后收到带总数的事件：直接用它。
  await service.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_c", unreadCount: 1, contactUnreadCount: 7, createdAt: new Date(Date.now() + 1000).toISOString() })));
  assert.equal(db.state("user_1")?.unreadCount, 7);
}

async function testReconciliationWatermarkAndConcurrentEvents() {
  const { service, db, respond } = createService();
  await configure(service);
  const past = (ms: number) => new Date(Date.now() - ms).toISOString();

  // 校准结果为 0 之后，晚到的更早事件（重试）不能把已读的请求重新变成未读。
  await service.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_a", unreadCount: 1, createdAt: past(120_000) })));
  respond(async () => json(200, { data: { externalUserId: "user_1", unreadCount: 0, requests: [] } }));
  assert.equal(await service.resyncUnread("user_1", { baseUrl: BASE_URL, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }), 0);
  assert.equal(await service.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_late", unreadCount: 3, createdAt: past(60_000) }))), "accepted");
  assert.equal(db.request("user_1", "req_late"), null, "早于校准的事件已包含在结果里，不再改动");
  assert.equal(db.state("user_1")?.unreadCount, 0);

  // 校准查询进行中处理了 Webhook：快照与该事件谁更新无法判断，放弃快照、保留 Webhook 的值，也不标记为已校准。
  const { service: racing, db: racingDb, published: racingPublished } = createService();
  await configure(racing);
  await racing.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_b", unreadCount: 4, createdAt: past(120_000) })));
  racing.fetchImpl = async () => {
    await racing.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_b", unreadCount: 1, createdAt: new Date().toISOString() })));
    return json(200, { data: { externalUserId: "user_1", unreadCount: 6, requests: [{ id: "req_b", unreadCount: 2 }, { id: "req_c", unreadCount: 4 }] } });
  };
  assert.equal(await racing.resyncUnread("user_1", { baseUrl: BASE_URL, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }), null);
  assert.equal(racingDb.state("user_1")?.unreadCount, 1, "保留查询期间 Webhook 写入的值");
  assert.equal(racingDb.state("user_1")?.syncedAt, null, "放弃的快照不算校准，下次查询状态会重试");
  assert.equal(racingDb.request("user_1", "req_b")?.unreadCount, 1);
  assert.deepEqual(racingPublished.map((item) => item.count), [4, 1]);
  // 没有并发写入时，下一次校准正常写回。
  racing.fetchImpl = async () => json(200, { data: { externalUserId: "user_1", unreadCount: 6, requests: [{ id: "req_b", unreadCount: 2 }, { id: "req_c", unreadCount: 4 }] } });
  assert.equal(await racing.resyncUnread("user_1", { baseUrl: BASE_URL, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }), 6);
  assert.equal(racingDb.state("user_1")?.unreadCount, 6);

  // 水位线用工单系统的时钟：本机时钟比工单系统快 30 秒时，校准之后工单系统产生的事件不能被当成旧事件丢掉。
  const { service: skewed, db: skewedDb } = createService();
  await configure(skewed);
  const upstreamNow = new Date(Date.now() - 30_000);
  skewed.fetchImpl = async () => json(200, { data: { externalUserId: "user_1", unreadCount: 0, requests: [] } }, upstreamNow);
  assert.equal(await skewed.resyncUnread("user_1", { baseUrl: BASE_URL, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }), 0);
  const responseDate = Math.floor(upstreamNow.getTime() / 1000) * 1000;
  assert.equal(skewedDb.state("user_1")?.sourceAt?.getTime(), responseDate - 4000, "水位线取响应头 Date 减去请求超时再减 1 秒");
  // 读取未读数可能早于生成响应：Date 前后几秒内的事件既不能当成已包含而丢掉，也不能直接采用其总数，
  // 而是由后台重新查询。例如用户已读后查询返回 0，一个 2 秒前的“未读 1”事件晚到，不能把 0 改回 1。
  let skewedFetches = 0;
  skewed.fetchImpl = async () => {
    skewedFetches += 1;
    return json(200, { data: { externalUserId: "user_1", unreadCount: 0, requests: [] } }, upstreamNow);
  };
  await skewed.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_edge", unreadCount: 1, contactUnreadCount: 1, createdAt: new Date(responseDate - 2000).toISOString() })));
  assert.equal(skewedDb.state("user_1")?.unreadCount, 0, "不确定区间内的事件不直接采用");
  assert.equal(skewedDb.state("user_1")?.syncedAt, null);
  await waitFor(() => skewedFetches === 1, "后台重新查询");
  await waitFor(() => skewedDb.state("user_1")?.syncedAt instanceof Date, "重新查询后写回");
  assert.equal(skewedDb.state("user_1")?.unreadCount, 0);
  const afterSnapshot = new Date(upstreamNow.getTime() + 5_000).toISOString();
  await skewed.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_a", unreadCount: 2, contactUnreadCount: 2, createdAt: afterSnapshot })));
  assert.equal(skewedDb.state("user_1")?.unreadCount, 2, "工单系统时间晚于快照的事件照常接受");
  // 没有 Date 头时无法界定结果对应的时刻，不采用这次结果（之后晚到的旧事件就无从覆盖它）。
  const { service: noDate, db: noDateDb } = createService();
  await configure(noDate);
  noDate.fetchImpl = async () => new Response(JSON.stringify({ data: { externalUserId: "user_1", unreadCount: 3, requests: [] } }), { status: 200 });
  assert.equal(await noDate.resyncUnread("user_1", { baseUrl: BASE_URL, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }), null);
  assert.equal(noDateDb.state("user_1"), null);
}

async function testIncompleteBaselineAndMixedOrdering() {
  const past = (ms: number) => new Date(Date.now() - ms).toISOString();
  const future = (ms: number) => new Date(Date.now() + ms).toISOString();

  // 权威总数 7 只解释了 req_a 的 1 个未读，其余请求本地不知道：之后不带总数的事件不能假设未知请求原来是 0。
  {
    const { service, db } = createService();
    await configure(service);
    await service.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_a", unreadCount: 1, contactUnreadCount: 7, createdAt: past(60_000) })));
    assert.equal(db.state("user_1")?.unreadCount, 7);
    assert.equal(db.state("user_1")?.requestsComplete, false);
    await service.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_b", unreadCount: 0, createdAt: future(1_000) })));
    assert.equal(db.state("user_1")?.unreadCount, 7, "接受过权威总数后不由单个请求推算总数");
    assert.equal(db.state("user_1")?.syncedAt, null, "标记为待校准，下次查询状态会向工单系统校准");
  }

  // 按请求记录的分布过时（A=2、B=0，而工单系统已是 A=0、B=2），即使某个总数恰好相等，也不能据此恢复求和。
  {
    const { service, db } = createService();
    await configure(service);
    await service.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_a", unreadCount: 2, createdAt: past(60_000) })));
    await service.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_c", unreadCount: 0, contactUnreadCount: 2, createdAt: past(30_000) })));
    assert.equal(db.state("user_1")?.unreadCount, 2);
    assert.equal(db.state("user_1")?.requestsComplete, false, "总数相等不代表每个请求的记录都是最新的");
    await service.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_b", unreadCount: 0, createdAt: future(1_000) })));
    assert.equal(db.state("user_1")?.unreadCount, 2, "不按过时的分布推算出 2 以外的值，而是等待校准");
    assert.equal(db.state("user_1")?.syncedAt, null);
    // 校准结果同样不恢复求和，之后以带总数的事件或下一次校准为准。
    service.fetchImpl = async () => json(200, { data: { externalUserId: "user_1", unreadCount: 0, requests: [] } });
    assert.equal(await service.resyncUnread("user_1", { baseUrl: BASE_URL, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }), 0);
    assert.equal(db.state("user_1")?.requestsComplete, false);
  }

  // 新旧版本事件交错：较新的按请求变化之后，才到达一个更早的权威总数，不能用旧总数覆盖。
  {
    const { service, db } = createService();
    await configure(service);
    await service.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_a", unreadCount: 2, createdAt: past(10_000) })));
    assert.equal(db.state("user_1")?.unreadCount, 2);
    await service.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_b", unreadCount: 1, contactUnreadCount: 1, createdAt: past(20_000) })));
    assert.equal(db.state("user_1")?.unreadCount, 2, "旧总数没有包含更新的 req_a 变化，保留当前值");
    assert.equal(db.state("user_1")?.syncedAt, null, "先后无法对齐时标记为待校准");
    assert.equal(db.request("user_1", "req_b")?.unreadCount, 1);
  }

  // 状态查询：校准期间 Webhook 已写入并推送新值，放弃快照后返回当前值而不是查询前读到的旧值。
  {
    const { service, db, published } = createService();
    await configure(service);
    await service.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_a", unreadCount: 4, createdAt: past(60_000) })));
    service.fetchImpl = async () => {
      await service.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_a", unreadCount: 1, createdAt: new Date().toISOString() })));
      return json(200, { data: { externalUserId: "user_1", unreadCount: 4, requests: [{ id: "req_a", unreadCount: 4 }] } });
    };
    assert.equal((await service.getClientStatus("user_1")).unreadCount, 1);
    assert.equal(db.state("user_1")?.unreadCount, 1);
    assert.deepEqual(published.map((item) => item.count), [4, 1]);
    // 工单系统不可用时同样返回当前值。
    (service as unknown as { resyncAttempts: Map<string, number> }).resyncAttempts.clear();
    service.fetchImpl = async () => {
      await service.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_a", unreadCount: 3, createdAt: future(1_000) })));
      throw new TypeError("fetch failed");
    };
    assert.equal((await service.getClientStatus("user_1")).unreadCount, 3);
  }
}

async function testPublishingKeepsNewestRevisionAndRespectsEnabled() {
  const { service, published } = createService();
  await configure(service);
  const publish = (change: { previous: number; next: number; revision: number; publish?: boolean }) =>
    (service as unknown as { publishIfChanged: (userId: string, change: unknown) => void }).publishIfChanged("user_1", { publish: true, ...change });
  // 两个事务先后提交（版本 5、6），但版本 6 的推送先执行：版本 5 的旧结果不能再推给客户端。
  publish({ previous: 3, next: 1, revision: 6 });
  publish({ previous: 2, next: 3, revision: 5 });
  publish({ previous: 1, next: 1, revision: 7 });
  publish({ previous: 1, next: 4, revision: 8 });
  publish({ previous: 4, next: 5, revision: 9, publish: false });
  assert.deepEqual(published.map((item) => item.count), [1, 4], "提交时未启用的结果不推送");

  // 停用后仍记录未读，但不推送；推送前的启用检查也覆盖校准结果。
  await service.updateAdminConfig({ enabled: false });
  const countBefore = published.length;
  await service.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_off", unreadCount: 3, contactUnreadCount: 9, createdAt: new Date(Date.now() + 60_000).toISOString() })));
  assert.equal(published.length, countBefore, "停用时不推送未读");
  service.fetchImpl = async () => json(200, { data: { externalUserId: "user_1", unreadCount: 2, requests: [] } }, new Date(Date.now() + 120_000));
  await service.resyncUnread("user_1", { baseUrl: BASE_URL, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  assert.equal(published.length, countBefore, "停用时校准结果也不推送");
}

async function testEqualTimestampsAndPostCommitFailures() {
  // 同一毫秒的两个不同总数：到达顺序不能代表先后，不采用后到的那个，改为重新查询。
  {
    const { service, db } = createService();
    await configure(service);
    service.fetchImpl = async () => {
      throw new TypeError("fetch failed");
    };
    const instant = new Date(Date.now() - 5_000).toISOString();
    await service.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_a", unreadCount: 2, contactUnreadCount: 3, createdAt: instant })));
    assert.equal(db.state("user_1")?.unreadCount, 3);
    await service.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_b", unreadCount: 1, contactUnreadCount: 2, createdAt: instant })));
    assert.equal(db.state("user_1")?.unreadCount, 3, "同一时刻的不同总数不按到达顺序覆盖");
    assert.equal(db.state("user_1")?.syncedAt, null, "标记为待校准");
    // 同一请求更新的记录已存在时，较早的总数同样不采用。
    const { service: sameRequest, db: sameDb } = createService();
    await configure(sameRequest);
    sameRequest.fetchImpl = service.fetchImpl;
    await sameRequest.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_a", unreadCount: 2, createdAt: new Date(Date.now() - 1_000).toISOString() })));
    await sameRequest.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_a", unreadCount: 5, contactUnreadCount: 5, createdAt: new Date(Date.now() - 2_000).toISOString() })));
    assert.equal(sameDb.state("user_1")?.unreadCount, 2);
  }

  // 旧格式事件：同一请求同一毫秒的“已读 0”先到、“未读 1”后到（投递顺序颠倒），不能按到达顺序把红点改回来。
  {
    const { service, db } = createService();
    await configure(service);
    let fetches = 0;
    service.fetchImpl = async () => {
      fetches += 1;
      return json(200, { data: { externalUserId: "user_1", unreadCount: 0, requests: [] } }, new Date(Date.now() + 10_000));
    };
    const instant = new Date(Date.now() - 5_000).toISOString();
    await service.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_a", unreadCount: 0, createdAt: instant })));
    await service.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_a", unreadCount: 1, createdAt: instant })));
    assert.equal(db.request("user_1", "req_a")?.unreadCount, 0, "保留已有记录");
    assert.equal(db.state("user_1")?.unreadCount, 0);
    assert.equal(db.state("user_1")?.syncedAt, null, "标记为待校准");
    await waitFor(() => fetches === 1, "安排后台校准");
    // 同一时刻、相同的值（例如重复投递但事件 ID 不同）不算冲突。
    const { service: same, db: sameDb } = createService();
    await configure(same);
    await same.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_a", unreadCount: 2, createdAt: instant })));
    await same.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_a", unreadCount: 2, createdAt: instant })));
    assert.equal(sameDb.state("user_1")?.unreadCount, 2);
    assert.equal(sameDb.state("user_1")?.requestsComplete, true);
  }

  // 事件 ID 提交后推送失败：Webhook 仍返回成功，不让工单系统把重试当成已处理却什么都没做。
  {
    const { service, db } = createService();
    await configure(service);
    (service as unknown as { clientEventsPublisher: unknown }).clientEventsPublisher = {
      publishSupportUnreadUpdated: () => {
        throw new Error("push channel down");
      }
    };
    const event = unreadEvent({ requestId: "req_a", unreadCount: 1, contactUnreadCount: 1, createdAt: new Date().toISOString() });
    assert.equal(await service.handleWebhook(webhookRequest(event)), "accepted");
    assert.equal(db.state("user_1")?.unreadCount, 1);
  }
}

async function testConnectionChangeResetsUnreadState() {
  const { service, db, published } = createService();
  await configure(service);
  await service.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_a", unreadCount: 2, contactUnreadCount: 4, createdAt: new Date().toISOString() })));
  await service.handleWebhook(webhookRequest(unreadEvent({ userId: "user_2", requestId: "req_b", unreadCount: 0, contactUnreadCount: 0, createdAt: new Date().toISOString() })));
  const revisionBefore = db.state("user_1")!.revision;
  // 旧连接的校准正在进行时切换了连接：结果不能写入。
  let releaseFetch: () => void = () => undefined;
  service.fetchImpl = () => new Promise<Response>((resolve) => {
    releaseFetch = () => resolve(json(200, { data: { externalUserId: "user_1", unreadCount: 9, requests: [] } }));
  });
  const inflight = service.resyncUnread("user_1", { baseUrl: BASE_URL, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  await new Promise((resolve) => setTimeout(resolve, 5));
  let newConnectionFetches = 0;
  const countBefore = published.length;
  await service.updateAdminConfig({ baseUrl: "https://support-new.example.test", clientId: "ac_fake_other" });
  service.fetchImpl = async () => {
    newConnectionFetches += 1;
    return json(200, { data: { externalUserId: "user_1", unreadCount: 1, requests: [] } });
  };
  releaseFetch();
  assert.equal(await inflight, null, "旧连接的校准结果不采用");
  assert.equal(db.state("user_1")?.unreadCount, 0, "切换连接后未读清零");
  assert.equal(db.state("user_1")?.syncedAt, null);
  assert.equal(db.state("user_1")?.sourceAt, null);
  assert.equal(db.state("user_1")?.requestsComplete, true);
  assert.ok(db.state("user_1")!.revision > revisionBefore, "版本号继续递增");
  assert.equal(db.requestCount(), 0, "旧连接的按请求记录全部删除");
  assert.deepEqual(published.slice(countBefore), [{ userId: "user_1", count: 0 }], "只给原来有未读的用户推送 0");
  await waitFor(() => newConnectionFetches === 2, "为用过工单入口的两位用户都向新连接重新查询");
  await waitFor(() => db.state("user_1")?.unreadCount === 1, "新连接的结果写回");
  assert.ok(published.some((item) => item.userId === "user_1" && item.count === 1));
  // 只改密钥或开关不算换连接，不清空未读。
  await service.updateAdminConfig({ webhookSecret: "whsec_rotated_fake" });
  assert.equal(db.state("user_1")?.unreadCount, 1);
}

async function testConnectionFenceAndEnableToggles() {
  // 验签之后、写入之前连接被切换：这个事件属于旧连接，不写入新连接的状态。
  {
    const { service, db } = createService();
    await configure(service);
    const event = unreadEvent({ requestId: "req_a", unreadCount: 5, contactUnreadCount: 5, createdAt: new Date().toISOString() });
    const originalFindUnique = db.prisma.user.findUnique;
    db.prisma.user.findUnique = async (args: unknown) => {
      // 模拟验签后在查用户时停顿，期间管理员切换了连接。
      db.prisma.user.findUnique = originalFindUnique;
      await service.updateAdminConfig({ baseUrl: "https://support-new.example.test" });
      return originalFindUnique(args);
    };
    assert.equal(await service.handleWebhook(webhookRequest(event)), "ignored");
    assert.equal(db.state("user_1"), null);
    assert.equal(db.eventCount(), 0, "旧连接的事件不记录事件 ID");
    assert.equal(db.setting("achord-connect").generation, 2, "首次填写和之后切换连接，代次各加一");
    await service.updateAdminConfig({ webhookSecret: "whsec_rotated_fake", enabled: false });
    assert.equal(db.setting("achord-connect").generation, 2, "只换密钥或开关不算切换连接");
  }

  // 停用时给有未读的在线客户端推送 0；重新启用时推送停用期间记录的当前值。
  {
    const { service, db, published } = createService();
    await configure(service);
    await service.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_a", unreadCount: 2, contactUnreadCount: 2, createdAt: new Date(Date.now() - 10_000).toISOString() })));
    assert.deepEqual(published, [{ userId: "user_1", count: 2 }]);
    await service.updateAdminConfig({ enabled: false });
    assert.deepEqual(published.at(-1), { userId: "user_1", count: 0 }, "停用时推送 0");
    await service.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_a", unreadCount: 4, contactUnreadCount: 4, createdAt: new Date().toISOString() })));
    assert.equal(published.length, 2, "停用期间只记录不推送");
    await service.updateAdminConfig({ enabled: true });
    assert.deepEqual(published.at(-1), { userId: "user_1", count: 4 }, "重新启用时推送当前值");
    assert.equal(db.state("user_1")?.unreadCount, 4);
    // 启用后推送按版本继续，不会被重新启用时的推送挡住更新的值。
    await service.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_a", unreadCount: 1, contactUnreadCount: 1, createdAt: new Date(Date.now() + 1_000).toISOString() })));
    assert.deepEqual(published.at(-1), { userId: "user_1", count: 1 });
  }
}

async function testPublicationFenceAndReconnectCandidates() {
  // 写入事务已提交、尚未推送时管理员停用了接入：这次结果不能在停用后把红点推回去。
  {
    const { service, db, published } = createService();
    await configure(service);
    const event = unreadEvent({ requestId: "req_a", unreadCount: 3, contactUnreadCount: 3, createdAt: new Date().toISOString() });
    const originalApply = service.applyUnreadChange.bind(service);
    service.applyUnreadChange = async (...args: Parameters<SupportIntegrationService["applyUnreadChange"]>) => {
      const result = await originalApply(...args);
      await service.updateAdminConfig({ enabled: false });
      return result;
    };
    assert.equal(await service.handleWebhook(webhookRequest(event)), "accepted");
    assert.equal(db.state("user_1")?.unreadCount, 3, "未读照常记录");
    assert.deepEqual(published, [{ userId: "user_1", count: 0 }], "停用时推送 0；停用之前提交的 3 不在停用之后推送");
    service.applyUnreadChange = originalApply;
    // 切换连接同样截断之前提交的结果。
    await service.updateAdminConfig({ enabled: true });
    const pushesBefore = published.length;
    service.applyUnreadChange = async (...args: Parameters<SupportIntegrationService["applyUnreadChange"]>) => {
      const result = await originalApply(...args);
      await service.updateAdminConfig({ clientId: "ac_fake_switched" });
      return result;
    };
    service.fetchImpl = async () => {
      throw new TypeError("fetch failed");
    };
    await service.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_b", unreadCount: 6, contactUnreadCount: 6, createdAt: new Date(Date.now() + 1_000).toISOString() })));
    assert.ok(published.slice(pushesBefore).every((item) => item.count === 0), "旧连接的结果不在切换后推送");
    service.applyUnreadChange = originalApply;
  }

  // 切换连接后，本地没有未读的用户也要向新连接查询一次。
  {
    const { service, db } = createService();
    await configure(service);
    await service.handleWebhook(webhookRequest(unreadEvent({ userId: "user_2", requestId: "req_z", unreadCount: 0, contactUnreadCount: 0, createdAt: new Date().toISOString() })));
    assert.equal(db.state("user_2")?.unreadCount, 0);
    const queried: string[] = [];
    service.fetchImpl = async (url) => {
      queried.push(url);
      return json(200, { data: { externalUserId: "user_2", unreadCount: 2, requests: [] } });
    };
    await service.updateAdminConfig({ baseUrl: "https://support-new.example.test" });
    await waitFor(() => db.state("user_2")?.unreadCount === 2, "向新连接查询原来没有未读的用户");
    assert.ok(queried.every((url) => url.startsWith("https://support-new.example.test/")));
  }

  // 启用前必须设置 Webhook Secret：客户端不会定时刷新，没有 Webhook 就收不到新的未读提醒。
  {
    const { service } = createService();
    await rejects(service.updateAdminConfig({ baseUrl: BASE_URL, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, enabled: true }), BadRequestException);
  }

  // 被全进程上限挡住的后台任务不占重试次数，稍后照常执行。
  {
    const { service } = createService();
    await configure(service);
    const timers = (service as unknown as { backgroundResyncTimers: Map<string, ReturnType<typeof setTimeout>> }).backgroundResyncTimers;
    const recent = (service as unknown as { recentResyncs: number[] }).recentResyncs;
    for (let index = 0; index < SUPPORT_UNREAD_RESYNC_MAX_PER_MINUTE; index += 1) recent.push(Date.now());
    await (service as unknown as { runBackgroundResync: (userId: string, attempt: number) => Promise<void> }).runBackgroundResync("user_1", 5);
    assert.ok(timers.has("user_1"), "最后一次机会被限流时仍会重新排队");
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }
}

async function testConfigNotificationsAndStatusRecheck() {
  type Internals = {
    publishIfChanged: (userId: string, change: unknown) => void;
    afterConfigSaved: (saved: unknown) => void;
    backgroundResyncTimers: Map<string, ReturnType<typeof setTimeout>>;
  };
  // 先停用、再切换连接、最后单独启用：启用时也要为用过工单入口的用户安排查询。
  {
    const { service, db } = createService();
    await configure(service);
    await service.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_a", unreadCount: 1, contactUnreadCount: 1, createdAt: new Date().toISOString() })));
    await service.updateAdminConfig({ enabled: false });
    await service.updateAdminConfig({ baseUrl: "https://support-new.example.test" });
    const internals = service as unknown as Internals;
    assert.equal(internals.backgroundResyncTimers.size, 0, "停用状态下切换连接不查询");
    let fetches = 0;
    service.fetchImpl = async () => {
      fetches += 1;
      return json(200, { data: { externalUserId: "user_1", unreadCount: 3, requests: [] } });
    };
    await service.updateAdminConfig({ enabled: true });
    await waitFor(() => db.state("user_1")?.unreadCount === 3, "重新启用后向新连接查询");
    assert.equal(fetches, 1);
  }

  // 保存设置时的推送同样按代次和版本号截断。
  {
    const { service, published } = createService();
    const internals = service as unknown as Internals;
    // 启用事务提交时读到 4（版本 7），但在它推送前，一个 Webhook（版本 8，同一代次）已推送 5：不能再推 4。
    internals.publishIfChanged("user_1", { previous: 4, next: 5, revision: 8, publish: true, epoch: 3 });
    internals.afterConfigSaved({
      next: { epoch: 3 },
      connectionChanged: false,
      wasEnabled: false,
      nowEnabled: true,
      withUnread: [{ userId: "user_1", unreadCount: 4, revision: 7 }],
      resyncCandidates: []
    });
    assert.deepEqual(published.map((item) => item.count), [5]);
    // 较早的一次保存（代次 3）的回调，晚于较新的停用（代次 4）执行：不再推送。
    internals.afterConfigSaved({
      next: { epoch: 4 },
      connectionChanged: false,
      wasEnabled: true,
      nowEnabled: false,
      withUnread: [{ userId: "user_1", unreadCount: 5, revision: 8 }],
      resyncCandidates: []
    });
    assert.deepEqual(published.map((item) => item.count), [5, 0], "停用推送 0（代次更新，版本号相同也能送达）");
    internals.afterConfigSaved({
      next: { epoch: 3 },
      connectionChanged: false,
      wasEnabled: false,
      nowEnabled: true,
      withUnread: [{ userId: "user_1", unreadCount: 5, revision: 9 }],
      resyncCandidates: []
    });
    assert.deepEqual(published.map((item) => item.count), [5, 0], "晚到的旧回调不推送");
  }

  // 状态查询在校准期间遇到停用：按未启用返回，不返回旧连接的数字。
  {
    const { service } = createService();
    await configure(service);
    service.fetchImpl = async () => {
      await service.updateAdminConfig({ enabled: false });
      return json(200, { data: { externalUserId: "user_1", unreadCount: 6, requests: [] } });
    };
    assert.deepEqual(await service.getClientStatus("user_1"), { enabled: false, unreadCount: 0, supportOrigin: null });
  }
  // 校准期间切换了连接：返回新连接的地址和重置后的本地值。
  {
    const { service } = createService();
    await configure(service);
    service.fetchImpl = async () => {
      service.fetchImpl = async () => {
        throw new TypeError("fetch failed");
      };
      await service.updateAdminConfig({ baseUrl: "https://support-new.example.test" });
      return json(200, { data: { externalUserId: "user_1", unreadCount: 6, requests: [] } });
    };
    assert.deepEqual(await service.getClientStatus("user_1"), { enabled: true, unreadCount: 0, supportOrigin: "https://support-new.example.test" });
  }
}

async function testStatusSchedulesRetryWhenDeferred() {
  const { service } = createService();
  await configure(service);
  const timers = (service as unknown as { backgroundResyncTimers: Map<string, ReturnType<typeof setTimeout>> }).backgroundResyncTimers;
  service.fetchImpl = async () => {
    throw new TypeError("fetch failed");
  };
  await service.getClientStatus("user_1");
  assert.ok(timers.has("user_1"), "状态查询校准失败后安排后台重试");
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  await service.getClientStatus("user_1");
  assert.ok(timers.has("user_1"), "状态查询被限流时安排后台查询");
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}

async function testLegacyEventsTriggerBackgroundResync() {
  // 客户端不会定时查询状态：旧格式事件无法给出总数时，由后台主动重新查询，不等客户端下次查询。
  const { service, db, published } = createService();
  await configure(service);
  await service.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_a", unreadCount: 1, contactUnreadCount: 5, createdAt: new Date(Date.now() - 60_000).toISOString() })));
  let fetches = 0;
  service.fetchImpl = async () => {
    fetches += 1;
    if (fetches === 1) throw new TypeError("fetch failed");
    return json(200, { data: { externalUserId: "user_1", unreadCount: 3, requests: [] } }, new Date(Date.now() + 10_000));
  };
  await service.handleWebhook(webhookRequest(unreadEvent({ requestId: "req_b", unreadCount: 0, createdAt: new Date().toISOString() })));
  assert.equal(db.state("user_1")?.unreadCount, 5);
  await waitFor(() => fetches === 1, "后台立即校准一次");
  const timers = (service as unknown as { backgroundResyncTimers: Map<string, ReturnType<typeof setTimeout>> }).backgroundResyncTimers;
  await waitFor(() => timers.has("user_1"), "失败后排队重试");
  // 同一用户只排一个任务。
  service.scheduleBackgroundResync("user_1");
  assert.equal(timers.size, 1);
  // 跳过等待，直接执行排队的重试。
  clearTimeout(timers.get("user_1"));
  timers.delete("user_1");
  (service as unknown as { resyncAttempts: Map<string, number> }).resyncAttempts.clear();
  service.scheduleBackgroundResync("user_1", 1);
  clearTimeout(timers.get("user_1"));
  timers.delete("user_1");
  await (service as unknown as { runBackgroundResync: (userId: string, attempt: number) => Promise<void> }).runBackgroundResync("user_1", 1);
  assert.equal(fetches, 2);
  assert.equal(db.state("user_1")?.unreadCount, 3);
  assert.deepEqual(published.at(-1), { userId: "user_1", count: 3 });
  // 停用后排队的校准不再查询。
  await service.updateAdminConfig({ enabled: false });
  await (service as unknown as { runBackgroundResync: (userId: string, attempt: number) => Promise<void> }).runBackgroundResync("user_1", 0);
  assert.equal(fetches, 2);
}

function testResyncRateLimits() {
  const { service } = createService();
  const claim = (userId: string, now: number) =>
    (service as unknown as { claimResyncAttempt: (userId: string, now: number) => boolean }).claimResyncAttempt(userId, now);
  const start = Date.UTC(2026, 8, 28, 10, 0, 0);
  assert.equal(claim("user_1", start), true);
  assert.equal(claim("user_1", start + SUPPORT_UNREAD_RESYNC_MIN_INTERVAL_MS - 1), false, "同一用户 5 分钟内最多查一次");
  assert.equal(claim("user_1", start + SUPPORT_UNREAD_RESYNC_MIN_INTERVAL_MS), true);
  // 整个进程每分钟有上限，远低于工单系统每连接每分钟 600 次。
  const later = start + 10 * 60_000;
  let granted = 0;
  for (let index = 0; index < SUPPORT_UNREAD_RESYNC_MAX_PER_MINUTE + 20; index += 1) {
    if (claim(`bulk_${index}`, later + index)) granted += 1;
  }
  assert.equal(granted, SUPPORT_UNREAD_RESYNC_MAX_PER_MINUTE);
  assert.ok(SUPPORT_UNREAD_RESYNC_MAX_PER_MINUTE < 600);
  assert.equal(claim("bulk_late", later + 60_000 + SUPPORT_UNREAD_RESYNC_MAX_PER_MINUTE), true, "一分钟后恢复");
}

// ---------- 后台设置 ----------

async function testAdminConfigNeverReturnsSecrets() {
  const { service, db, respond } = createService();
  const empty = await service.getAdminConfig();
  assert.deepEqual({ ...empty, updatedAt: null }, {
    baseUrl: null,
    clientId: null,
    hasClientSecret: false,
    hasWebhookSecret: false,
    enabled: false,
    webhookUrl: "https://v.example.test/api/integrations/achord-connect/webhook",
    updatedAt: null
  });
  await rejects(service.updateAdminConfig({ enabled: true }), BadRequestException);
  await rejects(service.updateAdminConfig({ baseUrl: "http://support.example.test" }), BadRequestException);
  await rejects(service.updateAdminConfig({ baseUrl: "https://support.example.test/path" }), BadRequestException);
  await rejects(service.updateAdminConfig({ baseUrl: "https://user:pass@support.example.test" }), BadRequestException);
  await rejects(service.updateAdminConfig({ clientId: "ac:with-colon" }), BadRequestException);
  await rejects(service.updateAdminConfig({ clientSecret: "   " }), BadRequestException);
  assert.equal(normalizeAchordConnectBaseUrl("https://support.example.test/"), BASE_URL);
  assert.equal(normalizeAchordConnectBaseUrl("http://localhost:4000", true), "http://localhost:4000");
  assert.throws(() => normalizeAchordConnectBaseUrl("http://localhost:4000", false), BadRequestException);

  const saved = await service.updateAdminConfig({ baseUrl: `${BASE_URL}/`, clientId: ` ${CLIENT_ID} `, clientSecret: CLIENT_SECRET, webhookSecret: WEBHOOK_SECRET, enabled: true });
  for (const view of [saved, await service.getAdminConfig()]) {
    const text = JSON.stringify(view);
    assert.doesNotMatch(text, new RegExp(`${CLIENT_SECRET}|${WEBHOOK_SECRET}`), "后台接口永不返回密钥");
    assert.equal(view.hasClientSecret, true);
    assert.equal(view.hasWebhookSecret, true);
    assert.equal(view.baseUrl, BASE_URL);
    assert.equal(view.clientId, CLIENT_ID);
  }
  // 省略表示保持不变；null 表示清除；清除 Client Secret 前必须先停用。
  await service.updateAdminConfig({ clientId: CLIENT_ID });
  assert.equal(db.setting("achord-connect").clientSecret, CLIENT_SECRET);
  await rejects(service.updateAdminConfig({ clientSecret: null }), BadRequestException);
  const cleared = await service.updateAdminConfig({ clientSecret: null, enabled: false });
  assert.equal(cleared.hasClientSecret, false);
  assert.equal(db.setting("achord-connect").clientSecret, null);
  assert.equal(db.setting("achord-connect").webhookSecret, WEBHOOK_SECRET);

  // 测试连接：未保存凭据时直接提示；工单系统未开启原生窗口、未读接口未上线时给出中文说明。
  const missing = await service.testConnection();
  assert.equal(missing.ok, false);
  assert.match(missing.launch.message, /请先填写并保存/);
  await service.updateAdminConfig({ clientSecret: CLIENT_SECRET });
  respond(async (call) => call.url.endsWith("/launch-tickets")
    ? json(403, { error: { code: "UNIVERSAL_NATIVE_LAUNCH_DISABLED", message: "upstream detail" } })
    : json(404, {}));
  const nativeDisabled = await service.testConnection();
  assert.equal(nativeDisabled.ok, false);
  assert.match(nativeDisabled.launch.message, /没有开启原生窗口打开/);
  assert.match(nativeDisabled.unread.message, /没有提供未读查询接口/);
  respond(async (call) => call.url.endsWith("/launch-tickets")
    ? json(409, { error: { code: "UNIVERSAL_IFRAME_NOT_CONFIGURED", message: "upstream detail" } })
    : json(401, { error: { code: "UNIVERSAL_CREDENTIAL_INVALID", message: "upstream detail" } }));
  const iframeMissing = await service.testConnection();
  assert.match(iframeMissing.launch.message, /UNIVERSAL_IFRAME_NOT_CONFIGURED/);
  assert.match(iframeMissing.unread.message, /Client ID 或 Client Secret 不正确/, "未读查询也能验证凭据");
  respond(async (call) => call.url.endsWith("/launch-tickets")
    ? json(201, { data: { launchUrl: `${BASE_URL}/embed/connect/pub_fake#ticket=act_fake`, expiresAt: "2026-09-28T10:01:00.000Z" } })
    : json(200, { data: { externalUserId: "chordv-connection-test", unreadCount: 0, requests: [] } }));
  const passed = await service.testConnection();
  assert.equal(passed.ok, true);
  assert.equal(passed.unread.ok, true);
  assert.doesNotMatch(JSON.stringify([nativeDisabled, passed]), /acs_|whsec_|upstream detail/);
}

// ---------- 旧工单写接口 ----------

async function testLegacyTicketWriteGuards() {
  const { service, db } = createService();
  const clientGuard = new LegacyClientTicketWriteGuard(db.prisma);
  const adminGuard = new LegacyAdminTicketWriteGuard(db.prisma);
  // 未启用新工单系统前（后台先上线、新版客户端尚未发布），旧工单照常可写。
  assert.equal(await clientGuard.canActivate(), true);
  assert.equal(await adminGuard.canActivate(), true);
  await configure(service, { enabled: false });
  assert.equal(await clientGuard.canActivate(), true, "配置了但未启用，仍不切换");
  await service.updateAdminConfig({ enabled: true });
  await assert.rejects(clientGuard.canActivate(), (error: unknown) => {
    assert.ok(error instanceof GoneException);
    assert.equal((error.getResponse() as { message: string }).message, "工单系统已升级，请更新到最新版客户端后提交工单");
    return true;
  });
  await assert.rejects(adminGuard.canActivate(), GoneException);
  await service.updateAdminConfig({ enabled: false });
  assert.equal(await clientGuard.canActivate(), true, "停用后可以回退到旧工单");
  // 旧版客户端（v1.1.10 的 describeUserError）只在 4xx 文案“客户可读”时原样展示：
  // 必须含中文、不超过 240 字，且不含英文单词、链接、路径、括号、下划线标识等（见 v1.1.10 的 isCustomerSafeText）。
  // v1.1.9 及更早直接展示 message。这句提示两种都满足，旧客户端看到的就是它。
  assert.match(LEGACY_CLIENT_TICKET_WRITE_MESSAGE, /[\u3400-\u9fff]/);
  assert.ok(LEGACY_CLIENT_TICKET_WRITE_MESSAGE.length <= 240);
  assert.doesNotMatch(LEGACY_CLIENT_TICKET_WRITE_MESSAGE, /[A-Za-z0-9_{}[\]<>`\\|/:]/);
}

// ---------- 依赖注入 ----------

function testSupportModuleDependenciesAreExported() {
  // 路由测试直接替换了服务实例，这里单独确认真实启动时构造函数依赖都能从全局模块拿到。
  const service = readFileSync(resolve(__dirname, "../src/modules/support/support-integration.service.ts"), "utf8");
  const constructorBlock = /constructor\(([\s\S]*?)\)\s*\{/.exec(service)?.[1] ?? "";
  const dependencies = [...constructorBlock.matchAll(/:\s*(\w+)/g)].map((match) => match[1]);
  assert.deepEqual(dependencies, ["PrismaService", "SiteAddressService", "ClientEventsPublisher"]);
  const devDataModule = readFileSync(resolve(__dirname, "../src/modules/common/dev-data.module.ts"), "utf8");
  const exportsBlock = /exports:\s*\[([\s\S]*?)\]/.exec(devDataModule)?.[1] ?? "";
  assert.match(devDataModule, /@Global\(\)/);
  for (const name of ["SiteAddressService", "ClientEventsPublisher"]) {
    assert.match(exportsBlock, new RegExp(`\\b${name}\\b`), `${name} 必须由全局 DevDataModule 导出`);
  }
  const supportModule = readFileSync(resolve(__dirname, "../src/modules/support/support.module.ts"), "utf8");
  assert.match(supportModule, /imports: \[DevDataModule\]/, "SupportModule 显式导入提供这些依赖的模块");
  const prismaModule = readFileSync(resolve(__dirname, "../src/modules/common/prisma.module.ts"), "utf8");
  assert.match(prismaModule, /@Global\(\)[\s\S]*exports: \[PrismaService\]/);
}

// ---------- 路由：原始正文与认证 ----------

async function testRoutesWithRawBodyParser() {
  const { service, db, respond } = createService();
  await configure(service);
  Reflect.defineMetadata("design:paramtypes", [SupportIntegrationService], AdminSupportIntegrationController);
  Reflect.defineMetadata("design:paramtypes", [SupportIntegrationService], ClientSupportController);
  Reflect.defineMetadata("design:paramtypes", [SupportIntegrationService], AchordConnectWebhookController);
  Reflect.defineMetadata("design:paramtypes", [UpdateSupportIntegrationConfigDto], AdminSupportIntegrationController.prototype, "save");
  Reflect.defineMetadata("design:paramtypes", [AuthSessionService], AdminAuthGuard);
  Reflect.defineMetadata("design:paramtypes", [AuthSessionService], ClientAuthGuard);

  @Module({
    controllers: [AdminSupportIntegrationController, ClientSupportController, AchordConnectWebhookController],
    providers: [
      AdminAuthGuard,
      ClientAuthGuard,
      { provide: SupportIntegrationService, useValue: service },
      {
        provide: AuthSessionService,
        useValue: {
          authenticateAccessToken: async (authorization?: string) => {
            if (authorization === "Bearer user-token") return { id: "user_1", email: "alice@example.test", displayName: "Alice", role: "user" };
            if (authorization === "Bearer admin-token") return { id: "admin_1", email: "admin@example.test", displayName: "Admin", role: "admin" };
            throw new UnauthorizedException("登录状态已过期，请重新登录。");
          }
        }
      }
    ]
  })
  class SupportRoutesTestModule {}

  const app = await NestFactory.create<NestExpressApplication>(SupportRoutesTestModule, { logger: false });
  app.setGlobalPrefix("api");
  app.useBodyParser("raw", { type: isAchordConnectWebhookRequest, limit: ACHORD_CONNECT_WEBHOOK_MAX_BODY_BYTES });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    // Webhook：原始正文（含空格与中文）按字节验签。
    const event = unreadEvent({ requestId: "req_route", unreadCount: 3, createdAt: "2026-09-28T10:00:00.000Z" });
    const rawBody = Buffer.from(event.rawBody.toString().replace('"type"', ' "type" ').replace("测试请求", "测试 请求 ✓"));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const post = (body: Buffer, headers: Record<string, string>) => fetch(`${baseUrl}/api/integrations/achord-connect/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", "user-agent": "Achord-Connect-Webhook/1.0", ...headers },
      body
    });
    const accepted = await post(rawBody, { "x-achord-event-id": event.id, "x-achord-timestamp": timestamp, "x-achord-signature": sign(rawBody, timestamp) });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { ok: true, result: "accepted" });
    assert.equal(db.state("user_1")?.unreadCount, 3);
    const duplicate = await post(rawBody, { "x-achord-event-id": event.id, "x-achord-timestamp": timestamp, "x-achord-signature": sign(rawBody, timestamp) });
    assert.deepEqual(await duplicate.json(), { ok: true, result: "duplicate" });
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(rawBody.toString())));
    const rejected = await post(reserialized, { "x-achord-event-id": event.id, "x-achord-timestamp": timestamp, "x-achord-signature": sign(rawBody, timestamp) });
    assert.equal(rejected.status, 401, "正文被改动（哪怕只是重新序列化）就验不过");
    const rejectedBody = await rejected.json() as Record<string, unknown>;
    assert.doesNotMatch(JSON.stringify(rejectedBody), /signature|签名|timestamp|secret/i, "401 不给出细节");
    const noSignature = await post(rawBody, { "x-achord-event-id": event.id, "x-achord-timestamp": timestamp });
    assert.equal(noSignature.status, 401);

    // 其他路由的 JSON 解析不受影响。
    const saved = await fetch(`${baseUrl}/api/admin/support-integration`, {
      method: "PUT",
      headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
      body: JSON.stringify({ clientId: CLIENT_ID, unknownField: "dropped" })
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.headers.get("cache-control"), "no-store");
    const savedBody = await saved.json() as Record<string, unknown>;
    assert.equal(savedBody.hasClientSecret, true);
    assert.doesNotMatch(JSON.stringify(savedBody), /acs_|whsec_/);
    const invalid = await fetch(`${baseUrl}/api/admin/support-integration`, {
      method: "PUT",
      headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
      body: JSON.stringify({ enabled: "yes" })
    });
    assert.equal(invalid.status, 400);
    const adminGet = await fetch(`${baseUrl}/api/admin/support-integration`, { headers: { authorization: "Bearer admin-token" } });
    assert.equal(adminGet.status, 200);
    assert.equal((await fetch(`${baseUrl}/api/admin/support-integration`, { headers: { authorization: "Bearer user-token" } })).status, 403, "普通用户不能读取后台设置");
    respond(async (call) => call.url.endsWith("/launch-tickets")
      ? json(201, { data: { launchUrl: `${BASE_URL}/embed/connect/pub_fake#ticket=act_fake`, expiresAt: "2026-09-28T10:01:00.000Z" } })
      : json(404, {}));
    const tested = await fetch(`${baseUrl}/api/admin/support-integration/test`, { method: "POST", headers: { authorization: "Bearer admin-token" } });
    assert.equal(tested.status, 200);
    assert.equal(((await tested.json()) as { ok: boolean }).ok, true);

    // 客户端接口：需要普通用户登录；管理员与未登录都不行。
    const status = await fetch(`${baseUrl}/api/client/support/status`, { headers: { authorization: "Bearer user-token" } });
    assert.equal(status.status, 200);
    assert.equal(status.headers.get("cache-control"), "no-store");
    assert.deepEqual(await status.json(), { enabled: true, unreadCount: 3, supportOrigin: BASE_URL });
    assert.equal((await fetch(`${baseUrl}/api/client/support/status`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/client/support/status`, { headers: { authorization: "Bearer admin-token" } })).status, 403);
    const launch = await fetch(`${baseUrl}/api/client/support/launch`, { method: "POST", headers: { authorization: "Bearer user-token" } });
    assert.equal(launch.status, 200);
    assert.equal(launch.headers.get("cache-control"), "no-store");
    assert.deepEqual(await launch.json(), {
      launchUrl: `${BASE_URL}/embed/connect/pub_fake#ticket=act_fake`,
      expiresAt: "2026-09-28T10:01:00.000Z",
      supportOrigin: BASE_URL
    });
    respond(async () => json(429, { error: { code: "UNIVERSAL_RATE_LIMITED", message: "upstream detail" } }));
    const limited = await fetch(`${baseUrl}/api/client/support/launch`, { method: "POST", headers: { authorization: "Bearer user-token" } });
    assert.equal(limited.status, 429);
    assert.equal(((await limited.json()) as { message: string }).message, "操作太频繁，请稍后再试");
    assert.equal((await fetch(`${baseUrl}/api/client/support/launch`, { method: "POST" })).status, 401);
  } finally {
    await app.close();
  }
}

async function main() {
  testSignatureVerification();
  testWebhookEventParsing();
  await testWebhookIdempotencyAndAggregation();
  await testWebhookFailureRollsBackEventId();
  await testWebhookEventPruning();
  await testLaunchTicketRequestAndErrorMapping();
  await testStatusFallbackAndResync();
  await testReconciliationWatermarkAndConcurrentEvents();
  await testIncompleteBaselineAndMixedOrdering();
  testResyncRateLimits();
  await testPublishingKeepsNewestRevisionAndRespectsEnabled();
  await testLegacyEventsTriggerBackgroundResync();
  await testEqualTimestampsAndPostCommitFailures();
  await testConnectionChangeResetsUnreadState();
  await testStatusSchedulesRetryWhenDeferred();
  await testConnectionFenceAndEnableToggles();
  await testPublicationFenceAndReconnectCandidates();
  await testConfigNotificationsAndStatusRecheck();
  await testAdminConfigNeverReturnsSecrets();
  await testLegacyTicketWriteGuards();
  testSupportModuleDependenciesAreExported();
  await testRoutesWithRawBodyParser();
  console.log("achord connect support regression checks passed");
}

let finished = false;
process.on("beforeExit", () => {
  if (!finished) {
    console.error("achord connect support regression exited before finishing (a promise never settled)");
    process.exitCode = 1;
  }
});
main().then(() => {
  finished = true;
}, (error) => {
  console.error(error);
  process.exit(1);
});
