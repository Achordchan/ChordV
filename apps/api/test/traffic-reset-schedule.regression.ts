import "reflect-metadata";
import assert from "node:assert/strict";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { computeNextTrafficResetAt, defaultTrafficResetDay } from "@chordv/shared";
import { AdminSubscriptionService } from "../src/modules/common/admin-subscription.service";
import { TrafficResetScheduleService } from "../src/modules/common/traffic-reset-schedule.service";
import { defaultTrafficResetDayForNewSubscription } from "../../admin/src/utils/admin-forms";
import { CreateSubscriptionDto, CreateTeamSubscriptionDto, UpdateSubscriptionDto } from "../src/modules/admin/admin.dto";

delete process.env.DATABASE_URL;

function createInstance<T>(prototype: object, fields: Record<string, unknown>): T {
  return Object.assign(Object.create(prototype), fields) as T;
}

/** 北京时间 → UTC Date */
function bj(isoLocal: string) {
  return new Date(`${isoLocal}+08:00`);
}

function testComputeNextTrafficResetAt() {
  // 北京时间 0 点执行
  assert.equal(computeNextTrafficResetAt(15, bj("2026-11-27T10:00:00")).toISOString(), bj("2026-12-15T00:00:00").toISOString());
  assert.equal(computeNextTrafficResetAt(28, bj("2026-11-27T10:00:00")).toISOString(), bj("2026-11-28T00:00:00").toISOString());
  // 31 号：30 天的月份在月末执行
  assert.equal(computeNextTrafficResetAt(31, bj("2026-11-27T10:00:00")).toISOString(), bj("2026-11-30T00:00:00").toISOString());
  assert.equal(computeNextTrafficResetAt(31, bj("2026-11-30T00:00:00")).toISOString(), bj("2026-12-31T00:00:00").toISOString());
  // 2 月：平年 28 号、闰年 29 号
  assert.equal(computeNextTrafficResetAt(30, bj("2027-01-31T00:00:00")).toISOString(), bj("2027-02-28T00:00:00").toISOString());
  assert.equal(computeNextTrafficResetAt(31, bj("2028-02-01T00:00:00")).toISOString(), bj("2028-02-29T00:00:00").toISOString());
  // 严格晚于给定时间：正好在重置时刻时取下个月
  assert.equal(computeNextTrafficResetAt(1, bj("2026-12-01T00:00:00")).toISOString(), bj("2027-01-01T00:00:00").toISOString());
  // 跨年
  assert.equal(computeNextTrafficResetAt(5, bj("2026-12-20T00:00:00")).toISOString(), bj("2027-01-05T00:00:00").toISOString());
  // 时区边界：UTC 11-30 17:00 已是北京时间 12-01 01:00，1 号的重置已过，下次是 1 月 1 日
  assert.equal(computeNextTrafficResetAt(1, new Date("2026-11-30T17:00:00Z")).toISOString(), bj("2027-01-01T00:00:00").toISOString());
  assert.equal(defaultTrafficResetDay(new Date("2026-11-30T17:00:00Z")), 1);
  assert.equal(defaultTrafficResetDay(new Date("2026-11-30T15:59:59Z")), 30);
  // 管理界面的默认值与后台一致
  for (let hour = 0; hour < 24 * 400; hour += 7) {
    const at = new Date(Date.UTC(2026, 0, 1) + hour * 3600_000);
    assert.equal(defaultTrafficResetDayForNewSubscription(at), defaultTrafficResetDay(at));
  }
  assert.throws(() => computeNextTrafficResetAt(0, new Date()), RangeError);
  assert.throws(() => computeNextTrafficResetAt(32, new Date()), RangeError);
  assert.throws(() => computeNextTrafficResetAt(1.5, new Date()), RangeError);
}

