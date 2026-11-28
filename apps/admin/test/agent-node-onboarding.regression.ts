import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

// Exercise the production async callbacks with controlled responses and session
// refs. This file verifies behavior, not browser layout or visual appearance.
const source = readFileSync(resolve(import.meta.dirname, "../src/features/nodes/useAgentNodeOnboarding.ts"), "utf8");
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
  const text = expressions.get(name); assert.ok(text);
  const code = ts.transpileModule(`const fn = ${text};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(scope), `${code}; return fn;`)(...Object.values(scope));
}
function deferred() {
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const node = { id: "pending-node", registrationStatus: "pending_register", name: "node" };
function fixture() {
  const session = { current: 1 }, active = { current: true }, requestBusy = { current: false };
  const resultAvailable = { current: false };
  const mutations: Array<[string, unknown]> = [], notified: unknown[] = [], polls: unknown[] = [], changedNodes: unknown[] = [];
  const scope: Record<string, unknown> = {
    session, active, requestBusy, resultAvailable, node,
    current: (epoch: number) => active.current && session.current === epoch,
    changed: { current: (value: unknown) => changedNodes.push(value) },
    stopWatching: () => undefined, watchRegistration: (...args: unknown[]) => polls.push(args),
    notifications: { show: (value: unknown) => notified.push(value) }, errorMessage: (error: Error) => error.message
  };
  for (const key of ["setCreating", "setError", "setNode", "setResult", "setStage", "setRegenerating", "setHasValidation"]) {
    scope[key] = (value: unknown) => mutations.push([key, value]);
  }
  return { scope, session, active, requestBusy, resultAvailable, mutations, notified, polls, changedNodes };
}
for (const request of ["submit", "regenerate"]) for (const outcome of ["resolve", "reject"]) {
  const f = fixture(), pending = deferred();
  f.scope.createAgentNode = () => pending.promise; f.scope.issueNodeRegisterToken = () => pending.promise;
  const run = callback(request, f.scope);
  const task = request === "submit" ? run({ name: "node" }) : run();
  const beforeClose = f.mutations.length;
  const close = callback("invalidate", f.scope); close();
  // The next session is open and has its own active request.
  f.session.current++; f.active.current = true; f.requestBusy.current = true;
  if (outcome === "reject") pending.reject(new Error("late failure"));
  else pending.resolve(request === "submit" ? { node, registerToken: "test", registerTokenExpiresAt: "future" } : { token: "fresh", expiresAt: "future" });
  await task;
  assert.equal(f.mutations.length, beforeClose, `${request} ${outcome} cannot mutate the new session`);
  assert.equal(f.requestBusy.current, true, "stale finally cannot unlock a newer request");
  assert.deepEqual(f.polls, []); assert.deepEqual(f.notified, []);
  assert.equal(f.changedNodes.length, request === "submit" && outcome === "resolve" ? 1 : 0, "committed creation only refreshes parent data");
}
const resumed = fixture();
resumed.scope.issueNodeRegisterToken = async () => ({ token: "new-token", expiresAt: "future" });
await callback("regenerate", resumed.scope)();
assert.deepEqual(resumed.mutations.find(([name]) => name === "setResult")?.[1], { node, registerToken: "new-token", registerTokenExpiresAt: "future" });
assert.deepEqual(resumed.polls, [[node.id, 1]], "resume must work without a previous one-time result");
assert.ok(resumed.mutations.some(([name, value]) => name === "setStage" && value === "awaiting"));
assert.equal(resumed.requestBusy.current, false);
console.log("agent-node-onboarding callbacks passed (late success/error/finally, close/reopen, pending resume)");

// Status comes from one command outcome, never registration or revision alone.
async function watchFixture(status: unknown, pendingRead?: Promise<unknown>, hasResult = false, preservePendingError = false) {
  const f = fixture();
  f.resultAvailable.current = hasResult;
  const watchEpoch = { current: 0 }, unsubscribe: { current: (() => void) | null } = { current: null };
  let listener!: (event: unknown) => void, reads = 0, stopped = 0;
  Object.assign(f.scope, {
    watchEpoch, unsubscribe, deadline: { current: null },
    window: { setTimeout: () => 1, clearTimeout: () => undefined },
    stopWatching: () => { watchEpoch.current++; unsubscribe.current?.(); unsubscribe.current = null; },
    subscribeAdminRuntimeEvents: (callback: (event: unknown) => void) => { listener = callback; return () => { stopped++; }; },
    fetchAgentOnboarding: () => { reads++; return reads === 1 && pendingRead ? pendingRead : Promise.resolve(status); }
  });
  callback("watchRegistration", f.scope)(node.id, 1, preservePendingError);
  const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  await flush();
  return { ...f, flush, event: () => listener({ type: 'node_access_updated', nodeId: node.id }), reads: () => reads, stopped: () => stopped };
}
const registeredNode = { ...node, registrationStatus: 'agent_ready', inboundAppliedRevision: '1' };
for (const hasResult of [false, true]) {
  const refreshed = await watchFixture({ mode: 'panel', node, spec: {}, command: null }, undefined, hasResult);
  assert.ok(refreshed.mutations.some(([key, value]) => key === 'setStage' && value === (hasResult ? 'awaiting' : 'resume')),
    'a successful pending read must restore the waiting state after a timeout');
  assert.ok(refreshed.mutations.some(([key, value]) => key === 'setError' && value === null), 'pending refresh must clear stale timeout errors');
}
for (const environmentReady of [false, true]) {
  const waiting = await watchFixture({ mode: 'environment', environmentReady, node: registeredNode, spec: null, command: null });
  assert.ok(waiting.mutations.some(([key, value]) => key === 'setStage' && value === (environmentReady ? 'configure' : 'environment')));
}
const failedMutation = await watchFixture({ mode: 'panel', node, spec: {}, command: null }, undefined, false, true);
assert.ok(!failedMutation.mutations.some(([key]) => key === 'setStage' || key === 'setError'),
  'observing a pending node must not conceal a failed token regeneration');
const validating = await watchFixture({ node: registeredNode, spec: {}, command: { status: 'pending', targetRevision: '2' } });
assert.ok(validating.mutations.some(([key, value]) => key === 'setStage' && value === 'validating'));
assert.ok(!validating.mutations.some(([key, value]) => key === 'setStage' && value === 'ready'));
const staleOutcome = await watchFixture({ node: registeredNode, spec: {}, command: { status: 'completed', targetRevision: '2' } });
assert.ok(staleOutcome.mutations.some(([key, value]) => key === 'setStage' && value === 'failed'));
const completedStatus = { node: registeredNode, spec: {}, command: { status: 'completed', targetRevision: '1' } };
const completed = await watchFixture(completedStatus);
assert.ok(completed.mutations.some(([key, value]) => key === 'setStage' && value === 'ready'));
assert.equal(completed.stopped(), 1);
const legacy = await watchFixture({ mode: 'legacy', node: registeredNode, spec: null, command: { status: 'completed', targetRevision: '1' } });
assert.ok(legacy.mutations.some(([key, value]) => key === 'setStage' && value === 'legacy'));
assert.ok(!legacy.mutations.some(([key, value]) => key === 'setStage' && (value === 'ready' || value === 'failed')));
assert.equal(legacy.stopped(), 1, 'legacy status must not wait for a Go validation event');
const inFlight = deferred();
const mergedEvents = await watchFixture(completedStatus, inFlight.promise);
for (let i = 0; i < 10; i++) mergedEvents.event();
inFlight.resolve({ node, spec: {}, command: null });
await mergedEvents.flush();
assert.equal(mergedEvents.reads(), 2, 'events during one request collapse to one following snapshot');
const lateRead = deferred();
const closed = await watchFixture(completedStatus, lateRead.promise);
callback('invalidate', closed.scope)();
const beforeLateRead = closed.mutations.length;
lateRead.resolve(completedStatus); await closed.flush();
assert.equal(closed.mutations.length, beforeLateRead, 'a closed SSE session cannot publish a late status');
console.log('onboarding SSE state regressions passed (registration is not validation, exact outcome, coalescing, close)');

// Exercise the actual frontend parser and watcher using explicit SSE wire
// fixtures for Go fullSyncEvents. Real Go HTTP replay/resync is covered by
// apps/server/internal/api/events_test.go, not a retired Nest service instance.
const clientSource = readFileSync(resolve(import.meta.dirname, '../src/api/client.ts'), 'utf8');
const clientTree = ts.createSourceFile('client.ts', clientSource, ts.ScriptTarget.Latest, true);
const parser = clientTree.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'parseAdminEventStreamBuffer');
assert.ok(parser);
const parserCode = ts.transpileModule(parser.getText(clientTree), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const parseStream = new Function(`${parserCode};return parseAdminEventStreamBuffer;`)();
const reconnect = fixture();
let statusAfterRead: unknown = { node: registeredNode, spec: {}, command: { status: 'pending', targetRevision: '1' } };
let deliverToWatcher!: (event: unknown) => void;
let serverSubscription: { unsubscribe(): void } | undefined;
let transportGeneration = 0;
const parsedCursors: string[] = [];
const transport = () => {
  const generation = ++transportGeneration;
  let open = true;
  serverSubscription = { unsubscribe: () => { open = false; } };
  const wire = [
    "retry: 3000\n\n",
    `id: go-restarted-${generation}:1\ndata: ${JSON.stringify({ type: "resync", reason: "connected", occurredAt: "2026-11-17T00:00:00.000Z" })}\n\n`,
    `id: go-restarted-${generation}:2\ndata: ${JSON.stringify({ type: "node_access_updated", occurredAt: "2026-11-17T00:00:00.000Z" })}\n\n`
  ].join("").replaceAll("\n", "\r\n");
  const deliver = (id: string | null, event: unknown) => {
    if (!open) return;
    if (id) parsedCursors.push(id);
    deliverToWatcher(event);
  };
  const boundary = wire.indexOf("node_access_updated") + 5;
  const first = parseStream(wire.slice(0, boundary), deliver);
  assert.ok(first.remaining.length > 0, "partial Go SSE data must remain buffered");
  const last = parseStream(first.remaining + wire.slice(boundary), deliver);
  assert.equal(last.remaining, "", "complete CRLF frames must drain the parser buffer");
};
const reconnectEpoch = { current: 0 };
Object.assign(reconnect.scope, {
  watchEpoch: reconnectEpoch, unsubscribe: { current: null }, deadline: { current: null },
  window: { setTimeout: () => 1 },
  stopWatching: () => { reconnectEpoch.current++; serverSubscription?.unsubscribe(); },
  subscribeAdminRuntimeEvents: (listener: (event: unknown) => void) => { deliverToWatcher = listener; transport(); return () => serverSubscription?.unsubscribe(); },
  fetchAgentOnboarding: async () => statusAfterRead
});
const drainEvents = async () => { for (let n = 0; n < 100; n++) await Promise.resolve(); };
try {
  callback('watchRegistration', reconnect.scope)(node.id, 1);
  await drainEvents();
  assert.ok(reconnect.mutations.some(([key, value]) => key === 'setStage' && value === 'validating'));
  serverSubscription?.unsubscribe();
  // Validation completes while disconnected; no completion event is delivered.
  statusAfterRead = completedStatus;
  const beforeReconnect = reconnect.mutations.length;
  transport();
  await drainEvents();
  assert.ok(reconnect.mutations.slice(beforeReconnect).some(([key, value]) => key === 'setStage' && value === 'ready'),
    'a reconnect initial event must refresh completion without a later node event or replay cache');
} finally { serverSubscription?.unsubscribe(); }
assert.ok(parsedCursors.includes("go-restarted-2:2"), "opening cursor must survive CRLF/chunk parsing after reconnect");
console.log('onboarding reconnect passed (Go wire contract -> actual client parser -> watcher snapshot; Go HTTP covered separately)');
