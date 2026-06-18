import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException
} from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { createHash } from "node:crypto";
import * as net from "node:net";
import { Client as PgClient } from "pg";
import type {
  AuthSessionDto,
  ClientBootstrapDto,
  ClientNodeProbeResultDto,
  ClientPingDto,
  ClientVersionDto,
  NodeProbeStatus,
  NodeSummaryDto,
  PlatformTarget,
  PolicyBundleDto,
  SubscriptionState,
  SubscriptionStatusDto,
  TeamMemberRole,
  TeamStatus
} from "@chordv/shared";
import { AnnouncementPolicyService } from "./announcement-policy.service";
import { AuthSessionService } from "./auth-session.service";
import { ClientRuntimeEventsService } from "./client-runtime-events.service";
import { ClientTicketService } from "./client-ticket.service";
import { MeteringIncidentService } from "./metering-incident.service";
import { isPrismaTransientError } from "./prisma-error.utils";
import { PrismaService } from "./prisma.service";
import { ReleaseCenterService } from "./release-center.service";
import {
  pickCurrentSubscription,
  toSubscriptionStatusDto
} from "./subscription.utils";
import { toNodeSummary } from "./node-import.utils";

const LOGIN_DUMMY_PASSWORD_HASH = bcrypt.hashSync("chordv-login-dummy-password", 10);
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_BASE_BACKOFF_MS = 30_000;
const LOGIN_MAX_BACKOFF_MS = 15 * 60_000;
const LOGIN_BUCKET_TTL_MS = 60 * 60_000;
const PROBE_RATE_LIMIT = 30;
const PROBE_RATE_WINDOW_MS = 60_000;
const PROBE_RATE_BLOCK_MS = 60_000;
const MAX_CLIENT_NODE_PROBE_IDS = 32;
const MAX_CLIENT_NODE_ID_LENGTH = 128;
const MAX_CONCURRENT_NODE_PROBES = 6;
const RATE_LIMIT_LOCK_KEY_1 = 420_705;
const DEFAULT_RATE_LIMIT_LOCK_WAIT_TIMEOUT_MS = 5_000;
const DEFAULT_RATE_LIMIT_LOCK_RETRY_INTERVAL_MS = 100;

type ClientSubscriptionAccess = {
  subscription: {
    id: string;
    planId: string;
    totalTrafficGb: number;
    usedTrafficGb: number;
    remainingTrafficGb: number;
    expireAt: Date;
    state: SubscriptionState;
    renewable: boolean;
    lastSyncedAt: Date;
    plan: { name: string; maxConcurrentSessions: number };
    user: { id: string; status: "active" | "disabled" } | null;
    team: { id: string; name: string; status: TeamStatus } | null;
  } | null;
  team: { id: string; name: string; status: TeamStatus } | null;
  memberRole: TeamMemberRole | null;
  memberUsedTrafficGb: number | null;
};

