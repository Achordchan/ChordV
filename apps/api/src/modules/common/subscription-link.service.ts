import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  AdminSubscriptionLinkDto,
  AdminSubscriptionLinkStateDto,
  SubscriptionLinkSettingsDto,
  UpdateSubscriptionLinkSettingsDto
} from "@chordv/shared";
import { isNodeOnboardingReady } from "./node-onboarding-policy";
import { isPrismaCodedError } from "./prisma-error.utils";
import { PrismaService } from "./prisma.service";
import { normalizeSiteOrigin } from "./site-address.service";
import {
  buildNodesDocument,
  buildNoticeDocument,
  buildSubscriptionLinkUrl,
  generateSubscriptionLinkToken,
  hashSubscriptionLinkToken,
  SUBSCRIPTION_LINK_NOTICES,
  type SubscriptionLinkDocument,
  type SubscriptionLinkNode,
  type SubscriptionLinkUsage
} from "./subscription-link";
import { pickCurrentSubscription, readEffectiveSubscriptionState } from "./subscription.utils";
import { trafficGbNumberToBytes } from "./traffic-bytes.utils";

export const SUBSCRIPTION_LINK_SETTINGS_KEY = "subscription-link";

type LinkRow = { userId: string; token: string; createdAt: Date; rotatedAt: Date | null };

function normalizeOptionalOrigin(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? normalizeSiteOrigin(trimmed) : null;
}

function readConfiguredOrigin(raw: string | undefined): string | null {
  // An unusable value in the environment must not take the admin pages down
  // with it: the feature reads as "not configured" instead.
  try {
    return normalizeOptionalOrigin(raw);
  } catch {
    return null;
  }
}

@Injectable()
export class SubscriptionLinkService {
  constructor(private readonly prisma: PrismaService) {}

