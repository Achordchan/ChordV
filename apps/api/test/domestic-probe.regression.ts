import assert from "node:assert/strict";
import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { DomesticProbeReportDto } from "../src/modules/domestic-probe/domestic-probe.dto";
import {
  DOMESTIC_BLOCK_STREAK,
  DOMESTIC_MAX_ERROR_LENGTH,
  DOMESTIC_MAX_TARGETS,
  DOMESTIC_PROBE_REPORT_MAX_BODY_BYTES,
  DOMESTIC_PROBE_REPORT_PATH,
  createDomesticProbeReportBodyParser,
  DOMESTIC_STALE_MS,
  effectiveDomesticStatus,
  nextDomesticState,
  shouldIgnoreRound
} from "../src/modules/domestic-probe/domestic-probe.policy";
import { DomesticProbeService, hashDomesticProbeToken } from "../src/modules/domestic-probe/domestic-probe.service";
import { toAdminNodeRecord } from "../src/modules/common/node-import.utils";

const ok = { tcpOk: true, tcpLatencyMs: 42, error: null };
const fail = { tcpOk: false, tcpLatencyMs: null, error: "TCP 超时" };

// A success resets the streak and records latency.
assert.deepEqual(nextDomesticState({ domesticStatus: "blocked", domesticFailStreak: 5 }, ok, true), {
  domesticStatus: "reachable", domesticFailStreak: 0, domesticLatencyMs: 42, domesticError: null
});

// Failures keep the previous status until the streak reaches the threshold.
let state = { domesticStatus: "reachable", domesticFailStreak: 0 };
for (let round = 1; round < DOMESTIC_BLOCK_STREAK; round += 1) {
  const next = nextDomesticState(state, fail, true);
  assert.equal(next.domesticStatus, "reachable", `round ${round} must not mark blocked yet`);
  assert.equal(next.domesticFailStreak, round);
  state = next;
}
const blocked = nextDomesticState(state, fail, true);
assert.equal(blocked.domesticStatus, "blocked");
assert.equal(blocked.domesticError, "TCP 超时");

// A node whose own agent is offline may just be down: not counted as blocked.
const down = nextDomesticState({ domesticStatus: "reachable", domesticFailStreak: 2 }, fail, false);
assert.equal(down.domesticStatus, "unknown");
assert.equal(down.domesticFailStreak, 2);

// Probe-health checks discard whole rounds.
assert.ok(shouldIgnoreRound(false, [ok]));
assert.ok(shouldIgnoreRound(true, [fail, fail]));
assert.equal(shouldIgnoreRound(true, [fail]), null, "a single node may genuinely be blocked");
assert.equal(shouldIgnoreRound(true, [ok, fail]), null);

// Stale results read as unknown.
const now = new Date("2026-11-27T08:00:00Z");
assert.equal(effectiveDomesticStatus("blocked", new Date(now.getTime() - 60_000), now), "blocked");
assert.equal(effectiveDomesticStatus("blocked", new Date(now.getTime() - DOMESTIC_STALE_MS - 1), now), "unknown");
assert.equal(effectiveDomesticStatus("reachable", null, now), "unknown");
assert.equal(effectiveDomesticStatus("garbage", new Date(now.getTime() - 1000), now), "unknown");

// Admin record exposes the fields and hides latency unless reachable.
const baseRow = {
  id: "n1", name: "N", region: "US", provider: "p", tags: [], recommended: false, latencyMs: 0, probeLatencyMs: null,
  protocol: "vless", security: "reality", serverHost: "h", serverPort: 443, serverName: "s", shortId: "", spiderX: "/",
  statsLastSyncedAt: null, probeStatus: "healthy" as const, probeCheckedAt: null, probeError: null,
  createdAt: new Date(), updatedAt: new Date()
};
const legacy = toAdminNodeRecord(baseRow);
assert.equal(legacy.domesticStatus, "unknown");
assert.equal(legacy.domesticFailStreak, 0);
const fresh = toAdminNodeRecord({ ...baseRow, domesticStatus: "reachable", domesticLatencyMs: 30, domesticCheckedAt: new Date(), domesticFailStreak: 0 });
assert.equal(fresh.domesticStatus, "reachable");
assert.equal(fresh.domesticLatencyMs, 30);

