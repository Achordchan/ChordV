import assert from "node:assert/strict";
import { RuntimeSessionService } from "../src/modules/common/runtime-session.service";
import {
  DEFAULT_LEASE_OFFLINE_HOLD_SECONDS,
  getLeaseAbandonCutoff,
  isLeaseAbandoned,
  isLeaseHardExpired,
  LEASE_GRACE_SECONDS,
  LEASE_OFFLINE_HOLD_SECONDS,
  resolveLeaseOfflineHoldSeconds
} from "../src/modules/common/runtime-session.utils";

// A connected client's tunnel does not depend on the control plane. These cover
// the control plane's half of letting it ride out an outage: a lease that went
// silent stays resumable for the offline hold, and resuming it is decided like
// a connect.

type LeaseRow = Record<string, unknown> & { id: string; expiresAt: Date };

function staleLease(overrides: Record<string, unknown> = {}): LeaseRow {
  return {
    id: "lease_1",
    sessionId: "session_1",
    userId: "user_1",
    subscriptionId: "sub_1",
    nodeId: "node_1",
    status: "active",
    // An hour past the TTL: far beyond the grace, well inside the hold.
    expiresAt: new Date(Date.now() - 3600_000),
    lastHeartbeatAt: new Date(Date.now() - 3600_000 - 1800_000),
    revokedReason: null,
    xrayUserEmail: "demo@example.com",
    xrayUserUuid: "uuid_1",
    node: { id: "node_1", flow: "" },
    ...overrides
  } as LeaseRow;
}

function createService(options: {
  lease: LeaseRow;
  currentConnections: number;
  planLimit?: number | null;
  userOverride?: number | null;
  onLock?: () => void;
  events: string[];
}) {
  const revoked: Array<{ leaseId: string; reason: string }> = [];
  const updates: Array<Record<string, any>> = [];
  const counts: Array<Record<string, any>> = [];
  const service = Object.assign(Object.create(RuntimeSessionService.prototype), {
    resolveActiveUserFromToken: async () => ({ id: "user_1" }),
    assertLeaseCanHeartbeat: async () => { options.events.push("eligibility"); },
    logLeaseWarning: () => undefined,
    refreshActiveRuntimeLease: () => undefined,
    revokeLease: async (leaseId: string, _node: unknown, reason: string) => {
      options.events.push(`revoke:${reason}`);
      revoked.push({ leaseId, reason });
    },
    runWithDistributedUserLeaseLock: async (userId: string, task: () => Promise<unknown>) => {
      options.events.push(`lock:${userId}`);
      options.onLock?.();
      try {
        return await task();
      } finally {
        options.events.push("unlock");
      }
    },
    prisma: {
      nodeSessionLease: {
        findUnique: async () => options.lease,
        count: async (query: Record<string, any>) => {
          options.events.push("count");
          counts.push(query);
          return options.currentConnections;
        },
        updateMany: async (payload: Record<string, any>) => {
          options.events.push("renew");
          updates.push(payload);
          return { count: 1 };
        }
      },
      user: {
        findUnique: async () => ({ maxConcurrentSessionsOverride: options.userOverride ?? null })
      },
      subscription: {
        findUnique: async () => ({ plan: { maxConcurrentSessions: options.planLimit === undefined ? 1 : options.planLimit } })
      }
    }
  }) as RuntimeSessionService;
  return { service, revoked, updates, counts };
}

