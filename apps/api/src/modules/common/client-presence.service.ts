import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type {
  AdminPresenceSessionDto,
  AdminPresenceSnapshotDto,
  AdminPresenceState,
  AdminUserClientVersionDto,
  AdminUserPresenceDto,
  ConnectionMode,
  SubscriptionState
} from "@chordv/shared";
import { Observable } from "rxjs";
import { workLifecycle } from "../../work-lifecycle";
import { AdminRuntimeEventsService } from "./admin-runtime-events.service";
import { throwLocalReadAsServiceUnavailable } from "./prisma-error.utils";
import { PrismaService } from "./prisma.service";
import { getLeaseHardExpireCutoff, isLeaseHardExpired, LEASE_HEARTBEAT_INTERVAL_SECONDS } from "./runtime-session.utils";
import { readEffectiveSubscriptionState, roundTrafficGb, toAdminUserClientVersion } from "./subscription.utils";

/** 客户端事件推送连接打开期间，每隔这么久刷新一次最近在线时间。 */
export const PRESENCE_REFRESH_MS = 60_000;
/** 超过这么久没有刷新就不再算在线（覆盖进程异常退出、来不及写离线的情况）。 */
export const PRESENCE_ONLINE_WINDOW_SECONDS = 150;
/** 最后一条推送连接断开后等这么久再记为离线，客户端短暂重连不会闪成离线。 */
export const PRESENCE_OFFLINE_GRACE_MS = 15_000;
/** 节点连接超过这么久没有心跳就不再算“已连接”：客户端每 30 秒心跳一次，允许连续错过 3 次。 */
export const PRESENCE_CONNECTED_WINDOW_SECONDS = Math.max(90, LEASE_HEARTBEAT_INTERVAL_SECONDS * 4);

const PRESENCE_REFRESH_BATCH_SIZE = 500;
/** 进程内节点心跳写入节流记录最多保留的用户数，超出后淘汰最久未写的。 */
const HEARTBEAT_WRITE_THROTTLE_LIMIT = 10_000;
const CONNECTION_MODES: ReadonlySet<string> = new Set<ConnectionMode>(["global", "rule", "direct"]);

export type PresenceRow = {
  userId: string;
  online: boolean;
  onlineSince: Date | null;
  lastSeenAt: Date;
};

export type PresenceLeaseRow = {
  sessionId: string;
  userId: string;
  status: string;
  issuedAt: Date;
  expiresAt: Date;
  lastHeartbeatAt: Date;
  connectionMode: string | null;
  node: {
    id: string;
    name: string;
    region: string;
    countryCode: string | null;
    provider: string;
    protocol: string;
    security: string;
  };
  subscription: {
    id: string;
    teamId: string | null;
    state: SubscriptionState;
    expireAt: Date;
    totalTrafficGb: number;
    usedTrafficGb: number;
    remainingTrafficGb: number;
    plan: { name: string };
    team: { name: string } | null;
  } | null;
};

export type PresenceUserRow = {
  id: string;
  displayName: string;
  email: string;
  teamMemberships: Array<{ team: { id: string; name: string } }>;
};

export type PresenceClientVersionRow = {
  userId: string;
  platform: AdminUserClientVersionDto["platform"];
  version: string;
  build: number | null;
  channel: AdminUserClientVersionDto["channel"];
  lastSeenAt: Date;
};

function onlineCutoff(now: Date) {
  return new Date(now.getTime() - PRESENCE_ONLINE_WINDOW_SECONDS * 1000);
}

/** 记录的最近在线时间仍在判定窗口内且未标记离线，才算客户端在线。 */
export function isPresenceOnline(row: Pick<PresenceRow, "online" | "lastSeenAt"> | null | undefined, now: Date) {
  return Boolean(row?.online) && row!.lastSeenAt.getTime() >= onlineCutoff(now).getTime();
}

/**
 * 本次客户端打开时的“在线起始时间”：距上次在线不超过判定窗口（短暂断线重连、后台重启交接）时沿用原来的起始时间，
 * 否则从现在算起。
 */
export function resolveOnlineSince(existing: Pick<PresenceRow, "onlineSince" | "lastSeenAt"> | null | undefined, now: Date) {
  if (existing?.onlineSince && existing.lastSeenAt.getTime() >= onlineCutoff(now).getTime() && existing.onlineSince.getTime() <= now.getTime()) {
    return existing.onlineSince;
  }
  return now;
}

