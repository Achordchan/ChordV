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
import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { Observable } from "rxjs";
import { workLifecycle } from "../../work-lifecycle";
import { AdminRuntimeEventsService } from "./admin-runtime-events.service";
import { throwLocalReadAsServiceUnavailable } from "./prisma-error.utils";
import { PrismaService } from "./prisma.service";
import { isLeaseHardExpired, LEASE_HEARTBEAT_INTERVAL_SECONDS } from "./runtime-session.utils";
import { readEffectiveSubscriptionState, roundTrafficGb, toAdminUserClientVersion } from "./subscription.utils";

/** 客户端事件推送连接打开期间，每隔这么久刷新一次推送连接记录与最近在线时间。 */
export const PRESENCE_REFRESH_MS = 60_000;
/** 推送连接记录超过这么久没有刷新就不再算在线（覆盖进程异常退出、来不及删除记录的情况）。 */
export const PRESENCE_ONLINE_WINDOW_SECONDS = 150;
/** 最后一条推送连接断开后等这么久再删除记录，客户端短暂重连不会闪成离线。 */
export const PRESENCE_OFFLINE_GRACE_MS = 15_000;
/** 节点连接超过这么久没有心跳就不再算“已连接”：客户端每 30 秒心跳一次，允许连续错过 3 次。 */
export const PRESENCE_CONNECTED_WINDOW_SECONDS = Math.max(90, LEASE_HEARTBEAT_INTERVAL_SECONDS * 4);
/** 后台列表按租约查这段时间内有过心跳的连接（不限状态）；更早的心跳已由 noteHeartbeat 写进最近在线记录。 */
export const PRESENCE_HEARTBEAT_HISTORY_MS = 24 * 60 * 60_000;
/** 进程异常退出留下的推送连接记录，超过这么久未刷新就清理掉。 */
export const PRESENCE_STREAM_STALE_CLEANUP_MS = 10 * 60_000;
/** 新版客户端保持推送连接期间，约每隔这么久调用一次 /client/ping，证明客户端仍在运行。 */
export const PRESENCE_PING_INTERVAL_SECONDS = 60;
/**
 * 声明了定期上报（?presence=ping）的推送连接，超过这么久既没有收到该用户的上报、连接也不是这段时间内建立的，
 * 就当作客户端已睡眠或断网（TCP 没有正常关闭，服务端自己发现不了）：主动结束这条连接并立即记为离线。
 * 允许错过一次上报，再留 30 秒余量。
 */
export const PRESENCE_PING_TIMEOUT_SECONDS = 150;
/** 每隔这么久检查一次本进程上声明了定期上报的推送连接。 */
export const PRESENCE_PING_CHECK_MS = 30_000;
/** 同一用户的上报在本进程内至少间隔这么久才写一次库：客户端每 60 秒上报一次，正常情况下每次上报写一次。 */
export const PRESENCE_PING_WRITE_THROTTLE_MS = 50_000;

const PRESENCE_REFRESH_BATCH_SIZE = 500;
/** 进程内节点心跳写入节流记录最多保留的用户数，超出后淘汰最久未写的。 */
const HEARTBEAT_WRITE_THROTTLE_LIMIT = 10_000;
/** 进程内在线上报记录最多保留的用户数，超出后淘汰最久未上报的（被淘汰的用户改以数据库里的上报时间为准）。 */
const PING_RECORD_LIMIT = 10_000;
/** 在线上报写库失败的日志每隔这么久最多记一条，数据库故障时不刷屏。 */
const PING_WRITE_WARN_INTERVAL_MS = 60_000;
const CONNECTION_MODES: ReadonlySet<string> = new Set<ConnectionMode>(["global", "rule", "direct"]);

export type ClientEventStreamOptions = {
  /** 客户端声明保持这条推送连接期间会定期调用 /client/ping（新版客户端才会带上）。 */
  presencePing?: boolean;
};

/** 推送流请求里的 `presence=ping` 声明：只认这一个值，其他值与缺省一样按旧客户端处理。 */
export function isPresencePingDeclared(value: unknown) {
  return value === "ping";
}

