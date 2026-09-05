import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

// Execute the actual component callback with a controlled scheduler/transport. This
// checks multi-day operations without waiting days or reproducing the polling code.
const source = readFileSync(resolve(import.meta.dirname, "../src/features/system-update/SystemUpdateBadge.tsx"), "utf8");
const tree = ts.createSourceFile("badge.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback = "", finishCallback = "";
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "pollOperation") {
    assert.ok(node.initializer && ts.isCallExpression(node.initializer));
    callback = node.initializer.arguments[0].getText(tree);
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "finishPolling") {
    assert.ok(node.initializer && ts.isCallExpression(node.initializer));
    finishCallback = node.initializer.arguments[0].getText(tree);
  }
  ts.forEachChild(node, visit);
}
visit(tree); assert.ok(callback);
const code = ts.transpileModule(`const poll = ${callback};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const queue: Array<{ run: () => void; delay: number }> = [];
const phases: string[] = [], completed: unknown[] = [], busy: unknown[] = [];
const mounted = { current: true }, polledOpId = { current: "op" }, pollTimer = { current: null };
let calls = 0, now = 0;
let result: unknown = new Error("offline");
const factory = new Function("fetchSystemOperation", "mounted", "polledOpId", "finishPolling", "setActiveOp", "setPhase", "pollTimer", "window", "POLL_INTERVAL_MS", "MAX_RECONNECT_INTERVAL_MS", "Date", "setBusy", "notifications", "ABSOLUTE_MAX_MS", "MAX_UNREACHABLE_MS", `${code}; return poll;`);
const poll = factory(async () => { calls++; if (result instanceof Error) throw result; return result; }, mounted, polledOpId,
  async (op: unknown) => completed.push(op), () => undefined, (phase: string) => phases.push(phase), pollTimer,
  { setTimeout: (run: () => void, delay: number) => { queue.push({ run, delay }); return queue.length; } },
  3000, 30000, { now: () => now }, (value: unknown) => busy.push(value), { show: () => undefined }, 90 * 60_000, 40 * 60_000);
async function tick() {
  assert.equal(queue.length, 1, "one request scheduler per operation");
  const next = queue.shift()!;
  next.run();
  await new Promise(resolve => setImmediate(resolve));
  return next.delay;
}
poll("op", 0);
now = 3 * 24 * 60 * 60_000;
assert.equal(await tick(), 3000);
assert.equal(await tick(), 6000);
assert.equal(await tick(), 12000);
assert.equal(await tick(), 24000);
assert.equal(await tick(), 30000);
assert.deepEqual(busy, [], "elapsed time/transport failure must not unlock operations");
assert.deepEqual(completed, []);
result = null; await tick();
assert.equal(phases.at(-1), "reconnecting");
result = { status: "running" }; await tick();
assert.equal(phases.at(-1), "running");
assert.equal(queue[0].delay, 3000, "successful contact restores normal interval");
result = { status: "succeeded", operationId: "op" }; await tick();
assert.deepEqual(completed, [result]); assert.equal(queue.length, 0);
poll("op"); mounted.current = false;
const before = calls; await tick();
assert.equal(calls, before); assert.equal(queue.length, 0, "unmount ends tracking");
mounted.current = true; polledOpId.current = "other"; poll("op"); await tick();
assert.equal(calls, before); assert.equal(queue.length, 0, "superseded operation cannot keep polling");
console.log("system-update-tracking.regression.ts passed (multi-day status, capped backoff, terminal, unmount, supersession)");

assert.ok(finishCallback);
const finishCode = ts.transpileModule(`const finish = ${finishCallback};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function deferred() {
  let resolve!: (value?: unknown) => void;
  return { promise: new Promise(done => { resolve = done; }), resolve: (value?: unknown) => resolve(value) };
}
for (const status of ["succeeded", "failed", "rolled_back"]) {
  const runtime = deferred(), check = deferred(), aux = deferred();
  let phase = "running", busy: string | null = "update", cachedCheck: unknown = { hasUpdate: true };
  const ref = { current: "op" };
  const finish = new Function("setActiveOp", "setPhase", "setCheck", "loadRuntime", "runCheck", "loadAux", "notifications", "kindLabel", "mounted", "polledOpId", "setBusy", `${finishCode}; return finish;`)(
    () => undefined, (value: string) => { phase = value; }, (value: unknown) => { cachedCheck = value; },
    () => runtime.promise, () => check.promise, () => aux.promise, { show: () => undefined }, () => "更新",
    { current: true }, ref, (value: string | null) => { busy = value; }
  );
  const pending = finish({ status, kind: "update", toVersion: "2.0.0" });
  const locked = () => { assert.equal(phase, "finishing"); assert.equal(busy, "update"); assert.equal(ref.current, "op"); };
  locked(); assert.equal(cachedCheck, null, "discard actionable stale release before awaiting refresh");
  runtime.resolve({ currentVersion: "1.0.0" }); await new Promise(resolve => setImmediate(resolve)); locked();
  check.resolve(); await new Promise(resolve => setImmediate(resolve)); locked();
  aux.resolve(); await pending;
  assert.equal(phase, "done"); assert.equal(busy, null); assert.equal(ref.current, null);
}
console.log("finishPolling slow-refresh regressions passed for success, failure and rollback");
