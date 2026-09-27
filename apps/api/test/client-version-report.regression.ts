import "reflect-metadata";
import assert from "node:assert/strict";
import { ClientController } from "../src/modules/client/client.controller";
import { AdminSubscriptionService } from "../src/modules/common/admin-subscription.service";
import {
  CLIENT_VERSION_SEEN_REFRESH_MS,
  ClientVersionReportService,
  normalizeClientVersionReport,
  shouldRecordClientVersion
} from "../src/modules/common/client-version-report.service";
import { DevDataService } from "../src/modules/common/dev-data.service";

function testNormalize() {
  assert.deepEqual(
    normalizeClientVersionReport({ currentVersion: "1.1.9", platform: "macos", channel: "stable" }),
    { platform: "macos", version: "1.1.9", build: null, channel: "stable" },
    "1.1.9 客户端不带构建号，也要能记录"
  );
  assert.deepEqual(
    normalizeClientVersionReport({ currentVersion: " v1.1.10 ", currentBuild: 3, platform: "windows", channel: "beta" }),
    { platform: "windows", version: "1.1.10", build: 3, channel: "beta" }
  );
  assert.equal(normalizeClientVersionReport({ currentVersion: "1.1.10+7", platform: "macos", channel: "stable" })?.build, 7);
  assert.equal(normalizeClientVersionReport({ currentVersion: "1.1.10", platform: "macos" } as never)?.channel, "stable");
  for (const currentVersion of ["", "latest", "1.1", "1.1.10.2", "<script>", `1.1.${"9".repeat(7)}`, "1.1.10+1+2", `1.1.10-${"a".repeat(40)}`]) {
    assert.equal(normalizeClientVersionReport({ currentVersion, platform: "macos", channel: "stable" }), null, `不接受版本号 ${currentVersion}`);
  }
  assert.equal(normalizeClientVersionReport({ currentVersion: "1.1.10", platform: "linux" as never, channel: "stable" }), null);
  assert.equal(normalizeClientVersionReport({ currentVersion: "1.1.10", currentBuild: 0, platform: "macos", channel: "stable" })?.build, null);
  assert.equal(normalizeClientVersionReport(null), null);
}

function testThrottle() {
  const now = new Date("2026-09-27T10:00:00Z");
  const next = { platform: "macos" as const, version: "1.1.10", build: 3, channel: "stable" as const };
  const stored = { version: "1.1.10", build: 3, channel: "stable" as const, lastSeenAt: new Date(now.getTime() - 60_000) };
  assert.equal(shouldRecordClientVersion(null, next, now), true);
  assert.equal(shouldRecordClientVersion(stored, next, now), false, "版本未变且刚记录过，不应重复写库");
  assert.equal(shouldRecordClientVersion({ ...stored, lastSeenAt: new Date(now.getTime() - CLIENT_VERSION_SEEN_REFRESH_MS) }, next, now), true);
  assert.equal(shouldRecordClientVersion({ ...stored, version: "1.1.9" }, next, now), true);
  assert.equal(shouldRecordClientVersion({ ...stored, build: null }, next, now), true);
  assert.equal(shouldRecordClientVersion({ ...stored, channel: "beta" }, next, now), true);
  assert.equal(shouldRecordClientVersion({ ...stored, version: "1.1.11", lastSeenAt: new Date(now.getTime() + 1) }, next, now), false, "比已记录更早的上报不覆盖");
}

// 按 Prisma 的语义求值更新条件（含 SQL 中 NULL 与 not 比较的行为），用来验证条件本身而不是测试替身。
function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([key, condition]: [string, any]) => {
    if (key === "OR") return condition.some((item: any) => matches(row, item));
    const value = row[key];
    const comparable = (input: any) => (input instanceof Date ? input.getTime() : input);
    if (condition === null) return value === null;
    if (typeof condition !== "object" || condition instanceof Date) return comparable(value) === comparable(condition);
    if ("not" in condition) return condition.not === null ? value !== null : value !== null && comparable(value) !== comparable(condition.not);
    if ("lt" in condition) return comparable(value) < comparable(condition.lt);
    if ("lte" in condition) return comparable(value) <= comparable(condition.lte);
    throw new Error(`unsupported condition ${key}`);
  });
}