/** 活跃租约且近期仍在心跳、未超过宽限期，才算“已连接（正在使用节点）”。 */
export function isLeaseConnected(lease: Pick<PresenceLeaseRow, "status" | "lastHeartbeatAt" | "expiresAt">, now: Date) {
  if (lease.status !== "active") return false;
  if (isLeaseHardExpired(lease.expiresAt, now)) return false;
  return lease.lastHeartbeatAt.getTime() >= now.getTime() - PRESENCE_CONNECTED_WINDOW_SECONDS * 1000;
}

export function normalizeConnectionMode(value: string | null | undefined): ConnectionMode | null {
  return typeof value === "string" && CONNECTION_MODES.has(value) ? (value as ConnectionMode) : null;
}

function maxDate(values: Array<Date | null | undefined>) {
  let result: Date | null = null;
  for (const value of values) {
    if (value && (!result || value.getTime() > result.getTime())) result = value;
  }
  return result;
}

function toPresenceSession(lease: PresenceLeaseRow): AdminPresenceSessionDto {
  const subscription = lease.subscription;
  return {
    sessionId: lease.sessionId,
    connectedAt: lease.issuedAt.toISOString(),
    lastHeartbeatAt: lease.lastHeartbeatAt.toISOString(),
    connectionMode: normalizeConnectionMode(lease.connectionMode),
    node: {
      id: lease.node.id,
      name: lease.node.name,
      region: lease.node.region,
      countryCode: lease.node.countryCode ?? null,
      provider: lease.node.provider,
      protocol: lease.node.protocol,
      security: lease.node.security
    },
    subscription: subscription
      ? {
          id: subscription.id,
          ownerType: subscription.teamId ? "team" : "user",
          teamName: subscription.team?.name ?? null,
          planName: subscription.plan.name,
          state: readEffectiveSubscriptionState(subscription),
          usedTrafficGb: roundTrafficGb(subscription.usedTrafficGb),
          totalTrafficGb: roundTrafficGb(subscription.totalTrafficGb),
          remainingTrafficGb: roundTrafficGb(subscription.remainingTrafficGb),
          expireAt: subscription.expireAt.toISOString()
        }
      : null
  };
}

const STATE_ORDER: Record<AdminPresenceState, number> = { connected: 0, online: 1, offline: 2 };

/**
 * 汇总在线状态：
 * - 已连接：有近期仍在心跳的节点连接（连接必然需要客户端打开，因此同时计入在线）；
 * - 在线：客户端已打开、登录并保持着事件推送连接，但没有连接节点；
 * - 离线：以上都不满足；最近在线时间取推送连接、节点心跳和检查更新三者中最新的一次。
 */
