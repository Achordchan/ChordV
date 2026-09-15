import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
import ts from "typescript";
const react={useCallback:(fn:unknown)=>fn,useRef:(current:unknown)=>({current}),useState:()=>[null,()=>{}]};
function load(name:string,modules:Record<string,unknown>={}){
 const exports:any={};const code=ts.transpileModule(readFileSync(new URL(`../src/hooks/${name}.ts`,import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(code,{exports,Error,require:(key:string)=>key==="react"?react:modules[key]??{}});return exports;
}
async function actions(reconnect:boolean){
 let requests=0,revoked=0;const notices:string[]=[];const node={id:"node"};
 const options=new Proxy({session:{accessToken:"token"},selectedNode:node,selectedNodeId:"node",nodesRef:{current:[node]},mode:"rule",
  desktopStatus:{platformTarget:"macos",status:reconnect?"connected":"idle",activePid:reconnect?1:null},
  canAttemptConnect:true,runtimeAssetsReady:true,runtimeAssets:{phase:"ready"},forceUpdateRequired:false,
  getCurrentSessionIdentity:()=>"login",getCurrentAccessToken:()=>"token",readError:(value:string)=>value,
  forceStopLocalRuntime:async()=>{throw Error("cleanup failed");},showErrorToast:(value:string)=>notices.push(value),
  runtime:reconnect?{sessionId:"old",node}:null,
 } as Record<string,unknown>,{get:(target,key:string)=>key in target?target[key]:()=>{}});
 const {useRuntimeActions}=load("useRuntimeActions",{
  "../api/client":{connectSession:async()=>{requests++;return{sessionId:"new",node};},disconnectSession:async()=>{revoked++;}},
  "../lib/runtime":{checkRuntimeNetworkConflict:async()=>{},connectRuntime:async()=>{throw Error("native startup failed");}},
  "../lib/connectionGuidance":{loadConnectFailureRuntimeStatus:async()=>null,deriveGuidanceFromConnectFailure:()=>null},
 });
 const hook=useRuntimeActions(options);
 if(reconnect){assert.equal(await hook.handleReconnect(),false);assert.equal(requests,0);}
 else {await hook.handlePrimaryAction();assert.equal(requests,1);assert.equal(revoked,1);}
 assert.equal(notices.length,1);assert.match(notices[0],/cleanup failed/);
}
await actions(false);await actions(true);
let cleared=0,revoked=0;const notices:string[]=[];
const authOptions=new Proxy({session:{accessToken:"token",refreshToken:"refresh"},logoutBusy:false,
 forceStopLocalRuntime:async()=>{throw Error("cleanup failed");},clearStoredSession:async()=>{cleared++;},
 logoutSession:async()=>{revoked++;},showErrorToast:(message:string)=>notices.push(message),readError:(message:string)=>message,
} as Record<string,unknown>,{get:(target,key:string)=>key in target?target[key]:()=>{}});
await load("useAuthBootstrap").useAuthBootstrap(authOptions).handleLogout();
assert.equal(cleared,0);assert.equal(revoked,0);assert.match(notices[0],/cleanup failed/);
console.log("cleanup errors are handled; reconnect and logout never continue after failed local stop");
