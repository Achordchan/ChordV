import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "./prisma.service";

@Injectable()
export class MeteringIncidentService {
  constructor(private readonly prisma: PrismaService) {}

  async getSubscriptionMeteringState(subscriptionId: string) {
    const activeLeaseCount = await this.prisma.nodeSessionLease.count({
      where: {
        subscriptionId,
        status: "active",
        expiresAt: { gt: new Date() }
      }
    });

    if (activeLeaseCount === 0) {
      return {
        meteringStatus: "ok" as const,
        meteringMessage: null
      };
    }

    const incidents = await this.prisma.meteringIncident.findMany({
      where: {
        subscriptionId,
        status: "open"
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
      incidents.find((item) => item.reason !== "NODE_METERING_UNAVAILABLE") ??
      (activeLeaseCount > 0 ? incidents[0] : null);

    if (!incident) {
      return {
        meteringStatus: "ok" as const,
        meteringMessage: null
      };
    }

    return {
      meteringStatus: "degraded" as const,
      meteringMessage: incident.detail?.trim() || "计费待同步，请联系服务商检查节点状态"
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
