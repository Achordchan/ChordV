import { Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type {
  AdminAnnouncementRecordDto,
  AdminPolicyRecordDto,
  AnnouncementDto,
  CreateAnnouncementInputDto,
  MarkClientAnnouncementsReadInputDto,
  PolicyBundleDto,
  UpdateAnnouncementInputDto,
  UpdatePolicyInputDto
} from "@chordv/shared";
import { AuthSessionService } from "./auth-session.service";
import { ClientRuntimeEventsService } from "./client-runtime-events.service";
import { PrismaService } from "./prisma.service";

export function toAnnouncementDto(
  row: {
    id: string;
    title: string;
    body: string;
    level: "info" | "warning" | "success";
    publishedAt: Date;
    displayMode: "passive" | "modal_confirm" | "modal_countdown";
    countdownSeconds: number;
  },
  readState?: {
    passiveSeenAt: Date | null;
    acknowledgedAt: Date | null;
  } | null
): AnnouncementDto {
  const passiveSeenAt = readState?.passiveSeenAt ?? null;
  const acknowledgedAt = readState?.acknowledgedAt ?? null;
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    level: row.level,
    publishedAt: row.publishedAt.toISOString(),
    displayMode: row.displayMode,
    countdownSeconds: row.countdownSeconds,
    passiveSeenAt: passiveSeenAt?.toISOString() ?? null,
    acknowledgedAt: acknowledgedAt?.toISOString() ?? null,
    isUnread: row.displayMode === "passive" ? passiveSeenAt === null : acknowledgedAt === null
  };
}

