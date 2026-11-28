import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// 执行实际bootstrap hook，仅适配React调度和API边界，不替换其分支逻辑。
const source = readFileSync(new URL("../src/hooks/useAuthBootstrap.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports: any = {};
vm.runInNewContext(code, { exports, require: (id: string) => id === "react" ? {
  useCallback: (fn: unknown) => fn, useRef: (current: unknown) => ({ current }), useEffect: () => {}
} : {} });
for (const state of ["exhausted", "paused", "expired", "active"]) {
  for (const hasNodes of [false, true]) {
    const notices: string[] = [];
    let loaded = false;
    const options = new Proxy({
      fetchBootstrap: async () => ({ subscription: { state }, policies: { defaultMode: "rule" } }),
      fetchNodes: async () => hasNodes ? [{ id: "test-only-node" }] : [],
      setBootstrap: () => { loaded = true; },
      resolveDefaultMode: () => "rule", pickNode: () => null,
      runUpdateCheck: async () => {}, showErrorToast: (message: string) => { notices.push(message); }
    } as Record<string, unknown>, { get: (target, key: string) => key in target ? target[key] : () => undefined });
    const result = await exports.useAuthBootstrap(options).bootstrapSession({ accessToken: "test-only-token" }, false, false, false);
    assert.equal(result, true); assert.equal(loaded, true);
    assert.equal(notices.length, 0, `${state}/${hasNodes}：成功读取节点列表不应报告同步失败`);
  }
}
console.log("subscription availability distinguishes intentionally empty blocked subscriptions from active missing nodes");
