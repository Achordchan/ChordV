import assert from "node:assert/strict";
import { test } from "node:test";
import { createIdleRuntimeStatus } from "../src/lib/nativeRuntime";
import { COMPONENT_CHECK_INTERVAL_MS, COMPONENT_CHECK_RETRY_BASE_MS, COMPONENT_CHECK_RETRY_MAX_MS,
  COMPONENT_CHECK_THROTTLE_MS, createComponentSyncLoop, type ComponentSyncState } from "../src/lib/componentSyncLoop";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function harness() {
  let now = 1_000_000, nextTimer = 0, active = 0, maxActive = 0, reads = 0;
  let configured = true, nativeConnected = false;
  let state: ComponentSyncState = { syncError: null, deferred: false };
  const changes: ComponentSyncState[] = [];
  const context = { accessToken: "test-only-token" as string | null, platform: "macos", enabled: true, blocked: false, inUse: false, visible: true };
  const timers = new Map<number, { at: number; callback: () => void }>();
  const requests: Array<{ resolve: (success: boolean) => void; reject: () => void }> = [];
  const loop = createComponentSyncLoop({
    context: () => context, configured: () => configured,
    loadStatus: async () => { reads++; return { ...createIdleRuntimeStatus("macos"), status: nativeConnected ? "connected" : "idle" }; },
    onStatus: status => { context.inUse = status.status === "connected"; },
    ensure: () => { active++; maxActive = Math.max(active, maxActive); return new Promise((resolve, reject) => {
      requests.push({ resolve: success => { active--; resolve(success); }, reject: () => { active--; reject(new Error("test-only failure")); } });
    }); },
    onState: next => { state = next; changes.push(next); }, now: () => now,
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout: handle => { timers.delete(handle as number); }
  });
  const tick = async (ms = 0) => {
    const end = now + ms;
    for (;;) {
      const next = [...timers].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].callback(); await flush();
    }
    now = end; await flush();
  };
  return { loop, context, timers, requests, changes, tick, state: () => state,
    counts: () => ({ active, maxActive, reads }), delay: () => Math.min(...[...timers.values()].map(task => task.at - now)),
    configure: (value: boolean) => { configured = value; }, native: (value: boolean) => { nativeConnected = value; } };
}

test("登录立即检查，12小时正常周期与30秒事件节流共用单飞和一个计时器", async () => {
  const h = harness(); h.loop.update(); await h.tick();
  assert.equal(h.requests.length, 1); assert.equal(h.timers.size, 0);
  h.loop.request(); h.loop.request(); h.loop.request();
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve(true); await flush();
  assert.equal(h.timers.size, 1); assert.equal(h.delay(), COMPONENT_CHECK_THROTTLE_MS);
  await h.tick(COMPONENT_CHECK_THROTTLE_MS - 1); assert.equal(h.requests.length, 1);
  await h.tick(1); assert.equal(h.requests.length, 2);
  h.requests[1].resolve(true); await flush(); assert.equal(h.delay(), COMPONENT_CHECK_INTERVAL_MS);
  await h.tick(COMPONENT_CHECK_INTERVAL_MS - 1); assert.equal(h.requests.length, 2);
  await h.tick(1); assert.equal(h.requests.length, 3); assert.equal(h.counts().maxActive, 1);
  h.requests[2].resolve(true); await flush(); h.loop.stop(); assert.equal(h.timers.size, 0);
});

test("失败按5/10/20/40/60分钟退避并封顶，事件和正常周期不能绕过", async () => {
  const h = harness(); h.loop.update(); await h.tick();
  const delays = [5, 10, 20, 40, 60, ...Array<number>(12).fill(60)].map(minutes => minutes * 60_000);
  for (let index = 0; index < delays.length; index++) {
    h.requests[index].resolve(false); await flush(); assert.ok(h.state().syncError);
    assert.equal(h.delay(), delays[index]);
    h.loop.request(); h.loop.update(); assert.equal(h.delay(), delays[index]);
    await h.tick(delays[index] - 1); assert.equal(h.requests.length, index + 1);
    await h.tick(1); assert.equal(h.requests.length, index + 2);
  }
  assert.equal(delays[0], COMPONENT_CHECK_RETRY_BASE_MS); assert.equal(delays.at(-1), COMPONENT_CHECK_RETRY_MAX_MS);
  h.requests.at(-1)!.resolve(true); await flush();
  assert.equal(h.state().syncError, null); assert.equal(h.delay(), COMPONENT_CHECK_INTERVAL_MS); h.loop.stop();
});

