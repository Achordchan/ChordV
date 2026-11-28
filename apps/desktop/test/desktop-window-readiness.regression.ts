import assert from "node:assert/strict";
import { test } from "node:test";
import { cancelDesktopWindowResize, resizeDesktopWindow } from "../src/lib/desktopWindowLayout";

test("真实窗口队列区分失效、失败和实际完成，不把跳过的RPC当布局就绪", async () => {
  const beforeWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const beforeMygo = Object.getOwnPropertyDescriptor(globalThis, "mygo");
  const calls: boolean[] = [];
  let enter: () => void = () => {}, release: () => void = () => {};
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const delayed = new Promise<void>(resolve => { release = resolve; });
  let wait = false, reject = false;
  const bridge = { platform: "macos", call: async (method: string, command: string, payload: { signedIn: boolean }) => {
    assert.equal(method, "DesktopService.Invoke");
    assert.equal(command, "transition_main_window");
    calls.push(payload.signedIn);
    if (reject) throw new Error("test-only resize rejection");
    if (wait) { enter(); await delayed; }
    return null;
  } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { mygo: bridge } });
  Object.defineProperty(globalThis, "mygo", { configurable: true, value: bridge });
  try {
    const skipped = resizeDesktopWindow(false, false);
    cancelDesktopWindowResize();
    assert.equal(await skipped, false);
    assert.deepEqual(calls, []);
    wait = true;
    const superseded = resizeDesktopWindow(true, false);
    await entered;
    const current = resizeDesktopWindow(false, false);
    wait = false;
    release();
    assert.equal(await superseded, false);
    assert.equal(await current, true);
    assert.deepEqual(calls, [true, false]);
    reject = true;
    await assert.rejects(resizeDesktopWindow(true, false), /resize rejection/);
    reject = false;
    assert.equal(await resizeDesktopWindow(false, false), true, "一次失败不能永久阻断后续真实窗口请求");
  } finally {
    release();
    cancelDesktopWindowResize();
    if (beforeWindow) Object.defineProperty(globalThis, "window", beforeWindow); else Reflect.deleteProperty(globalThis, "window");
    if (beforeMygo) Object.defineProperty(globalThis, "mygo", beforeMygo); else Reflect.deleteProperty(globalThis, "mygo");
  }
});
