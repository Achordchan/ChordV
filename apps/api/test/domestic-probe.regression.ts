import assert from "node:assert/strict";
import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { DomesticProbeReportDto } from "../src/modules/domestic-probe/domestic-probe.dto";
import {
  DOMESTIC_BLOCK_STREAK,
  DOMESTIC_MAX_ERROR_LENGTH,
  DOMESTIC_MAX_TARGETS,
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
      update: async ({ where, data }: any) => Object.assign(nodes.find((node) => node.id === where.id)!, data)
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
  await service.listTargets();
  assert.deepEqual(lastFindMany.orderBy[0], { domesticCheckedAt: { sort: "asc", nulls: "first" } });
  assert.equal(lastFindMany.take, DOMESTIC_MAX_TARGETS);

  const revoked = await service.revokeToken();
  assert.equal(revoked.configured, false);
  assert.equal(await service.authenticate(`Bearer ${issued.token}`), false);
  console.log("domestic-probe regression passed");
}

void main().catch((error) => { console.error(error); process.exit(1); });