export function buildAdminPresenceSnapshot(input: {
  now: Date;
  users: PresenceUserRow[];
  presence: PresenceRow[];
  leases: PresenceLeaseRow[];
  clientVersions: PresenceClientVersionRow[];
}): AdminPresenceSnapshotDto {
  const { now } = input;
  const presenceByUser = new Map(input.presence.map((row) => [row.userId, row]));
  const sessionsByUser = new Map<string, PresenceLeaseRow[]>();
  for (const lease of input.leases) {
    if (!isLeaseConnected(lease, now)) continue;
    const list = sessionsByUser.get(lease.userId) ?? [];
    list.push(lease);
    sessionsByUser.set(lease.userId, list);
  }
  const versionsByUser = new Map<string, PresenceClientVersionRow[]>();
  for (const row of input.clientVersions) {
    const list = versionsByUser.get(row.userId) ?? [];
    list.push(row);
    versionsByUser.set(row.userId, list);
  }

  const users: AdminUserPresenceDto[] = [];
  for (const user of input.users) {
    const presence = presenceByUser.get(user.id) ?? null;
    const leases = (sessionsByUser.get(user.id) ?? []).sort((left, right) => left.issuedAt.getTime() - right.issuedAt.getTime());
    const versions = versionsByUser.get(user.id) ?? [];
    const latestVersion = versions.reduce<PresenceClientVersionRow | null>(
      (latest, row) => (!latest || row.lastSeenAt.getTime() > latest.lastSeenAt.getTime() ? row : latest),
      null
    );
    const clientOnline = isPresenceOnline(presence, now);
    const state: AdminPresenceState = leases.length ? "connected" : clientOnline ? "online" : "offline";
    const lastOnlineAt = maxDate([
      presence?.lastSeenAt,
      ...leases.map((lease) => lease.lastHeartbeatAt),
      latestVersion?.lastSeenAt
    ]);
    if (state === "offline" && !lastOnlineAt) continue;
    const earliestLease = leases[0]?.issuedAt ?? null;
    const onlineSince = state === "offline"
      ? null
      : clientOnline && presence?.onlineSince
        ? earliestLease && earliestLease.getTime() < presence.onlineSince.getTime() ? earliestLease : presence.onlineSince
        : earliestLease;
    const team = user.teamMemberships[0]?.team ?? null;
    users.push({
      userId: user.id,
      displayName: user.displayName,
      email: user.email,
      teamId: team?.id ?? null,
      teamName: team?.name ?? null,
      state,
      onlineSince: onlineSince?.toISOString() ?? null,
      lastOnlineAt: (state === "offline" ? lastOnlineAt : now)?.toISOString() ?? null,
      client: latestVersion ? toAdminUserClientVersion(latestVersion) : null,
      sessions: leases.map(toPresenceSession)
    });
  }

  users.sort((left, right) =>
    STATE_ORDER[left.state] - STATE_ORDER[right.state] ||
    (left.state === "offline"
      ? Date.parse(right.lastOnlineAt ?? "") - Date.parse(left.lastOnlineAt ?? "")
      : Date.parse(left.onlineSince ?? "") - Date.parse(right.onlineSince ?? "")) ||
    left.displayName.localeCompare(right.displayName, "zh-CN")
  );
  const connected = users.filter((user) => user.state === "connected").length;
  const idle = users.filter((user) => user.state === "online").length;
  return {
    generatedAt: now.toISOString(),
    connectedWindowSeconds: PRESENCE_CONNECTED_WINDOW_SECONDS,
    onlineWindowSeconds: PRESENCE_ONLINE_WINDOW_SECONDS,
    counts: { online: connected + idle, connected, idle },
    users
  };
}

/**
 * 客户端在线状态。
 *
 * 已登录的桌面客户端打开期间会一直保持 /client/events/stream 推送连接，这里按用户记录连接数：
 * 第一条连接打开时记为在线，最后一条断开 15 秒后记为离线，期间每分钟刷新一次最近在线时间。
 * 后台 API 为单实例部署；多实例时某实例断开会先记离线，仍保持连接的实例在下一次刷新（1 分钟内）恢复在线。
 * 进程异常退出时来不及记离线，由“超过判定窗口即离线”兜底。
 */
