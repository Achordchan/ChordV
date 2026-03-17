import { Injectable, NotFoundException, OnModuleInit, UnauthorizedException } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { Agent, fetch as undiciFetch } from "undici";
import {
  mockAdmin,
  mockAnnouncements,
  mockNodes,
  mockPanels,
  mockPolicies,
  mockSubscription,
  mockUser
} from "@chordv/shared";
import type {
  AdminSnapshotDto,
  AnnouncementDto,
  AuthSessionDto,
  ClientBootstrapDto,
  ConnectRequestDto,
  GeneratedRuntimeConfigDto,
  NodeSummaryDto,
  PanelSyncRunDto,
  PanelSyncStatusDto,
  PolicyBundleDto,
  SubscriptionStatusDto,
  UserProfileDto
} from "@chordv/shared";
import { PrismaService } from "./prisma.service";

@Injectable()
export class DevDataService implements OnModuleInit {
  private activeRuntime?: GeneratedRuntimeConfigDto;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.seedIfEmpty();
  }

  async login(email: string, password: string): Promise<AuthSessionDto> {
    const user = await this.prisma.user.findUnique({
      where: { email }
    });

    if (!user) {
      throw new UnauthorizedException("Invalid email or password");
    }

    const passwordMatched = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatched) {
      throw new UnauthorizedException("Invalid email or password");
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        lastSeenAt: new Date()
      }
    });

    return {
      accessToken: `access_${tokenize(email)}`,
      refreshToken: `refresh_${tokenize(email)}`,
      user: toUserProfile(updatedUser)
    };
  }

  async refresh(token: string): Promise<AuthSessionDto> {
    if (!token.startsWith("refresh_")) {
      throw new UnauthorizedException("Invalid refresh token");
    }

    const email = detokenize(token.replace("refresh_", ""));
    const user = await this.prisma.user.findUnique({
      where: { email }
    });

    if (!user) {
      throw new UnauthorizedException("User not found");
    }

    return {
      accessToken: `access_${tokenize(email)}`,
      refreshToken: token,
      user: toUserProfile(user)
    };
  }

  logout(): { ok: true } {
    return { ok: true };
  }

  async getBootstrap(token?: string): Promise<ClientBootstrapDto> {
    const user = await this.resolveUserFromToken(token);
    const subscription = await this.getSubscriptionForUser(user.id);
    const policies = await this.getPolicies();
    const announcements = await this.getAnnouncements();
    const profile = await this.prisma.policyProfile.findUnique({
      where: { id: "default" }
    });

    if (!profile) {
      throw new NotFoundException("Policy profile not found");
    }

    return {
      user,
      subscription,
      policies,
      announcements,
      version: {
        currentVersion: profile.currentVersion,
        minimumVersion: profile.minimumVersion,
        forceUpgrade: profile.forceUpgrade,
        changelog: profile.changelog
      }
    };
  }

  async getSubscription(token?: string): Promise<SubscriptionStatusDto> {
    const user = await this.resolveUserFromToken(token);
    return this.getSubscriptionForUser(user.id);
  }

  async getNodes(): Promise<NodeSummaryDto[]> {
    const rows = await this.prisma.node.findMany({
      orderBy: [{ recommended: "desc" }, { latencyMs: "asc" }]
    });

    return rows.map(toNodeSummary);
  }

  async getPolicies(): Promise<PolicyBundleDto> {
    const profile = await this.prisma.policyProfile.findUnique({
      where: { id: "default" },
      include: {
        strategyGroups: true
      }
    });

    if (!profile) {
      throw new NotFoundException("Policy profile not found");
    }

    return {
      defaultMode: profile.defaultMode as PolicyBundleDto["defaultMode"],
      modes: profile.modes as PolicyBundleDto["modes"],
      strategyGroups: profile.strategyGroups.map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        defaultNodeId: item.defaultNodeId
      })),
      ruleVersion: profile.ruleVersion,
      ruleUpdatedAt: profile.ruleUpdatedAt.toISOString(),
      dnsProfile: profile.dnsProfile,
      features: {
        blockAds: profile.blockAds,
        chinaDirect: profile.chinaDirect,
        aiServicesProxy: profile.aiServicesProxy
      }
    };
  }

  async getAnnouncements(): Promise<AnnouncementDto[]> {
    const rows = await this.prisma.announcement.findMany({
      where: { isActive: true },
      orderBy: { publishedAt: "desc" }
    });

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      level: row.level,
      publishedAt: row.publishedAt.toISOString()
    }));
  }

  async getPanels(): Promise<PanelSyncStatusDto[]> {
    const rows = await this.prisma.panel.findMany({
      orderBy: { name: "asc" }
    });

    return rows.map((row) => ({
      panelId: row.id,
      name: row.name,
      health: row.health,
      baseUrl: row.baseUrl,
      apiBasePath: row.apiBasePath,
      lastSyncedAt: row.lastSyncedAt.toISOString(),
      latencyMs: row.latencyMs,
      activeUsers: row.activeUsers
    }));
  }

  async synchronizePanels(): Promise<PanelSyncRunDto[]> {
    const panels = await this.prisma.panel.findMany({
      where: { syncEnabled: true },
      orderBy: { name: "asc" }
    });

    const results: PanelSyncRunDto[] = [];

    for (const panel of panels) {
      const startedAt = Date.now();
      const credentials = this.resolvePanelCredentials(panel);
      if (!credentials) {
        const result: PanelSyncRunDto = {
          panelId: panel.id,
          health: "degraded",
          synchronizedUsers: 0,
          matchedSubscriptions: 0,
          latencyMs: Date.now() - startedAt,
          lastSyncedAt: new Date().toISOString(),
          error: "Missing panel credentials"
        };
        await this.persistPanelStatus(result, panel, 0);
        results.push(result);
        continue;
      }

      try {
        const cookie = await this.loginPanel(
          credentials.baseUrl,
          credentials.username,
          credentials.password,
          credentials.apiBasePath,
          credentials.timeoutMs,
          credentials.allowInsecureTls
        );
        const payload = await this.fetchPanelInbounds(
          credentials.baseUrl,
          cookie,
          credentials.apiBasePath,
          credentials.timeoutMs,
          credentials.allowInsecureTls
        );
        const result = await this.applyPanelPayload(panel.id, payload, Date.now() - startedAt);
        await this.persistPanelStatus(result, panel, result.synchronizedUsers);
        results.push(result);
      } catch (error) {
        const result: PanelSyncRunDto = {
          panelId: panel.id,
          health: "offline",
          synchronizedUsers: 0,
          matchedSubscriptions: 0,
          latencyMs: Date.now() - startedAt,
          lastSyncedAt: new Date().toISOString(),
          error: formatPanelError(error)
        };
        await this.persistPanelStatus(result, panel, 0);
        results.push(result);
      }
    }

    return results;
  }

  async getAdminSnapshot(): Promise<AdminSnapshotDto> {
    const [users, subscriptions, nodes, panels, announcements] = await Promise.all([
      this.getUsers(),
      this.getSubscriptions(),
      this.getNodes(),
      this.getPanels(),
      this.getAnnouncements()
    ]);

    return {
      dashboard: {
        users: users.length,
        activeSubscriptions: subscriptions.filter((item) => item.state === "active").length,
        activeNodes: nodes.length,
        announcements: announcements.length,
        panelHealth: panels.every((panel) => panel.health === "healthy")
          ? "healthy"
          : panels.some((panel) => panel.health === "offline")
            ? "offline"
            : "degraded"
      },
      users,
      subscriptions,
      nodes,
      panels,
      announcements
    };
  }

  async connect(request: ConnectRequestDto): Promise<GeneratedRuntimeConfigDto> {
    const node = await this.prisma.node.findUnique({
      where: { id: request.nodeId }
    });

    if (!node) {
      throw new NotFoundException("Node not found");
    }

    this.activeRuntime = {
      sessionId: `session_${node.id}`,
      node: toNodeSummary(node),
      mode: request.mode,
      localHttpPort: 17890,
      localSocksPort: 17891,
      routingProfile: request.strategyGroupId ?? "managed-rule-default",
      generatedAt: new Date().toISOString(),
      outbound: {
        protocol: "vless",
        server: node.serverHost,
        port: node.serverPort,
        uuid: node.uuid,
        flow: node.flow,
        realityPublicKey: node.realityPublicKey,
        shortId: node.shortId,
        serverName: node.serverName,
        fingerprint: node.fingerprint
      }
    };

    return this.activeRuntime;
  }

  disconnect() {
    const previous = this.activeRuntime;
    this.activeRuntime = undefined;
    return {
      ok: true,
      previousSessionId: previous?.sessionId ?? null
    };
  }

  getActiveRuntime() {
    return this.activeRuntime ?? null;
  }

  async getUsers(): Promise<UserProfileDto[]> {
    const rows = await this.prisma.user.findMany({
      orderBy: { createdAt: "asc" }
    });

    return rows.map(toUserProfile);
  }

  private async getSubscriptions(): Promise<SubscriptionStatusDto[]> {
    const rows = await this.prisma.subscription.findMany({
      include: {
        plan: true
      },
      orderBy: { createdAt: "asc" }
    });

    return rows.map((row) => toSubscriptionDto(row, row.plan.name));
  }

  private async getSubscriptionForUser(userId: string): Promise<SubscriptionStatusDto> {
    const row = await this.prisma.subscription.findFirst({
      where: { userId },
      include: {
        plan: true
      },
      orderBy: { createdAt: "asc" }
    });

    if (!row) {
      throw new NotFoundException("Subscription not found");
    }

    return toSubscriptionDto(row, row.plan.name);
  }

  private async resolveUserFromToken(token?: string): Promise<UserProfileDto> {
    const email = token ? tryEmailFromToken(token) : mockUser.email;
    const user = await this.prisma.user.findUnique({
      where: { email: email ?? mockUser.email }
    });

    if (!user) {
      throw new UnauthorizedException("User not found");
    }

    return toUserProfile(user);
  }

  private async seedIfEmpty() {
    const userCount = await this.prisma.user.count();
    if (userCount > 0) {
      return;
    }

    const demoPasswordHash = await bcrypt.hash("demo123456", 10);
    const adminPasswordHash = await bcrypt.hash("admin123456", 10);
    const defaultPanelBaseUrl = process.env.CHORDV_PANEL_DEFAULT_URL;

    await this.prisma.user.createMany({
      data: [
        {
          id: mockUser.id,
          email: mockUser.email,
          displayName: mockUser.displayName,
          role: mockUser.role,
          status: mockUser.status,
          passwordHash: demoPasswordHash,
          lastSeenAt: new Date(mockUser.lastSeenAt)
        },
        {
          id: mockAdmin.id,
          email: mockAdmin.email,
          displayName: mockAdmin.displayName,
          role: mockAdmin.role,
          status: mockAdmin.status,
          passwordHash: adminPasswordHash,
          lastSeenAt: new Date(mockAdmin.lastSeenAt)
        }
      ]
    });

    await this.prisma.plan.create({
      data: {
        id: mockSubscription.planId,
        name: mockSubscription.planName,
        totalTrafficGb: mockSubscription.totalTrafficGb,
        durationDays: 30,
        renewable: mockSubscription.renewable,
        isActive: true
      }
    });

    await this.prisma.subscription.create({
      data: {
        id: "subscription_demo_001",
        userId: mockUser.id,
        planId: mockSubscription.planId,
        panelClientEmail: process.env.CHORDV_DEMO_PANEL_CLIENT_EMAIL || mockUser.email,
        totalTrafficGb: mockSubscription.totalTrafficGb,
        usedTrafficGb: mockSubscription.usedTrafficGb,
        remainingTrafficGb: mockSubscription.remainingTrafficGb,
        expireAt: new Date(mockSubscription.expireAt),
        state: mockSubscription.state,
        renewable: mockSubscription.renewable,
        lastSyncedAt: new Date(mockSubscription.lastSyncedAt)
      }
    });

    await this.prisma.node.createMany({
      data: mockNodes.map((node) => ({
        id: node.id,
        name: node.name,
        region: node.region,
        provider: node.provider,
        tags: node.tags,
        recommended: node.recommended,
        latencyMs: node.latencyMs,
        protocol: node.protocol,
        security: node.security,
        serverHost: `${node.region.toLowerCase().replaceAll(" ", "-")}.edge.chordv.app`,
        serverPort: 443,
        uuid: "d5076fbe-b935-4dc6-8f59-a056d05db6f3",
        flow: "xtls-rprx-vision",
        realityPublicKey: "5C3G02RWVBX3e2tHAh9d69Vk4g8JwG2Zx2N0TTTPD2M",
        shortId: "6ba85179",
        serverName: "cdn.cloudflare.com",
        fingerprint: "chrome"
      }))
    });

    await this.prisma.policyProfile.create({
      data: {
        id: "default",
        defaultMode: mockPolicies.defaultMode,
        modes: mockPolicies.modes,
        ruleVersion: mockPolicies.ruleVersion,
        ruleUpdatedAt: new Date(mockPolicies.ruleUpdatedAt),
        dnsProfile: mockPolicies.dnsProfile,
        blockAds: mockPolicies.features.blockAds,
        chinaDirect: mockPolicies.features.chinaDirect,
        aiServicesProxy: mockPolicies.features.aiServicesProxy,
        currentVersion: "0.1.0",
        minimumVersion: "0.1.0",
        forceUpgrade: false,
        changelog: [
          "Prisma-backed PostgreSQL data layer",
          "Docker Compose local database bootstrap",
          "Managed runtime config contracts still intact"
        ]
      }
    });

    await this.prisma.strategyGroup.createMany({
      data: mockPolicies.strategyGroups.map((item) => ({
        id: item.id,
        policyId: "default",
        name: item.name,
        description: item.description,
        defaultNodeId: item.defaultNodeId
      }))
    });

    await this.prisma.panel.createMany({
      data: mockPanels.map((panel) => ({
        id: panel.panelId,
        name: panel.name,
        baseUrl: panel.panelId === "panel_hk_1" && defaultPanelBaseUrl ? defaultPanelBaseUrl : panel.baseUrl,
        apiBasePath: panel.apiBasePath ?? "/panel",
        health: panel.health,
        lastSyncedAt: new Date(panel.lastSyncedAt),
        latencyMs: panel.latencyMs,
        activeUsers: panel.activeUsers,
        syncEnabled: panel.panelId === "panel_hk_1"
      }))
    });

    await this.prisma.announcement.createMany({
      data: mockAnnouncements.map((item) => ({
        id: item.id,
        title: item.title,
        body: item.body,
        level: item.level,
        publishedAt: new Date(item.publishedAt),
        isActive: true
      }))
    });
  }

  private resolvePanelCredentials(panel: {
    id: string;
    baseUrl: string;
    apiBasePath: string;
    username: string | null;
    password: string | null;
  }) {
    const baseUrl = process.env.CHORDV_PANEL_DEFAULT_URL ?? panel.baseUrl;
    const username = panel.username ?? process.env.CHORDV_PANEL_DEFAULT_USERNAME ?? "";
    const password = panel.password ?? process.env.CHORDV_PANEL_DEFAULT_PASSWORD ?? "";
    const apiBasePath = panel.apiBasePath || process.env.CHORDV_PANEL_DEFAULT_API_BASE_PATH || "/panel";
    const timeoutMs = Number(process.env.CHORDV_PANEL_DEFAULT_TIMEOUT_MS ?? 10000);
    const allowInsecureTls = (process.env.CHORDV_PANEL_ALLOW_INSECURE_TLS ?? "false").toLowerCase() === "true";

    if (!username || !password) {
      return null;
    }

    return {
      baseUrl,
      username,
      password,
      apiBasePath,
      timeoutMs,
      allowInsecureTls
    };
  }

  private async loginPanel(
    baseUrl: string,
    username: string,
    password: string,
    apiBasePath: string,
    timeoutMs: number,
    allowInsecureTls: boolean
  ) {
    const response = await undiciFetch(joinUrl(baseUrl, "/login"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher: createDispatcher(timeoutMs, allowInsecureTls)
    });

    if (!response.ok) {
      throw new Error(`Panel login failed with HTTP ${response.status}`);
    }

    const payload = (await response.json()) as { success?: boolean; msg?: string };
    if (!payload.success) {
      throw new Error(payload.msg ?? "Panel login returned unsuccessful response");
    }

    const setCookie = readSetCookie(response.headers);
    const cookie = extractCookie(setCookie, "3x-ui");
    if (!cookie) {
      throw new Error("Panel login succeeded without 3x-ui cookie");
    }

    return cookie;
  }

  private async fetchPanelInbounds(
    baseUrl: string,
    cookie: string,
    apiBasePath: string,
    timeoutMs: number,
    allowInsecureTls: boolean
  ) {
    const url = joinUrl(baseUrl, `${trimSlashes(apiBasePath)}/api/inbounds/list`);
    const response = await undiciFetch(url, {
      headers: {
        Cookie: cookie
      },
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher: createDispatcher(timeoutMs, allowInsecureTls)
    });

    if (!response.ok) {
      throw new Error(`Panel inbounds request failed with HTTP ${response.status}`);
    }

    const payload = (await response.json()) as {
      success?: boolean;
      msg?: string;
      obj?: Array<{
        id: number;
        remark?: string;
        clientStats?: Array<{
          email?: string;
          up?: number;
          down?: number;
          total?: number;
          expiryTime?: number;
          enable?: boolean;
        }>;
      }>;
    };

    if (!payload.success || !Array.isArray(payload.obj)) {
      throw new Error(payload.msg ?? "Panel inbounds payload invalid");
    }

    return payload.obj;
  }

  private async applyPanelPayload(panelId: string, inbounds: Array<{
    id: number;
    clientStats?: Array<{
      email?: string;
      up?: number;
      down?: number;
      total?: number;
      expiryTime?: number;
      enable?: boolean;
    }>;
  }>, latencyMs: number): Promise<PanelSyncRunDto> {
    const statsByEmail = new Map<string, { usedBytes: number; totalBytes: number; expiryTime?: number }>();

    for (const inbound of inbounds) {
      for (const client of inbound.clientStats ?? []) {
        if (!client.email) {
          continue;
        }

        statsByEmail.set(client.email, {
          usedBytes: (client.up ?? 0) + (client.down ?? 0),
          totalBytes: client.total ?? 0,
          expiryTime: client.expiryTime
        });
      }
    }

    const subscriptions = await this.prisma.subscription.findMany({
      include: {
        user: true
      }
    });

    let matchedSubscriptions = 0;

    for (const subscription of subscriptions) {
      const panelClientEmail = subscription.panelClientEmail ?? subscription.user.email;
      const stat = statsByEmail.get(panelClientEmail);
      if (!stat) {
        continue;
      }

      matchedSubscriptions += 1;
      const usedTrafficGb = toGigabytes(stat.usedBytes);
      const totalTrafficGb = stat.totalBytes > 0 ? toGigabytes(stat.totalBytes) : subscription.totalTrafficGb;
      const remainingTrafficGb = Math.max(0, totalTrafficGb - usedTrafficGb);
      const expireAt = normalizeExpiry(stat.expiryTime, subscription.expireAt);
      const state = deriveSubscriptionState(remainingTrafficGb, expireAt);

      await this.prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          usedTrafficGb,
          totalTrafficGb,
          remainingTrafficGb,
          expireAt,
          state,
          lastSyncedAt: new Date()
        }
      });
    }

    return {
      panelId,
      health: "healthy",
      synchronizedUsers: statsByEmail.size,
      matchedSubscriptions,
      latencyMs,
      lastSyncedAt: new Date().toISOString(),
      error: null
    };
  }

  private async persistPanelStatus(
    result: PanelSyncRunDto,
    panel: { id: string },
    activeUsers: number
  ) {
    await this.prisma.panel.update({
      where: { id: panel.id },
      data: {
        health: result.health,
        latencyMs: result.latencyMs,
        activeUsers,
        lastSyncedAt: new Date(result.lastSyncedAt)
      }
    });
  }
}

