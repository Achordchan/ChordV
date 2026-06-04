import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  UnauthorizedException
} from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type {
  AdminAnnouncementRecordDto,
  AdminNodeRecordDto,
  AdminNodePanelInboundDto,
  AdminPlanRecordDto,
  AdminPolicyRecordDto,
  AdminReleaseArtifactDto,
  AdminReleaseArtifactValidationDto,
  AdminReleaseRecordDto,
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
  GeneratedRuntimeConfigDto,
  ImportNodeInputDto,
  MarkClientAnnouncementsReadInputDto,
  NodeProbeStatus,
  NodeSummaryDto,
  DashboardSnapshotDto,
  PlatformTarget,
  PolicyBundleDto,
  ReleaseArtifactType,
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
  UpdateDeliveryMode,
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
import {
  assertExternalReleaseArtifactUrlMatchesType,
  buildReleaseArtifactDownloadUrl,
  buildReleaseArtifactDownloadUrlForClient,
  calculateFileSha256,
  compareSemver,
  createId,
  defaultDeliveryModeForPlatform,
  fetchExternalReleaseArtifactMetadata,
  fromPrismaReleaseArtifactType,
  normalizeReleaseChannel,
  releaseArtifactStorageRoot,
  resolveReleaseArtifactAbsolutePath,
  sanitizeReleaseArtifactFileName,
  normalizeBigInt,
  normalizeChangelog,
  normalizeNullableText,
  normalizeOptionalBoolean,
  normalizePublishedAt,
  normalizeVersion,
  assertReleaseArtifactTypeAllowed as assertReleaseArtifactTypeAllowedForRelease,
  defaultDeliveryModeForArtifact,
  ensureFileReadable,
  removeReleaseArtifactDirectory,
  removeReleaseArtifactFile,
  toAdminReleaseArtifactRecord,
  toAdminReleaseRecord,
  toPrismaReleaseArtifactType
} from "./release-center.utils";
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
    await this.tryPublishEvent("subscription_updated", () => this.clientEventsPublisher.publishSubscriptionUpdated(target));
  }

  private async publishNodeAccessUpdatedEvent(target: {
    subscriptionId?: string | null;
    userId?: string | null;
    teamId?: string | null;
  }) {
    await this.tryPublishEvent("node_access_updated", () => this.clientEventsPublisher.publishNodeAccessUpdated(target));
  }

  private async tryPublishEvent(eventType: string, task: () => Promise<unknown>) {
    try {
      await task();
    } catch (error) {
      this.logger?.warn(`Local change saved, but ${eventType} publish failed: ${readPanelSyncErrorMessage(error)}`);
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
    const [users, plans, subscriptions, teams, nodes, panelSyncJobs, announcements, policy, releases, ticketCounts] = await Promise.all([
      this.listAdminUsers(),
      this.listAdminPlans(),
      this.listAdminSubscriptions(),
      this.listAdminTeams(),
      this.listAdminNodes(),
      this.listAdminPanelSyncJobs(),
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
        announcements: announcements.filter((item) => item.isActive).length,
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
      announcements,
      policy,
      releases
    };
  }

  async getAdminDashboard(): Promise<DashboardSnapshotDto> {
    const [users, teams, activePlans, activeSubscriptions, activeNodes, announcements, ticketCounts] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.team.count(),
      this.prisma.plan.count({ where: { isActive: true } }),
      this.prisma.subscription.count({ where: { state: "active" } }),
      this.prisma.node.count({ where: { isActive: true } }),
      this.prisma.announcement.count({ where: { isActive: true } }),
      this.getSupportTicketDashboardCounts()
    ]);

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
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }]
    });
    return rows.map(toAdminSupportTicketSummary);
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

    const current = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: { id: true, status: true, userId: true }
    });
    if (!current) {
      throw new NotFoundException("工单不存在");
    }
    if (current.status === "closed") {
      throw new BadRequestException("当前工单已关闭，请先重新打开。");
    }

    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.supportTicketMessage.create({
        data: {
          id: createId("ticket_msg"),
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

    this.publishClientEventToUser(current.userId, {
      type: "ticket_updated",
      occurredAt: now.toISOString(),
      ticketId,
      ticketStatus: "waiting_user"
    });

    return this.getAdminSupportTicketDetail(ticketId);
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

    const current = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: { id: true, status: true, userId: true }
    });
    if (!current) {
      throw new NotFoundException("工单不存在");
    }
    if (current.status === "closed") {
      throw new BadRequestException("当前工单已关闭，请先重新打开。");
    }

    const uploaded = file ? await this.imageBedService.uploadSupportTicketAttachment(file) : null;
    const now = new Date();
    try {
      await this.prisma.$transaction(async (tx) => {
        const message = await tx.supportTicketMessage.create({
          data: {
            id: createId("ticket_msg"),
            ticketId,
            authorRole: "admin",
            authorUserId: adminUserId ?? null,
            body: body || (uploaded ? `上传了附件：${uploaded.fileName}` : "")
          }
        });
        if (uploaded) {
          await tx.supportTicketAttachment.create({
            data: {
              id: createId("ticket_att"),
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
      throw error;
    }

    this.publishClientEventToUser(current.userId, {
      type: "ticket_updated",
      occurredAt: now.toISOString(),
      ticketId,
      ticketStatus: "waiting_user"
    });

    return this.getAdminSupportTicketDetail(ticketId);
  }

  async closeAdminSupportTicket(ticketId: string): Promise<AdminSupportTicketDetailDto> {
    const current = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: { id: true, status: true, closedAt: true, userId: true }
    });
    if (!current) {
      throw new NotFoundException("工单不存在");
    }
    if (current.status !== "closed") {
      await this.prisma.supportTicket.update({
        where: { id: ticketId },
        data: {
          status: "closed",
          closedAt: new Date()
        }
      });
    }
    this.publishClientEventToUser(current.userId, {
      type: "ticket_updated",
      occurredAt: new Date().toISOString(),
      ticketId,
      ticketStatus: "closed"
    });
    return this.getAdminSupportTicketDetail(ticketId);
  }

  async reopenAdminSupportTicket(ticketId: string): Promise<AdminSupportTicketDetailDto> {
    const current = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: { id: true, status: true, userId: true }
    });
    if (!current) {
      throw new NotFoundException("工单不存在");
    }
    if (current.status === "closed") {
      await this.prisma.supportTicket.update({
        where: { id: ticketId },
        data: {
          status: "open",
          closedAt: null
        }
      });
    }
    this.publishClientEventToUser(current.userId, {
      type: "ticket_updated",
      occurredAt: new Date().toISOString(),
      ticketId,
      ticketStatus: "open"
    });
    return this.getAdminSupportTicketDetail(ticketId);
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

  async validateReleaseArtifact(releaseId: string, artifactId: string): Promise<AdminReleaseArtifactValidationDto> {
    return this.releaseCenterService.validateReleaseArtifact(releaseId, artifactId);
  }

  async getReleaseArtifactDownloadDescriptor(artifactId: string) {
    return this.releaseCenterService.getReleaseArtifactDownloadDescriptor(artifactId);
  }

  private async prepareUploadedReleaseArtifactFile(
    releaseId: string,
    artifactId: string,
    file: UploadedReleaseFile,
    preferredFileName?: string | null
  ) {
    const finalFileName = sanitizeReleaseArtifactFileName(preferredFileName?.trim() || file.originalname || `${artifactId}.bin`);
    const storedFilePath = path.join(releaseId, artifactId, finalFileName);
    const absolutePath = resolveReleaseArtifactAbsolutePath(storedFilePath);

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.rm(absolutePath, { force: true });
    await fs.rename(file.path, absolutePath);

    return {
      absolutePath,
      storedFilePath,
      fileName: finalFileName,
      fileSizeBytes: BigInt(file.size),
      fileHash: await calculateFileSha256(absolutePath),
      downloadUrl: buildReleaseArtifactDownloadUrl(artifactId)
    };
  }

  private async getAdminRelease(releaseId: string): Promise<AdminReleaseRecordDto> {
    const row = await this.prisma.release.findUnique({
      where: { id: releaseId },
      include: {
        artifacts: {
          orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }]
        }
      }
    });
    if (!row) {
      throw new NotFoundException("发布记录不存在");
    }
    return toAdminReleaseRecord(row);
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

  private async ensureReleaseArtifactExists(releaseId: string, artifactId: string) {
    const row = await this.prisma.releaseArtifact.findFirst({
      where: {
        id: artifactId,
        releaseId
      },
      select: { id: true }
    });
    if (!row) {
      throw new NotFoundException("发布产物不存在");
    }
    return row;
  }

  private async getClientSupportTicketInbox(userId: string) {
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
    const row = await this.prisma.supportTicket.findFirst({
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
    if (!row) {
      throw new NotFoundException("工单不存在");
    }
    return row;
  }

  private async requireAdminSupportTicketDetail(ticketId: string) {
    const row = await this.prisma.supportTicket.findUnique({
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
          orderBy: { createdAt: "asc" }
        }
      }
    });
    if (!row) {
      throw new NotFoundException("工单不存在");
    }
    return row;
  }

  private async getSupportTicketDashboardCounts() {
    const [openTickets, waitingAdminTickets, closedTickets] = await Promise.all([
      this.prisma.supportTicket.count({
        where: {
          status: {
            in: ["open", "waiting_admin", "waiting_user"]
          }
        }
      }),
      this.prisma.supportTicket.count({
        where: { status: "waiting_admin" }
      }),
      this.prisma.supportTicket.count({
        where: { status: "closed" }
      })
    ]);

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
  ): Promise<AuthSessionDto> {
    const currentAdmin = await this.authSessionService.authenticateAccessToken(authorization);
    if (currentAdmin.role !== "admin") {
      throw new ForbiddenException("需要管理员权限");
    }

    const nextEmail = input.email.trim().toLowerCase();
    if (!nextEmail) {
      throw new BadRequestException("请输入新的管理员账号");
    }

    const admin = await this.prisma.user.findUnique({
      where: { id: currentAdmin.id }
    });
    if (!admin || admin.role !== "admin" || admin.status !== "active") {
      throw new ForbiddenException("当前管理员不可用");
    }

    const passwordMatched = await bcrypt.compare(input.currentPassword, admin.passwordHash);
    if (!passwordMatched) {
      throw new UnauthorizedException("当前密码错误");
    }

    const existing = await this.prisma.user.findUnique({
      where: { email: nextEmail }
    });
    if (existing && existing.id !== admin.id) {
      throw new ConflictException("该账号已被占用");
    }

    const nextPassword = input.newPassword?.trim();
    const updated = await this.prisma.$transaction(async (tx) => {
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
    });

    return this.authSessionService.issueSession(updated.id);
  }

  async createUser(input: CreateUserInputDto): Promise<AdminUserRecordDto> {
    return this.adminSubscriptionService.createUser(input);
  }

  async updateUser(userId: string, input: UpdateUserInputDto): Promise<AdminUserRecordDto> {
    return this.adminSubscriptionService.updateUser(userId, input);
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

  private async assertReleasePublishable(releaseId: string) {
    const release = await this.prisma.release.findUnique({
      where: { id: releaseId },
      include: {
        artifacts: {
          orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }]
        }
      }
    });
    if (!release) {
      throw new NotFoundException("发布记录不存在");
    }
    const primaryArtifact = release.artifacts.find((item) => item.isPrimary) ?? release.artifacts[0];
    if (!primaryArtifact) {
      throw new BadRequestException("请先上传或配置至少一个安装产物，再发布版本");
    }
    const validation = await this.validateReleaseArtifact(releaseId, primaryArtifact.id);
    if (validation.status !== "ready") {
      throw new BadRequestException(`主下载产物当前不可发布：${validation.message}`);
    }
  }

  private assertReleaseArtifactsMutable(release: { status: string }) {
    if (release.status === "published") {
      throw new BadRequestException("请先撤回发布，再调整安装产物。");
    }
  }

  private async prepareInitialExternalReleaseArtifact(
    platform: PlatformTarget,
    releaseId: string,
    input: CreateReleaseArtifactInputDto
  ) {
    const source = input.source ?? "external";
    if (source !== "external") {
      throw new BadRequestException("首个安装产物只支持外部链接，请先创建草稿后再走上传接口。");
    }
    assertReleaseArtifactTypeAllowedForRelease(platform, input.type);
    assertExternalReleaseArtifactUrlMatchesType(input.type, input.downloadUrl);

    const defaultMirrorPrefix = normalizeNullableText(input.defaultMirrorPrefix);
    const externalMetadata = await fetchExternalReleaseArtifactMetadata(
      input.downloadUrl,
      defaultMirrorPrefix
    );
    const artifactId = createId("artifact");
    const isFullPackage = normalizeOptionalBoolean(input.isFullPackage);

    return {
      id: artifactId,
      releaseId,
      source,
      type: toPrismaReleaseArtifactType(input.type),
      deliveryMode: input.deliveryMode ?? defaultDeliveryModeForArtifact(input.type),
      downloadUrl: input.downloadUrl.trim(),
      defaultMirrorPrefix,
      allowClientMirror: input.allowClientMirror ?? true,
      fileName: externalMetadata?.fileName ?? normalizeNullableText(input.fileName),
      storedFilePath: null,
      fileSizeBytes: externalMetadata?.fileSizeBytes ?? normalizeBigInt(input.fileSizeBytes),
      fileHash: externalMetadata?.fileHash ?? normalizeNullableText(input.fileHash),
      isPrimary: true,
      isFullPackage: isFullPackage ?? true
    };
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
  }

  async updateSubscriptionNodeAccess(
    subscriptionId: string,
    input: UpdateSubscriptionNodeAccessInputDto
  ): Promise<SubscriptionNodeAccessDto> {
    return runWithSubscriptionUsageLock(subscriptionId, () => this.updateSubscriptionNodeAccessLocked(subscriptionId, input));
  }

  private async updateSubscriptionNodeAccessLocked(
    subscriptionId: string,
    input: UpdateSubscriptionNodeAccessInputDto
  ): Promise<SubscriptionNodeAccessDto> {
    const subscription = await this.requireSubscription(subscriptionId);

    const uniqueNodeIds = [...new Set(input.nodeIds)];
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

    if (uniqueNodeIds.length === 0) {
      if (existingRows.length > 0) {
        await this.prisma.$transaction(async (tx) => {
          await tx.subscriptionNodeAccess.deleteMany({
            where: { subscriptionId }
          });
        });
        const queuedPanelSyncMessage = await this.queuePanelDisableJobsForNodeAccessRevocation(subscriptionId, undefined);
        const revocation = await this.tryApplyNodeAccessRevocationEffects(
          subscriptionId,
          undefined,
          "node_access_revoked",
          { queuedPanelSyncMessage }
        );
        revokedSessionCount = revocation.revokedSessionCount;
        if (revocation.panelSyncMessage) {
          panelSyncStatus = "pending";
          panelSyncMessage = revocation.panelSyncMessage;
          panelSyncMessage = "3x-ui 客户端禁用已加入后台队列，本地授权和当前连接已立即失效。";
        }
        panelSyncMessage = revocation.panelSyncMessage ?? panelSyncMessage;
        reasonCode = "node_access_revoked";
        reasonMessage = "当前订阅的节点授权已全部取消，现有连接会立即失效。";
        message =
          revokedSessionCount > 0
            ? `节点授权已清空，已断开 ${revokedSessionCount} 条现有连接。${panelSyncMessage ? ` ${panelSyncMessage}` : ""}`
            : `节点授权已清空，当前没有活跃连接。${panelSyncMessage ? ` ${panelSyncMessage}` : ""}`;
      }

      await this.publishNodeAccessUpdatedEvent({
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
      where: { id: { in: uniqueNodeIds } }
    });

    if (availableNodes.length !== uniqueNodeIds.length) {
      throw new BadRequestException("存在无效节点");
    }

    const removedNodeIds = existingRows
      .filter((item) => !uniqueNodeIds.includes(item.nodeId))
      .map((item) => item.nodeId);
    const addedNodeIds = uniqueNodeIds.filter((nodeId) => !existingNodeIds.has(nodeId));

    if (removedNodeIds.length > 0) {
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
            }))
          });
        }
      });
      const queuedPanelSyncMessage = await this.queuePanelDisableJobsForNodeAccessRevocation(subscriptionId, {
        nodeIds: removedNodeIds
      });
      const revocation = await this.tryApplyNodeAccessRevocationEffects(
        subscriptionId,
        { nodeIds: removedNodeIds },
        "node_access_revoked",
        { queuedPanelSyncMessage }
      );
      revokedSessionCount = revocation.revokedSessionCount;
      if (revocation.panelSyncMessage) {
        panelSyncStatus = "pending";
        panelSyncMessage = revocation.panelSyncMessage;
        panelSyncMessage = "3x-ui 客户端禁用已加入后台队列，本地授权和当前连接已立即失效。";
      }
      panelSyncMessage = revocation.panelSyncMessage ?? panelSyncMessage;
      reasonCode = "node_access_revoked";
      reasonMessage = "已取消部分节点授权，正在使用这些节点的连接会立即失效。";
      message =
        revokedSessionCount > 0
          ? `节点授权已保存，已断开 ${revokedSessionCount} 条受影响连接。${panelSyncMessage ? ` ${panelSyncMessage}` : ""}`
          : `节点授权已保存。${panelSyncMessage ? ` ${panelSyncMessage}` : ""}`;
    }

    if (removedNodeIds.length === 0 && addedNodeIds.length > 0) {
      await this.prisma.subscriptionNodeAccess.createMany({
        data: addedNodeIds.map((nodeId) => ({
          id: createId("subscription_node"),
          subscriptionId,
          nodeId
        }))
      });
    }

    if (addedNodeIds.length > 0) {
      const panelSync = await this.trySyncSubscriptionPanelAccess(subscriptionId);
      if (!panelSync.ok) {
        panelSyncStatus = "pending";
        panelSyncMessage = `节点授权已保存，但 3x-ui 客户端预同步失败，将在连接时重试：${panelSync.errorMessage}`;
      }
    }
    await this.publishNodeAccessUpdatedEvent({
      subscriptionId,
      userId: subscription.userId,
      teamId: subscription.teamId
    });

    let deduped: Array<{ nodeId: string; node: (typeof availableNodes)[number] }>;
    try {
      const rows = await this.prisma.subscriptionNodeAccess.findMany({
        where: { subscriptionId },
        include: { node: true },
        orderBy: [{ node: { recommended: "desc" } }, { node: { latencyMs: "asc" } }, { node: { createdAt: "desc" } }]
      });
      deduped = dedupeNodeAccessRows(rows);
    } catch (error) {
      const errorMessage = readPanelSyncErrorMessage(error);
      this.logger?.warn(`Node access saved, but response refresh failed for ${subscriptionId}: ${errorMessage}`);
      panelSyncStatus = "pending";
      panelSyncMessage = [panelSyncMessage, `local node access saved, but response refresh failed: ${errorMessage}`]
        .filter(Boolean)
        .join(" ");
      deduped = uniqueNodeIds
        .map((nodeId) => availableNodes.find((node) => node.id === nodeId))
        .filter((node): node is (typeof availableNodes)[number] => Boolean(node))
        .map((node) => ({ nodeId: node.id, node }));
    }

    return {
      subscriptionId,
      nodeIds: deduped.map((item) => item.nodeId),
      nodes: deduped.map((item) => toNodeSummary(item.node)),
      revokedSessionCount,
      reasonCode,
      reasonMessage,
      panelSyncStatus,
      panelSyncMessage,
      message: panelSyncMessage ? `${message ?? "节点授权已保存。"} ${panelSyncMessage}` : (message ?? "节点授权已保存。")
    };
  }

  private async trySyncSubscriptionPanelAccess(subscriptionId: string) {
    try {
      const queuedCount = await this.runtimeSessionService.syncSubscriptionPanelAccess(subscriptionId);
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

  private async queuePanelDisableJobsForNodeAccessRevocation(
    subscriptionId: string,
    filter: { nodeIds?: string[] } | undefined
  ) {
    const messages: string[] = [];
    try {
      const pendingPanelSyncCount = await this.runtimeSessionService.markPanelBindingsDisabledForSubscription(
        subscriptionId,
        filter
      );
      if (pendingPanelSyncCount > 0) {
        messages.push("3x-ui disable job queued; local node access and active sessions are invalidated.");
      }
      try {
        await this.prisma.$transaction((tx) =>
          this.runtimeSessionService.queueLeaseRevocationJobsForSubscriptionTx(
            tx,
            subscriptionId,
            "node_access_revoked",
            filter
          )
        );
      } catch (error) {
        const errorMessage = readPanelSyncErrorMessage(error);
        this.logger?.warn(`Node access saved, but lease revocation job queueing failed for ${subscriptionId}: ${errorMessage}`);
        messages.push(`lease revocation job queueing failed: ${errorMessage}`);
      }
      return messages.length > 0 ? messages.join(" ") : null;
      return pendingPanelSyncCount > 0
        ? "3x-ui 客户端禁用已加入后台队列，本地授权和当前连接已立即失效。"
        : null;
    } catch (error) {
      const errorMessage = readPanelSyncErrorMessage(error);
      this.logger?.warn(`Node access saved, but 3x-ui disable job queueing failed for ${subscriptionId}: ${errorMessage}`);
      messages.push(`3x-ui disable job queueing failed: ${errorMessage}`);
      return messages.join(" ");
    }
  }

  private async queuePanelDisableJobsForNodeAccessRevocationTx(
    writer: any,
    subscriptionId: string,
    filter: { nodeIds?: string[] } | undefined
  ) {
    const messages: string[] = [];
    try {
      const pendingPanelSyncCount = await this.runtimeSessionService.queuePanelDisableJobsForSubscriptionTx(
        writer,
        subscriptionId,
        filter
      );
      await this.runtimeSessionService.queueLeaseRevocationJobsForSubscriptionTx(
        writer,
        subscriptionId,
        "node_access_revoked",
        filter
      );
      if (pendingPanelSyncCount > 0) {
        return "3x-ui disable job queued; local node access and active sessions are invalidated.";
      }
      return null;
      return pendingPanelSyncCount > 0
        ? "3x-ui 瀹㈡埛绔鐢ㄥ凡鍔犲叆鍚庡彴闃熷垪锛屾湰鍦版巿鏉冨拰褰撳墠杩炴帴宸茬珛鍗冲け鏁堛€?"
        : null;
    } catch (error) {
      const errorMessage = readPanelSyncErrorMessage(error);
      this.logger?.warn(`Node access saved, but 3x-ui disable job queueing failed for ${subscriptionId}: ${errorMessage}`);
      messages.push(`3x-ui disable job queueing failed: ${errorMessage}`);
      return messages.join(" ");
    }
  }

  private async tryApplyNodeAccessRevocationEffects(
    subscriptionId: string,
    filter: { nodeIds?: string[] } | undefined,
    reason: string,
    options: { queuedPanelSyncMessage?: string | null } = {}
  ) {
    const messages: string[] = [];
    let revokedSessionCount = 0;

    if (options.queuedPanelSyncMessage) {
      messages.push(options.queuedPanelSyncMessage);
    }

    try {
      revokedSessionCount = await this.runtimeSessionService.revokeSubscriptionLeases(subscriptionId, reason, filter);
    } catch (error) {
      const errorMessage = readPanelSyncErrorMessage(error);
      this.logger?.warn(`Node access saved, but active lease revocation failed for ${subscriptionId}: ${errorMessage}`);
      messages.push(`active lease revocation failed: ${errorMessage}`);
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
