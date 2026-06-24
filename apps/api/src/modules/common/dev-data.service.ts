import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
  UnauthorizedException
} from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import type {
  AdminAnnouncementRecordDto,
  AdminNodeRecordDto,
  AdminNodePanelInboundDto,
  AdminPlanRecordDto,
  AdminPolicyRecordDto,
  AdminReleaseRecordDto,
  AdminSecurityUpdateResultDto,
  AdminSnapshotDto,
  AdminSupportTicketDetailDto,
  AdminSupportTicketSummaryDto,
  AdminSubscriptionRecordDto,
  AdminTeamMemberRecordDto,
  AdminTeamRecordDto,
  AdminTeamUsageNodeSummaryDto,
  AdminTeamUsageRecordDto,
  AdminUserRecordDto,
  AnnouncementDto,
  AuthSessionDto,
  ChangeSubscriptionPlanInputDto,
  ClientBootstrapDto,
  ClientNodeProbeResultDto,
  ClientPingDto,
  ClientRuntimeEventDto,
  ClientSupportTicketDetailDto,
  ClientSupportTicketSummaryDto,
  ClientTeamSummaryDto,
  ClientUpdateCheckDto,
  ClientUpdateCheckResultDto,
  ClientVersionDto,
  ConnectRequestDto,
  ConvertSubscriptionToTeamInputDto,
  ConvertSubscriptionToTeamResultDto,
  CreateAnnouncementInputDto,
  CreateClientSupportTicketInputDto,
  CreatePlanInputDto,
  CreateReleaseArtifactInputDto,
  CreateReleaseInputDto,
  CreateSubscriptionInputDto,
  CreateTeamInputDto,
  KickTeamMemberInputDto,
  KickTeamMemberResultDto,
  ResetSubscriptionTrafficInputDto,
  ResetSubscriptionTrafficResultDto,
  CreateTeamMemberInputDto,
  CreateTeamSubscriptionInputDto,
  CreateUserInputDto,
  DisconnectUserResultDto,
  GeneratedRuntimeConfigDto,
  ImportNodeInputDto,
  MarkClientAnnouncementsReadInputDto,
  NodeProbeStatus,
  NodeSummaryDto,
  DashboardSnapshotDto,
  PlatformTarget,
  PolicyBundleDto,
  ReleaseChannel,
  ReleaseStatus,
  ReplyClientSupportTicketInputDto,
  RenewSubscriptionInputDto,
  SessionEvictedReason,
  SessionReasonCode,
  SubscriptionNodeAccessDto,
  SubscriptionSourceAction,
  SubscriptionState,
  SubscriptionStatusDto,
  TeamMemberRole,
  TeamStatus,
  UploadReleaseArtifactInputDto,
  UpdateAnnouncementInputDto,
  UpdateNodeInputDto,
  UpdatePlanInputDto,
  UpdatePlanSecurityInputDto,
  UpdatePolicyInputDto,
  UpdateReleaseArtifactInputDto,
  UpdateReleaseInputDto,
  UpdateSubscriptionInputDto,
  UpdateSubscriptionNodeAccessInputDto,
  UpdateTeamInputDto,
  UpdateTeamMemberInputDto,
  UpdateCurrentAdminSecurityInputDto,
  UpdateUserSecurityInputDto,
  UpdateUserInputDto,
  UserProfileDto,
  UserSubscriptionSummaryDto,
  SupportTicketAuthorRole,
  SupportTicketSource,
  SupportTicketStatus
} from "@chordv/shared";
import { METERING_REASON_NODE_UNAVAILABLE } from "./metering.constants";
import { AdminNodeService } from "./admin-node.service";
import { AdminRuntimeEventsService } from "./admin-runtime-events.service";
import { AdminSubscriptionService } from "./admin-subscription.service";
import { AnnouncementPolicyService } from "./announcement-policy.service";
import { AuthSessionService } from "./auth-session.service";
import { ClientAccessService } from "./client-access.service";
import { DevDataBootstrapService } from "./dev-data-bootstrap.service";
import { ClientEventsPublisher } from "./client-events.publisher";
import { ClientRuntimeEventsService } from "./client-runtime-events.service";
import { ClientTicketService } from "./client-ticket.service";
import { ImageBedService, type UploadedTicketAttachmentFile } from "./image-bed.service";
import { dedupeNodeAccessRows } from "./dev-data.utils";
import {
  decodeSubscriptionText,
  inferRegion,
  normalizeOptionalString as normalizeNodeOptionalString,
  normalizePanelApiBasePath,
  normalizeTags,
  parseVlessLink,
  probeNodeConnectivity,
  readRuntimeInboundId,
  toAdminNodeRecord,
  toNodeId,
  toNodeSummary
} from "./node-import.utils";
import { PrismaService } from "./prisma.service";
import { throwLocalReadAsServiceUnavailable, toPrismaTransientHttpError, throwLocalSaveAsServiceUnavailable } from "./prisma-error.utils";
import { createId } from "./release-center.utils";
import { ReleaseCenterService } from "./release-center.service";
import {
  isEffectiveSubscription,
  pickCurrentSubscription,
  readEffectiveSubscriptionState,
  resolveRenewExpireAt,
  resolveSubscriptionState,
  roundTrafficGb,
  getSubscriptionStateReason,
  summarizeTeamUsageRecords,
  toAdminSubscriptionRecord,
  toAdminTeamMemberRecord,
  toAdminTeamRecord,
  toSubscriptionStatusDto,
  toUserProfile,
  toUserSubscriptionSummary
} from "./subscription.utils";
import {
} from "./runtime-session.utils";
import {
  hasUnreadTicketMessages,
  readSupportTicketAuthorDisplayName,
  summarizeSupportTicketMessage,
  toAdminSupportTicketDetail,
  toAdminSupportTicketSummary,
  toClientSupportTicketDetail,
  toClientSupportTicketSummary
} from "./ticket.utils";
import { RuntimeSessionService } from "./runtime-session.service";
import { runWithSubscriptionUsageLock } from "./usage-lock.utils";
const RELEASE_ARTIFACT_DOWNLOAD_PREFIX = "/api/downloads/releases";
const NODE_ACCESS_FOLLOW_UP_BUDGET_MS = 300;
const NODE_ACCESS_DEFERRED_EFFECT_DELAY_MS = 50;
const EVENT_PUBLISH_BUDGET_MS = 300;
const TICKET_DETAIL_REFRESH_BUDGET_MS = 300;
const ADMIN_SUPPORT_TICKET_LIST_LIMIT = readPositiveIntegerEnv("CHORDV_ADMIN_SUPPORT_TICKET_LIST_LIMIT", 200);
const ADMIN_SUPPORT_TICKET_DETAIL_MESSAGE_LIMIT = readPositiveIntegerEnv("CHORDV_ADMIN_SUPPORT_TICKET_DETAIL_MESSAGE_LIMIT", 300);
const TICKET_ATTACHMENT_UPLOAD_BUDGET_MS = readPositiveIntegerEnv("CHORDV_TICKET_ATTACHMENT_UPLOAD_TIMEOUT_MS", 12_000);

type NodeAccessRevocationEffects = {
  revokedSessionCount: number;
  panelSyncMessage: string | null;
};

type UploadedReleaseFile = {
  path: string;
  originalname: string;
  size: number;
};


@Injectable()
export class DevDataService implements OnModuleInit {
  private readonly logger = new Logger(DevDataService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authSessionService: AuthSessionService,
    private readonly clientRuntimeEventsService: ClientRuntimeEventsService,
    private readonly adminRuntimeEventsService: AdminRuntimeEventsService,
    private readonly clientEventsPublisher: ClientEventsPublisher,
    private readonly clientAccessService: ClientAccessService,
    private readonly clientTicketService: ClientTicketService,
    private readonly announcementPolicyService: AnnouncementPolicyService,
    private readonly devDataBootstrapService: DevDataBootstrapService,
    private readonly releaseCenterService: ReleaseCenterService,
    private readonly adminNodeService: AdminNodeService,
    private readonly adminSubscriptionService: AdminSubscriptionService,
    private readonly imageBedService: ImageBedService,
    private readonly runtimeSessionService: RuntimeSessionService
  ) {}

  async onModuleInit() {
    if (!shouldAutoBootstrapDevData()) {
      this.logger.log("已跳过开发数据自动初始化");
      return;
    }
    await this.devDataBootstrapService.initialize();
  }

  async login(account: string, password: string, clientIp?: string): Promise<AuthSessionDto> {
    return this.clientAccessService.login(account, password, clientIp);
  }

  async refresh(token: string): Promise<AuthSessionDto> {
    return this.clientAccessService.refresh(token);
  }

  async logout(token?: string, refreshToken?: string) {
    return this.clientAccessService.logout(token, refreshToken);
  }

  async streamRuntimeEvents(token?: string, lastEventId?: string | null) {
    return this.clientAccessService.streamRuntimeEvents(token, lastEventId);
  }

  async getBootstrap(token?: string, platform?: PlatformTarget): Promise<ClientBootstrapDto> {
    return this.clientAccessService.getBootstrap(token, platform);
  }

  async getSubscription(token?: string): Promise<SubscriptionStatusDto> {
    return this.clientAccessService.getSubscription(token);
  }

  async getNodes(token?: string): Promise<NodeSummaryDto[]> {
    return this.clientAccessService.getNodes(token);
  }

  async probeClientNodes(nodeIds: string[], token?: string): Promise<ClientNodeProbeResultDto[]> {
    return this.clientAccessService.probeClientNodes(nodeIds, token);
  }

  async getPolicies(): Promise<PolicyBundleDto> {
    return this.announcementPolicyService.getPolicies();
  }

  async getAnnouncements(token?: string): Promise<AnnouncementDto[]> {
    return this.announcementPolicyService.getAnnouncements(token);
  }

  async markClientAnnouncementsRead(
    input: MarkClientAnnouncementsReadInputDto,
    token?: string
  ): Promise<{ ok: boolean; updatedIds: string[] }> {
    return this.announcementPolicyService.markClientAnnouncementsRead(input, token);
  }

  async getClientVersion(platform?: PlatformTarget): Promise<ClientVersionDto> {
    return this.clientAccessService.getClientVersion(platform);
  }

  private async listActiveUserIds(): Promise<string[]> {
    return this.clientEventsPublisher.listActiveUserIds();
  }

  private async resolveTargetUserIdsForSubscriptionTarget(target: {
    userId?: string | null;
    teamId?: string | null;
  }): Promise<string[]> {
    return this.clientEventsPublisher.resolveTargetUserIdsForSubscriptionTarget(target);
  }

