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
}

function createRecorder(options: { failAuth?: boolean; failWrite?: boolean } = {}) {
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
          return rows.get(`${where.userId_platform.userId}:${where.userId_platform.platform}`) ?? null;
        },
        upsert: async (input: any) => {
          if (options.failWrite) throw new Error("数据库不可用");
          calls.writes.push(input);
          const key = `${input.where.userId_platform.userId}:${input.where.userId_platform.platform}`;
          rows.set(key, { ...(rows.get(key) ?? input.create), ...input.update });
          return rows.get(key);
        }
      }
    }
  }) as ClientVersionReportService;
  return { service, rows, calls };
}

async function testRecord() {
  const t0 = new Date("2026-09-27T10:00:00Z");
  const report = { platform: "macos" as const, version: "1.1.9", build: null, channel: "stable" as const };
  const { service, rows, calls } = createRecorder();
  assert.equal(await service.record("Bearer good", report, t0), true);
  assert.equal(calls.writes[0].create.userId, "user-1");
  assert.equal(calls.writes[0].create.platform, "macos");
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
  assert.equal(calls.writes[0].create.build, 2);
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
  await testBackground();
  await testUpdateCheckWiring();
  await testAdminUsers();
  console.log("client version report checks passed");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