async function main() {
  // --- the setting -----------------------------------------------------------

  assert.equal(DEFAULT_LEASE_OFFLINE_HOLD_SECONDS, 24 * 60 * 60);
  assert.equal(resolveLeaseOfflineHoldSeconds(undefined), DEFAULT_LEASE_OFFLINE_HOLD_SECONDS);
  assert.equal(resolveLeaseOfflineHoldSeconds(""), DEFAULT_LEASE_OFFLINE_HOLD_SECONDS);
  assert.equal(resolveLeaseOfflineHoldSeconds("3600"), 3600);
  assert.equal(resolveLeaseOfflineHoldSeconds(" 7200 "), 7200);
  // 0 is a real choice — the behaviour before the hold existed — not "unset".
  assert.equal(resolveLeaseOfflineHoldSeconds("0"), 0);
  // Number("") is 0 and Number("abc") is NaN; neither may leak through as a
  // hold of zero or as a NaN that makes every comparison false.
  for (const bad of ["abc", "-1", "1.5", "24h", "1e3", "99999999999999999999"]) {
    assert.equal(resolveLeaseOfflineHoldSeconds(bad), DEFAULT_LEASE_OFFLINE_HOLD_SECONDS, `${bad} 应回退默认值`);
  }

  // --- stale is not abandoned --------------------------------------------------

  const now = new Date("2026-11-26T04:00:00.000Z");
  const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);
  // grace 300, hold 3600.
  assert.equal(isLeaseHardExpired(ago(299), now, 300), false);
  assert.equal(isLeaseHardExpired(ago(301), now, 300), true, "超过 TTL + 宽限即为失联");
  assert.equal(isLeaseAbandoned(ago(301), now, 300, 3600), false, "失联但在保持期内，不算放弃");
  assert.equal(isLeaseAbandoned(ago(3899), now, 300, 3600), false);
  assert.equal(isLeaseAbandoned(ago(3901), now, 300, 3600), true, "超过保持期才算放弃");
  // With no hold the two are the same instant, which is what makes 0 the old
  // behaviour exactly.
  for (const seconds of [0, 299, 300, 301, 5000]) {
    assert.equal(isLeaseAbandoned(ago(seconds), now, 300, 0), isLeaseHardExpired(ago(seconds), now, 300));
  }
  assert.equal(getLeaseAbandonCutoff(now, 300, 3600).getTime(), now.getTime() - 3900_000);
  // The sweep and the heartbeat must agree on the boundary, or a lease could be
  // revoked by one while the other would still have resumed it.
  const cutoff = getLeaseAbandonCutoff(now, 300, 3600);
  for (const seconds of [3899, 3901]) {
    assert.equal(ago(seconds).getTime() < cutoff.getTime(), isLeaseAbandoned(ago(seconds), now, 300, 3600));
  }

  assert.ok(LEASE_OFFLINE_HOLD_SECONDS > 3600 + LEASE_GRACE_SECONDS, "以下用例假设默认保持期远大于一小时");

  // --- resuming ----------------------------------------------------------------

  // The slot is free: the client carries on with the SAME session, no reconnect.
  {
    const events: string[] = [];
    const { service, revoked, updates, counts } = createService({ lease: staleLease(), currentConnections: 0, events });
    const result = await service.heartbeatSession("session_1", "Bearer token");
    assert.equal(result.status, "active");
    assert.equal(result.sessionId, "session_1");
    assert.ok(new Date(result.leaseExpiresAt).getTime() > Date.now(), "恢复后租约应重新续期");
    assert.equal(revoked.length, 0);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].where.status, "active");
    // Subscription, node access and binding are checked exactly as for any
    // heartbeat, BEFORE the slot is considered: a client whose subscription
    // ended during the outage is told that, not that it was taken over.
    assert.deepEqual(events, ["eligibility", "lock:user_1", "count", "renew", "unlock"],
      "恢复必须先过常规校验，再在用户连接锁内判定名额并续期");
    // Counted the way a connect counts: connections that are current, and not
    // this lease itself.
    const where = counts[0].where;
    assert.equal(where.userId, "user_1");
    assert.equal(where.status, "active");
    assert.deepEqual(where.id, { not: "lease_1" });
    const freshness = where.expiresAt.gt.getTime();
    assert.ok(Math.abs(freshness - (Date.now() - LEASE_GRACE_SECONDS * 1000)) < 5_000, "只统计仍在 TTL + 宽限内的连接");
  }

  // The slot was taken while this client was silent: the newer connection
  // keeps it, exactly as if it had taken over a live one.
  {
    const events: string[] = [];
    const { service, revoked, updates } = createService({ lease: staleLease(), currentConnections: 1, planLimit: 1, events });
    await assert.rejects(() => service.heartbeatSession("session_1", "Bearer token"), /当前连接已被其他设备接管/);
    assert.deepEqual(revoked, [{ leaseId: "lease_1", reason: "concurrency_limit" }]);
    assert.equal(updates.length, 0, "名额已被占用时不得续期");
    assert.deepEqual(events, ["eligibility", "lock:user_1", "count", "revoke:concurrency_limit", "unlock"]);
  }

  // The limit is the user's override, then the plan's, as on connect.
  {
    const events: string[] = [];
    const { service, revoked } = createService({ lease: staleLease(), currentConnections: 2, planLimit: 1, userOverride: 3, events });
    const result = await service.heartbeatSession("session_1", "Bearer token");
    assert.equal(result.status, "active", "用户单独放宽的并发数应优先于套餐");
    assert.equal(revoked.length, 0);
  }
  {
    const events: string[] = [];
    const { service, revoked } = createService({ lease: staleLease(), currentConnections: 2, planLimit: 5, userOverride: 2, events });
    await assert.rejects(() => service.heartbeatSession("session_1", "Bearer token"), /其他设备接管/);
    assert.equal(revoked.length, 1, "用户单独收紧的并发数同样优先于套餐");
  }

  // A lease that is merely late (inside the grace) is renewed as it always was:
  // no lock, no count. The hold must not put a database round trip and a
  // per-user lock on every ordinary heartbeat.
  {
    const events: string[] = [];
    const { service } = createService({
      lease: staleLease({ expiresAt: new Date(Date.now() - 5_000) }),
      currentConnections: 99,
      events
    });
    const result = await service.heartbeatSession("session_1", "Bearer token");
    assert.equal(result.status, "active");
    assert.deepEqual(events, ["eligibility", "renew"]);
  }

  // Past the hold the lease is gone for good, without consulting anything.
  {
    const events: string[] = [];
    const { service, revoked, updates } = createService({
      lease: staleLease({
        expiresAt: new Date(Date.now() - ((LEASE_GRACE_SECONDS + LEASE_OFFLINE_HOLD_SECONDS) * 1000 + 5_000))
      }),
      currentConnections: 0,
      events
    });
    await assert.rejects(() => service.heartbeatSession("session_1", "Bearer token"), /会话已过期/);
    assert.deepEqual(revoked, [{ leaseId: "lease_1", reason: "lease_expired" }]);
    assert.equal(updates.length, 0);
    assert.deepEqual(events, ["revoke:lease_expired"]);
  }

  // A lease the control plane ended on purpose is not resumable by silence
  // followed by a heartbeat, however recent.
  {
    const events: string[] = [];
    const { service, updates } = createService({
      lease: staleLease({ status: "revoked", revokedReason: "admin_user_disconnected" }),
      currentConnections: 0,
      events
    });
    await assert.rejects(() => service.heartbeatSession("session_1", "Bearer token"), /管理员已暂停当前连接/);
    assert.equal(updates.length, 0);
    assert.deepEqual(events, []);
  }

  console.log("lease-offline-hold.regression.ts passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
