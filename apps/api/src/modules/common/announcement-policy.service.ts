import { workLifecycle } from "../../work-lifecycle";
import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type {
  AdminAnnouncementRecordDto,
  AdminPolicyRecordDto,
  AnnouncementDto,
  ConnectionMode,
  CreateAnnouncementInputDto,
  MarkClientAnnouncementsReadInputDto,
  PolicyBundleDto,
  UpdateAnnouncementInputDto,
  UpdatePolicyInputDto
} from "@chordv/shared";
import { AuthSessionService } from "./auth-session.service";
import { AdminRuntimeEventsService } from "./admin-runtime-events.service";
import { ClientRuntimeEventsService } from "./client-runtime-events.service";
import { PrismaService } from "./prisma.service";
import { throwLocalReadAsServiceUnavailable, throwLocalSaveAsServiceUnavailable } from "./prisma-error.utils";

const EVENT_PUBLISH_BUDGET_MS = 300;

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

type AnnouncementDtoRow = Parameters<typeof toAnnouncementDto>[0];
type AnnouncementReadStateRow = NonNullable<Parameters<typeof toAnnouncementDto>[1]>;
type AnnouncementDtoRowWithReadState = AnnouncementDtoRow & {
  readStates: AnnouncementReadStateRow[];
};

@Injectable()
export class AnnouncementPolicyService {
  private readonly logger = new Logger(AnnouncementPolicyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authSessionService: AuthSessionService,
    private readonly clientRuntimeEventsService: ClientRuntimeEventsService,
    private readonly adminRuntimeEventsService: AdminRuntimeEventsService
  ) {}

