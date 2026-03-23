import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { randomUUID } from "node:crypto";
import {
  METERING_REASON_COUNTER_ROLLBACK,
  METERING_REASON_MAPPING_MISSING,
  METERING_REASON_NODE_UNAVAILABLE,
  METERING_REASON_SAMPLE_MISSING
} from "../common/metering.constants";
import { MeteringIncidentService } from "../common/metering-incident.service";
import { PrismaService } from "../common/prisma.service";
import { XuiService } from "../xui/xui.service";

const GB_IN_BYTES = 1024 ** 3;
const NODE_USAGE_STALE_SECONDS = Number(process.env.CHORDV_NODE_USAGE_STALE_SECONDS ?? 90);
const NODE_USAGE_WARN_INTERVAL_MS = Number(process.env.CHORDV_NODE_USAGE_WARN_INTERVAL_SECONDS ?? 600) * 1000;

@Injectable()
export class UsageSyncService {
  private readonly logger = new Logger(UsageSyncService.name);
  private readonly warningTimestamps = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly meteringIncidentService: MeteringIncidentService,
    private readonly xuiService: XuiService
  ) {}

  async ingestUsageReport(nodeId: string, records: unknown, reportedAt: string) {
    const context = await this.loadNodeSyncContext(nodeId);
    const samples = normalizeStatsResponse({ records });
    await this.applyNodeSamples(nodeId, samples, context);

    const reportedAtDate = parseSampledAt(reportedAt);
    await this.prisma.node.update({
      where: { id: nodeId },
      data: {
        statsLastSyncedAt: reportedAtDate
      }
    });
    await this.resolveIncidentForSubscriptions(context.subscriptionIds, nodeId, METERING_REASON_NODE_UNAVAILABLE);
  }

  @Cron("*/30 * * * * *")
  async syncNodeUsage() {
    const policy = await this.prisma.policyProfile.findUnique({
      where: { id: "default" },
      select: { accessMode: true }
    });

    if (policy?.accessMode === "xui") {
      await this.syncXuiUsage();
      return;
    }

    const activeLeases = await this.prisma.nodeSessionLease.findMany({
      where: {
        status: "active",
        expiresAt: { gt: new Date() }
      },
      select: {
        nodeId: true,
        subscriptionId: true,
        node: {
          select: {
            statsLastSyncedAt: true
          }
        }
      }
    });

    const now = Date.now();
    const perNode = new Map<string, { statsLastSyncedAt: Date | null; subscriptionIds: string[] }>();
    for (const lease of activeLeases) {
      const current = perNode.get(lease.nodeId) ?? {
        statsLastSyncedAt: lease.node.statsLastSyncedAt,
        subscriptionIds: []
      };
      current.statsLastSyncedAt = lease.node.statsLastSyncedAt;
      current.subscriptionIds.push(lease.subscriptionId);
      perNode.set(lease.nodeId, current);
    }

    for (const [nodeId, item] of perNode.entries()) {
      const subscriptionIds = Array.from(new Set(item.subscriptionIds));
      const sampleFresh =
        item.statsLastSyncedAt && now - item.statsLastSyncedAt.getTime() <= NODE_USAGE_STALE_SECONDS * 1000;
      if (sampleFresh) {
        await this.resolveIncidentForSubscriptions(subscriptionIds, nodeId, METERING_REASON_NODE_UNAVAILABLE);
        continue;
      }

      const reason = "中心转发计费样本上报超时";
      this.warnThrottled(nodeId, reason);
      await this.openIncidentForSubscriptions(
        subscriptionIds,
        nodeId,
        METERING_REASON_NODE_UNAVAILABLE,
        `${reason}，等待节点恢复上报`
      );
    }
  }

  private async syncXuiUsage() {
    const bindings = await this.prisma.panelClientBinding.findMany({
      where: {
        status: "active",
        subscription: {
          state: "active"
        },
        node: {
          panelEnabled: true
        }
      },
      include: {
        node: {
          select: {
            id: true,
            panelBaseUrl: true,
            panelApiBasePath: true,
            panelUsername: true,
            panelPassword: true,
            panelInboundId: true
          }
        }
      }
    });

    const nodeMap = new Map<string, typeof bindings>();
    for (const binding of bindings) {
      const current = nodeMap.get(binding.nodeId) ?? [];
      current.push(binding);
      nodeMap.set(binding.nodeId, current);
    }

    for (const [nodeId, nodeBindings] of nodeMap.entries()) {
      const subscriptionIds = Array.from(new Set(nodeBindings.map((item) => item.subscriptionId)));
      try {
        const allowedEmails = new Set(
          nodeBindings.map((item) => item.panelClientEmail.trim().toLowerCase()).filter(Boolean)
        );
        const records = (await this.xuiService.listNodeUsage({
          id: nodeId,
          panelBaseUrl: nodeBindings[0].node.panelBaseUrl,
          panelApiBasePath: nodeBindings[0].node.panelApiBasePath,
          panelUsername: nodeBindings[0].node.panelUsername,
          panelPassword: nodeBindings[0].node.panelPassword,
          panelInboundId: nodeBindings[0].node.panelInboundId
        })).filter((item) => allowedEmails.has(item.xrayUserEmail.trim().toLowerCase()));
        const context = await this.loadNodeSyncContext(nodeId, "xui");
        await this.applyNodeSamples(nodeId, records, context);
        const now = new Date();
        await this.prisma.node.update({
          where: { id: nodeId },
          data: {
            panelStatus: "online",
            panelError: null,
            panelLastSyncedAt: now,
            statsLastSyncedAt: now
          }
        });
        await this.resolveIncidentForSubscriptions(subscriptionIds, nodeId, METERING_REASON_NODE_UNAVAILABLE);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "3x-ui 面板流量同步失败";
        this.warnThrottled(nodeId, detail);
        await this.prisma.node.update({
          where: { id: nodeId },
          data: {
            panelStatus: "degraded",
            panelError: detail
          }
        });
        await this.openIncidentForSubscriptions(
          subscriptionIds,
          nodeId,
          METERING_REASON_NODE_UNAVAILABLE,
          `3x-ui 面板流量同步失败：${detail}`
        );
      }
    }
  }

  private async applyNodeSamples(nodeId: string, samples: NodeTrafficSample[], context: NodeSyncContext) {
    const seenEmails = new Set<string>();
    const mappedSubscriptions = new Set<string>();
    const rollbackSubscriptions = new Set<string>();
    const rollbackDetails = new Map<string, string>();
    const mappingIssues = new Map<string, string[]>();

    for (const item of context.invalidMappings) {
      appendIssue(mappingIssues, item.subscriptionId, item.detail);
    }

    for (const sample of samples) {
      const normalizedEmail = sample.xrayUserEmail.trim().toLowerCase();
      if (!normalizedEmail) {
        continue;
      }
      seenEmails.add(normalizedEmail);

      const mapping =
        (sample.xrayUserUuid ? context.leaseMappingsByUuid.get(sample.xrayUserUuid) : undefined) ??
        context.mappings.get(normalizedEmail);
      if (!mapping) {
        for (const subscriptionId of context.subscriptionIds) {
          appendIssue(mappingIssues, subscriptionId, `未识别用户 ${normalizedEmail} 的计费映射`);
        }
        continue;
      }

      mappedSubscriptions.add(mapping.subscriptionId);

      const totalBytes = sample.uplinkBytes + sample.downlinkBytes;
      const snapshotKey = buildSnapshotKey(nodeId, mapping.subscriptionId, mapping.userId);
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
            subscriptionId: mapping.subscriptionId,
            userId: mapping.userId,
            teamId: mapping.teamId,
            uplinkBytes: sample.uplinkBytes,
            downlinkBytes: sample.downlinkBytes,
            totalBytes,
            sampledAt
          }
        });
        await this.touchBindingSyncState(mapping.bindingId, sample.uplinkBytes, sample.downlinkBytes, sampledAt);
        await this.touchSubscriptionSyncState(mapping.subscriptionId, sampledAt);
        continue;
      }

      if (totalBytes < snapshot.totalBytes) {
        rollbackSubscriptions.add(mapping.subscriptionId);
        rollbackDetails.set(mapping.subscriptionId, `用户 ${normalizedEmail} 的累计流量计数发生回退`);
        await this.touchSubscriptionSyncState(mapping.subscriptionId, sampledAt);
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
      await this.touchBindingSyncState(mapping.bindingId, sample.uplinkBytes, sample.downlinkBytes, sampledAt);

      if (deltaBytes <= 0n) {
        await this.touchSubscriptionSyncState(mapping.subscriptionId, sampledAt);
        continue;
      }

      await this.applyUsageDelta(nodeId, mapping.subscriptionId, mapping.teamId, mapping.userId, deltaBytes, sampledAt);
    }

    const missingSnapshotKeys = Array.from(context.mappings.entries())
      .filter(([email]) => !seenEmails.has(email))
      .map(([, mapping]) => ({
        subscriptionId: mapping.subscriptionId,
        snapshotKey: buildSnapshotKey(nodeId, mapping.subscriptionId, mapping.userId)
      }));

    const existingMissingSnapshots =
      missingSnapshotKeys.length > 0
        ? await this.prisma.trafficSnapshot.findMany({
            where: {
              snapshotKey: {
                in: missingSnapshotKeys.map((item) => item.snapshotKey)
              }
            },
            select: {
              snapshotKey: true
            }
          })
        : [];
    const existingMissingSet = new Set(existingMissingSnapshots.map((item) => item.snapshotKey));
    const missingSubscriptions = new Set<string>();
    for (const item of missingSnapshotKeys) {
      const mapping = Array.from(context.mappings.values()).find(
        (entry) => buildSnapshotKey(nodeId, entry.subscriptionId, entry.userId) === item.snapshotKey
      );
      const lastSyncedAt = mapping?.bindingLastSyncedAt?.getTime() ?? 0;
      const staleEnough = lastSyncedAt > 0 && Date.now() - lastSyncedAt >= NODE_USAGE_STALE_SECONDS * 1000;
      if (existingMissingSet.has(item.snapshotKey) && staleEnough) {
        missingSubscriptions.add(item.subscriptionId);
      }
    }

    for (const subscriptionId of missingSubscriptions) {
      await this.meteringIncidentService.open(
        subscriptionId,
        nodeId,
        METERING_REASON_SAMPLE_MISSING,
        "节点本轮未返回该用户累计流量样本，待后续同步追平"
      );
    }

    for (const subscriptionId of mappedSubscriptions) {
      if (!missingSubscriptions.has(subscriptionId)) {
        await this.meteringIncidentService.resolve(subscriptionId, nodeId, METERING_REASON_SAMPLE_MISSING);
      }
    }

    for (const subscriptionId of rollbackSubscriptions) {
      await this.meteringIncidentService.open(
        subscriptionId,
        nodeId,
        METERING_REASON_COUNTER_ROLLBACK,
        rollbackDetails.get(subscriptionId) ?? "节点累计计数回退，已等待后续样本恢复"
      );
    }

    for (const subscriptionId of mappedSubscriptions) {
      if (!rollbackSubscriptions.has(subscriptionId)) {
        await this.meteringIncidentService.resolve(subscriptionId, nodeId, METERING_REASON_COUNTER_ROLLBACK);
      }
    }

    for (const [subscriptionId, details] of mappingIssues.entries()) {
      await this.meteringIncidentService.open(
        subscriptionId,
        nodeId,
        METERING_REASON_MAPPING_MISSING,
        details.slice(0, 3).join("；")
      );
    }

    for (const subscriptionId of context.subscriptionIds) {
      if (!mappingIssues.has(subscriptionId)) {
        await this.meteringIncidentService.resolve(subscriptionId, nodeId, METERING_REASON_MAPPING_MISSING);
      }
    }
  }

  private async applyUsageDelta(
    nodeId: string,
    subscriptionId: string,
    teamId: string | null,
    userId: string | null,
    deltaBytes: bigint,
    sampledAt: Date
  ) {
    const deltaGb = Number(deltaBytes) / GB_IN_BYTES;
    let nextState: "active" | "expired" | "exhausted" | "paused" = "active";

    await this.prisma.$transaction(async (tx) => {
      const current = await tx.subscription.findUnique({
        where: { id: subscriptionId }
      });

      if (!current) {
        return;
      }

      const nextUsedTrafficGb = roundTrafficGb(current.usedTrafficGb + deltaGb);
      const nextRemainingTrafficGb = roundTrafficGb(Math.max(0, current.totalTrafficGb - nextUsedTrafficGb));
      nextState =
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
            nodeId,
            usedTrafficGb: roundTrafficGb(deltaGb),
            recordedAt: sampledAt
          }
        });
      }
    });

    if (nextState !== "active") {
      await this.deactivatePanelClients(subscriptionId, "disabled");
      await this.revokeActiveLeases(
        subscriptionId,
        nextState === "expired"
          ? "subscription_expired"
          : nextState === "exhausted"
            ? "subscription_exhausted"
            : "subscription_paused"
      );
    }
  }

  private async touchSubscriptionSyncState(subscriptionId: string, sampledAt: Date) {
    await this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: { lastSyncedAt: sampledAt }
    });
  }

  private async touchBindingSyncState(
    bindingId: string | undefined,
    uplinkBytes: bigint,
    downlinkBytes: bigint,
    sampledAt: Date
  ) {
    if (!bindingId) {
      return;
    }
    await this.prisma.panelClientBinding.update({
      where: { id: bindingId },
      data: {
        lastUplinkBytes: uplinkBytes,
        lastDownlinkBytes: downlinkBytes,
        lastSyncedAt: sampledAt
      }
    });
  }

  private async loadNodeSyncContext(nodeId: string, accessMode: "relay" | "xui" = "relay"): Promise<NodeSyncContext> {
    const subscriptionIds: string[] = [];
    const mappings = new Map<string, UsageMapping>();
    const leaseMappingsByUuid = new Map<string, UsageMapping>();
    if (accessMode === "xui") {
      const bindings = await this.prisma.panelClientBinding.findMany({
        where: {
          nodeId,
          status: "active"
        },
        select: {
          id: true,
          panelClientEmail: true,
          panelClientId: true,
          subscriptionId: true,
          userId: true,
          teamId: true,
          lastSyncedAt: true
        }
      });
      for (const binding of bindings) {
        subscriptionIds.push(binding.subscriptionId);
        mappings.set(binding.panelClientEmail.trim().toLowerCase(), {
          bindingId: binding.id,
          subscriptionId: binding.subscriptionId,
          teamId: binding.teamId,
          userId: binding.userId,
          bindingLastSyncedAt: binding.lastSyncedAt
        });
        leaseMappingsByUuid.set(binding.panelClientId, {
          bindingId: binding.id,
          subscriptionId: binding.subscriptionId,
          teamId: binding.teamId,
          userId: binding.userId,
          bindingLastSyncedAt: binding.lastSyncedAt
        });
      }
    } else {
      const activeLeases = await this.prisma.nodeSessionLease.findMany({
        where: {
          nodeId,
          status: "active",
          expiresAt: { gt: new Date() }
        },
        select: {
          xrayUserEmail: true,
          xrayUserUuid: true,
          subscriptionId: true,
          userId: true,
          subscription: {
            select: {
              teamId: true
            }
          }
        }
      });
      for (const lease of activeLeases) {
        subscriptionIds.push(lease.subscriptionId);
        mappings.set(lease.xrayUserEmail.trim().toLowerCase(), {
          subscriptionId: lease.subscriptionId,
          teamId: lease.subscription.teamId,
          userId: lease.userId
        });
        leaseMappingsByUuid.set(lease.xrayUserUuid, {
          subscriptionId: lease.subscriptionId,
          teamId: lease.subscription.teamId,
          userId: lease.userId
        });
      }
    }

    return {
      subscriptionIds: Array.from(new Set(subscriptionIds)),
      mappings,
      leaseMappingsByUuid,
      invalidMappings: []
    };
  }

  private async openIncidentForSubscriptions(
    subscriptionIds: string[],
    nodeId: string,
    reason: string,
    detail: string
  ) {
    await Promise.all(
      subscriptionIds.map((subscriptionId) => this.meteringIncidentService.open(subscriptionId, nodeId, reason, detail))
    );
  }

  private async resolveIncidentForSubscriptions(subscriptionIds: string[], nodeId: string, reason: string) {
    await Promise.all(
      subscriptionIds.map((subscriptionId) => this.meteringIncidentService.resolve(subscriptionId, nodeId, reason))
    );
  }

  private warnThrottled(nodeId: string, reason: string) {
    const key = `${nodeId}:${reason}`;
    const now = Date.now();
    const lastWarnedAt = this.warningTimestamps.get(key) ?? 0;
    if (now - lastWarnedAt < NODE_USAGE_WARN_INTERVAL_MS) {
      return;
    }
    this.warningTimestamps.set(key, now);
    this.logger.warn(`节点 ${nodeId} 用量同步异常: ${reason}`);
  }

  private async deactivatePanelClients(subscriptionId: string, nextStatus: "disabled" | "deleted" = "disabled") {
    const bindings = await this.prisma.panelClientBinding.findMany({
      where: {
        subscriptionId,
        status: "active"
      },
      include: {
        node: {
          select: {
            id: true,
            panelBaseUrl: true,
            panelApiBasePath: true,
            panelUsername: true,
            panelPassword: true,
            panelInboundId: true
          }
        }
      }
    });

    for (const binding of bindings) {
      try {
        await this.xuiService.setClientEnabled(
          {
            id: binding.node.id,
            panelBaseUrl: binding.node.panelBaseUrl,
            panelApiBasePath: binding.node.panelApiBasePath,
            panelUsername: binding.node.panelUsername,
            panelPassword: binding.node.panelPassword,
            panelInboundId: binding.node.panelInboundId
          },
          binding.panelClientId,
          binding.panelClientEmail,
          false
        );
      } catch (error) {
        await this.prisma.node.update({
          where: { id: binding.nodeId },
          data: {
            panelStatus: "degraded",
            panelError: error instanceof Error ? error.message : "禁用 3x-ui 客户端失败"
          }
        });
        // 这里不抛错，避免计量主链被节点面板异常打断，后续轮询会继续尝试修复。
        continue;
      }

      await this.prisma.panelClientBinding.update({
        where: { id: binding.id },
        data: {
          status: nextStatus
        }
      });
    }
  }

  private async revokeActiveLeases(subscriptionId: string, reason: string) {
    await this.prisma.nodeSessionLease.updateMany({
      where: {
        subscriptionId,
        status: "active"
      },
      data: {
        status: "revoked",
        revokedReason: reason,
        revokedAt: new Date()
      }
    });
  }
}

