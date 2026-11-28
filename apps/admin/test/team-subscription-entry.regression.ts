import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const file = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let declaration: ts.FunctionDeclaration | undefined;
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "openTeamSubscriptions") declaration = node;
  ts.forEachChild(node, visit);
}
visit(file);
assert.ok(declaration, "客户团队订阅入口必须存在");
const calls: unknown[][] = [];
const emitted = ts.transpileModule(declaration.getText(file), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText;
const open = vm.runInNewContext(`${emitted}\nopenTeamSubscriptions`, {
  openDrawer: (...args: unknown[]) => calls.push(args),
  setSubscriptionTab() {}, setSearch() {}, selectSection() {}
}) as (team: { id: string; name: string; ownerEmail: string }) => void;
open(Object.freeze({ id: "team-entry-a", name: "甲团队", ownerEmail: "a@chordv.local" }));
open(Object.freeze({ id: "team-entry-b", name: "乙团队", ownerEmail: "b@chordv.local" }));
assert.deepEqual(calls, [
  ["team-subscription", null, "team-entry-a"],
  ["team-subscription", null, "team-entry-b"]
], "开通订阅必须打开绑定所选团队的实际编辑表单，而不是只切换隐藏列表状态");
console.log("team subscription entry behavior passed");
