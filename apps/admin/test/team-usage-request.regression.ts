import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source=readFileSync(new URL("../src/App.tsx",import.meta.url),"utf8");
const tree=ts.createSourceFile("App.tsx",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const names=["mergeSnapshot","syncLoadedTeamUsage","loadTeamUsage","clearTeamUsageCache"];
const functions=new Map<string,string>();
function visit(node:ts.Node){if(ts.isFunctionDeclaration(node)&&node.name&&names.includes(node.name.text))functions.set(node.name.text,node.getText(tree));ts.forEachChild(node,visit);}
visit(tree);assert.equal(functions.size,names.length);
const code=ts.transpileModule([...functions.values()].join("\n"),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;

function fixture(){
  const state={usage:{} as Record<string,unknown[]>,loading:{} as Record<string,boolean>,errors:{} as Record<string,string|null>,snapshot:{teams:[]} as unknown,notices:[] as unknown[]};
  const pending:{resolve:(value:unknown)=>void;reject:(reason:Error)=>void}[]=[];
  const setter=(key:"usage"|"loading"|"errors"|"snapshot")=>(value:any)=>{(state as any)[key]=typeof value==="function"?value(state[key]):value;};
  const scope={teamUsageByTeamId:state.usage,teamUsageEpochRef:{current:0},teamUsageVersionRef:{current:{} as Record<string,number>},teamUsageInFlightRef:{current:{} as Record<string,number>},
    setTeamUsageByTeamId:setter("usage"),setTeamUsageLoadingByTeamId:setter("loading"),setTeamUsageErrorByTeamId:setter("errors"),setSnapshot:setter("snapshot"),
    getTeamUsage:()=>new Promise((resolve,reject)=>pending.push({resolve,reject})),readError:(error:Error)=>error.message,notifications:{show:(notice:unknown)=>state.notices.push(notice)},createEmptyDashboardSnapshot:()=>({})};
  const api=new Function(...Object.keys(scope),code+`;return {${names.join(",")}};`)(...Object.values(scope));
  return {state,pending,api};
}

for(const failed of [false,true]){
  const f=fixture(),read=f.api.loadTeamUsage("opened");
  f.api.mergeSnapshot({teams:[{id:"opened",usage:["fresh-snapshot"]},{id:"unopened",usage:["never-warm"]}]});
  assert.deepEqual(f.state.usage,{opened:["fresh-snapshot"]});assert.equal(f.state.loading.opened,false);
  failed?f.pending[0].reject(new Error("old-error")):f.pending[0].resolve(["old-response"]);await read;
  assert.deepEqual(f.state.usage,{opened:["fresh-snapshot"]});assert.deepEqual(f.state.notices,[]);assert.equal(f.state.errors.opened,null);
}
{
  const f=fixture(),old=f.api.loadTeamUsage("opened");f.api.clearTeamUsageCache();
  const fresh=f.api.loadTeamUsage("opened");f.pending[0].resolve(["old-session"]);await old;
  assert.equal(f.state.loading.opened,true,"旧会话finally不能结束新会话读取");assert.deepEqual(f.state.usage,{});
  f.pending[1].resolve(["new-session"]);await fresh;assert.deepEqual(f.state.usage,{opened:["new-session"]});
}
{
  const f=fixture(),old=f.api.loadTeamUsage("opened"),fresh=f.api.loadTeamUsage("opened",{force:true});
  f.pending[0].reject(new Error("superseded"));await old;
  assert.equal(f.state.loading.opened,true);assert.deepEqual(f.state.notices,[]);
  f.pending[1].resolve(["forced"]);await fresh;assert.deepEqual(f.state.usage,{opened:["forced"]});
}
{
  const f=fixture(),first=f.api.loadTeamUsage("opened");await f.api.loadTeamUsage("opened");assert.equal(f.pending.length,1,"同一帧重复打开不增加usage请求");
  f.pending[0].resolve(["loaded"]);await first;f.api.mergeSnapshot({teams:[{id:"unopened",usage:[]}]});
  assert.deepEqual(f.state.usage,{},"移除团队不能保留可复活的旧缓存，也不能预热未打开团队");
}
console.log("team usage snapshot/request ownership checks passed");