function testDtoValidation() {
  const base = { userId: "u", planId: "p", expireAt: "2027-01-01T00:00:00.000Z" };
  const errors = (cls: any, body: Record<string, unknown>) => validateSync(plainToInstance(cls, body) as object);
  assert.equal(errors(CreateSubscriptionDto, base).length, 0, "不传重置日合法（后台默认开通日）");
  assert.equal(errors(CreateSubscriptionDto, { ...base, trafficResetDay: null }).length, 0, "null 表示不自动重置");
  assert.equal(errors(CreateSubscriptionDto, { ...base, trafficResetDay: 31 }).length, 0);
  for (const bad of [0, 32, 1.5, "15"]) {
    assert.ok(errors(CreateSubscriptionDto, { ...base, trafficResetDay: bad }).length > 0, `重置日 ${String(bad)} 应被拒绝`);
  }
  assert.ok(errors(UpdateSubscriptionDto, { trafficResetDay: 0 }).length > 0);
  assert.equal(errors(UpdateSubscriptionDto, { trafficResetDay: null }).length, 0);
  assert.ok(errors(CreateTeamSubscriptionDto, { planId: "p", expireAt: base.expireAt, trafficResetDay: 40 }).length > 0);
}

function testResolveTrafficResetScheduleForUpdate() {
  const service = createInstance<any>(AdminSubscriptionService.prototype, {});
  const next = new Date("2026-12-15T00:00:00+08:00");
  assert.deepEqual(service.resolveTrafficResetScheduleForUpdate({ trafficResetDay: 15, nextTrafficResetAt: next }, undefined), {});
  assert.deepEqual(service.resolveTrafficResetScheduleForUpdate({ trafficResetDay: 15, nextTrafficResetAt: next }, 15), {}, "重置日没变时不重算下次时间");
  assert.deepEqual(service.resolveTrafficResetScheduleForUpdate({ trafficResetDay: 15, nextTrafficResetAt: next }, null), {
    trafficResetDay: null,
    nextTrafficResetAt: null
  });
  const changed = service.resolveTrafficResetScheduleForUpdate({ trafficResetDay: 15, nextTrafficResetAt: next }, 3);
  assert.equal(changed.trafficResetDay, 3);
  assert.ok(changed.nextTrafficResetAt instanceof Date && changed.nextTrafficResetAt.getTime() > Date.now());
  assert.throws(() => service.resolveTrafficResetScheduleForUpdate({}, 0), /1 到 31/);
}

function createResetHarness(initial: Record<string, any>) {
  const state: { row: Record<string, any>; updates: any[]; ledgerDeletes: any[]; accessSyncs: number; published: number; quiesced: number } = {
    row: { ...initial },
    updates: [],
    ledgerDeletes: [],
    accessSyncs: 0,
    published: 0,
    quiesced: 0
  };
  const withIncludes = () => ({ ...state.row, plan: { name: "Plan" }, user: null, team: state.row.teamId ? { name: "Team" } : null, nodeAccesses: [] });
  const tx = {
    panelClientBinding: { findMany: async () => [] },
    subscription: {
      findUnique: async () => withIncludes(),
      update: async (payload: any) => {
        state.updates.push(payload);
        state.row = { ...state.row, ...payload.data };
        return withIncludes();
      }
    },
    trafficLedger: {
      deleteMany: async (payload: any) => {
        state.ledgerDeletes.push(payload);
        return { count: 0 };
      },
      aggregate: async () => ({ _sum: { usedTrafficGb: 0, usedTrafficBytes: 0n } })
    }
  };
  const service = createInstance<AdminSubscriptionService>(AdminSubscriptionService.prototype, {
    prisma: {
      ...tx,
      $transaction: async (task: (writer: any) => unknown) => task(tx)
    },
    runtimeSessionService: {
      withDirectTrafficResetInFlight: async (_id: string, task: () => Promise<unknown>) => task(),
      quiesceDirectBindingsForTrafficReset: async () => {
        state.quiesced += 1;
        return [];
      }
    },
    requireSubscription: async () => withIncludes(),
    syncDirectSubscriptionAccessBestEffort: async () => {
      state.accessSyncs += 1;
      return { ok: true };
    },
    publishSubscriptionUpdatedEvent: async () => {
      state.published += 1;
    }
  });
  return { service, state };
}