// The largest report the DTO accepts must fit in Nest's default 100 KB JSON body
// limit, otherwise a full round would get HTTP 413 before validation.
const largest = {
  controlOk: true,
  results: Array.from({ length: DOMESTIC_MAX_TARGETS }, () => ({
    nodeId: "n".repeat(64),
    tcpOk: false,
    tcpLatencyMs: 60000,
    error: "墙".repeat(DOMESTIC_MAX_ERROR_LENGTH)
  }))
};
assert.deepEqual(validateSync(plainToInstance(DomesticProbeReportDto, largest)), [], "largest report must pass validation");
assert.ok(Buffer.byteLength(JSON.stringify(largest), "utf8") < 100 * 1024, "largest report must fit the default body limit");
const tooMany = { ...largest, results: [...largest.results, largest.results[0]] };
assert.notDeepEqual(validateSync(plainToInstance(DomesticProbeReportDto, tooMany)), [], "one more than the cap is rejected");

// Service: token auth, round handling, and the settings row never holding the plain token.
let lastFindMany: any = null;
let lastUpdateMany: any = null;
type NodeRow = { id: string; domesticStatus: string; domesticFailStreak: number; controlStatus: string; agentLastSeenAt: Date | null; domesticCheckedAt?: Date };
function createFakePrisma(nodes: NodeRow[]) {
  const settings = new Map<string, unknown>();
  const client: any = {
    systemSetting: {
      findUnique: async ({ where }: any) => settings.has(where.key) ? { value: settings.get(where.key), updatedAt: new Date() } : null,
      upsert: async ({ where, create, update }: any) => { settings.set(where.key, settings.has(where.key) ? update.value : create.value); }
    },
    node: {
      findMany: async (args: any) => {
        lastFindMany = args;
        return args.where.id ? nodes.filter((node) => args.where.id.in.includes(node.id)) : [];
      },
      update: async ({ where, data }: any) => Object.assign(nodes.find((node) => node.id === where.id)!, data),
      updateMany: async (args: any) => { lastUpdateMany = args; return { count: args.where.id.in.length }; }
    },
    $executeRaw: async () => 0
  };
  client.$transaction = async (fn: (tx: any) => unknown) => fn(client);
  return { client, settings };
}

async function main() {
  const seen = new Date();
  const nodes: NodeRow[] = [
    { id: "a", domesticStatus: "unknown", domesticFailStreak: 0, controlStatus: "online", agentLastSeenAt: seen },
    { id: "b", domesticStatus: "reachable", domesticFailStreak: 2, controlStatus: "online", agentLastSeenAt: seen }
  ];
  const { client, settings } = createFakePrisma(nodes);
  const service = new DomesticProbeService(client);

  assert.equal(await service.authenticate("Bearer anything"), false, "no token configured yet");
  const issued = await service.rotateToken();
  assert.ok(issued.token.startsWith("cvdp_"));
  assert.ok(!JSON.stringify([...settings.values()]).includes(issued.token), "plain token must not be stored");
  assert.equal((settings.get("domestic-probe") as any).tokenHash, hashDomesticProbeToken(issued.token));
  assert.equal(await service.authenticate(`Bearer ${issued.token}`), true);
  assert.equal(await service.authenticate(`Bearer ${issued.token}x`), false);
  assert.equal(await service.authenticate(issued.token), false, "Bearer scheme required");

  const ignored = await service.report({ controlOk: false, results: [{ nodeId: "a", ...ok }] });
  assert.equal(ignored.ignored, true);
  assert.equal(nodes[0].domesticStatus, "unknown", "ignored round must not touch nodes");
  assert.equal((await service.getState()).lastRoundIgnored, true);

  const result = await service.report({ controlOk: true, results: [{ nodeId: "a", ...ok }, { nodeId: "b", ...fail }, { nodeId: "b", ...ok }, { nodeId: "missing", ...ok }] });
  assert.deepEqual(result, { accepted: 2, ignored: false, reason: null });
  assert.equal(nodes[0].domesticStatus, "reachable");
  assert.equal(nodes[1].domesticStatus, "blocked", "third consecutive failure blocks; duplicate observation is ignored");
  assert.equal((await service.getState()).lastRoundIgnored, false);

  // Targets come least recently checked first, capped at the report limit.
  // Targets rotate by when they were last handed out, independent of accepted rounds.
  lastFindMany = null;
  client.node.findMany = async (args: any) => { lastFindMany = args; return [{ id: "a", name: "A", serverHost: "h", serverPort: 443 }]; };
  const listed = await service.listTargets(new Date("2026-11-27T09:00:00Z"));
  assert.equal(listed.targets.length, 1);
  assert.deepEqual(lastFindMany.orderBy[0], { domesticScheduledAt: { sort: "asc", nulls: "first" } });
  assert.deepEqual(lastFindMany.orderBy[1], { domesticCheckedAt: { sort: "asc", nulls: "first" } }, "unfinished nodes win ties");
  assert.equal(lastFindMany.take, DOMESTIC_MAX_TARGETS);
  assert.deepEqual(lastUpdateMany, { where: { id: { in: ["a"] } }, data: { domesticScheduledAt: new Date("2026-11-27T09:00:00Z") } });

  await assertReportRouteBodyLimit();
  await assertNestKeepsDefaultJsonParser();

  const revoked = await service.revokeToken();
  assert.equal(revoked.configured, false);
  assert.equal(await service.authenticate(`Bearer ${issued.token}`), false);
  console.log("domestic-probe regression passed");
}

