import * as guidance from "../src/lib/connectionGuidance";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

async function scenario(signOut: boolean, conflict = false, rotation: "config" | "native" | null = null, signOutNative = false, relogin = false) {
  let identity: string | null = "login-1:user";
  let token: string | null = "token";
  let sessionCalls = 0, nativeCalls = 0, saves = 0, preflightCalls = 0, assetCalls = 0;
  let shownGuidance: any = null;
  let resolveConfig!: (config: unknown) => void;
  const configTask = new Promise(resolve=> { resolveConfig = resolve; });
  const exports: any = {};
  const code = ts.transpileModule(readFileSync(new URL("../src/hooks/useRuntimeActions.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  vm.runInNewContext(code, { exports, require: (id: string) => {
    if (id === "react") return { useCallback: (fn: unknown)=>fn, useRef: (current: unknown)=>({current}), useState: ()=>[null,()=>undefined] };
    if (id === "../api/client") return { connectSession: ()=>{sessionCalls++; return configTask;}, disconnectSession: async()=>undefined };
    if (id === "../lib/runtime") return {
      checkRuntimeNetworkConflict: async()=>{preflightCalls++;if(conflict)throw new Error("external_proxy_conflict: 系统代理已由其他应用占用");},
      connectRuntime: async()=>{nativeCalls++;if(rotation==="native")token="rotated";if(signOutNative)identity=null;}, focusDesktopWindow: async()=>undefined
    };
    if (id === "../lib/connectionGuidance") return guidance;
    return {};
  }});
  const node = { id: "node" };
  const options = new Proxy({
    session: { accessToken: "token", user:{id:"user"} }, selectedNode: node, nodesRef: { current: [node] },
    desktopStatus: { platformTarget: "macos", status: "idle" },
    canAttemptConnect: true, runtimeAssetsReady: false, runtimeAssets: { phase: "idle" },
    ensureRuntimeAssetsReady: async()=>{assetCalls++;return true;},
    readError: (message: string)=>message,
    setGuidanceDialog: (update: (current: null)=>unknown)=>{shownGuidance=typeof update === "function" ? update(null) : update;},
    forceStopLocalRuntime: ()=>{throw new Error("preflight conflict must not clean up someone else's proxy");},
    forceUpdateRequired: false, mode: "rule", leaseHeartbeatFailedAtRef: { current: null },
    getCurrentAccessToken: ()=>token, getCurrentSessionIdentity: ()=>identity, refreshRuntime: async()=>undefined,
    setRuntime: ()=>{saves++;},
  } as Record<string, unknown>, { get:(target,key:string)=>key in target?target[key]:()=>undefined });
  const { handlePrimaryAction: handleConnect } = exports.useRuntimeActions(options);
  const first = handleConnect();
  const second = handleConnect();
  for(let turn=0;turn<10;turn++) await Promise.resolve();
  assert.equal(preflightCalls, 1, "duplicate clicks must share the in-flight guard before preflight");
  assert.equal(sessionCalls, conflict ? 0 : 1, "conflicts must be detected before any backend request");
  assert.equal(assetCalls, conflict ? 0 : 1, "conflicts must not wait for component downloads");
  if (signOut) { token = null; identity=null; }
  if (rotation==="config") token="rotated";
  if (relogin) identity="login-2:user";
  resolveConfig({ sessionId: "session", node });
  await Promise.all([first, second]);
  assert.equal(nativeCalls, signOut || conflict || relogin ? 0 : 1);
  assert.equal(saves, signOut || conflict || signOutNative || relogin ? 0 : 1, "late connection results must not restore a signed-out account");
  if(conflict) assert.equal(shownGuidance?.code,"desktop_external_proxy_conflict");
}
await scenario(false);
await scenario(true);
await scenario(false, true);
await scenario(false,false,"config");
await scenario(false,false,"native");
await scenario(false,false,null,true);
await scenario(false,false,null,false,true);
console.log("connection duplicate, logout/relogin and token-rotation race checks passed");
