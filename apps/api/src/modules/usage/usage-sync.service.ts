import { Injectable, Logger } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { Cron } from "@nestjs/schedule";
import { randomUUID } from "node:crypto";
import { Client as PgClient } from "pg";
import {
  METERING_REASON_COUNTER_ROLLBACK,
  METERING_REASON_MAPPING_MISSING,
  METERING_REASON_NODE_UNAVAILABLE,
  METERING_REASON_SAMPLE_MISSING
} from "../common/metering.constants";
import { ClientEventsPublisher } from "../common/client-events.publisher";
import { MeteringIncidentService } from "../common/metering-incident.service";
import { PrismaService } from "../common/prisma.service";
import { RuntimeSessionService } from "../common/runtime-session.service";
import { runWithSubscriptionUsageLock } from "../common/usage-lock.utils";
import { XuiService } from "../xui/xui.service";

const GB_IN_BYTES = 1024 ** 3;
const NODE_USAGE_STALE_SECONDS = Number(process.env.CHORDV_NODE_USAGE_STALE_SECONDS ?? 90);
const NODE_USAGE_WARN_INTERVAL_MS = Number(process.env.CHORDV_NODE_USAGE_WARN_INTERVAL_SECONDS ?? 600) * 1000;
const USAGE_SYNC_LOCK_KEY_1 = 420_701;
const USAGE_SYNC_LOCK_KEY_2 = 917_503;