// Over HTTP: the report route's own parser accepts a report above the global
// 100 KB default (the global parser alone would answer 413), other routes keep the default.
async function assertReportRouteBodyLimit() {
  const express = (await import("express")).default;
  const app = express();
  const reportParser = createDomesticProbeReportBodyParser();
  assert.notEqual(reportParser.name, "jsonParser", "Nest would skip its default JSON parser");
  app.use(reportParser);
  app.use(express.json());
  app.post("*splat", (req: any, res: any) => res.json({ size: JSON.stringify(req.body).length }));
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? 500).json({ error: error.type }));
  const server = await new Promise<any>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const body = JSON.stringify({ controlOk: true, results: [], padding: "x".repeat(150 * 1024) });
    const post = (path: string) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    assert.equal((await post(DOMESTIC_PROBE_REPORT_PATH)).status, 200, "report route accepts 150 KB");
    assert.equal((await post(`${DOMESTIC_PROBE_REPORT_PATH}?x=1`)).status, 200, "query string ignored");
    assert.equal((await post("/api/other")).status, 413, "other routes keep the default limit");
    const small = await fetch(base + "/api/other", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ a: 1 }) });
    assert.deepEqual(await small.json(), { size: 7 }, "other routes still get parsed JSON");
    const tooLarge = JSON.stringify({ padding: "x".repeat(DOMESTIC_PROBE_REPORT_MAX_BODY_BYTES) });
    assert.equal((await fetch(base + DOMESTIC_PROBE_REPORT_PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: tooLarge })).status, 413, "still bounded");
  } finally {
    server.close();
  }
}

// Inside a real Nest app: installing the report parser must not stop Nest from
// registering its default JSON parser for every other route.
async function assertNestKeepsDefaultJsonParser() {
  const { Body, Controller, Module, Post } = await import("@nestjs/common");
  const { NestFactory } = await import("@nestjs/core");
  // Decorators applied by hand: this test file is compiled without experimentalDecorators.
  class EchoController {
    other(body: unknown) { return { body }; }
    report(body: { padding?: string }) { return { size: body?.padding?.length ?? 0 }; }
  }
  for (const [method, path] of [["other", "other"], ["report", "domestic-probe/report"]] as const) {
    Body()(EchoController.prototype, method, 0);
    Post(path)(EchoController.prototype, method, Object.getOwnPropertyDescriptor(EchoController.prototype, method)!);
  }
  Controller()(EchoController);
  class EchoModule {}
  Module({ controllers: [EchoController] })(EchoModule);
  const app = await NestFactory.create(EchoModule, { logger: false });
  app.use(createDomesticProbeReportBodyParser());
  app.setGlobalPrefix("api");
  await app.listen(0, "127.0.0.1");
  try {
    const base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
    const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.deepEqual(await (await post("/api/other", { a: 1 })).json(), { body: { a: 1 } }, "default JSON parser still installed");
    assert.deepEqual(await (await post(DOMESTIC_PROBE_REPORT_PATH, { padding: "x".repeat(150 * 1024) })).json(), { size: 150 * 1024 });
    assert.equal((await post("/api/other", { padding: "x".repeat(150 * 1024) })).status, 413);
  } finally {
    await app.close();
  }
}

void main().catch((error) => { console.error(error); process.exit(1); });
