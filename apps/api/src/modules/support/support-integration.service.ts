import { BadGatewayException, BadRequestException, HttpException, HttpStatus, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import type {
  AdminSupportIntegrationConfigDto,
  AdminSupportIntegrationTestItemDto,
  AdminSupportIntegrationTestResultDto,
  ClientSupportLaunchDto,
  ClientSupportStatusDto,
  UpdateAdminSupportIntegrationConfigInputDto
} from "@chordv/shared";
import { DrainableJob } from "../../work-lifecycle";
import { ClientEventsPublisher } from "../common/client-events.publisher";
import { PrismaService } from "../common/prisma.service";
import { SiteAddressService } from "../common/site-address.service";
import {
  AchordConnectRequestError,
  buildAchordConnectWebhookUrl,
  createAchordConnectLaunchTicket,
  fetchAchordConnectContactUnread,
  normalizeAchordConnectBaseUrl,
  normalizeAchordConnectClientId,
  normalizeAchordConnectSecret,
  parseAchordConnectWebhookEvent,
  verifyAchordConnectWebhookSignature,
  type AchordConnectCredentials,
  type AchordConnectFetch,
  type AchordConnectLaunchUser,
  type AchordConnectUnreadChange
} from "./achord-connect";

export const SUPPORT_INTEGRATION_SETTING_KEY = "achord-connect";
export const SUPPORT_NOT_OPEN_MESSAGE = "工单系统暂未开放，请稍后再试";
export const SUPPORT_RATE_LIMITED_MESSAGE = "操作太频繁，请稍后再试";
export const SUPPORT_UNAVAILABLE_MESSAGE = "工单系统暂时无法连接，请稍后再试";
const LAUNCH_TIMEOUT_MS = 8_000;
/** 查询状态时顺带校准未读数：等待时间要短，工单系统慢或不可用时直接用本地值。 */
const RESYNC_TIMEOUT_MS = 3_000;
/** 本地未读数超过这个时间没有得到权威值时，查询状态会先向工单系统校准。 */
export const SUPPORT_UNREAD_RESYNC_AFTER_MS = 5 * 60_000;
/** 同一用户两次校准之间至少间隔，工单系统不可用时也不会被每次状态查询放大请求。 */
export const SUPPORT_UNREAD_RESYNC_MIN_INTERVAL_MS = 60_000;
const RESYNC_ATTEMPT_TRACKING_LIMIT = 10_000;
const RESYNC_REQUEST_ROWS_LIMIT = 500;
export const WEBHOOK_EVENT_RETENTION_DAYS = 30;
const CONNECTION_TEST_USER: AchordConnectLaunchUser = { id: "chordv-connection-test", email: "", displayName: "ChordV 连接测试" };

type StoredSupportIntegrationConfig = {
  baseUrl: string | null;
  clientId: string | null;
  clientSecret: string | null;
  webhookSecret: string | null;
  enabled: boolean;
};

export type AchordConnectWebhookRequest = {
  rawBody: Buffer;
  eventId: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
};

export type AchordConnectWebhookResult = "accepted" | "duplicate" | "ignored";

type UnreadTotalChange = { previous: number; next: number };

@Injectable()
export class SupportIntegrationService {
  private readonly logger = new Logger(SupportIntegrationService.name);
  /** 对工单系统的请求入口，测试时替换。 */
  fetchImpl: AchordConnectFetch = (input, init) => fetch(input, init);
  private readonly resyncAttempts = new Map<string, number>();
  private unreadEndpointMissingLogged = false;
  private lastRejectedWebhookLogAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sites: SiteAddressService,
    private readonly clientEventsPublisher: ClientEventsPublisher
  ) {}

  // ---------- 后台设置 ----------

  async getAdminConfig(): Promise<AdminSupportIntegrationConfigDto> {
    const stored = await this.readStoredConfig();
    return this.toAdminConfig(stored.value, stored.updatedAt);
  }

  async updateAdminConfig(input: UpdateAdminSupportIntegrationConfigInputDto): Promise<AdminSupportIntegrationConfigDto> {
    const current = (await this.readStoredConfig()).value;
    const next: StoredSupportIntegrationConfig = { ...current };
    if (input.baseUrl !== undefined) {
      next.baseUrl = input.baseUrl?.trim() ? normalizeAchordConnectBaseUrl(input.baseUrl) : null;
    }
    if (input.clientId !== undefined) {
      next.clientId = input.clientId?.trim() ? normalizeAchordConnectClientId(input.clientId) : null;
    }
    if (input.clientSecret !== undefined) {
      next.clientSecret = input.clientSecret === null ? null : normalizeAchordConnectSecret(input.clientSecret, "Client Secret");
    }
    if (input.webhookSecret !== undefined) {
      next.webhookSecret = input.webhookSecret === null ? null : normalizeAchordConnectSecret(input.webhookSecret, "Webhook Secret");
    }
    if (input.enabled !== undefined) {
      next.enabled = input.enabled;
    }
    if (next.enabled && !readCredentials(next)) {
      throw new BadRequestException("启用前请先填写工单系统地址、Client ID 和 Client Secret");
    }
    const row = await this.prisma.systemSetting.upsert({
      where: { key: SUPPORT_INTEGRATION_SETTING_KEY },
      create: { key: SUPPORT_INTEGRATION_SETTING_KEY, value: next },
      update: { value: next }
    });
    return this.toAdminConfig(next, row.updatedAt);
  }

  /** 用已保存的设置测试：为测试用户创建一次票据（不会被兑换，60 秒后自动失效），并查询一次未读。 */
  async testConnection(): Promise<AdminSupportIntegrationTestResultDto> {
    const credentials = readCredentials((await this.readStoredConfig()).value);
    if (!credentials) {
      const missing = { ok: false, message: "请先填写并保存工单系统地址、Client ID 和 Client Secret" };
      return { ok: false, launch: missing, unread: { ok: false, message: "未测试" } };
    }
    const launch = await createAchordConnectLaunchTicket(this.fetchImpl, credentials, CONNECTION_TEST_USER, LAUNCH_TIMEOUT_MS).then(
      (): AdminSupportIntegrationTestItemDto => ({ ok: true, message: "凭据有效，可以创建原生窗口工单入口" }),
      (error: unknown) => ({ ok: false, message: describeConnectionTestFailure(error, "launch") })
    );
    const unread = await fetchAchordConnectContactUnread(this.fetchImpl, credentials, CONNECTION_TEST_USER.id, LAUNCH_TIMEOUT_MS).then(
      (): AdminSupportIntegrationTestItemDto => ({ ok: true, message: "未读查询接口可用" }),
      (error: unknown) => ({ ok: false, message: describeConnectionTestFailure(error, "unread") })
    );
    return { ok: launch.ok, launch, unread };
  }

  // ---------- 客户端接口 ----------

  async getClientStatus(userId: string): Promise<ClientSupportStatusDto> {
    const credentials = await this.readLaunchCredentials();
    if (!credentials) {
      return { enabled: false, unreadCount: 0, supportOrigin: null };
    }
    const state = await this.prisma.supportUnreadState.findUnique({
      where: { userId },
      select: { unreadCount: true, syncedAt: true }
    });
    let unreadCount = state?.unreadCount ?? 0;
    const now = Date.now();
    const stale = !state?.syncedAt || now - state.syncedAt.getTime() >= SUPPORT_UNREAD_RESYNC_AFTER_MS;
    if (stale && this.claimResyncAttempt(userId, now)) {
      const synced = await this.resyncUnread(userId, credentials);
      if (synced !== null) {
        unreadCount = synced;
      }
    }
    return { enabled: true, unreadCount, supportOrigin: credentials.baseUrl };
  }

  async launchForClient(user: AchordConnectLaunchUser): Promise<ClientSupportLaunchDto> {
    const credentials = await this.readLaunchCredentials();
    if (!credentials) {
      throw new ServiceUnavailableException(SUPPORT_NOT_OPEN_MESSAGE);
    }
    try {
      const ticket = await createAchordConnectLaunchTicket(this.fetchImpl, credentials, user, LAUNCH_TIMEOUT_MS);
      return { launchUrl: ticket.launchUrl, expiresAt: ticket.expiresAt, supportOrigin: credentials.baseUrl };
    } catch (error) {
      this.logger.warn(`Achord Connect 创建票据失败（用户 ${user.id}）：${describeInternalError(error)}`);
      if (error instanceof AchordConnectRequestError && error.status === HttpStatus.TOO_MANY_REQUESTS) {
        throw new HttpException({ statusCode: HttpStatus.TOO_MANY_REQUESTS, message: SUPPORT_RATE_LIMITED_MESSAGE }, HttpStatus.TOO_MANY_REQUESTS);
      }
      throw new BadGatewayException(SUPPORT_UNAVAILABLE_MESSAGE);
    }
  }

  // ---------- Webhook ----------

  async handleWebhook(request: AchordConnectWebhookRequest): Promise<AchordConnectWebhookResult> {
    const { webhookSecret } = (await this.readStoredConfig()).value;
    const verified = Boolean(webhookSecret) && verifyAchordConnectWebhookSignature({
      secret: webhookSecret ?? "",
      rawBody: request.rawBody,
      timestamp: request.timestamp,
      signature: request.signature
    });
    if (!verified) {
      // 验签失败只回 401 不给细节；日志每分钟最多一条，方便排查密钥填错又不会被刷屏。
      const now = Date.now();
      if (now - this.lastRejectedWebhookLogAt >= 60_000) {
        this.lastRejectedWebhookLogAt = now;
        this.logger.warn(webhookSecret
          ? "Achord Connect Webhook 验签未通过（签名不符或时间戳超出 300 秒），请核对 Webhook Secret 与服务器时间"
          : "收到 Achord Connect Webhook，但尚未设置 Webhook Secret，已拒绝");
      }
      throw new UnauthorizedException();
    }
    const eventId = request.eventId?.trim() ?? "";
    const event = parseAchordConnectWebhookEvent(request.rawBody);
    if (!eventId || eventId.length > 191 || !event || (event.id !== null && event.id !== eventId)) {
      throw new BadRequestException();
    }
    if (event.type !== "request.unread.changed") {
      if (event.type === "connector.test") {
        this.logger.log(`收到 Achord Connect 测试事件 ${eventId}`);
      }
      return "ignored";
    }
    const change = event.unreadChange;
    if (!change) {
      this.logger.warn(`Achord Connect 未读事件 ${eventId} 缺少必要字段，已忽略`);
      return "ignored";
    }
    const user = await this.prisma.user.findUnique({ where: { id: change.externalUserId }, select: { id: true } });
    if (!user) {
      this.logger.warn(`Achord Connect 未读事件 ${eventId} 指向不存在的用户，已忽略`);
      return "ignored";
    }
    const eventAt = event.createdAt ?? new Date(Number(request.timestamp) * 1000);
    const result = await this.applyUnreadChange(eventId, event.type, change, eventAt);
    if (!result) {
      return "duplicate";
    }
    this.publishIfChanged(change.externalUserId, result);
    return "accepted";
  }

  /**
   * 在一个事务里记录事件 ID（去重）并更新未读数；同一用户的事件按行锁串行处理。
   * 事件带 contactUnreadCount 时以它为总数，否则按请求求和；晚到的旧事件不会覆盖更新的值。
   * 返回 null 表示事件已处理过。
   */
  async applyUnreadChange(eventId: string, type: string, change: AchordConnectUnreadChange, eventAt: Date): Promise<UnreadTotalChange | null> {
    const userId = change.externalUserId;
    return this.prisma.$transaction(async (tx) => {
      const inserted = await tx.achordConnectWebhookEvent.createMany({ data: [{ eventId, type }], skipDuplicates: true });
      if (inserted.count === 0) {
        return null;
      }
      await tx.supportUnreadState.createMany({ data: [{ userId }], skipDuplicates: true });
      await tx.$queryRaw`SELECT "userId" FROM "SupportUnreadState" WHERE "userId" = ${userId} FOR UPDATE`;
      const state = await tx.supportUnreadState.findUniqueOrThrow({ where: { userId } });
      const key = { userId_requestId: { userId, requestId: change.requestId } };
      const existing = await tx.supportRequestUnread.findUnique({ where: key, select: { eventAt: true } });
      if (!existing) {
        await tx.supportRequestUnread.create({ data: { userId, requestId: change.requestId, unreadCount: change.unreadCount, eventAt } });
      } else if (existing.eventAt.getTime() <= eventAt.getTime()) {
        await tx.supportRequestUnread.update({ where: key, data: { unreadCount: change.unreadCount, eventAt } });
      }
      const data: { unreadCount: number; sourceAt?: Date; syncedAt?: Date } = { unreadCount: state.unreadCount };
      if (change.contactUnreadCount !== null) {
        if (!state.sourceAt || state.sourceAt.getTime() <= eventAt.getTime()) {
          data.unreadCount = change.contactUnreadCount;
          data.sourceAt = eventAt;
          data.syncedAt = new Date();
        }
      } else {
        const sum = await tx.supportRequestUnread.aggregate({ where: { userId }, _sum: { unreadCount: true } });
        data.unreadCount = sum._sum.unreadCount ?? 0;
      }
      await tx.supportUnreadState.update({ where: { userId }, data });
      return { previous: state.unreadCount, next: data.unreadCount };
    });
  }

  // ---------- 未读校准 ----------

  /** 向工单系统查询该用户的未读总数并写回本地；失败时返回 null，由调用方继续使用本地值。 */
  async resyncUnread(userId: string, credentials: AchordConnectCredentials): Promise<number | null> {
    const snapshotAt = new Date();
    let remote: Awaited<ReturnType<typeof fetchAchordConnectContactUnread>>;
    try {
      remote = await fetchAchordConnectContactUnread(this.fetchImpl, credentials, userId, RESYNC_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof AchordConnectRequestError && error.status === HttpStatus.NOT_FOUND) {
        if (!this.unreadEndpointMissingLogged) {
          this.unreadEndpointMissingLogged = true;
          this.logger.warn("Achord Connect 暂未提供未读查询接口（HTTP 404），未读数先按 Webhook 维护");
        }
      } else {
        this.logger.warn(`Achord Connect 未读校准失败（用户 ${userId}）：${describeInternalError(error)}`);
      }
      return null;
    }
    let result: UnreadTotalChange;
    try {
      result = await this.prisma.$transaction(async (tx) => {
        await tx.supportUnreadState.createMany({ data: [{ userId }], skipDuplicates: true });
        await tx.$queryRaw`SELECT "userId" FROM "SupportUnreadState" WHERE "userId" = ${userId} FOR UPDATE`;
        const state = await tx.supportUnreadState.findUniqueOrThrow({ where: { userId } });
        if (state.sourceAt && state.sourceAt.getTime() > snapshotAt.getTime()) {
          // 查询期间已收到更新的权威总数，保留它。
          return { previous: state.unreadCount, next: state.unreadCount };
        }
        // 查询结果取代它之前的按请求记录；查询期间到达的更新事件保留。
        await tx.supportRequestUnread.deleteMany({ where: { userId, eventAt: { lte: snapshotAt } } });
        const rows = remote.requests.slice(0, RESYNC_REQUEST_ROWS_LIMIT).map((item) => ({
          userId,
          requestId: item.id,
          unreadCount: item.unreadCount,
          eventAt: snapshotAt
        }));
        if (rows.length > 0) {
          await tx.supportRequestUnread.createMany({ data: rows, skipDuplicates: true });
        }
        await tx.supportUnreadState.update({
          where: { userId },
          data: { unreadCount: remote.unreadCount, sourceAt: snapshotAt, syncedAt: new Date() }
        });
        return { previous: state.unreadCount, next: remote.unreadCount };
      });
    } catch (error) {
      this.logger.warn(`Achord Connect 未读校准写入失败（用户 ${userId}）：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    this.publishIfChanged(userId, result);
    return result.next;
  }

  /** 每小时清理 30 天前的 Webhook 事件 ID；工单系统最长约 14 小时内重试完，30 天足够去重。 */
  @Cron("0 43 * * * *")
  @DrainableJob()
  async pruneWebhookEvents(now = new Date()) {
    const cutoff = new Date(now.getTime() - WEBHOOK_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const deleted = await this.prisma.achordConnectWebhookEvent.deleteMany({ where: { receivedAt: { lt: cutoff } } });
    if (deleted.count > 0) {
      this.logger.log(`已清理 ${deleted.count} 条过期的 Achord Connect Webhook 事件记录`);
    }
    return deleted.count;
  }

  // ---------- 内部 ----------

  private publishIfChanged(userId: string, change: UnreadTotalChange) {
    if (change.previous === change.next) {
      return;
    }
    this.clientEventsPublisher.publishSupportUnreadUpdated(userId, change.next);
  }

  private claimResyncAttempt(userId: string, now: number) {
    const last = this.resyncAttempts.get(userId);
    if (last !== undefined && now - last < SUPPORT_UNREAD_RESYNC_MIN_INTERVAL_MS) {
      return false;
    }
    this.resyncAttempts.delete(userId);
    this.resyncAttempts.set(userId, now);
    if (this.resyncAttempts.size > RESYNC_ATTEMPT_TRACKING_LIMIT) {
      const oldest = this.resyncAttempts.keys().next().value;
      if (oldest !== undefined) {
        this.resyncAttempts.delete(oldest);
      }
    }
    return true;
  }

  private async readLaunchCredentials(): Promise<AchordConnectCredentials | null> {
    const { value } = await this.readStoredConfig();
    return value.enabled ? readCredentials(value) : null;
  }

  private async readStoredConfig(): Promise<{ value: StoredSupportIntegrationConfig; updatedAt: Date | null }> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: SUPPORT_INTEGRATION_SETTING_KEY } });
    return { value: parseStoredConfig(row?.value), updatedAt: row?.updatedAt ?? null };
  }

  private async toAdminConfig(value: StoredSupportIntegrationConfig, updatedAt: Date | null): Promise<AdminSupportIntegrationConfigDto> {
    const site = await this.sites.get();
    return {
      baseUrl: value.baseUrl,
      clientId: value.clientId,
      hasClientSecret: Boolean(value.clientSecret),
      hasWebhookSecret: Boolean(value.webhookSecret),
      enabled: value.enabled,
      webhookUrl: buildAchordConnectWebhookUrl(site.primaryOrigin),
      updatedAt: updatedAt?.toISOString() ?? null
    };
  }
}

function parseStoredConfig(value: unknown): StoredSupportIntegrationConfig {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const text = (key: string) => (typeof record[key] === "string" && record[key] ? (record[key] as string) : null);
  return {
    baseUrl: text("baseUrl"),
    clientId: text("clientId"),
    clientSecret: text("clientSecret"),
    webhookSecret: text("webhookSecret"),
    enabled: record.enabled === true
  };
}

function readCredentials(value: StoredSupportIntegrationConfig): AchordConnectCredentials | null {
  return value.baseUrl && value.clientId && value.clientSecret
    ? { baseUrl: value.baseUrl, clientId: value.clientId, clientSecret: value.clientSecret }
    : null;
}

function describeInternalError(error: unknown) {
  if (error instanceof AchordConnectRequestError) {
    return `${error.kind}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** 给管理员看的测试结果：可以带状态码和工单系统的错误码，但不带工单系统返回的原文。 */
function describeConnectionTestFailure(error: unknown, target: "launch" | "unread") {
  if (!(error instanceof AchordConnectRequestError)) {
    return "测试时出现未知错误，请查看后台日志";
  }
  if (error.kind === "timeout") return "连接工单系统超时，请检查地址和网络";
  if (error.kind === "network") return "无法连接到工单系统，请检查地址和网络";
  if (error.kind === "invalid_response") return "工单系统返回的内容不符合预期，请确认地址指向 Achord Connect";
  const code = error.code ? `，错误码 ${error.code}` : "";
  if (error.status === 401) return `工单系统拒绝了凭据：Client ID 或 Client Secret 不正确，或连接未启用${code}`;
  if (error.status === 429) return "请求太频繁，请稍后再测";
  if (target === "launch" && error.code === "UNIVERSAL_NATIVE_LAUNCH_DISABLED") {
    return "凭据有效，但工单系统的连接没有开启原生窗口打开（allowNativeLaunch）";
  }
  if (target === "launch" && error.status === 422) {
    return `工单系统不接受原生窗口参数，可能还没有升级到支持原生窗口的版本${code}`;
  }
  if (target === "unread" && error.status === 404) {
    return "工单系统暂未提供未读查询接口；未读数先按 Webhook 维护，工单系统升级后自动启用";
  }
  return `工单系统返回异常（HTTP ${error.status ?? "未知"}${code}）`;
}
