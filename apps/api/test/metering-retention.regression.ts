import "reflect-metadata";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MeteringRetentionService } from "../src/modules/common/metering-retention.service";
import type { PrismaService } from "../src/modules/common/prisma.service";

const root = path.resolve(__dirname, "../../..");
const source = readFileSync(
  path.join(root, "apps/api/src/modules/common/metering-retention.service.ts"),
  "utf8"
);
const agentSource = readFileSync(path.join(root, "apps/api/src/modules/agent/agent.service.ts"), "utf8");
const sessionSource = readFileSync(
  path.join(root, "apps/api/src/modules/common/runtime-session.service.ts"),
  "utf8"
);

// ---------------------------------------------------------------------------
// NodeUsageBatch rows must SURVIVE. Their reachability is not a function of age
// or of the agent's current bootId: ingest adopts whatever bootId arrives and
// resets the acknowledgement watermark to 0, so a retry from a superseded boot
// sends contiguity back to sequence 1. Any deleted prefix is then a permanent gap.
// ---------------------------------------------------------------------------
assert.doesNotMatch(
  source,
  /DELETE FROM "NodeUsageBatch"/,
  "usage batch rows must never be deleted while the ack watermark can regress to 0"
);
assert.match(
  source,
  /UPDATE "NodeUsageBatch"\s*\n\s*SET "payload" = '\{\}'::jsonb/,
  "only the raw payload blob may be reclaimed from settled batches"
);
assert.match(
  source,
  /WHERE "accountedAt" IS NOT NULL/,
  "a batch that has not been accounted still owes its payload to accounting"
);

// The premises that make redaction safe, locked against drift.
{
  const body = agentSource.match(/private async accountContiguousBatches\([\s\S]*?\n {2}\}/);
  assert.ok(body, "accountContiguousBatches must still exist");
  assert.match(
    body[0],
    /if \(!batch\.accountedAt\) \{[\s\S]*?const payload = batch\.payload/,
    "payload must stay reachable ONLY for un-accounted batches, or redacting settled ones breaks accounting"
  );
  assert.match(body[0], /if \(batch\.sequence !== ackThrough \+ 1n\) break;/, "accounting must still require contiguity");
}
{
  const body = agentSource.match(/private async advanceAck\([\s\S]*?\n {2}\}/);
  assert.ok(body, "advanceAck must still exist");
  assert.doesNotMatch(body[0], /payload/, "the panel track must not start reading payloads");
}
assert.match(
  agentSource,
  /if \(existing\.payloadHash !== payloadHash\) throw new ConflictException/,
  "replay conflict detection must keep using payloadHash, which redaction preserves"
);
assert.match(
  sessionSource,
  /assertDirectTerminalWatermarksSettled[\s\S]*?nodeUsageBatch\.findUnique\([\s\S]*?select: \{ accountedAt: true \}/,
  "the disable gate looks a specific batch up by key and needs the row to exist"
);

// ---------------------------------------------------------------------------
// Incidents carry no acknowledgement semantics, so closed ones can go entirely.
// ---------------------------------------------------------------------------
assert.match(source, /DELETE FROM "MeteringIncident"/, "resolved incidents may be deleted outright");
assert.match(source, /WHERE status = 'resolved'/, "open metering incidents are live state and must never be pruned");

// ---------------------------------------------------------------------------
// Scheduling: hourly and drain-aware.
// ---------------------------------------------------------------------------
assert.match(source, /@Cron\("0 17 \* \* \* \*"\)/, "reclamation must run hourly so a restart cannot skip it forever");
assert.match(source, /@DrainableJob\(\)/, "reclamation must not claim work while the process is draining");

// ---------------------------------------------------------------------------
// Chunking: bounded per tick, stopping as soon as a short chunk proves the
// backlog is drained rather than issuing the full budget of empty statements.
// ---------------------------------------------------------------------------
function serviceWith(results: number[]) {
  const issued: string[] = [];
  let call = 0;
  const prisma = {
    $executeRaw: (strings: TemplateStringsArray) => {
      issued.push(strings.join("?"));
      const value = results[call] ?? 0;
      call += 1;
      return Promise.resolve(value);
    }
  } as unknown as PrismaService;
  return { service: new MeteringRetentionService(prisma), issued };
}

async function main() {
  {
    const { service, issued } = serviceWith([12, 3]);
    await service.reclaimExpiredMeteringHistory();
    assert.equal(issued.length, 2, "a short chunk must end that table's loop immediately");
    assert.match(issued[0], /UPDATE "NodeUsageBatch"/);
    assert.match(issued[1], /DELETE FROM "MeteringIncident"/);
  }

  {
    const { service, issued } = serviceWith(new Array(200).fill(5_000));
    await service.reclaimExpiredMeteringHistory();
    assert.equal(issued.length, 80, "each table must stop at its per-tick chunk budget instead of draining unboundedly");
    assert.equal(issued.filter((sql) => sql.includes("NodeUsageBatch")).length, 40);
    assert.equal(issued.filter((sql) => sql.includes("MeteringIncident")).length, 40);
  }

  {
    const { service, issued } = serviceWith([0, 0]);
    await service.reclaimExpiredMeteringHistory();
    assert.equal(issued.length, 2, "an idle deployment must cost two statements per hour");
  }
}

main().then(
  () => console.log("metering-retention.regression.ts passed"),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
