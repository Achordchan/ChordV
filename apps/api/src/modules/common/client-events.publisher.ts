import { Injectable } from "@nestjs/common";
import type { PlatformTarget, ReleaseChannel, SubscriptionState, SupportTicketStatus } from "@chordv/shared";
import { ClientRuntimeEventsService } from "./client-runtime-events.service";
import { PrismaService } from "./prisma.service";
import { compareSemver, normalizeReleaseChannel } from "./release-center.utils";

@Injectable()
export class ClientEventsPublisher {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clientRuntimeEventsService: ClientRuntimeEventsService
  ) {}

  async listActiveUserIds(): Promise<string[]> {
    const rows = await this.prisma.user.findMany({
      where: { status: "active" },
      select: { id: true }
    });
    return rows.map((row) => row.id);
  }

  async resolveTargetUserIdsForSubscriptionTarget(target: {
    userId?: string | null;
    teamId?: string | null;
  }): Promise<string[]> {
    if (target.teamId) {
      const rows = await this.prisma.teamMember.findMany({
        where: { teamId: target.teamId },
        select: { userId: true }
      });
      return Array.from(new Set(rows.map((row) => row.userId)));
    }
    return target.userId ? [target.userId] : [];
  }

  publishClientEventToUsers(userIds: Iterable<string>, event: Parameters<ClientRuntimeEventsService["publishToUsers"]>[1]) {
    this.clientRuntimeEventsService.publishToUsers(userIds, event);
  }

  async publishAnnouncementUpdated(announcementId: string) {
    const userIds = await this.listActiveUserIds();
    this.publishClientEventToUsers(userIds, {
      type: "announcement_updated",
      occurredAt: new Date().toISOString(),
      announcementId
    });
  }

  publishAnnouncementReadStateUpdated(userId: string, announcementId: string) {
    this.clientRuntimeEventsService.publishToUser(userId, {
      type: "announcement_read_state_updated",
      occurredAt: new Date().toISOString(),
      announcementId
    });
  }

  publishTicketEvent(
    userId: string,
    ticketId: string,
    ticketStatus: SupportTicketStatus,
    type: "ticket_updated" | "ticket_read_state_updated" = "ticket_updated"
  ) {
    this.clientRuntimeEventsService.publishToUser(userId, {
      type,
      occurredAt: new Date().toISOString(),
      ticketId,
      ticketStatus
    });
  }

  async publishVersionUpdated(
    platform?: PlatformTarget | null,
    channel: ReleaseChannel = "stable",
    latestVersion?: string | null
  ) {
    const resolvedLatestVersion =
      latestVersion === undefined && platform
        ? (await this.findLatestPublishedVersion(channel, platform)) ?? null
        : latestVersion ?? null;
    const userIds = await this.listActiveUserIds();
    this.publishClientEventToUsers(userIds, {
      type: "version_updated",
      occurredAt: new Date().toISOString(),
      platform: platform ?? null,
      channel,
      latestVersion: resolvedLatestVersion
    });
  }

  async publishSubscriptionUpdated(target: {
    subscriptionId?: string | null;
    userId?: string | null;
    teamId?: string | null;
    state?: SubscriptionState | null;
  }) {
    const userIds = await this.resolveTargetUserIdsForSubscriptionTarget(target);
    this.publishClientEventToUsers(userIds, {
      type: "subscription_updated",
      occurredAt: new Date().toISOString(),
      subscriptionId: target.subscriptionId ?? null,
      subscriptionState: target.state ?? null,
      state: target.state ?? null
    });
  }

  async publishNodeAccessUpdated(target: {
    subscriptionId?: string | null;
    userId?: string | null;
    teamId?: string | null;
  }) {
    const userIds = await this.resolveTargetUserIdsForSubscriptionTarget(target);
    this.publishClientEventToUsers(userIds, {
      type: "node_access_updated",
      occurredAt: new Date().toISOString(),
      subscriptionId: target.subscriptionId ?? null
    });
  }

  private async findLatestPublishedVersion(channel: ReleaseChannel, platform: PlatformTarget) {
    const rows = await this.prisma.release.findMany({
      where: {
        channel: normalizeReleaseChannel(channel),
        status: "published",
        platform
      },
      select: {
        version: true,
        publishedAt: true
      }
    });

    if (rows.length === 0) {
      return null;
    }

    return rows.sort((left, right) => {
      const versionDiff = compareSemver(right.version, left.version);
      if (versionDiff !== 0) {
        return versionDiff;
      }
      return (right.publishedAt?.getTime() ?? 0) - (left.publishedAt?.getTime() ?? 0);
    })[0]?.version ?? null;
  }
}