@Injectable()
export class AnnouncementPolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authSessionService: AuthSessionService,
    private readonly clientRuntimeEventsService: ClientRuntimeEventsService
  ) {}

  async getPolicies(): Promise<PolicyBundleDto> {
    const profile = await this.prisma.policyProfile.findUnique({
      where: { id: "default" }
    });

    if (!profile) {
      throw new NotFoundException("策略配置不存在");
    }

    return {
      defaultMode: profile.defaultMode as PolicyBundleDto["defaultMode"],
      modes: profile.modes as PolicyBundleDto["modes"],
      features: {
        blockAds: profile.blockAds,
        chinaDirect: profile.chinaDirect,
        aiServicesProxy: profile.aiServicesProxy
      }
    };
  }

  async getAnnouncements(token?: string): Promise<AnnouncementDto[]> {
    const user = token ? await this.authSessionService.authenticateAccessToken(token) : null;
    if (!user) {
      const rows = await this.prisma.announcement.findMany({
        where: {
          isActive: true,
          publishedAt: { lte: new Date() }
        },
        orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }]
      });
      return rows.map((row) => toAnnouncementDto(row, null));
    }

    const rows = await this.prisma.announcement.findMany({
      where: {
        isActive: true,
        publishedAt: { lte: new Date() }
      },
      include: {
        readStates: {
          where: { userId: user.id },
          take: 1,
          select: {
            passiveSeenAt: true,
            acknowledgedAt: true
          }
        }
      },
      orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }]
    });

    return rows.map((row) => toAnnouncementDto(row, row.readStates[0] ?? null));
  }

  async markClientAnnouncementsRead(
    input: MarkClientAnnouncementsReadInputDto,
    token?: string
  ): Promise<{ ok: boolean; updatedIds: string[] }> {
    const user = await this.authSessionService.authenticateAccessToken(token);
    const announcementIds = Array.from(
      new Set((input.announcementIds ?? []).filter((item) => typeof item === "string" && item.trim().length > 0))
    );
    if (announcementIds.length === 0) {
      return { ok: true, updatedIds: [] };
    }

    const rows = await this.prisma.announcement.findMany({
      where: {
        id: { in: announcementIds },
        isActive: true,
        publishedAt: { lte: new Date() }
      },
      select: {
        id: true,
        displayMode: true
      }
    });

    const targetRows = input.action === "seen" ? rows.filter((item) => item.displayMode === "passive") : rows;
    if (targetRows.length === 0) {
      return { ok: true, updatedIds: [] };
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      for (const item of targetRows) {
        await tx.announcementReadState.upsert({
          where: {
            announcementId_userId: {
              announcementId: item.id,
              userId: user.id
            }
          },
          create: {
            id: createEntityId("announcement_state"),
            announcementId: item.id,
            userId: user.id,
            passiveSeenAt: input.action === "seen" ? now : null,
            acknowledgedAt: input.action === "ack" ? now : null
          },
          update: input.action === "seen" ? { passiveSeenAt: now } : { acknowledgedAt: now }
        });
      }
    });

    for (const item of targetRows) {
      this.clientRuntimeEventsService.publishToUser(user.id, {
        type: "announcement_read_state_updated",
        occurredAt: now.toISOString(),
        announcementId: item.id
      });
    }

    return {
      ok: true,
      updatedIds: targetRows.map((item) => item.id)
    };
  }

  async listAdminAnnouncements(): Promise<AdminAnnouncementRecordDto[]> {
    const rows = await this.prisma.announcement.findMany({
      orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }]
    });
    return rows.map(toAdminAnnouncementRecord);
  }

  async createAnnouncement(input: CreateAnnouncementInputDto): Promise<AdminAnnouncementRecordDto> {
    const displayMode = input.displayMode ?? "passive";
    const countdownSeconds = displayMode === "modal_countdown" ? Math.max(1, input.countdownSeconds ?? 5) : 0;
    const row = await this.prisma.announcement.create({
      data: {
        id: createEntityId("announcement"),
        title: input.title.trim(),
        body: input.body.trim(),
        level: input.level,
        publishedAt: input.publishedAt ? new Date(input.publishedAt) : new Date(),
        isActive: input.isActive ?? true,
        displayMode,
        countdownSeconds
      }
    });
    await this.publishAnnouncementUpdatedEvent(row.id);
    return toAdminAnnouncementRecord(row);
  }

  async updateAnnouncement(
    announcementId: string,
    input: UpdateAnnouncementInputDto
  ): Promise<AdminAnnouncementRecordDto> {
    const current = await this.prisma.announcement.findUnique({
      where: { id: announcementId }
    });
    if (!current) {
      throw new NotFoundException("公告不存在");
    }

    const displayMode = input.displayMode ?? current.displayMode;
    const countdownBase = input.countdownSeconds ?? current.countdownSeconds ?? 5;
    const countdownSeconds = displayMode === "modal_countdown" ? Math.max(1, countdownBase) : 0;
    const row = await this.prisma.announcement.update({
      where: { id: announcementId },
      data: {
        ...(input.title !== undefined ? { title: input.title.trim() } : {}),
        ...(input.body !== undefined ? { body: input.body.trim() } : {}),
        ...(input.level !== undefined ? { level: input.level } : {}),
        ...(input.publishedAt !== undefined ? { publishedAt: new Date(input.publishedAt) } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.displayMode !== undefined ? { displayMode } : {}),
        ...(input.displayMode !== undefined || input.countdownSeconds !== undefined ? { countdownSeconds } : {})
      }
    });
    await this.publishAnnouncementUpdatedEvent(row.id);
    return toAdminAnnouncementRecord(row);
  }

  async deleteAnnouncement(announcementId: string): Promise<{ ok: boolean; announcementId: string }> {
    const current = await this.prisma.announcement.findUnique({
      where: { id: announcementId },
      select: { id: true }
    });
    if (!current) {
      throw new NotFoundException("公告不存在");
    }

    await this.prisma.announcement.delete({
      where: { id: announcementId }
    });
    await this.publishAnnouncementUpdatedEvent(announcementId);

    return {
      ok: true,
      announcementId
    };
  }

  async getAdminPolicy(): Promise<AdminPolicyRecordDto> {
    const profile = await this.prisma.policyProfile.findUnique({
      where: { id: "default" }
    });
    if (!profile) {
      throw new NotFoundException("策略配置不存在");
    }
    return toAdminPolicyRecord(profile);
  }

  async updatePolicy(input: UpdatePolicyInputDto): Promise<AdminPolicyRecordDto> {
    await this.prisma.policyProfile.update({
      where: { id: "default" },
      data: {
        ...(input.accessMode !== undefined ? { accessMode: input.accessMode } : {}),
        ...(input.defaultMode !== undefined ? { defaultMode: input.defaultMode } : {}),
        ...(input.modes !== undefined ? { modes: input.modes } : {}),
        ...(input.blockAds !== undefined ? { blockAds: input.blockAds } : {}),
        ...(input.chinaDirect !== undefined ? { chinaDirect: input.chinaDirect } : {}),
        ...(input.aiServicesProxy !== undefined ? { aiServicesProxy: input.aiServicesProxy } : {})
      }
    });
    return this.getAdminPolicy();
  }

  private async publishAnnouncementUpdatedEvent(announcementId: string) {
    const rows = await this.prisma.user.findMany({
      where: { status: "active" },
      select: { id: true }
    });
    const userIds = Array.from(new Set(rows.map((row) => row.id)));
    this.clientRuntimeEventsService.publishToUsers(userIds, {
      type: "announcement_updated",
      occurredAt: new Date().toISOString(),
      announcementId
    });
  }
}

function createEntityId(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function toAdminAnnouncementRecord(row: {
  id: string;
  title: string;
  body: string;
  level: "info" | "warning" | "success";
  isActive: boolean;
  publishedAt: Date;
  displayMode: "passive" | "modal_confirm" | "modal_countdown";
  countdownSeconds: number;
  createdAt: Date;
  updatedAt: Date;
}): AdminAnnouncementRecordDto {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    level: row.level,
    isActive: row.isActive,
    publishedAt: row.publishedAt.toISOString(),
    displayMode: row.displayMode,
    countdownSeconds: row.countdownSeconds,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function toAdminPolicyRecord(row: {
  accessMode: string;
  defaultMode: string;
  modes: unknown;
  blockAds: boolean;
  chinaDirect: boolean;
  aiServicesProxy: boolean;
}): AdminPolicyRecordDto {
  return {
    accessMode: row.accessMode as AdminPolicyRecordDto["accessMode"],
    defaultMode: row.defaultMode as AdminPolicyRecordDto["defaultMode"],
    modes: row.modes as AdminPolicyRecordDto["modes"],
    features: {
      blockAds: row.blockAds,
      chinaDirect: row.chinaDirect,
      aiServicesProxy: row.aiServicesProxy
    }
  };
}
