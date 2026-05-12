import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { METERING_NODE_UNAVAILABLE_GRACE_MS, METERING_REASON_NODE_UNAVAILABLE } from "./metering.constants";
import { PrismaService } from "./prisma.service";

@Injectable()
export class MeteringIncidentService {
  constructor(private readonly prisma: PrismaService) {}

  async getSubscriptionMeteringState(subscriptionId: string) {
    const activeLeases = await this.prisma.nodeSessionLease.findMany({
      where: {
        subscriptionId,
        status: "active",
        expiresAt: { gt: new Date() }
      },
      select: {
        nodeId: true
      }
    });

    const activeNodeIds = Array.from(new Set(activeLeases.map((lease) => lease.nodeId)));
    if (activeNodeIds.length === 0) {
      return {
        meteringStatus: "ok" as const,
        meteringMessage: null
      };
    }

    const incidents = await this.prisma.meteringIncident.findMany({
      where: {
        subscriptionId,
        status: "open",
        nodeId: { in: activeNodeIds }
      },
      orderBy: [{ openedAt: "desc" }, { createdAt: "desc" }]
    });

    if (incidents.length === 0) {
      return {
        meteringStatus: "ok" as const,
        meteringMessage: null
      };
    }

    const incident =
      incidents.find((item) => item.reason !== METERING_REASON_NODE_UNAVAILABLE) ??
      incidents.find(
        (item) =>
          item.reason === METERING_REASON_NODE_UNAVAILABLE &&
          Date.now() - Math.max(item.createdAt.getTime(), item.openedAt.getTime()) >= METERING_NODE_UNAVAILABLE_GRACE_MS
      ) ??
      null;

    if (!incident) {
      return {
        meteringStatus: "ok" as const,
        meteringMessage: null
      };
    }

    if (incident.reason === METERING_REASON_NODE_UNAVAILABLE) {
      return {
        meteringStatus: "degraded" as const,
        meteringMessage: "计量同步延迟，后台正在重试，请稍后查看"
      };
    }

    return {
      meteringStatus: "degraded" as const,
      meteringMessage: "流量统计正在校准，请稍后查看"
    };
  }

  async open(subscriptionId: string, nodeId: string, reason: string, detail?: string) {
    const existing = await this.prisma.meteringIncident.findFirst({
      where: {
        subscriptionId,
        nodeId,
        reason,
        status: "open"
      },
      orderBy: [{ openedAt: "desc" }, { createdAt: "desc" }]
    });

    if (existing) {
      await this.prisma.meteringIncident.update({
        where: { id: existing.id },
        data: {
          detail: detail?.trim() || existing.detail,
          openedAt: new Date()
        }
      });
      return;
    }

    await this.prisma.meteringIncident.create({
      data: {
        id: randomUUID(),
        subscriptionId,
        nodeId,
        reason,
        status: "open",
        detail: detail?.trim() || null,
        openedAt: new Date()
      }
    });
  }

  async resolve(subscriptionId: string, nodeId: string, reason: string) {
    await this.prisma.meteringIncident.updateMany({
      where: {
        subscriptionId,
        nodeId,
        reason,
        status: "open"
      },
      data: {
        status: "resolved",
        resolvedAt: new Date()
      }
    });
  }
}