@Injectable()
export class ClientAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authSessionService: AuthSessionService,
    private readonly clientRuntimeEventsService: ClientRuntimeEventsService,
    private readonly meteringIncidentService: MeteringIncidentService,
    private readonly announcementPolicyService: AnnouncementPolicyService,
    private readonly clientTicketService: ClientTicketService,
    private readonly releaseCenterService: ReleaseCenterService
  ) {}

  async login(account: string, password: string, clientIp = "unknown"): Promise<AuthSessionDto> {
    const normalizedAccount = account.trim().toLowerCase();
    const loginKeys = this.createLoginRateLimitKeys(normalizedAccount, clientIp);
    return runWithRateLimitBucketLocks(loginKeys, async () => {
      await this.assertLoginAllowed(loginKeys);
      const user = await this.resolveUserForLogin(normalizedAccount);

      if (!user) {
        await bcrypt.compare(password, LOGIN_DUMMY_PASSWORD_HASH);
        await this.recordFailedLogin(loginKeys, { lockHeld: true });
        throw new UnauthorizedException("账号或密码错误");
      }

      const matched = await bcrypt.compare(password, user.passwordHash);
      if (!matched) {
        await this.recordFailedLogin(loginKeys, { lockHeld: true });
        throw new UnauthorizedException("账号或密码错误");
      }
      if (user.status !== "active") {
        await this.recordFailedLogin(loginKeys, { lockHeld: true });
        throw new ForbiddenException("当前账号已禁用，请联系管理员处理。");
      }

      return this.createLoginSessionAfterSuccess(user.id, loginKeys);
    });
  }

  async refresh(token: string): Promise<AuthSessionDto> {
    return this.authSessionService.rotateRefreshToken(token);
  }

  async logout(token?: string, refreshToken?: string) {
    await this.authSessionService.revokeByAccessOrRefreshToken(token, refreshToken);
    return { ok: true };
  }

  async streamRuntimeEvents(token?: string, lastEventId?: string | null) {
    const user = await this.authSessionService.authenticateAccessToken(token);
    return this.clientRuntimeEventsService.streamForUser(user.id, {
      lastEventId,
      validate: async () => {
        await this.authSessionService.authenticateAccessToken(token);
      }
    });
  }

  async getBootstrap(token?: string, platform?: PlatformTarget): Promise<ClientBootstrapDto> {
    const user = await this.authSessionService.authenticateAccessToken(token);
    const access = await this.resolveSubscriptionAccessForUser(user.id);
    if (!access.subscription) {
      throw new NotFoundException("当前没有可用订阅");
    }

    const metering = await this.meteringIncidentService.getSubscriptionMeteringState(access.subscription.id);
    const policies = await this.announcementPolicyService.getPolicies();
    const version = await this.getClientVersion(platform);
    const announcements = await this.loadOptionalBootstrapPart(() => this.announcementPolicyService.getAnnouncements(token), []);
    const supportTickets = await this.loadOptionalBootstrapPart(() => this.clientTicketService.getClientSupportTicketInbox(user.id), {
      totalCount: 0,
      unreadCount: 0
    });

    return {
      user,
      subscription: toSubscriptionStatusDto(access.subscription, access.team, access.memberUsedTrafficGb, metering),
      policies,
      announcements,
      supportTickets,
      version,
      team: access.team
        ? {
            id: access.team.id,
            name: access.team.name,
            status: access.team.status,
            role: access.memberRole ?? "member"
          }
        : null
    };
  }

  async getSubscription(token?: string): Promise<SubscriptionStatusDto> {
    const user = await this.authSessionService.authenticateAccessToken(token);
    const access = await this.resolveSubscriptionAccessForUser(user.id);
    if (!access.subscription) {
      throw new NotFoundException("当前没有可用订阅");
    }

    const metering = await this.meteringIncidentService.getSubscriptionMeteringState(access.subscription.id);
    return toSubscriptionStatusDto(access.subscription, access.team, access.memberUsedTrafficGb, metering);
  }

  async getNodes(token?: string): Promise<NodeSummaryDto[]> {
    const user = await this.authSessionService.authenticateAccessToken(token);
    const access = await this.resolveSubscriptionAccessForUser(user.id);
    if (!access.subscription) {
      return [];
    }
    if (!isClientSubscriptionUsable(access)) {
      return [];
    }

    const rows = await this.prisma.subscriptionNodeAccess.findMany({
      where: {
        subscriptionId: access.subscription.id,
        node: {
          isActive: true,
          panelEnabled: true
        }
      },
      include: { node: true },
      orderBy: [{ node: { recommended: "desc" } }, { node: { latencyMs: "asc" } }, { node: { createdAt: "desc" } }]
    });

    const nodeMap = new Map<string, NodeSummaryDto>();
    for (const row of rows) {
      if (!nodeMap.has(row.nodeId)) {
        nodeMap.set(row.nodeId, toNodeSummary(row.node));
      }
    }
    return Array.from(nodeMap.values());
  }

  async probeClientNodes(nodeIds: string[], token?: string): Promise<ClientNodeProbeResultDto[]> {
    const user = await this.authSessionService.authenticateAccessToken(token);
    await this.consumeRateLimit([`node-probe:user:${user.id}`], {
      limit: PROBE_RATE_LIMIT,
      windowMs: PROBE_RATE_WINDOW_MS,
      blockMs: PROBE_RATE_BLOCK_MS,
      message: "Too many node probe requests. Please try again later."
    });
    const access = await this.resolveSubscriptionAccessForUser(user.id);
    if (!access.subscription) {
      return [];
    }
    if (!isClientSubscriptionUsable(access)) {
      return [];
    }

    const requestedNodeIds = normalizeClientProbeNodeIds(nodeIds);
    if (requestedNodeIds.length === 0) {
      return [];
    }

    const rows = await this.prisma.subscriptionNodeAccess.findMany({
      where: {
        subscriptionId: access.subscription.id,
        nodeId: { in: requestedNodeIds },
        node: {
          isActive: true,
          panelEnabled: true
        }
      },
      include: { node: true }
    });

    const rowMap = new Map(rows.map((row) => [row.nodeId, row.node]));
    return mapWithConcurrency(requestedNodeIds, MAX_CONCURRENT_NODE_PROBES, async (nodeId) => {
        const node = rowMap.get(nodeId);
        if (!node) {
          return {
            nodeId,
            status: "offline" as const,
            latencyMs: null,
            checkedAt: new Date().toISOString(),
            error: "当前订阅未开通该节点"
          };
        }

        const probe = await probeNodeConnectivity(node.serverHost, node.serverPort);
        return {
          nodeId,
          status: probe.status === "healthy" ? "healthy" as const : "offline" as const,
          latencyMs: probe.latencyMs,
          checkedAt: new Date().toISOString(),
          error: probe.error
        };
      });
  }

  async getPolicies(): Promise<PolicyBundleDto> {
    return this.announcementPolicyService.getPolicies();
  }

  async getClientVersion(platform?: PlatformTarget): Promise<ClientVersionDto> {
    const profile = await this.prisma.policyProfile.findUnique({
      where: { id: "default" }
    });
    if (!platform) {

      if (!profile) {
        throw new NotFoundException("版本配置不存在");
      }

      return {
        currentVersion: profile.currentVersion,
        minimumVersion: profile.minimumVersion,
        forceUpgrade: profile.forceUpgrade,
        changelog: profile.changelog,
        downloadUrl: profile.downloadUrl
      };
    }

    const baselineVersion = profile?.currentVersion ?? "0.0.0";
    const update = await this.releaseCenterService.checkClientUpdate({
      currentVersion: baselineVersion,
      platform,
      channel: "stable"
    });

    if (!update.recommendedArtifact && update.latestVersion === baselineVersion) {
      if (!profile) {
        throw new NotFoundException("版本配置不存在");
      }

      return {
        currentVersion: profile.currentVersion,
        minimumVersion: profile.minimumVersion,
        forceUpgrade: profile.forceUpgrade,
        changelog: profile.changelog,
        downloadUrl: profile.downloadUrl
      };
    }

    return {
      currentVersion: update.latestVersion,
      minimumVersion: update.minimumVersion,
      forceUpgrade: update.forceUpgrade,
      changelog: update.changelog,
      downloadUrl: update.downloadUrl ?? null
    };
  }

  async pingClient(token?: string): Promise<ClientPingDto> {
    await this.authSessionService.authenticateAccessToken(token);
    return {
      ok: true,
      serverTime: new Date().toISOString()
    };
  }

  private async loadOptionalBootstrapPart<T>(task: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await task();
    } catch (error) {
      if (isPrismaTransientError(error)) {
        return fallback;
      }
      throw error;
    }
  }

  private async resolveSubscriptionAccessForUser(userId: string): Promise<ClientSubscriptionAccess> {
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

  private async resolveUserForLogin(account: string) {
    return this.prisma.user.findUnique({
      where: { email: account }
    });
  }

  private createLoginRateLimitKeys(account: string, clientIp: string) {
    const ip = clientIp.trim() || "unknown";
    return [`ip:${ip}`, `account:${account}`, `ip-account:${ip}:${account}`];
  }

  private async assertLoginAllowed(keys: string[]) {
    const blockedUntil = await this.findBlockedUntil(keys);
    if (blockedUntil && blockedUntil.getTime() > Date.now()) {
      throw new HttpException("Too many login attempts. Please try again later.", HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private async recordFailedLogin(keys: string[], options?: { lockHeld?: boolean }) {
    const record = async () => {
      const now = Date.now();
      for (const key of keys) {
        const current = await this.prisma.rateLimitBucket.findUnique({ where: { key } });
        const isExpired = !current || current.updatedAt.getTime() + LOGIN_BUCKET_TTL_MS < now;
        const count = (isExpired ? 0 : current.count) + 1;
        const excess = Math.max(0, count - LOGIN_FAILURE_LIMIT);
        const blockedUntil =
          excess > 0
            ? new Date(now + Math.min(LOGIN_MAX_BACKOFF_MS, LOGIN_BASE_BACKOFF_MS * 2 ** Math.min(excess - 1, 8)))
            : null;
        await this.prisma.rateLimitBucket.upsert({
          where: { key },
          create: {
            key,
            count,
            blockedUntil
          },
          update: {
            count,
            blockedUntil
          }
        });
      }
    };
    if (options?.lockHeld) {
      return record();
    }
    return runWithRateLimitBucketLocks(keys, record);
  }

  private async clearLoginFailures(keys: string[], options?: { lockHeld?: boolean }) {
    const clear = async () => this.prisma.rateLimitBucket.deleteMany({
      where: { key: { in: keys } }
    });
    if (options?.lockHeld) {
      await clear();
      return;
    }
    await runWithRateLimitBucketLocks(keys, clear);
  }

  private async createLoginSessionAfterSuccess(userId: string, loginKeys: string[]) {
    try {
      await this.clearLoginFailures(loginKeys, { lockHeld: true });
      const updated = await this.prisma.user.update({
        where: { id: userId },
        data: { lastSeenAt: new Date() }
      });
      return await this.authSessionService.issueSession(updated.id);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new ServiceUnavailableException("登录状态保存失败，请稍后重试。");
    }
  }

  private async consumeRateLimit(
    keys: string[],
    options: { limit: number; windowMs: number; blockMs: number; message: string }
  ) {
    await runWithRateLimitBucketLocks(keys, async () => {
      const now = Date.now();
      const blockedUntil = await this.findBlockedUntil(keys);
      if (blockedUntil && blockedUntil.getTime() > now) {
        throw new HttpException(options.message, HttpStatus.TOO_MANY_REQUESTS);
      }

      for (const key of keys) {
        const current = await this.prisma.rateLimitBucket.findUnique({ where: { key } });
        const isExpired = !current || current.updatedAt.getTime() + options.windowMs < now;
        const count = (isExpired ? 0 : current.count) + 1;
        const blockedUntil = count > options.limit ? new Date(now + options.blockMs) : null;
        await this.prisma.rateLimitBucket.upsert({
          where: { key },
          create: {
            key,
            count,
            blockedUntil
          },
          update: {
            count,
            blockedUntil
          }
        });
      }
    });
  }

  private async findBlockedUntil(keys: string[]) {
    const buckets = await this.prisma.rateLimitBucket.findMany({
      where: {
        key: { in: keys },
        blockedUntil: { gt: new Date() }
      },
      orderBy: { blockedUntil: "desc" },
      take: 1
    });
    return buckets[0]?.blockedUntil ?? null;
  }

}

function normalizeClientProbeNodeIds(nodeIds: string[]) {
  const normalized = Array.from(
    new Set(
      nodeIds
        .filter((item) => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0 && item.length <= MAX_CLIENT_NODE_ID_LENGTH)
    )
  );
  if (normalized.length > MAX_CLIENT_NODE_PROBE_IDS) {
    throw new HttpException(
      `Too many node probes in one request. Maximum is ${MAX_CLIENT_NODE_PROBE_IDS}.`,
      HttpStatus.TOO_MANY_REQUESTS
    );
  }
  return normalized;
}

function isClientSubscriptionUsable(access: ClientSubscriptionAccess) {
  const subscription = access.subscription;
  if (!subscription) {
    return false;
  }
  if (subscription.user?.status === "disabled") {
    return false;
  }
  if (access.team?.status && access.team.status !== "active") {
    return false;
  }
  if (subscription.team?.status && subscription.team.status !== "active") {
    return false;
  }
  return subscription.state === "active" && subscription.expireAt.getTime() > Date.now() && subscription.remainingTrafficGb > 0;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>) {
  const results: R[] = [];
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await worker(items[currentIndex]);
      }
    })
  );
  return results;
}

