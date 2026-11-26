import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import type { SubscriptionLinkDistributionDto, SubscriptionLinkPublicationStatusDto } from "@chordv/shared";
import { DrainableJob } from "../../work-lifecycle";
import { PrismaService } from "./prisma.service";
import { hashSubscriptionLinkDocument, serializeSubscriptionLinkDocument } from "./subscription-link";
import {
  SUBSCRIPTION_LINK_STORE,
  SubscriptionLinkStoreError,
  type SubscriptionLinkStore
} from "./subscription-link-store";
import { SubscriptionLinkService } from "./subscription-link.service";

/** A published document is rewritten this long after its last write even if nothing changed. */
export const SUBSCRIPTION_LINK_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
/** Upper bound on writes in one pass; the rest wait for the next one. */
export const SUBSCRIPTION_LINK_MAX_WRITES_PER_PASS = 50;
/** A pass gives up after this many store failures instead of hammering a store that is down. */
export const SUBSCRIPTION_LINK_MAX_FAILURES_PER_PASS = 3;
/** How long to stay away after the store says the write limit is reached. */
export const SUBSCRIPTION_LINK_RATE_LIMIT_PAUSE_MS = 10 * 60 * 1000;

export type SubscriptionLinkReconcileResult = {
  outcome: "disabled" | "busy" | "paused" | "ran";
  written: number;
  deleted: number;
  failed: number;
  /** Links whose document could not be published this pass, for any reason. */
  pending: number;
};

function idle(outcome: SubscriptionLinkReconcileResult["outcome"]): SubscriptionLinkReconcileResult {
  return { outcome, written: 0, deleted: 0, failed: 0, pending: 0 };
}

/**
 * Keeps the distribution layer equal to what the links should return.
 *
 * There is no queue of "things that changed". A pass renders every link from
 * the database, compares it with what was last written, and writes or deletes
 * the difference — so nothing has to remember to announce a change, whichever
 * of the many paths made it (a renewal, a node's address, a team member
 * leaving, the clock passing an expiry). A write that fails is simply still a
 * difference on the next pass. The same pass run twice, or by two processes at
 * once, converges on the same store contents: writes and deletes are
 * idempotent, and the publication row is only recorded after the store
 * accepted the write.
 */
