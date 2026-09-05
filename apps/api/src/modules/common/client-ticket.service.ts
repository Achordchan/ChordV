import { workLifecycle } from "../../work-lifecycle";
import { BadRequestException, HttpException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type {
  ClientSupportTicketDetailDto,
  ClientSupportTicketSummaryDto,
  CreateClientSupportTicketInputDto,
  ReplyClientSupportTicketInputDto,
  TeamMemberRole,
  UploadedSupportTicketAttachmentReferenceInputDto
} from "@chordv/shared";
import { AuthSessionService } from "./auth-session.service";
import { AdminRuntimeEventsService } from "./admin-runtime-events.service";
import { ClientRuntimeEventsService } from "./client-runtime-events.service";
import { ImageBedService, type UploadedTicketAttachmentFile } from "./image-bed.service";
import { throwLocalReadAsServiceUnavailable, throwLocalSaveAsServiceUnavailable } from "./prisma-error.utils";
import { PrismaService } from "./prisma.service";
import { createId } from "./release-center.utils";
import { pickCurrentSubscription } from "./subscription.utils";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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
const TICKET_ATTACHMENT_UPLOAD_BUDGET_MS = readPositiveIntegerEnv("CHORDV_TICKET_ATTACHMENT_UPLOAD_TIMEOUT_MS", 60_000);

@Injectable()
export class ClientTicketService {
  private readonly logger = new Logger(ClientTicketService.name);
  private pendingAttachmentJanitorRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly authSessionService: AuthSessionService,
    private readonly adminRuntimeEventsService: AdminRuntimeEventsService,
    private readonly clientRuntimeEventsService: ClientRuntimeEventsService,
    private readonly imageBedService: ImageBedService
  ) {
    if (process.env.NODE_ENV !== "test" && process.env.CHORDV_DISABLE_ATTACHMENT_JANITOR !== "true") {
      this.startPendingAttachmentJanitor();
    }
  }

  private startPendingAttachmentJanitor() {
    // Pending attachment rows are shared in Postgres so restarts/multi-instance stay consistent.
    const intervalMs = Math.max(30_000, Math.floor(SUPPORT_TICKET_ATTACHMENT_UPLOAD_TOKEN_TTL_MS / 2));
    const tick = () => {
      if (!workLifecycle.isDraining) workLifecycle.track(this.pruneExpiredPendingAttachmentsAndCleanup());
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    workLifecycle.onDrain(() => clearInterval(timer));
    timer.unref?.();
  }

  private async pruneExpiredPendingAttachmentsAndCleanup() {
    if (this.pendingAttachmentJanitorRunning) {
      return;
    }
    this.pendingAttachmentJanitorRunning = true;
    try {
      const expired = await prunePendingSupportTicketAttachments(this.prisma);
      const cleanedTokenIds: string[] = [];
      for (const pending of expired) {
        const deleted = await this.imageBedService.deleteUploadedSupportTicketAttachmentBestEffort({
          url: pending.url,
          providerFileId: pending.providerFileId,
          fileName: pending.fileName,
          mimeType: pending.mimeType,
          fileSizeBytes: pending.fileSizeBytes
        });
        if (deleted) {
          cleanedTokenIds.push(pending.tokenId);
        } else {
          this.logger.warn(
            `Pending support-ticket attachment remote cleanup failed for ${pending.tokenId}; credentials retained for retry`
          );
        }
      }
      await deletePendingSupportTicketAttachmentCredentials(this.prisma, cleanedTokenIds);
      await pruneExpiredSupportTicketAttachmentRateBuckets(this.prisma);
    } catch (error) {
      this.logger.warn(
        `Pending support-ticket attachment janitor failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      this.pendingAttachmentJanitorRunning = false;
    }
  }

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
    const body = input.body?.trim() ?? "";
    const attachment = normalizeUploadedSupportTicketAttachmentReference(input.attachment);
    if (!body && !attachment) {
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

    const now = new Date();
    const messageId = createId("ticket_msg");
    const attachmentId = attachment ? createId("ticket_att") : null;
    const messageBody = body || (attachment ? `Uploaded attachment: ${attachment.fileName}` : "");
    let pendingAttachment: PendingSupportTicketAttachment | null | undefined = null;
    let attachmentTokenId: string | null = null;
    if (attachment) {
      attachmentTokenId = assertSupportTicketAttachmentUploadToken(attachment.uploadToken, user.id, ticketId);
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        if (attachment && attachmentTokenId) {
          pendingAttachment = await consumePendingSupportTicketAttachment(
            tx,
            attachmentTokenId,
            user.id,
            ticketId,
            attachment.url
          );
        }
        const message = await tx.supportTicketMessage.create({
          data: {
            id: messageId,
            ticketId,
            authorRole: "user",
            authorUserId: user.id,
            body: messageBody
          }
        });
        if (attachment && pendingAttachment) {
          await tx.supportTicketAttachment.create({
            data: {
              id: attachmentId!,
              ticketId,
              messageId: message.id,
              provider: "image-bed",
              url: pendingAttachment.url,
              fileName: pendingAttachment.fileName,
              mimeType: pendingAttachment.mimeType,
              fileSizeBytes: pendingAttachment.fileSizeBytes
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
      // Claim/delete of pending rows participate in the same DB transaction.
      // On failure Postgres rolls them back, so remote cleanup here would create
      // a live pending token pointing at an already-deleted image.
      if (error instanceof HttpException) {
        throw error;
      }
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
        body: messageBody,
        attachments:
          attachment && attachmentId && pendingAttachment
            ? [
                {
                  id: attachmentId,
                  url: pendingAttachment.url,
                  fileName: pendingAttachment.fileName,
                  mimeType: pendingAttachment.mimeType,
                  fileSizeBytes: pendingAttachment.fileSizeBytes.toString(),
                  createdAt: now.toISOString()
                }
              ]
            : []
      })
    );
  }

  async uploadClientSupportTicketAttachment(
    ticketId: string,
    file: UploadedTicketAttachmentFile | undefined,
    token?: string
  ): Promise<UploadedSupportTicketAttachmentReferenceInputDto> {
    const user = await this.authSessionService.authenticateAccessToken(token);
    let current: { id: string; status: "open" | "waiting_admin" | "waiting_user" | "closed" } | null;
    try {
      current = await this.prisma.supportTicket.findFirst({
        where: { id: ticketId, userId: user.id },
        select: { id: true, status: true }
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

    if (!file) {
      throw new BadRequestException("请先选择要上传的附件。");
    }
    this.imageBedService.assertSupportTicketAttachment(file);
    const quotaReservation = await assertSupportTicketAttachmentUploadQuota(this.prisma, user.id, file.size);
    let uploaded: Awaited<ReturnType<ImageBedService["uploadSupportTicketAttachment"]>> | null = null;
    try {
      uploaded = await this.imageBedService.uploadSupportTicketAttachment(file);
      const attachmentToken = createSupportTicketAttachmentUploadToken(user.id, ticketId);
      try {
        await this.prisma.supportTicketPendingAttachment.create({
          data: {
            tokenId: attachmentToken.tokenId,
            userId: user.id,
            ticketId,
            url: uploaded.url,
            providerFileId: uploaded.providerFileId,
            fileName: uploaded.fileName,
            mimeType: uploaded.mimeType,
            fileSizeBytes: uploaded.fileSizeBytes,
            consumed: false,
            expiresAt: new Date(attachmentToken.expiresAt)
          }
        });
        consumeSupportTicketAttachmentUploadQuota(quotaReservation);
      } catch (error) {
        // Leave remote cleanup to the outer catch so the file is deleted exactly once.
        throwLocalSaveAsServiceUnavailable(error, "附件记录保存失败，请稍后重试。");
      }
      return {
        uploadToken: attachmentToken.uploadToken,
        url: uploaded.url,
        providerFileId: uploaded.providerFileId,
        fileName: uploaded.fileName,
        mimeType: uploaded.mimeType,
        fileSizeBytes: uploaded.fileSizeBytes.toString()
      };
    } catch (error) {
      await releaseSupportTicketAttachmentUploadQuota(this.prisma, quotaReservation).catch(() => undefined);
      if (uploaded) {
        await this.imageBedService.deleteUploadedSupportTicketAttachmentBestEffort(uploaded);
      }
      if (error instanceof HttpException) {
        throw error;
      }
      throw error;
    }
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
    let quotaReservation: SupportTicketAttachmentQuotaReservation | null = null;
    if (file) {
      this.imageBedService.assertSupportTicketAttachment?.(file);
      quotaReservation = await assertSupportTicketAttachmentUploadQuota(this.prisma, user.id, file.size);
      try {
        uploaded = await this.imageBedService.uploadSupportTicketAttachment(file, {
          timeoutMs: TICKET_ATTACHMENT_UPLOAD_BUDGET_MS
        });
      } catch (error) {
        attachmentUploadError = readErrorMessage(error);
        this.logger.warn(`Client ticket attachment upload failed for ${ticketId}: ${attachmentUploadError}`);
        if (quotaReservation) {
          await releaseSupportTicketAttachmentUploadQuota(this.prisma, quotaReservation).catch(() => undefined);
        }
        if (!body) {
          if (error instanceof HttpException) {
            throw error;
          }
          throw new ServiceUnavailableException("附件上传失败，未保存工单回复，请稍后重试。");
        }
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
      if (quotaReservation) {
        await releaseSupportTicketAttachmentUploadQuota(this.prisma, quotaReservation).catch(() => undefined);
      }
      if (uploaded) {
        await this.imageBedService.deleteUploadedSupportTicketAttachmentBestEffort(uploaded);
      }
      throwLocalSaveAsServiceUnavailable(error, "工单回复保存失败，请刷新后重试；已尝试清理本次上传附件。");
    }

    if (uploaded) {
      consumeSupportTicketAttachmentUploadQuota(quotaReservation);
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
      return await Promise.race([workLifecycle.track(detailTask), timeoutTask]);
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
  const baseBody = body || attachmentFallbackBody || "附件上传失败";
  if (!attachmentUploadError) {
    return baseBody;
  }
  const notice = "附件上传失败，文字回复已保存。请检查图床配置或稍后重试。";
  return body ? `${baseBody}\n\n${notice}` : notice;
}


const SUPPORT_TICKET_ATTACHMENT_UPLOAD_TOKEN_TTL_MS = readPositiveIntegerEnv(
  "CHORDV_SUPPORT_TICKET_ATTACHMENT_TOKEN_TTL_MS",
  30 * 60 * 1000
);
const SUPPORT_TICKET_ATTACHMENT_UPLOAD_RATE_LIMIT = readPositiveIntegerEnv(
  "CHORDV_SUPPORT_TICKET_ATTACHMENT_UPLOAD_RATE_LIMIT",
  20
);
const SUPPORT_TICKET_ATTACHMENT_UPLOAD_RATE_WINDOW_MS = readPositiveIntegerEnv(
  "CHORDV_SUPPORT_TICKET_ATTACHMENT_UPLOAD_RATE_WINDOW_MS",
  60 * 60 * 1000
);
const SUPPORT_TICKET_ATTACHMENT_DAILY_BYTES_LIMIT = readPositiveIntegerEnv(
  "CHORDV_SUPPORT_TICKET_ATTACHMENT_DAILY_BYTES_LIMIT",
  50 * 1024 * 1024
);

type PendingSupportTicketAttachment = {
  tokenId: string;
  userId: string;
  ticketId: string;
  url: string;
  providerFileId: string | null;
  fileName: string;
  mimeType: string;
  fileSizeBytes: bigint;
  createdAt: number;
  consumed: boolean;
};

type TicketAttachmentPrisma = {
  supportTicketPendingAttachment: {
    findMany: (args?: any) => Promise<Array<Record<string, any>>>;
    findUnique: (args: any) => Promise<Record<string, any> | null>;
    create: (args: any) => Promise<unknown>;
    updateMany: (args: any) => Promise<{ count: number }>;
    deleteMany: (args: any) => Promise<unknown>;
    delete: (args: any) => Promise<unknown>;
  };
  rateLimitBucket: {
    findUnique: (args: any) => Promise<{ key: string; count: number; blockedUntil: Date | null } | null>;
    upsert: (args: any) => Promise<unknown>;
    update: (args: any) => Promise<unknown>;
    updateMany: (args: any) => Promise<{ count: number }>;
    deleteMany: (args: any) => Promise<{ count: number }>;
  };
  $transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
};

function getSupportTicketAttachmentTokenSecret() {
  return (
    process.env.CHORDV_SUPPORT_TICKET_ATTACHMENT_TOKEN_SECRET?.trim() ||
    process.env.CHORDV_JWT_SECRET?.trim() ||
    "chordv-dev-support-ticket-attachment-secret"
  );
}

function signSupportTicketAttachmentToken(tokenId: string, userId: string, ticketId: string, expiresAt: number) {
  return createHash("sha256")
    .update(`${tokenId}.${userId}.${ticketId}.${expiresAt}.${getSupportTicketAttachmentTokenSecret()}`)
    .digest("hex");
}

function createSupportTicketAttachmentUploadToken(userId: string, ticketId: string) {
  const tokenId = randomBytes(16).toString("hex");
  const expiresAt = Date.now() + SUPPORT_TICKET_ATTACHMENT_UPLOAD_TOKEN_TTL_MS;
  const signature = signSupportTicketAttachmentToken(tokenId, userId, ticketId, expiresAt);
  return {
    tokenId,
    expiresAt,
    uploadToken: `${tokenId}.${expiresAt}.${signature}`
  };
}

function parseSupportTicketAttachmentUploadToken(uploadToken: string) {
  const [tokenId, expiresAtRaw, signature] = uploadToken.split(".");
  if (!tokenId || !expiresAtRaw || !signature) {
    return null;
  }
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt)) {
    return null;
  }
  return { tokenId, expiresAt, signature };
}

function assertSupportTicketAttachmentUploadToken(uploadToken: string, userId: string, ticketId: string) {
  const parsed = parseSupportTicketAttachmentUploadToken(uploadToken);
  if (!parsed) {
    throw new BadRequestException("附件凭证无效，请重新上传。");
  }
  if (parsed.expiresAt < Date.now()) {
    throw new BadRequestException("附件凭证已过期，请重新上传。");
  }
  const expected = signSupportTicketAttachmentToken(parsed.tokenId, userId, ticketId, parsed.expiresAt);
  const left = Buffer.from(expected);
  const right = Buffer.from(parsed.signature);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new BadRequestException("附件凭证无效，请重新上传。");
  }
  return parsed.tokenId;
}

function toPendingSupportTicketAttachment(row: Record<string, unknown>): PendingSupportTicketAttachment {
  const createdAtValue = row.createdAt instanceof Date ? row.createdAt.getTime() : Number(row.createdAt ?? Date.now());
  return {
    tokenId: String(row.tokenId ?? ""),
    userId: String(row.userId ?? ""),
    ticketId: String(row.ticketId ?? ""),
    url: String(row.url ?? ""),
    providerFileId: row.providerFileId == null ? null : String(row.providerFileId),
    fileName: String(row.fileName ?? "attachment"),
    mimeType: String(row.mimeType ?? "application/octet-stream"),
    fileSizeBytes: typeof row.fileSizeBytes === "bigint" ? row.fileSizeBytes : BigInt(Number(row.fileSizeBytes ?? 0)),
    createdAt: createdAtValue,
    consumed: Boolean(row.consumed)
  };
}

async function prunePendingSupportTicketAttachments(prisma: TicketAttachmentPrisma, now = Date.now()) {
  const expiredRows = await prisma.supportTicketPendingAttachment.findMany({
    where: {
      OR: [
        { consumed: true },
        { expiresAt: { lte: new Date(now) } }
      ]
    },
    take: 200
  });
  const expired: PendingSupportTicketAttachment[] = [];
  for (const row of expiredRows) {
    const pending = toPendingSupportTicketAttachment(row);
    // Keep DB credentials until remote cleanup succeeds so failed deletes can retry.
    if (!pending.consumed || pending.providerFileId || pending.url) {
      expired.push(pending);
    }
  }
  return expired;
}

async function deletePendingSupportTicketAttachmentCredentials(
  prisma: TicketAttachmentPrisma,
  tokenIds: string[]
) {
  if (tokenIds.length === 0) {
    return;
  }
  await prisma.supportTicketPendingAttachment.deleteMany({
    where: {
      tokenId: { in: tokenIds }
    }
  });
}

async function pruneExpiredSupportTicketAttachmentRateBuckets(
  prisma: TicketAttachmentPrisma,
  now = Date.now()
) {
  const hourlyStaleBefore = new Date(now - SUPPORT_TICKET_ATTACHMENT_UPLOAD_RATE_WINDOW_MS * 2);
  const currentUtcDayStart = new Date(now);
  currentUtcDayStart.setUTCHours(0, 0, 0, 0);
  if (typeof prisma.rateLimitBucket.deleteMany !== "function") {
    return;
  }
  await prisma.rateLimitBucket.deleteMany({
    where: {
      OR: [
        {
          key: { startsWith: "ticket-att-rate:" },
          updatedAt: { lt: hourlyStaleBefore }
        },
        {
          key: { startsWith: "ticket-att-daily:" },
          updatedAt: { lt: currentUtcDayStart }
        }
      ]
    }
  });
}

async function reserveRateLimitBucket(
  tx: any,
  key: string,
  increment: number,
  limit: number,
  overLimitMessage: string
) {
  // Atomic create-or-increment under a limit. Concurrent requests cannot all pass the old
  // read-then-upsert race: only one of the conditional updates succeeds past the ceiling.
  await tx.rateLimitBucket.upsert({
    where: { key },
    create: { key, count: 0 },
    update: {}
  });
  const updated = await tx.rateLimitBucket.updateMany({
    where: {
      key,
      count: { lte: limit - increment }
    },
    data: {
      count: { increment }
    }
  });
  if (updated.count === 0) {
    throw new BadRequestException(overLimitMessage);
  }
}

type SupportTicketAttachmentQuotaReservation = {
  rateKey: string;
  dailyKey: string;
  fileSizeBytes: number;
  status: "reserved" | "refunding" | "refunded" | "consumed";
};
function buildSupportTicketAttachmentQuotaKeys(userId: string, now = Date.now()) {
  const windowStart = now - (now % SUPPORT_TICKET_ATTACHMENT_UPLOAD_RATE_WINDOW_MS);
  const rateKey = `ticket-att-rate:${userId}:${windowStart}`;
  const day = new Date(now).toISOString().slice(0, 10);
  const dailyKey = `ticket-att-daily:${userId}:${day}`;
  return { rateKey, dailyKey };
}

async function assertSupportTicketAttachmentUploadQuota(
  prisma: TicketAttachmentPrisma,
  userId: string,
  fileSizeBytes: number
): Promise<SupportTicketAttachmentQuotaReservation> {
  const now = Date.now();
  const { rateKey, dailyKey } = buildSupportTicketAttachmentQuotaKeys(userId, now);

  await prisma.$transaction(async (tx) => {
    await reserveRateLimitBucket(
      tx,
      rateKey,
      1,
      SUPPORT_TICKET_ATTACHMENT_UPLOAD_RATE_LIMIT,
      "附件上传过于频繁，请稍后再试。"
    );
    await reserveRateLimitBucket(
      tx,
      dailyKey,
      fileSizeBytes,
      SUPPORT_TICKET_ATTACHMENT_DAILY_BYTES_LIMIT,
      "今日附件上传容量已用尽，请明天再试。"
    );
  });

  return { rateKey, dailyKey, fileSizeBytes, status: "reserved" };
}

async function releaseSupportTicketAttachmentUploadQuota(
  prisma: TicketAttachmentPrisma,
  reservation: SupportTicketAttachmentQuotaReservation
) {
  if (reservation.status !== "reserved") {
    return false;
  }
  reservation.status = "refunding";
  const { rateKey, dailyKey, fileSizeBytes } = reservation;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.rateLimitBucket.updateMany({
        where: { key: rateKey, count: { gte: 1 } },
        data: { count: { decrement: 1 } }
      });
      if (fileSizeBytes > 0) {
        await tx.rateLimitBucket.updateMany({
          where: { key: dailyKey, count: { gte: fileSizeBytes } },
          data: { count: { decrement: fileSizeBytes } }
        });
      }
    });
    reservation.status = "refunded";
    return true;
  } catch (error) {
    reservation.status = "reserved";
    throw error;
  }
}

function consumeSupportTicketAttachmentUploadQuota(
  reservation: SupportTicketAttachmentQuotaReservation | null
) {
  if (reservation?.status === "reserved") {
    reservation.status = "consumed";
  }
}
async function consumePendingSupportTicketAttachment(
  prisma: Pick<TicketAttachmentPrisma, "supportTicketPendingAttachment">,
  tokenId: string,
  userId: string,
  ticketId: string,
  expectedUrl?: string
) {
  // Atomic claim: only one concurrent consumer can flip consumed=false -> true.
  // Losers must not remote-delete the winner's already-saved image.
  // URL validation happens before claim so mismatch does not consume the token.
  const now = new Date();
  const existing = await prisma.supportTicketPendingAttachment.findUnique({ where: { tokenId } });
  if (!existing || Boolean(existing.consumed)) {
    throw new BadRequestException("附件不存在或已使用，请重新上传。");
  }
  const preview = toPendingSupportTicketAttachment(existing);
  if (preview.userId !== userId || preview.ticketId !== ticketId) {
    throw new BadRequestException("附件不属于当前工单，请重新上传。");
  }
  const expiresAt =
    existing.expiresAt instanceof Date
      ? existing.expiresAt.getTime()
      : preview.createdAt + SUPPORT_TICKET_ATTACHMENT_UPLOAD_TOKEN_TTL_MS;
  if (expiresAt < Date.now()) {
    await prisma.supportTicketPendingAttachment
      .deleteMany({ where: { tokenId, consumed: false } })
      .catch(() => undefined);
    throw new BadRequestException("附件凭证已过期，请重新上传。");
  }
  if (expectedUrl && preview.url !== expectedUrl) {
    throw new BadRequestException("附件凭证与上传记录不匹配，请重新上传。");
  }

  const claimed = await prisma.supportTicketPendingAttachment.updateMany({
    where: {
      tokenId,
      userId,
      ticketId,
      consumed: false,
      expiresAt: { gt: now },
      ...(expectedUrl ? { url: expectedUrl } : {})
    },
    data: {
      consumed: true
    }
  });
  if (claimed.count !== 1) {
    throw new BadRequestException("附件不存在或已使用，请重新上传。");
  }

  const row = await prisma.supportTicketPendingAttachment.findUnique({ where: { tokenId } });
  if (!row) {
    throw new BadRequestException("附件不存在或已使用，请重新上传。");
  }
  const pending = toPendingSupportTicketAttachment(row);
  await prisma.supportTicketPendingAttachment.delete({ where: { tokenId } }).catch(() => undefined);
  return pending;
}

function normalizeUploadedSupportTicketAttachmentReference(
  input: UploadedSupportTicketAttachmentReferenceInputDto | null | undefined
) {
  if (!input) {
    return null;
  }
  const uploadToken = input.uploadToken?.trim();
  const url = input.url?.trim();
  const fileName = input.fileName?.trim();
  const mimeType = input.mimeType?.trim();
  if (!uploadToken || !url || !fileName || !mimeType) {
    throw new BadRequestException("附件信息不完整，请重新上传。");
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("invalid protocol");
    }
  } catch {
    throw new BadRequestException("附件地址无效，请重新上传。");
  }
  if (!mimeType.startsWith("image/")) {
    throw new BadRequestException("仅支持图片附件。");
  }
  const fileSizeBytes = parseNullableBigInt(input.fileSizeBytes);
  if (fileSizeBytes !== null && fileSizeBytes <= 0n) {
    throw new BadRequestException("附件大小无效，请重新上传。");
  }
  return {
    uploadToken,
    url,
    providerFileId: input.providerFileId?.trim() || null,
    fileName: fileName.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 255) || "attachment",
    mimeType: mimeType.slice(0, 120),
    fileSizeBytes
  };
}


function parseNullableBigInt(value: string | null | undefined) {
  if (value === null || value === undefined || value.trim() === "") {
    return null;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new BadRequestException("附件大小无效，请重新上传。");
  }
  const parsed = BigInt(trimmed);
  if (parsed > 9223372036854775807n) {
    throw new BadRequestException("附件大小无效，请重新上传。");
  }
  return parsed;
}

function readPositiveIntegerEnv(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(Number(parsed)) : fallback;
}