  async getSettings(): Promise<SubscriptionLinkSettingsDto> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: SUBSCRIPTION_LINK_SETTINGS_KEY } });
    if (row) {
      const value = row.value as unknown as Partial<UpdateSubscriptionLinkSettingsDto> | null;
      return {
        origin: typeof value?.origin === "string" ? value.origin : null,
        backupOrigin: typeof value?.backupOrigin === "string" ? value.backupOrigin : null,
        updatedAt: row.updatedAt.toISOString()
      };
    }
    return {
      origin: readConfiguredOrigin(process.env.CHORDV_SUBSCRIPTION_LINK_ORIGIN),
      backupOrigin: null,
      updatedAt: null
    };
  }

  async saveSettings(input: UpdateSubscriptionLinkSettingsDto): Promise<SubscriptionLinkSettingsDto> {
    const origin = normalizeOptionalOrigin(input.origin);
    const backupOrigin = normalizeOptionalOrigin(input.backupOrigin);
    if (backupOrigin && !origin) throw new BadRequestException("请先填写订阅域名，再填写备用域名");
    if (backupOrigin && backupOrigin === origin) throw new BadRequestException("备用域名不能和订阅域名相同");
    const value = { origin, backupOrigin };
    const row = await this.prisma.systemSetting.upsert({
      where: { key: SUBSCRIPTION_LINK_SETTINGS_KEY },
      create: { key: SUBSCRIPTION_LINK_SETTINGS_KEY, value },
      update: { value }
    });
    return { ...value, updatedAt: row.updatedAt.toISOString() };
  }

  async getForUser(userId: string): Promise<AdminSubscriptionLinkStateDto> {
    await this.assertUserExists(userId);
    const row = await this.prisma.subscriptionLink.findUnique({ where: { userId } });
    return { link: row ? await this.describe(row) : null };
  }

  /** Returns the user's link, issuing one if they have none. Never changes an existing token. */
  async ensureForUser(userId: string): Promise<AdminSubscriptionLinkStateDto> {
    await this.assertUserExists(userId);
    const existing = await this.prisma.subscriptionLink.findUnique({ where: { userId } });
    if (existing) return { link: await this.describe(existing) };
    const token = generateSubscriptionLinkToken();
    try {
      const created = await this.prisma.subscriptionLink.create({
        data: { userId, token, tokenHash: hashSubscriptionLinkToken(token) }
      });
      return { link: await this.describe(created) };
    } catch (error) {
      // Two requests issuing at once: the loser hands out the winner's link
      // rather than failing, so both callers end up with the same one.
      if (!isPrismaCodedError(error) || error.code !== "P2002") throw error;
      const winner = await this.prisma.subscriptionLink.findUnique({ where: { userId } });
      if (!winner) throw error;
      return { link: await this.describe(winner) };
    }
  }

  /** Replaces the token. The old link stops working; the user's nodes and credentials are untouched. */
  async resetForUser(userId: string): Promise<AdminSubscriptionLinkStateDto> {
    await this.assertUserExists(userId);
    const token = generateSubscriptionLinkToken();
    const tokenHash = hashSubscriptionLinkToken(token);
    const row = await this.prisma.subscriptionLink.upsert({
      where: { userId },
      create: { userId, token, tokenHash },
      update: { token, tokenHash, rotatedAt: new Date() }
    });
    return { link: await this.describe(row) };
  }

  /**
   * What this user's link returns right now.
   *
   * It follows the same entitlement the desktop client connects under — the
   * team's subscription for a team member, otherwise the user's own — and lists
   * only nodes the user holds a live credential on. Anything short of that is a
   * notice saying why, never an empty list and never a stale node.
   */
  async render(userId: string): Promise<SubscriptionLinkDocument> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, status: true } });
    if (!user || user.status !== "active") return buildNoticeDocument(SUBSCRIPTION_LINK_NOTICES.account_disabled);

    const membership = await this.prisma.teamMember.findUnique({
      where: { userId },
      include: { team: { include: { subscriptions: { orderBy: [{ expireAt: "desc" }, { createdAt: "desc" }] } } } }
    });
    const subscription = membership
      ? pickCurrentSubscription(membership.team.subscriptions)
      : pickCurrentSubscription(
          await this.prisma.subscription.findMany({
            where: { userId },
            orderBy: [{ expireAt: "desc" }, { createdAt: "desc" }]
          })
        );
    if (!subscription) return buildNoticeDocument(SUBSCRIPTION_LINK_NOTICES.no_subscription);

    const usage: SubscriptionLinkUsage =
      subscription.totalTrafficBytes > 0n
        ? {
            usedBytes: subscription.usedTrafficBytes,
            totalBytes: subscription.totalTrafficBytes,
            expireAt: subscription.expireAt
          }
        : {
            usedBytes: trafficGbNumberToBytes(subscription.usedTrafficGb),
            totalBytes: trafficGbNumberToBytes(subscription.totalTrafficGb),
            expireAt: subscription.expireAt
          };

    if (membership && membership.team.status !== "active") {
      return buildNoticeDocument(SUBSCRIPTION_LINK_NOTICES.team_disabled, usage);
    }
    const state = readEffectiveSubscriptionState(subscription);
    if (state === "expired") return buildNoticeDocument(SUBSCRIPTION_LINK_NOTICES.subscription_expired, usage);
    if (state === "exhausted") return buildNoticeDocument(SUBSCRIPTION_LINK_NOTICES.subscription_exhausted, usage);
    if (state === "paused") return buildNoticeDocument(SUBSCRIPTION_LINK_NOTICES.subscription_paused, usage);

    const [bindings, accesses] = await Promise.all([
      this.prisma.panelClientBinding.findMany({
        where: { subscriptionId: subscription.id, userId, status: "active", source: "direct" },
        include: { node: true }
      }),
      this.prisma.subscriptionNodeAccess.findMany({
        where: { subscriptionId: subscription.id },
        select: { nodeId: true }
      })
    ]);
    const assignedNodeIds = new Set(accesses.map((access) => access.nodeId));
    const nodes: SubscriptionLinkNode[] = [];
    for (const binding of bindings) {
      const node = binding.node;
      // A credential can outlive the assignment or the node for a moment while
      // its removal is still being carried out; the link must not advertise it.
      if (!assignedNodeIds.has(node.id) || !node.isActive || !isNodeOnboardingReady(node)) continue;
      if (node.protocol !== "vless" || node.security !== "reality") continue;
      if (!node.realityPublicKey.trim() || !node.serverName.trim() || !node.fingerprint.trim()) continue;
      nodes.push({
        nodeId: node.id,
        name: node.name,
        serverHost: node.serverHost,
        serverPort: node.serverPort,
        uuid: binding.panelClientId,
        flow: node.flow,
        realityPublicKey: node.realityPublicKey,
        shortId: node.shortId,
        serverName: node.serverName,
        fingerprint: node.fingerprint,
        spiderX: node.spiderX,
        mldsa65Verify: node.mldsa65Verify
      });
    }
    return buildNodesDocument(nodes, usage);
  }

  private async describe(row: LinkRow): Promise<AdminSubscriptionLinkDto> {
    const [settings, document] = await Promise.all([this.getSettings(), this.render(row.userId)]);
    return {
      userId: row.userId,
      url: settings.origin ? buildSubscriptionLinkUrl(settings.origin, row.token) : null,
      backupUrl: settings.backupOrigin ? buildSubscriptionLinkUrl(settings.backupOrigin, row.token) : null,
      createdAt: row.createdAt.toISOString(),
      rotatedAt: row.rotatedAt ? row.rotatedAt.toISOString() : null,
      preview: { kind: document.kind, notice: document.notice, nodes: document.nodes }
    };
  }

  private async assertUserExists(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new NotFoundException("用户不存在");
  }
}
