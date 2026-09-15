import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
import ts from "typescript";
const code=ts.transpileModule(readFileSync(new URL("../src/hooks/useRuntimeStatus.ts",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
async function scenario(readFails:boolean,stopFails:boolean,stillActive:boolean){
 const connected={status:"connected",activeSessionId:"s",activePid:1},idle={status:"idle",activeSessionId:null,activePid:null};
 let cleared=0,cursor=0;const cells:any[]=[];const exports:any={};
 const react={useCallback:(fn:unknown)=>fn,useRef:(value:unknown)=>{const i=cursor++;return cells[i]??(cells[i]={current:value});},useState:(value:any)=>{const i=cursor++;if(!(i in cells))cells[i]=typeof value==="function"?value():value;return[cells[i],(update:any)=>{cells[i]=typeof update==="function"?update(cells[i]):update;}];}};
 vm.runInNewContext(code,{exports,require:(name:string)=>name==="react"?react:{createIdleRuntimeStatus:()=>connected,loadRuntimeStatus:async()=>{if(readFails)throw Error("ipc error");return stillActive?connected:idle;},disconnectRuntime:async()=>{if(stopFails)throw Error("stop failed");return{ok:true};}}});
 const render=()=>{cursor=0;return exports.useRuntimeStatus({setRuntime:()=>{cleared++;},leaseHeartbeatFailedAtRef:{current:null}});};
 let hook=render();
 if(readFails){assert.equal(await hook.refreshRuntime(),null);hook=render();assert.equal(hook.desktopStatus.activePid,1);assert.equal(cleared,0);}
 if(stopFails||stillActive) {await assert.rejects(()=>hook.forceStopLocalRuntime());assert.equal(cleared,0);}
 if(!readFails&&!stopFails&&!stillActive){await hook.forceStopLocalRuntime();assert.ok(cleared>0);}
}
await scenario(true,false,true);await scenario(false,true,true);await scenario(false,false,true);await scenario(false,false,false);
console.log("failed native reads and stops never masquerade as a successful disconnect");
