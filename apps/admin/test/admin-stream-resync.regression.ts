import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { adminEventSections, createAdminRefreshBatch } from "../src/utils/admin-runtime-events";
import type { AdminRuntimeEventDto } from "../src/api/client";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const tree = ts.createSourceFile("App.tsx", app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let refreshSource = "";
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(tree) === "createAdminRefreshBatch") {
    const argument = node.arguments[0];
    if (argument && ts.isObjectLiteralExpression(argument)) {
      const property = argument.properties.find(item => ts.isPropertyAssignment(item) && item.name.getText(tree) === "refresh");
      if (property && ts.isPropertyAssignment(property)) refreshSource = property.initializer.getText(tree);
    }
  }
  ts.forEachChild(node, visit);
}
visit(tree);
assert.ok(refreshSource, "execute the production resync refresh callback");
const compiledRefresh = ts.transpileModule(`const refresh = ${refreshSource}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const client = readFileSync(new URL("../src/api/client.ts", import.meta.url), "utf8");
const clientTree = ts.createSourceFile("client.ts", client, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const parser = clientTree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "parseAdminEventStreamBuffer");
assert.ok(parser && ts.isFunctionDeclaration(parser));
const compiledParser = ts.transpileModule(parser.getText(clientTree), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const parse = new Function(`${compiledParser}; return parseAdminEventStreamBuffer;`)() as (input: string, callback: (id: string | null, event: AdminRuntimeEventDto) => void) => { remaining: string };

function fixture() {
  const calls = { full: 0, dashboard: 0, tickets: 0, imageBed: 0, detail: 0 };
  const scope = {
    disposed: false, sectionRef: { current: "tickets" }, settingsPanelRef: { current: "imageBed" },
    loadFullSnapshot: async () => { calls.full++; }, refreshDashboard: async () => { calls.dashboard++; },
    setTicketRefreshSignal: () => { calls.tickets++; }, setImageBedRefreshSignal: () => { calls.imageBed++; },
    leaseRevocationQueueRef: { current: { opened: true, filter: null } },
    refreshNodeCommandQueueDetail: () => { calls.detail++; }
  };
  const refresh = new Function(...Object.keys(scope), `${compiledRefresh}; return refresh;`)(...Object.values(scope));
  return { calls, refresh };
}
const pause = () => new Promise(resolve => setTimeout(resolve, 240));

test("Go的resync与旧DTO序列经真实SSE解析器合并成一次全量同步", async () => {
  const { calls, refresh } = fixture();
  const batch = createAdminRefreshBatch({ visible: () => true, refresh });
  const events: AdminRuntimeEventDto[] = [
    { type: "resync", reason: "replay_gap", occurredAt: "2026-11-16T00:00:00Z" },
    ...["account_updated", "subscription_updated", "node_access_updated", "announcement_updated", "policy_updated", "ticket_updated"].map(type => ({ type, occurredAt: "2026-11-16T00:00:00Z" } as AdminRuntimeEventDto))
  ];
  const stream = events.map(event => `id: new-process:512\ndata: ${JSON.stringify(event)}\n\n`).join("");
  let cursor: string | null = "old-process:1";
  const receive = (id: string | null, event: AdminRuntimeEventDto) => { cursor = id; batch.add(adminEventSections(event)); };
  const first = parse(stream.slice(0, 83), receive);
  const remaining = parse(first.remaining + stream.slice(83), receive);
  assert.equal(remaining.remaining, ""); assert.equal(cursor, "new-process:512");
  await pause(); batch.stop();
  assert.deepEqual(calls, { full: 1, dashboard: 0, tickets: 1, imageBed: 1, detail: 1 });
  assert.doesNotMatch(refreshSource, /setInterval|setTimeout/);
});

test("隐藏页面保留resync，恢复可见才同步，停止后不再安排请求", async () => {
  const { calls, refresh } = fixture(); let visible = false;
  const batch = createAdminRefreshBatch({ visible: () => visible, refresh });
  batch.add(["resync"]); await pause(); assert.equal(calls.full, 0);
  visible = true; batch.resume(); await pause(); assert.equal(calls.full, 1);
  batch.stop(); batch.add(["resync"]); batch.resume(); await pause(); assert.equal(calls.full, 1);
});
