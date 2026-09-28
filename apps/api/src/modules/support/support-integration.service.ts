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
import { promotionAdmission } from "../../promotion-admission";
import { DrainableJob, workLifecycle } from "../../work-lifecycle";
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
  isStoredSupportIntegrationEnabled,
  lockSupportIntegrationConfigShared,
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
/** 校准水位线相对响应头 Date 的回退量，见 resyncUnread 的说明。 */
const SNAPSHOT_WATERMARK_MARGIN_MS = RESYNC_TIMEOUT_MS + 1000;
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
/** 后台校准（由无法直接采用的 Webhook 触发）失败或被限流时的重试次数，按同一用户的最小间隔排队，约半小时内放弃。 */
const BACKGROUND_RESYNC_MAX_ATTEMPTS = 6;
export const WEBHOOK_EVENT_RETENTION_DAYS = 30;
const CONNECTION_TEST_USER: AchordConnectLaunchUser = { id: "chordv-connection-test", email: "", displayName: "ChordV 连接测试" };

export type AchordConnectWebhookRequest = {
  rawBody: Buffer;
  eventId: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
};

export type AchordConnectWebhookResult = "accepted" | "duplicate" | "ignored";

/**
 * revision 是写入后的版本号，推送时据此丢弃乱序到达的旧结果；
 * needsResync 表示这次事件无法可靠地给出总数，需要后台向工单系统重新查询；
 * publish 是提交时新工单系统是否启用（在同一事务里读取，提交后的推送不再依赖任何可能失败的查询）；
 * epoch 是当时设置的推送代次，设置在此之后切换过连接或启用状态的，推送时丢弃。
 */
type UnreadTotalChange = { previous: number; next: number; revision: number; publish: boolean; epoch: number; needsResync?: boolean };