  private publishClientEventToUsers(userIds: Iterable<string>, event: ClientRuntimeEventDto) {
    this.clientEventsPublisher.publishClientEventToUsers(userIds, event);
  }

  private publishClientEventToUser(userId: string, event: ClientRuntimeEventDto) {
    try {
      this.clientRuntimeEventsService.publishToUser(userId, event);
    } catch (error) {
      this.logger?.warn(`Local change saved, but user event publish failed for ${userId}: ${readPanelSyncErrorMessage(error)}`);
    }
  }

  private publishAdminTicketEventBestEffort(ticketId: string, ticketStatus?: SupportTicketStatus) {
    if (!this.adminRuntimeEventsService) {
      return;
    }
    try {
      this.adminRuntimeEventsService.publishTicketUpdated({ ticketId, ticketStatus });
    } catch (error) {
      this.logger?.warn(`Local ticket change saved, but admin ticket event publish failed: ${readPanelSyncErrorMessage(error)}`);
    }
  }

  private async publishAnnouncementUpdatedEvent(announcementId: string) {
    await this.tryPublishEvent("announcement_updated", () => this.clientEventsPublisher.publishAnnouncementUpdated(announcementId));
  }

  private publishAnnouncementReadStateUpdatedEvent(userId: string, announcementId: string) {
    this.clientEventsPublisher.publishAnnouncementReadStateUpdated(userId, announcementId);
  }

  private publishTicketEvent(
    userId: string,
    ticketId: string,
    ticketStatus: SupportTicketStatus,
    type: "ticket_updated" | "ticket_read_state_updated" = "ticket_updated"
  ) {
    this.clientEventsPublisher.publishTicketEvent(userId, ticketId, ticketStatus, type);
  }

  private async publishVersionUpdatedEvent(
    platform?: PlatformTarget | null,
    channel: ReleaseChannel = "stable",
    latestVersion?: string | null
  ) {
    await this.tryPublishEvent("version_updated", () =>
      this.clientEventsPublisher.publishVersionUpdated(platform, channel, latestVersion)
    );
  }

  private async publishSubscriptionUpdatedEvent(target: {
    subscriptionId?: string | null;
    userId?: string | null;
    teamId?: string | null;
    state?: SubscriptionState | null;
  }) {
    this.publishAdminSubscriptionEventBestEffort(target);
    await this.tryPublishEvent("subscription_updated", () => this.clientEventsPublisher.publishSubscriptionUpdated(target));
  }

  private async publishNodeAccessUpdatedEvent(target: {
    subscriptionId?: string | null;
    userId?: string | null;
    teamId?: string | null;
  }) {
    this.publishAdminNodeAccessEventBestEffort(target);
    await this.tryPublishEvent("node_access_updated", () => this.clientEventsPublisher.publishNodeAccessUpdated(target));
  }

  private publishAdminSubscriptionEventBestEffort(target: {
    subscriptionId?: string | null;
    state?: SubscriptionState | null;
  }) {
    if (!this.adminRuntimeEventsService) {
      return;
    }
    try {
      this.adminRuntimeEventsService.publishSubscriptionUpdated({
        subscriptionId: target.subscriptionId ?? null,
        state: target.state ?? null
      });
    } catch (error) {
      this.logger?.warn(`Local subscription change saved, but admin subscription_updated publish failed: ${readPanelSyncErrorMessage(error)}`);
    }
  }

  private publishAdminNodeAccessEventBestEffort(target: {
    subscriptionId?: string | null;
  }) {
    if (!this.adminRuntimeEventsService) {
      return;
    }
    try {
      this.adminRuntimeEventsService.publish({
        type: "node_access_updated",
        occurredAt: new Date().toISOString(),
        subscriptionId: target.subscriptionId ?? null
      });
    } catch (error) {
      this.logger?.warn(`Local node access change saved, but admin node_access_updated publish failed: ${readPanelSyncErrorMessage(error)}`);
    }
  }

  private publishNodeAccessUpdatedEventInBackground(target: {
    subscriptionId?: string | null;
    userId?: string | null;
    teamId?: string | null;
  }) {
    void this.publishNodeAccessUpdatedEvent(target).catch((error) => {
      this.logger?.warn(`Local node access change saved, but async node access publish failed: ${readPanelSyncErrorMessage(error)}`);
    });
  }