function toUserProfile(row: {
  id: string;
  email: string;
  displayName: string;
  role: "user" | "admin";
  status: "active" | "disabled";
  lastSeenAt: Date;
}): UserProfileDto {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
    lastSeenAt: row.lastSeenAt.toISOString()
  };
}

function toNodeSummary(row: {
  id: string;
  name: string;
  region: string;
  provider: string;
  tags: string[];
  recommended: boolean;
  latencyMs: number;
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
    latencyMs: row.latencyMs,
    protocol: row.protocol as "vless",
    security: row.security as "reality"
  };
}

function toSubscriptionDto(
  row: {
    planId: string;
    totalTrafficGb: number;
    usedTrafficGb: number;
    remainingTrafficGb: number;
    expireAt: Date;
    state: "active" | "expired" | "exhausted" | "paused";
    renewable: boolean;
    lastSyncedAt: Date;
  },
  planName: string
): SubscriptionStatusDto {
  return {
    planId: row.planId,
    planName,
    totalTrafficGb: row.totalTrafficGb,
    usedTrafficGb: row.usedTrafficGb,
    remainingTrafficGb: row.remainingTrafficGb,
    expireAt: row.expireAt.toISOString(),
    state: row.state,
    renewable: row.renewable,
    lastSyncedAt: row.lastSyncedAt.toISOString()
  };
}

