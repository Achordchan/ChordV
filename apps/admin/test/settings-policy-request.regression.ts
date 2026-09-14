import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { isRuntimeVersionUnavailable } from "../src/utils/runtime-version-capability";

const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const tree = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let code = "";
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "loadSettingsPolicy") code = node.getText(tree);
  ts.forEachChild(node, visit);
}
visit(tree);
assert.ok(code);
function fixture() {
  const state = { loading: false, error: null as string | null, form: "cached", saved: null as unknown };
  let resolve!: (value: unknown) => void, reject!: (reason: Error) => void;
  const scope = {
    settingsPolicyRequest: {current:0}, sectionRequestSeqRef:{current:0},
    policyDirtyRef:{current:false}, policySavingRef:{current:false},
    fetchAdminPolicy: () => new Promise((yes, no) => {resolve=yes;reject=no;}),
    setSettingsPolicyLoading: (v:boolean) => {state.loading=v;},
    setSettingsPolicyError: (v:string|null) => {state.error=v;},
    mergeSnapshot: (v:unknown) => {state.saved=v;},
    setPolicyForm: (v:string) => {state.form=v;},
    toPolicyForm: (v:unknown) => v,
    readError: (e:Error) => e.message
  };
  const js = ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const load = new Function(...Object.keys(scope), js+";return loadSettingsPolicy;")(...Object.values(scope));
  return {state,scope,load,resolve:(v:unknown)=>resolve(v),reject:(e:Error)=>reject(e)};
}
{
  const f=fixture(), pending=f.load();
  f.scope.sectionRequestSeqRef.current++;
  f.resolve("fresh"); await pending;
  assert.equal(f.state.form,"fresh","无关页面刷新不能丢弃策略读取");
  assert.equal(f.state.loading,false);
}
{
  const f=fixture(), pending=f.load();
  f.scope.settingsPolicyRequest.current++;
  f.resolve("stale"); await pending;
  assert.equal(f.state.form,"cached","已关闭或新会话不能接受旧结果");
}
{
  const f=fixture(), pending=f.load();
  f.reject(new Error("offline")); await pending;
  assert.equal(f.state.error,"offline","失败必须保留错误门禁而非暴露缓存表单");
}
assert.equal(isRuntimeVersionUnavailable(new Error('{"statusCode":404}')),true);
for (const message of ['{"statusCode":401}', '{"statusCode":403}', '{"statusCode":500}', 'network failed']) {
  assert.equal(isRuntimeVersionUnavailable(new Error(message)),false);
}
console.log("settings policy ownership and runtime capability checks passed");
