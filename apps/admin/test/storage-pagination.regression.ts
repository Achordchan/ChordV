import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source=ts.createSourceFile("StorageManager.tsx",readFileSync(new URL("../src/features/storage/StorageManager.tsx",import.meta.url),"utf8"),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let expression="";
const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(source)==="moreJobs")expression=node.initializer!.getText(source);ts.forEachChild(node,visit);};visit(source);assert.ok(expression);
let finish!:(value:unknown)=>void,calls=0;
const context:any={epoch:{current:1},readSeq:{current:1},busyRef:{current:false},jobsRequest:{current:null},cleanupPage:0,page:0,search:"",data:{cleanupJobs:[{id:"first"}],cleanupTotal:300},loading:false,
  setJobsLoading:(value:boolean)=>{context.loading=value;},setData:(update:any)=>{context.data=typeof update==="function"?update(context.data):update;},
  setCleanupPage:(value:number)=>{context.cleanupPage=value;},setError:(reason:unknown)=>{throw reason;},
  listStorage:()=>{calls++;return new Promise(resolve=>{finish=resolve;});}
};
vm.runInNewContext(ts.transpileModule(`globalThis.moreJobs=${expression};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
const stale=context.moreJobs();await context.moreJobs();assert.equal(calls,1,"overlapping page requests are suppressed");
context.readSeq.current++;context.data={cleanupJobs:[{id:"new-scan"}],cleanupTotal:200};context.cleanupPage=0;
finish({cleanupJobs:[{id:"stale"}],cleanupTotal:300});await stale;
assert.equal(context.data.cleanupJobs.length,1);assert.equal(context.data.cleanupJobs[0].id,"new-scan");assert.equal(context.cleanupPage,0);assert.equal(context.loading,false);
const fresh=context.moreJobs();finish({cleanupJobs:[{id:"next"}],cleanupTotal:200});await fresh;
assert.equal(context.data.cleanupJobs.length,2);assert.equal(context.cleanupPage,1);
console.log("cleanup pagination rejects stale responses and suppresses overlapping reads");
