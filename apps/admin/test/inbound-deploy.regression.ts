import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

// Exercise the production async callbacks with controlled responses and session
// refs, mirroring agent-node-onboarding.regression.ts. The mounted section is
// covered by the targeted browser check.
const source = readFileSync(resolve(import.meta.dirname, "../src/features/nodes/useInboundDeployment.ts"), "utf8");
const tree = ts.createSourceFile("hook.ts", source, ts.ScriptTarget.Latest, true);
const expressions = new Map<string, string>();
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(tree) === "useCallback") {
    expressions.set(node.name.getText(tree), node.initializer.arguments[0].getText(tree));
  }
  ts.forEachChild(node, visit);
}
visit(tree);
function callback(name: string, scope: Record<string, unknown>) {
  const text = expressions.get(name); assert.ok(text, `${name} callback should exist`);
  const code = ts.transpileModule(`const fn = ${text};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(scope), `${code}; return fn;`)(...Object.values(scope));
}
function deferred() {
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const node = { id: "node-1", name: "node" };
const command = { commandId: "command-1", type: "ENSURE_INBOUND", targetRevision: "12", payload: {}, createdAt: "2026-01-01T00:00:00.000Z" };
function fixture() {
  const session = { current: 1 }, active = { current: true }, requestBusy = { current: false };
  const pollEpoch = { current: 0 }, timer = { current: null as number | null };
  const mutations: Array<[string, unknown]> = [], notified: unknown[] = [], polls: unknown[] = [], changedNodes: unknown[] = [];
  const scope: Record<string, unknown> = {
    session, active, requestBusy, pollEpoch, timer,
    current: (epoch: number) => active.current && session.current === epoch,
    changed: { current: (value: unknown) => changedNodes.push(value) },
    stopPolling: () => undefined, pollCompletion: (...args: unknown[]) => polls.push(args),
    notifications: { show: (value: unknown) => notified.push(value) }, errorMessage: (error: Error) => error.message
  };
  for (const key of ["setStage", "setError", "setDeploying", "setQueuedRevision"]) {
    scope[key] = (value: unknown) => mutations.push([key, value]);
  }
  return { scope, session, active, requestBusy, pollEpoch, mutations, notified, polls, changedNodes };
}

// A queue response that lands after the drawer closed or switched nodes must
// not mutate, notify, poll, or unlock a newer session's request.
for (const outcome of ["resolve", "reject"]) {
  const f = fixture(), pending = deferred();
  f.scope.deployNodeInbound = () => pending.promise;
  const task = callback("deploy", f.scope)(node, { listenPort: 443, serverNames: ["www.microsoft.com"], rotateKeys: false });
  const beforeClose = f.mutations.length;
  callback("invalidate", f.scope)();
  f.session.current++; f.active.current = true; f.requestBusy.current = true;
  if (outcome === "reject") pending.reject(new Error("late failure"));
  else pending.resolve(command);
  assert.equal(await task, false, `late ${outcome} reports not-queued`);
  assert.equal(f.mutations.length, beforeClose, `late ${outcome} cannot mutate the new session`);
  assert.equal(f.requestBusy.current, true, "stale finally cannot unlock a newer request");
  assert.deepEqual(f.polls, []); assert.deepEqual(f.notified, []); assert.deepEqual(f.changedNodes, []);
}

// In-session success: reports queued, starts polling for the command's OWN
// target revision, and unlocks the request.
{
  const f = fixture();
  f.scope.deployNodeInbound = async () => command;
  const queued = await callback("deploy", f.scope)(node, { listenPort: 443 });
  assert.equal(queued, true);
  assert.deepEqual(f.polls, [[node.id, "12", 1]], "polling must watch the queued command's target revision");
  assert.ok(f.mutations.some(([name, value]) => name === "setStage" && value === "queued"));
  assert.ok(f.mutations.some(([name, value]) => name === "setQueuedRevision" && value === "12"));
  assert.equal(f.requestBusy.current, false);
}

// In-session failure (e.g. the server rejected the spec): surfaces the
// server's message, no polling.
{
  const f = fixture();
  f.scope.deployNodeInbound = async () => { throw new Error(JSON.stringify({ message: "入站参数 listenPort 必须是 1-65535 的端口" })); };
  const queued = await callback("deploy", f.scope)(node, { listenPort: 70000 });
  assert.equal(queued, false);
  assert.ok(f.mutations.some(([name, value]) => name === "setStage" && value === "failed"));
  assert.ok(f.mutations.some(([name, value]) => name === "setError" && String(value).includes("listenPort")));
  assert.deepEqual(f.polls, []);
}

// Completion poll: done only once the node's applied revision reaches the
// command's target revision — the deploy queue response is the COMMAND, not
// the outcome.
function pollFixture(records: Array<Record<string, unknown>>, runFirstScheduleOnly: boolean) {
  const f = fixture();
  f.scope.fetchAdminNodes = async () => records;
  f.scope.POLL_INTERVAL_MS = 3_000;
  f.scope.POLL_TIMEOUT_MS = 300_000;
  f.scope.Date = Date; f.scope.BigInt = BigInt;
  let handles = 0;
  f.scope.window = {
    setTimeout: (fn: () => void) => {
      handles += 1;
      if (runFirstScheduleOnly && handles === 1) { fn(); return handles; }
      if (!runFirstScheduleOnly) { fn(); return handles; }
      return handles;
    },
    clearTimeout: () => undefined
  };
  return f;
}
{
  const f = pollFixture([{ id: "node-1", inboundAppliedRevision: "12", name: "node" }], true);
  await callback("pollCompletion", f.scope)("node-1", "12", 1);
  assert.equal(f.changedNodes.length, 1, "completion must refresh the parent record");
  assert.ok(f.mutations.some(([name, value]) => name === "setStage" && value === "done"));
  assert.equal(f.notified.length, 1, "completion must notify once");
}
{
  // Below the target revision (or a different node entirely): keep waiting.
  const f = pollFixture([{ id: "node-1", inboundAppliedRevision: "11", name: "node" }], true);
  await callback("pollCompletion", f.scope)("node-1", "12", 1);
  assert.equal(f.changedNodes.length, 0);
  assert.equal(f.mutations.some(([name, value]) => name === "setStage" && value === "done"), false);
  assert.deepEqual(f.notified, []);
}

// Destructive-operation marking lives in the section source: rotation is only
// offered on an already-deployed node, and submitting it requires an explicit
// confirmation that states what it invalidates.
const sectionSource = readFileSync(resolve(import.meta.dirname, "../src/features/nodes/InboundDeploySection.tsx"), "utf8");
assert.match(sectionSource, /轮换 Reality 密钥（破坏性操作）/, "轮换必须标注为破坏性操作");
assert.match(sectionSource, /已发出的所有订阅将立即失效/, "确认文案必须写明失效后果");
assert.match(sectionSource, /const canRotate = deployed;/, "轮换选项只在已部署节点上出现");
assert.match(sectionSource, /!form\.rotateKeys \|\| confirmedRotation/, "勾选轮换后必须先确认才能提交");
const apiClientSource = readFileSync(resolve(import.meta.dirname, "../src/api/nodes.ts"), "utf8");
assert.match(apiClientSource, /type: "ENSURE_INBOUND"/, "部署走 ENSURE_INBOUND 命令");
assert.match(apiClientSource, /\/agent-commands/, "部署走既有的 agent-commands 端点");

// The drawer reuses the section across node switches: a stale open modal
// (form values, an already-confirmed key rotation) must never deploy the
// previous node's settings onto the new node.
const controlCenterSource = readFileSync(resolve(import.meta.dirname, "../src/features/nodes/NodeControlCenter.tsx"), "utf8");
assert.match(controlCenterSource, /<InboundDeploySection key=\{node\.id\}/, "区块必须按 node.id 重新挂载");

// A reissue preserves the COMPLETE deployed spec (serverNames list, dest,
// flow/fingerprint/spiderX/inboundTag) — loaded from the applied job, not
// reconstructed from the lossy node record — and the fallback target follows
// the first SNI when the operator leaves it empty.
assert.match(sectionSource, /preserve: deployed/, "重下发必须保留当前部署的字段");
assert.match(sectionSource, /fetchNodeInboundSpec/, "必须从 applied 任务的完整规格加载，而不是从节点记录重建");
assert.match(sectionSource, /serverNamesCsv: specServerNames\.length > 0 \? specServerNames\.join/, "SNI 预填必须用完整规格列表（多 SNI 不丢）");
assert.doesNotMatch(sectionSource, /serverNames: \[form\.serverNamesCsv\]/, "SNI 不得退化为单项表单");
assert.match(sectionSource, /dest: stringField\(currentSpec, "dest"\) \?\? ""/, "dest 预填部署原值（可能是自定义主机/端口）");
assert.match(sectionSource, /inboundTag: stringField\(currentSpec, "inboundTag"\)/, "inboundTag 必须随规格保留");
assert.match(sectionSource, /必须能为所选 SNI 出示有效证书/, "回退目标的说明必须写明与 SNI 配套的原因");

console.log("inbound deploy regression passed (queue/poll session discipline, completion by applied revision, destructive rotation marking)");
