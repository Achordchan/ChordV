import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const code=ts.transpileModule(readFileSync(new URL("../src/hooks/useNodeProbe.ts",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
async function scenario(change:"refresh"|"logout"|"relogin"|"bootstrap"|"unsupported") {
  let identity:string|null=change==="bootstrap"?null:"1:user",token:string|null="old",cursor=0;
  const cells:any[]=[],effects:Array<()=>void>=[],reports:string[]=[];
  const react={
    useRef:(value:unknown)=>{const i=cursor++;return cells[i]??(cells[i]={current:value});},
    useState:(value:unknown)=>{const i=cursor++;if(!(i in cells))cells[i]=value;return[cells[i],(next:any)=>{cells[i]=typeof next==="function"?next(cells[i]):next;}];},
    useCallback:(fn:unknown)=>fn,useMemo:(fn:()=>unknown)=>fn(),
    useEffect:(fn:()=>void,deps:unknown[])=>{const i=cursor++;const previous=cells[i];if(!previous||deps.some((v,j)=>v!==previous[j])){cells[i]=deps;effects.push(fn);}}
  };
  let finish!:(value:unknown)=>void;const measurement=new Promise(resolve=>{finish=resolve;});
  const exports:any={};
  vm.runInNewContext(code,{exports,Date,Object,require:(name:string)=>name==="react"?react:name==="../api/client"?{reportNodeProbes:async(access:string)=>{reports.push(access);},isUnauthorizedApiError:()=>false}:name==="../lib/runtime"?{probeLocalNodes:()=>measurement}:{}});
  const render=()=>{cursor=0;const hook=exports.useNodeProbe({accessToken:token,sessionIdentity:identity,getCurrentSessionIdentity:()=>identity,getCurrentAccessToken:()=>token});for(const effect of effects.splice(0))effect();return hook;};
  let hook=render();
  if(change==="bootstrap")identity="1:user";
  const pending=hook.runProbe([{id:"node"}],false);
  if(change==="refresh")token="new";
  if(change==="logout"){identity=null;token=null;}
  if(change==="relogin")identity="2:user";
  hook=render();
  finish([{nodeId:"node",status:change==="unsupported"?"unknown":"healthy",latencyMs:change==="unsupported"?null:20}]);
  await pending;hook=render();
  const valid=change==="refresh"||change==="bootstrap"||change==="unsupported";
  assert.equal(Boolean(hook.probeResults.node),valid,change);
  assert.deepEqual(reports,valid&&change!=="unsupported"?[token!]:[],"reports must use the current token and login");
  if(valid&&change!=="unsupported"){token="newer";hook=render();assert.equal(hook.probeResults.node.latencyMs,20,"token refresh preserves completed results");}
}
for(const change of ["refresh","logout","relogin","bootstrap","unsupported"] as const)await scenario(change);
console.log("local probes preserve token refresh, reject old logins and support immediate bootstrap measurement");