function createRecorder(options: { failAuth?: boolean; failWrite?: boolean; beforeReadReturns?: () => Promise<void> } = {}) {
  const rows = new Map<string, any>();
  const calls = { auth: 0, reads: 0, writes: [] as any[] };
  const service = Object.assign(Object.create(ClientVersionReportService.prototype), {
    logger: { warn: () => undefined },
    authSessionService: {
      authenticateAccessToken: async (authorization: string) => {
        calls.auth += 1;
        if (options.failAuth || authorization !== "Bearer good") throw new Error("登录状态已过期");
        return { id: "user-1" };
      }
    },
    prisma: {
      userClientVersion: {
        findUnique: async ({ where }: any) => {
          calls.reads += 1;
          const row = rows.get(`${where.userId_platform.userId}:${where.userId_platform.platform}`);
          const snapshot = row ? { ...row } : null;
          await options.beforeReadReturns?.();
          return snapshot;
        },
        create: async ({ data }: any) => {
          if (options.failWrite) throw new Error("数据库不可用");
          const key = `${data.userId}:${data.platform}`;
          if (rows.has(key)) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
          calls.writes.push({ op: "create", data });
          rows.set(key, { ...data });
          return data;
        },
        updateMany: async ({ where, data }: any) => {
          if (options.failWrite) throw new Error("数据库不可用");
          let count = 0;
          for (const [key, row] of rows) {
            if (!matches(row, where)) continue;
            rows.set(key, { ...row, ...data });
            count += 1;
          }
          if (count) calls.writes.push({ op: "update", where, data });
          return { count };
        }
      }
    }
  }) as ClientVersionReportService;
  return { service, rows, calls };
}

async function testOutOfOrder() {
  const t0 = new Date("2026-09-27T10:00:00Z");
  const t1 = new Date(t0.getTime() + 60 * 60_000);
  const t2 = new Date(t1.getTime() + 1_000);
  const older = { platform: "macos" as const, version: "1.1.9", build: null, channel: "stable" as const };
  const newer = { ...older, version: "1.1.10", build: 4 };

  // 两台设备都读到了 t0 的旧记录；较新的上报先写完，较早的上报随后才写。
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let gated = true;
  const racing = createRecorder({ beforeReadReturns: () => (gated ? gate : Promise.resolve()) });
  racing.rows.set("user-1:macos", { userId: "user-1", platform: "macos", version: "1.1.8", build: null, channel: "stable", lastSeenAt: t0 });
  const slow = racing.service.record("Bearer good", older, t1);
  await new Promise((resolve) => setImmediate(resolve));
  gated = false;
  assert.equal(await racing.service.record("Bearer good", newer, t2), true);
  release();
  assert.equal(await slow, false, "更早发生的上报晚到时，数据库条件拒绝覆盖");
  assert.equal(racing.rows.get("user-1:macos").version, "1.1.10");
  assert.equal(racing.rows.get("user-1:macos").lastSeenAt.getTime(), t2.getTime(), "最近使用时间不会倒退");

  // 首次上报并发到达：较新的先建行，较早的建行冲突后走条件更新，同样被拒绝。
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstGated = true;
  const first = createRecorder({ beforeReadReturns: () => (firstGated ? firstGate : Promise.resolve()) });
  const slowFirst = first.service.record("Bearer good", older, t1);
  await new Promise((resolve) => setImmediate(resolve));
  firstGated = false;
  assert.equal(await first.service.record("Bearer good", newer, t2), true);
  releaseFirst();
  assert.equal(await slowFirst, false);
  assert.equal(first.rows.get("user-1:macos").version, "1.1.10");

  // 反过来较早的先写完，较新的仍能覆盖。
  const ordered = createRecorder();
  assert.equal(await ordered.service.record("Bearer good", older, t1), true);
  assert.equal(await ordered.service.record("Bearer good", newer, t2), true);
  assert.equal(ordered.rows.get("user-1:macos").version, "1.1.10");
  assert.equal(await ordered.service.record("Bearer good", older, t1), false, "已记录更新的上报后，更早的上报不再写");
}

async function testRecord() {
  const t0 = new Date("2026-09-27T10:00:00Z");
  const report = { platform: "macos" as const, version: "1.1.9", build: null, channel: "stable" as const };
  const { service, rows, calls } = createRecorder();
  assert.equal(await service.record("Bearer good", report, t0), true);
  assert.equal(calls.writes[0].data.userId, "user-1");
  assert.equal(calls.writes[0].data.platform, "macos");
  assert.equal(rows.get("user-1:macos").version, "1.1.9");
  assert.equal(await service.record("Bearer good", report, new Date(t0.getTime() + 5 * 60_000)), false, "10 分钟内同版本不写");
  assert.equal(calls.writes.length, 1);
  assert.equal(await service.record("Bearer good", report, new Date(t0.getTime() + 11 * 60_000)), true, "超过刷新间隔才更新最近活跃时间");
  assert.equal(rows.get("user-1:macos").lastSeenAt.getTime(), t0.getTime() + 11 * 60_000);
  assert.equal(await service.record("Bearer good", { ...report, version: "1.1.10", build: 4 }, new Date(t0.getTime() + 12 * 60_000)), true, "升级后立刻记录新版本");
  assert.equal(rows.get("user-1:macos").version, "1.1.10");
  assert.equal(rows.get("user-1:macos").build, 4);
  assert.equal(await service.record("Bearer good", { ...report, platform: "windows" }, t0), true, "不同平台分别记录");
  assert.equal(rows.size, 2);

  const before = calls.reads;
  assert.equal(await service.record("Bearer expired", report, t0), false, "登录凭证无效时静默跳过");
  assert.equal(calls.reads, before, "凭证无效时不读版本表");

  const broken = createRecorder({ failWrite: true });
  assert.equal(await broken.service.record("Bearer good", report, t0), false, "写库失败不抛错");
}