@Injectable()
export class UsageSyncService {
  private readonly logger = new Logger(UsageSyncService.name);
  private readonly warningTimestamps = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly meteringIncidentService: MeteringIncidentService,
    private readonly clientEventsPublisher: ClientEventsPublisher,
    private readonly moduleRef: ModuleRef,
    private readonly xuiService: XuiService
  ) {}

  private getRuntimeSessionService() {
    const directRuntimeSessionService = (this as UsageSyncService & {
      runtimeSessionService?: RuntimeSessionService;
    }).runtimeSessionService;
    if (directRuntimeSessionService) {
      return directRuntimeSessionService;
    }
    return this.moduleRef.get(RuntimeSessionService, { strict: false });
  }

  @Cron("*/30 * * * * *")
  async syncNodeUsage() {
    const lockClient = new PgClient({
      connectionString: process.env.DATABASE_URL
    });
    let locked = false;

    try {
      await lockClient.connect();
      const result = await lockClient.query<{ locked: boolean }>(
        "select pg_try_advisory_lock($1, $2) as locked",
        [USAGE_SYNC_LOCK_KEY_1, USAGE_SYNC_LOCK_KEY_2]
      );
      locked = Boolean(result.rows[0]?.locked);
      if (!locked) {
        this.logger.debug("跳过本轮 3x-ui 流量同步，另一个实例正在执行");
        return;
      }
      await this.syncXuiUsage();
    } catch (error) {
      this.logger.warn(`3x-ui 流量同步锁执行失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (locked) {
        await lockClient.query("select pg_advisory_unlock($1, $2)", [USAGE_SYNC_LOCK_KEY_1, USAGE_SYNC_LOCK_KEY_2]).catch(() => undefined);
      }
      await lockClient.end().catch(() => undefined);
    }
  }

  private async syncXuiUsage() {
    const bindings = await this.prisma.panelClientBinding.findMany({
      where: {
        status: "active",
        NOT: {
          panelSyncJobs: {
            some: {
              action: "reset_client_traffic",
              status: { in: ["pending", "running", "failed"] }
            }
          }
        },
        subscription: {
          state: "active"
        },
        node: {
          panelEnabled: true,
          isActive: true
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

    const nodeMap = new Map<
      string,
      {
        nodeId: string;
        panelInboundId: number;
        bindings: typeof bindings;
      }
    >();
    for (const binding of bindings) {
      const groupKey = `${binding.nodeId}:${binding.panelInboundId}`;
      const current = nodeMap.get(groupKey);
      if (current) {
        current.bindings.push(binding);
      } else {
        nodeMap.set(groupKey, {
          nodeId: binding.nodeId,
          panelInboundId: binding.panelInboundId,
          bindings: [binding]
        });
      }
    }

    const nodeResults = new Map<
      string,
      {
        subscriptionIds: Set<string>;
        lastSuccessfulSyncAt: Date | null;
        errors: string[];
      }
    >();
    const readNodeResult = (nodeId: string) => {
      let result = nodeResults.get(nodeId);
      if (!result) {
        result = {
          subscriptionIds: new Set<string>(),
          lastSuccessfulSyncAt: null,
          errors: []
        };
        nodeResults.set(nodeId, result);
      }
      return result;
    };

    for (const { nodeId, panelInboundId, bindings: nodeBindings } of nodeMap.values()) {
      const subscriptionIds = Array.from(new Set(nodeBindings.map((item) => item.subscriptionId)));
      const nodeResult = readNodeResult(nodeId);
      for (const subscriptionId of subscriptionIds) {
        nodeResult.subscriptionIds.add(subscriptionId);
      }
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
          panelInboundId
        })).filter((item) => allowedEmails.has(item.xrayUserEmail.trim().toLowerCase()));
        const context = await this.loadNodeSyncContext(nodeId, panelInboundId);
        await this.applyNodeSamples(nodeId, records, context);
        nodeResult.lastSuccessfulSyncAt = new Date();
      } catch (error) {
        const detail = error instanceof Error ? error.message : "3x-ui 面板流量同步失败";
        this.warnThrottled(nodeId, detail);
        nodeResult.errors.push(detail);
        await this.openIncidentForSubscriptions(
          subscriptionIds,
          nodeId,
          METERING_REASON_NODE_UNAVAILABLE,
          `3x-ui 面板流量同步失败：${detail}`
        );
      }
    }

    for (const [nodeId, result] of nodeResults) {
      if (result.errors.length > 0) {
        await this.prisma.node.update({
          where: { id: nodeId },
          data: {
            panelStatus: "degraded",
            panelError: result.errors.join("; ")
          }
        });
        continue;
      }
      if (!result.lastSuccessfulSyncAt) {
        continue;
      }
      await this.prisma.node.update({
        where: { id: nodeId },
        data: {
          panelStatus: "online",
          panelError: null,
          panelLastSyncedAt: result.lastSuccessfulSyncAt,
          statsLastSyncedAt: result.lastSuccessfulSyncAt
        }
      });
      await this.resolveIncidentForSubscriptions(
        Array.from(result.subscriptionIds),
        nodeId,
        METERING_REASON_NODE_UNAVAILABLE
      );
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

      await runWithSubscriptionUsageLock(mapping.subscriptionId, async () => {
      const totalBytes = sample.uplinkBytes + sample.downlinkBytes;
      const snapshotKey = buildSnapshotKey(nodeId, mapping.subscriptionId, mapping.userId);
      const snapshot = await this.prisma.trafficSnapshot.findUnique({
        where: { snapshotKey }
      });

      const sampledAt = parseSampledAt(sample.sampledAt);
      if (!snapshot) {
        const previousTotalBytes = (mapping.bindingLastUplinkBytes ?? 0n) + (mapping.bindingLastDownlinkBytes ?? 0n);
        if (totalBytes < previousTotalBytes) {
          rollbackSubscriptions.add(mapping.subscriptionId);
          rollbackDetails.set(mapping.subscriptionId, `用户 ${normalizedEmail} 的累计流量计数发生回退`);
          await this.touchSubscriptionSyncState(mapping.subscriptionId, sampledAt);
          return;
        }

        const initialDeltaBytes = totalBytes - previousTotalBytes;
        if (initialDeltaBytes <= 0n) {
          await this.createTrafficSnapshot({
            snapshotKey,
            nodeId,
            subscriptionId: mapping.subscriptionId,
            teamId: mapping.teamId,
            userId: mapping.userId,
            uplinkBytes: sample.uplinkBytes,
            downlinkBytes: sample.downlinkBytes,
            totalBytes,
            sampledAt
          });
          await this.touchBindingSyncState(mapping.bindingId, sample.uplinkBytes, sample.downlinkBytes, sampledAt);
          await this.touchSubscriptionSyncState(mapping.subscriptionId, sampledAt);
          return;
        }

        await this.applyUsageDelta({
          nodeId,
          snapshotKey,
          snapshotMode: "create",
          subscriptionId: mapping.subscriptionId,
          teamId: mapping.teamId,
          userId: mapping.userId,
          bindingId: mapping.bindingId,
          uplinkBytes: sample.uplinkBytes,
          downlinkBytes: sample.downlinkBytes,
          totalBytes,
          deltaBytes: initialDeltaBytes,
          sampledAt,
          lockHeld: true
        });
        return;
      }

      if (sampledAt.getTime() < snapshot.sampledAt.getTime()) {
        return;
      }

      if (totalBytes < snapshot.totalBytes) {
        rollbackSubscriptions.add(mapping.subscriptionId);
        rollbackDetails.set(mapping.subscriptionId, `用户 ${normalizedEmail} 的累计流量计数发生回退`);
        await this.touchSubscriptionSyncState(mapping.subscriptionId, sampledAt);
        return;
      }

      const deltaBytes = totalBytes - snapshot.totalBytes;
      if (deltaBytes <= 0n) {
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
        await this.touchSubscriptionSyncState(mapping.subscriptionId, sampledAt);
        return;
      }

      await this.applyUsageDelta({
        nodeId,
        snapshotKey,
        snapshotMode: "update",
        subscriptionId: mapping.subscriptionId,
        teamId: mapping.teamId,
        userId: mapping.userId,
        bindingId: mapping.bindingId,
        uplinkBytes: sample.uplinkBytes,
        downlinkBytes: sample.downlinkBytes,
        totalBytes,
        deltaBytes,
        sampledAt,
        lockHeld: true
      });
      });
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

  private async applyUsageDelta(input: UsageDeltaInput) {
    const apply = async () => {
    const deltaGb = Number(input.deltaBytes) / GB_IN_BYTES;
    let nextState: "active" | "expired" | "exhausted" | "paused" | null = null;

    await this.prisma.$transaction(async (tx) => {
      const current = await tx.subscription.findUnique({
        where: { id: input.subscriptionId }
      });

      if (!current) {
        return;
      }

      const nextUsedTrafficGb = roundTrafficGb(current.usedTrafficGb + deltaGb);
      const nextRemainingTrafficGb = roundTrafficGb(Math.max(0, current.totalTrafficGb - nextUsedTrafficGb));
      nextState =
        current.state !== "active"
          ? current.state
          : current.expireAt.getTime() <= input.sampledAt.getTime()
          ? "expired"
          : nextRemainingTrafficGb <= 0
            ? "exhausted"
            : "active";

      const snapshotData = {
          uplinkBytes: input.uplinkBytes,
          downlinkBytes: input.downlinkBytes,
          totalBytes: input.totalBytes,
          sampledAt: input.sampledAt
      };
      if (input.snapshotMode === "create") {
        await tx.trafficSnapshot.upsert({
          where: { snapshotKey: input.snapshotKey },
          update: snapshotData,
          create: {
            id: randomUUID(),
            snapshotKey: input.snapshotKey,
            nodeId: input.nodeId,
            subscriptionId: input.subscriptionId,
            userId: input.userId,
            teamId: input.teamId,
            ...snapshotData
          }
        });
      } else {
        await tx.trafficSnapshot.update({
          where: { snapshotKey: input.snapshotKey },
          data: snapshotData
        });
      }

      if (input.bindingId) {
        await tx.panelClientBinding.updateMany({
          where: { id: input.bindingId },
          data: {
            lastUplinkBytes: input.uplinkBytes,
            lastDownlinkBytes: input.downlinkBytes,
            lastSyncedAt: input.sampledAt
          }
        });
      }

      await tx.subscription.update({
        where: { id: input.subscriptionId },
        data: {
          usedTrafficGb: nextUsedTrafficGb,
          remainingTrafficGb: nextRemainingTrafficGb,
          state: nextState,
          lastSyncedAt: input.sampledAt
        }
      });

      if (input.teamId && input.userId) {
        await tx.trafficLedger.create({
          data: {
            id: randomUUID(),
            teamId: input.teamId,
            userId: input.userId,
            subscriptionId: input.subscriptionId,
            nodeId: input.nodeId,
            usedTrafficGb: roundTrafficGb(deltaGb),
            recordedAt: input.sampledAt
          }
        });
      }
    });

    if (!nextState) {
      return;
    }

    if (nextState !== "active") {
      await this.markPanelBindingsDisabledBestEffort(input.subscriptionId);
      await this.revokeActiveLeasesBestEffort(
        input.subscriptionId,
        nextState === "expired"
          ? "subscription_expired"
          : nextState === "exhausted"
            ? "subscription_exhausted"
            : "subscription_paused"
      );
    }

    await this.publishSubscriptionUpdatedBestEffort({
      subscriptionId: input.subscriptionId,
      userId: input.userId,
      teamId: input.teamId,
      state: nextState
    });
    };
    if (input.lockHeld) {
      return apply();
    }
    return runWithSubscriptionUsageLock(input.subscriptionId, apply);
  }

  private async touchSubscriptionSyncState(subscriptionId: string, sampledAt: Date) {
    await this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: { lastSyncedAt: sampledAt }
    });
  }

  private async createTrafficSnapshot(input: {
    snapshotKey: string;
    nodeId: string;
    subscriptionId: string;
    teamId: string | null;
    userId: string | null;
    uplinkBytes: bigint;
    downlinkBytes: bigint;
    totalBytes: bigint;
    sampledAt: Date;
  }) {
    await this.prisma.trafficSnapshot.upsert({
      where: { snapshotKey: input.snapshotKey },
      update: {
        uplinkBytes: input.uplinkBytes,
        downlinkBytes: input.downlinkBytes,
        totalBytes: input.totalBytes,
        sampledAt: input.sampledAt
      },
      create: {
        id: randomUUID(),
        snapshotKey: input.snapshotKey,
        nodeId: input.nodeId,
        subscriptionId: input.subscriptionId,
        userId: input.userId,
        teamId: input.teamId,
        uplinkBytes: input.uplinkBytes,
        downlinkBytes: input.downlinkBytes,
        totalBytes: input.totalBytes,
        sampledAt: input.sampledAt
      }
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

  private async loadNodeSyncContext(nodeId: string, panelInboundId?: number): Promise<NodeSyncContext> {
    const subscriptionIds: string[] = [];
    const mappings = new Map<string, UsageMapping>();
    const leaseMappingsByUuid = new Map<string, UsageMapping>();
    const bindings = await this.prisma.panelClientBinding.findMany({
      where: {
        nodeId,
        ...(panelInboundId !== undefined ? { panelInboundId } : {}),
        status: "active",
        NOT: {
          panelSyncJobs: {
            some: {
              action: "reset_client_traffic",
              status: { in: ["pending", "running", "failed"] }
            }
          }
        }
      },
      select: {
        id: true,
        panelClientEmail: true,
        panelClientId: true,
        subscriptionId: true,
        userId: true,
        teamId: true,
        lastSyncedAt: true,
        lastUplinkBytes: true,
        lastDownlinkBytes: true
      }
    });
    for (const binding of bindings) {
      subscriptionIds.push(binding.subscriptionId);
      mappings.set(binding.panelClientEmail.trim().toLowerCase(), {
        bindingId: binding.id,
        subscriptionId: binding.subscriptionId,
        teamId: binding.teamId,
        userId: binding.userId,
        bindingLastUplinkBytes: binding.lastUplinkBytes,
        bindingLastDownlinkBytes: binding.lastDownlinkBytes,
        bindingLastSyncedAt: binding.lastSyncedAt
      });
      leaseMappingsByUuid.set(binding.panelClientId, {
        bindingId: binding.id,
        subscriptionId: binding.subscriptionId,
        teamId: binding.teamId,
        userId: binding.userId,
        bindingLastUplinkBytes: binding.lastUplinkBytes,
        bindingLastDownlinkBytes: binding.lastDownlinkBytes,
        bindingLastSyncedAt: binding.lastSyncedAt
      });
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

  private async revokeActiveLeases(subscriptionId: string, reason: string) {
    await this.getRuntimeSessionService().revokeSubscriptionLeases(subscriptionId, reason);
  }

  private async markPanelBindingsDisabledBestEffort(subscriptionId: string) {
    try {
      await this.getRuntimeSessionService().markPanelBindingsDisabledForSubscription(subscriptionId);
    } catch (error) {
      this.logger.warn(`Usage sync saved local subscription state, but panel disable queueing failed for ${subscriptionId}: ${readErrorMessage(error)}`);
    }
  }

  private async revokeActiveLeasesBestEffort(subscriptionId: string, reason: string) {
    try {
      await this.revokeActiveLeases(subscriptionId, reason);
    } catch (error) {
      this.logger.warn(`Usage sync saved local subscription state, but active lease revocation failed for ${subscriptionId}: ${readErrorMessage(error)}`);
    }
  }

  private async publishSubscriptionUpdatedBestEffort(input: {
    subscriptionId: string;
    userId: string | null;
    teamId: string | null;
    state: "active" | "expired" | "exhausted" | "paused";
  }) {
    try {
      await this.clientEventsPublisher.publishSubscriptionUpdated(input);
    } catch (error) {
      this.logger.warn(
        `Usage sync saved local subscription state, but subscription event publish failed for ${input.subscriptionId}: ${readErrorMessage(error)}`
      );
    }
  }
}

function readErrorMessage(error: unknown) {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : String(error);
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
  bindingLastUplinkBytes?: bigint | null;
  bindingLastDownlinkBytes?: bigint | null;
  bindingLastSyncedAt?: Date | null;
};

type UsageDeltaInput = {
  nodeId: string;
  snapshotKey: string;
  snapshotMode: "create" | "update";
  subscriptionId: string;
  teamId: string | null;
  userId: string | null;
  bindingId?: string;
  uplinkBytes: bigint;
  downlinkBytes: bigint;
  totalBytes: bigint;
  deltaBytes: bigint;
  sampledAt: Date;
  lockHeld?: boolean;
};

type NodeSyncContext = {
  subscriptionIds: string[];
  mappings: Map<string, UsageMapping>;
  leaseMappingsByUuid: Map<string, UsageMapping>;
  invalidMappings: Array<{ subscriptionId: string; detail: string }>;
};

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
