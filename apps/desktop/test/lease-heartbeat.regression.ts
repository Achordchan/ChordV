import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiRequestError } from "../src/api/http";
import { createLeaseHeartbeatRunner, readLeaseHeartbeatTiming } from "../src/lib/leaseHeartbeat";

const active = (sessionId = "lease-a") => ({ sessionId, status: "active", leaseExpiresAt: "2099-01-01T00:00:00Z" });
const session = { accessToken: "test-only-new-access" };
function barrier<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const base = { scope: "owner:runtime:a", accessToken: "test-only-access", sessionId: "lease-a", isCurrent: () => true, request: async () => active(), recover: async () => session };

test("只有匹配会话的active和有效续期才是成功，2xx终态直接返回终态", async () => {
  const runner = createLeaseHeartbeatRunner();
  for (const status of ["expired", "evicted", "revoked"]) {
    const result = await runner.run({ ...base, request: async () => ({ ...active(), status }) });
    assert.equal(result.kind, "terminal", status);
  }
  for (const reply of [{ ...active(), status: "unknown" }, { ...active(), status: ["active"] }, { ...active(), sessionId: "other" }, { ...active(), leaseExpiresAt: "bad" }, { ...active(), status: "expired", reasonCode: {} }, {}, null]) {
    assert.equal((await runner.run({ ...base, request: async () => reply })).kind, "transient");
  }
  assert.equal((await runner.run(base)).kind, "active");
});

test("同一租约定时与恢复检查单飞；旧请求迟到或旧401不动新连接", async () => {
  const runner = createLeaseHeartbeatRunner(), pending = barrier<unknown>();
  let calls = 0, recoveries = 0, current = true;
  const request = async () => { calls++; return pending.promise; };
  const first = runner.run({ ...base, request, isCurrent: () => current });
  const second = runner.run({ ...base, request, isCurrent: () => current });
  assert.equal(first, second); assert.equal(calls, 1);
  current = false;
  assert.equal((await runner.run({ ...base, scope: "new-owner", sessionId: "lease-b", request: async () => active("lease-b") })).kind, "active");
  pending.resolve(active()); assert.equal((await first).kind, "stale");
  const unauthorized = barrier<unknown>(); current = true;
  const stale = runner.run({ ...base, isCurrent: () => current, request: async () => unauthorized.promise, recover: async () => { recoveries++; return session; } });
  current = false; unauthorized.resolve(Promise.reject(new ApiRequestError(401, "old owner")));
  assert.equal((await stale).kind, "stale"); assert.equal(recoveries, 0);
});

test("心跳参数拒绝0/负数/非整数/非有限与毫秒越界，不悄悄夹取", () => {
  assert.deepEqual(readLeaseHeartbeatTiming({ leaseHeartbeatIntervalSeconds: 30, leaseGraceSeconds: 300 }), { intervalMs: 30_000, graceMs: 300_000 });
  for (const value of [0, -1, 4, 1.5, NaN, Infinity, 2_147_484, undefined]) {
    assert.throws(() => readLeaseHeartbeatTiming({ leaseHeartbeatIntervalSeconds: value as number, leaseGraceSeconds: 300 }));
  }
  for (const value of [0, -1, 29, 1.5, NaN, Infinity, 2_147_484, undefined]) {
    assert.throws(() => readLeaseHeartbeatTiming({ leaseHeartbeatIntervalSeconds: 30, leaseGraceSeconds: value as number }));
  }
  assert.deepEqual(readLeaseHeartbeatTiming({ leaseHeartbeatIntervalSeconds: 2_147_483, leaseGraceSeconds: 2_147_483 }), { intervalMs: 2_147_483_000, graceMs: 2_147_483_000 });
});

test("401刷新暂错保留临时失败，明确刷新失效才是auth_invalid；成功刷新仅重试一次", async () => {
  const runner = createLeaseHeartbeatRunner();
  const unauthorized = async () => { throw new ApiRequestError(401, "test-only expired"); };
  assert.equal((await runner.run({ ...base, request: unauthorized, recover: async () => ({ accessToken: base.accessToken }) })).kind, "transient");
  assert.equal((await runner.run({ ...base, request: unauthorized, recover: async () => null })).kind, "auth_invalid");
  assert.equal((await runner.run({ ...base, request: unauthorized, recover: async () => { throw new ApiRequestError(503, "test-only outage"); } })).kind, "transient");
  const tokens: string[] = [];
  const result = await runner.run({ ...base, request: async token => { tokens.push(token); if (token === base.accessToken) return unauthorized(); return active(); } });
  assert.equal(result.kind, "active"); assert.deepEqual(tokens, [base.accessToken, session.accessToken]);
});

test("临时失败从首次失败计宽限，成功清零，旧结果和重复结果不影响新连接", async () => {
  const { createLeaseHeartbeatObserver } = await import("../src/lib/leaseHeartbeat");
  const observer = createLeaseHeartbeatObserver();
  const failed = () => ({ kind: "transient" as const, reason: new Error("503: session expired text is not a terminal status") });
  const first = failed();
  assert.equal(observer.observe("a", first, 30_000, 0), "transient");
  assert.equal(observer.observe("a", first, 30_000, 30_000), "ignore", "共享请求的副作用只能执行一次");
  assert.equal(observer.observe("a", failed(), 30_000, 29_999), "transient");
  assert.equal(observer.observe("a", failed(), 30_000, 30_000), "grace_exceeded");
  assert.equal(observer.observe("b", failed(), 30_000, 30_001), "transient", "新连接重新计时");
  assert.equal(observer.observe("b", { kind: "active", lease: active() as never }, 30_000, 50_000), "active");
  assert.equal(observer.observe("b", failed(), 30_000, 60_001), "transient");
  assert.equal(observer.observe("b", { kind: "stale" }, 30_000, 90_000), "ignore");
  assert.equal(observer.observe("b", failed(), 30_000, 90_001), "grace_exceeded");
});

test("桌面界面只接受当前租约的显式terminal，不为原生临时失败另设断连计时", async () => {
  const { classifyNativeLeaseHeartbeat } = await import("../src/lib/leaseHeartbeat");
  const event = { sessionId: "lease-a", status: "error" as const, terminal: false, leaseExpiresAt: null, reasonCode: "session_expired", message: "当前连接已过期" };
  assert.equal(classifyNativeLeaseHeartbeat(event, "lease-a"), "transient");
  assert.equal(classifyNativeLeaseHeartbeat({ ...event, terminal: true }, "lease-a"), "terminal");
  assert.equal(classifyNativeLeaseHeartbeat({ ...event, terminal: true }, "lease-b"), "ignore");
  assert.equal(classifyNativeLeaseHeartbeat({ ...event, status: "ok", leaseExpiresAt: "2099-01-01T00:00:00Z" }, "lease-b"), "ignore");
  assert.equal(classifyNativeLeaseHeartbeat({ ...event, status: "ok", leaseExpiresAt: "2099-01-01T00:00:00Z" }, "lease-a"), "active");
});
