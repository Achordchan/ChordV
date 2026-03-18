import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { randomUUID } from "node:crypto";
import { Agent, fetch as undiciFetch } from "undici";
import { DevDataService } from "../common/dev-data.service";
import { PrismaService } from "../common/prisma.service";

const SYNC_INTERVAL_MS = 30_000;
const GB_IN_BYTES = 1024 ** 3;

@Injectable()
export class UsageSyncService {
  private readonly logger = new Logger(UsageSyncService.name);
  private readonly httpsAgent = new Agent({
    connect: {
      rejectUnauthorized: false
    }
  });
  private readonly mockCounters = new Map<string, { uplinkBytes: bigint; downlinkBytes: bigint }>();
  private syncInFlight = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly devDataService: DevDataService
  ) {}

  @Cron("*/30 * * * * *")
  async syncNodeUsage() {
    if (this.syncInFlight) {
      return;
    }

    this.syncInFlight = true;
    try {
      const nodes = await this.prisma.node.findMany({
        where: {
          statsEnabled: true,
          statsApiUrl: { not: null }
        },
        orderBy: [{ recommended: "desc" }, { createdAt: "asc" }]
      });

      for (const node of nodes) {
        try {
          const samples = await this.readNodeSamples(node.id, node.statsApiUrl ?? "", node.statsApiToken ?? null);
          await this.applyNodeSamples(node.id, samples);
          await this.prisma.node.update({
            where: { id: node.id },
            data: { statsLastSyncedAt: new Date() }
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "未知错误";
          this.logger.warn(`节点 ${node.id} 用量同步失败: ${message}`);
        }
      }
    } finally {
      this.syncInFlight = false;
    }
  }

  private async readNodeSamples(nodeId: string, statsApiUrl: string, statsApiToken: string | null) {
    if (statsApiUrl.startsWith("mock://")) {
      return this.readMockSamples(nodeId);
    }

    const response = await undiciFetch(statsApiUrl, {
      dispatcher: statsApiUrl.startsWith("https://") ? this.httpsAgent : undefined,
      headers: {
        Accept: "application/json",
        ...(statsApiToken ? { Authorization: `Bearer ${statsApiToken}` } : {})
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const body = (await response.json()) as unknown;
    return normalizeStatsResponse(body);
  }

  private readMockSamples(nodeId: string): NodeTrafficSample[] {
    const context = this.devDataService.getActiveRuntimeUsageContext();
    if (!context || context.nodeId !== nodeId) {
      return [];
    }

    const key = buildSnapshotKey(nodeId, context.subscriptionId, context.userId ?? null);
    const current = this.mockCounters.get(key) ?? {
      uplinkBytes: 0n,
      downlinkBytes: 0n
    };

    const uplinkBytes = current.uplinkBytes + 12n * 1024n * 1024n;
    const downlinkBytes = current.downlinkBytes + 48n * 1024n * 1024n;
    this.mockCounters.set(key, { uplinkBytes, downlinkBytes });

    return [
      {
        subscriptionId: context.subscriptionId,
        userId: context.teamId ? context.userId : null,
        uplinkBytes,
        downlinkBytes,
        sampledAt: new Date().toISOString()
      }
    ];
  }

  private async applyNodeSamples(nodeId: string, samples: NodeTrafficSample[]) {
    for (const sample of samples) {
      const subscription = await this.prisma.subscription.findUnique({
        where: { id: sample.subscriptionId }
      });
      if (!subscription) {
        continue;
      }

      const snapshotKey = buildSnapshotKey(nodeId, sample.subscriptionId, sample.userId ?? null);
      const totalBytes = sample.uplinkBytes + sample.downlinkBytes;
      const snapshot = await this.prisma.trafficSnapshot.findUnique({
        where: { snapshotKey }
      });

      const sampledAt = parseSampledAt(sample.sampledAt);
      if (!snapshot) {
        await this.prisma.trafficSnapshot.create({
          data: {
            id: randomUUID(),
            snapshotKey,
            nodeId,
            subscriptionId: subscription.id,
            userId: sample.userId ?? null,
            teamId: subscription.teamId,
            uplinkBytes: sample.uplinkBytes,
            downlinkBytes: sample.downlinkBytes,
            totalBytes,
            sampledAt
          }
        });
        await this.touchSubscriptionSyncState(subscription.id, sampledAt);
        continue;
      }

      if (totalBytes < snapshot.totalBytes) {
        await this.prisma.trafficSnapshot.update({
          where: { snapshotKey },
          data: {
            uplinkBytes: sample.uplinkBytes,
            downlinkBytes: sample.downlinkBytes,
            totalBytes,
            sampledAt
          }
        });
        await this.touchSubscriptionSyncState(subscription.id, sampledAt);
        continue;
      }

      const deltaBytes = totalBytes - snapshot.totalBytes;
      await this.prisma.trafficSnapshot.update({
        where: { snapshotKey },
        data: {
          uplinkBytes: sample.uplinkBytes,
          downlinkBytes: sample.downlinkBytes,
          totalBytes,
          sampledAt
        }
      });

      if (deltaBytes <= 0n) {
        await this.touchSubscriptionSyncState(subscription.id, sampledAt);
        continue;
      }

      await this.applyUsageDelta(subscription.id, subscription.teamId, sample.userId ?? null, deltaBytes, sampledAt);
    }
  }

  private async applyUsageDelta(
    subscriptionId: string,
    teamId: string | null,
    userId: string | null,
    deltaBytes: bigint,
    sampledAt: Date
  ) {
    const deltaGb = Number(deltaBytes) / GB_IN_BYTES;

    await this.prisma.$transaction(async (tx) => {
      const current = await tx.subscription.findUnique({
        where: { id: subscriptionId }
      });

      if (!current) {
        return;
      }

      const nextUsedTrafficGb = roundTrafficGb(current.usedTrafficGb + deltaGb);
      const nextRemainingTrafficGb = roundTrafficGb(Math.max(0, current.totalTrafficGb - nextUsedTrafficGb));
      const nextState =
        current.expireAt.getTime() <= sampledAt.getTime()
          ? "expired"
          : nextRemainingTrafficGb <= 0
            ? "exhausted"
            : current.state === "paused"
              ? "paused"
              : "active";

      await tx.subscription.update({
        where: { id: subscriptionId },
        data: {
          usedTrafficGb: nextUsedTrafficGb,
          remainingTrafficGb: nextRemainingTrafficGb,
          state: nextState,
          lastSyncedAt: sampledAt
        }
      });

      if (teamId && userId) {
        await tx.trafficLedger.create({
          data: {
            id: randomUUID(),
            teamId,
            userId,
            subscriptionId,
            usedTrafficGb: roundTrafficGb(deltaGb),
            recordedAt: sampledAt
          }
        });
      }
    });
  }

  private async touchSubscriptionSyncState(subscriptionId: string, sampledAt: Date) {
    await this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: { lastSyncedAt: sampledAt }
    });
  }
}

type NodeTrafficSample = {
  subscriptionId: string;
  userId: string | null;
  uplinkBytes: bigint;
  downlinkBytes: bigint;
  sampledAt?: string;
};

function normalizeStatsResponse(body: unknown): NodeTrafficSample[] {
  const payload = Array.isArray(body)
    ? body
    : body && typeof body === "object" && "records" in body && Array.isArray(body.records)
      ? body.records
      : [];

  return payload.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const subscriptionId = readString(entry, "subscriptionId");
    if (!subscriptionId) {
      return [];
    }

    return [
      {
        subscriptionId,
        userId: readString(entry, "userId") ?? null,
        uplinkBytes: readBigInt(entry, "uplinkBytes"),
        downlinkBytes: readBigInt(entry, "downlinkBytes"),
        sampledAt: readString(entry, "sampledAt") ?? undefined
      }
    ];
  });
}

function readString(value: object, key: string) {
  const target = Reflect.get(value, key);
  return typeof target === "string" && target.trim() ? target.trim() : null;
}

function readBigInt(value: object, key: string) {
  const target = Reflect.get(value, key);
  if (typeof target === "bigint") {
    return target;
  }
  if (typeof target === "number" && Number.isFinite(target)) {
    return BigInt(Math.max(0, Math.trunc(target)));
  }
  if (typeof target === "string" && target.trim()) {
    return BigInt(target.trim());
  }
  return 0n;
}

function parseSampledAt(sampledAt?: string) {
  if (!sampledAt) {
    return new Date();
  }

  const next = new Date(sampledAt);
  return Number.isNaN(next.getTime()) ? new Date() : next;
}

function buildSnapshotKey(nodeId: string, subscriptionId: string, userId: string | null) {
  return [nodeId, subscriptionId, userId ?? "subscription"].join(":");
}

function roundTrafficGb(value: number) {
  return Math.round(value * 1000) / 1000;
}
