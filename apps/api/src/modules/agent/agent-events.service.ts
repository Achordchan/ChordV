import { Injectable, Logger, MessageEvent } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import type { AgentCommandDto } from "@chordv/shared";
import { Observable } from "rxjs";
import { PrismaService } from "../common/prisma.service";
import { DrainableJob, workLifecycle } from "../../work-lifecycle";

type EventSink = (event: MessageEvent) => void;

@Injectable()
export class AgentEventsService {
  private readonly logger = new Logger(AgentEventsService.name);
  private readonly subscribers = new Map<string, Set<EventSink>>();
  private retrying = false;

  constructor(private readonly prisma: PrismaService) {}

  stream(agentId: string, validate: () => Promise<void>): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      let queue = Promise.resolve();
      const deliver = (event: MessageEvent) => {
        queue = queue.then(validate).then(() => subscriber.next(event)).catch((error) => subscriber.error(error));
      };
      const sink: EventSink = (event) => {
        deliver(event);
      };
      const sinks = this.subscribers.get(agentId) ?? new Set<EventSink>();
      sinks.add(sink);
      this.subscribers.set(agentId, sinks);

      void this.loadPending(agentId).then((commands) => commands.forEach((command) => sink(this.toEvent(command))));
      const keepaliveTimer = setInterval(() => deliver({ type: "keepalive", data: JSON.stringify({ occurredAt: new Date().toISOString() }) }), 15000);

