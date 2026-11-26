import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import type { SubscriptionLinkDistributionDto, SubscriptionLinkPublicationStatusDto } from "@chordv/shared";
import { DrainableJob, workLifecycle } from "../../work-lifecycle";
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

/** Shown as the status when a pass could not be carried out at all. */
export const SUBSCRIPTION_LINK_PASS_FAILED = "对账未能执行（读取数据库出错），发布和撤销都已停下，稍后自动重试";

export type SubscriptionLinkReconcileResult = {
  /**
   * "paused": the store's write limit was reached a short while ago. Such a
   * pass still revokes — a reset link must not outlive the pause — but it
   * publishes nothing.
   */
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
 * difference on the next pass.
 *
 * What a pass must never lose is a key. A published document carries a user's
 * node credentials, and the only way a reset or a deleted account takes it
 * back is a pass finding a record with no link behind it. So the record is
 * written BEFORE the store is contacted and removed only AFTER the store
 * confirmed the delete:
 *
 *   record (content unknown) → put → record (content, time)
 *   delete → remove record
 *
 * Whatever fails in between — the store accepting a write whose answer never
 * arrives, the database going away right after — leaves a record behind, never
 * a key without one. Records name the destination they were written to: a
 * record for another namespace says nothing about this one.
 */
@Injectable()
export class SubscriptionLinkPublicationService {
  private readonly logger = new Logger(SubscriptionLinkPublicationService.name);
  private running = false;
  private driving = false;
  private rerunRequested = false;
  private pausedUntil = 0;
  private lastRunAt: Date | null = null;
  private lastSuccessAt: Date | null = null;
  private lastError: string | null = null;
  private lastPending = 0;
  private lastRevoking = 0;
  private elsewhere = 0;
  private elsewhereReported = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly links: SubscriptionLinkService,
    @Optional() @Inject(SUBSCRIPTION_LINK_STORE) private readonly store: SubscriptionLinkStore | null = null
  ) {}

  get configured(): boolean {
    return Boolean(this.store);
  }

  /**
   * Passes until there is nothing newly asked for. Both the timer and kick()
   * come through here, so both are admitted, refused while draining, and
   * awaited by a drain in exactly the same way: a pass writes to the store and
   * to the database, and neither may be cut off by a shutdown that believes
   * nothing is running.
   */
  @Cron("*/30 * * * * *")
  @DrainableJob()
  async reconcileOnSchedule() {
    if (this.driving) {
      // The pass in flight read its links before whatever prompted this call.
      // Its owner runs once more when it ends, so a reset is not left waiting
      // for the next tick.
      this.rerunRequested = true;
      return;
    }
    this.driving = true;
    try {
      do {
        this.rerunRequested = false;
        await this.reconcile();
      } while (this.rerunRequested && !workLifecycle.isDraining);
    } catch (error) {
      // A database blip must not surface as an unhandled rejection in the
      // scheduler; the next tick starts from scratch anyway.
      this.logger.warn(`订阅链接分发对账失败（稍后重试）：${error instanceof Error ? error.name : "unknown"}`);
    } finally {
      this.driving = false;
    }
  }

  /**
   * Asks for a pass now, without waiting for it: issuing or resetting a link
   * should not wait for the timer. It only asks — the caller's response goes
   * out before the pass has done anything, and must not claim otherwise.
   */
  kick(): void {
    if (!this.store) return;
    void this.reconcileOnSchedule();
  }

  getStatus(): SubscriptionLinkPublicationStatusDto {
    return {
      configured: this.configured,
      lastRunAt: this.lastRunAt?.toISOString() ?? null,
      lastSuccessAt: this.lastSuccessAt?.toISOString() ?? null,
      lastError: this.lastError,
      pending: this.lastPending,
      revoking: this.lastRevoking,
      elsewhere: this.elsewhere
    };
  }

  /**
   * Whether this user's current link is being served yet, and whether any
   * earlier link of theirs is still waiting to be taken down.
   */
  async describeForUser(userId: string): Promise<SubscriptionLinkDistributionDto> {
    const store = this.store;
    if (!store) return { state: "not_configured", publishedAt: null, revoking: 0 };
    const [link, records] = await Promise.all([
      this.prisma.subscriptionLink.findUnique({ where: { userId }, select: { tokenHash: true } }),
      this.prisma.subscriptionLinkPublication.findMany({ where: { destination: store.destination, userId } })
    ]);
    const current = link ? records.find((record) => record.tokenHash === link.tokenHash) : undefined;
    const revoking = records.filter((record) => record.tokenHash !== link?.tokenHash).length;
    return current?.contentHash && current.publishedAt
      ? { state: "live", publishedAt: current.publishedAt.toISOString(), revoking }
      : { state: "pending", publishedAt: null, revoking };
  }

  async reconcile(now: Date = new Date()): Promise<SubscriptionLinkReconcileResult> {
    const store = this.store;
    if (!store) return idle("disabled");
    if (this.running) return idle("busy");
    this.running = true;
    try {
      return await this.runPass(store, now, now.getTime() < this.pausedUntil);
    } catch (error) {
      // The pass never got as far as counting anything — in practice the
      // database could not be read. The figures from the last pass that did
      // run are no longer evidence that distribution is keeping up, so say
      // that it is not; only a pass that completes cleanly takes this back.
      // The error's own text stays out of a status an operator's browser reads.
      this.lastRunAt = now;
      this.lastError = SUBSCRIPTION_LINK_PASS_FAILED;
      throw error;
    } finally {
      this.running = false;
    }
  }

  private async runPass(store: SubscriptionLinkStore, now: Date, paused: boolean): Promise<SubscriptionLinkReconcileResult> {
    const result: SubscriptionLinkReconcileResult = { outcome: paused ? "paused" : "ran", written: 0, deleted: 0, failed: 0, pending: 0 };
    const destination = store.destination;
    const [links, publications, elsewhere] = await Promise.all([
      this.prisma.subscriptionLink.findMany({ select: { userId: true, tokenHash: true }, orderBy: { userId: "asc" } }),
      this.prisma.subscriptionLinkPublication.findMany({ where: { destination } }),
      this.prisma.subscriptionLinkPublication.count({ where: { destination: { not: destination } } })
    ]);
    this.noteElsewhere(elsewhere);
    const liveHashes = new Set(links.map((link) => link.tokenHash));
    const publishedByHash = new Map(publications.map((publication) => [publication.tokenHash, publication]));
    let abandoned = false;
    // A shutdown waits for this pass. Stop taking on new work the moment one
    // starts; everything left is still a difference for the next process.
    const stopping = () => abandoned || workLifecycle.isDraining;

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

    // Deletions first, and in every pass — paused ones included: a key that is
    // still there after a reset or an account removal is a link that still
    // works for whoever holds it.
    let revoking = 0;
    for (const publication of publications) {
      if (liveHashes.has(publication.tokenHash)) continue;
      if (stopping()) {
        revoking += 1;
        continue;
      }
      try {
        await store.delete(publication.tokenHash);
        await this.prisma.subscriptionLinkPublication.deleteMany({ where: { destination, tokenHash: publication.tokenHash } });
        result.deleted += 1;
      } catch (error) {
        revoking += 1;
        noteFailure("撤销", publication.tokenHash, error);
      }
    }
    this.lastRevoking = revoking;

    if (paused) {
      // Nothing was rendered, so there is no new figure for what is left to
      // publish; the last one stands. So does the last error, except the one
      // that said no pass could run: this one just did.
      if (this.lastError === SUBSCRIPTION_LINK_PASS_FAILED && result.failed === 0) this.lastError = null;
      if (result.deleted > 0) this.logger.log(`订阅链接分发（限流暂停中）：撤销 ${result.deleted} 条，待撤销 ${revoking} 条`);
      return result;
    }

    for (const link of links) {
      if (stopping() || result.written >= SUBSCRIPTION_LINK_MAX_WRITES_PER_PASS) {
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
      const confirmed = published?.contentHash && published.publishedAt ? published : null;
      const unchanged = confirmed?.contentHash === contentHash;
      const fresh = confirmed !== null && now.getTime() - confirmed.publishedAt!.getTime() < SUBSCRIPTION_LINK_REFRESH_AFTER_MS;
      if (unchanged && fresh) continue;
      const key = { destination_tokenHash: { destination, tokenHash: link.tokenHash } };
      try {
        // The list of links was read at the start of the pass. If this one was
        // reset or removed since, its token is no longer anyone's: do not
        // publish it now only to revoke it a pass later.
        const current = await this.prisma.subscriptionLink.findUnique({ where: { userId: link.userId }, select: { tokenHash: true } });
        if (current?.tokenHash !== link.tokenHash) {
          this.rerunRequested = true;
          continue;
        }
        if (!unchanged) {
          // Record first. From here on the key may exist in the store with
          // content nobody has confirmed, and this row is what a later pass
          // rewrites or revokes it by. (A daily rewrite of unchanged content
          // already has its row, and a failure leaves that row true.)
          await this.prisma.subscriptionLinkPublication.upsert({
            where: key,
            create: { destination, tokenHash: link.tokenHash, userId: link.userId, contentHash: null, publishedAt: null },
            update: { userId: link.userId, contentHash: null, publishedAt: null }
          });
        }
        await store.put(link.tokenHash, value);
        await this.prisma.subscriptionLinkPublication.update({ where: key, data: { contentHash, publishedAt: now } });
        result.written += 1;
      } catch (error) {
        result.pending += 1;
        noteFailure("发布", link.tokenHash, error);
      }
    }

    this.lastRunAt = now;
    this.lastPending = result.pending;
    if (result.failed === 0 && result.pending === 0 && revoking === 0) {
      this.lastSuccessAt = now;
      this.lastError = null;
    }
    if (result.written > 0 || result.deleted > 0) {
      this.logger.log(`订阅链接分发：写入 ${result.written} 条，撤销 ${result.deleted} 条，待处理 ${result.pending} 条`);
    }
    return result;
  }

  /**
   * Records written to a destination this process is not configured for. They
   * are kept — the keys may still be there, and only a process pointed back at
   * that destination can take them down — and said out loud, because nothing
   * else will: whatever still serves the old namespace keeps returning what
   * was last published to it.
   */
  private noteElsewhere(count: number) {
    this.elsewhere = count;
    if (count > 0 && !this.elsewhereReported) {
      this.logger.warn(
        `有 ${count} 条订阅链接分发记录属于之前配置的分发层。那里已发布的内容不会被更新或撤销，` +
          "如已不再使用，请在 Cloudflare 删除旧的 KV 命名空间。"
      );
    }
    this.elsewhereReported = count > 0;
  }
}
