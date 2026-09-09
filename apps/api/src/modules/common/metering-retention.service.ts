import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DrainableJob } from "../../work-lifecycle";
import { PrismaService } from "./prisma.service";

/**
 * Raw agent batches are forensic once they have been folded into TrafficLedger,
 * but nothing ever deleted them: a 17-user deployment accumulated 702,765 rows /
 * 1656 MB in 41 days (~40 MB/day), 98.6% of the whole database. Resolved metering
 * incidents grew the same way — 271,453 rows, all of them already closed.
 */
const DEFAULT_USAGE_BATCH_RETENTION_DAYS = 30;
const DEFAULT_INCIDENT_RETENTION_DAYS = 90;
/**
 * Deleting is bounded per tick rather than "everything older than the cutoff":
 * the first run against an un-pruned database would otherwise be a single
 * multi-hundred-thousand-row statement holding locks while the API serves live
 * ingest. Chunked deletes let each statement commit and yield.
 */
const DELETE_CHUNK_ROWS = 5_000;
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
   * Hourly rather than daily on purpose: this deployment restarts itself for
   * every backend update, and a once-a-day schedule can be skipped indefinitely
   * by a restart that lands before it. An hourly tick with a bounded budget is
   * self-healing — it drains a backlog over a few hours and then idles.
   */
  @Cron("0 17 * * * *")
  @DrainableJob()
  async pruneExpiredMeteringHistory() {
    const batches = await this.pruneUsageBatches();
    const incidents = await this.pruneResolvedIncidents();
    if (batches > 0 || incidents > 0) {
      this.logger.log(`计量历史清理：删除 ${batches} 条用量批次、${incidents} 条已解决的计量异常`);
    }
  }

  /**
   * A batch is deletable once no future read path can reach it again.
   *
   * Both readers — accountContiguousBatches and advanceAck in AgentService —
   * scope their queries to the agent's CURRENT bootId and to `sequence >
   * lastAckSequence`. The acknowledgement watermark lives on NodeAgent, not in
   * this table, so a row at or below it is already settled, and a row belonging
   * to a superseded bootId is unreachable regardless of its sequence (a boot
   * change resets both watermarks to 0).
   *
   * Deleting such a row therefore cannot cause double-counting: a replay of a
   * deleted batch no longer matches the (nodeId, bootId, sequence) uniqueness
   * probe, so it is inserted anew — but accounting still filters on `sequence >
   * lastAckSequence`, so it is never billed a second time, and the next tick
   * prunes it again.
   *
   * The one behaviour that does change: the ack for such a replay reports
   * `duplicate: false` instead of `true`, and a replay carrying a DIFFERENT
   * payload for an already-settled sequence no longer raises the payload-hash
   * conflict. Neither affects the ledger, and agents advance on `ackThrough`.
   */
  private async pruneUsageBatches(): Promise<number> {
    const before = cutoff(
      readPositiveIntegerEnv("CHORDV_USAGE_BATCH_RETENTION_DAYS", DEFAULT_USAGE_BATCH_RETENTION_DAYS)
    );
    let deleted = 0;
    for (let chunk = 0; chunk < MAX_CHUNKS_PER_TICK; chunk += 1) {
      const removed = await this.prisma.$executeRaw`
        DELETE FROM "NodeUsageBatch"
         WHERE id IN (
           SELECT b.id
             FROM "NodeUsageBatch" b
             JOIN "NodeAgent" a ON a.id = b."agentId"
            WHERE b."createdAt" < ${before}
              AND (a."bootId" IS DISTINCT FROM b."bootId" OR b."sequence" <= a."lastAckSequence")
            LIMIT ${DELETE_CHUNK_ROWS}
         )`;
      deleted += removed;
      if (removed < DELETE_CHUNK_ROWS) break;
    }
    return deleted;
  }

  /**
   * Only closed incidents, and only after a window long enough to stay useful for
   * dispute handling. Open incidents are live state and are never touched here.
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
            LIMIT ${DELETE_CHUNK_ROWS}
         )`;
      deleted += removed;
      if (removed < DELETE_CHUNK_ROWS) break;
    }
    return deleted;
  }
}
