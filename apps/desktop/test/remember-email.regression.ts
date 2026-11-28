import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// 执行实际鉴权hook，只有React调度与外部边界使用同步测试适配器。
const source = readFileSync(new URL("../src/hooks/useAuthBootstrap.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports: any = {};
vm.runInNewContext(code, { exports, require: (id: string) => id === "react" ? { useCallback: (fn: unknown) => fn, useRef: (current: unknown) => ({ current }), useEffect: () => {} } : {} });

for (const rememberPassword of [true, false]) {
  for (const action of ["logout", "revoked"] as const) {
    let credentials = { email: "remember-email@test.invalid", password: "test-only-password" };
    const remembered = { email: credentials.email };
    let stopped = 0, cleared = 0, signedOut = 0, updates = 0;
    const options = new Proxy({
      session: { accessToken: "test-only-token", refreshToken: "test-only-refresh" }, logoutBusy: false, rememberPassword,
      forceStopLocalRuntime: async () => { stopped++; },
      clearStoredSession: async () => { cleared++; },
      logoutSession: async () => {},
      setSession: (next: unknown) => { assert.equal(next, null); signedOut++; },
      setCredentials: (update: (current: typeof credentials) => typeof credentials) => { const next = update(credentials); if (next !== credentials) updates++; credentials = next; },
      showErrorToast: () => assert.fail("清理不应失败")
    } as Record<string, unknown>, { get: (target, key: string) => key in target ? target[key] : () => undefined });
    const hook = exports.useAuthBootstrap(options);
    if (action === "logout") await hook.handleLogout();
    else await hook.clearSession(true);
    assert.equal(credentials.password.length, 0, `${action} remember=${rememberPassword}必须清空内存密码`);
    assert.equal(credentials.email, remembered.email, "清除会话不能更改邮箱保留语义");
    assert.equal(updates, 1, "入口幂等清理仅实际更新一次凭据");
    assert.equal(stopped, 1); assert.equal(cleared, 1); assert.equal(signedOut, 1);
  }
}
for (const action of ["logout", "revoked"] as const) {
  for (const stage of ["stop", "store"] as const) {
    let credentials = { email: "remember-email@test.invalid", password: "test-only-password" };
    let signedOut = 0, reported = 0;
    const failure = new Error(`test-only ${stage} cleanup failure`);
    const options = new Proxy({
      session: { accessToken: "test-only-token", refreshToken: "test-only-refresh" }, logoutBusy: false, rememberPassword: true,
      forceStopLocalRuntime: async () => { assert.equal(credentials.password, ""); if (stage === "stop") throw failure; },
      clearStoredSession: async () => { assert.equal(credentials.password, ""); if (stage === "store") throw failure; },
      logoutSession: async () => {}, setSession: () => { signedOut++; },
      setCredentials: (update: (current: typeof credentials) => typeof credentials) => { credentials = update(credentials); },
      showErrorToast: (reason: unknown) => { assert.equal(reason, failure); reported++; }
    } as Record<string, unknown>, { get: (target, key: string) => key in target ? target[key] : () => undefined });
    const hook = exports.useAuthBootstrap(options);
    if (action === "logout") { await hook.handleLogout(); assert.equal(reported, 1); }
    else await assert.rejects(hook.clearSession(true), (reason: unknown) => reason === failure);
    assert.equal(credentials.password, "", `${action}/${stage}失败仍需清空内存密码`);
    assert.equal(credentials.email, "remember-email@test.invalid");
    assert.equal(signedOut, 0, "清理失败不能伪造会话已退出");
  }
}
console.log("remember-email logout and revoked session clear passwords without changing email");
