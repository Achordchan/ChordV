import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import ts from "typescript";
const source=ts.createSourceFile("App.tsx",readFileSync(new URL("../src/App.tsx",import.meta.url),"utf8"),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let effect="";
function visit(node:ts.Node){
 if(ts.isCallExpression(node)&&node.expression.getText(source)==="useEffect"&&node.arguments[0]?.getText(source).includes("subscribeNativeLifecycleNotices"))effect=node.arguments[0].getText(source);
 ts.forEachChild(node,visit);
}
visit(source);assert.ok(effect);
let notify:(notice:unknown)=>void=()=>{};let removed=false;const notices:any[]=[];
const code=ts.transpileModule(`const effect=${effect};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const run=new Function("subscribeNativeLifecycleNotices","setNativeLifecycleNotice",`${code};return effect;`)(async(fn:(notice:unknown)=>void)=>{notify=fn;return()=>{removed=true;};},(notice:unknown)=>notices.push(notice));
const cleanup=run();await Promise.resolve();notify({kind:"exit-cleanup-failed",message:"系统代理恢复超时"});
assert.deepEqual(notices,[{kind:"exit-cleanup-failed",message:"系统代理恢复超时"}]);
cleanup();notify({kind:"exit-cleanup-failed",message:"late error"});assert.equal(notices.length,1);assert.equal(removed,true);
console.log("退出清理失败进入持久反馈状态，卸载后移除监听并忽略迟到事件");