@Injectable()
export class ClientPresenceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClientPresenceService.name);
  private readonly streamCounts = new Map<string, number>();
  private readonly offlineTimers = new Map<string, NodeJS.Timeout>();
  /** 同一用户的在线/离线写入在进程内逐个执行，不会互相覆盖。 */
  private readonly writeQueues = new Map<string, Promise<void>>();
  /** 每位用户最近一次因节点心跳写入最近在线时间的时刻，用于每分钟最多写一次。 */
  private readonly heartbeatWrites = new Map<string, number>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshing: Promise<void> | null = null;
  /** 可在测试中调短。 */
  offlineGraceMs = PRESENCE_OFFLINE_GRACE_MS;

  constructor(
    private readonly prisma: PrismaService,
    private readonly adminRuntimeEventsService: AdminRuntimeEventsService
  ) {}

  onModuleInit() {
    this.refreshTimer = setInterval(() => {
      if (workLifecycle.isDraining || this.refreshing) return;
      this.refreshing = workLifecycle.track(this.refreshOnlineUsers()).finally(() => {
        this.refreshing = null;
      });
    }, PRESENCE_REFRESH_MS);
    this.refreshTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    for (const timer of this.offlineTimers.values()) clearTimeout(timer);
    this.offlineTimers.clear();
  }

  /** 包装用户的事件推送流：订阅期间计为在线，取消订阅（客户端断开、退出登录、后台交接）时计为断开。 */
  trackStream<T>(userId: string, stream: Observable<T>): Observable<T> {
    return new Observable<T>((subscriber) => {
      this.streamOpened(userId);
      const subscription = stream.subscribe(subscriber);
      return () => {
        subscription.unsubscribe();
        this.streamClosed(userId);
      };
    });
  }

  streamOpened(userId: string, now = new Date()) {
    const count = (this.streamCounts.get(userId) ?? 0) + 1;
    this.streamCounts.set(userId, count);
    const pendingOffline = this.offlineTimers.get(userId);
    if (pendingOffline) {
      // 断开后很快重连：取消待写的离线，库里仍是在线。
      clearTimeout(pendingOffline);
      this.offlineTimers.delete(userId);
      return;
    }
    if (count === 1 && !workLifecycle.isDraining) {
      void workLifecycle.track(this.runExclusive(userId, () => this.markOnline(userId, now)));
    }
  }

  streamClosed(userId: string, now = new Date()) {
    const count = (this.streamCounts.get(userId) ?? 0) - 1;
    if (count > 0) {
      this.streamCounts.set(userId, count);
      return;
    }
    this.streamCounts.delete(userId);
    // 后台交接时新实例会接手客户端的重连；来不及交接则由判定窗口兜底为离线。
    if (workLifecycle.isDraining || this.offlineTimers.has(userId)) return;
    const timer = setTimeout(() => {
      this.offlineTimers.delete(userId);
      if ((this.streamCounts.get(userId) ?? 0) > 0 || workLifecycle.isDraining) return;
      void workLifecycle.track(this.runExclusive(userId, () => this.markOffline(userId, now)));
    }, this.offlineGraceMs);
    timer.unref?.();
    this.offlineTimers.set(userId, timer);
  }

  /**
   * 节点心跳也说明客户端在运行：推送连接已断开、但仍在心跳的用户，把最近在线时间记到心跳时刻，
   * 连接撤销或心跳超时后“最近在线”仍然准确。只更新已记为离线（或还没有记录）的用户，不改变在线判定；
   * 本进程仍保持着推送连接的用户由定时刷新负责。每位用户每分钟最多写一次。
   */
  noteHeartbeat(userId: string, at = new Date()) {
    if ((this.streamCounts.get(userId) ?? 0) > 0 || workLifecycle.isDraining) return;
    const last = this.heartbeatWrites.get(userId);
    if (last !== undefined && at.getTime() - last < PRESENCE_REFRESH_MS) return;
    this.heartbeatWrites.delete(userId);
    this.heartbeatWrites.set(userId, at.getTime());
    if (this.heartbeatWrites.size > HEARTBEAT_WRITE_THROTTLE_LIMIT) {
      const oldest = this.heartbeatWrites.keys().next().value;
      if (oldest !== undefined) this.heartbeatWrites.delete(oldest);
    }
    void workLifecycle.track(this.runExclusive(userId, () => this.recordHeartbeat(userId, at)));
  }

  /** 当前进程里保持着推送连接的用户数（诊断用）。 */
  localOnlineUserCount() {
    return this.streamCounts.size;
  }

  async getAdminPresenceSnapshot(now = new Date()): Promise<AdminPresenceSnapshotDto> {
    try {
      const [presence, leases, clientVersions] = await workLifecycle.all([
        this.prisma.userClientPresence.findMany({
          select: { userId: true, online: true, onlineSince: true, lastSeenAt: true }
        }),
        this.prisma.nodeSessionLease.findMany({
          where: {
            status: "active",
            lastHeartbeatAt: { gte: new Date(now.getTime() - PRESENCE_CONNECTED_WINDOW_SECONDS * 1000) },
            expiresAt: { gt: getLeaseHardExpireCutoff(now) }
          },
          select: {
            sessionId: true,
            userId: true,
            status: true,
            issuedAt: true,
            expiresAt: true,
            lastHeartbeatAt: true,
            connectionMode: true,
            node: {
              select: { id: true, name: true, region: true, countryCode: true, provider: true, protocol: true, security: true }
            },
            subscription: {
              select: {
                id: true,
                teamId: true,
                state: true,
                expireAt: true,
                totalTrafficGb: true,
                usedTrafficGb: true,
                remainingTrafficGb: true,
                plan: { select: { name: true } },
                team: { select: { name: true } }
              }
            }
          },
          orderBy: { issuedAt: "asc" }
        }),
        this.prisma.userClientVersion.findMany({
          select: { userId: true, platform: true, version: true, build: true, channel: true, lastSeenAt: true }
        })
      ]);
      const userIds = Array.from(
        new Set([...presence.map((row) => row.userId), ...leases.map((row) => row.userId), ...clientVersions.map((row) => row.userId)])
      );
      const users = userIds.length
        ? await this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: {
              id: true,
              displayName: true,
              email: true,
              teamMemberships: { select: { team: { select: { id: true, name: true } } }, take: 1 }
            }
          })
        : [];
      return buildAdminPresenceSnapshot({ now, users, presence, leases, clientVersions });
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "在线状态暂时不可用，请稍后重试。");
    }
  }

  private async markOnline(userId: string, now: Date) {
    try {
      const existing = await this.prisma.userClientPresence.findUnique({
        where: { userId },
        select: { online: true, onlineSince: true, lastSeenAt: true }
      });
      const onlineSince = resolveOnlineSince(existing, now);
      // 不让最近在线时间倒退（另一实例或更晚的刷新可能已写过更新的时间）。
      const lastSeenAt = existing && existing.lastSeenAt.getTime() > now.getTime() ? existing.lastSeenAt : now;
      await this.prisma.userClientPresence.upsert({
        where: { userId },
        create: { userId, online: true, onlineSince, lastSeenAt },
        update: { online: true, onlineSince, lastSeenAt }
      });
      if (!isPresenceOnline(existing, now)) this.notifyChanged();
    } catch (error) {
      // 下一次定时刷新会补写，这里只记录。
      this.logger.warn(`在线状态记录失败：${readErrorMessage(error)}`);
    }
  }

  private async markOffline(userId: string, closedAt: Date) {
    try {
      // 只在记录不晚于断开时间时写离线：另一实例在此之后刷新过，说明客户端仍在线。
      const updated = await this.prisma.userClientPresence.updateMany({
        where: { userId, online: true, lastSeenAt: { lte: closedAt } },
        data: { online: false, lastSeenAt: closedAt }
      });
      if (updated.count > 0) this.notifyChanged();
    } catch (error) {
      this.logger.warn(`离线状态记录失败：${readErrorMessage(error)}`);
    }
  }

  private async recordHeartbeat(userId: string, at: Date) {
    try {
      const updated = await this.prisma.userClientPresence.updateMany({
        where: { userId, online: false, lastSeenAt: { lt: at } },
        data: { lastSeenAt: at }
      });
      if (updated.count > 0) return;
      // 还没有任何记录（例如上线前就已连接、推送连接一直没连上）：补一条离线记录，只用于最近在线时间。
      await this.prisma.userClientPresence.createMany({
        data: [{ userId, online: false, onlineSince: null, lastSeenAt: at }],
        skipDuplicates: true
      });
    } catch (error) {
      this.logger.warn(`心跳在线时间记录失败：${readErrorMessage(error)}`);
    }
  }

  /** 定时刷新本进程保持着推送连接的用户；记录缺失或已超出判定窗口的逐个重新记为在线。 */
  async refreshOnlineUsers(now = new Date()) {
    const userIds = Array.from(this.streamCounts.keys());
    for (let index = 0; index < userIds.length; index += PRESENCE_REFRESH_BATCH_SIZE) {
      const batch = userIds.slice(index, index + PRESENCE_REFRESH_BATCH_SIZE);
      try {
        const updated = await this.prisma.userClientPresence.updateMany({
          where: { userId: { in: batch }, online: true, lastSeenAt: { gte: onlineCutoff(now) } },
          data: { lastSeenAt: now }
        });
        if (updated.count >= batch.length) continue;
        const fresh = await this.prisma.userClientPresence.findMany({
          where: { userId: { in: batch }, online: true, lastSeenAt: { gte: now } },
          select: { userId: true }
        });
        const freshIds = new Set(fresh.map((row) => row.userId));
        for (const userId of batch) {
          if (freshIds.has(userId) || !(this.streamCounts.get(userId) ?? 0)) continue;
          await this.runExclusive(userId, () => this.markOnline(userId, now));
        }
      } catch (error) {
        this.logger.warn(`在线状态刷新失败：${readErrorMessage(error)}`);
      }
    }
  }

  private notifyChanged() {
    this.adminRuntimeEventsService.publishPresenceUpdated();
  }

  private runExclusive(key: string, task: () => Promise<void>): Promise<void> {
    const previous = this.writeQueues.get(key) ?? Promise.resolve();
    const run = previous.then(task);
    const tail = run.then(() => undefined, () => undefined);
    this.writeQueues.set(key, tail);
    void tail.then(() => {
      if (this.writeQueues.get(key) === tail) this.writeQueues.delete(key);
    });
    return tail;
  }
}

function readErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
