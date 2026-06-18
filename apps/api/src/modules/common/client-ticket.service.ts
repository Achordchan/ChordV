import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type {
  ClientSupportTicketDetailDto,
  ClientSupportTicketSummaryDto,
  CreateClientSupportTicketInputDto,
  ReplyClientSupportTicketInputDto,
  TeamMemberRole
} from "@chordv/shared";
import { AuthSessionService } from "./auth-session.service";
import { AdminRuntimeEventsService } from "./admin-runtime-events.service";
import { ClientRuntimeEventsService } from "./client-runtime-events.service";
import { ImageBedService, type UploadedTicketAttachmentFile } from "./image-bed.service";
import { throwLocalReadAsServiceUnavailable, throwLocalSaveAsServiceUnavailable } from "./prisma-error.utils";
import { PrismaService } from "./prisma.service";
import { createId } from "./release-center.utils";
import { pickCurrentSubscription } from "./subscription.utils";
import {
  hasUnreadTicketMessages,
  readSupportTicketAuthorDisplayName,
  summarizeSupportTicketMessage,
  toSupportTicketAttachmentDto,
  toClientSupportTicketDetail,
  toClientSupportTicketSummary
} from "./ticket.utils";

type ClientSubscriptionAccess = {
  subscription: {
    id: string;
    plan: { maxConcurrentSessions: number };
    user: { id: string; status: "active" | "disabled" } | null;
    team: { id: string; name: string; status: "active" | "disabled" } | null;
  } | null;
  team: { id: string; name: string; status: "active" | "disabled" } | null;
  memberRole: TeamMemberRole | null;
  memberUsedTrafficGb: number | null;
};

const TICKET_DETAIL_REFRESH_BUDGET_MS = 300;
const TICKET_ATTACHMENT_UPLOAD_BUDGET_MS = readPositiveIntegerEnv("CHORDV_TICKET_ATTACHMENT_UPLOAD_TIMEOUT_MS", 12_000);

@Injectable()
export class ClientTicketService {
  private readonly logger = new Logger(ClientTicketService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authSessionService: AuthSessionService,
    private readonly adminRuntimeEventsService: AdminRuntimeEventsService,
    private readonly clientRuntimeEventsService: ClientRuntimeEventsService,
    private readonly imageBedService: ImageBedService
  ) {}