async function runWithRateLimitBucketLocks<T>(keys: string[], task: () => Promise<T>) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return task();
  }

  const uniqueKeys = Array.from(new Set(keys)).sort();
  const lockClient = new PgClient({
    connectionString,
    connectionTimeoutMillis: readPositiveIntegerEnv(
      "CHORDV_RATE_LIMIT_LOCK_CONNECT_TIMEOUT_MS",
      readRateLimitLockWaitTimeoutMs()
    )
  });
  const lockedKeys: string[] = [];
  try {
    try {
      await lockClient.connect();
      for (const key of uniqueKeys) {
        await acquireRateLimitPgLock(lockClient, key);
        lockedKeys.push(key);
      }
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new ServiceUnavailableException("登录限流锁暂时不可用，请稍后重试。");
    }
    return await task();
  } finally {
    for (const key of lockedKeys.reverse()) {
      await lockClient
        .query("select pg_advisory_unlock($1, $2)", [RATE_LIMIT_LOCK_KEY_1, deriveRateLimitLockKey(key)])
        .catch(() => undefined);
    }
    await lockClient.end().catch(() => undefined);
  }
}

function deriveRateLimitLockKey(key: string) {
  return createHash("sha256").update(key).digest().readInt32BE(0);
}

async function acquireRateLimitPgLock(client: PgClient, key: string) {
  const timeoutMs = readRateLimitLockWaitTimeoutMs();
  const retryIntervalMs = readRateLimitLockRetryIntervalMs();
  const deadline = Date.now() + timeoutMs;
  const args: [number, number] = [RATE_LIMIT_LOCK_KEY_1, deriveRateLimitLockKey(key)];

  for (;;) {
    const result = await client.query("select pg_try_advisory_lock($1, $2) as locked", args);
    if (result.rows[0]?.locked === true) {
      return;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new ConflictException("rate limit bucket is still being processed; please retry shortly.");
    }
    await delay(Math.min(retryIntervalMs, remainingMs));
  }
}

