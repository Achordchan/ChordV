import * as guidance from "../src/lib/connectionGuidance";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

async function scenario(signOut: boolean, conflict: boolean | "update" = false, rotation: "config" | "native" | null = null, signOutNative = false, relogin = false, force = false, blocked = false, reconnect = false, lateUpdate = false) {
  let identity: string | null = "login-1:user";
  let token: string | null = "token";
  let sessionCalls = 0, nativeCalls = 0, saves = 0, preflightCalls = 0, assetCalls = 0;
  let revoked=0;
  let forcedStart: boolean | null = null;
  let shownGuidance: any = null;
  let resolveConfig!: (config: unknown) => void;
  const configTask = new Promise(resolve=> { resolveConfig = resolve; });
  const exports: any = {};
  const code = ts.transpileModule(readFileSync(new URL("../src/hooks/useRuntimeActions.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  vm.runInNewContext(code, { exports, require: (id: string) => {
    if (id === "react") return { useCallback: (fn: unknown)=>fn, useRef: (current: unknown)=>({current}), useState: ()=>[null,()=>undefined] };
    if (id === "../api/client") return { connectSession: ()=>{sessionCalls++; return configTask;}, disconnectSession: async()=>{revoked++;} };
    if (id === "../lib/runtime") return {
      checkRuntimeNetworkConflict: async(confirmed:boolean)=>{preflightCalls++;assert.equal(confirmed,force);if(conflict === "update")throw new Error("mac_update_pending: 数据目录正在使用，请稍后重试");if(conflict && !confirmed)throw new Error("external_proxy_conflict: 系统代理已由其他应用占用");},
      connectRuntime: async(_config: unknown, runtimeOptions?: { forceTakeover?: boolean })=>{nativeCalls++;if(lateUpdate)throw new Error("mac_update_pending: 发现未完成的应用更新");forcedStart=runtimeOptions?.forceTakeover===true;if(rotation==="native")token="rotated";if(signOutNative)identity=null;}, focusDesktopWindow: async()=>undefined
    };
    if (id === "../lib/connectionGuidance") return guidance;
    return {};
  }});
  const node = { id: "node" };
  const options = new Proxy({
    session: { accessToken: "token", user:{id:"user"} }, selectedNode: node, selectedNodeId: node.id, runtime: null, bootstrap: {subscription: {state: blocked ? "exhausted" : "active",remainingTrafficGb: blocked ? 0 : 1}}, probeResultsRef: {current:{}}, nodesRef: { current: [node] },
    desktopStatus: { platformTarget: "macos", status: "idle" },
    canAttemptConnect: !blocked, runtimeAssetsReady: false, runtimeAssets: { phase: blocked ? "failed" : "idle" },
    ensureRuntimeAssetsReady: async()=>{assetCalls++;return true;},
    readError: (message: string)=>message,
    setGuidanceDialog: (update: (current: null)=>unknown)=>{shownGuidance=typeof update === "function" ? update(null) : update;},
    forceStopLocalRuntime: ()=>{throw new Error("preflight conflict must not clean up someone else's proxy");},
    forceUpdateRequired: false, mode: "rule", leaseHeartbeatFailedAtRef: { current: null },
    getCurrentAccessToken: ()=>token, getCurrentSessionIdentity: ()=>identity, refreshRuntime: async()=>undefined,
    setRuntime: ()=>{saves++;},
  } as Record<string, unknown>, { get:(target,key:string)=>key in target?target[key]:()=>undefined });
  const actions = exports.useRuntimeActions(options);
  const first = reconnect ? actions.handleReconnect() : force ? actions.handleForceConnect() : actions.handlePrimaryAction();
  const second = (reconnect || force) ? Promise.resolve() : actions.handlePrimaryAction();
  for(let turn=0;turn<10;turn++) await Promise.resolve();
  if (blocked) {
    assert.deepEqual([preflightCalls, assetCalls, sessionCalls, nativeCalls], [0, 0, 0, 0]);
    const [result]=await Promise.all([first, second]);
    if(reconnect) assert.equal(result,false);
    return;
  }
  assert.equal(preflightCalls, 1, "even a confirmed takeover must check the update gate");
  if (conflict === "update") {
    await Promise.all([first, second]);
    assert.deepEqual([assetCalls, sessionCalls, nativeCalls, revoked], [0, 0, 0, 0]);
    return;
  }
  assert.equal(sessionCalls, conflict && !force ? 0 : 1, "conflicts must be detected before any backend request");
  assert.equal(assetCalls, conflict && !force ? 0 : 1, "conflicts must not wait for component downloads");
  if (signOut) { token = null; identity=null; }
  if (rotation==="config") token="rotated";
  if (relogin) identity="login-2:user";
  resolveConfig({ sessionId: "session", node });
  const [result] = await Promise.all([first, second]);
  if (lateUpdate) {assert.equal(revoked,1);assert.equal(saves,0);assert.equal(nativeCalls,1);return;}
  if (reconnect) assert.equal(result, !(signOut || (conflict && !force) || signOutNative || relogin));
  assert.equal(nativeCalls, signOut || (conflict && !force) || relogin ? 0 : 1);
  if (nativeCalls) assert.equal(forcedStart, force, "only the confirmed attempt may carry forceTakeover to the native layer");
  assert.equal(saves, signOut || (conflict && !force) || signOutNative || relogin ? 0 : 1, "late connection results must not restore a signed-out account");
  if(signOutNative) assert.equal(revoked,1,"stale completed starts must revoke their server lease");
  if(conflict && !force) assert.equal(shownGuidance?.code,"desktop_external_proxy_conflict");
}
// A stale tray selection must not tear down an otherwise usable connection.
async function verifyTraySwitch(outcome: "removed" | "offline" | "changed-login" | "connected") {
  const source = ts.transpileModule(readFileSync(new URL("../src/hooks/useRuntimeActions.ts", import.meta.url), "utf8"), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const calls:string[] = []; const old = {id:"original"}, next = {id:"other"}; const exports:any={}; let identity="login-a";
  vm.runInNewContext(source,{exports,require:(id:string)=>{
    if(id==="react")return {useCallback:(fn:unknown)=>fn,useState:()=>[null,()=>{}],useRef:(current:unknown)=>({current})};
    if(id==="../lib/connectionGuidance")return guidance;
    if(id==="../api/client")return {disconnectSession:async()=>{calls.push("release")},connectSession:async({nodeId}:{nodeId:string})=>{calls.push("request:"+nodeId);return {sessionId:"new",node:next}}};
    if(id==="../lib/runtime")return {checkRuntimeNetworkConflict:async()=>{},connectRuntime:async()=>{calls.push("start")}};return {};
  }});
  const runtime={sessionId:"old",node:old};const options=new Proxy({session:{accessToken:"token"},bootstrap:{subscription:{state:"active",remainingTrafficGb:1}},runtime,runtimeRef:{current:runtime},nodesRef:{current:outcome==="removed"?[old]:[old,next]},probeResultsRef:{current:outcome==="offline"?{other:{status:"offline"}}:{}},desktopStatus:{status:"connected",platformTarget:"macos"},forceUpdateRequired:false,runtimeAssetsReady:true,runtimeAssets:{phase:"ready"},leaseHeartbeatFailedAtRef:{current:null},getCurrentAccessToken:()=>"token",getCurrentSessionIdentity:()=>identity,forceStopLocalRuntime:async()=>{calls.push("stop");if(outcome==="changed-login")identity="login-b"}} as Record<string,unknown>,{get:(obj,key:string)=>key in obj?obj[key]:()=>undefined});
  const result=await exports.useRuntimeActions(options).handleSwitchConnection({nodeId:next.id});
  assert.deepEqual(calls,outcome==="connected"?["stop","release","request:other","start"]:outcome==="changed-login"?["stop","release"]:[],outcome);
  assert.equal(result,outcome==="connected",outcome);
}
for (const outcome of ["removed","offline","changed-login","connected"] as const) await verifyTraySwitch(outcome);
for (const force of [false, true]) await scenario(false, "update", null, false, false, force);
await scenario(false,false,null,false,false,false,true,true);
await scenario(false,false,null,false,false,false,false,true);
await scenario(false,true,null,false,false,false,false,true);
await scenario(false,false,null,false,false,false,true);
await scenario(false,false,null,false,false,false,false,false,true);
await scenario(false);
await scenario(true);
await scenario(false, true);
await scenario(false,false,"config");
await scenario(false,false,"native");
await scenario(false,false,null,true);
await scenario(false,false,null,false,true);
await scenario(false,true,null,false,false,true);
await scenario(false,false,null,false,false,true);
console.log("connection duplicate, logout/relogin and token-rotation race checks passed");