  async getClientSupportTicketInbox(userId: string) {
    try {
      const rows = await this.prisma.supportTicket.findMany({
        where: { userId },
        select: {
          id: true,
          readStates: {
            where: { userId },
            select: { lastReadAt: true, lastReadMessageAt: true },
            take: 1
          }
        }
      });

      const latestAdminMessageMap = await this.loadLatestAdminTicketMessageMap(rows.map((item) => item.id));
      const unreadCount = rows.filter((row) =>
        hasUnreadTicketMessages(latestAdminMessageMap.get(row.id) ?? null, row.readStates[0] ?? null)
      ).length;

      return {
        totalCount: rows.length,
        unreadCount
      };
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "Support ticket inbox is temporarily unavailable.");
    }
  }

  async listClientSupportTickets(token?: string): Promise<ClientSupportTicketSummaryDto[]> {
    const user = await this.authSessionService.authenticateAccessToken(token);
    try {
      const rows = await this.prisma.supportTicket.findMany({
        where: { userId: user.id },
        include: {
          team: {
            select: { id: true, name: true }
          },
          messages: {
            select: { body: true, createdAt: true },
            orderBy: { createdAt: "desc" },
            take: 1
          },
          readStates: {
            where: { userId: user.id },
            select: { lastReadAt: true, lastReadMessageAt: true },
            take: 1
          }
        },
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }]
      });

      const latestAdminMessageMap = await this.loadLatestAdminTicketMessageMap(rows.map((item) => item.id));
      return rows.map((row) => toClientSupportTicketSummary(row, latestAdminMessageMap.get(row.id) ?? null));
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "Support ticket list is temporarily unavailable.");
    }
  }

  async getClientSupportTicketDetail(ticketId: string, token?: string): Promise<ClientSupportTicketDetailDto> {
    const user = await this.authSessionService.authenticateAccessToken(token);
    const row = await this.requireClientSupportTicketDetail(ticketId, user.id);
    return toClientSupportTicketDetail(row);
  }

  async markClientSupportTicketRead(
    ticketId: string,
    token?: string
  ): Promise<{ ok: boolean; ticketId: string; lastReadAt: string }> {
    const user = await this.authSessionService.authenticateAccessToken(token);
    let row: { id: string; messages: Array<{ createdAt: Date }> } | null;
    try {
      row = await this.prisma.supportTicket.findFirst({
        where: {
          id: ticketId,
          userId: user.id
        },
        select: {
          id: true,
          messages: {
            where: { authorRole: "admin" },
            select: { createdAt: true },
            orderBy: { createdAt: "desc" },
            take: 1
          }
        }
      });
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "Support ticket read state is temporarily unavailable.");
    }

    if (!row) {
      throw new NotFoundException("工单不存在");
    }

    const now = new Date();
    try {
      await this.prisma.supportTicketReadState.upsert({
        where: {
          ticketId_userId: {
            ticketId: row.id,
            userId: user.id
          }
        },
        create: {
          id: createId("ticket_read"),
          ticketId: row.id,
          userId: user.id,
          lastReadMessageAt: row.messages[0]?.createdAt ?? null,
          lastReadAt: now
        },
        update: {
          lastReadMessageAt: row.messages[0]?.createdAt ?? null,
          lastReadAt: now
        }
      });
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "工单已读状态保存失败，请刷新后重试。");
    }

    this.publishTicketEventBestEffort(user.id, {
      type: "ticket_read_state_updated",
      occurredAt: now.toISOString(),
      ticketId: row.id
    });

    return {
      ok: true,
      ticketId: row.id,
      lastReadAt: now.toISOString()
    };
  }

  async createClientSupportTicket(
    input: CreateClientSupportTicketInputDto,
    token?: string
  ): Promise<ClientSupportTicketDetailDto> {
    const user = await this.authSessionService.authenticateAccessToken(token);
    const access = await this.resolveSubscriptionAccessForUser(user.id);
    const title = input.title.trim();
    const body = input.body.trim();

    if (!title) {
      throw new BadRequestException("工单标题不能为空");
    }
    if (!body) {
      throw new BadRequestException("工单内容不能为空");
    }

    const now = new Date();
    const ticketId = createId("ticket");
    const messageId = createId("ticket_msg");
    try {
      await this.prisma.supportTicket.create({
        data: {
          id: ticketId,
          userId: user.id,
          subscriptionId: access.subscription?.id ?? null,
          teamId: access.team?.id ?? null,
          title,
          status: "waiting_admin",
          source: "desktop",
          lastMessageAt: now,
          readStates: {
            create: {
              id: createId("ticket_read"),
              userId: user.id,
              lastReadMessageAt: now,
              lastReadAt: now
            }
          },
          messages: {
            create: {
              id: messageId,
              authorRole: "user",
              authorUserId: user.id,
              body
            }
          }
        }
      });
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "工单保存失败，请刷新后重试。");
    }

    this.publishTicketEventBestEffort(user.id, {
      type: "ticket_updated",
      occurredAt: now.toISOString(),
      ticketId,
      ticketStatus: "waiting_admin"
    });

    return this.getClientSupportTicketDetailAfterWrite(ticketId, token, () =>
      this.buildClientSupportTicketWriteFallback(
        {
          id: ticketId,
          title,
          subscriptionId: access.subscription?.id ?? null,
          teamId: access.team?.id ?? null,
          teamName: access.team?.name ?? null,
          closedAt: null,
          createdAt: now
        },
        now,
        {
          messageId,
          body,
          attachments: []
        }
      )
    );
  }

  async replyClientSupportTicket(
    ticketId: string,
    input: ReplyClientSupportTicketInputDto,
    token?: string
  ): Promise<ClientSupportTicketDetailDto> {
    const user = await this.authSessionService.authenticateAccessToken(token);
    const body = input.body.trim();
    if (!body) {
      throw new BadRequestException("回复内容不能为空");
    }

    let current: any;
    try {
      current = await this.prisma.supportTicket.findFirst({
        where: { id: ticketId, userId: user.id },
        select: {
          id: true,
          title: true,
          status: true,
          source: true,
          subscriptionId: true,
          teamId: true,
          lastMessageAt: true,
          closedAt: true,
          createdAt: true,
          updatedAt: true,
          team: { select: { name: true } },
          messages: {
            include: {
              authorUser: { select: { displayName: true } },
              attachments: { orderBy: { createdAt: "asc" } }
            },
            orderBy: { createdAt: "asc" }
          },
          readStates: {
            where: { userId: user.id },
            select: { lastReadAt: true, lastReadMessageAt: true },
            take: 1
          },
        }
      });
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "Support ticket detail is temporarily unavailable.");
    }
    if (!current) {
      throw new NotFoundException("工单不存在");
    }
    if (current.status === "closed") {
      throw new BadRequestException("当前工单已关闭，请等待管理员重新打开。");
    }

    const now = new Date();
    const messageId = createId("ticket_msg");
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.supportTicketMessage.create({
          data: {
            id: messageId,
            ticketId,
            authorRole: "user",
            authorUserId: user.id,
            body
          }
        });
        await tx.supportTicket.update({
          where: { id: ticketId },
          data: {
            status: "waiting_admin",
            lastMessageAt: now,
            closedAt: null
          }
        });
        await tx.supportTicketReadState.upsert({
          where: {
            ticketId_userId: {
              ticketId,
              userId: user.id
            }
          },
          create: {
            id: createId("ticket_read"),
            ticketId,
            userId: user.id,
            lastReadMessageAt: now,
            lastReadAt: now
          },
          update: {
            lastReadMessageAt: now,
            lastReadAt: now
          }
        });
      });
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "工单回复保存失败，请刷新后重试。");
    }

    this.publishTicketEventBestEffort(user.id, {
      type: "ticket_updated",
      occurredAt: now.toISOString(),
      ticketId,
      ticketStatus: "waiting_admin"
    });

    return this.getClientSupportTicketDetailAfterWrite(ticketId, token, () =>
      this.buildClientSupportTicketWriteFallback(current, now, {
        messageId,
        body,
        attachments: []
      })
    );
  }

  async replyClientSupportTicketWithAttachment(
    ticketId: string,
    input: { body?: string | null },
    file: UploadedTicketAttachmentFile | undefined,
    token?: string
  ): Promise<ClientSupportTicketDetailDto> {
    const user = await this.authSessionService.authenticateAccessToken(token);
    const body = input.body?.trim() ?? "";
    if (!body && !file) {
      throw new BadRequestException("回复内容或附件不能为空");
    }
    if (body.length > 4000) {
      throw new BadRequestException("Reply body must not exceed 4000 characters.");
    }

    let current: any;
    try {
      current = await this.prisma.supportTicket.findFirst({
        where: { id: ticketId, userId: user.id },
        select: {
          id: true,
          title: true,
          status: true,
          source: true,
          subscriptionId: true,
          teamId: true,
          lastMessageAt: true,
          closedAt: true,
          createdAt: true,
          updatedAt: true,
          team: { select: { name: true } },
          messages: {
            include: {
              authorUser: { select: { displayName: true } },
              attachments: { orderBy: { createdAt: "asc" } }
            },
            orderBy: { createdAt: "asc" }
          },
          readStates: {
            where: { userId: user.id },
            select: { lastReadAt: true, lastReadMessageAt: true },
            take: 1
          },
        }
      });
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "Support ticket detail is temporarily unavailable.");
    }
    if (!current) {
      throw new NotFoundException("工单不存在");
    }
    if (current.status === "closed") {
      throw new BadRequestException("当前工单已关闭，请等待管理员重新打开。");
    }

    let uploaded = null as Awaited<ReturnType<ImageBedService["uploadSupportTicketAttachment"]>> | null;
    let attachmentUploadError: string | null = null;
    if (file) {
      this.imageBedService.assertSupportTicketAttachment?.(file);
      try {
        uploaded = await this.imageBedService.uploadSupportTicketAttachment(file, {
          timeoutMs: TICKET_ATTACHMENT_UPLOAD_BUDGET_MS
        });
      } catch (error) {
        attachmentUploadError = readErrorMessage(error);
        this.logger.warn(`Client ticket attachment upload failed for ${ticketId}: ${attachmentUploadError}`);
      }
    }
    const now = new Date();
    const messageId = createId("ticket_msg");
    const attachmentId = uploaded ? createId("ticket_att") : null;
    const safeMessageBody = buildSupportTicketAttachmentReplyBody(
      body,
      uploaded ? `Uploaded attachment: ${uploaded.fileName}` : "",
      attachmentUploadError
    );
    try {
      await this.prisma.$transaction(async (tx) => {
        const message = await tx.supportTicketMessage.create({
          data: {
            id: messageId,
            ticketId,
            authorRole: "user",
            authorUserId: user.id,
            body: safeMessageBody
          }
        });
        if (uploaded) {
          await tx.supportTicketAttachment.create({
            data: {
              id: attachmentId!,
              ticketId,
              messageId: message.id,
              provider: "image-bed",
              url: uploaded.url,
              fileName: uploaded.fileName,
              mimeType: uploaded.mimeType,
              fileSizeBytes: uploaded.fileSizeBytes
            }
          });
        }
        await tx.supportTicket.update({
          where: { id: ticketId },
          data: {
            status: "waiting_admin",
            lastMessageAt: now,
            closedAt: null
          }
        });
        await tx.supportTicketReadState.upsert({
          where: {
            ticketId_userId: {
              ticketId,
              userId: user.id
            }
          },
          create: {
            id: createId("ticket_read"),
            ticketId,
            userId: user.id,
            lastReadMessageAt: now,
            lastReadAt: now
          },
          update: {
            lastReadMessageAt: now,
            lastReadAt: now
          }
        });
      });
    } catch (error) {
      await this.imageBedService.deleteUploadedSupportTicketAttachmentBestEffort(uploaded);
      throwLocalSaveAsServiceUnavailable(error, "工单回复保存失败，请刷新后重试；已上传附件已清理。");
    }

    this.publishTicketEventBestEffort(user.id, {
      type: "ticket_updated",
      occurredAt: now.toISOString(),
      ticketId,
      ticketStatus: "waiting_admin"
    });

    const detail = await this.getClientSupportTicketDetailAfterWrite(ticketId, token, () =>
      this.buildClientSupportTicketWriteFallback(current, now, {
        messageId,
        body: safeMessageBody,
        attachments:
          uploaded && attachmentId
            ? [
                {
                  id: attachmentId,
                  url: uploaded.url,
                  fileName: uploaded.fileName,
                  mimeType: uploaded.mimeType,
                  fileSizeBytes: uploaded.fileSizeBytes.toString(),
                  createdAt: now.toISOString()
                }
              ]
            : []
      })
    );
    return {
      ...detail,
      attachmentUploadStatus: file ? (uploaded ? "uploaded" : "failed") : "none",
      attachmentUploadError
    };
  }

  private async getClientSupportTicketDetailAfterWrite(
    ticketId: string,
    token: string | undefined,
    fallback: () => ClientSupportTicketDetailDto
  ) {
    let settled = false;
    const detailTask = this.getClientSupportTicketDetail(ticketId, token).then(
      (detail) => {
        settled = true;
        return detail;
      },
      (error) => {
        settled = true;
        throw error;
      }
    );
    void detailTask.catch(() => undefined);

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutTask = new Promise<ClientSupportTicketDetailDto>((resolve) => {
      timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        this.logger.warn(
          `Client ticket write saved, but detail refresh exceeded ${TICKET_DETAIL_REFRESH_BUDGET_MS}ms and will continue in background.`
        );
        resolve(fallback());
      }, TICKET_DETAIL_REFRESH_BUDGET_MS);
    });

    try {
      return await Promise.race([detailTask, timeoutTask]);
    } catch (error) {
      this.logger.warn(`Client ticket write saved, but detail refresh failed for ${ticketId}: ${readErrorMessage(error)}`);
      return fallback();
    } finally {
      if (settled && timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private buildClientSupportTicketWriteFallback(
    ticket: {
      id: string;
      title: string;
      subscriptionId: string | null;
      teamId: string | null;
      teamName?: string | null;
      team?: { name: string } | null;
      source?: "desktop" | "admin";
      lastMessageAt?: Date;
      closedAt: Date | null;
      createdAt: Date;
      updatedAt?: Date;
      readStates?: Array<{ lastReadAt: Date | null; lastReadMessageAt: Date | null }>;
      messages?: Array<{
        id: string;
        ticketId: string;
        authorRole: ClientSupportTicketDetailDto["messages"][number]["authorRole"];
        body: string;
        createdAt: Date;
        attachments?: Array<{
          id: string;
          url: string;
          fileName: string;
          mimeType: string;
          fileSizeBytes: bigint | number | null;
          createdAt: Date;
        }>;
        authorUser?: { displayName: string } | null;
      }>;
    },
    now: Date,
    message: {
      messageId: string;
      body: string;
      attachments: ClientSupportTicketDetailDto["messages"][number]["attachments"];
    }
  ): ClientSupportTicketDetailDto {
    return {
      id: ticket.id,
      title: ticket.title,
      status: "waiting_admin",
      source: "desktop",
      subscriptionId: ticket.subscriptionId,
      teamId: ticket.teamId,
      teamName: ticket.teamName ?? ticket.team?.name ?? null,
      lastMessageAt: now.toISOString(),
      closedAt: ticket.closedAt?.toISOString() ?? null,
      createdAt: ticket.createdAt.toISOString(),
      updatedAt: now.toISOString(),
      lastMessagePreview: summarizeSupportTicketMessage(message.body),
      hasUnreadMessages: false,
      unreadCount: 0,
      lastReadAt: now.toISOString(),
      messages: [
        ...(ticket.messages ?? []).map((existingMessage) => ({
          id: existingMessage.id,
          ticketId: existingMessage.ticketId,
          authorRole: existingMessage.authorRole,
          authorDisplayName: readSupportTicketAuthorDisplayName(
            existingMessage.authorRole,
            existingMessage.authorUser?.displayName ?? null
          ),
          body: existingMessage.body,
          attachments: (existingMessage.attachments ?? []).map(toSupportTicketAttachmentDto),
          createdAt: existingMessage.createdAt.toISOString()
        })),
        {
          id: message.messageId,
          ticketId: ticket.id,
          authorRole: "user",
          authorDisplayName: readSupportTicketAuthorDisplayName("user", null),
          body: message.body,
          attachments: message.attachments,
          createdAt: now.toISOString()
        }
      ]
    };
  }

  private publishTicketEventBestEffort(
    userId: string,
    event: Parameters<ClientRuntimeEventsService["publishToUser"]>[1]
  ) {
    try {
      this.clientRuntimeEventsService.publishToUser(userId, event);
    } catch (error) {
      this.logger.warn(`Local ticket change saved, but ticket event publish failed for ${userId}: ${readErrorMessage(error)}`);
    }
    if (event.ticketId && this.adminRuntimeEventsService) {
      try {
        this.adminRuntimeEventsService.publishTicketUpdated({
          ticketId: event.ticketId,
          ticketStatus: event.ticketStatus
        });
      } catch (error) {
        this.logger.warn(`Local ticket change saved, but admin ticket event publish failed: ${readErrorMessage(error)}`);
      }
    }
  }

  private async loadLatestAdminTicketMessageMap(ticketIds: string[]) {
    const uniqueTicketIds = Array.from(new Set(ticketIds.filter((item) => item.trim().length > 0)));
    const result = new Map<string, Date>();
    if (uniqueTicketIds.length === 0) {
      return result;
    }

    const rows = await this.prisma.supportTicketMessage.findMany({
      where: {
        ticketId: { in: uniqueTicketIds },
        authorRole: "admin"
      },
      select: {
        ticketId: true,
        createdAt: true
      },
      orderBy: [{ createdAt: "desc" }]
    });

    for (const row of rows) {
      if (!result.has(row.ticketId)) {
        result.set(row.ticketId, row.createdAt);
      }
    }
    return result;
  }

  private async requireClientSupportTicketDetail(ticketId: string, userId: string) {
    let row: any;
    try {
      row = await this.prisma.supportTicket.findFirst({
        where: {
          id: ticketId,
          userId
        },
        include: {
          team: {
            select: { id: true, name: true }
          },
          messages: {
            include: {
              authorUser: {
                select: { displayName: true }
              },
              attachments: {
                orderBy: { createdAt: "asc" }
              }
            },
            orderBy: { createdAt: "asc" }
          },
          readStates: {
            where: { userId },
            select: { lastReadAt: true, lastReadMessageAt: true },
            take: 1
          }
        }
      });
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "Support ticket detail is temporarily unavailable.");
    }

    if (!row) {
      throw new NotFoundException("工单不存在");
    }
    return row;
  }

  private async resolveSubscriptionAccessForUser(userId: string): Promise<ClientSubscriptionAccess> {
    try {
      const membership = await this.prisma.teamMember.findUnique({
        where: { userId },
        include: {
          team: {
            include: {
              subscriptions: {
                include: { plan: true, user: true, team: true },
                orderBy: [{ expireAt: "desc" }, { createdAt: "desc" }]
              }
            }
          }
        }
      });

      if (membership) {
        const pickedSubscription = pickCurrentSubscription(membership.team.subscriptions);
        const subscription = pickedSubscription
          ? await this.prisma.subscription.findUnique({
              where: { id: pickedSubscription.id },
              include: { plan: true, user: true, team: true }
            })
          : null;
        const memberUsedTrafficGb = subscription
          ? await this.getMemberUsedTrafficGb(membership.teamId, userId, subscription.id)
          : 0;

        return {
          subscription,
          team: membership.team,
          memberRole: membership.role as TeamMemberRole,
          memberUsedTrafficGb
        };
      }

      const subscription = await this.findCurrentPersonalSubscription(userId);
      return {
        subscription,
        team: null,
        memberRole: null,
        memberUsedTrafficGb: null
      };
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "Support ticket subscription access is temporarily unavailable.");
    }
  }

  private async findCurrentPersonalSubscription(userId: string) {
    const rows = await this.prisma.subscription.findMany({
      where: { userId },
      include: { plan: true, user: true, team: true },
      orderBy: [{ expireAt: "desc" }, { createdAt: "desc" }]
    });
    return pickCurrentSubscription(rows);
  }

  private async getMemberUsedTrafficGb(teamId: string, userId: string, subscriptionId: string) {
    const rows = await this.prisma.trafficLedger.findMany({
      where: { teamId, userId, subscriptionId }
    });
    return rows.reduce((sum, item) => sum + item.usedTrafficGb, 0);
  }
}

function readErrorMessage(error: unknown) {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : "unknown error";
}

function buildSupportTicketAttachmentReplyBody(body: string, attachmentFallbackBody: string, attachmentUploadError: string | null) {
  const baseBody = body || attachmentFallbackBody || "Attachment upload failed";
  if (!attachmentUploadError) {
    return baseBody;
  }
  return `${baseBody}\n\nAttachment upload failed; text reply was saved first: ${attachmentUploadError}`;
}

function readPositiveIntegerEnv(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(Number(parsed)) : fallback;
}
