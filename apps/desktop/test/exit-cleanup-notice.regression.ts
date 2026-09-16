import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import ts from "typescript";
const source=ts.createSourceFile("App.tsx",readFileSync(new URL("../src/App.tsx",import.meta.url),"utf8"),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let effect="";
function visit(node:ts.Node){
 if(ts.isCallExpression(node)&&node.expression.getText(source)==="useEffect"&&node.arguments[0]?.getText(source).includes("subscribeNativeExitFailure"))effect=node.arguments[0].getText(source);
 ts.forEachChild(node,visit);
}
visit(source);assert.ok(effect);
let notify:(message:string)=>void=()=>{};let removed=false;const notices:any[]=[];
const code=ts.transpileModule(`const effect=${effect};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const run=new Function("subscribeNativeExitFailure","notifications",`${code};return effect;`)(async(fn:(message:string)=>void)=>{notify=fn;return()=>{removed=true;};},{show:(notice:unknown)=>notices.push(notice)});
const cleanup=run();await Promise.resolve();notify("系统代理恢复超时");
assert.equal(notices.length,1);assert.equal(notices[0].title,"退出未完成");assert.equal(notices[0].autoClose,false);assert.match(notices[0].message,/系统代理恢复超时.*重试/);
cleanup();notify("late error");assert.equal(notices.length,1);assert.equal(removed,true);
console.log("exit cleanup failure is visible until dismissed, with retry guidance and listener cleanup");
