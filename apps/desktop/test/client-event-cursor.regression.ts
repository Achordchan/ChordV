import assert from "node:assert/strict";
import { test } from "node:test";
import { subscribeClientEvents } from "../src/api/client";
import { isReplayableEventId } from "../src/api/sse";

const instance = "b03f124d-7218-4cd7-bbd1-e1c35d2b98b8";
test("接受Go UUID实例加序列号并兼容旧ID，拒绝非法游标", () => {
  for (const value of [`${instance}:0`, `${instance}:7`, `${instance}:18446744073709551615`, "1710000000000-7"]) assert.equal(isReplayableEventId(value), true, value);
  for (const value of [null, "", "bad-instance:7", `${instance}:00`, `${instance}:-1`, `${instance}:184467440737095516150`, `${instance}:18446744073709551616`, `${instance}:7\r\nX-Header: injected`]) assert.equal(isReplayableEventId(value), false, String(value));
});

test("真实订阅适配器在重连时保留Go游标，不被非法ID覆盖", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalMygo = Object.getOwnPropertyDescriptor(globalThis, "mygo");
  const listeners = new Set<(event: { name: string; payload: unknown }) => void>();
  const timers = new Map<number, () => void>(); let timerID = 0;
  const starts: Array<{ streamId: string; lastEventId: string | null }> = [];
  let started!: () => void;
  let nextStart = new Promise<void>(resolve => { started = resolve; });
  const host = {
    platform: "darwin",
    call: async (method: string, command: string, payload: { input?: { streamId: string; lastEventId: string | null } }) => {
      assert.equal(method, "DesktopService.Invoke");
      if (command === "start_client_event_stream") {
        assert.ok(payload.input); starts.push(payload.input); started();
        return { streamId: payload.input.streamId };
      }
      return { ok: true };
    },
    on: (name: string, listener: (event: { name: string; payload: unknown }) => void) => {
      assert.equal(name, "native-event"); listeners.add(listener); return () => { listeners.delete(listener); };
    }
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    mygo: host, navigator: { userAgent: "macOS" },
    setTimeout: (callback: () => void) => { const id = ++timerID; timers.set(id, callback); return id; },
    clearTimeout: (id: number) => timers.delete(id)
  } });
  Object.defineProperty(globalThis, "mygo", { configurable: true, value: host });
  const emit = (name: string, payload: unknown) => { for (const listener of [...listeners]) listener({ name, payload }); };
  let stop: (() => void) | undefined;
  try {
    stop = subscribeClientEvents("test-only-access-token", { onEvent: () => {}, onError: () => {} });
    await nextStart; assert.equal(starts[0].lastEventId, null);
    const streamId = starts[0].streamId;
    emit("chordv://client-runtime-event-open", { streamId });
    emit("chordv://client-runtime-event", { streamId, eventId: `${instance}:7`, event: { type: "account_updated", occurredAt: "2026-11-16T00:00:00Z" } });
    emit("chordv://client-runtime-event", { streamId, eventId: "bad\r\nHeader: value", event: { type: "keepalive", occurredAt: "2026-11-16T00:00:00Z" } });
    emit("chordv://client-runtime-event-error", { streamId, message: "test-only stream closed", status: null, authError: false });
    assert.equal(timers.size, 1, "只保留一个有界重连计时器，不启动轮询");
    nextStart = new Promise<void>(resolve => { started = resolve; });
    const [id, reconnect] = [...timers][0]; timers.delete(id); reconnect();
    await nextStart;
    assert.equal(starts.length, 2); assert.equal(starts[1].lastEventId, `${instance}:7`);
    stop(); stop = undefined;
    await Promise.resolve();
    assert.equal(listeners.size, 0); assert.equal(timers.size, 0);
  } finally {
    stop?.();
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window");
    if (originalMygo) Object.defineProperty(globalThis, "mygo", originalMygo); else Reflect.deleteProperty(globalThis, "mygo");
  }
});