@Injectable()
export class SupportIntegrationService {
  private readonly logger = new Logger(SupportIntegrationService.name);
  /** 对工单系统的请求入口，测试时替换。 */
  fetchImpl: AchordConnectFetch = (input, init) => fetch(input, init);
  private readonly resyncAttempts = new Map<string, number>();
  private readonly recentResyncs: number[] = [];
  /** 每位用户最近一次推送对应的（推送代次，版本号），按先代次、后版本号比较新旧。 */
  private readonly publishedRevisions = new Map<string, { epoch: number; revision: number }>();
  private readonly backgroundResyncTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 本进程见过的最新推送代次。 */
  private publicationEpoch = 0;
  private unreadEndpointMissingLogged = false;
  private lastRejectedWebhookLogAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sites: SiteAddressService,
    private readonly clientEventsPublisher: ClientEventsPublisher
  ) {
    workLifecycle.onDrain(() => {
      for (const timer of this.backgroundResyncTimers.values()) clearTimeout(timer);
      this.backgroundResyncTimers.clear();
    });
  }

  // ---------- 后台设置 ----------

  async getAdminConfig(): Promise<AdminSupportIntegrationConfigDto> {
    const stored = await this.readStoredConfig();
    return this.toAdminConfig(stored.value, stored.updatedAt);
  }

  /**
   * 部分更新：省略的字段保持不变。读取与写回在同一事务里并对设置行加排他锁，
   * 两位管理员同时保存时后者基于前者的结果修改，不会把对方清除的密钥或关闭的开关写回去；
   * Webhook 与校准写入时持有同一行的共享锁，保存设置与它们互斥。
   * - 地址或 Client ID 变化意味着换了一个 Achord Connect 连接：连接代次加一，旧连接的未读数、按请求记录和水位线全部作废
   *   （加锁顺序与 Webhook 一致：设置行 → 用户未读状态 → 按请求记录）。
   * - 启用状态变化时通知在线客户端：停用时推送 0，启用时推送当前未读数（停用期间只记录、不推送）。
   */
  async updateAdminConfig(input: UpdateAdminSupportIntegrationConfigInputDto): Promise<AdminSupportIntegrationConfigDto> {
    const saved = await this.prisma.$transaction(async (tx) => {
      await tx.systemSetting.createMany({ data: [{ key: SUPPORT_INTEGRATION_SETTING_KEY, value: {} }], skipDuplicates: true });
      await tx.$queryRaw`SELECT "key" FROM "SystemSetting" WHERE "key" = ${SUPPORT_INTEGRATION_SETTING_KEY} FOR UPDATE`;
      const row = await tx.systemSetting.findUniqueOrThrow({ where: { key: SUPPORT_INTEGRATION_SETTING_KEY } });
      const current = parseStoredSupportIntegrationConfig(row.value);
      const next = applyConfigUpdate(current, input);
      const connectionChanged = current.baseUrl !== next.baseUrl || current.clientId !== next.clientId;
      const wasEnabled = isStoredSupportIntegrationEnabled(current);
      const nowEnabled = isStoredSupportIntegrationEnabled(next);
      if (connectionChanged) {
        next.generation = current.generation + 1;
      }
      if (connectionChanged || wasEnabled !== nowEnabled) {
        next.epoch = current.epoch + 1;
      }
      const updated = await tx.systemSetting.update({ where: { key: SUPPORT_INTEGRATION_SETTING_KEY }, data: { value: next } });
      // 需要通知的是所有用过工单入口的用户，不只是当前记录里有未读的：记录可能刚被改成 0、但那次推送还没发出，
      // 而这次保存会推进推送代次、把它挡掉，所以这里要给每个人都推一次最终值。
      const withUnread = connectionChanged || wasEnabled !== nowEnabled
        ? await tx.supportUnreadState.findMany({ where: { unreadCount: { gte: 0 } }, select: { userId: true, unreadCount: true, revision: true } })
        : [];
      // 切换连接或重新启用后，所有用过工单入口的用户都要查询一次：连接可能已换（原来没有未读的用户在新连接里也可能有），
      // 停用期间也可能漏掉了变化。后台任务执行前会跳过近期已校准的用户。
      const resyncCandidates = nowEnabled && (connectionChanged || !wasEnabled) ? withUnread.map((item) => item.userId) : [];
      if (!connectionChanged && nowEnabled && !wasEnabled) {
        // 重新启用：停用期间可能漏掉了变化（例如当时换过 Webhook Secret），所有用户都视为待校准，后台任务不会因“刚校准过”而跳过。
        await tx.supportUnreadState.updateMany({ data: { syncedAt: null } });
      }
      if (connectionChanged) {
        // 重置后每位用户的版本号加一，下面的“推送 0”使用重置后的版本号。
        for (const item of withUnread) item.revision += 1;
        await tx.supportUnreadState.updateMany({
          data: { unreadCount: 0, sourceAt: null, snapshotUntil: null, syncedAt: null, requestsComplete: true, revision: { increment: 1 } }
        });
        await tx.supportRequestUnread.deleteMany({});
      }
      return { next, updatedAt: updated.updatedAt, connectionChanged, wasEnabled, nowEnabled, withUnread, resyncCandidates };
    });
    this.afterConfigSaved(saved);
    return this.toAdminConfig(saved.next, saved.updatedAt);
  }

  private afterConfigSaved(saved: {
    next: StoredSupportIntegrationConfig;
    connectionChanged: boolean;
    wasEnabled: boolean;
    nowEnabled: boolean;
    withUnread: Array<{ userId: string; unreadCount: number; revision: number }>;
    resyncCandidates: string[];
  }) {
    // 先推进推送代次：在这次保存之前提交、但尚未推送的结果，之后到达推送时会被丢弃。
    this.publicationEpoch = Math.max(this.publicationEpoch, saved.next.epoch);
    if (saved.connectionChanged) {
      // 清空限流记录，尽快向新连接查询。
      this.resyncAttempts.clear();
    }
    for (const userId of saved.resyncCandidates) {
      this.scheduleBackgroundResync(userId);
    }
    for (const item of saved.withUnread) {
      // 停用或切换连接：已在线的客户端清零；重新启用：推送停用期间记录的当前值。
      const count = saved.nowEnabled && !saved.connectionChanged ? item.unreadCount : 0;
      if (saved.connectionChanged && !saved.wasEnabled) {
        continue;
      }
      try {
        this.publishFenced(item.userId, count, saved.next.epoch, item.revision);
      } catch (error) {
        this.logger.warn(`工单系统接入设置变化后推送未读失败（用户 ${item.userId}）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
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
        // 客户端不会定时查询状态：交给后台稍后重试，结果通过推送送达。
        this.scheduleBackgroundResync(userId, 1);
      }
    } else if (stale) {
      // 被限流：同样交给后台在允许时查询。
      this.scheduleBackgroundResync(userId);
      return { enabled: true, unreadCount, supportOrigin: credentials.baseUrl };
    } else {
      return { enabled: true, unreadCount, supportOrigin: credentials.baseUrl };
    }
    // 校准期间设置可能已变：停用了就按未启用返回；换了连接就返回新连接下的本地值（已重置，稍后由后台查询新连接）。
    const latest = await this.readLaunchCredentials();
    if (!latest) {
      return { enabled: false, unreadCount: 0, supportOrigin: null };
    }
    if (latest.baseUrl !== credentials.baseUrl || latest.clientId !== credentials.clientId) {
      const current = await this.prisma.supportUnreadState.findUnique({ where: { userId }, select: { unreadCount: true } });
      return { enabled: true, unreadCount: current?.unreadCount ?? 0, supportOrigin: latest.baseUrl };
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
    const { webhookSecret, generation } = (await this.readStoredConfig()).value;
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
    const result = await this.applyUnreadChange(eventId, event.type, change, eventAt, generation);
    if (result === "stale") {
      this.logger.warn(`Achord Connect 未读事件 ${eventId} 在验签后连接已切换，已忽略`);
      return "ignored";
    }
    if (!result) {
      return "duplicate";
    }
    // 事件 ID 已随事务提交：之后的推送与排队都是内存操作，出错也只记日志，不能让 Webhook 返回失败，
    // 否则工单系统重试时会被当成重复事件而跳过。
    try {
      this.publishIfChanged(change.externalUserId, result);
      if (result.needsResync) {
        this.scheduleBackgroundResync(change.externalUserId);
      }
    } catch (error) {
      this.logger.warn(`Achord Connect 未读事件 ${eventId} 已记录，但推送或安排校准失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return "accepted";
  }

  /**
   * 在一个事务里记录事件 ID（去重）并更新未读数；同一用户的事件按行锁串行处理。
   * 返回 null 表示事件已处理过，"stale" 表示验签所用的连接已被切换。
   * 事件先后一律按工单系统的时间（事件 createdAt、未读查询响应的 Date）比较，不用本机时间。
   * - 早于最近一次权威总数的事件已包含在总数里，只记录事件 ID；同一请求晚到的旧事件也不会覆盖新值。
   * - 落在最近一次服务端查询的不确定区间里的事件，无法判断是否已包含在查询结果里：不采用其总数，改为重新查询。
   * - 同一请求在同一时刻出现两个不同的未读数，同样无法判断先后：保留已有记录，改为重新查询。
   * - 带 contactUnreadCount：以它为总数；但如果本地已有比它更新的按请求变化（新旧版本事件混在一起），
   *   两者先后无法对齐，就保留当前值并标记为待校准。
   * - 不带 contactUnreadCount（旧版工单系统）：只有从未接受过权威总数、本地记录由逐条事件累积而来时，
   *   才按请求求和；一旦接受过权威总数，本地记录无法证明与之一致，改为保留当前值并标记为待校准。
   */
  async applyUnreadChange(
    eventId: string,
    type: string,
    change: AchordConnectUnreadChange,
    eventAt: Date,
    generation: number
  ): Promise<UnreadTotalChange | null | "stale"> {
    const userId = change.externalUserId;
    return this.prisma.$transaction(async (tx) => {
      // 先拿设置行的共享锁并核对连接代次：验签之后若连接已切换，这个事件属于旧连接，不写入。
      const config = await lockSupportIntegrationConfigShared(tx);
      if (config.generation !== generation) {
        return "stale" as const;
      }
      const inserted = await tx.achordConnectWebhookEvent.createMany({ data: [{ eventId, type }], skipDuplicates: true });
      if (inserted.count === 0) {
        return null;
      }
      await tx.supportUnreadState.createMany({ data: [{ userId }], skipDuplicates: true });
      await tx.$queryRaw`SELECT "userId" FROM "SupportUnreadState" WHERE "userId" = ${userId} FOR UPDATE`;
      const state = await tx.supportUnreadState.findUniqueOrThrow({ where: { userId } });
      const publish = isStoredSupportIntegrationEnabled(config);
      const unchanged = { previous: state.unreadCount, next: state.unreadCount, revision: state.revision, publish: false, epoch: config.epoch };
      if (state.sourceAt && eventAt.getTime() < state.sourceAt.getTime()) {
        return unchanged;
      }
      const key = { userId_requestId: { userId, requestId: change.requestId } };
      const existing = await tx.supportRequestUnread.findUnique({ where: key, select: { eventAt: true, unreadCount: true } });
      // 同一请求在同一毫秒有两个不同的未读数：到达顺序不能代表先后，保留已有记录，改为重新查询。
      const sameInstantRequestConflict = Boolean(
        existing && existing.eventAt.getTime() === eventAt.getTime() && existing.unreadCount !== change.unreadCount
      );
      if (!existing || existing.eventAt.getTime() < eventAt.getTime()) {
        await tx.supportRequestUnread.upsert({
          where: key,
          create: { userId, requestId: change.requestId, unreadCount: change.unreadCount, eventAt },
          update: { unreadCount: change.unreadCount, eventAt }
        });
      }
      let data: { unreadCount?: number; sourceAt?: Date; syncedAt?: Date | null; requestsComplete?: boolean };
      const insideSnapshotWindow = Boolean(state.snapshotUntil && eventAt.getTime() < state.snapshotUntil.getTime());
      if (insideSnapshotWindow || sameInstantRequestConflict) {
        data = { syncedAt: null };
      } else if (change.contactUnreadCount !== null) {
        // 与当前权威总数同一时刻、却给出不同总数的事件，以及其他请求在同一时刻或之后已有变化的情况，
        // 都无法由到达顺序判断先后：不采用，改为重新查询。
        const sameInstantConflict = Boolean(state.sourceAt && state.sourceAt.getTime() === eventAt.getTime() && state.unreadCount !== change.contactUnreadCount);
        const concurrentRequests = await tx.supportRequestUnread.count({
          where: {
            userId,
            OR: [
              { requestId: { not: change.requestId }, eventAt: { gte: eventAt } },
              { requestId: change.requestId, eventAt: { gt: eventAt } }
            ]
          }
        });
        data = sameInstantConflict || concurrentRequests > 0
          ? { syncedAt: null }
          : { unreadCount: change.contactUnreadCount, sourceAt: eventAt, syncedAt: new Date(), requestsComplete: false };
      } else if (state.requestsComplete) {
        const sum = await tx.supportRequestUnread.aggregate({ where: { userId }, _sum: { unreadCount: true } });
        data = { unreadCount: sum._sum.unreadCount ?? 0 };
      } else {
        data = { syncedAt: null };
      }
      await tx.supportUnreadState.update({ where: { userId }, data: { ...data, revision: { increment: 1 } } });
      return {
        previous: state.unreadCount,
        next: data.unreadCount ?? state.unreadCount,
        revision: state.revision + 1,
        publish,
        epoch: config.epoch,
        needsResync: data.syncedAt === null
      };
    });
  }

  // ---------- 未读校准 ----------

  /**
   * 向工单系统查询该用户的未读总数并写回本地；失败时返回 null，由调用方继续使用本地值。
   * 查询结果不带版本号，无法与查询期间到达的 Webhook 比较先后：查询前记下本地版本号，写回时若版本已变
   * （查询期间处理过 Webhook），就放弃这次结果、保留 Webhook 的值，不标记为已校准，下次查询状态时再试。
   * 写回的是总数；按请求记录不动，并记为“与总数无法对齐”，之后旧版格式的事件不再据此推算总数。
   * 水位线用工单系统的时钟：响应头 Date 减去“请求超时 + 1 秒”。Date 是生成响应的时间（精确到秒），
   * 工单系统读取未读数一定发生在这次请求之内，而整个请求不超过超时时间，所以读取时刻不早于这条水位线；
   * 早于水位线的事件必然已包含在结果里。水位线之后、读取之前的事件会被再次接受，
   * 这些事件无法判断是否已包含在结果里，不直接采用其总数，而是由后台重新查询（见 snapshotUntil）。
   * 响应没有可用的 Date 时无法界定查询结果的时刻，不采用这次结果。
   */
  async resyncUnread(userId: string, credentials: AchordConnectCredentials): Promise<number | null> {
    const before = await this.prisma.supportUnreadState.findUnique({ where: { userId }, select: { revision: true } });
    const expectedRevision = before?.revision ?? 0;
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
    const serverTime = remote.serverTime;
    if (!serverTime) {
      this.logger.warn(`Achord Connect 未读查询响应缺少 Date，无法确定结果对应的时刻，本次不采用（用户 ${userId}）`);
      return null;
    }
    let result: UnreadTotalChange | null;
    try {
      result = await this.prisma.$transaction(async (tx) => {
        const config = await lockSupportIntegrationConfigShared(tx);
        await tx.supportUnreadState.createMany({ data: [{ userId }], skipDuplicates: true });
        await tx.$queryRaw`SELECT "userId" FROM "SupportUnreadState" WHERE "userId" = ${userId} FOR UPDATE`;
        const state = await tx.supportUnreadState.findUniqueOrThrow({ where: { userId } });
        const currentConnection = readCredentials(config);
        if (
          state.revision !== expectedRevision ||
          currentConnection?.baseUrl !== credentials.baseUrl ||
          currentConnection?.clientId !== credentials.clientId
        ) {
          // 查询期间处理过 Webhook，或连接已被切换：结果不再适用。
          return null;
        }
        const snapshotWatermark = new Date(serverTime.getTime() - SNAPSHOT_WATERMARK_MARGIN_MS);
        const sourceAt = !state.sourceAt || snapshotWatermark.getTime() > state.sourceAt.getTime() ? snapshotWatermark : state.sourceAt;
        // Date 只精确到秒，真实的响应时间在 [Date, Date + 1 秒) 之内；早于这个上界的事件都可能在读取之前或之后。
        const snapshotUntil = new Date(serverTime.getTime() + 1000);
        await tx.supportUnreadState.update({
          where: { userId },
          data: { unreadCount: remote.unreadCount, sourceAt, snapshotUntil, syncedAt: new Date(), requestsComplete: false, revision: { increment: 1 } }
        });
        return {
          previous: state.unreadCount,
          next: remote.unreadCount,
          revision: state.revision + 1,
          publish: isStoredSupportIntegrationEnabled(config),
          epoch: config.epoch
        };
      });
    } catch (error) {
      this.logger.warn(`Achord Connect 未读校准写入失败（用户 ${userId}）：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    if (!result) {
      this.logger.log(`Achord Connect 未读校准期间收到新的 Webhook 或连接已切换，本次结果不采用（用户 ${userId}）`);
      return null;
    }
    try {
      this.publishIfChanged(userId, result);
    } catch (error) {
      this.logger.warn(`Achord Connect 未读校准已写入，但推送失败（用户 ${userId}）：${error instanceof Error ? error.message : String(error)}`);
    }
    return result.next;
  }

  /**
   * 后台校准：由无法直接采用的 Webhook、被限流或失败的状态查询、切换连接触发。
   * 客户端不会定时查询状态，不能等下一次查询才纠正红点，结果通过推送送达。
   * 同一用户只排一个任务，遵守与状态查询相同的限流（同一用户 5 分钟一次、全进程每分钟上限），
   * 失败或被限流时按最小间隔重试，最多 BACKGROUND_RESYNC_MAX_ATTEMPTS 次；新工单系统停用后不再查询。
   */
  scheduleBackgroundResync(userId: string, attempt = 0, throttled = false) {
    if (this.backgroundResyncTimers.has(userId) || workLifecycle.isDraining || attempt >= BACKGROUND_RESYNC_MAX_ATTEMPTS) {
      return;
    }
    const last = this.resyncAttempts.get(userId);
    const untilAllowed = last === undefined ? 0 : Math.max(0, last + SUPPORT_UNREAD_RESYNC_MIN_INTERVAL_MS - Date.now());
    // 被全进程上限挡住时等到下一分钟窗口；失败重试至少间隔 1 分钟。
    const delay = attempt === 0 && !throttled ? untilAllowed : Math.max(untilAllowed, throttled ? 60_000 + Math.floor(Math.random() * 30_000) : 60_000);
    const timer = setTimeout(() => {
      this.backgroundResyncTimers.delete(userId);
      if (workLifecycle.isDraining || !promotionAdmission.isApproved()) {
        return;
      }
      void workLifecycle.track(this.runBackgroundResync(userId, attempt));
    }, delay);
    timer.unref?.();
    this.backgroundResyncTimers.set(userId, timer);
  }

  private async runBackgroundResync(userId: string, attempt: number) {
    try {
      const credentials = await this.readLaunchCredentials();
      if (!credentials) {
        return;
      }
      const state = await this.prisma.supportUnreadState.findUnique({ where: { userId }, select: { syncedAt: true } });
      if (state?.syncedAt && Date.now() - state.syncedAt.getTime() < SUPPORT_UNREAD_RESYNC_AFTER_MS) {
        return;
      }
      if (!this.claimResyncAttempt(userId, Date.now())) {
        // 被限流不算失败，不占重试次数，稍后再排。
        this.scheduleBackgroundResync(userId, attempt, true);
        return;
      }
      if ((await this.resyncUnread(userId, credentials)) === null) {
        this.scheduleBackgroundResync(userId, attempt + 1);
      }
    } catch (error) {
      this.logger.warn(`Achord Connect 后台未读校准失败（用户 ${userId}）：${error instanceof Error ? error.message : String(error)}`);
      this.scheduleBackgroundResync(userId, attempt + 1);
    }
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

  /**
   * 行锁保证了数据库写入的先后，但事务提交后到推送之间可能被并发的另一次写入插队：
   * 按写入后的版本号推送，比已推送版本旧的结果直接丢弃，客户端最终停在最新值上。
   * 停用新工单系统后仍记录未读（重新启用时可直接使用），但不再推给客户端，免得停用后又亮起红点；
   * 在切换连接或启用状态之前提交、之后才推送的结果（推送代次较旧）同样丢弃。
   * 这里没有任何等待，比较与记录版本号不会被插队。（版本记录在本进程内；生产环境是单个 API 进程。）
   */
  private publishIfChanged(userId: string, change: UnreadTotalChange) {
    if (change.epoch > this.publicationEpoch) {
      // 设置已在别处（或本进程重启前）推进过代次，跟上它。
      this.publicationEpoch = change.epoch;
    }
    if (change.previous === change.next || !change.publish) {
      return;
    }
    this.publishFenced(userId, change.next, change.epoch, change.revision);
  }

  /**
   * 所有未读推送的唯一出口（包括保存设置时的推送）：推送代次比当前旧，或（代次，版本号）不比已推送的新，都不推送；
   * 通过后才记录并推送，已推送的位置只会前进。保存设置时的推送代次更新，所以即使版本号相同也能送达。
   */
  private publishFenced(userId: string, count: number, epoch: number, revision: number) {
    if (epoch < this.publicationEpoch) {
      return;
    }
    const published = this.publishedRevisions.get(userId);
    if (published && (epoch < published.epoch || (epoch === published.epoch && revision <= published.revision))) {
      return;
    }
    this.publishedRevisions.delete(userId);
    this.publishedRevisions.set(userId, { epoch, revision });
    if (this.publishedRevisions.size > RESYNC_ATTEMPT_TRACKING_LIMIT) {
      const oldest = this.publishedRevisions.keys().next().value;
      if (oldest !== undefined) {
        this.publishedRevisions.delete(oldest);
      }
    }
    this.clientEventsPublisher.publishSupportUnreadUpdated(userId, count);
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
    return isStoredSupportIntegrationEnabled(value) ? readCredentials(value) : null;
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
  if (next.enabled && (!readCredentials(next) || !next.webhookSecret)) {
    // 客户端不会定时查询状态，未读提醒依赖 Webhook，所以启用前 Webhook Secret 也必须填写。
    throw new BadRequestException("启用前请先填写工单系统地址、Client ID、Client Secret 和 Webhook Secret");
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
