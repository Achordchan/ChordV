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
import {
  SUPPORT_INTEGRATION_SETTING_KEY,
  parseStoredSupportIntegrationConfig,
  readSupportIntegrationConfig,
  readSupportIntegrationCredentials as readCredentials,
  type StoredSupportIntegrationConfig
} from "./support-integration.settings";

export { SUPPORT_INTEGRATION_SETTING_KEY } from "./support-integration.settings";
export const SUPPORT_NOT_OPEN_MESSAGE = "工单系统暂未开放，请稍后再试";
export const SUPPORT_RATE_LIMITED_MESSAGE = "操作太频繁，请稍后再试";
export const SUPPORT_UNAVAILABLE_MESSAGE = "工单系统暂时无法连接，请稍后再试";
const LAUNCH_TIMEOUT_MS = 8_000;
/** 查询状态时顺带校准未读数：等待时间要短，工单系统慢或不可用时直接用本地值。 */
const RESYNC_TIMEOUT_MS = 3_000;
/** 本地未读数超过这个时间没有得到权威值时，查询状态会先向工单系统校准。 */
export const SUPPORT_UNREAD_RESYNC_AFTER_MS = 5 * 60_000;
/**
 * 同一用户两次校准之间至少间隔 5 分钟（不论成败）：工单系统要求由后端按需查询、不要让客户端轮询，
 * 工单系统不可用时也不会被每次状态查询放大请求。
 */