type NodeTrafficSample = {
  xrayUserEmail: string;
  xrayUserUuid?: string;
  uplinkBytes: bigint;
  downlinkBytes: bigint;
  sampledAt?: string;
};

type UsageMapping = {
  bindingId?: string;
  subscriptionId: string;
  teamId: string | null;
  userId: string | null;
  bindingLastSyncedAt?: Date | null;
};

type NodeSyncContext = {
  subscriptionIds: string[];
  mappings: Map<string, UsageMapping>;
  leaseMappingsByUuid: Map<string, UsageMapping>;
  invalidMappings: Array<{ subscriptionId: string; detail: string }>;
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

    const xrayUserEmail =
      readString(entry, "xrayUserEmail") ?? readString(entry, "userEmail") ?? readString(entry, "email");
    if (!xrayUserEmail) {
      return [];
    }

    return [
      {
        xrayUserEmail: xrayUserEmail.toLowerCase(),
        xrayUserUuid: readString(entry, "xrayUserUuid") ?? undefined,
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
    return target >= 0n ? target : 0n;
  }
  if (typeof target === "number" && Number.isFinite(target)) {
    return BigInt(Math.max(0, Math.trunc(target)));
  }
  if (typeof target === "string" && target.trim()) {
    try {
      return BigInt(target.trim());
    } catch {
      const fallback = Number(target.trim());
      if (Number.isFinite(fallback)) {
        return BigInt(Math.max(0, Math.trunc(fallback)));
      }
    }
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

function appendIssue(issueMap: Map<string, string[]>, subscriptionId: string, detail: string) {
  const next = issueMap.get(subscriptionId) ?? [];
  next.push(detail);
  issueMap.set(subscriptionId, next);
}
