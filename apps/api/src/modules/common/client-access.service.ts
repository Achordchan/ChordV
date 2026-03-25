import { Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import * as net from "node:net";
import type {
  AuthSessionDto,
  ClientBootstrapDto,
  ClientNodeProbeResultDto,
  ClientPingDto,
  ClientVersionDto,
  NodeProbeStatus,
  NodeSummaryDto,
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
import { PrismaService } from "./prisma.service";
import {
  pickCurrentSubscription,
  toSubscriptionStatusDto
} from "./subscription.utils";

const BUILTIN_ADMIN_ACCOUNT = "admin";

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

export function toNodeSummary(row: {
  id: string;
  name: string;
  region: string;
  provider: string;
  tags: string[];
  recommended: boolean;
  latencyMs: number;
  probeLatencyMs?: number | null;
  protocol: string;
  security: string;
}): NodeSummaryDto {
  return {
    id: row.id,
    name: row.name,
    region: row.region,
    provider: row.provider,
    tags: row.tags,
    recommended: row.recommended,
    latencyMs: row.probeLatencyMs ?? row.latencyMs,
    protocol: row.protocol as "vless",
    security: row.security as "reality"
  };
}

@Injectable()
export class ClientAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authSessionService: AuthSessionService,
    private readonly clientRuntimeEventsService: ClientRuntimeEventsService,
    private readonly meteringIncidentService: MeteringIncidentService,
    private readonly announcementPolicyService: AnnouncementPolicyService,
    private readonly clientTicketService: ClientTicketService
  ) {}

  async login(account: string, password: string): Promise<AuthSessionDto> {
    const user = await this.resolveUserForLogin(account.trim().toLowerCase());

    if (!user || user.status !== "active") {
      throw new UnauthorizedException("账号或密码错误");
    }

    const matched = await bcrypt.compare(password, user.passwordHash);
    if (!matched) {
      throw new UnauthorizedException("账号或密码错误");
    }

    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { lastSeenAt: new Date() }
    });
    return this.authSessionService.issueSession(updated.id);
  }

  async refresh(token: string): Promise<AuthSessionDto> {
    return this.authSessionService.rotateRefreshToken(token);
  }

  async logout(token?: string) {
    await this.authSessionService.revokeByAccessToken(token);
    return { ok: true };
  }

  async streamRuntimeEvents(token?: string) {
    const user = await this.authSessionService.authenticateAccessToken(token);
    return this.clientRuntimeEventsService.streamForUser(user.id);
  }

  async getBootstrap(token?: string): Promise<ClientBootstrapDto> {
    const user = await this.authSessionService.authenticateAccessToken(token);
    const access = await this.resolveSubscriptionAccessForUser(user.id);
    if (!access.subscription) {
      throw new NotFoundException("当前没有可用订阅");
    }

    const metering = await this.meteringIncidentService.getSubscriptionMeteringState(access.subscription.id);
    const [policies, announcements, version, supportTickets] = await Promise.all([
      this.announcementPolicyService.getPolicies(),
      this.announcementPolicyService.getAnnouncements(token),
      this.getClientVersion(),
      this.clientTicketService.getClientSupportTicketInbox(user.id)
    ]);

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

    const rows = await this.prisma.subscriptionNodeAccess.findMany({
      where: { subscriptionId: access.subscription.id },
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
    const access = await this.resolveSubscriptionAccessForUser(user.id);
    if (!access.subscription) {
      return [];
    }

    const requestedNodeIds = Array.from(new Set(nodeIds.filter((item) => typeof item === "string" && item.trim().length > 0)));
    if (requestedNodeIds.length === 0) {
      return [];
    }

    const rows = await this.prisma.subscriptionNodeAccess.findMany({
      where: {
        subscriptionId: access.subscription.id,
        nodeId: { in: requestedNodeIds }
      },
      include: { node: true }
    });

    const rowMap = new Map(rows.map((row) => [row.nodeId, row.node]));
    return Promise.all(
      requestedNodeIds.map(async (nodeId) => {
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
      })
    );
  }

  async getPolicies(): Promise<PolicyBundleDto> {
    return this.announcementPolicyService.getPolicies();
  }

  async getClientVersion(): Promise<ClientVersionDto> {
    const latestRelease = await this.findLatestPublishedRelease("stable");
    if (!latestRelease) {
      const profile = await this.prisma.policyProfile.findUnique({
        where: { id: "default" }
      });

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

    const primaryArtifact = pickPrimaryReleaseArtifact(latestRelease.artifacts);
    return {
      currentVersion: latestRelease.version,
      minimumVersion: latestRelease.minimumVersion,
      forceUpgrade: latestRelease.forceUpgrade,
      changelog: latestRelease.changelog,
      downloadUrl: primaryArtifact?.downloadUrl ?? null
    };
  }

  async pingClient(token?: string): Promise<ClientPingDto> {
    await this.authSessionService.authenticateAccessToken(token);
    return {
      ok: true,
      serverTime: new Date().toISOString()
    };
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
    return this.prisma.subscription.findFirst({
      where: { userId },
      include: { plan: true, user: true, team: true },
      orderBy: [{ expireAt: "desc" }, { createdAt: "desc" }]
    });
  }

  private async getMemberUsedTrafficGb(teamId: string, userId: string, subscriptionId: string) {
    const rows = await this.prisma.trafficLedger.findMany({
      where: { teamId, userId, subscriptionId }
    });
    return rows.reduce((sum, item) => sum + item.usedTrafficGb, 0);
  }

  private async resolveUserForLogin(account: string) {
    if (account === BUILTIN_ADMIN_ACCOUNT) {
      const adminByAccount = await this.prisma.user.findUnique({
        where: { email: BUILTIN_ADMIN_ACCOUNT }
      });
      if (adminByAccount) {
        return adminByAccount;
      }
      return this.prisma.user.findFirst({
        where: { role: "admin" },
        orderBy: { createdAt: "asc" }
      });
    }

    return this.prisma.user.findUnique({
      where: { email: account }
    });
  }

  private async findLatestPublishedRelease(channel: "stable") {
    const rows = await this.prisma.release.findMany({
      where: {
        channel,
        status: "published"
      },
      include: {
        artifacts: {
          orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }]
        }
      }
    });

    if (rows.length === 0) {
      return null;
    }

    return rows.sort((left, right) => {
      const versionDiff = compareSemver(right.version, left.version);
      if (versionDiff !== 0) {
        return versionDiff;
      }
      return (right.publishedAt?.getTime() ?? 0) - (left.publishedAt?.getTime() ?? 0);
    })[0];
  }
}