test("隐藏、内核使用中、应用更新或组件忙时暂停，恢复只执行合并检查", async () => {
  const h = harness(); h.context.visible = false; h.loop.update(); h.loop.request();
  assert.equal(h.timers.size, 0); await h.tick(COMPONENT_CHECK_INTERVAL_MS); assert.equal(h.requests.length, 0);
  h.context.visible = true; h.context.inUse = true; h.loop.update();
  assert.equal(h.state().deferred, true); assert.equal(h.timers.size, 0);
  h.context.inUse = false; h.context.blocked = true; h.loop.update(); assert.equal(h.timers.size, 0);
  h.context.blocked = false; h.context.enabled = false; h.loop.update(); assert.equal(h.timers.size, 0);
  h.context.enabled = true; h.loop.update(); await h.tick(); assert.equal(h.requests.length, 1);
  h.requests[0].resolve(true); await flush();
  h.context.visible = false; h.loop.update(); assert.equal(h.timers.size, 0);
  h.context.visible = true; h.loop.request(); await h.tick(COMPONENT_CHECK_THROTTLE_MS); assert.equal(h.requests.length, 2);
  h.requests[1].resolve(true); await flush(); h.loop.stop();
});

test("原生内核状态领先React时暂缓且不重复请求或打断连接", async () => {
  const h = harness(); h.native(true); h.loop.update(); await h.tick();
  assert.equal(h.requests.length, 0); assert.equal(h.counts().reads, 1); assert.equal(h.timers.size, 0); assert.equal(h.state().deferred, true);
  await h.tick(COMPONENT_CHECK_INTERVAL_MS); assert.equal(h.counts().reads, 1);
  h.native(false); h.context.inUse = false; h.loop.update(); await h.tick(); assert.equal(h.requests.length, 1);
  h.requests[0].resolve(true); await flush(); h.loop.stop();
});

test("未配置、未登录与不支持的平台没有定时器或同步失败，卸载清理幂等", async () => {
  const h = harness(); h.configure(false); h.loop.update(); h.loop.request();
  await h.tick(COMPONENT_CHECK_INTERVAL_MS * 3); assert.equal(h.requests.length, 0); assert.equal(h.timers.size, 0); assert.equal(h.state().syncError, null);
  h.configure(true); h.context.accessToken = null; h.loop.update(); h.loop.request(); assert.equal(h.timers.size, 0);
  h.context.accessToken = "test-only-token"; h.context.platform = "linux"; h.loop.update(); assert.equal(h.timers.size, 0);
  h.context.platform = "macos"; h.loop.update(); await h.tick(); assert.equal(h.requests.length, 1);
  h.loop.stop(); h.loop.stop(); const changes = h.changes.length;
  h.requests[0].reject(); await flush(); h.loop.request(); h.loop.update(); await h.tick(COMPONENT_CHECK_INTERVAL_MS * 2);
  assert.equal(h.requests.length, 1); assert.equal(h.timers.size, 0); assert.equal(h.changes.length, changes);
});

test("登出或切换身份隔离迟到失败，新会话仍保持单飞", async () => {
  const h = harness(); h.loop.update(); await h.tick();
  h.context.accessToken = null; h.loop.update(); assert.equal(h.timers.size, 0);
  h.context.accessToken = "test-only-next-token"; h.loop.update(); await h.tick(); assert.equal(h.requests.length, 1);
  h.requests[0].reject(); await flush(); assert.equal(h.state().syncError, null);
  await h.tick(); assert.equal(h.requests.length, 2); assert.equal(h.counts().maxActive, 1);
  h.requests[1].resolve(true); await flush(); h.loop.stop();
});

test("手动成功解除失败退避，旧在途失败不能覆盖手动成功", async () => {
  const h = harness(); h.loop.update(); await h.tick(); h.requests[0].reject(); await flush();
  assert.equal(h.delay(), COMPONENT_CHECK_RETRY_BASE_MS); assert.ok(h.state().syncError);
  h.loop.manualSuccess(); assert.equal(h.state().syncError, null); assert.equal(h.delay(), COMPONENT_CHECK_INTERVAL_MS);
  h.loop.request(); assert.equal(h.delay(), COMPONENT_CHECK_THROTTLE_MS);
  await h.tick(COMPONENT_CHECK_THROTTLE_MS); assert.equal(h.requests.length, 2);
  h.loop.manualSuccess(); h.requests[1].reject(); await flush();
  assert.equal(h.state().syncError, null); assert.equal(h.delay(), COMPONENT_CHECK_INTERVAL_MS); h.loop.stop();
});

test("在途检查期间失去来源配置会停止后续巡检，不产生同步失败循环", async () => {
  const h = harness(); h.loop.update(); await h.tick(); h.loop.request(); h.configure(false);
  h.requests[0].resolve(false); await flush();
  assert.equal(h.state().syncError, null); assert.equal(h.timers.size, 0);
  h.loop.request(); await h.tick(COMPONENT_CHECK_INTERVAL_MS * 2); assert.equal(h.requests.length, 1);
  h.configure(true); h.loop.request(); await h.tick(); assert.equal(h.requests.length, 2);
  h.requests[1].resolve(true); await flush(); h.loop.stop();
});
