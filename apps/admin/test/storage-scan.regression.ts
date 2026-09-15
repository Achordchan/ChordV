import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source=readFileSync(new URL("../src/features/storage/storage-api.ts",import.meta.url),"utf8")
  .replace(/^import .*;\n/,"").replace(/\bexport /g,"");
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;

async function verify(phase:"headers"|"body",cancelByUser:boolean) {
  const caller=new AbortController(),deadline=new AbortController();
  let receivedSignal:AbortSignal|undefined;
  const requestResponse=async (_url:string,options:{signal:AbortSignal})=>{
    receivedSignal=options.signal;
    if(phase==="headers")return new Promise<Response>((_resolve,reject)=>options.signal.addEventListener("abort",()=>reject(options.signal.reason),{once:true}));
    return new Response(new ReadableStream({start(controller){options.signal.addEventListener("abort",()=>controller.error(options.signal.reason),{once:true});}}));
  };
  const signals={any:AbortSignal.any.bind(AbortSignal),timeout:(ms:number)=>{assert.equal(ms,600000);return deadline.signal;}};
  const scan=new Function("request","requestResponse","AbortSignal",`${code};return scanStorage;`)(()=>{},requestResponse,signals);
  const pending=scan(caller.signal,()=>{});
  await Promise.resolve();await Promise.resolve();
  assert.notEqual(receivedSignal,caller.signal,"fetch must use a composed deadline signal");
  const error=new DOMException(cancelByUser?"cancelled":"deadline",cancelByUser?"AbortError":"TimeoutError");
  const rejected=assert.rejects(pending,(reason:unknown)=>reason===error);
  (cancelByUser?caller:deadline).abort(error);
  await rejected;
}
for(const phase of ["headers","body"] as const)for(const cancel of [false,true])await verify(phase,cancel);
console.log("storage scan: deadline and user cancellation cover response headers and stalled body reads");