function tokenize(value: string) {
  return value.trim().toLowerCase().replaceAll("@", "_at_").replaceAll(".", "_dot_");
}

function detokenize(value: string) {
  return value.replace("_at_", "@").replaceAll("_dot_", ".");
}

function tryEmailFromToken(token: string) {
  const raw = token.replace("Bearer ", "").replace("access_", "").trim();
  return raw ? detokenize(raw) : null;
}

function joinUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function trimSlashes(value: string) {
  return `/${value.replace(/^\/+/, "").replace(/\/+$/, "")}`;
}

function readSetCookie(headers: Headers) {
  const setCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  if (setCookie.length > 0) {
    return setCookie.join("; ");
  }

  return headers.get("set-cookie") ?? "";
}

function extractCookie(header: string, cookieName: string) {
  const match = header.match(new RegExp(`${cookieName}=([^;]+)`));
  return match ? `${cookieName}=${match[1]}` : null;
}

function toGigabytes(bytes: number) {
  return Number((bytes / 1024 / 1024 / 1024).toFixed(2));
}

function normalizeExpiry(expiryTime: number | undefined, fallback: Date) {
  if (!expiryTime || expiryTime <= 0) {
    return fallback;
  }

  const value = expiryTime > 1_000_000_000_000 ? expiryTime : expiryTime * 1000;
  return new Date(value);
}

function deriveSubscriptionState(remainingTrafficGb: number, expireAt: Date): "active" | "expired" | "exhausted" | "paused" {
  if (expireAt.getTime() <= Date.now()) {
    return "expired";
  }

  if (remainingTrafficGb <= 0) {
    return "exhausted";
  }

  return "active";
}

function createDispatcher(timeoutMs: number, allowInsecureTls: boolean) {
  return new Agent({
    connectTimeout: timeoutMs,
    connect: {
      rejectUnauthorized: !allowInsecureTls
    }
  });
}

function formatPanelError(error: unknown) {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code || cause?.message) {
      return `${error.message}: ${cause.code ?? cause.message}`;
    }
    return error.message;
  }

  return "Unknown panel sync error";
}