function compareSemver(left: string, right: string) {
  const leftParts = parseSemver(left);
  const rightParts = parseSemver(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts.core[index] !== rightParts.core[index]) {
      return leftParts.core[index] - rightParts.core[index];
    }
  }
  if (leftParts.prerelease === rightParts.prerelease) {
    return 0;
  }
  if (!leftParts.prerelease) {
    return 1;
  }
  if (!rightParts.prerelease) {
    return -1;
  }
  return leftParts.prerelease.localeCompare(rightParts.prerelease, undefined, { numeric: true });
}

function parseSemver(value: string) {
  const [corePart, prerelease = ""] = value.trim().split("-", 2);
  const core = corePart.split(".").map((item) => Number.parseInt(item, 10) || 0);
  while (core.length < 3) {
    core.push(0);
  }
  return { core, prerelease };
}

function pickPrimaryReleaseArtifact(
  artifacts: Array<{
    id: string;
    releaseId: string;
    source: string;
    type: string;
    deliveryMode: string;
    downloadUrl: string;
    defaultMirrorPrefix: string | null;
    allowClientMirror: boolean;
    fileName: string | null;
    fileSizeBytes: bigint | null;
    fileHash: string | null;
    isPrimary: boolean;
    isFullPackage: boolean;
    createdAt: Date;
    updatedAt: Date;
  }>
) {
  return artifacts.find((item) => item.isPrimary) ?? artifacts[0] ?? null;
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
