import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DrainableJob } from "../../work-lifecycle";
import { AdminSubscriptionService } from "./admin-subscription.service";
import { PrismaService } from "./prisma.service";

/** 每分钟最多处理的到期订阅数；每个重置要等节点结清，串行执行，限量防止一轮拖太久。 */
const MAX_RESETS_PER_TICK = 10;
/** 一个订阅重置失败后（多半是节点离线、用量结不清），隔多久再试，避免每分钟都让客户断一下。 */
const FAILURE_RETRY_DELAY_MS = 30 * 60 * 1000;

/**
 * 按订阅的“每月重置日”自动重置流量。
 *
 * 只看 Subscription.nextTrafficResetAt：到点的订阅交给 AdminSubscriptionService
 * 用手动重置同一套流程执行，执行与推进下一次在同一事务里完成，并以
 * nextTrafficResetAt 做条件，所以多个进程同时跑也只会清零一次。
 *
 * 每分钟一次而不是每天一次：后台每次更新都会重启，按天调度可能被重启跳过；
 * 每分钟检查一次，重启后补上即可。长时间停机后只补最近一次，不会连续清零多次。
 */
@Injectable()
export class TrafficResetScheduleService {
  private readonly logger = new Logger(TrafficResetScheduleService.name);
  private readonly retryNotBefore = new Map<string, number>();
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly adminSubscriptionService: AdminSubscriptionService
  ) {}

  @Cron("20 * * * * *")
  @DrainableJob()
  async runDueTrafficResets() {
    await this.runDueTrafficResetsAt(new Date());
  }

  /** 定时任务的实际入口；测试可传入固定时间。 */
  async runDueTrafficResetsAt(now: Date) {
    if (this.running) return;
    this.running = true;
    try {
      await this.runDueTrafficResetsOnce(now);
    } finally {
      this.running = false;
    }
  }

  private async runDueTrafficResetsOnce(now: Date) {
    // 退避中的订阅在查询里就排除，否则一批反复失败的订阅会占满每轮的名额，后面的订阅永远轮不到。
    for (const [id, retryAt] of this.retryNotBefore) {
      if (retryAt <= now.getTime()) this.retryNotBefore.delete(id);
    }
    const backedOff = Array.from(this.retryNotBefore.keys());
    const due = await this.prisma.subscription.findMany({
      where: {
        nextTrafficResetAt: { lte: now },
        ...(backedOff.length > 0 ? { id: { notIn: backedOff } } : {})
      },
      select: { id: true, nextTrafficResetAt: true, expireAt: true, state: true },
      orderBy: { nextTrafficResetAt: "asc" },
      take: MAX_RESETS_PER_TICK * 3
    });
    let attempted = 0;
    for (const row of due) {
      if (attempted >= MAX_RESETS_PER_TICK) break;
      const dueAt = row.nextTrafficResetAt;
      if (!dueAt) continue;

      if (row.state === "expired" || row.expireAt.getTime() <= now.getTime()) {
        try {
          await this.adminSubscriptionService.skipScheduledTrafficReset(row.id, dueAt, now);
        } catch (error) {
          this.logger.warn(`订阅 ${row.id} 已过期，推进下次重置时间失败：${readErrorMessage(error)}`);
        }
        continue;
      }

      attempted += 1;
      try {
        const outcome = await this.adminSubscriptionService.runScheduledTrafficReset(row.id, dueAt);
        this.retryNotBefore.delete(row.id);
        if (outcome === "reset") {
          this.logger.log(`订阅 ${row.id} 已按每月重置日自动重置流量（计划时间 ${dueAt.toISOString()}）`);
        }
      } catch (error) {
        this.retryNotBefore.set(row.id, now.getTime() + FAILURE_RETRY_DELAY_MS);
        this.logger.warn(`订阅 ${row.id} 自动重置流量失败，30 分钟后重试：${readErrorMessage(error)}`);
      }
    }
  }
}

function readErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
