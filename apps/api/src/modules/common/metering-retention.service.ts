import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DrainableJob } from "../../work-lifecycle";
import { PrismaService } from "./prisma.service";

/**
 * Metering history was written and never reclaimed: a 17-user deployment reached
 * 702,765 NodeUsageBatch rows / 1656 MB and 271,453 MeteringIncident rows / 180 MB
 * in 41 days — 98.6% of the whole database, against under 4 MB of real business
 * data. ~40 MB/day, unbounded and unrelated to user count.
 */
const DEFAULT_USAGE_PAYLOAD_RETENTION_DAYS = 30;
const DEFAULT_INCIDENT_RETENTION_DAYS = 90;
/**
 * Bounded per tick rather than "everything past the cutoff": the first run against
 * an un-reclaimed database would otherwise be a single several-hundred-thousand-row
 * statement holding locks while the API is still ingesting. Chunking lets each
 * statement commit and yield.
 */
const CHUNK_ROWS = 5_000;
const MAX_CHUNKS_PER_TICK = 40;

function readPositiveIntegerEnv(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function cutoff(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

@Injectable()
export class MeteringRetentionService {
  private readonly logger = new Logger(MeteringRetentionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Hourly rather than daily on purpose: this deployment restarts itself for every
   * backend update, and a once-a-day schedule can be skipped indefinitely by a
   * restart that lands before it. An hourly tick with a bounded budget is
   * self-healing — it drains a backlog over a few hours, then idles at two
   * statements per hour.
   */
  @Cron("0 17 * * * *")
  @DrainableJob()
  async reclaimExpiredMeteringHistory() {
    const payloads = await this.redactSettledUsagePayloads();
    const incidents = await this.pruneResolvedIncidents();
    if (payloads > 0 || incidents > 0) {
      this.logger.log(`计量历史回收：清空 ${payloads} 条已入账批次的原始载荷、删除 ${incidents} 条已解决的计量异常`);
    }
  }

  /**
   * NodeUsageBatch rows are KEPT; only the raw `payload` blob is cleared.
   *
   * Deleting the rows is not safe, and the reason is worth stating precisely: a
   * batch's reachability is NOT decided by its age or by whether its bootId is the
   * agent's current one. `ingestUsageBatchWithinNodeLock` adopts whatever bootId
   * arrives and resets lastAckSequence to 0 — including a flip BACK to a boot it
   * had already superseded, which `heartbeat` can do as well. The node-agent keeps
   * a durable local queue, so a retry from an old boot after extended downtime is
   * reachable in practice. Once the watermark is back at 0, contiguous
   * acknowledgement has to walk from sequence 1 again; a deleted prefix leaves a
   * permanent gap and that node's metering can never advance again.
   *
   * Three readers also depend on these rows existing:
   *   - accountContiguousBatches walks them for contiguity
   *   - advanceAck does the same on the retired panel track
   *   - assertDirectTerminalWatermarksSettled (runtime-session.service.ts) looks a
   *     specific (nodeId, bootId, sequence) up and refuses the disable flow when it
   *     is missing — a deleted row would wedge that flow, not merely slow it
   * and the ingest de-duplication compares `payloadHash` on replay.
   *
   * Clearing `payload` costs none of that: it is read ONLY inside
   * `if (!batch.accountedAt)`, i.e. never for a row this method touches. Sequence,
   * accountedAt and payloadHash all survive, so contiguity, the disable gate and
   * replay conflict detection keep working byte for byte. The blob is 871 MB of
   * the table's 1656 MB.
   *
   * Reclaiming the rows themselves needs a durable per-boot acknowledgement
   * watermark so it can never regress to 0; that is a separate change to the
   * billing-critical ingest path and is deliberately not in this one.
   */
  private async redactSettledUsagePayloads(): Promise<number> {
    const before = cutoff(
      readPositiveIntegerEnv("CHORDV_USAGE_PAYLOAD_RETENTION_DAYS", DEFAULT_USAGE_PAYLOAD_RETENTION_DAYS)
    );
    let redacted = 0;
    for (let chunk = 0; chunk < MAX_CHUNKS_PER_TICK; chunk += 1) {
      const changed = await this.prisma.$executeRaw`
        UPDATE "NodeUsageBatch"
           SET "payload" = '{}'::jsonb
         WHERE id IN (
           SELECT id
             FROM "NodeUsageBatch"
            WHERE "accountedAt" IS NOT NULL
              AND "createdAt" < ${before}
              AND "payload" <> '{}'::jsonb
            LIMIT ${CHUNK_ROWS}
         )`;
      redacted += changed;
      if (changed < CHUNK_ROWS) break;
    }
    return redacted;
  }

  /**
   * Incidents carry no acknowledgement semantics, so closed ones can go entirely.
   * Only `resolved` rows, and only past a window long enough to stay useful for
   * dispute handling; `open` incidents are live state and are never touched.
   */
  private async pruneResolvedIncidents(): Promise<number> {
    const before = cutoff(
      readPositiveIntegerEnv("CHORDV_METERING_INCIDENT_RETENTION_DAYS", DEFAULT_INCIDENT_RETENTION_DAYS)
    );
    let deleted = 0;
    for (let chunk = 0; chunk < MAX_CHUNKS_PER_TICK; chunk += 1) {
      const removed = await this.prisma.$executeRaw`
        DELETE FROM "MeteringIncident"
         WHERE id IN (
           SELECT id
             FROM "MeteringIncident"
            WHERE status = 'resolved'
              AND COALESCE("resolvedAt", "updatedAt") < ${before}
            LIMIT ${CHUNK_ROWS}
         )`;
      deleted += removed;
      if (removed < CHUNK_ROWS) break;
    }
    return deleted;
  }
}
