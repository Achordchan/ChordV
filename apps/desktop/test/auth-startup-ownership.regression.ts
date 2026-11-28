import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import * as api from "../src/api/client";
import * as recovery from "../src/lib/desktopSessionRecovery";
import * as lease from "../src/lib/sessionLeaseState";
import { ApiRequestError } from "../src/api/http";

const source = readFileSync(new URL("../src/hooks/useAuthBootstrap.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const old = { accessToken: "test-only-old", refreshToken: "test-only-refresh-old", user: { id: "old" } };
const fresh = { accessToken: "test-only-new", refreshToken: "test-only-refresh-new", user: { id: "new" } };
const rotated = { ...old, accessToken: "test-only-rotated" };
const bootstrap = (id: string) => ({ user: { id }, subscription: { state: "active" }, policies: { defaultMode: "rule" } });

function barrier<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function harness(overrides: Record<string, unknown> = {}) {
  const cleanups: Array<() => void> = [];
  const exported: any = {};
  vm.runInNewContext(code, { exports: exported, require: (id: string) => {
    if (id === "react") return { useCallback: (fn: unknown) => fn, useRef: (current: unknown) => ({ current }),
      useEffect: (fn: () => (() => void) | undefined) => { const cleanup = fn(); if (cleanup) cleanups.push(cleanup); } };
    if (id === "../api/client") return api;
    if (id === "../lib/desktopSessionRecovery") return recovery;
    if (id === "../lib/sessionLeaseState") return lease;
    return {};
  } });
  const state: { session: any; bootstrap: any; stored: any; writes: string[] } = { session: null, bootstrap: null, stored: old, writes: [] };
  const options = new Proxy({
    session: null, nodes: [], authBusy: false, logoutBusy: false, refreshing: false, rememberPassword: false,
    credentials: { email: "new@test.invalid", password: "test-only-password" }, unauthorizedRecoveryTaskRef: { current: null },
    login: async () => fresh, fetchBootstrap: async (token: string) => bootstrap(token === fresh.accessToken ? "new" : "old"),
    fetchNodes: async () => [], loadStoredSession: async () => state.stored,
    saveStoredSession: async (next: typeof old) => { state.writes.push(next.accessToken); state.stored = next; },
    clearStoredSession: async () => { state.writes.push("clear"); state.stored = null; },
    setSession: (next: unknown) => { state.session = next; }, setBootstrap: (next: unknown) => { state.bootstrap = next; },
    resolveDefaultMode: () => "rule", pickNode: () => null, runUpdateCheck: async () => {},
    ...overrides
  } as Record<string, unknown>, { get: (target, key: string) => key in target ? target[key] : () => undefined });
  return { hook: exported.useAuthBootstrap(options), state, unmount: () => cleanups.forEach(cleanup => cleanup()) };
}

test("旧启动认证迟到不覆盖新登录，也不改写新凭据", async () => {
  const pending = barrier<unknown>(), entered = barrier<void>();
  const h = harness({ fetchBootstrap: (token: string) => {
    if (token === old.accessToken) { entered.resolve(); return pending.promise; }
    return Promise.resolve(bootstrap("new"));
  } });
  const restoring = h.hook.restoreStoredSession();
  await entered.promise;
  await h.hook.handleLogin();
  pending.resolve(bootstrap("old"));
  assert.equal(await restoring, null);
  assert.equal(h.state.session.accessToken, fresh.accessToken);
  assert.equal(h.state.bootstrap.user.id, "new");
  assert.equal(h.state.stored.accessToken, fresh.accessToken);
  assert.deepEqual(h.state.writes, [fresh.accessToken]);
});

test("旧启动Token刷新迟到不保存、不清理用户的新登录", async () => {
  const pending = barrier<unknown>(), entered = barrier<void>();
  const h = harness({ fetchBootstrap: async (token: string) => {
    if (token === old.accessToken) throw new ApiRequestError(401, "test-only expired");
    return bootstrap("new");
  }, refreshStoredSessionNative: () => { entered.resolve(); return pending.promise; } });
  const restoring = h.hook.restoreStoredSession();
  await entered.promise;
  await h.hook.handleLogin();
  pending.resolve(rotated);
  assert.equal(await restoring, null);
  assert.equal(h.state.session.accessToken, fresh.accessToken);
  assert.equal(h.state.stored.accessToken, fresh.accessToken);
  assert.deepEqual(h.state.writes, [fresh.accessToken]);
});

test("已开始的旧会话落盘与新登录串行，新凭据最后提交", async () => {
  const pending = barrier<void>(), entered = barrier<void>();
  const writes: string[] = [];
  let stored: unknown = old;
  const h = harness({ loadStoredSession: async () => stored, fetchBootstrap: async (token: string) => {
    if (token === old.accessToken) throw new ApiRequestError(401, "test-only expired");
    return bootstrap("new");
  }, refreshStoredSessionNative: async () => rotated,
  saveStoredSession: async (next: typeof old) => {
    if (next.accessToken === rotated.accessToken) { entered.resolve(); await pending.promise; }
    stored = next;
    writes.push(next.accessToken);
  } });
  const restoring = h.hook.restoreStoredSession();
  await entered.promise;
  const login = h.hook.handleLogin();
  pending.resolve();
  await login;
  assert.equal(await restoring, null);
  assert.deepEqual(writes, [rotated.accessToken, fresh.accessToken]);
  assert.equal((stored as typeof fresh).accessToken, fresh.accessToken);
  assert.equal(h.state.session.accessToken, fresh.accessToken);
});

test("旧启动清理等待本地停止时，新登录不会被迟到清理清空", async () => {
  const pending = barrier<void>(), entered = barrier<void>();
  const h = harness({ loadStoredSession: async () => ({ ...old, refreshToken: "" }),
    fetchBootstrap: async (token: string) => {
      if (token === old.accessToken) throw new ApiRequestError(401, "test-only invalid");
      return bootstrap("new");
    }, forceStopLocalRuntime: () => { entered.resolve(); return pending.promise; } });
  const restoring = h.hook.restoreStoredSession();
  await entered.promise;
  await h.hook.handleLogin();
  pending.resolve();
  assert.equal(await restoring, null);
  assert.equal(h.state.session.accessToken, fresh.accessToken);
  assert.equal(h.state.stored.accessToken, fresh.accessToken);
  assert.deepEqual(h.state.writes, [fresh.accessToken]);
});

test("卸载或已有手动认证时，启动恢复不再发布旧状态", async () => {
  const pending = barrier<unknown>(), entered = barrier<void>();
  const h = harness({ fetchBootstrap: () => { entered.resolve(); return pending.promise; } });
  const restoring = h.hook.restoreStoredSession();
  await entered.promise;
  h.unmount();
  pending.resolve(bootstrap("old"));
  assert.equal(await restoring, null);
  assert.equal(h.state.session, null);
  assert.deepEqual(h.state.writes, []);
  const next = harness();
  await next.hook.handleLogin();
  assert.equal(await next.hook.restoreStoredSession(), null);
  assert.equal(next.state.session.accessToken, fresh.accessToken);
});