  async getPolicies(): Promise<PolicyBundleDto> {
    let profile: Awaited<ReturnType<PrismaService["policyProfile"]["findUnique"]>>;
    try {
      profile = await this.prisma.policyProfile.findUnique({
        where: { id: "default" }
      });
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "策略配置读取失败，请稍后重试。");
    }

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
      },
      customRoutingRules: []
    };
  }

  async getAnnouncements(token?: string): Promise<AnnouncementDto[]> {
    const user = token ? await this.authSessionService.authenticateAccessToken(token) : null;
    if (!user) {
      let rows: Awaited<ReturnType<PrismaService["announcement"]["findMany"]>>;
      try {
        rows = await this.prisma.announcement.findMany({
          where: {
            isActive: true,
            publishedAt: { lte: new Date() }
          },
          orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }]
        });
      } catch (error) {
        throwLocalReadAsServiceUnavailable(error, "公告列表读取失败，请稍后重试。");
      }
      return rows.map((row) => toAnnouncementDto(row, null));
    }

    let rows: AnnouncementDtoRowWithReadState[];
    try {
      rows = await this.prisma.announcement.findMany({
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
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "公告列表读取失败，请稍后重试。");
    }

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

    let rows: Array<{ id: string; displayMode: "passive" | "modal_confirm" | "modal_countdown" }>;
    try {
      rows = await this.prisma.announcement.findMany({
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
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "公告状态读取失败，请稍后重试。");
    }

    const targetRows = input.action === "seen" ? rows.filter((item) => item.displayMode === "passive") : rows;
    if (targetRows.length === 0) {
      return { ok: true, updatedIds: [] };
    }

    const now = new Date();
    try {
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
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "公告已读状态保存失败，请稍后重试。");
    }

    for (const item of targetRows) {
      this.publishAnnouncementReadStateUpdatedBestEffort(user.id, item.id, now);
    }

    return {
      ok: true,
      updatedIds: targetRows.map((item) => item.id)
    };
  }

  async listAdminAnnouncements(): Promise<AdminAnnouncementRecordDto[]> {
    let rows: Awaited<ReturnType<PrismaService["announcement"]["findMany"]>>;
    try {
      rows = await this.prisma.announcement.findMany({
        orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }]
      });
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "公告列表读取失败，请刷新后重试。");
    }
    return rows.map(toAdminAnnouncementRecord);
  }

  async createAnnouncement(input: CreateAnnouncementInputDto): Promise<AdminAnnouncementRecordDto> {
    const title = normalizeRequiredText(input.title, "title");
    const body = normalizeRequiredText(input.body, "body");
    const displayMode = input.displayMode ?? "passive";
    const countdownSeconds = displayMode === "modal_countdown" ? normalizeCountdownSeconds(input.countdownSeconds ?? 5) : 0;
    let row: Awaited<ReturnType<PrismaService["announcement"]["create"]>>;
    try {
      row = await this.prisma.announcement.create({
        data: {
          id: createEntityId("announcement"),
          title,
          body,
          level: input.level,
          publishedAt: input.publishedAt ? new Date(input.publishedAt) : new Date(),
          isActive: input.isActive ?? true,
          displayMode,
          countdownSeconds
        }
      });
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "公告保存失败，请刷新后重试。");
    }
    this.publishAnnouncementUpdatedEventInBackground(row.id);
    return toAdminAnnouncementRecord(row);
  }

  async updateAnnouncement(
    announcementId: string,
    input: UpdateAnnouncementInputDto
  ): Promise<AdminAnnouncementRecordDto> {
    let current: Awaited<ReturnType<PrismaService["announcement"]["findUnique"]>>;
    try {
      current = await this.prisma.announcement.findUnique({
        where: { id: announcementId }
      });
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "公告读取失败，请刷新后重试。");
    }
    if (!current) {
      throw new NotFoundException("公告不存在");
    }

    const displayMode = input.displayMode ?? current.displayMode;
    const countdownBase =
      input.countdownSeconds ??
      (displayMode === "modal_countdown" && current.countdownSeconds < 1 ? 5 : current.countdownSeconds) ??
      5;
    const countdownSeconds = displayMode === "modal_countdown" ? normalizeCountdownSeconds(countdownBase) : 0;
    const title = input.title !== undefined ? normalizeRequiredText(input.title, "title") : undefined;
    const body = input.body !== undefined ? normalizeRequiredText(input.body, "body") : undefined;
    let row: Awaited<ReturnType<PrismaService["announcement"]["update"]>>;
    try {
      row = await this.prisma.announcement.update({
        where: { id: announcementId },
        data: {
          ...(title !== undefined ? { title } : {}),
          ...(body !== undefined ? { body } : {}),
          ...(input.level !== undefined ? { level: input.level } : {}),
          ...(input.publishedAt !== undefined ? { publishedAt: new Date(input.publishedAt) } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          ...(input.displayMode !== undefined ? { displayMode } : {}),
          ...(input.displayMode !== undefined || input.countdownSeconds !== undefined ? { countdownSeconds } : {})
        }
      });
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "公告保存失败，请刷新后重试。");
    }
    this.publishAnnouncementUpdatedEventInBackground(row.id);
    return toAdminAnnouncementRecord(row);
  }

  async deleteAnnouncement(announcementId: string): Promise<{ ok: boolean; announcementId: string }> {
    let current: { id: string } | null;
    try {
      current = await this.prisma.announcement.findUnique({
        where: { id: announcementId },
        select: { id: true }
      });
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "公告读取失败，请刷新后重试。");
    }
    if (!current) {
      throw new NotFoundException("公告不存在");
    }

    try {
      await this.prisma.announcement.delete({
        where: { id: announcementId }
      });
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "公告删除失败，请刷新后重试。");
    }
    this.publishAnnouncementUpdatedEventInBackground(announcementId);

    return {
      ok: true,
      announcementId
    };
  }

  async getAdminPolicy(): Promise<AdminPolicyRecordDto> {
    let profile: Awaited<ReturnType<PrismaService["policyProfile"]["findUnique"]>>;
    try {
      profile = await this.prisma.policyProfile.findUnique({
        where: { id: "default" }
      });
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "策略配置读取失败，请刷新后重试。");
    }
    if (!profile) {
      throw new NotFoundException("策略配置不存在");
    }
    return toAdminPolicyRecord(profile);
  }

  async updatePolicy(input: UpdatePolicyInputDto): Promise<AdminPolicyRecordDto> {
    let current: Awaited<ReturnType<PrismaService["policyProfile"]["findUnique"]>>;
    try {
      current = await this.prisma.policyProfile.findUnique({
        where: { id: "default" }
      });
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "策略配置读取失败，请刷新后重试。");
    }
    if (!current) {
      throw new NotFoundException("策略配置不存在");
    }
    const nextModes = input.modes !== undefined ? normalizePolicyModes(input.modes) : normalizeExistingPolicyModes(current.modes);
    const nextDefaultMode = input.defaultMode ?? (current.defaultMode as ConnectionMode);
    if (!nextModes.includes(nextDefaultMode)) {
      throw new BadRequestException("默认模式必须包含在可用模式中");
    }

    const data = {
      ...(input.defaultMode !== undefined ? { defaultMode: input.defaultMode } : {}),
      ...(input.modes !== undefined ? { modes: nextModes } : {}),
      ...(input.blockAds !== undefined ? { blockAds: input.blockAds } : {}),
      ...(input.chinaDirect !== undefined ? { chinaDirect: input.chinaDirect } : {}),
      ...(input.aiServicesProxy !== undefined ? { aiServicesProxy: input.aiServicesProxy } : {})
    };
    let updated: Awaited<ReturnType<PrismaService["policyProfile"]["update"]>>;
    try {
      updated = await this.prisma.policyProfile.update({
        where: { id: "default" },
        data
      });
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "策略配置保存失败，请刷新后重试。");
    }
    this.publishPolicyUpdatedEventInBackground();
    return toAdminPolicyRecord(updated ?? { ...current, ...data });
  }

  private publishPolicyUpdatedEventInBackground() {
    this.startPublishEventInBackground("policy_updated", () => this.publishPolicyUpdatedEvent());
  }

  private publishAnnouncementUpdatedEventInBackground(announcementId: string) {
    this.startPublishEventInBackground("announcement_updated", () => this.publishAnnouncementUpdatedEvent(announcementId));
  }

  private startPublishEventInBackground(eventType: string, task: () => Promise<unknown>) {
    const timer = workLifecycle.defer(() => {
      return task().catch((error) => {
        this.logger.warn(`Local change saved, but background ${eventType} publish failed: ${readErrorMessage(error)}`);
      });
    }, 0);
    timer.unref?.();
  }

  private async publishPolicyUpdatedEvent() {
    const occurredAt = new Date().toISOString();
    await this.runPublishEventBestEffort("admin policy_updated", async () => {
      this.adminRuntimeEventsService.publish({
        type: "policy_updated",
        occurredAt
      });
    });
    await this.runPublishEventBestEffort("client policy_updated", async () => {
      const rows = await this.prisma.user.findMany({
        where: { status: "active" },
        select: { id: true }
      });
      const userIds = Array.from(new Set(rows.map((row) => row.id)));
      this.clientRuntimeEventsService.publishToUsers(userIds, {
        type: "policy_updated",
        occurredAt
      });
    });
  }

  private async publishAnnouncementUpdatedEvent(announcementId: string) {
    const occurredAt = new Date().toISOString();
    await this.runPublishEventBestEffort("admin announcement_updated", async () => {
      this.adminRuntimeEventsService.publish({
        type: "announcement_updated",
        occurredAt,
        announcementId
      });
    });
    await this.runPublishEventBestEffort("client announcement_updated", async () => {
      const rows = await this.prisma.user.findMany({
        where: { status: "active" },
        select: { id: true }
      });
      const userIds = Array.from(new Set(rows.map((row) => row.id)));
      this.clientRuntimeEventsService.publishToUsers(userIds, {
        type: "announcement_updated",
        occurredAt,
        announcementId
      });
    });
  }

  private publishAnnouncementReadStateUpdatedBestEffort(userId: string, announcementId: string, occurredAt: Date) {
    try {
      this.clientRuntimeEventsService.publishToUser(userId, {
        type: "announcement_read_state_updated",
        occurredAt: occurredAt.toISOString(),
        announcementId
      });
    } catch (error) {
      this.logger.warn(
        `Local announcement read state saved, but announcement_read_state_updated publish failed for ${userId}: ${readErrorMessage(error)}`
      );
    }
  }

  private async runPublishEventBestEffort(eventType: string, task: () => Promise<unknown>) {
    let settled = false;
    const guardedTask = Promise.resolve()
      .then(task)
      .then(
        () => {
          settled = true;
        },
        (error) => {
          settled = true;
          throw error;
        }
      );
    void guardedTask.catch((error) => {
      this.logger.warn(`Local change saved, but delayed ${eventType} publish failed: ${readErrorMessage(error)}`);
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutTask = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        this.logger.warn(
          `Local change saved, but ${eventType} publish exceeded ${EVENT_PUBLISH_BUDGET_MS}ms and will continue in background.`
        );
        resolve();
      }, EVENT_PUBLISH_BUDGET_MS);
    });

    try {
      await Promise.race([workLifecycle.track(guardedTask), timeoutTask]);
    } catch (error) {
      this.logger.warn(`Local change saved, but ${eventType} publish failed: ${readErrorMessage(error)}`);
    } finally {
      if (settled && timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}

function readErrorMessage(error: unknown) {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : String(error);
}

function createEntityId(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function normalizeRequiredText(value: string, fieldName: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new BadRequestException(`${fieldName} must not be empty.`);
  }
  return trimmed;
}

function normalizeCountdownSeconds(value: number) {
  if (!Number.isInteger(value) || value < 1) {
    throw new BadRequestException("countdownSeconds must be a positive integer.");
  }
  return value;
}

function normalizePolicyModes(value: unknown): ConnectionMode[] {
  if (!Array.isArray(value)) {
    throw new BadRequestException("modes must be an array.");
  }
  const deduped = Array.from(new Set(value));
  if (deduped.length !== value.length) {
    throw new BadRequestException("modes must not contain duplicates.");
  }
  if (deduped.length === 0 || deduped.length > 3) {
    throw new BadRequestException("modes must contain between 1 and 3 entries.");
  }
  for (const mode of deduped) {
    if (mode !== "global" && mode !== "rule" && mode !== "direct") {
      throw new BadRequestException("modes contains an invalid connection mode.");
    }
  }
  return deduped as ConnectionMode[];
}

function normalizeExistingPolicyModes(value: unknown): ConnectionMode[] {
  if (!Array.isArray(value)) {
    throw new BadRequestException("modes must be an array.");
  }
  const modes = value.filter((mode): mode is ConnectionMode => mode === "global" || mode === "rule" || mode === "direct");
  const deduped = Array.from(new Set(modes));
  return deduped.length > 0 ? deduped : ["rule"];
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
  defaultMode: string;
  modes: unknown;
  blockAds: boolean;
  chinaDirect: boolean;
  aiServicesProxy: boolean;
}): AdminPolicyRecordDto {
  return {
    defaultMode: row.defaultMode as AdminPolicyRecordDto["defaultMode"],
    modes: row.modes as AdminPolicyRecordDto["modes"],
    features: {
      blockAds: row.blockAds,
      chinaDirect: row.chinaDirect,
      aiServicesProxy: row.aiServicesProxy
    },
    customRoutingRules: []
  };
}