  private async tryPublishEvent(eventType: string, task: () => Promise<unknown>) {
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
      this.logger?.warn(`Local change saved, but delayed ${eventType} publish failed: ${readPanelSyncErrorMessage(error)}`);
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutTask = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        this.logger?.warn(
          `Local change saved, but ${eventType} publish exceeded ${EVENT_PUBLISH_BUDGET_MS}ms and will continue in background.`
        );
        resolve();
      }, EVENT_PUBLISH_BUDGET_MS);
    });

    try {
      await Promise.race([guardedTask, timeoutTask]);
    } catch (error) {
      this.logger?.warn(`Local change saved, but ${eventType} publish failed: ${readPanelSyncErrorMessage(error)}`);
    } finally {
      if (settled && timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  async pingClient(token?: string): Promise<ClientPingDto> {
    return this.clientAccessService.pingClient(token);
  }

  async listClientSupportTickets(token?: string): Promise<ClientSupportTicketSummaryDto[]> {
    return this.clientTicketService.listClientSupportTickets(token);
  }

  async getClientSupportTicketDetail(ticketId: string, token?: string): Promise<ClientSupportTicketDetailDto> {
    return this.clientTicketService.getClientSupportTicketDetail(ticketId, token);
  }

  async markClientSupportTicketRead(
    ticketId: string,
    token?: string
  ): Promise<{ ok: boolean; ticketId: string; lastReadAt: string }> {
    return this.clientTicketService.markClientSupportTicketRead(ticketId, token);
  }

  async createClientSupportTicket(
    input: CreateClientSupportTicketInputDto,
    token?: string
  ): Promise<ClientSupportTicketDetailDto> {
    return this.clientTicketService.createClientSupportTicket(input, token);
  }

  async replyClientSupportTicket(
    ticketId: string,
    input: ReplyClientSupportTicketInputDto,
    token?: string
  ): Promise<ClientSupportTicketDetailDto> {
    return this.clientTicketService.replyClientSupportTicket(ticketId, input, token);
  }

  async replyClientSupportTicketWithAttachment(
    ticketId: string,
    input: { body?: string | null },
    file: UploadedTicketAttachmentFile | undefined,
    token?: string
  ): Promise<ClientSupportTicketDetailDto> {
    return this.clientTicketService.replyClientSupportTicketWithAttachment(ticketId, input, file, token);
  }

  async checkClientUpdate(input: ClientUpdateCheckDto): Promise<ClientUpdateCheckResultDto> {
    return this.releaseCenterService.checkClientUpdate(input);
  }

  async connect(request: ConnectRequestDto, token?: string): Promise<GeneratedRuntimeConfigDto> {
    return this.runtimeSessionService.connect(request, token);
  }

  async heartbeatSession(sessionId: string, token?: string) {
    return this.runtimeSessionService.heartbeatSession(sessionId, token);
  }

  async disconnect(sessionId: string, token?: string) {
    return this.runtimeSessionService.disconnect(sessionId, token);
  }

  async getActiveRuntime(sessionId?: string, token?: string) {
    return this.runtimeSessionService.getActiveRuntime(sessionId, token);
  }

  getActiveRuntimeUsageContext() {
    return this.runtimeSessionService.getActiveRuntimeUsageContext();
  }

  async getAdminSnapshot(): Promise<AdminSnapshotDto> {
    const [users, plans, subscriptions, teams, nodes, panelSyncJobs, leaseRevocationJobs, announcements, policy, releases, ticketCounts] =
      await Promise.all([
      this.listAdminUsers(),
      this.listAdminPlans(),
      this.listAdminSubscriptions(),
      this.listAdminTeams(),
      this.listAdminNodes(),
      this.listAdminPanelSyncJobs(),
      this.listAdminLeaseRevocationJobs(),
      this.listAdminAnnouncements(),
      this.getAdminPolicy(),
      this.listAdminReleases(),
      this.getSupportTicketDashboardCounts()
    ]);

    return {
      dashboard: {
        users: users.length,
        teams: teams.length,
        activeSubscriptions: subscriptions.filter((item) => item.state === "active").length,
        activeNodes: nodes.filter((item) => item.isActive).length,
        announcements: announcements.filter(isClientVisibleAdminAnnouncement).length,
        activePlans: plans.filter((item) => item.isActive).length,
        openTickets: ticketCounts.openTickets,
        waitingAdminTickets: ticketCounts.waitingAdminTickets,
        closedTickets: ticketCounts.closedTickets
      },
      users,
      plans,
      subscriptions,
      teams,
      nodes,
      panelSyncJobs,
      leaseRevocationJobs,
      announcements,
      policy,
      releases
    };
  }

  async getAdminDashboard(): Promise<DashboardSnapshotDto> {
    const now = new Date();
    let counts: [number, number, number, number, number, number, Awaited<ReturnType<typeof this.getSupportTicketDashboardCounts>>];
    try {
      counts = await Promise.all([
        this.prisma.user.count(),
        this.prisma.team.count(),
        this.prisma.plan.count({ where: { isActive: true } }),
        this.prisma.subscription.count({ where: { state: "active", expireAt: { gt: now }, remainingTrafficGb: { gt: 0 } } }),
        this.prisma.node.count({ where: { isActive: true } }),
        this.prisma.announcement.count({ where: { isActive: true, publishedAt: { lte: now } } }),
        this.getSupportTicketDashboardCounts()
      ]);
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "Admin dashboard is temporarily unavailable.");
    }
    const [users, teams, activePlans, activeSubscriptions, activeNodes, announcements, ticketCounts] = counts;

    return {
      users,
      teams,
      activePlans,
      activeSubscriptions,
      activeNodes,
      announcements,
      openTickets: ticketCounts.openTickets,
      waitingAdminTickets: ticketCounts.waitingAdminTickets,
      closedTickets: ticketCounts.closedTickets
    };
  }

  async listAdminSupportTickets(): Promise<AdminSupportTicketSummaryDto[]> {
    try {
      const rows = await this.prisma.supportTicket.findMany({
        include: {
          user: {
            select: { id: true, email: true, displayName: true }
          },
          team: {
            select: { id: true, name: true }
          },
          messages: {
            select: { body: true, createdAt: true },
            orderBy: { createdAt: "desc" },
            take: 1
          }
        },
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
        take: ADMIN_SUPPORT_TICKET_LIST_LIMIT
      });
      return rows.map(toAdminSupportTicketSummary);
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "Admin support ticket list is temporarily unavailable.");
    }
  }

  async getAdminSupportTicketDetail(ticketId: string): Promise<AdminSupportTicketDetailDto> {
    const row = await this.requireAdminSupportTicketDetail(ticketId);
    return toAdminSupportTicketDetail(row);
  }

  async replyAdminSupportTicket(
    ticketId: string,
    input: ReplyClientSupportTicketInputDto,
    adminUserId?: string | null
  ): Promise<AdminSupportTicketDetailDto> {
    const body = input.body.trim();
    if (!body) {
      throw new BadRequestException("回复内容不能为空");
    }

    if (body.length > 4000) {
      throw new BadRequestException("Reply body must not exceed 4000 characters.");
    }

    let current: any;
    try {
      current = await this.prisma.supportTicket.findUnique({
        where: { id: ticketId },
        include: {
          user: { select: { id: true, email: true, displayName: true } },
          team: { select: { id: true, name: true } },
          messages: {
            include: {
              authorUser: { select: { id: true, email: true, displayName: true } },
              attachments: { orderBy: { createdAt: "asc" } }
            },
            orderBy: { createdAt: "desc" },
            take: ADMIN_SUPPORT_TICKET_DETAIL_MESSAGE_LIMIT
          },
        }
      });
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "Admin support ticket detail is temporarily unavailable.");
    }
    if (!current) {
      throw new NotFoundException("工单不存在");
    }
    if (current.status === "closed") {
      throw new BadRequestException("当前工单已关闭，请先重新打开。");
    }

    current = {
      ...current,
      messages: [...(current.messages ?? [])].reverse()
    };
    const now = new Date();
    const messageId = createId("ticket_msg");
    try {
      await this.prisma.$transaction([
        this.prisma.supportTicketMessage.create({
          data: {
            id: messageId,
            ticketId,
            authorRole: "admin",
            authorUserId: adminUserId ?? null,
            body
          }
        }),
        this.prisma.supportTicket.update({
          where: { id: ticketId },
          data: {
            status: "waiting_user",
            lastMessageAt: now,
            closedAt: null
          }
        })
      ]);
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "工单回复保存失败，请刷新后重试。");
    }

    this.publishClientEventToUser(current.userId, {
      type: "ticket_updated",
      occurredAt: now.toISOString(),
      ticketId,
      ticketStatus: "waiting_user"
    });
    this.publishAdminTicketEventBestEffort(ticketId, "waiting_user");

    return this.getAdminSupportTicketDetailAfterReply(
      ticketId,
      () => this.buildAdminSupportTicketReplyFallback(current, now, {
        messageId,
        body,
        adminUserId: adminUserId ?? null,
        attachments: []
      })
    );
  }

  async replyAdminSupportTicketWithAttachment(
    ticketId: string,
    input: { body?: string | null },
    file: UploadedTicketAttachmentFile | undefined,
    adminUserId?: string | null
  ): Promise<AdminSupportTicketDetailDto> {
    const body = input.body?.trim() ?? "";
    if (!body && !file) {
      throw new BadRequestException("回复内容或附件不能为空");
    }

    if (body.length > 4000) {
      throw new BadRequestException("Reply body must not exceed 4000 characters.");
    }

    let current: any;
    try {
      current = await this.prisma.supportTicket.findUnique({
        where: { id: ticketId },
        include: {
          user: { select: { id: true, email: true, displayName: true } },
          team: { select: { id: true, name: true } },
          messages: {
            include: {
              authorUser: { select: { id: true, email: true, displayName: true } },
              attachments: { orderBy: { createdAt: "asc" } }
            },
            orderBy: { createdAt: "desc" },
            take: ADMIN_SUPPORT_TICKET_DETAIL_MESSAGE_LIMIT
          },
        }
      });
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "Admin support ticket detail is temporarily unavailable.");
    }
    if (!current) {
      throw new NotFoundException("工单不存在");
    }
    current = {
      ...current,
      messages: [...(current.messages ?? [])].reverse()
    };
    if (current.status === "closed") {
      throw new BadRequestException("当前工单已关闭，请先重新打开。");
    }

    let uploaded = null as Awaited<ReturnType<ImageBedService["uploadSupportTicketAttachment"]>> | null;
    if (file) {
      this.imageBedService.assertSupportTicketAttachment?.(file);
      try {
        uploaded = await this.imageBedService.uploadSupportTicketAttachment(file, {
          timeoutMs: TICKET_ATTACHMENT_UPLOAD_BUDGET_MS
        });
      } catch (error) {
        const attachmentUploadError = readPanelSyncErrorMessage(error);
        this.logger.warn(`Admin ticket attachment upload failed for ${ticketId}: ${attachmentUploadError}`);
        if (error instanceof HttpException) {
          throw error;
        }
        throw new ServiceUnavailableException("附件上传失败，未保存工单回复，请稍后重试。");
      }
    }
    const now = new Date();
    const messageId = createId("ticket_msg");
    const attachmentId = uploaded ? createId("ticket_att") : null;
    const messageBody = buildSupportTicketAttachmentReplyBody(
      body,
      uploaded ? `上传了附件：${uploaded.fileName}` : "",
      null
    );
    try {
      await this.prisma.$transaction(async (tx) => {
        const message = await tx.supportTicketMessage.create({
          data: {
            id: messageId,
            ticketId,
            authorRole: "admin",
            authorUserId: adminUserId ?? null,
            body: messageBody
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
            status: "waiting_user",
            lastMessageAt: now,
            closedAt: null
          }
        });
      });
    } catch (error) {
      await this.imageBedService.deleteUploadedSupportTicketAttachmentBestEffort(uploaded);
      throwLocalSaveAsServiceUnavailable(error, "工单回复保存失败，请刷新后重试；已尝试清理本次上传附件。");
    }

    this.publishClientEventToUser(current.userId, {
      type: "ticket_updated",
      occurredAt: now.toISOString(),
      ticketId,
      ticketStatus: "waiting_user"
    });
    this.publishAdminTicketEventBestEffort(ticketId, "waiting_user");

    const detail = await this.getAdminSupportTicketDetailAfterReply(
      ticketId,
      () => this.buildAdminSupportTicketReplyFallback(current, now, {
        messageId,
        body: messageBody,
        adminUserId: adminUserId ?? null,
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
      attachmentUploadStatus: file ? "uploaded" : "none",
      attachmentUploadError: null
    };
  }

  private async getAdminSupportTicketDetailAfterReply(
    ticketId: string,
    fallback: () => AdminSupportTicketDetailDto,
    actionLabel = "Admin ticket reply saved"
  ) {
    let settled = false;
    const detailTask = this.getAdminSupportTicketDetail(ticketId).then(
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
    const timeoutTask = new Promise<AdminSupportTicketDetailDto>((resolve) => {
      timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        this.logger.warn(
          `${actionLabel}, but detail refresh exceeded ${TICKET_DETAIL_REFRESH_BUDGET_MS}ms and will continue in background.`
        );
        resolve(fallback());
      }, TICKET_DETAIL_REFRESH_BUDGET_MS);
    });

    try {
      return await Promise.race([detailTask, timeoutTask]);
    } catch (error) {
      this.logger.warn(`${actionLabel}, but detail refresh failed for ${ticketId}: ${readPanelSyncErrorMessage(error)}`);
      return fallback();
    } finally {
      if (settled && timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private buildAdminSupportTicketReplyFallback(
    ticket: {
      id: string;
      title: string;
      status: SupportTicketStatus;
      source: SupportTicketSource;
      userId: string;
      subscriptionId: string | null;
      teamId: string | null;
      lastMessageAt: Date;
      closedAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
      user: { id: string; email: string; displayName: string };
      team?: { name: string } | null;
      messages?: Array<{
        id: string;
        ticketId: string;
        authorRole: SupportTicketAuthorRole;
        authorUserId: string | null;
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
        authorUser?: { id: string; email: string; displayName: string } | null;
      }>;
    },
    now: Date,
    message: {
      messageId: string;
      body: string;
      adminUserId: string | null;
      attachments: AdminSupportTicketDetailDto["messages"][number]["attachments"];
    }
  ): AdminSupportTicketDetailDto {
    const existingDetail = toAdminSupportTicketDetail({
      ...ticket,
      status: ticket.status,
      lastMessageAt: ticket.lastMessageAt,
      closedAt: ticket.closedAt,
      updatedAt: ticket.updatedAt,
      team: ticket.team ? { id: ticket.teamId ?? "", name: ticket.team.name } : null,
      messages: ticket.messages ?? []
    });
    const newMessage = {
      id: message.messageId,
      ticketId: ticket.id,
      authorRole: "admin" as const,
      authorUserId: message.adminUserId,
      authorDisplayName: readSupportTicketAuthorDisplayName("admin", null),
      authorEmail: null,
      body: message.body,
      attachments: message.attachments,
      createdAt: now.toISOString()
    };
    return {
      ...existingDetail,
      status: "waiting_user",
      lastMessageAt: now.toISOString(),
      closedAt: null,
      updatedAt: now.toISOString(),
      lastMessagePreview: summarizeSupportTicketMessage(message.body),
      messages: [...existingDetail.messages, newMessage]
    };
  }

  private buildAdminSupportTicketStatusFallback(
    ticket: Parameters<typeof toAdminSupportTicketDetail>[0],
    now: Date,
    status: SupportTicketStatus,
    closedAt: Date | null
  ): AdminSupportTicketDetailDto {
    const detail = toAdminSupportTicketDetail({
      ...ticket,
      lastMessageAt: ticket.lastMessageAt ?? now,
      closedAt: ticket.closedAt ?? null,
      updatedAt: ticket.updatedAt ?? now,
      messages: ticket.messages ?? []
    });
    return {
      ...detail,
      status,
      lastMessageAt: now.toISOString(),
      closedAt: closedAt?.toISOString() ?? null,
      updatedAt: now.toISOString()
    };
  }

  async closeAdminSupportTicket(ticketId: string): Promise<AdminSupportTicketDetailDto> {
    let current: any;
    try {
      current = await this.prisma.supportTicket.findUnique({
        where: { id: ticketId },
        include: {
          user: { select: { id: true, email: true, displayName: true } },
          team: { select: { id: true, name: true } },
          messages: {
            include: {
              authorUser: { select: { id: true, email: true, displayName: true } },
              attachments: { orderBy: { createdAt: "asc" } }
            },
            orderBy: { createdAt: "desc" },
            take: ADMIN_SUPPORT_TICKET_DETAIL_MESSAGE_LIMIT
          },
        }
      });
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "Admin support ticket detail is temporarily unavailable.");
    }
    if (!current) {
      throw new NotFoundException("工单不存在");
    }
    current = {
      ...current,
      messages: [...(current.messages ?? [])].reverse()
    };
    const now = new Date();
    const closedAt = current.status === "closed" ? current.closedAt ?? now : now;
    if (current.status !== "closed") {
      try {
        await this.prisma.supportTicket.update({
          where: { id: ticketId },
          data: {
            status: "closed",
            closedAt
          }
        });
      } catch (error) {
        throwLocalSaveAsServiceUnavailable(error, "工单保存失败，请刷新后重试。");
      }
    }
    this.publishClientEventToUser(current.userId, {
      type: "ticket_updated",
      occurredAt: now.toISOString(),
      ticketId,
      ticketStatus: "closed"
    });
    this.publishAdminTicketEventBestEffort(ticketId, "closed");
    return this.getAdminSupportTicketDetailAfterReply(
      ticketId,
      () => this.buildAdminSupportTicketStatusFallback(current, now, "closed", closedAt),
      "Admin ticket status saved"
    );
  }

  async reopenAdminSupportTicket(ticketId: string): Promise<AdminSupportTicketDetailDto> {
    let current: any;
    try {
      current = await this.prisma.supportTicket.findUnique({
        where: { id: ticketId },
        include: {
          user: { select: { id: true, email: true, displayName: true } },
          team: { select: { id: true, name: true } },
          messages: {
            include: {
              authorUser: { select: { id: true, email: true, displayName: true } },
              attachments: { orderBy: { createdAt: "asc" } }
            },
            orderBy: { createdAt: "desc" },
            take: ADMIN_SUPPORT_TICKET_DETAIL_MESSAGE_LIMIT
          },
        }
      });
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "Admin support ticket detail is temporarily unavailable.");
    }
    if (!current) {
      throw new NotFoundException("工单不存在");
    }
    current = {
      ...current,
      messages: [...(current.messages ?? [])].reverse()
    };
    const now = new Date();
    if (current.status === "closed") {
      try {
        await this.prisma.supportTicket.update({
          where: { id: ticketId },
          data: {
            status: "open",
            closedAt: null
          }
        });
      } catch (error) {
        throwLocalSaveAsServiceUnavailable(error, "工单保存失败，请刷新后重试。");
      }
    }
    this.publishClientEventToUser(current.userId, {
      type: "ticket_updated",
      occurredAt: now.toISOString(),
      ticketId,
      ticketStatus: "open"
    });
    this.publishAdminTicketEventBestEffort(ticketId, "open");
    return this.getAdminSupportTicketDetailAfterReply(
      ticketId,
      () => this.buildAdminSupportTicketStatusFallback(current, now, "open", null),
      "Admin ticket status saved"
    );
  }

  async listAdminReleases(input?: { platform?: PlatformTarget; status?: ReleaseStatus }): Promise<AdminReleaseRecordDto[]> {
    return this.releaseCenterService.listAdminReleases(input);
  }

  async createRelease(input: CreateReleaseInputDto): Promise<AdminReleaseRecordDto> {
    return this.releaseCenterService.createRelease(input);
  }

  async updateRelease(releaseId: string, input: UpdateReleaseInputDto): Promise<AdminReleaseRecordDto> {
    return this.releaseCenterService.updateRelease(releaseId, input);
  }

  async publishRelease(releaseId: string, publishedAt?: string | null): Promise<AdminReleaseRecordDto> {
    return this.releaseCenterService.publishRelease(releaseId, publishedAt);
  }

  async unpublishRelease(releaseId: string): Promise<AdminReleaseRecordDto> {
    return this.releaseCenterService.unpublishRelease(releaseId);
  }

  async deleteRelease(releaseId: string): Promise<{ ok: true; releaseId: string }> {
    return this.releaseCenterService.deleteRelease(releaseId);
  }

  async createReleaseArtifact(releaseId: string, input: CreateReleaseArtifactInputDto): Promise<AdminReleaseRecordDto> {
    return this.releaseCenterService.createReleaseArtifact(releaseId, input);
  }

  async updateReleaseArtifact(
    releaseId: string,
    artifactId: string,
    input: UpdateReleaseArtifactInputDto
  ): Promise<AdminReleaseRecordDto> {
    return this.releaseCenterService.updateReleaseArtifact(releaseId, artifactId, input);
  }

  async uploadReleaseArtifact(
    releaseId: string,
    input: UploadReleaseArtifactInputDto,
    file?: UploadedReleaseFile
  ): Promise<AdminReleaseRecordDto> {
    return this.releaseCenterService.uploadReleaseArtifact(releaseId, input, file);
  }

  async replaceReleaseArtifactUpload(
    releaseId: string,
    artifactId: string,
    input: UploadReleaseArtifactInputDto,
    file?: UploadedReleaseFile
  ): Promise<AdminReleaseRecordDto> {
    return this.releaseCenterService.replaceReleaseArtifactUpload(releaseId, artifactId, input, file);
  }

  async deleteReleaseArtifact(releaseId: string, artifactId: string): Promise<AdminReleaseRecordDto> {
    return this.releaseCenterService.deleteReleaseArtifact(releaseId, artifactId);
  }

  async getReleaseArtifactDownloadDescriptor(artifactId: string) {
    return this.releaseCenterService.getReleaseArtifactDownloadDescriptor(artifactId);
  }

  private async ensureReleaseExists(releaseId: string) {
    const row = await this.prisma.release.findUnique({
      where: { id: releaseId },
      select: { id: true, platform: true, status: true }
    });
    if (!row) {
      throw new NotFoundException("发布记录不存在");
    }
    return row;
  }

  private async getClientSupportTicketInbox(userId: string) {
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

  private async loadLatestAdminTicketMessageMap(ticketIds: string[]) {
    const uniqueTicketIds = Array.from(new Set(ticketIds.filter((item) => item.trim().length > 0)));
    const result = new Map<string, Date>();
    if (uniqueTicketIds.length === 0) {
      return result;
    }
    let rows: Array<{ ticketId: string; createdAt: Date }>;
    try {
      rows = await this.prisma.supportTicketMessage.findMany({
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
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "Support ticket unread state is temporarily unavailable.");
    }
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
                select: { id: true, email: true, displayName: true }
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

  private async requireAdminSupportTicketDetail(ticketId: string) {
    let row: any;
    try {
      row = await this.prisma.supportTicket.findUnique({
        where: { id: ticketId },
        include: {
          user: {
            select: { id: true, email: true, displayName: true }
          },
          team: {
            select: { id: true, name: true }
          },
          messages: {
            include: {
              authorUser: {
                select: { id: true, email: true, displayName: true }
              },
              attachments: {
                orderBy: { createdAt: "asc" }
              }
            },
            orderBy: { createdAt: "desc" },
            take: ADMIN_SUPPORT_TICKET_DETAIL_MESSAGE_LIMIT
          },
        }
      });
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "Admin support ticket detail is temporarily unavailable.");
    }
    if (!row) {
      throw new NotFoundException("工单不存在");
    }
    return {
      ...row,
      messages: [...(row.messages ?? [])].reverse()
    };
  }

  private async getSupportTicketDashboardCounts() {
    let counts: [number, number, number];
    try {
      counts = await Promise.all([
        this.prisma.supportTicket.count({
          where: { status: { in: ["open", "waiting_user"] } }
        }),
        this.prisma.supportTicket.count({
          where: { status: "waiting_admin" }
        }),
        this.prisma.supportTicket.count({
          where: { status: "closed" }
        })
      ]);
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "Support ticket dashboard counts are temporarily unavailable.");
    }
    const [openTickets, waitingAdminTickets, closedTickets] = counts;

    return {
      openTickets,
      waitingAdminTickets,
      closedTickets
    };
  }

  async listAdminUsers(): Promise<AdminUserRecordDto[]> {
    return this.adminSubscriptionService.listAdminUsers();
  }

  async updateCurrentAdminSecurity(
    authorization: string | undefined,
    input: UpdateCurrentAdminSecurityInputDto
  ): Promise<AdminSecurityUpdateResultDto> {
    const currentAdmin = await this.authSessionService.authenticateAccessToken(authorization);
    if (currentAdmin.role !== "admin") {
      throw new ForbiddenException("需要管理员权限");
    }

    const nextEmail = input.email.trim().toLowerCase();
    if (!nextEmail) {
      throw new BadRequestException("请输入新的管理员账号");
    }

    let admin: Awaited<ReturnType<PrismaService["user"]["findUnique"]>>;
    try {
      admin = await this.prisma.user.findUnique({
        where: { id: currentAdmin.id }
      });
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "管理员账号读取失败，请稍后重试。");
    }
    if (!admin || admin.role !== "admin" || admin.status !== "active") {
      throw new ForbiddenException("当前管理员不可用");
    }

    const passwordMatched = await bcrypt.compare(input.currentPassword, admin.passwordHash);
    if (!passwordMatched) {
      throw new UnauthorizedException("当前密码错误");
    }

    let existing: Awaited<ReturnType<PrismaService["user"]["findUnique"]>>;
    try {
      existing = await this.prisma.user.findUnique({
        where: { email: nextEmail }
      });
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "管理员账号邮箱校验失败，请稍后重试。");
    }
    if (existing && existing.id !== admin.id) {
      throw new ConflictException("该账号已被占用");
    }

    const nextPassword = input.newPassword?.trim();
    let updated: Awaited<ReturnType<PrismaService["user"]["update"]>>;
    try {
      updated = await this.updateCurrentAdminSecurityWithUniqueEmailGuard(async () =>
        this.prisma.$transaction(async (tx) => {
          const row = await tx.user.update({
            where: { id: admin.id },
            data: {
              email: nextEmail,
              ...(nextPassword ? { passwordHash: await bcrypt.hash(nextPassword, 10) } : {}),
              authVersion: { increment: 1 },
              lastSeenAt: new Date()
            }
          });
          await tx.refreshToken.updateMany({
            where: {
              userId: admin.id,
              revokedAt: null
            },
            data: {
              revokedAt: new Date()
            }
          });
          return row;
        })
      );
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "管理员安全设置保存失败，请稍后重试。");
    }

    try {
      return await this.authSessionService.issueSession(updated.id);
    } catch (error) {
      this.logger?.warn(
        `Admin security was saved, but issuing a replacement session failed for ${updated.id}: ${readPanelSyncErrorMessage(error)}`
      );
      return {
        ok: true,
        sessionRefreshRequired: true,
        message: "管理员安全设置已保存，请重新登录。"
      };
    }
  }

  async createUser(input: CreateUserInputDto): Promise<AdminUserRecordDto> {
    return this.adminSubscriptionService.createUser(input);
  }

  private async updateCurrentAdminSecurityWithUniqueEmailGuard<T>(task: () => Promise<T>): Promise<T> {
    try {
      return await task();
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) {
        throw new ConflictException("该账号已被占用");
      }
      throw error;
    }
  }

  async updateUser(userId: string, input: UpdateUserInputDto): Promise<AdminUserRecordDto> {
    return this.adminSubscriptionService.updateUser(userId, input);
  }

  async disconnectUser(userId: string): Promise<DisconnectUserResultDto> {
    return this.adminSubscriptionService.disconnectUser(userId);
  }

  async updateUserSecurity(userId: string, input: UpdateUserSecurityInputDto): Promise<AdminUserRecordDto> {
    return this.adminSubscriptionService.updateUserSecurity(userId, input);
  }

  async resetSubscriptionTraffic(
    subscriptionId: string,
    input: ResetSubscriptionTrafficInputDto = {}
  ): Promise<ResetSubscriptionTrafficResultDto> {
    return this.adminSubscriptionService.resetSubscriptionTraffic(subscriptionId, input);
  }

  async listAdminPlans(): Promise<AdminPlanRecordDto[]> {
    return this.adminSubscriptionService.listAdminPlans();
  }

  async createPlan(input: CreatePlanInputDto): Promise<AdminPlanRecordDto> {
    return this.adminSubscriptionService.createPlan(input);
  }

  async updatePlan(planId: string, input: UpdatePlanInputDto): Promise<AdminPlanRecordDto> {
    return this.adminSubscriptionService.updatePlan(planId, input);
  }

  async updatePlanSecurity(planId: string, input: UpdatePlanSecurityInputDto): Promise<AdminPlanRecordDto> {
    return this.adminSubscriptionService.updatePlanSecurity(planId, input);
  }

  async listAdminSubscriptions(): Promise<AdminSubscriptionRecordDto[]> {
    return this.adminSubscriptionService.listAdminSubscriptions();
  }

  async createSubscription(input: CreateSubscriptionInputDto): Promise<AdminSubscriptionRecordDto> {
    return this.adminSubscriptionService.createSubscription(input);
  }

  async renewSubscription(subscriptionId: string, input: RenewSubscriptionInputDto): Promise<AdminSubscriptionRecordDto> {
    return this.adminSubscriptionService.renewSubscription(subscriptionId, input);
  }

  async changeSubscriptionPlan(subscriptionId: string, input: ChangeSubscriptionPlanInputDto): Promise<AdminSubscriptionRecordDto> {
    return this.adminSubscriptionService.changeSubscriptionPlan(subscriptionId, input);
  }

  async updateSubscription(subscriptionId: string, input: UpdateSubscriptionInputDto): Promise<AdminSubscriptionRecordDto> {
    return this.adminSubscriptionService.updateSubscription(subscriptionId, input);
  }

  async convertPersonalSubscriptionToTeam(
    subscriptionId: string,
    input: ConvertSubscriptionToTeamInputDto
  ): Promise<ConvertSubscriptionToTeamResultDto> {
    return this.adminSubscriptionService.convertPersonalSubscriptionToTeam(subscriptionId, input);
  }

  async listAdminTeams(): Promise<AdminTeamRecordDto[]> {
    return this.adminSubscriptionService.listAdminTeams();
  }

  async createTeam(input: CreateTeamInputDto): Promise<AdminTeamRecordDto> {
    return this.adminSubscriptionService.createTeam(input);
  }

  async updateTeam(teamId: string, input: UpdateTeamInputDto): Promise<AdminTeamRecordDto> {
    return this.adminSubscriptionService.updateTeam(teamId, input);
  }

  async createTeamMember(teamId: string, input: CreateTeamMemberInputDto): Promise<AdminTeamRecordDto> {
    return this.adminSubscriptionService.createTeamMember(teamId, input);
  }

  async updateTeamMember(teamId: string, memberId: string, input: UpdateTeamMemberInputDto): Promise<AdminTeamRecordDto> {
    return this.adminSubscriptionService.updateTeamMember(teamId, memberId, input);
  }

  async deleteTeamMember(teamId: string, memberId: string) {
    return this.adminSubscriptionService.deleteTeamMember(teamId, memberId);
  }

  async kickTeamMember(teamId: string, memberId: string, input: KickTeamMemberInputDto): Promise<KickTeamMemberResultDto> {
    return this.adminSubscriptionService.kickTeamMember(teamId, memberId, input);
  }

  async createTeamSubscription(teamId: string, input: CreateTeamSubscriptionInputDto): Promise<AdminSubscriptionRecordDto> {
    return this.adminSubscriptionService.createTeamSubscription(teamId, input);
  }

  async getSubscriptionNodeAccess(subscriptionId: string): Promise<SubscriptionNodeAccessDto> {
    try {
      const subscription = await this.requireSubscription(subscriptionId);
      const rows = await this.prisma.subscriptionNodeAccess.findMany({
        where: { subscriptionId },
        include: { node: true },
        orderBy: [{ node: { recommended: "desc" } }, { node: { latencyMs: "asc" } }, { node: { createdAt: "desc" } }]
      });
      const deduped = dedupeNodeAccessRows(rows);

      return {
        subscriptionId: subscription.id,
        nodeIds: deduped.map((item) => item.nodeId),
        nodes: deduped.map((item) => toNodeSummary(item.node))
      };
    } catch (error) {
      const controlledError = toNodeAccessReadHttpError(error);
      if (controlledError) {
        throw controlledError;
      }
      this.logger?.error?.(
        `Node access read failed for ${subscriptionId}: ${readPanelSyncErrorMessage(error)}`,
        error instanceof Error ? error.stack : undefined
      );
      throw new ServiceUnavailableException("节点授权加载失败，请刷新订阅和节点列表后重试。");
    }
  }

  async updateSubscriptionNodeAccess(
    subscriptionId: string,
    input: UpdateSubscriptionNodeAccessInputDto
  ): Promise<SubscriptionNodeAccessDto> {
    if (!input || !Array.isArray(input.nodeIds)) {
      throw new BadRequestException("nodeIds must be an array.");
    }
    const nodeIds = input.nodeIds.map((nodeId) => {
      if (typeof nodeId !== "string") {
        throw new BadRequestException("nodeIds must contain only node id strings.");
      }
      const trimmed = nodeId.trim();
      if (!trimmed) {
        throw new BadRequestException("nodeIds must not contain empty values.");
      }
      return trimmed;
    });
    // Admin authorization changes are DB-first and must not wait behind slow usage/panel sync work.
    const localSaveFallbackRef: { current?: SubscriptionNodeAccessDto } = {};
    try {
      return await this.updateSubscriptionNodeAccessLocked(subscriptionId, { nodeIds }, (fallback) => {
        localSaveFallbackRef.current = fallback;
      });
    } catch (error) {
      const localSaveFallback = localSaveFallbackRef.current;
      if (!localSaveFallback) {
        const controlledError = toNodeAccessLocalSaveHttpError(error);
        if (controlledError) {
          throw controlledError;
        }
        this.logger?.error?.(
          `Node access local save failed for ${subscriptionId}: ${readPanelSyncErrorMessage(error)}`,
          error instanceof Error ? error.stack : undefined
        );
        throw new ServiceUnavailableException("节点授权保存失败，请刷新订阅和节点列表后重试；本次请求没有等待失联面板。");
      }
      const errorMessage = readPanelSyncErrorMessage(error);
      this.logger?.warn(`Node access local save completed, but finalize failed for ${subscriptionId}: ${errorMessage}`);
      return {
        ...localSaveFallback,
        panelSyncStatus: "pending",
        panelSyncMessage: [localSaveFallback.panelSyncMessage, `node access saved locally, but finalize failed: ${errorMessage}`]
          .filter(Boolean)
          .join(" "),
        message:
          localSaveFallback.message ??
          "Node access saved locally; panel synchronization is pending background retry."
      };
    }
  }

  private async updateSubscriptionNodeAccessLocked(
    subscriptionId: string,
    input: UpdateSubscriptionNodeAccessInputDto,
    markLocalSave?: (fallback: SubscriptionNodeAccessDto) => void
  ): Promise<SubscriptionNodeAccessDto> {
    const subscription = await this.requireSubscription(subscriptionId);

    const requestedNodeIds = [...new Set(input.nodeIds)];
    const existingRows = await this.prisma.subscriptionNodeAccess.findMany({
      where: { subscriptionId },
      select: { id: true, nodeId: true }
    });
    const existingNodeIds = new Set(existingRows.map((item) => item.nodeId));
    let revokedSessionCount = 0;
    let reasonCode: SessionReasonCode | null = null;
    let reasonMessage: string | null = null;
    let message: string | null = null;
    let panelSyncStatus: SubscriptionNodeAccessDto["panelSyncStatus"] = "synced";
    let panelSyncMessage: string | null = null;

    if (requestedNodeIds.length === 0) {
      if (existingRows.length > 0) {
        await this.prisma.$transaction(async (tx) => {
          await tx.subscriptionNodeAccess.deleteMany({
            where: { subscriptionId }
          });
        });
        const fallback: SubscriptionNodeAccessDto = {
          subscriptionId,
          nodeIds: [],
          nodes: [],
          revokedSessionCount,
          reasonCode: "node_access_revoked",
          reasonMessage: "All node access was revoked locally; panel synchronization is pending.",
          panelSyncStatus: "pending",
          panelSyncMessage: "local node access cleared; panel disable and lease revocation are pending background processing.",
          message: "Node access cleared locally; panel synchronization is pending background retry."
        };
        markLocalSave?.(fallback);
        const queuedRevocationMessage = await this.queueNodeAccessRevocationJobsAfterLocalSave(subscriptionId, undefined);
        panelSyncStatus = "pending";
        panelSyncMessage = queuedRevocationMessage ?? "3x-ui client disable and lease revocation jobs queued; local node access is already invalid.";
        reasonCode = "node_access_revoked";
        reasonMessage = "当前订阅的节点授权已全部取消，本地权限已立即失效；连接撤销任务会后台处理。";
        message = "节点授权已清空，本地权限已立即失效；连接撤销和面板同步任务已排队。";
      }

      this.publishNodeAccessUpdatedEventInBackground({
        subscriptionId,
        userId: subscription.userId,
        teamId: subscription.teamId
      });
      return {
        subscriptionId,
        nodeIds: [],
        nodes: [],
        revokedSessionCount,
        reasonCode,
        reasonMessage,
        panelSyncStatus,
        panelSyncMessage,
        message
      };
    }

    const availableNodes = await this.prisma.node.findMany({
      where: { id: { in: requestedNodeIds } }
    });
    const availableNodeIds = new Set(availableNodes.map((node) => node.id));
    const invalidAddedNodeIds = requestedNodeIds.filter((nodeId) => !availableNodeIds.has(nodeId) && !existingNodeIds.has(nodeId));
    const uniqueNodeIds = requestedNodeIds.filter((nodeId) => availableNodeIds.has(nodeId));

    if (invalidAddedNodeIds.length > 0) {
      panelSyncStatus = "pending";
      panelSyncMessage = [
        panelSyncMessage,
        `ignored stale node selections that are no longer available: ${invalidAddedNodeIds.join(", ")}`
      ]
        .filter(Boolean)
        .join(" ");
    }

    const removedNodeIds = existingRows
      .filter((item) => !uniqueNodeIds.includes(item.nodeId))
      .map((item) => item.nodeId);
    const addedNodeIds = uniqueNodeIds.filter((nodeId) => !existingNodeIds.has(nodeId));
    let queuedEnsureMessage: string | null = null;

    if (removedNodeIds.length > 0) {
      let queuedRevocationMessage: string | null = null;
      await this.prisma.$transaction(async (tx) => {
        await tx.subscriptionNodeAccess.deleteMany({
          where: {
            subscriptionId,
            nodeId: { in: removedNodeIds }
          }
        });
        if (addedNodeIds.length > 0) {
          await tx.subscriptionNodeAccess.createMany({
            data: addedNodeIds.map((nodeId) => ({
              id: createId("subscription_node"),
              subscriptionId,
              nodeId
            })),
            skipDuplicates: true
          });
        }
      });
      const fallbackNodes = uniqueNodeIds
        .map((nodeId) => availableNodes.find((node) => node.id === nodeId))
        .filter((node): node is (typeof availableNodes)[number] => Boolean(node));
      markLocalSave?.({
        subscriptionId,
        nodeIds: uniqueNodeIds,
        nodes: [],
        revokedSessionCount,
        reasonCode: "node_access_revoked",
        reasonMessage: "Node access was updated locally; revoked nodes are invalid locally immediately.",
        panelSyncStatus: "pending",
        panelSyncMessage: "local node access saved; panel disable and lease revocation are pending background processing.",
        message: "Node access saved locally; panel synchronization is pending background retry."
      });
      const fallback: SubscriptionNodeAccessDto = {
        subscriptionId,
        nodeIds: fallbackNodes.map((node) => node.id),
        nodes: this.buildNodeAccessSummaries(subscriptionId, fallbackNodes, "fallback").nodes,
        revokedSessionCount,
        reasonCode: "node_access_revoked",
        reasonMessage: "Node access was updated locally; revoked nodes are invalid locally immediately.",
        panelSyncStatus: "pending",
        panelSyncMessage: "local node access saved; panel disable and lease revocation are pending background processing.",
        message: "Node access saved locally; panel synchronization is pending background retry."
      };
      markLocalSave?.(fallback);
      queuedRevocationMessage = await this.queueNodeAccessRevocationJobsAfterLocalSave(subscriptionId, { nodeIds: removedNodeIds });
      if (addedNodeIds.length > 0) {
        queuedEnsureMessage = await this.queueSubscriptionPanelAccessSyncAfterLocalSave(subscriptionId);
      }
      panelSyncStatus = "pending";
      panelSyncMessage = [
        panelSyncMessage,
        queuedRevocationMessage ?? "3x-ui client disable and lease revocation jobs queued; local node access is already invalid."
      ]
        .filter(Boolean)
        .join(" ");
      reasonCode = "node_access_revoked";
      reasonMessage = "已取消部分节点授权，本地权限已立即失效；连接撤销任务会后台处理。";
      message = "节点授权已保存，已移除的节点本地权限已立即失效；连接撤销和面板同步任务已排队。";
      if (addedNodeIds.length === 0) {
        this.publishNodeAccessUpdatedEventInBackground({
          subscriptionId,
          userId: subscription.userId,
          teamId: subscription.teamId
        });
        return {
          subscriptionId,
          nodeIds: fallbackNodes.map((node) => node.id),
          nodes: this.buildNodeAccessSummaries(subscriptionId, fallbackNodes, "remove-only response").nodes,
          revokedSessionCount,
          reasonCode,
          reasonMessage,
          panelSyncStatus,
          panelSyncMessage,
          message
        };
      }
    }

    if (removedNodeIds.length === 0 && addedNodeIds.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        await tx.subscriptionNodeAccess.createMany({
          data: addedNodeIds.map((nodeId) => ({
            id: createId("subscription_node"),
            subscriptionId,
            nodeId
          })),
          skipDuplicates: true
        });
      });
      const fallbackNodes = uniqueNodeIds
        .map((nodeId) => availableNodes.find((node) => node.id === nodeId))
        .filter((node): node is (typeof availableNodes)[number] => Boolean(node));
      markLocalSave?.({
        subscriptionId,
        nodeIds: uniqueNodeIds,
        nodes: [],
        revokedSessionCount,
        reasonCode,
        reasonMessage,
        panelSyncStatus: "pending",
        panelSyncMessage: "local node access saved; panel ensure synchronization is pending background processing.",
        message: "Node access saved locally; panel synchronization is pending background retry."
      });
      const fallback: SubscriptionNodeAccessDto = {
        subscriptionId,
        nodeIds: fallbackNodes.map((node) => node.id),
        nodes: this.buildNodeAccessSummaries(subscriptionId, fallbackNodes, "fallback").nodes,
        revokedSessionCount,
        reasonCode,
        reasonMessage,
        panelSyncStatus: "pending",
        panelSyncMessage: "local node access saved; panel ensure synchronization is pending background processing.",
        message: "Node access saved locally; panel synchronization is pending background retry."
      };
      markLocalSave?.(fallback);
      queuedEnsureMessage = await this.queueSubscriptionPanelAccessSyncAfterLocalSave(subscriptionId);
    }

    if (addedNodeIds.length > 0) {
      panelSyncStatus = "pending";
      panelSyncMessage = [panelSyncMessage, queuedEnsureMessage ?? "panel access synchronization queued; local node access is already saved."]
        .filter(Boolean)
        .join(" ");
    }
    this.publishNodeAccessUpdatedEventInBackground({
      subscriptionId,
      userId: subscription.userId,
      teamId: subscription.teamId
    });

    const fallbackDeduped = uniqueNodeIds
      .map((nodeId) => availableNodes.find((node) => node.id === nodeId))
      .filter((node): node is (typeof availableNodes)[number] => Boolean(node))
      .map((node) => ({ nodeId: node.id, node }));
    let deduped: Array<{ nodeId: string; node: (typeof availableNodes)[number] }>;
    try {
      const rows = await this.withNodeAccessResponseRefreshBudget(
        subscriptionId,
        this.prisma.subscriptionNodeAccess.findMany({
          where: { subscriptionId },
          include: { node: true },
          orderBy: [{ node: { recommended: "desc" } }, { node: { latencyMs: "asc" } }, { node: { createdAt: "desc" } }]
        })
      );
      deduped = dedupeNodeAccessRows(rows);
    } catch (error) {
      const errorMessage = readPanelSyncErrorMessage(error);
      this.logger?.warn(`Node access saved, but response refresh failed for ${subscriptionId}: ${errorMessage}`);
      panelSyncStatus = "pending";
      panelSyncMessage = [panelSyncMessage, `local node access saved, but response refresh failed: ${errorMessage}`]
        .filter(Boolean)
        .join(" ");
      deduped = fallbackDeduped;
    }

    const responseSummary = this.buildNodeAccessSummaries(
      subscriptionId,
      deduped.map((item) => item.node),
      "response"
    );
    if (responseSummary.errorMessage) {
      panelSyncStatus = "pending";
      panelSyncMessage = [panelSyncMessage, responseSummary.errorMessage].filter(Boolean).join(" ");
    }

    return {
      subscriptionId,
      nodeIds: deduped.map((item) => item.nodeId),
      nodes: responseSummary.nodes,
      revokedSessionCount,
      reasonCode,
      reasonMessage,
      panelSyncStatus,
      panelSyncMessage,
      message: message ?? (panelSyncMessage ? `节点授权已保存。 ${panelSyncMessage}` : "节点授权已保存。")
    };
  }

  private async trySyncSubscriptionPanelAccess(subscriptionId: string) {
    try {
      const queuePanelAccessSync = (this.runtimeSessionService as { queueSubscriptionPanelAccessSync?: unknown })
        .queueSubscriptionPanelAccessSync;
      if (typeof queuePanelAccessSync !== "function") {
        return {
          ok: false as const,
          errorMessage: "runtime session service does not support queued panel access synchronization"
        };
      }
      const syncResult = await this.withNodeAccessPanelSyncBudget(
        subscriptionId,
        (queuePanelAccessSync as (subscriptionId: string) => Promise<number>).call(this.runtimeSessionService, subscriptionId)
      );
      if (!syncResult.ok) {
        return syncResult;
      }
      const queuedCount = syncResult.queuedCount;
      if (queuedCount > 0) {
        return { ok: false as const, errorMessage: "3x-ui panel sync queued for background retry" };
      }
      return { ok: true as const };
    } catch (error) {
      const errorMessage = readPanelSyncErrorMessage(error);
      this.logger?.warn(`节点授权已保存，但 3x-ui 客户端预同步失败：${subscriptionId}: ${errorMessage}`);
      return { ok: false as const, errorMessage };
    }
  }

  private async queueSubscriptionPanelAccessSyncAfterLocalSave(subscriptionId: string) {
    try {
      const result = await this.withNodeAccessPanelSyncBudget(
        subscriptionId,
        this.prisma.$transaction((tx) => this.queueSubscriptionPanelAccessSyncTx(tx, subscriptionId))
      );
      if (result.ok) {
        return result.queuedCount > 0
          ? "panel access synchronization queued; local node access is already saved."
          : "panel access synchronization checked; no panel changes were required.";
      }
      return [
        `panel access synchronization queued for background retry: ${result.errorMessage}`,
        this.startSubscriptionPanelAccessSync(subscriptionId)
      ]
        .filter(Boolean)
        .join(" ");
    } catch (error) {
      const errorMessage = readPanelSyncErrorMessage(error);
      this.logger?.warn(`Node access saved, but panel access sync queueing failed for ${subscriptionId}: ${errorMessage}`);
      return [
        `panel access synchronization queued for background retry: ${errorMessage}`,
        this.startSubscriptionPanelAccessSync(subscriptionId)
      ]
        .filter(Boolean)
        .join(" ");
    }
  }

  private async queueSubscriptionPanelAccessSyncTx(writer: any, subscriptionId: string) {
    const queuePanelAccessSyncTx = (this.runtimeSessionService as {
      queueSubscriptionPanelAccessSyncTx?: (writer: any, subscriptionId: string) => Promise<number>;
    }).queueSubscriptionPanelAccessSyncTx;
    if (typeof queuePanelAccessSyncTx !== "function") {
      throw new Error("runtime session service does not support transaction-scoped panel access queueing");
    }
    return queuePanelAccessSyncTx.call(this.runtimeSessionService, writer, subscriptionId);
  }

  private startSubscriptionPanelAccessSync(subscriptionId: string) {
    const timer = setTimeout(() => {
      void this.trySyncSubscriptionPanelAccess(subscriptionId)
        .then((result) => {
          if (!result.ok) {
            this.logger?.warn(`Node access saved, but async panel access sync is pending for ${subscriptionId}: ${result.errorMessage}`);
          }
        })
        .catch((error) => {
          this.logger?.warn(
            `Node access saved, but async panel access sync failed for ${subscriptionId}: ${readPanelSyncErrorMessage(error)}`
          );
        });
    }, NODE_ACCESS_DEFERRED_EFFECT_DELAY_MS);
    timer.unref?.();
    return "panel access synchronization queued for background processing; local node access is already saved.";
  }

  private async withNodeAccessPanelSyncBudget(
    subscriptionId: string,
    task: Promise<number>
  ): Promise<{ ok: true; queuedCount: number } | { ok: false; errorMessage: string }> {
    let settled = false;
    const guardedTask = task.then(
      (queuedCount) => {
        settled = true;
        return queuedCount;
      },
      (error) => {
        settled = true;
        throw error;
      }
    );
    void guardedTask.catch((error) => {
      this.logger?.warn(
        `Node access saved, but delayed panel access sync failed for ${subscriptionId}: ${readPanelSyncErrorMessage(error)}`
      );
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutTask = new Promise<{ ok: false; errorMessage: string }>((resolve) => {
      timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        this.logger?.warn(
          `Node access saved for ${subscriptionId}, but panel access sync exceeded ${NODE_ACCESS_FOLLOW_UP_BUDGET_MS}ms and will continue in background.`
        );
        resolve({
          ok: false,
          errorMessage: "panel access sync is still running in background; local node access is already saved."
        });
      }, NODE_ACCESS_FOLLOW_UP_BUDGET_MS);
    });

    try {
      const queuedCount = await Promise.race([guardedTask, timeoutTask]);
      return typeof queuedCount === "number" ? { ok: true, queuedCount } : queuedCount;
    } catch (error) {
      const errorMessage = readPanelSyncErrorMessage(error);
      this.logger?.warn(`Node access saved, but panel access sync failed for ${subscriptionId}: ${errorMessage}`);
      return { ok: false, errorMessage };
    } finally {
      if (settled && timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private async withNodeAccessResponseRefreshBudget<T>(subscriptionId: string, task: Promise<T>): Promise<T> {
    let settled = false;
    const guardedTask = task.then(
      (result) => {
        settled = true;
        return result;
      },
      (error) => {
        settled = true;
        throw error;
      }
    );
    void guardedTask.catch((error) => {
      this.logger?.warn(
        `Node access saved, but delayed response refresh failed for ${subscriptionId}: ${readPanelSyncErrorMessage(error)}`
      );
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutTask = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        reject(new Error("response refresh is still running in background; local node access is already saved."));
      }, NODE_ACCESS_FOLLOW_UP_BUDGET_MS);
    });

    try {
      return await Promise.race([guardedTask, timeoutTask]);
    } finally {
      if (settled && timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private async queuePanelDisableJobsForNodeAccessRevocation(
    subscriptionId: string,
    filter: { nodeIds?: string[] } | undefined
  ) {
    try {
      const pendingPanelSyncCount = await this.runtimeSessionService.markPanelBindingsDisabledForSubscription(
        subscriptionId,
        filter
      );
      if (pendingPanelSyncCount > 0) {
        return "3x-ui disable job queued; local node access and active sessions are invalidated.";
      }
      return null;
    } catch (error) {
      const errorMessage = readPanelSyncErrorMessage(error);
      this.logger?.warn(`Node access saved, but 3x-ui disable job queueing failed for ${subscriptionId}: ${errorMessage}`);
      return `3x-ui disable job queueing failed: ${errorMessage}`;
    }
  }

  private async queuePanelDisableJobsForNodeAccessRevocationTx(
    writer: any,
    subscriptionId: string,
    filter: { nodeIds?: string[] } | undefined
  ) {
    const pendingPanelSyncCount = await this.runtimeSessionService.queuePanelDisableJobsForSubscriptionTx(
      writer,
      subscriptionId,
      filter
    );
    if (pendingPanelSyncCount > 0) {
      return "3x-ui disable job queued; local node access and active sessions are invalidated.";
    }
    return null;
  }

  private async queueNodeAccessRevocationJobsAfterLocalSave(
    subscriptionId: string,
    filter: { nodeIds?: string[] } | undefined
  ) {
    try {
      const result = await this.withNodeAccessFollowUpBudget(
        subscriptionId,
        this.queueNodeAccessRevocationJobsPostCommitTx(subscriptionId, filter).then((panelSyncMessage) => ({
          revokedSessionCount: 0,
          panelSyncMessage
        }))
      );
      return result.panelSyncMessage;
    } catch (error) {
      const errorMessage = readPanelSyncErrorMessage(error);
      this.logger?.warn(`Node access saved, but revocation queueing failed for ${subscriptionId}: ${errorMessage}`);
      return [
        `node access revocation queueing failed: ${errorMessage}`,
        this.startNodeAccessRevocationEffects(subscriptionId, filter, "node_access_revoked")
      ]
        .filter(Boolean)
        .join(" ");
    }
  }

  private async queueNodeAccessRevocationJobsPostCommitTx(
    subscriptionId: string,
    filter: { nodeIds?: string[] } | undefined
  ) {
    const messages: string[] = [];
    let failed = false;

    try {
      const panelMessage = await this.prisma.$transaction((tx) =>
        this.queuePanelDisableJobsForNodeAccessRevocationTx(tx, subscriptionId, filter)
      );
      if (panelMessage) {
        messages.push(panelMessage);
      }
    } catch (error) {
      failed = true;
      const errorMessage = readPanelSyncErrorMessage(error);
      this.logger?.warn(`Node access saved, but panel disable job queueing failed for ${subscriptionId}: ${errorMessage}`);
      messages.push(`3x-ui disable job queueing failed: ${errorMessage}`);
    }

    try {
      const leaseJobCount = await this.prisma.$transaction((tx) =>
        this.runtimeSessionService.queueLeaseRevocationJobsForSubscriptionTx(
          tx,
          subscriptionId,
          "node_access_revoked",
          filter
        )
      );
      if (leaseJobCount > 0) {
        messages.push("lease revocation queued for background retry.");
      }
    } catch (error) {
      failed = true;
      const errorMessage = readPanelSyncErrorMessage(error);
      this.logger?.warn(`Node access saved, but lease revocation job queueing failed for ${subscriptionId}: ${errorMessage}`);
      messages.push(`lease revocation job queueing failed: ${errorMessage}`);
    }

    if (failed) {
      messages.push(this.startNodeAccessRevocationEffects(subscriptionId, filter, "node_access_revoked"));
    }

    return messages.length > 0
      ? messages.join(" ")
      : "3x-ui client disable and lease revocation jobs queued; local node access is already invalid.";
  }

  private async queueLeaseRevocationJobsForNodeAccessRevocation(
    subscriptionId: string,
    filter: { nodeIds?: string[] } | undefined
  ) {
    try {
      await this.prisma.$transaction((tx) =>
        this.runtimeSessionService.queueLeaseRevocationJobsForSubscriptionTx(
          tx,
          subscriptionId,
          "node_access_revoked",
          filter
        )
      );
      return null;
    } catch (error) {
      const errorMessage = readPanelSyncErrorMessage(error);
      this.logger?.warn(`Node access saved, but lease revocation job queueing failed for ${subscriptionId}: ${errorMessage}`);
      return `lease revocation job queueing failed: ${errorMessage}`;
    }
  }

  private async applyNodeAccessRevocationEffectsBestEffort(
    subscriptionId: string,
    filter: { nodeIds?: string[] } | undefined,
    reason: string
  ): Promise<NodeAccessRevocationEffects> {
    const [panelQueue, leaseQueue, leaseQueueFollowUp] = await Promise.all([
      this.withNodeAccessFollowUpBudget(
        subscriptionId,
        this.queuePanelDisableJobsForNodeAccessRevocation(subscriptionId, filter).then((panelSyncMessage) => ({
          revokedSessionCount: 0,
          panelSyncMessage
        }))
      ),
      this.withNodeAccessFollowUpBudget(
        subscriptionId,
        this.queueLeaseRevocationJobsForNodeAccessRevocation(subscriptionId, filter).then((panelSyncMessage) => ({
          revokedSessionCount: 0,
          panelSyncMessage
        }))
      ),
      this.withNodeAccessFollowUpBudget(
        subscriptionId,
        this.tryApplyNodeAccessRevocationEffects(subscriptionId, filter, reason)
      )
    ]);

    const panelSyncMessage = [panelQueue.panelSyncMessage, leaseQueue.panelSyncMessage, leaseQueueFollowUp.panelSyncMessage]
      .filter(Boolean)
      .join(" ");

    return {
      revokedSessionCount: leaseQueueFollowUp.revokedSessionCount,
      panelSyncMessage: panelSyncMessage || null
    };
  }

  private startNodeAccessRevocationEffects(
    subscriptionId: string,
    filter: { nodeIds?: string[] } | undefined,
    reason: string
  ) {
    const timer = setTimeout(() => {
      void this.applyNodeAccessRevocationEffectsBestEffort(subscriptionId, filter, reason)
        .then((result) => {
          if (result.panelSyncMessage) {
            this.logger?.warn(`Node access revocation follow-up for ${subscriptionId}: ${result.panelSyncMessage}`);
          }
        })
        .catch((error) => {
          this.logger?.warn(
            `Node access saved, but async revocation follow-up failed for ${subscriptionId}: ${readPanelSyncErrorMessage(error)}`
          );
        });
    }, NODE_ACCESS_DEFERRED_EFFECT_DELAY_MS);
    timer.unref?.();
    return "3x-ui 客户端禁用和连接撤销已进入后台处理，本地授权已立即失效。";
  }

  private startActiveNodeAccessRevocationEffects(
    subscriptionId: string,
    filter: { nodeIds?: string[] } | undefined,
    reason: string
  ) {
    const timer = setTimeout(() => {
      void this.withNodeAccessFollowUpBudget(
        subscriptionId,
        this.tryApplyNodeAccessRevocationEffects(subscriptionId, filter, reason)
      )
        .then((result) => {
          if (result.panelSyncMessage) {
            this.logger?.warn(`Node access lease revocation queue follow-up for ${subscriptionId}: ${result.panelSyncMessage}`);
          }
        })
        .catch((error) => {
          this.logger?.warn(
            `Node access saved, but async lease revocation queueing failed for ${subscriptionId}: ${readPanelSyncErrorMessage(error)}`
          );
        });
    }, NODE_ACCESS_DEFERRED_EFFECT_DELAY_MS);
    timer.unref?.();
    return "连接撤销已进入后台处理，本地授权已立即失效。";
  }

  private async withNodeAccessFollowUpBudget(
    subscriptionId: string,
    task: Promise<NodeAccessRevocationEffects>
  ): Promise<NodeAccessRevocationEffects> {
    let settled = false;
    const guardedTask = task.then(
      (result) => {
        settled = true;
        return result;
      },
      (error) => {
        settled = true;
        throw error;
      }
    );
    void guardedTask.catch((error) => {
      this.logger?.warn(
        `Node access saved, but delayed revocation follow-up failed for ${subscriptionId}: ${readPanelSyncErrorMessage(error)}`
      );
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutTask = new Promise<NodeAccessRevocationEffects>((resolve) => {
      timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        this.logger?.warn(
          `Node access saved for ${subscriptionId}, but revocation follow-up exceeded ${NODE_ACCESS_FOLLOW_UP_BUDGET_MS}ms and will continue in background.`
        );
        resolve({
          revokedSessionCount: 0,
          panelSyncMessage: "node access revocation follow-up is still running in background; local access is already saved."
        });
      }, NODE_ACCESS_FOLLOW_UP_BUDGET_MS);
    });

    try {
      return await Promise.race([guardedTask, timeoutTask]);
    } catch (error) {
      const errorMessage = readPanelSyncErrorMessage(error);
      this.logger?.warn(`Node access saved, but revocation follow-up failed for ${subscriptionId}: ${errorMessage}`);
      return {
        revokedSessionCount: 0,
        panelSyncMessage: `node access revocation follow-up failed: ${errorMessage}`
      };
    } finally {
      if (settled && timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private async tryApplyNodeAccessRevocationEffects(
    subscriptionId: string,
    filter: { nodeIds?: string[] } | undefined,
    reason: string,
    options: { queuedPanelSyncMessage?: string | null } = {}
  ): Promise<NodeAccessRevocationEffects> {
    const messages: string[] = [];
    let revokedSessionCount = 0;

    if (options.queuedPanelSyncMessage) {
      messages.push(options.queuedPanelSyncMessage);
    }

    try {
      const queuedLeaseRevocationCount = await this.runtimeSessionService.queueLeaseRevocationJobsForSubscription(
        subscriptionId,
        reason,
        filter
      );
      if (queuedLeaseRevocationCount > 0) {
        messages.push("lease revocation queued for background retry.");
      }
    } catch (error) {
      const errorMessage = readPanelSyncErrorMessage(error);
      this.logger?.warn(`Node access saved, but lease revocation job queueing failed for ${subscriptionId}: ${errorMessage}`);
      messages.push(`lease revocation job queueing failed: ${errorMessage}`);
    }

    return {
      revokedSessionCount,
      panelSyncMessage: messages.length > 0 ? messages.join(" ") : null
    };
  }

  async getTeamUsage(teamId: string): Promise<AdminTeamUsageRecordDto[]> {
    return this.adminSubscriptionService.getTeamUsage(teamId);
  }

  async listAdminNodes(): Promise<AdminNodeRecordDto[]> {
    return this.adminNodeService.listAdminNodes();
  }

  async listAdminPanelSyncJobs() {
    return this.adminNodeService.listPanelSyncJobs();
  }

  async retryAdminPanelSyncJob(jobId: string) {
    return this.adminNodeService.retryPanelSyncJob(jobId);
  }

  async retryAdminPanelSyncJobsForNode(nodeId: string) {
    return this.adminNodeService.retryPanelSyncJobsForNode(nodeId);
  }

  async listAdminLeaseRevocationJobs() {
    return this.adminNodeService.listLeaseRevocationJobs();
  }

  async retryAdminLeaseRevocationJob(jobId: string) {
    return this.adminNodeService.retryLeaseRevocationJob(jobId);
  }

  async retryAdminLeaseRevocationJobsForNode(nodeId: string) {
    return this.adminNodeService.retryLeaseRevocationJobsForNode(nodeId);
  }

  async importNodeFromSubscription(input: ImportNodeInputDto): Promise<AdminNodeRecordDto> {
    return this.adminNodeService.importNodeFromSubscription(input);
  }

  async listNodePanelInbounds(input: {
    panelBaseUrl: string;
    panelApiBasePath?: string;
    panelUsername: string;
    panelPassword: string;
  }): Promise<AdminNodePanelInboundDto[]> {
    return this.adminNodeService.listNodePanelInbounds(input);
  }

  async updateNode(nodeId: string, input: UpdateNodeInputDto): Promise<AdminNodeRecordDto> {
    return this.adminNodeService.updateNode(nodeId, input);
  }

  async refreshNode(nodeId: string): Promise<AdminNodeRecordDto> {
    return this.adminNodeService.refreshNode(nodeId);
  }

  async probeNode(nodeId: string): Promise<AdminNodeRecordDto> {
    return this.adminNodeService.probeNode(nodeId);
  }

  async probeAllNodes() {
    return this.adminNodeService.probeAllNodes();
  }

  async deleteNode(nodeId: string) {
    return this.adminNodeService.deleteNode(nodeId);
  }

  async listAdminAnnouncements(): Promise<AdminAnnouncementRecordDto[]> {
    return this.announcementPolicyService.listAdminAnnouncements();
  }

  async createAnnouncement(input: CreateAnnouncementInputDto): Promise<AdminAnnouncementRecordDto> {
    return this.announcementPolicyService.createAnnouncement(input);
  }

  async updateAnnouncement(announcementId: string, input: UpdateAnnouncementInputDto): Promise<AdminAnnouncementRecordDto> {
    return this.announcementPolicyService.updateAnnouncement(announcementId, input);
  }

  async deleteAnnouncement(announcementId: string) {
    return this.announcementPolicyService.deleteAnnouncement(announcementId);
  }

  async getAdminPolicy(): Promise<AdminPolicyRecordDto> {
    return this.announcementPolicyService.getAdminPolicy();
  }

  async updatePolicy(input: UpdatePolicyInputDto): Promise<AdminPolicyRecordDto> {
    return this.announcementPolicyService.updatePolicy(input);
  }

  async getUsers(): Promise<UserProfileDto[]> {
    const rows = await this.prisma.user.findMany({
      orderBy: { createdAt: "asc" }
    });
    return rows.map(toUserProfile);
  }

  private async requireSubscription(subscriptionId: string) {
    const row = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: {
        plan: true,
        user: true,
        team: true
      }
    });
    if (!row) {
      throw new NotFoundException("订阅不存在");
    }
    return row;
  }

  private buildNodeAccessSummaries(
    subscriptionId: string,
    nodes: Array<Parameters<typeof toNodeSummary>[0]>,
    context: string
  ): { nodes: NodeSummaryDto[]; errorMessage: string | null } {
    const summaries: NodeSummaryDto[] = [];
    const errors: string[] = [];
    for (const node of nodes) {
      try {
        summaries.push(toNodeSummary(node));
      } catch (error) {
        const message = readPanelSyncErrorMessage(error);
        errors.push(message);
        this.logger?.warn(`Node access saved, but ${context} node summary failed for ${subscriptionId}: ${message}`);
      }
    }
    return {
      nodes: summaries,
      errorMessage: errors.length > 0 ? `node summary failed: ${errors.join("; ")}` : null
    };
  }
}

function shouldAutoBootstrapDevData() {
  const flag = process.env.CHORDV_DEV_BOOTSTRAP?.trim().toLowerCase();
  if (flag === "true") {
    if (process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test") {
      throw new Error("Development data bootstrap is allowed only when NODE_ENV is development or test.");
    }
    return true;
  }
  if (flag === "false") {
    return false;
  }
  return false;
}

function readPanelSyncErrorMessage(error: unknown) {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : "3x-ui 客户端预同步失败";
}

function isPrismaUniqueConstraintError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

function isPrismaForeignKeyConstraintError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2003";
}

function isPrismaRecordNotFoundError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2025";
}

function toNodeAccessLocalSaveHttpError(error: unknown) {
  if (error instanceof HttpException) {
    return error;
  }
  if (isPrismaUniqueConstraintError(error)) {
    return new ConflictException("节点授权已被其他操作修改，请刷新后重试。");
  }
  if (isPrismaForeignKeyConstraintError(error) || isPrismaRecordNotFoundError(error)) {
    return new BadRequestException("节点授权数据已变化，请刷新订阅和节点列表后重试。");
  }
  const transientError = toPrismaTransientHttpError(error, "节点授权保存暂时繁忙，请刷新后重试；本次请求没有等待失联面板。");
  if (transientError) return transientError;
  return new ServiceUnavailableException("节点授权保存失败，请刷新订阅和节点列表后重试；本次请求没有等待失联面板。");
}

function toNodeAccessReadHttpError(error: unknown) {
  if (error instanceof HttpException) {
    return error;
  }
  if (isPrismaForeignKeyConstraintError(error) || isPrismaRecordNotFoundError(error)) {
    return new BadRequestException("节点授权数据已变化，请刷新订阅和节点列表后重试。");
  }
  const transientError = toPrismaTransientHttpError(error, "节点授权加载暂时繁忙，请稍后重试。");
  if (transientError) return transientError;
  return null;
}

function buildSupportTicketAttachmentReplyBody(body: string, attachmentFallbackBody: string, attachmentUploadError: string | null) {
  const baseBody = body || attachmentFallbackBody || "附件上传失败";
  if (!attachmentUploadError) {
    return baseBody;
  }
  const notice = "附件上传失败，文字回复已保存。请检查图床配置或稍后重试。";
  return body ? `${baseBody}\n\n${notice}` : notice;
}

function readPositiveIntegerEnv(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function isClientVisibleAdminAnnouncement(item: AdminAnnouncementRecordDto) {
  return item.isActive && new Date(item.publishedAt).getTime() <= Date.now();
}
