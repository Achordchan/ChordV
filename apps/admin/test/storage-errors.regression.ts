import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { readError } from "../src/utils/admin-filters";

const source = ts.createSourceFile("StorageManager.tsx", readFileSync(new URL("../src/features/storage/StorageManager.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const operations = new Map<string, string>();
const visit = (node: ts.Node) => {
  if (ts.isVariableDeclaration(node) && ["scan", "load", "mutate", "moreJobs"].includes(node.name.getText(source))) operations.set(node.name.getText(source), node.initializer!.getText(source));
  if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect") operations.set("initialLoad", node.arguments[0].getText(source));
  ts.forEachChild(node, visit);
};
visit(source);
assert.equal(operations.size, 5);
for (const [name, expression] of operations) {
  for (const failure of [
    new Error(JSON.stringify({ statusCode: 500, message: "HTTP 500", requestId: "storage-server-proof" })),
    new Error(JSON.stringify({ statusCode: 400, message: "文件已变化，未删除。", requestId: "storage-detail-proof" })),
    new Error("GET /api/admin/storage failed before HTTP response requestId=storage-network-proof: Failed to fetch")
  ]) {
    let captured = "";
    let observed!: () => void;
    const errorReported = new Promise<void>(resolve => { observed = resolve; });
    const noop = () => {};
    const reject = async () => { throw failure; };
    const context: any = { Error, AbortController, readError, opened: true,
      epoch: { current: 1 }, readSeq: { current: 1 }, busyRef: { current: false }, jobsRequest: { current: null },
      abort: { current: null }, page: 0, cleanupPage: 0, search: "",
      listStorage: reject, scanStorage: reject, request: reject,
      setBusy: noop, setProgress: noop, setData: noop, setPage: noop, setCleanupPage: noop, setSearch: noop, setJobsLoading: noop,
      setError: (message: string) => { if (message) { captured = message; observed(); } }
    };
    vm.runInNewContext(ts.transpileModule(`globalThis.operation=${expression};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    await context.operation();
    await errorReported;
    assert.equal(captured, readError(failure, "文件扫描失败，请重试。"), `${name} must use the real shared error reader`);
    assert.ok(!captured.includes('"statusCode"'), `${name} must not render raw API JSON`);
    assert.match(captured, /请求编号：storage-/);
  }
}
console.log("storage initial/list/scan/mutation/pagination failures use the shared message reader and retain request IDs");
