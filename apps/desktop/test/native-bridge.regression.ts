import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

type EventHandler = (event: { name: string; payload: unknown }) => void;

function loadBridge(platform?: string) {
  const calls: unknown[][] = [];
  const nativeHandlers = new Set<EventHandler>();
  const systemHandlers = new Map<string, Set<(value: unknown) => void>>();
  const host = platform ? {
    platform,
    call: () => Promise.resolve(),
    on(name: string, handler: (value: unknown) => void) {
      const handlers = systemHandlers.get(name) ?? new Set();
      handlers.add(handler);
      systemHandlers.set(name, handlers);
      return () => handlers.delete(handler);
    }
  } : undefined;
  const exports: Record<string, any> = {};
  const source = readFileSync(new URL("../src/lib/nativeBridge.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  vm.runInNewContext(code, {
    exports,
    window: { mygo: host },
    require(name: string) {
      assert.equal(name, "./mygo");
      return {
        DesktopService: {
          async invoke(...args: unknown[]) { calls.push(args); return { ok: true }; }
        },
        events: { nativeEvent: { on(handler: EventHandler) {
          nativeHandlers.add(handler);
          return () => nativeHandlers.delete(handler);
        } } }
      };
    }
  });
  return { bridge: exports, calls, nativeHandlers, systemHandlers };
}

for (const [input, expected] of [[undefined, "web"], ["macos", "macos"], ["darwin", "macos"], ["windows", "windows"], ["linux", "linux"]]) {
  const { bridge } = loadBridge(input);
  assert.equal(bridge.nativePlatform(), expected);
  assert.equal(bridge.isNativeDesktop(), input !== undefined);
}

const web = loadBridge();
await assert.rejects(web.bridge.invokeNative("connect_runtime", {}), /MyGo/);
assert.equal(web.calls.length, 0, "网页预览不能伪造连接成功");
const stopWeb = await web.bridge.listenNative("ignored", () => assert.fail("网页不能发原生事件"));
stopWeb();

const native = loadBridge("macos");
await native.bridge.invokeNative("api_request", { request: { path: "/client/bootstrap" } });
assert.equal(native.calls[0][0], "api_request");
assert.equal((native.calls[0][1] as any).request.path, "/client/bootstrap");
await native.bridge.invokeNative("disconnect_runtime");
assert.equal(Object.keys(native.calls[1][1] as object).length, 0);

const received: unknown[] = [];
const stop = await native.bridge.listenNative("chordv://native-session-refreshed", (event: any) => received.push(event.payload));
assert.equal(native.nativeHandlers.size, 1);
for (const handler of native.nativeHandlers) {
  handler({ name: "chordv://other", payload: "wrong" });
  handler({ name: "chordv://native-session-refreshed", payload: { accessToken: "local-test-token" } });
}
assert.equal(received.length, 1);
assert.equal((received[0] as any).accessToken, "local-test-token");
stop();
stop();
assert.equal(native.nativeHandlers.size, 0, "退订必须移除原生监听");

const focus: boolean[] = [];
const stopFocus = await native.bridge.onNativeFocusChanged((active: boolean) => focus.push(active));
for (const handler of native.systemHandlers.get("mygo:window-active") ?? []) {
  handler(false);
  handler(true);
}
assert.deepEqual(focus, [false, true]);
stopFocus();
assert.equal(native.systemHandlers.get("mygo:window-active")?.size, 0);

console.log("MyGo桥接：平台识别、真实调用、事件过滤、退订及窗口焦点检查通过");
