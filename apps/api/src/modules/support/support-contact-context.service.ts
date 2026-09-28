import { Injectable, Logger } from "@nestjs/common";
import type { SupportContactProfileFieldKey } from "@chordv/shared";
import { PrismaService } from "../common/prisma.service";
import { pickCurrentSubscription, readEffectiveSubscriptionState } from "../common/subscription.utils";
import {
  SUPPORT_CONTACT_UNKNOWN,
  buildSupportContactAttributes,
  describeConnection,
  describePlan,
  type SupportLaunchContext,
  type SupportLeaseSnapshot,
  type SupportPlanSnapshot
} from "./support-contact-context";

/** 数据库查询的等待上限：慢了就显示“未知”，不拖慢打开工单。 */
const LOOKUP_TIMEOUT_MS = 1_500;

/**
 * 打开工单时附带的联系人资料里由后台负责的部分：连接详情（按会话记录）与套餐（按订阅）。
 * 查询失败或超时只把对应字段写成“未知”，永不抛错。
 */
@Injectable()
export class SupportContactContextService {
  private readonly logger = new Logger(SupportContactContextService.name);

  constructor(private readonly prisma: PrismaService) {}

  async buildAttributes(userId: string, context: SupportLaunchContext | null, now = new Date()): Promise<Record<SupportContactProfileFieldKey, string>> {
    const state = context?.connectionState ?? null;
    const [lease, plan] = await Promise.all([
      this.withFallback("会话记录", this.findLease(userId, context, now), undefined),
      this.withFallback("订阅", this.findPlan(userId), undefined)
    ]);
    const connection = describeConnection({
      state,
      errorCode: context?.connectionErrorCode ?? null,
      lease: lease === undefined ? "unknown" : lease,
      now
    });
    return buildSupportContactAttributes({
      context,
      connection,
      plan: plan === undefined ? SUPPORT_CONTACT_UNKNOWN : describePlan(plan),
      now
    });
  }

  /**
   * 有会话 ID 时只找本机那条有效会话；客户端说已连接 / 正在连接却没带会话 ID、或旧版客户端（不知道状态），
   * 取该用户最近的一条有效会话；客户端明确未连接、断开中或失败时不查。
   */
  private async findLease(userId: string, context: SupportLaunchContext | null, now: Date): Promise<SupportLeaseSnapshot | null> {
    const state = context?.connectionState;
    if (!context?.sessionId && (state === "disconnected" || state === "disconnecting" || state === "error")) {
      return null;
    }
    const lease = await this.prisma.nodeSessionLease.findFirst({
      where: {
        userId,
        status: "active",
        expiresAt: { gt: now },
        ...(context?.sessionId ? { sessionId: context.sessionId } : {})
      },
      orderBy: { issuedAt: "desc" },
      select: {
        connectionMode: true,
        issuedAt: true,
        node: { select: { name: true, protocol: true, security: true } }
      }
    });
    return lease ?? null;
  }

  /** 与客户端订阅页一致：团队成员看团队订阅，否则看个人订阅；状态按到期时间和流量折算。 */
  private async findPlan(userId: string): Promise<SupportPlanSnapshot | null> {
    const select = { state: true, expireAt: true, remainingTrafficGb: true, createdAt: true, plan: { select: { name: true } } } as const;
    const membership = await this.prisma.teamMember.findUnique({
      where: { userId },
      select: { team: { select: { subscriptions: { select, orderBy: [{ expireAt: "desc" }, { createdAt: "desc" }] } } } }
    });
    const rows = membership
      ? membership.team.subscriptions
      : await this.prisma.subscription.findMany({ where: { userId }, select, orderBy: [{ expireAt: "desc" }, { createdAt: "desc" }] });
    const current = pickCurrentSubscription(rows);
    if (!current) return null;
    return {
      scope: membership ? "team" : "personal",
      planName: current.plan.name,
      state: readEffectiveSubscriptionState(current),
      expireAt: current.expireAt,
      remainingTrafficGb: current.remainingTrafficGb
    };
  }

  private async withFallback<T>(label: string, task: Promise<T>, fallback: T | undefined): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), LOOKUP_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([task, timeout]);
      if (result === undefined) {
        this.logger.warn(`读取工单联系人资料的${label}超时，按未知处理`);
        task.catch(() => undefined);
      }
      return result === undefined ? fallback : result;
    } catch (error) {
      this.logger.warn(`读取工单联系人资料的${label}失败，按未知处理：${error instanceof Error ? error.message : String(error)}`);
      return fallback;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
