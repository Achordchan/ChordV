import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import * as api from "../src/api/client";
import * as runtime from "../src/lib/runtime";
import { ApiRequestError } from "../src/api/http";

const baseline = JSON.parse(readFileSync(new URL("./fixtures/frontend-export-contract.json", import.meta.url), "utf8")) as Record<string, Array<{ name: string; type: boolean }>>;
function exportsOf(path: string) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const exports: Array<{ name: string; type: boolean }> = [];
  for (const node of tree.statements) {
    assert.ok(ts.isExportDeclaration(node), "旧入口只允许重导出，不能残留第二套业务实现");
    assert.ok(node.exportClause && ts.isNamedExports(node.exportClause), "公开导出必须可逐项核对");
    for (const item of node.exportClause.elements) exports.push({ name: item.name.text, type: node.isTypeOnly || item.isTypeOnly });
  }
  return exports.sort((a, b) => a.name.localeCompare(b.name));
}
test("API和本地能力旧导入路径完整保留所有值及类型名称", () => {
  for (const [key, path, module] of [["api", "../src/api/client.ts", api], ["runtime", "../src/lib/runtime.ts", runtime]] as const) {
    const expected = baseline[key].slice().sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(exportsOf(path), expected);
    assert.deepEqual(Object.keys(module).sort(), expected.filter(item => !item.type).map(item => item.name).sort());
  }
  assert.equal(api.ApiRequestError, ApiRequestError, "错误类必须保持同一构造器，不能复制导致instanceof失效");
  assert.equal(runtime.invokeDesktopConnect, runtime.connectRuntime);
  assert.equal(runtime.invokeDesktopDisconnect, runtime.disconnectRuntime);
  assert.equal(runtime.loadActiveRuntimeConfig, runtime.loadRuntimeSnapshot);
});

test("职责模块保持400行以内且不依赖兼容入口形成运行时循环", () => {
  const modules = ["api/http", "api/account", "api/connection", "api/native-commands", "api/client-events", "api/sse",
    "lib/nativeRuntime", "lib/nativeShell", "lib/nativeSupport", "lib/nativeInstaller", "lib/nativeComponents", "lib/nativeSession", "lib/nativeEnvironment", "lib/nativeDownloadProgress", "lib/githubReleaseTypes"];
  for (const module of modules) {
    const source = readFileSync(new URL(`../src/${module}.ts`, import.meta.url), "utf8");
    assert.ok(source.split("\n").length <= 400, `${module} should stay within its responsibility boundary`);
    assert.doesNotMatch(source, /from ["'](?:\.\/client|\.\/runtime|\.\.\/api\/client)["']/);
  }
});