async function testScheduledResetClearsTeamPoolOnceAndAdvances() {
  const dueAt = bj("2026-11-15T00:00:00");
  const { service, state } = createResetHarness({
    id: "sub_team",
    userId: null,
    teamId: "team_1",
    planId: "plan_team",
    totalTrafficGb: 500,
    usedTrafficGb: 500,
    remainingTrafficGb: 0,
    totalTrafficBytes: 500n * 1024n ** 3n,
    usedTrafficBytes: 500n * 1024n ** 3n,
    expireAt: bj("2027-06-01T00:00:00"),
    state: "exhausted",
    renewable: true,
    sourceAction: "created",
    lastSyncedAt: new Date(),
    trafficResetDay: 15,
    nextTrafficResetAt: dueAt,
    lastTrafficAutoResetAt: null
  });

  assert.equal(await service.runScheduledTrafficReset("sub_team", dueAt), "reset");
  assert.equal(state.updates.length, 1);
  assert.equal(state.row.usedTrafficGb, 0);
  assert.equal(state.row.usedTrafficBytes, 0n);
  assert.equal(state.row.remainingTrafficGb, 500);
  assert.equal(state.row.state, "active", "流量用完被停的订阅，重置后恢复");
  assert.deepEqual(state.ledgerDeletes[0].where, { teamId: "team_1", subscriptionId: "sub_team" }, "团队订阅整队清零");
  assert.ok(state.row.nextTrafficResetAt.getTime() > Date.now(), "下次重置推到将来");
  assert.equal(new Date(state.row.nextTrafficResetAt.getTime() + 8 * 3600_000).getUTCDate() <= 15, true);
  assert.ok(state.row.lastTrafficAutoResetAt instanceof Date);
  assert.equal(state.accessSyncs, 1, "重置后把新额度推给节点");
  assert.equal(state.published, 1);

  // 同一个计划时间再来一次（另一个进程或重复调用）：不再清零
  state.row.usedTrafficGb = 3;
  assert.equal(await service.runScheduledTrafficReset("sub_team", dueAt), "superseded");
  assert.equal(state.updates.length, 1);
  assert.equal(state.row.usedTrafficGb, 3);
  assert.equal(state.quiesced, 1, "已处理的计划不再暂停节点账号");
}

async function testScheduledResetKeepsPausedAndSupersedesInsideLock() {
  const dueAt = bj("2026-11-01T00:00:00");
  const { service, state } = createResetHarness({
    id: "sub_user",
    userId: "user_1",
    teamId: null,
    planId: "plan",
    totalTrafficGb: 500,
    usedTrafficGb: 120,
    remainingTrafficGb: 380,
    totalTrafficBytes: 0n,
    usedTrafficBytes: 0n,
    expireAt: bj("2027-06-01T00:00:00"),
    state: "paused",
    renewable: true,
    sourceAction: "created",
    lastSyncedAt: new Date(),
    trafficResetDay: 1,
    nextTrafficResetAt: dueAt,
    lastTrafficAutoResetAt: null
  });
  assert.equal(await service.runScheduledTrafficReset("sub_user", dueAt), "reset");
  assert.equal(state.row.state, "paused", "暂停的订阅重置后仍保持暂停");
  assert.equal(state.row.usedTrafficGb, 0);

  // 管理员在执行前改了重置日：锁内复核发现计划已变，不执行
  const second = createResetHarness({ ...state.row, usedTrafficGb: 50, nextTrafficResetAt: dueAt });
  (second.service as any).requireSubscription = async () => ({ ...second.state.row, plan: { name: "Plan" }, user: null, team: null, nodeAccesses: [] });
  const originalFindUnique = (second.service as any).prisma.subscription.findUnique;
  let calls = 0;
  (second.service as any).prisma.subscription.findUnique = async (...args: unknown[]) => {
    calls += 1;
    if (calls === 1) return { nextTrafficResetAt: bj("2026-12-20T00:00:00") };
    return originalFindUnique(...args);
  };
  assert.equal(await second.service.runScheduledTrafficReset("sub_user", dueAt), "superseded");
  assert.equal(second.state.updates.length, 0);
  assert.equal(second.state.quiesced, 0);
  assert.equal(second.state.accessSyncs, 0);
}

