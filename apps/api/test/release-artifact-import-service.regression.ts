import "reflect-metadata";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { ConflictException } from "@nestjs/common";

// Execute the real orchestration method without a database or external network.
const sourcePath = resolve(__dirname, "../src/modules/common/release-center.service.ts");
const tree = ts.createSourceFile(sourcePath, readFileSync(sourcePath, "utf8"), ts.ScriptTarget.Latest, true);
const service = tree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "ReleaseCenterService") as ts.ClassDeclaration;
const method = service.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(tree) === "importReleaseArtifact")!;
const code = ts.transpileModule(`class ImportHarness { ${method.getText(tree)} }`, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;

function harness(failSave = false) {
  const calls: string[] = [];
  let wait: Promise<void> | null = null;
  const download = async () => {
    calls.push("download"); if (wait) await wait;
    return {path:"private-temp-file",size:12345,originalname:"ChordV.dmg",cleanup:async()=>{calls.push("cleanup");}};
  };
  const Harness = new Function("downloadHostedArtifact", "ConflictException", `${code};return ImportHarness;`)(download,ConflictException);
  const instance = new Harness();
  instance.activeImports = new Set();
  instance.ensureReleaseExists = async () => ({platform:"macos",version:"1.1.8",status:"draft"});
  instance.assertReleaseArtifactsMutable = (release:any) => { if(release.status!=="draft")throw new Error("draft required"); };
  const save = async (kind:string, stored:any) => {
    calls.push(kind);assert.equal(stored.size,12345);assert.equal(stored.path,"private-temp-file");
    if(failSave)throw new Error("save failed"); return {id:"release",artifacts:[{source:"uploaded",fileSizeBytes:"12345"}]};
  };
  instance.uploadReleaseArtifact = async (_id:string,_input:any,stored:any)=>save("create",stored);
  instance.replaceReleaseArtifactUpload = async (_id:string,artifactId:string,_input:any,stored:any)=>{assert.equal(artifactId,"existing");return save("replace",stored);};
  return {instance,calls,setWait:(value:Promise<void>)=>{wait=value;}};
}
async function main() {
  for(const replace of [false,true]) {
    const h=harness();
    const result=await h.instance.importReleaseArtifact("release",{sourceUrl:"https://example.com/a.dmg",...(replace?{artifactId:"existing"}:{}),fileSizeBytes:"111"},()=>{},new AbortController().signal);
    assert.equal(result.artifacts[0].fileSizeBytes,"12345");
    assert.deepEqual(h.calls,["download",replace?"replace":"create","cleanup"]);
    assert.equal(h.instance.activeImports.size,0);
  }
  const failure=harness(true);
  await assert.rejects(failure.instance.importReleaseArtifact("release",{sourceUrl:"https://example.com/a.dmg"},()=>{},new AbortController().signal),/save failed/);
  assert.equal(failure.calls.at(-1),"cleanup");assert.equal(failure.instance.activeImports.size,0);
  const duplicate=harness();let finish!:()=>void;duplicate.setWait(new Promise(resolve=>{finish=resolve;}));
  const first=duplicate.instance.importReleaseArtifact("release",{sourceUrl:"https://example.com/a.dmg"},()=>{},new AbortController().signal);
  await assert.rejects(duplicate.instance.importReleaseArtifact("release",{sourceUrl:"https://example.com/a.dmg"},()=>{},new AbortController().signal),/正在获取/);
  finish();await first;
  const published=harness();published.instance.ensureReleaseExists=async()=>({status:"published"});
  await assert.rejects(published.instance.importReleaseArtifact("release",{sourceUrl:"https://example.com/a.dmg"},()=>{},new AbortController().signal),/draft required/);
  assert.deepEqual(published.calls,[]);
  console.log("release artifact import orchestration regression checks passed");
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
