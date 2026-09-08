import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

// Exercise the production async callbacks with controlled responses and session
// refs, mirroring agent-node-onboarding.regression.ts. The mounted section is
// covered by the targeted browser check.
const source = readFileSync(resolve(import.meta.dirname, "../src/features/nodes/useInboundDeployment.ts"), "utf8");
const sectionSource = readFileSync(resolve(import.meta.dirname, "../src/features/nodes/InboundDeploySection.tsx"), "utf8");
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
const sectionTree = ts.createSourceFile("section.tsx", sectionSource, ts.ScriptTarget.Latest, true);
const sectionExpressions = new Map<string, string>();
(function visitSection(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(sectionTree) === "useCallback") {
    sectionExpressions.set(node.name.getText(sectionTree), node.initializer.arguments[0].getText(sectionTree));
  }
  ts.forEachChild(node, visitSection);
})(sectionTree);
function sectionCallback(name: string, scope: Record<string, unknown>) {
  const body = sectionExpressions.get(name); assert.ok(body, `${name} callback should exist`);
  const code = ts.transpileModule(`const fn = ${body};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
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
    stopPolling: () => undefined, pollOutcome: (...args: unknown[]) => polls.push(args),
    notifications: { show: (value: unknown) => notified.push(value) }, errorMessage: (error: Error) => error.message,
    fetchAdminNodes: async () => { throw new Error("no nodes"); }
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
  const queued = await callback("deploy", f.scope)(node, { listenPort: 443 }, "12");
  assert.equal(queued, true);
  assert.deepEqual(f.polls, [[node.id, command.commandId, "12", 1]], "polling must watch the queued command's own outcome");
  assert.ok(f.mutations.some(([name, value]) => name === "setStage" && value === "queued"));
  assert.ok(f.mutations.some(([name, value]) => name === "setQueuedRevision" && value === "12"));
  assert.equal(f.requestBusy.current, false);
}

// In-session failure: surfaces the server's message, no polling — and, when
// the fresh record is available, tells the parent so a STALE browser re-render
// onto current truth (a CAS rejection means another admin deployed; no admin
// event ever told this browser).
{
  const f = fixture();
  f.scope.deployNodeInbound = async () => { throw new Error(JSON.stringify({ message: "节点部署已更新（当前部署 revision 13，表单基于 12），请刷新后重试" })); };
  f.scope.fetchAdminNodes = async () => [Object.assign({}, node, { inboundAppliedRevision: "13" })];
  const queued = await callback("deploy", f.scope)(node, { listenPort: 70000 }, "12");
  assert.equal(queued, false);
  assert.ok(f.mutations.some(([name, value]) => name === "setStage" && value === "failed"));
  assert.ok(f.mutations.some(([name, value]) => name === "setError" && String(value).includes("节点部署已更新")));
  assert.deepEqual(f.polls, []);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(f.changedNodes, [Object.assign({}, node, { inboundAppliedRevision: "13" })], "失败后必须把新记录交给父级自愈");
}

// Outcome poll: success is the QUEUED COMMAND's terminal state, not a higher
// node-level applied revision — this deployment can fail while a later
// administrator's succeeds (worst for key rotation: the rotation never
// happened but the revision moved past the target).
// A macrotask hop flushes every microtask the async tick chain needs (the
// completed branch awaits the outcome AND the node list before publishing).
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function outcomeFixture(outcome: unknown, records: Array<Record<string, unknown>>, runFirstScheduleOnly = true) {
  const f = fixture();
  f.scope.fetchNodeCommandOutcome = async () => outcome;
  f.scope.fetchAdminNodes = async () => records;
  f.scope.POLL_INTERVAL_MS = 3_000;
  f.scope.POLL_TIMEOUT_MS = 300_000;
  f.scope.Date = Date; f.scope.BigInt = BigInt;
  let handles = 0;
  f.scope.window = {
    setTimeout: (fn: () => void) => {
      handles += 1;
      if (handles === 1 || !runFirstScheduleOnly) { fn(); return handles; }
      return handles;
    },
    clearTimeout: () => undefined
  };
  return f;
}
{
  const f = outcomeFixture({ status: "completed", lastError: null }, [{ id: "node-1", inboundAppliedRevision: "12", name: "node" }]);
  callback("pollOutcome", f.scope)("node-1", "command-1", "12", 1);
  await flush();
  assert.equal(f.changedNodes.length, 1, "完成必须刷新父级记录");
  assert.ok(f.mutations.some(([name, value]) => name === "setStage" && value === "done"));
  assert.equal(f.notified.length, 1, "完成必须通知一次");
}
{
  // A FAILED command reports failure with the agent's reason — even if a
  // later deployment already pushed the applied revision past the target.
  const f = outcomeFixture({ status: "failed", lastError: "入站部署后未能确认生效" }, [{ id: "node-1", inboundAppliedRevision: "13", name: "node" }]);
  callback("pollOutcome", f.scope)("node-1", "command-1", "12", 1);
  await flush();
  assert.equal(f.mutations.some(([name, value]) => name === "setStage" && value === "done"), false, "失败的命令不得报成功");
  assert.ok(f.mutations.some(([name, value]) => name === "setStage" && value === "failed"), "失败必须落到 failed");
  assert.ok(f.mutations.some(([name, value]) => name === "setError" && String(value).includes("未能确认生效")), "必须透出 Agent 的失败原因");
}
{
  // Pending while a LATER deployment pushed the revision strictly past the
  // target: superseded, not successful — the requested change (e.g. a key
  // rotation) never took effect.
  const f = outcomeFixture({ status: "pending", lastError: null }, [{ id: "node-1", inboundAppliedRevision: "13", name: "node" }]);
  callback("pollOutcome", f.scope)("node-1", "command-1", "12", 1);
  await flush();
  assert.equal(f.mutations.some(([name, value]) => name === "setStage" && value === "done"), false, "被取代不得报成功");
  assert.ok(f.mutations.some(([name, value]) => name === "setError" && String(value).includes("已被更新的部署取代")), "必须说明被取代且未生效");
}
{
  // Pending with the revision still at/below the target: keep waiting.
  const f = outcomeFixture({ status: "pending", lastError: null }, [{ id: "node-1", inboundAppliedRevision: "12", name: "node" }]);
  callback("pollOutcome", f.scope)("node-1", "command-1", "12", 1);
  await flush();
  assert.equal(f.mutations.some(([name, value]) => name === "setStage" && value === "done"), false);
  assert.equal(f.mutations.some(([name, value]) => name === "setStage" && value === "failed"), false);
  assert.deepEqual(f.notified, []);
}
{
  // The job row gone (history cleanup): fail fast rather than guess.
  const f = outcomeFixture(null, []);
  callback("pollOutcome", f.scope)("node-1", "command-1", "12", 1);
  await flush();
  assert.ok(f.mutations.some(([name, value]) => name === "setStage" && value === "failed"), "命令记录缺失必须显式失败");
}

// Destructive-operation marking lives in the section source: rotation is only
// offered on an already-deployed node, and submitting it requires an explicit
// confirmation that states what it invalidates.
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
// Reissue editing is gated on a SUCCESSFUL spec load, the spec refreshes when
// the applied revision moves, and fetch failures are surfaced with a retry.
assert.match(sectionSource, /const reissueReady = !deployed \|\| specLoad\.status === "loaded"/, "重新下发必须以规格成功加载为门槛");
assert.match(sectionSource, /disabled=\{deployment\.stage === "queued" \|\| !reissueReady\}/, "加载未完成/失败时按钮必须禁用");
assert.match(sectionSource, /\}, \[loadSpec, node\.inboundAppliedRevision, specRetry\]\);/, "规格必须随 applied revision 变化刷新");
assert.match(sectionSource, /读取当前部署规格失败/, "读取失败必须显式暴露而非当作没有部署");
assert.match(sectionSource, /setSpecRetry\(\(count\) => count \+ 1\)/, "失败后必须可重试");
assert.doesNotMatch(sectionSource, /\(current\) => \(\{[^}]*event\.currentTarget/, "函数式更新器里不得读 event.currentTarget（React 可能推迟到 currentTarget 清空后才执行）");
// The open form is bound to the applied revision it was built from: a change
// underneath (another admin's deployment completing) must block submission
// until the operator reopens the form against the current spec — gating only
// the modal-opening button leaves the stale snapshot submittable.
assert.match(sectionSource, /setFormRevision\(node\.inboundAppliedRevision \?\? "0"\)/, "打开表单必须快照 applied revision");
assert.match(sectionSource, /const revisionChangedUnderneath = formRevision !== null && \(node\.inboundAppliedRevision \?\? "0"\) !== formRevision;/, "必须检测表单打开期间的 revision 变化");
assert.match(sectionSource, /&& !revisionChangedUnderneath/, "revision 变化后提交必须被阻断");
assert.match(sectionSource, /节点部署已在此表单打开期间发生变化/, "阻断时必须向操作员说明原因与恢复方式");
assert.match(sectionSource, /\}\), formRevision \?\? node\.inboundAppliedRevision \?\? "0"\);/, "提交必须携带表单快照的 applied revision（服务端 CAS）");

// The deploy completion callback must apply the polled record IMMEDIATELY:
// discarding it for a full-list refetch leaves the drawer on the old revision
// and cached spec whenever that refetch fails — a re-opened form would then
// re-submit the OLD settings after a successful change.
const appSource = readFileSync(resolve(import.meta.dirname, "../src/App.tsx"), "utf8");
assert.match(appSource, /onNodeRecordChanged=\{\(record\) =>/, "完成回调必须接收轮询到的记录");
assert.match(appSource, /item\.id === record\.id \? record : item/, "完成回调必须立即合并传入的记录，全表刷新只是补充");

console.log("inbound deploy regression passed (queue/poll session discipline, completion by applied revision, destructive rotation marking)");
