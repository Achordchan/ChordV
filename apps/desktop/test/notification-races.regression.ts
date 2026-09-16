import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createNotificationsStore } from "@mantine/notifications";
import { notifications } from "../src/lib/notifications";
import * as guidance from "../src/lib/connectionGuidance";

const store = createNotificationsStore();
const notice = { title: "同步失败", message: "请稍后重试", color: "yellow" };
const id = notifications.show(notice, store);
notifications.show(notice, store);
notifications.show(notice, store);
assert.equal(store.getState().notifications.length, 1);
notifications.show({ ...notice, message: "另一个错误" }, store);
assert.equal(store.getState().notifications.length, 2);
notifications.hide(id, store);
notifications.show(notice, store);
assert.equal(store.getState().notifications.length, 2, "dismissed notices may recur");
store.setState({ ...store.getState(), limit: 0 });
notifications.show({ ...notice, message: "排队消息" }, store);
notifications.show({ ...notice, message: "排队消息" }, store);
assert.equal(store.getState().queue.filter(item => item.message === "排队消息").length, 1);
notifications.show({ id: "persistent", message: "退出失败", autoClose: false }, store);
assert.equal(store.getState().queue.find(item => item.id === "persistent")?.autoClose, false);

const code = ts.transpileModule(readFileSync(new URL("../src/hooks/useRuntimeActions.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
async function scenario(kind: "empty" | "disconnect" | "logout" | "switch" | "idle" | "confirm-fails" | "valid") {
  let epoch = 0, identity: string | null = "login", calls = 0, stopped = 0, writes = 0;
  const notices: unknown[] = [];
  let release!: (value: unknown) => void;
  const response = new Promise(resolve => { release = resolve; });
  const node = { id: "node" };
  const runtimeRef = { current: { sessionId: "old", node } as any };
  const options = {
    session: { accessToken: "token" }, runtimeRef, runtime: runtimeRef.current,
    desktopStatus: { platformTarget: kind === "confirm-fails" ? "web" : "macos", activeSessionId: "old", status: "connected" },
    getRuntimeSyncEpoch: () => epoch, isRuntimeStopping: () => false,
    getCurrentSessionIdentity: () => identity, getCurrentAccessToken: () => "token",
    refreshRuntime: async () => ({ activeSessionId: kind === "idle" ? null : "old", status: kind === "idle" ? "idle" : "connected" }),
    nodesRef: { current: [node] }, selectedNodeIdRef: { current: "node" }, probeResultsRef: { current: {} },
    lastForegroundSyncErrorRef: { current: null }, lastGuidanceToastRef: { current: null },
    setBootstrap: () => { writes++; }, setNodes: () => {}, setSelectedNodeId: () => {},
    setMode: () => {}, mode: "rule", mergeSubscriptionState: () => {},
    setRuntime: () => {}, notify: (value: unknown) => notices.push(value),
    forceStopLocalRuntime: async () => { epoch++; stopped++; runtimeRef.current = null; },
    setDesktopStatus: () => {}, setConnectionGuidance: () => {}, setGuidanceDialog: () => {},
    recoverSessionAfterUnauthorized: async () => null, showErrorToast: (value: unknown) => notices.push(value)
  };
  const exports: any = {};
  const api = {
    fetchBootstrap: async () => ({ policies: { modes: ["rule"] } }),
    fetchSubscription: async () => ({}), fetchNodes: async () => [node], fetchAnnouncements: async () => [],
    fetchClientRuntime: () => { calls++; return calls === 1 ? response : kind === "confirm-fails" ? Promise.reject(Error("offline")) : Promise.resolve(null); },
    isUnauthorizedApiError: () => false, isForbiddenApiError: () => false, isNotFoundApiError: () => false,
    disconnectSession: async () => {}
  };
  vm.runInNewContext(code, { exports, window: { setTimeout: (fn: () => void) => { fn(); } },
    require: (key: string) => key === "react" ? {
      useCallback: (fn: unknown) => fn, useRef: (current: unknown) => ({ current }), useState: () => [null, () => {}]
    } : key === "../api/client" ? api : key === "../lib/connectionGuidance" ? guidance : {} });
  const hook = exports.useRuntimeActions(options);
  const first = hook.syncForegroundState("token");
  const second = hook.syncForegroundState("token");
  assert.equal(first, second, "parallel event/open syncs share a task");
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(calls, kind === "idle" ? 0 : 1);
  if (kind === "disconnect") await hook.handleDisconnect();
  if (kind === "logout") { identity = null; epoch++; }
  if (kind === "switch") runtimeRef.current = { sessionId: "new", node };
  release(kind === "valid" ? { sessionId: "old", node } : null);
  await first;
  assert.equal(notices.length, 0, `${kind}: no stale or unconfirmed failure toast`);
  assert.equal(stopped, kind === "disconnect" ? 1 : 0, "uncertain reads never stop a connection");
  if (kind === "disconnect" || kind === "logout") assert.equal(writes, 0, "stale request cannot mutate state");
  await hook.handleRuntimeEvent({ type: "session_revoked", sessionId: "retired", reasonCode: "session_invalid" }, "token");
  assert.equal(notices.length, 0, "retired session events must be ignored before auth handling");
}
for (const kind of ["empty", "disconnect", "logout", "switch", "idle", "confirm-fails", "valid"] as const) await scenario(kind);
console.log("notification deduplication and seven connection sync race scenarios passed");
