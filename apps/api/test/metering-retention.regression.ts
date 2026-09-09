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

// ---------------------------------------------------------------------------
// The deletion predicate IS the safety argument. Both readers in AgentService
// scope to the agent's current bootId and to sequence > lastAckSequence, so a
// row is only prunable once it fails one of those — anything looser would delete
// batches that still owe accounting, i.e. silently drop billable traffic.
// ---------------------------------------------------------------------------
assert.match(
  source,
  /a\."bootId" IS DISTINCT FROM b\."bootId" OR b\."sequence" <= a\."lastAckSequence"/,
  "usage batches may only be pruned once no reader can reach them again"
);
assert.match(
  source,
  /JOIN "NodeAgent" a ON a\.id = b\."agentId"/,
  "the watermark lives on NodeAgent, so the delete must join it rather than trust the row alone"
);
// The watermark check must not be weakened into an OR with the age cutoff.
assert.match(
  source,
  /WHERE b\."createdAt" < \$\{before\}\s*\n\s*AND \(/,
  "the age cutoff and the reachability check must both hold, never either-or"
);
assert.match(
  source,
  /WHERE status = 'resolved'/,
  "open metering incidents are live state and must never be pruned"
);

// The ingest path this reasoning depends on must still look the way it does.
const agentSource = readFileSync(path.join(root, "apps/api/src/modules/agent/agent.service.ts"), "utf8");
for (const reader of ["advanceAck", "accountContiguousBatches"]) {
  const body = agentSource.match(new RegExp(`private async ${reader}\\([\\s\\S]*?\\n  \\}`));
  assert.ok(body, `${reader} must still exist`);
  assert.match(
    body[0],
    /sequence: \{ gt: currentAck \}/,
    `${reader} must still skip settled sequences, or pruning them would drop billable traffic`
  );
  assert.match(body[0], /bootId/, `${reader} must still scope to a single bootId`);
}
assert.match(
  agentSource,
  /data: \{ bootId: input\.bootId, lastSequence: 0n, lastAckSequence: 0n \}/,
  "a boot change must still reset both watermarks, which is what makes old bootIds unreachable"
);

// ---------------------------------------------------------------------------
// Scheduling: hourly and drain-aware.
// ---------------------------------------------------------------------------
assert.match(source, /@Cron\("0 17 \* \* \* \*"\)/, "pruning must run hourly so a restart cannot skip it forever");
assert.match(source, /@DrainableJob\(\)/, "pruning must not claim work while the process is draining");

// ---------------------------------------------------------------------------
// Chunking: bounded per tick, and it stops as soon as a short chunk proves the
// backlog is drained rather than issuing the full budget of empty deletes.
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
    // One short chunk each: two statements total, no wasted round-trips.
    const { service, issued } = serviceWith([12, 3]);
    await service.pruneExpiredMeteringHistory();
    assert.equal(issued.length, 2, "a short chunk must end that table's loop immediately");
    assert.match(issued[0], /NodeUsageBatch/);
    assert.match(issued[1], /MeteringIncident/);
  }

  {
    // A full chunk means more may remain, so it keeps going — but never forever.
    const { service, issued } = serviceWith(new Array(200).fill(5_000));
    await service.pruneExpiredMeteringHistory();
    assert.equal(
      issued.length,
      80,
      "each table must stop after its per-tick chunk budget instead of draining unboundedly"
    );
    assert.equal(issued.filter((sql) => sql.includes("NodeUsageBatch")).length, 40);
    assert.equal(issued.filter((sql) => sql.includes("MeteringIncident")).length, 40);
  }

  {
    // Nothing to prune: exactly one probe per table, and no log noise.
    const { service, issued } = serviceWith([0, 0]);
    await service.pruneExpiredMeteringHistory();
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