/**
 * 声明了定期上报的推送连接是否已失效：连接建立和该用户最近一次上报都算客户端仍在运行的证明，
 * 取较晚的一次，超过上报超时即失效。时间均为毫秒时间戳。
 */
export function isKeepaliveStreamExpired(openedAt: number, lastPingAt: number | null | undefined, now: number) {
  return now - Math.max(openedAt, lastPingAt ?? 0) > PRESENCE_PING_TIMEOUT_SECONDS * 1000;
}

/** 本进程上一条声明了定期上报的推送连接。 */
type KeepaliveStream = {
  openedAt: number;
  /** 因上报超时被服务端主动结束。 */
  expired: boolean;
  end: () => void;
};

/** 用户的最近在线记录。 */
export type PresenceRow = {
  userId: string;
  onlineSince: Date | null;
  lastSeenAt: Date;
};

/** 某个 API 进程为用户保持着的推送连接记录。 */
export type PresenceStreamRow = {
  userId: string;
  connectedAt: Date;
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

/** 推送连接记录仍在判定窗口内刷新过，才算客户端在线。 */
export function isStreamLive(row: Pick<PresenceStreamRow, "lastSeenAt">, now: Date) {
  return row.lastSeenAt.getTime() >= onlineCutoff(now).getTime();
}

/**
 * 本次客户端打开时的“在线起始时间”：距上次在线不超过判定窗口（短暂断线重连、后台重启交接、另一台设备仍在线）
 * 时沿用原来的起始时间，否则从现在算起。
 */
export function resolveOnlineSince(existing: Pick<PresenceRow, "onlineSince" | "lastSeenAt"> | null | undefined, now: Date) {
  if (existing?.onlineSince && existing.lastSeenAt.getTime() >= onlineCutoff(now).getTime() && existing.onlineSince.getTime() <= now.getTime()) {
    return existing.onlineSince;
  }
  return now;
}

/**
 * 与 resolveOnlineSince 同一规则的数据库条件：命中时把在线开始时间重置为 at。
 * 条件随更新语句一起执行，多个进程同时写同一用户时不依赖先读后写。
 */
export function buildOnlineStartResetCondition(userIds: string | string[], at: Date): Prisma.UserClientPresenceWhereInput {
  return {
    userId: typeof userIds === "string" ? userIds : { in: userIds },
    OR: [
      { onlineSince: null },
      { onlineSince: { gt: at } },
      { lastSeenAt: { lt: onlineCutoff(at) } }
    ]
  };
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

function minDate(values: Array<Date | null | undefined>) {
  let result: Date | null = null;
  for (const value of values) {
    if (value && (!result || value.getTime() < result.getTime())) result = value;
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

function groupByUser<T extends { userId: string }>(rows: T[], keep: (row: T) => boolean = () => true) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    if (!keep(row)) continue;
    const list = grouped.get(row.userId) ?? [];
    list.push(row);
    grouped.set(row.userId, list);
  }
  return grouped;
}

const STATE_ORDER: Record<AdminPresenceState, number> = { connected: 0, online: 1, offline: 2 };

/**
 * 汇总在线状态：
 * - 已连接：有近期仍在心跳的节点连接（连接必然需要客户端打开，因此同时计入在线）；
 * - 在线：任一 API 进程上保持着近期刷新过的推送连接记录，但没有连接节点；
 * - 离线：以上都不满足；最近在线时间取最近在线记录（含推送连接与节点心跳）、近期连接（不限状态）的最后心跳和检查更新时间中最新的一次。
 *
 * 在线开始时间优先取最近在线记录里本次在线的开始时间（断线超过判定窗口后会重置，例如电脑睡眠后唤醒）；
 * 没有可用记录时才退回推送连接的建立时间，最后才用节点连接的建立时间。
 */
export function buildAdminPresenceSnapshot(input: {
  now: Date;
  users: PresenceUserRow[];
  presence: PresenceRow[];
  streams: PresenceStreamRow[];
  /** 近期有过心跳的连接，不限状态：活跃且仍在心跳的算“已连接”，其余只用来取最后心跳。 */
  leases: PresenceLeaseRow[];
  clientVersions: PresenceClientVersionRow[];
}): AdminPresenceSnapshotDto {
  const { now } = input;
  const presenceByUser = new Map(input.presence.map((row) => [row.userId, row]));
  const streamsByUser = groupByUser(input.streams, (row) => isStreamLive(row, now));
  const sessionsByUser = groupByUser(input.leases, (lease) => isLeaseConnected(lease, now));
  const versionsByUser = groupByUser(input.clientVersions);
  const lastHeartbeatByUser = new Map<string, Date>();
  for (const lease of input.leases) {
    const current = lastHeartbeatByUser.get(lease.userId);
    if (!current || lease.lastHeartbeatAt.getTime() > current.getTime()) lastHeartbeatByUser.set(lease.userId, lease.lastHeartbeatAt);
  }

  const users: AdminUserPresenceDto[] = [];
  for (const user of input.users) {
    const presence = presenceByUser.get(user.id) ?? null;
    const streams = streamsByUser.get(user.id) ?? [];
    const leases = (sessionsByUser.get(user.id) ?? []).sort((left, right) => left.issuedAt.getTime() - right.issuedAt.getTime());
    const latestVersion = (versionsByUser.get(user.id) ?? []).reduce<PresenceClientVersionRow | null>(
      (latest, row) => (!latest || row.lastSeenAt.getTime() > latest.lastSeenAt.getTime() ? row : latest),
      null
    );
    const clientOnline = streams.length > 0;
    const state: AdminPresenceState = leases.length ? "connected" : clientOnline ? "online" : "offline";
    const lastOnlineAt = maxDate([
      presence?.lastSeenAt,
      ...streams.map((stream) => stream.lastSeenAt),
      ...leases.map((lease) => lease.lastHeartbeatAt),
      lastHeartbeatByUser.get(user.id),
      latestVersion?.lastSeenAt
    ]);
    if (state === "offline" && !lastOnlineAt) continue;
    // 最近在线记录仍在判定窗口内（推送连接每分钟刷新、节点心跳每分钟推进），它的开始时间就是本次在线的开始。
    const recordedSince = presence?.onlineSince && isStreamLive(presence, now) ? presence.onlineSince : null;
    const onlineSince = state === "offline"
      ? null
      : recordedSince ?? (clientOnline ? minDate(streams.map((stream) => stream.connectedAt)) : null) ?? leases[0]?.issuedAt ?? null;
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
 * 已登录的桌面客户端打开期间会一直保持 /client/events/stream 推送连接。每个 API 进程为它持有推送连接的用户
 * 各保留一条 UserClientPresenceStream 记录（按进程区分），每分钟刷新；该进程上这位用户的最后一条推送连接
 * 断开 15 秒后删除自己的记录。任一进程有近期刷新的记录即为在线，因此一台设备断开不会让连在另一实例上的
 * 设备显示离线。进程异常退出时来不及删除，由“超过判定窗口即不算在线”兜底，并由其他进程定期清理。
 * UserClientPresence 另记最近在线时间（推送连接与节点心跳都会推进，只前进不后退）与本次在线开始时间，供离线后展示。
 *
 * 电脑睡眠或断网时 TCP 往往不会正常关闭，服务端要等连接超时（最坏十几分钟）才发现推送连接已断。新版客户端打开推送连接时
 * 带上 `?presence=ping` 声明，之后每 60 秒调用一次 /client/ping；本进程每 30 秒检查一次这类连接，超过 150 秒既没有该用户的
 * 上报、连接也不是这段时间内建立的，就主动结束连接并立即记为离线（约 2～3 分钟内）。上报可能落在另一个进程上，所以上报时间
 * 同时记在本进程内存与 UserClientPresence.lastPingAt（带条件只前进不后退，每位用户每进程约每分钟最多写一次），本进程内存
 * 里没有足够新的上报时才查库。上报按用户记，同一账号任一台新版设备仍在上报时，其他设备的推送连接不会被这一机制断开；
 * 不带声明的旧客户端（1.1.10 及更早）行为不变。
 */
@Injectable()
export class ClientPresenceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClientPresenceService.name);
  /** 本进程的标识，重启后变化；旧进程留下的记录会随判定窗口失效并被清理。 */
  readonly instanceId = randomUUID();
  private readonly streamCounts = new Map<string, number>();
  private readonly offlineTimers = new Map<string, NodeJS.Timeout>();
  /** 同一用户的在线/离线写入在进程内逐个执行，不会互相覆盖。 */
  private readonly writeQueues = new Map<string, Promise<void>>();
  /** 每位用户最近一次因节点心跳写入最近在线时间的时刻，用于每分钟最多写一次。 */
  private readonly heartbeatWrites = new Map<string, number>();
  /** 本进程上声明了定期上报的推送连接，按用户分组。 */
  private readonly keepaliveStreams = new Map<string, Set<KeepaliveStream>>();
  /** 本进程收到的每位用户最近一次上报时刻，以及最近一次因上报写库的时刻（节流用）。 */
  private readonly pings = new Map<string, { at: number; writtenAt: number | null }>();
  private lastPingWriteWarnAt = 0;
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshing: Promise<void> | null = null;
  private pingCheckTimer: NodeJS.Timeout | null = null;
  private checkingPings: Promise<void> | null = null;
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
    this.pingCheckTimer = setInterval(() => {
      if (workLifecycle.isDraining || this.checkingPings || this.keepaliveStreams.size === 0) return;
      this.checkingPings = workLifecycle.track(this.checkKeepaliveStreams()).finally(() => {
        this.checkingPings = null;
      });
    }, PRESENCE_PING_CHECK_MS);
    this.pingCheckTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    if (this.pingCheckTimer) clearInterval(this.pingCheckTimer);
    this.pingCheckTimer = null;
    for (const timer of this.offlineTimers.values()) clearTimeout(timer);
    this.offlineTimers.clear();
  }

  /**
   * 包装用户的事件推送流：订阅期间计为在线，取消订阅（客户端断开、退出登录、后台交接）时计为断开。
   * 客户端声明了定期上报（presencePing）的连接，上报中断超过 150 秒会被主动结束，并且不等宽限期直接记为离线。
   */
  trackStream<T>(userId: string, stream: Observable<T>, options: ClientEventStreamOptions = {}): Observable<T> {
    return new Observable<T>((subscriber) => {
      const keepalive: KeepaliveStream | null = options.presencePing
        ? { openedAt: Date.now(), expired: false, end: () => subscriber.complete() }
        : null;
      if (keepalive) this.addKeepaliveStream(userId, keepalive);
      this.streamOpened(userId);
      const subscription = stream.subscribe(subscriber);
      return () => {
        subscription.unsubscribe();
        if (keepalive) this.removeKeepaliveStream(userId, keepalive);
        this.streamClosed(userId, new Date(), { immediate: keepalive?.expired === true });
      };
    });
  }

  streamOpened(userId: string, now = new Date()) {
    const count = (this.streamCounts.get(userId) ?? 0) + 1;
    this.streamCounts.set(userId, count);
    const pendingOffline = this.offlineTimers.get(userId);
    if (pendingOffline) {
      // 断开后很快重连：取消待删除的记录，库里仍是在线。
      clearTimeout(pendingOffline);
      this.offlineTimers.delete(userId);
      return;
    }
    if (count === 1 && !workLifecycle.isDraining) {
      void workLifecycle.track(this.runExclusive(userId, () => this.markOnline(userId, now)));
    }
  }

  /** immediate：连接因上报超时被服务端结束，客户端早已不在，不再等宽限期。 */
  streamClosed(userId: string, now = new Date(), options: { immediate?: boolean } = {}) {
    const count = (this.streamCounts.get(userId) ?? 0) - 1;
    if (count > 0) {
      this.streamCounts.set(userId, count);
      return;
    }
    this.streamCounts.delete(userId);
    // 后台交接时新进程会接手客户端的重连；来不及交接则由判定窗口兜底为离线。
    if (workLifecycle.isDraining || this.offlineTimers.has(userId)) return;
    if (options.immediate) {
      void workLifecycle.track(this.runExclusive(userId, () => this.markOffline(userId, now)));
      return;
    }
    const timer = setTimeout(() => {
      this.offlineTimers.delete(userId);
      if ((this.streamCounts.get(userId) ?? 0) > 0 || workLifecycle.isDraining) return;
      void workLifecycle.track(this.runExclusive(userId, () => this.markOffline(userId, now)));
    }, this.offlineGraceMs);
    timer.unref?.();
    this.offlineTimers.set(userId, timer);
  }

  /**
   * 节点心跳也说明客户端在运行：推送连接已断开、但仍在心跳的用户，把最近在线时间推进到心跳时刻，
   * 连接撤销或心跳超时很久之后“最近在线”仍然准确。不影响在线判定（在线只看推送连接记录）；
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
    void workLifecycle.track(this.runExclusive(userId, () => this.touchLastSeen(userId, at)));
  }

  /**
   * 新版客户端的在线上报（/client/ping）：本进程内存记下上报时刻（每次都记，供本进程检查推送连接），
   * 同时把 UserClientPresence.lastPingAt 推进到上报时刻，供持有推送连接的其他进程判断。
   * 写库按用户节流（本进程内至少间隔 50 秒），带条件只前进不后退；写库失败不影响接口响应。
   */
  notePing(userId: string, at = new Date()) {
    const time = at.getTime();
    const previous = this.pings.get(userId);
    const shouldWrite = !workLifecycle.isDraining &&
      (previous?.writtenAt == null || time - previous.writtenAt >= PRESENCE_PING_WRITE_THROTTLE_MS);
    this.pings.delete(userId);
    this.pings.set(userId, {
      at: Math.max(time, previous?.at ?? 0),
      writtenAt: shouldWrite ? time : previous?.writtenAt ?? null
    });
    if (this.pings.size > PING_RECORD_LIMIT) {
      const oldest = this.pings.keys().next().value;
      if (oldest !== undefined) this.pings.delete(oldest);
    }
    if (!shouldWrite) return;
    void workLifecycle.track(this.runExclusive(userId, () => this.recordPing(userId, at)));
  }

  /**
   * 检查本进程上声明了定期上报的推送连接：连接建立与该用户最近一次上报都已超过 150 秒的，主动结束并立即记为离线。
   * 本进程内存里的上报足够新时不查库（单实例部署下稳定状态零查询）；否则按批查 UserClientPresence.lastPingAt，
   * 覆盖上报落在其他进程上的情况。查库失败时这一轮不断开任何连接（退回原来的行为），下一轮再查。
   */
  async checkKeepaliveStreams(now = new Date()) {
    const nowMs = now.getTime();
    const pending: string[] = [];
    for (const [userId, streams] of this.keepaliveStreams) {
      const localPing = this.pings.get(userId)?.at;
      for (const stream of streams) {
        if (isKeepaliveStreamExpired(stream.openedAt, localPing, nowMs)) {
          pending.push(userId);
          break;
        }
      }
    }
    let ended = 0;
    for (let index = 0; index < pending.length; index += PRESENCE_REFRESH_BATCH_SIZE) {
      const batch = pending.slice(index, index + PRESENCE_REFRESH_BATCH_SIZE);
      let stored: Map<string, number | null>;
      try {
        const rows = await this.prisma.userClientPresence.findMany({
          where: { userId: { in: batch } },
          select: { userId: true, lastPingAt: true }
        });
        stored = new Map(rows.map((row) => [row.userId, row.lastPingAt?.getTime() ?? null]));
      } catch (error) {
        this.logger.warn(`在线上报检查失败：${readErrorMessage(error)}`);
        continue;
      }
      for (const userId of batch) {
        // 查库期间可能又收到了上报，这里重新读本进程的记录。
        const lastPing = Math.max(this.pings.get(userId)?.at ?? 0, stored.get(userId) ?? 0) || null;
        for (const stream of Array.from(this.keepaliveStreams.get(userId) ?? [])) {
          if (!isKeepaliveStreamExpired(stream.openedAt, lastPing, nowMs)) continue;
          stream.expired = true;
          stream.end();
          ended += 1;
        }
      }
    }
    if (ended > 0) {
      this.logger.log(`已断开 ${ended} 条超过 ${PRESENCE_PING_TIMEOUT_SECONDS} 秒未上报在线的推送连接`);
    }
  }

  /** 当前进程里保持着推送连接的用户数（诊断用）。 */
  localOnlineUserCount() {
    return this.streamCounts.size;
  }

  async getAdminPresenceSnapshot(now = new Date()): Promise<AdminPresenceSnapshotDto> {
    try {
      // 连接只查近一天内有过心跳的（不限状态，走 lastHeartbeatAt 索引）：活跃且仍在心跳的是当前连接，
      // 已撤销或心跳超时的只用来取离线用户的最后心跳。更早的心跳由 noteHeartbeat 写进了 UserClientPresence.lastSeenAt。
      // 不扫全部历史租约：租约表没有保留期，而后台每 30 秒会拉一次。
      const [presence, streams, leases, clientVersions] = await workLifecycle.all([
        this.prisma.userClientPresence.findMany({
          select: { userId: true, onlineSince: true, lastSeenAt: true }
        }),
        this.prisma.userClientPresenceStream.findMany({
          where: { lastSeenAt: { gte: onlineCutoff(now) } },
          select: { userId: true, connectedAt: true, lastSeenAt: true }
        }),
        this.prisma.nodeSessionLease.findMany({
          where: { lastHeartbeatAt: { gte: new Date(now.getTime() - PRESENCE_HEARTBEAT_HISTORY_MS) } },
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
        new Set([
          ...presence.map((row) => row.userId),
          ...streams.map((row) => row.userId),
          ...leases.map((row) => row.userId),
          ...clientVersions.map((row) => row.userId)
        ])
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
      return buildAdminPresenceSnapshot({ now, users, presence, streams, leases, clientVersions });
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "在线状态暂时不可用，请稍后重试。");
    }
  }

  private async markOnline(userId: string, now: Date) {
    try {
      const otherLive = await this.prisma.userClientPresenceStream.count({
        where: { userId, instanceId: { not: this.instanceId }, lastSeenAt: { gte: onlineCutoff(now) } }
      });
      await this.advancePresenceOrThrow(userId, now);
      await this.prisma.userClientPresenceStream.upsert({
        where: { userId_instanceId: { userId, instanceId: this.instanceId } },
        create: { userId, instanceId: this.instanceId, connectedAt: now, lastSeenAt: now },
        update: { lastSeenAt: now }
      });
      if (otherLive === 0) this.notifyChanged();
    } catch (error) {
      // 下一次定时刷新会补写，这里只记录。
      this.logger.warn(`在线状态记录失败：${readErrorMessage(error)}`);
    }
  }

  private async markOffline(userId: string, closedAt: Date) {
    try {
      // 只删除本进程的记录；其他进程仍保持着的推送连接不受影响。
      const deleted = await this.prisma.userClientPresenceStream.deleteMany({
        where: { userId, instanceId: this.instanceId }
      });
      await this.advancePresenceOrThrow(userId, closedAt);
      if (deleted.count > 0) this.notifyChanged();
    } catch (error) {
      this.logger.warn(`离线状态记录失败：${readErrorMessage(error)}`);
    }
  }

  private addKeepaliveStream(userId: string, stream: KeepaliveStream) {
    const streams = this.keepaliveStreams.get(userId) ?? new Set<KeepaliveStream>();
    streams.add(stream);
    this.keepaliveStreams.set(userId, streams);
  }

  private removeKeepaliveStream(userId: string, stream: KeepaliveStream) {
    const streams = this.keepaliveStreams.get(userId);
    if (!streams) return;
    streams.delete(stream);
    if (streams.size === 0) this.keepaliveStreams.delete(userId);
  }

  /**
   * 把最近一次上报时间推进到 at（只前进不后退，多个进程同时写同一用户也不会倒退）。
   * 没有记录（推送连接的上线写入还没完成或失败过）时补一条，这次上报同样说明客户端在 at 时刻仍在运行。
   */
  private async recordPing(userId: string, at: Date) {
    try {
      const updated = await this.prisma.userClientPresence.updateMany({
        where: { userId, OR: [{ lastPingAt: null }, { lastPingAt: { lt: at } }] },
        data: { lastPingAt: at }
      });
      if (updated.count > 0) return;
      await this.prisma.userClientPresence.createMany({
        data: [{ userId, onlineSince: at, lastSeenAt: at, lastPingAt: at }],
        skipDuplicates: true
      });
    } catch (error) {
      // 本进程内存里已记下上报时间，本进程上的推送连接不受影响；日志每分钟最多一条。
      const nowMs = Date.now();
      if (nowMs - this.lastPingWriteWarnAt >= PING_WRITE_WARN_INTERVAL_MS) {
        this.lastPingWriteWarnAt = nowMs;
        this.logger.warn(`在线上报记录失败：${readErrorMessage(error)}`);
      }
    }
  }

  private async touchLastSeen(userId: string, at: Date) {
    try {
      await this.advancePresenceOrThrow(userId, at);
    } catch (error) {
      this.logger.warn(`最近在线时间记录失败：${readErrorMessage(error)}`);
    }
  }

  /**
   * 客户端在 at 时刻仍在运行（推送连接打开/断开、节点心跳）：
   * 1. 没有记录时补一条，在线开始时间即 at；
   * 2. 距上次在线已超过判定窗口（或没有开始时间）时，把在线开始时间重置为 at，
   *    例如长时间离线后先恢复了节点心跳、之后才连上推送连接，不会接着很久以前的开始时间算；
   * 3. 最近在线时间推进到 at，只前进不后退。
   * 三步都是带条件的单条语句，多个进程同时写同一用户时由数据库保证不会倒退，不依赖先读后写。
   */
  private async advancePresenceOrThrow(userId: string, at: Date) {
    const created = await this.prisma.userClientPresence.createMany({
      data: [{ userId, onlineSince: at, lastSeenAt: at }],
      skipDuplicates: true
    });
    if (created.count > 0) return;
    await this.prisma.userClientPresence.updateMany({
      where: buildOnlineStartResetCondition(userId, at),
      data: { onlineSince: at }
    });
    await this.prisma.userClientPresence.updateMany({
      where: { userId, lastSeenAt: { lt: at } },
      data: { lastSeenAt: at }
    });
  }

  /**
   * 定时刷新本进程保持着推送连接的用户：推送连接记录与最近在线时间各一条批量更新；
   * 记录缺失（之前写库失败或被当作过期清理）的逐个补回。顺带清理异常退出的进程留下的过期记录。
   */
  async refreshOnlineUsers(now = new Date()) {
    const userIds = Array.from(this.streamCounts.keys());
    for (let index = 0; index < userIds.length; index += PRESENCE_REFRESH_BATCH_SIZE) {
      const batch = userIds.slice(index, index + PRESENCE_REFRESH_BATCH_SIZE);
      try {
        const updated = await this.prisma.userClientPresenceStream.updateMany({
          where: { instanceId: this.instanceId, userId: { in: batch } },
          data: { lastSeenAt: now }
        });
        if (updated.count < batch.length) {
          // 先补回缺失的推送连接记录（markOnline 会按规则处理在线开始时间），再统一推进最近在线时间。
          const existing = await this.prisma.userClientPresenceStream.findMany({
            where: { instanceId: this.instanceId, userId: { in: batch } },
            select: { userId: true }
          });
          const existingIds = new Set(existing.map((row) => row.userId));
          for (const userId of batch) {
            if (existingIds.has(userId) || !(this.streamCounts.get(userId) ?? 0)) continue;
            await this.runExclusive(userId, () => this.markOnline(userId, now));
          }
        }
        // 与 advancePresenceOrThrow 相同的顺序：先按规则重置过期的在线开始时间，再推进最近在线时间。
        // 例如之前的上线写入失败、记录还停在几天前，刷新时不会把整段离线时间算进在线时长。
        await this.prisma.userClientPresence.updateMany({
          where: buildOnlineStartResetCondition(batch, now),
          data: { onlineSince: now }
        });
        await this.prisma.userClientPresence.updateMany({
          where: { userId: { in: batch }, lastSeenAt: { lt: now } },
          data: { lastSeenAt: now }
        });
      } catch (error) {
        this.logger.warn(`在线状态刷新失败：${readErrorMessage(error)}`);
      }
    }
    try {
      await this.prisma.userClientPresenceStream.deleteMany({
        where: { lastSeenAt: { lt: new Date(now.getTime() - PRESENCE_STREAM_STALE_CLEANUP_MS) } }
      });
    } catch (error) {
      this.logger.warn(`过期在线记录清理失败：${readErrorMessage(error)}`);
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