function readRateLimitLockWaitTimeoutMs() {
  return readPositiveIntegerEnv("CHORDV_RATE_LIMIT_LOCK_WAIT_TIMEOUT_MS", DEFAULT_RATE_LIMIT_LOCK_WAIT_TIMEOUT_MS);
}

function readRateLimitLockRetryIntervalMs() {
  return readPositiveIntegerEnv("CHORDV_RATE_LIMIT_LOCK_RETRY_INTERVAL_MS", DEFAULT_RATE_LIMIT_LOCK_RETRY_INTERVAL_MS);
}

function readPositiveIntegerEnv(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeNodeConnectivity(
  host: string,
  port: number
): Promise<{ status: NodeProbeStatus; latencyMs: number | null; error: string | null }> {
  try {
    const latencyMs = await probeTcp(host, port);
    return {
      status: "healthy",
      latencyMs,
      error: null
    };
  } catch (error) {
    return {
      status: "offline",
      latencyMs: null,
      error: formatError(error)
    };
  }
}

function probeTcp(host: string, port: number) {
  return new Promise<number>((resolve, reject) => {
    const startedAt = Date.now();
    const socket = net.createConnection({ host, port });
    const cleanup = () => {
      socket.removeAllListeners();
      socket.destroy();
    };

    socket.setTimeout(5000);
    socket.once("connect", () => {
      const latency = Math.max(1, Date.now() - startedAt);
      cleanup();
      resolve(latency);
    });
    socket.once("timeout", () => {
      cleanup();
      reject(new Error("TCP 超时"));
    });
    socket.once("error", (error: Error) => {
      cleanup();
      reject(error);
    });
  });
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