async function testBackground() {
  const valid = { currentVersion: "1.1.10", currentBuild: 2, platform: "macos" as const, channel: "stable" as const };
  const { service, calls } = createRecorder();
  service.recordInBackground(undefined, valid);
  service.recordInBackground("  ", valid);
  service.recordInBackground("Bearer good", { ...valid, currentVersion: "not-a-version" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.auth, 0, "未登录或版本号非法时不做任何校验与读写");
  service.recordInBackground("Bearer good", valid);
  for (let index = 0; index < 20 && calls.writes.length === 0; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].data.build, 2);
  const failing = createRecorder({ failAuth: true });
  assert.doesNotThrow(() => failing.service.recordInBackground("Bearer good", valid));
  await new Promise((resolve) => setImmediate(resolve));
}

async function testUpdateCheckWiring() {
  const recorded: unknown[] = [];
  const result = { hasUpdate: false };
  const devData = Object.assign(Object.create(DevDataService.prototype), {
    clientVersionReportService: { recordInBackground: (...args: unknown[]) => recorded.push(args) },
    releaseCenterService: { checkClientUpdate: async () => result }
  }) as DevDataService;
  const input = { currentVersion: "1.1.9", platform: "macos" as const, channel: "stable" as const };
  assert.equal(await devData.checkClientUpdate(input, "Bearer good"), result);
  assert.deepEqual(recorded, [["Bearer good", input]]);
  assert.equal(await devData.checkClientUpdate(input), result, "未登录的检查更新照常返回");
  assert.equal(recorded.length, 1);

  const forwarded: unknown[] = [];
  const controller = Object.assign(Object.create(ClientController.prototype), {
    clientService: { checkUpdate: (...args: unknown[]) => { forwarded.push(args); return result; } }
  }) as ClientController;
  controller.checkUpdate(input as never, "Bearer good");
  assert.deepEqual(forwarded, [[input, "Bearer good"]], "检查更新接口把登录凭证交给服务层");
}

async function testAdminUsers() {
  let query: any;
  const lastSeenAt = new Date("2026-09-27T09:00:00Z");
  const service = Object.assign(Object.create(AdminSubscriptionService.prototype), {
    prisma: {
      user: {
        findMany: async (input: unknown) => {
          query = input;
          return [
            {
              id: "user-1", email: "a@example.com", displayName: "A", role: "user", status: "active",
              lastSeenAt, createdAt: lastSeenAt, updatedAt: lastSeenAt, maxConcurrentSessionsOverride: null,
              subscriptions: [], teamMemberships: [],
              clientVersions: [{ platform: "windows", version: "1.1.10", build: 5, channel: "beta", lastSeenAt }]
            },
            {
              id: "user-2", email: "b@example.com", displayName: "B", role: "user", status: "active",
              lastSeenAt, createdAt: lastSeenAt, updatedAt: lastSeenAt, maxConcurrentSessionsOverride: null,
              subscriptions: [], teamMemberships: []
            }
          ];
        }
      }
    }
  }) as AdminSubscriptionService;
  const [first, second] = await service.listAdminUsers();
  assert.deepEqual(query.include.clientVersions, { orderBy: { lastSeenAt: "desc" } });
  assert.deepEqual(first.clientVersions, [{ platform: "windows", version: "1.1.10", build: 5, channel: "beta", lastSeenAt: lastSeenAt.toISOString() }]);
  assert.deepEqual(second.clientVersions, [], "没有上报记录的用户返回空列表");
}

async function main() {
  testNormalize();
  testThrottle();
  await testRecord();
  await testOutOfOrder();
  await testBackground();
  await testUpdateCheckWiring();
  await testAdminUsers();
  console.log("client version report checks passed");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