export const SUPPORT_UNREAD_RESYNC_MIN_INTERVAL_MS = 5 * 60_000;
/** 整个进程每分钟最多校准的次数，远低于工单系统每连接每分钟 600 次的限额，超出时直接用本地值。 */
export const SUPPORT_UNREAD_RESYNC_MAX_PER_MINUTE = 120;
const RESYNC_ATTEMPT_TRACKING_LIMIT = 10_000;
export const WEBHOOK_EVENT_RETENTION_DAYS = 30;
const CONNECTION_TEST_USER: AchordConnectLaunchUser = { id: "chordv-connection-test", email: "", displayName: "ChordV 连接测试" };

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
  private readonly recentResyncs: number[] = [];
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

  /**
   * 部分更新：省略的字段保持不变。读取与写回在同一事务里并对设置行加锁，
   * 两位管理员同时保存时后者基于前者的结果修改，不会把对方清除的密钥或关闭的开关写回去。
   */
  async updateAdminConfig(input: UpdateAdminSupportIntegrationConfigInputDto): Promise<AdminSupportIntegrationConfigDto> {
    const saved = await this.prisma.$transaction(async (tx) => {
      await tx.systemSetting.createMany({ data: [{ key: SUPPORT_INTEGRATION_SETTING_KEY, value: {} }], skipDuplicates: true });
      await tx.$queryRaw`SELECT "key" FROM "SystemSetting" WHERE "key" = ${SUPPORT_INTEGRATION_SETTING_KEY} FOR UPDATE`;
      const row = await tx.systemSetting.findUniqueOrThrow({ where: { key: SUPPORT_INTEGRATION_SETTING_KEY } });
      const next = applyConfigUpdate(parseStoredSupportIntegrationConfig(row.value), input);
      const updated = await tx.systemSetting.update({ where: { key: SUPPORT_INTEGRATION_SETTING_KEY }, data: { value: next } });
      return { next, updatedAt: updated.updatedAt };
    });
    return this.toAdminConfig(saved.next, saved.updatedAt);
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
      } else {
        // 校准失败或被放弃时，查询期间可能已有 Webhook 写入并推送了新值，重新读取，避免返回旧值覆盖客户端。
        const current = await this.prisma.supportUnreadState.findUnique({ where: { userId }, select: { unreadCount: true } });
        unreadCount = current?.unreadCount ?? 0;
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
      this.logger.warn(`Achord Connect 创建票据失败（用户 ${user.id}）：${describeInternalError(error)}${describeLaunchConfigHint(error)}`);
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
   * 在一个事务里记录事件 ID（去重）并更新未读数；同一用户的事件按行锁串行处理。返回 null 表示事件已处理过。
   * - 早于最近一次权威总数（Webhook 的 contactUnreadCount 或服务端校准）的事件已包含在总数里，只记录事件 ID；
   *   同一请求晚到的旧事件也不会覆盖新值。
   * - 带 contactUnreadCount：以它为总数；但如果本地已有比它更新的按请求变化（新旧版本事件混在一起），
   *   两者先后无法对齐，就保留当前值并标记为待校准，而不是用旧总数覆盖。
   * - 不带 contactUnreadCount：本地按请求记录完整时按请求求和；不完整时（总数来自权威值，
   *   本地缺少部分请求）无法由单个请求推出总数，保留当前值并标记为待校准。
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
      const unchanged = { previous: state.unreadCount, next: state.unreadCount };
      if (state.sourceAt && eventAt.getTime() < state.sourceAt.getTime()) {
        return unchanged;
      }
      const key = { userId_requestId: { userId, requestId: change.requestId } };
      const existing = await tx.supportRequestUnread.findUnique({ where: key, select: { eventAt: true } });
      if (!existing || existing.eventAt.getTime() <= eventAt.getTime()) {
        await tx.supportRequestUnread.upsert({
          where: key,
          create: { userId, requestId: change.requestId, unreadCount: change.unreadCount, eventAt },
          update: { unreadCount: change.unreadCount, eventAt }
        });
      }
      const sumRequests = async () =>
        (await tx.supportRequestUnread.aggregate({ where: { userId }, _sum: { unreadCount: true } }))._sum.unreadCount ?? 0;
      let data: { unreadCount?: number; sourceAt?: Date; syncedAt?: Date | null; requestsComplete?: boolean };
      if (change.contactUnreadCount !== null) {
        const newerRequests = await tx.supportRequestUnread.count({ where: { userId, eventAt: { gt: eventAt } } });
        if (newerRequests > 0) {
          data = { syncedAt: null };
        } else {
          const sum = await sumRequests();
          data = {
            unreadCount: change.contactUnreadCount,
            sourceAt: eventAt,
            syncedAt: new Date(),
            requestsComplete: sum === change.contactUnreadCount
          };
        }
      } else if (state.requestsComplete) {
        data = { unreadCount: await sumRequests() };
      } else {
        data = { syncedAt: null };
      }
      await tx.supportUnreadState.update({ where: { userId }, data: { ...data, revision: { increment: 1 } } });
      return { previous: state.unreadCount, next: data.unreadCount ?? state.unreadCount };
    });
  }

  // ---------- 未读校准 ----------

  /**
   * 向工单系统查询该用户的未读总数并写回本地；失败时返回 null，由调用方继续使用本地值。
   * 查询结果是工单系统某一时刻的快照，但它不带版本号，无法判断与查询期间到达的 Webhook 谁更新：
   * 查询前记下本地版本号，写回时若版本已变（查询期间处理过 Webhook），就放弃这次结果、保留 Webhook 的值，
   * 不标记为已校准，下次查询状态时再试。写回后，早于查询开始时间的事件都已包含在快照里，不再改动未读。
   */
  async resyncUnread(userId: string, credentials: AchordConnectCredentials): Promise<number | null> {
    const before = await this.prisma.supportUnreadState.findUnique({ where: { userId }, select: { revision: true } });
    const expectedRevision = before?.revision ?? 0;
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
    let result: UnreadTotalChange | null;
    try {
      result = await this.prisma.$transaction(async (tx) => {
        await tx.supportUnreadState.createMany({ data: [{ userId }], skipDuplicates: true });
        await tx.$queryRaw`SELECT "userId" FROM "SupportUnreadState" WHERE "userId" = ${userId} FOR UPDATE`;
        const state = await tx.supportUnreadState.findUniqueOrThrow({ where: { userId } });
        if (state.revision !== expectedRevision) {
          return null;
        }
        // 快照整体取代本地的按请求记录（包括快照里已经没有的请求），不截断。
        await tx.supportRequestUnread.deleteMany({ where: { userId } });
        if (remote.requests.length > 0) {
          await tx.supportRequestUnread.createMany({
            data: remote.requests.map((item) => ({ userId, requestId: item.id, unreadCount: item.unreadCount, eventAt: snapshotAt })),
            skipDuplicates: true
          });
        }
        // 查询结果只给了总数、或按请求明细加起来对不上总数时，本地记录不完整，之后不再由单个请求推算总数。
        const requestsComplete = remote.requests.reduce((sum, item) => sum + item.unreadCount, 0) === remote.unreadCount;
        await tx.supportUnreadState.update({
          where: { userId },
          data: { unreadCount: remote.unreadCount, sourceAt: snapshotAt, syncedAt: new Date(), requestsComplete, revision: { increment: 1 } }
        });
        return { previous: state.unreadCount, next: remote.unreadCount };
      });
    } catch (error) {
      this.logger.warn(`Achord Connect 未读校准写入失败（用户 ${userId}）：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    if (!result) {
      this.logger.log(`Achord Connect 未读校准期间收到新的 Webhook，已保留 Webhook 的值（用户 ${userId}）`);
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
    while (this.recentResyncs.length > 0 && now - this.recentResyncs[0] >= 60_000) {
      this.recentResyncs.shift();
    }
    if (this.recentResyncs.length >= SUPPORT_UNREAD_RESYNC_MAX_PER_MINUTE) {
      return false;
    }
    this.recentResyncs.push(now);
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

  private readStoredConfig() {
    return readSupportIntegrationConfig(this.prisma);
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

function applyConfigUpdate(current: StoredSupportIntegrationConfig, input: UpdateAdminSupportIntegrationConfigInputDto): StoredSupportIntegrationConfig {
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
  return next;
}

function describeInternalError(error: unknown) {
  if (error instanceof AchordConnectRequestError) {
    return `${error.kind}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** 创建票据失败时给服务端日志补一句排查提示，区分“后台配置有误”和工单系统本身的问题。 */
function describeLaunchConfigHint(error: unknown) {
  if (!(error instanceof AchordConnectRequestError) || error.kind !== "http") return "";
  if (error.status === 401) return "（后台配置问题：Client ID 或 Client Secret 不正确、凭据已撤销，或 Achord Connect 连接未激活）";
  if (error.code === "UNIVERSAL_NATIVE_LAUNCH_DISABLED") return "（后台配置问题：Achord Connect 连接没有开启原生窗口打开）";
  if (error.code === "UNIVERSAL_IFRAME_NOT_CONFIGURED") return "（请求缺少原生窗口参数，且连接没有配置 iframe 来源）";
  if (error.status === 422) return "（工单系统拒绝了请求参数）";
  if (error.status === 429) return "（触发工单系统限流）";
  return "";
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
  if (target === "launch" && error.code === "UNIVERSAL_IFRAME_NOT_CONFIGURED") {
    return `工单系统没有收到原生窗口参数，且连接没有配置 iframe 来源${code}`;
  }
  if (target === "launch" && error.status === 422) {
    return `工单系统不接受这次的请求参数${code}`;
  }
  if (target === "unread" && error.status === 404) {
    return "工单系统没有提供未读查询接口（HTTP 404），请确认地址指向已升级的 Achord Connect；未读数暂时只按 Webhook 维护";
  }
  return `工单系统返回异常（HTTP ${error.status ?? "未知"}${code}）`;
}
