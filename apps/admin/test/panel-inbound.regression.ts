import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const source = readFileSync(resolve(import.meta.dirname, "../src/features/nodes/PanelInboundSection.tsx"), "utf8");
const tree = ts.createSourceFile("panel.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let expression = "";
(function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "parse" && node.initializer) expression = node.initializer.getText(tree);
  ts.forEachChild(node, visit);
})(tree);
assert.ok(expression);
const code = ts.transpileModule(`const fn = ${expression};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const build = (scope: Record<string, unknown>) => new Function(...Object.keys(scope), `${code};return fn;`)(...Object.values(scope));
for (const manual of [false, true]) {
  const changes: Array<[string, unknown]> = [];
  let request: any;
  let resolveResponse!: (value: unknown) => void;
  const pending = new Promise(resolve => { resolveResponse = resolve; });
  const epoch = { current: 0 };
  const scope: Record<string, unknown> = { epoch, node: { inboundAppliedRevision: "12" }, manual,
    link: "vless://placeholder@node.example.com:443?security=reality", panelVersion: "3.7.0", tag: "", confirmed: false,
    fields: { serverHost: "2001:db8::1", port: "8443", pbk: "key", sid: "ab", sni: "example.com", flow: "", fp: "chrome", spx: "/" },
    parsePanelInboundLink: (input: unknown) => { request = input; return pending; }, URLSearchParams };
  for (const name of ["setBusy", "setError", "setSpec", "setRevision", "setLink"]) scope[name] = (value: unknown) => changes.push([name, value]);
  const task = build(scope)();
  if (manual) {
    const parsed = new URL(request.link);
    assert.equal(parsed.hostname, "[2001:db8::1]");
    assert.equal(parsed.searchParams.get("flow"), "");
  }
  const before = changes.length;
  epoch.current++; // another input edit or drawer unmount
  resolveResponse({ mode: "validate_panel" });
  await task;
  assert.equal(changes.length, before, "late parse response must not mutate newer form");
}
assert.match(source, /node\.isActive \|\| revision !==/);
assert.match(source, /startsWith\("go-"\)/);
console.log("panel inbound UI parsing/session regressions passed");