async function testSchedulerSkipsExpiredAndBacksOffOnFailure() {
  const now = bj("2026-12-01T00:00:20");
  const rows = [
    { id: "expired", nextTrafficResetAt: bj("2026-12-01T00:00:00"), expireAt: bj("2026-11-20T00:00:00"), state: "active" },
    { id: "failing", nextTrafficResetAt: bj("2026-12-01T00:00:00"), expireAt: bj("2027-11-20T00:00:00"), state: "active" },
    { id: "ok", nextTrafficResetAt: bj("2026-12-01T00:00:00"), expireAt: bj("2027-11-20T00:00:00"), state: "exhausted" }
  ];
  const calls: string[] = [];
  const scheduler = new TrafficResetScheduleService(
    {
      subscription: {
        findMany: async (query: any) => {
          assert.ok(query.where.nextTrafficResetAt.lte instanceof Date, "只取已到点的订阅");
          const excluded: string[] = query.where.id?.notIn ?? [];
          return rows.filter((row) => !excluded.includes(row.id));
        }
      }
    } as any,
    {
      skipScheduledTrafficReset: async (id: string) => {
        calls.push(`skip:${id}`);
        return true;
      },
      runScheduledTrafficReset: async (id: string) => {
        calls.push(`reset:${id}`);
        if (id === "failing") throw new Error("节点离线，用量结不清");
        return "reset";
      }
    } as any
  );
  (scheduler as any).logger = { log: () => undefined, warn: () => undefined };
  await scheduler.runDueTrafficResetsAt(now);
  assert.deepEqual(calls, ["skip:expired", "reset:failing", "reset:ok"]);

  calls.length = 0;
  await scheduler.runDueTrafficResetsAt(new Date(now.getTime() + 60_000));
  assert.deepEqual(calls, ["skip:expired", "reset:ok"], "失败的订阅 30 分钟内不重试");

  calls.length = 0;
  await scheduler.runDueTrafficResetsAt(new Date(now.getTime() + 31 * 60_000));
  assert.ok(calls.includes("reset:failing"), "30 分钟后重试");
}

async function testSchedulerBackoffDoesNotStarveLaterSubscriptions() {
  const now = bj("2026-12-01T00:00:20");
  const rows = Array.from({ length: 40 }, (_, index) => ({
    id: `sub_${String(index).padStart(2, "0")}`,
    nextTrafficResetAt: bj("2026-12-01T00:00:00"),
    expireAt: bj("2027-11-20T00:00:00"),
    state: "active"
  }));
  const failing = new Set(rows.slice(0, 30).map((row) => row.id));
  const resetDone = new Set<string>();
  const scheduler = new TrafficResetScheduleService(
    {
      subscription: {
        findMany: async (query: any) => {
          const excluded: string[] = query.where.id?.notIn ?? [];
          return rows.filter((row) => !excluded.includes(row.id) && !resetDone.has(row.id)).slice(0, query.take);
        }
      }
    } as any,
    {
      skipScheduledTrafficReset: async () => true,
      runScheduledTrafficReset: async (id: string) => {
        if (failing.has(id)) throw new Error("结不清");
        resetDone.add(id);
        return "reset";
      }
    } as any
  );
  (scheduler as any).logger = { log: () => undefined, warn: () => undefined };
  for (let minute = 0; minute < 5; minute += 1) {
    await scheduler.runDueTrafficResetsAt(new Date(now.getTime() + minute * 60_000));
  }
  assert.equal(resetDone.size, 10, "前 30 个反复失败的订阅在退避期间不占名额，后面 10 个都能重置");
}

async function testSkipRequiresStillExpiredAtUpdate() {
  const dueAt = bj("2026-12-01T00:00:00");
  const now = bj("2026-12-01T00:00:20");
  let where: any = null;
  const service = createInstance<AdminSubscriptionService>(AdminSubscriptionService.prototype, {
    prisma: {
      subscription: {
        findUnique: async () => ({ trafficResetDay: 1 }),
        updateMany: async (payload: any) => {
          where = payload.where;
          return { count: 0 };
        }
      }
    }
  });
  assert.equal(await service.skipScheduledTrafficReset("sub", dueAt, now), false);
  assert.deepEqual(where, {
    id: "sub",
    nextTrafficResetAt: dueAt,
    OR: [{ state: "expired" }, { expireAt: { lte: now } }]
  }, "跳过只在更新那一刻仍过期时生效");
}

async function main() {
  testComputeNextTrafficResetAt();
  testDtoValidation();
  testResolveTrafficResetScheduleForUpdate();
  await testScheduledResetClearsTeamPoolOnceAndAdvances();
  await testScheduledResetKeepsPausedAndSupersedesInsideLock();
  await testSchedulerSkipsExpiredAndBacksOffOnFailure();
  await testSchedulerBackoffDoesNotStarveLaterSubscriptions();
  await testSkipRequiresStillExpiredAtUpdate();
  console.log("traffic-reset-schedule regression passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