@Injectable()
export class SubscriptionLinkPublicationService {
  private readonly logger = new Logger(SubscriptionLinkPublicationService.name);
  private running = false;
  private pausedUntil = 0;
  private lastRunAt: Date | null = null;
  private lastSuccessAt: Date | null = null;
  private lastError: string | null = null;
  private lastPending = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly links: SubscriptionLinkService,
    @Optional() @Inject(SUBSCRIPTION_LINK_STORE) private readonly store: SubscriptionLinkStore | null = null
  ) {}

  get configured(): boolean {
    return Boolean(this.store);
  }

  @Cron("*/30 * * * * *")
  @DrainableJob()
  async reconcileOnSchedule() {
    try {
      await this.reconcile();
    } catch (error) {
      // A database blip must not surface as an unhandled rejection in the
      // scheduler; the next tick starts from scratch anyway.
      this.logger.warn(`订阅链接分发对账失败（稍后重试）：${error instanceof Error ? error.name : "unknown"}`);
    }
  }

  /** Runs a pass now, without waiting for it: issuing or resetting a link should take effect right away. */
  kick(): void {
    if (!this.store) return;
    void this.reconcile().catch(() => undefined);
  }

  getStatus(): SubscriptionLinkPublicationStatusDto {
    return {
      configured: this.configured,
      lastRunAt: this.lastRunAt?.toISOString() ?? null,
      lastSuccessAt: this.lastSuccessAt?.toISOString() ?? null,
      lastError: this.lastError,
      pending: this.lastPending
    };
  }

  /** Whether this user's current link is being served yet. */
  async describeForUser(userId: string): Promise<SubscriptionLinkDistributionDto> {
    if (!this.store) return { state: "not_configured", publishedAt: null };
    const link = await this.prisma.subscriptionLink.findUnique({ where: { userId }, select: { tokenHash: true } });
    if (!link) return { state: "pending", publishedAt: null };
    const publication = await this.prisma.subscriptionLinkPublication.findUnique({ where: { tokenHash: link.tokenHash } });
    return publication
      ? { state: "live", publishedAt: publication.publishedAt.toISOString() }
      : { state: "pending", publishedAt: null };
  }

  async reconcile(now: Date = new Date()): Promise<SubscriptionLinkReconcileResult> {
    const store = this.store;
    if (!store) return idle("disabled");
    if (this.running) return idle("busy");
    if (now.getTime() < this.pausedUntil) return idle("paused");
    this.running = true;
    try {
      return await this.runPass(store, now);
    } finally {
      this.running = false;
    }
  }

  private async runPass(store: SubscriptionLinkStore, now: Date): Promise<SubscriptionLinkReconcileResult> {
    const result: SubscriptionLinkReconcileResult = { outcome: "ran", written: 0, deleted: 0, failed: 0, pending: 0 };
    const [links, publications] = await Promise.all([
      this.prisma.subscriptionLink.findMany({ select: { userId: true, tokenHash: true }, orderBy: { userId: "asc" } }),
      this.prisma.subscriptionLinkPublication.findMany()
    ]);
    const liveHashes = new Set(links.map((link) => link.tokenHash));
    const publishedByHash = new Map(publications.map((publication) => [publication.tokenHash, publication]));
    let abandoned = false;

    const noteFailure = (action: string, tokenHash: string, error: unknown) => {
      result.failed += 1;
      const status = error instanceof SubscriptionLinkStoreError ? error.status : null;
      this.lastError = error instanceof SubscriptionLinkStoreError ? error.message : `${action}时出错`;
      // The hash prefix identifies the link to an operator without being the link.
      this.logger.warn(`订阅链接${action}失败 ${tokenHash.slice(0, 8)}：${this.lastError}`);
      if (status === 429) {
        this.pausedUntil = now.getTime() + SUBSCRIPTION_LINK_RATE_LIMIT_PAUSE_MS;
        abandoned = true;
      } else if (result.failed >= SUBSCRIPTION_LINK_MAX_FAILURES_PER_PASS) {
        abandoned = true;
      }
    };

    // Deletions first: a key that is still there after a reset or an account
    // removal is a link that still works for whoever holds it.
    for (const publication of publications) {
      if (abandoned) break;
      if (liveHashes.has(publication.tokenHash)) continue;
      try {
        await store.delete(publication.tokenHash);
        await this.prisma.subscriptionLinkPublication.deleteMany({ where: { tokenHash: publication.tokenHash } });
        result.deleted += 1;
      } catch (error) {
        noteFailure("撤销", publication.tokenHash, error);
      }
    }

    for (const link of links) {
      if (abandoned || result.written >= SUBSCRIPTION_LINK_MAX_WRITES_PER_PASS) {
        // Not examined this pass. Counting it as pending overstates rather
        // than understates what is left, which is the safe direction for a
        // figure someone watches to decide whether distribution is stuck.
        result.pending += 1;
        continue;
      }
      let value: string;
      let contentHash: string;
      try {
        const document = await this.links.render(link.userId);
        value = serializeSubscriptionLinkDocument(document);
        contentHash = hashSubscriptionLinkDocument(document);
      } catch (error) {
        // One user's unreadable data must not hold everyone else's link back.
        result.pending += 1;
        this.lastError = "生成订阅内容时出错";
        this.logger.warn(`订阅内容生成失败 ${link.tokenHash.slice(0, 8)}：${error instanceof Error ? error.name : "unknown"}`);
        continue;
      }
      const published = publishedByHash.get(link.tokenHash);
      const fresh = published && now.getTime() - published.publishedAt.getTime() < SUBSCRIPTION_LINK_REFRESH_AFTER_MS;
      if (published && published.contentHash === contentHash && fresh) continue;
      try {
        await store.put(link.tokenHash, value);
        await this.prisma.subscriptionLinkPublication.upsert({
          where: { tokenHash: link.tokenHash },
          create: { tokenHash: link.tokenHash, contentHash, publishedAt: now },
          update: { contentHash, publishedAt: now }
        });
        result.written += 1;
      } catch (error) {
        result.pending += 1;
        noteFailure("发布", link.tokenHash, error);
      }
    }

    this.lastRunAt = now;
    this.lastPending = result.pending;
    if (result.failed === 0 && result.pending === 0) {
      this.lastSuccessAt = now;
      this.lastError = null;
    }
    if (result.written > 0 || result.deleted > 0) {
      this.logger.log(`订阅链接分发：写入 ${result.written} 条，撤销 ${result.deleted} 条，待处理 ${result.pending} 条`);
    }
    return result;
  }
}