      // An agent command stream is a long-lived request: without this the drain
      // waits for a subscription that only ends when the agent disconnects, so
      // every self-update stalled until the full drain timeout and fenced.
      const removeDrainListener = workLifecycle.onDrain(() => subscriber.complete());
      return () => {
        removeDrainListener();
        clearInterval(keepaliveTimer);
        sinks.delete(sink);
        if (sinks.size === 0) this.subscribers.delete(agentId);
      };
    });
  }

  publish(agentId: string, command: AgentCommandDto) {
    const event = this.toEvent(command);
    for (const sink of this.subscribers.get(agentId) ?? []) sink(event);
  }

  @Cron("*/30 * * * * *")
  @DrainableJob()
  async retryDueCommands() {
    if (this.retrying) return;
    this.retrying = true;
    try {
      const now = new Date();
      const firstAttemptCutoff = new Date(now.getTime() - 30_000);
      const exhausted = await this.prisma.nodeCommandJob.findMany({
        where: {
          status: { in: ["pending", "running", "failed"] },
          attempts: { gte: 8 },
          OR: [{ nextRunAt: { lte: now } }, { createdAt: { lte: firstAttemptCutoff } }]
        },
        select: { id: true, nodeId: true, dedupeKey: true, commandType: true }
      });
      if (exhausted.length > 0) {
        // Cancelling ends the operation, so an ENSURE_INBOUND's key must be
        // released or that deployment could never be ordered again on this
        // node. Other types keep their key: it is the caller's idempotency
        // contract, not a lock on an outstanding operation. Both writes are one
        // transaction — a cancelled job that kept its key would be excluded
        // from every later sweep and would permanently block that deployment.
        let cancelledCount = 0;
        for (const candidate of exhausted) {
          if (workLifecycle.isDraining) break;
          cancelledCount += await this.prisma.$transaction(async (tx) => {
            // Enqueue and completion take Node first. Re-read after acquiring
            // the same lock: the scan is only a candidate list, not authority
            // to overwrite a command that completed while this sweep waited.
            await tx.$queryRaw`SELECT id FROM "Node" WHERE id = ${candidate.nodeId} FOR UPDATE`;
            const job = await tx.nodeCommandJob.findFirst({
              where: {
                id: candidate.id,
                status: { in: ["pending", "running", "failed"] },
                attempts: { gte: 8 }
              }
            });
            if (!job) return 0;
            const replacements = await tx.nodeCommandJob.findMany({
              where: {
                nodeId: job.nodeId,
                targetRevision: { gt: job.targetRevision },
                OR: [
                  ...(job.bindingId ? [{ bindingId: job.bindingId, commandType: { in: [job.commandType, "REMOVE_USER" as const] } }] : []),
                  { bindingId: null, commandType: job.commandType }
                ]
              },
              select: { bindingId: true, payload: true }
            });
            // Match enqueue resolution: binding commands cover their binding;
            // commands without a user target cover node + commandType. A raw
            // email/UUID command without bindingId must not clear other users.
            const superseded = replacements.some(replacement => replacement.bindingId ||
              !["bindingId", "userKey", "email", "uuid"].some(key => {
                const payload = replacement.payload;
                return payload !== null && typeof payload === "object" && !Array.isArray(payload)
                  && typeof payload[key] === "string" && payload[key].length > 0;
              }));
            await tx.nodeCommandJob.update({
              where: { id: job.id },
              data: {
                status: "cancelled",
                lastError: "Agent 命令重试次数已达到上限",
                ...(superseded ? { resolvedAt: new Date() } : {}),
                ...(job.commandType === "ENSURE_INBOUND" ? { dedupeKey: `${job.dedupeKey}:cancelled:${job.id}` } : {})
              }
            });
            if (!superseded && !job.resolvedAt) {
              await tx.node.updateMany({
                where: { id: job.nodeId, controlStatus: { notIn: ["rollback_pending", "direct_cutover_pending"] } },
                data: { controlStatus: "degraded" }
              });
            }
            return 1;
          });
        }
        if (cancelledCount > 0) this.logger.error(`已取消 ${cancelledCount} 个超过重试上限的 Agent 命令`);
      }

      const jobs = await this.prisma.nodeCommandJob.findMany({
        where: {
          agentId: { not: null },
          status: { in: ["pending", "running", "failed"] },
          attempts: { lt: 8 },
          OR: [
            { status: { in: ["pending", "running"] }, attempts: 0, createdAt: { lte: firstAttemptCutoff } },
            { status: "failed", attempts: 0, nextRunAt: { lte: now } },
            { attempts: { gt: 0 }, nextRunAt: { lte: now } }
          ]
        },
        orderBy: [{ nextRunAt: "asc" }, { createdAt: "asc" }],
        take: 500
      });
      for (const job of jobs) {
        const claimed = await this.prisma.nodeCommandJob.updateMany({
          where: {
            id: job.id,
            status: { in: ["pending", "running", "failed"] },
            attempts: job.attempts
          },
          data: {
            status: "running",
            attempts: { increment: 1 },
            nextRunAt: new Date(Date.now() + 30_000)
          }
        });
        if (claimed.count === 1 && job.agentId) this.publish(job.agentId, serializeCommand(job));
      }
    } finally {
      this.retrying = false;
    }
  }

  private async loadPending(agentId: string): Promise<AgentCommandDto[]> {
    const jobs = await this.prisma.nodeCommandJob.findMany({
      where: { agentId, status: { in: ["pending", "running", "failed"] }, nextRunAt: { lte: new Date() } },
      orderBy: [{ targetRevision: "asc" }, { createdAt: "asc" }],
      take: 200
    });
    return jobs.map((job) => ({
      commandId: job.id,
      type: job.commandType,
      targetRevision: job.targetRevision.toString(),
      payload: job.payload as Record<string, unknown>,
      createdAt: job.createdAt.toISOString()
    }));
  }

  private toEvent(command: AgentCommandDto): MessageEvent {
    return { id: command.commandId, type: "command", data: JSON.stringify(command) };
  }
}

function serializeCommand(job: {
  id: string;
  commandType: AgentCommandDto["type"];
  targetRevision: bigint;
  payload: unknown;
  createdAt: Date;
}): AgentCommandDto {
  return {
    commandId: job.id,
    type: job.commandType,
    targetRevision: job.targetRevision.toString(),
    payload: job.payload as Record<string, unknown>,
    createdAt: job.createdAt.toISOString()
  };
}
