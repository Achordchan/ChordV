import { BadRequestException, ConflictException, HttpException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type {
  AdminDeletableEntityKind,
  AdminDeletePreviewDto,
  AdminDeleteRelatedItemDto,
  AdminDeleteResultDto,
  AgentCommandDto
} from "@chordv/shared";
import { AdminRuntimeEventsService } from "./admin-runtime-events.service";
import { ClientRuntimeEventsService } from "./client-runtime-events.service";
import { PrismaService } from "./prisma.service";
import { RuntimeSessionService } from "./runtime-session.service";

const SAMPLE_LIMIT = 5;
const KIND_LABEL: Record<AdminDeletableEntityKind, string> = {
  user: "账号",
  plan: "套餐",
  subscription: "订阅",
  team: "团队"
};

type Db = Prisma.TransactionClient | PrismaService;

type DeletionScope = {
  name: string;
  related: AdminDeleteRelatedItemDto[];
  blockedReason: string | null;
  /** 删除前要断开的订阅（它们会随删除一起消失）。 */
  subscriptionIds: string[];
  /** 需要通知客户端刷新的用户。 */
  affectedUserIds: string[];
  /** 被删的账号本身（要让它的客户端退出登录）。 */
  deletedUserId: string | null;
  /** 会随删除级联消失的节点账号。 */
  bindingWhere: Prisma.PanelClientBindingWhereInput;
};

type SubscriptionSample = {
  id: string;
  userId: string | null;
  teamId: string | null;
  plan: { name: string };
  user: { displayName: string; email: string } | null;
  team: { name: string; members: Array<{ userId: string }> } | null;
};

const SUBSCRIPTION_SAMPLE_SELECT = {
  id: true,
  userId: true,
  teamId: true,
  plan: { select: { name: true } },
  user: { select: { displayName: true, email: true } },
  team: { select: { name: true, members: { select: { userId: true } } } }
} as const;

function item(key: string, label: string, count: number, samples: string[] = []): AdminDeleteRelatedItemDto {
  return { key, label, count, samples: samples.slice(0, SAMPLE_LIMIT) };
}

function describeSubscription(row: SubscriptionSample) {
  const owner = row.team ? `团队 ${row.team.name}` : row.user ? row.user.displayName || row.user.email : "未知归属";
  return `${owner} · ${row.plan.name}`;
}

function subscriptionUserIds(rows: SubscriptionSample[]) {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.userId) ids.add(row.userId);
    for (const member of row.team?.members ?? []) ids.add(member.userId);
  }
  return ids;
}

function readErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 用户、套餐、订阅、团队的硬删除。
 *
 * 数据库里这些关系都是级联删除：删套餐会带走它的全部订阅，订阅又带走流量账本、
 * 节点账号、会话等。所以删除前先给出预览，有关联数据时必须显式 force；
 * 删除时在同一个事务里先给节点下发 REMOVE_USER（命令行与订阅没有外键，删除后仍在），
 * 再删记录，避免节点上留下还能用的账号。
 */
@Injectable()
export class AdminDeletionService {
  private readonly logger = new Logger(AdminDeletionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly runtimeSessionService: RuntimeSessionService,
    private readonly clientRuntimeEventsService: ClientRuntimeEventsService,
    private readonly adminRuntimeEventsService: AdminRuntimeEventsService
  ) {}

  async preview(kind: AdminDeletableEntityKind, id: string, actorUserId: string | null): Promise<AdminDeletePreviewDto> {
    const scope = await this.resolveScope(this.prisma, kind, id, actorUserId);
    return {
      kind,
      id,
      name: scope.name,
      related: scope.related,
      requiresForce: scope.related.some((entry) => entry.count > 0),
      blockedReason: scope.blockedReason
    };
  }

  async delete(
    kind: AdminDeletableEntityKind,
    id: string,
    options: { force: boolean; actorUserId: string | null }
  ): Promise<AdminDeleteResultDto> {
    // 第一遍不加锁：用来在删除前拒绝、以及先断开在线会话（会话行会随删除消失，
    // 删除之后就没有办法再通知到客户端）。真正的校验在下面加锁的事务里重做。
    const precheck = await this.resolveScope(this.prisma, kind, id, options.actorUserId);
    this.assertDeletable(kind, precheck, options.force);
    await this.revokeLeasesBestEffort(kind, id, precheck);

    let scope = precheck;
    let commands: Array<{ agentId: string; command: AgentCommandDto }> = [];
    let skipped = 0;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const outcome = await this.prisma.$transaction(async (tx) => {
          // 锁住要删的行和它名下的订阅：新建订阅/节点账号/团队成员都要对这些父行取外键锁，
          // 会一直等到本事务结束（那时父行已删，插入失败）。所以下面读到的关联数据就是
          // 删除时级联的全部，不会有漏掉 REMOVE_USER 的绑定，也不会有未经确认的新订阅。
          await this.lockForDelete(tx, kind, id);
          const locked = await this.resolveScope(tx, kind, id, options.actorUserId);
          this.assertDeletable(kind, locked, options.force);
          const removal = await this.runtimeSessionService.queueBindingRemovalBeforeDeleteTx(tx, locked.bindingWhere);
          await this.deleteRow(tx, kind, id);
          return { ...removal, scope: locked };
        });
        commands = outcome.commands;
        skipped = outcome.skipped;
        scope = outcome.scope;
        break;
      } catch (error) {
        if (error instanceof HttpException) throw error;
        if (isRecordMissing(error)) throw new NotFoundException(`${KIND_LABEL[kind]}不存在或已被删除`);
        if (isTransientConflict(error) && attempt < 3) continue;
        this.logger.warn(`Delete ${kind} ${id} failed: ${readErrorMessage(error)}`);
        throw new ServiceUnavailableException(`${KIND_LABEL[kind]}删除失败，请刷新后重试。`);
      }
    }

    this.runtimeSessionService.publishAgentCommandsBestEffort(commands);
    this.publishAfterDelete(kind, scope);

    const parts = [`${KIND_LABEL[kind]}「${scope.name}」已删除。`];
    if (commands.length > 0) parts.push(`已通知节点删除 ${commands.length} 个账号。`);
    if (skipped > 0) parts.push(`${skipped} 个节点账号所在节点没有可用 Agent 或不在 Agent 直控模式，无法自动删除，需要到节点上自行检查。`);
    return {
      ok: true,
      kind,
      id,
      message: parts.join(""),
      queuedNodeRemovalCount: commands.length,
      skippedNodeRemovalCount: skipped
    };
  }

  private assertDeletable(kind: AdminDeletableEntityKind, scope: DeletionScope, force: boolean) {
    if (scope.blockedReason) {
      throw new BadRequestException(scope.blockedReason);
    }
    const nonEmpty = scope.related.filter((entry) => entry.count > 0);
    if (nonEmpty.length > 0 && !force) {
      throw new ConflictException(
        `该${KIND_LABEL[kind]}还有关联数据（${nonEmpty.map((entry) => `${entry.label} ${entry.count}`).join("、")}），需要确认强制删除。`
      );
    }
  }

  /**
   * FOR UPDATE 与外键检查取的 KEY SHARE 锁冲突，所以锁住父行后，引用它们的插入都会等待。
   * 删账号时先按 id 顺序锁住全部管理员：两个管理员同时互删时第二个请求会等第一个提交，
   * 再数管理员时就能看到对方已经被删，“至少保留一个管理员”不会被并发绕过。
   */
  private async lockForDelete(tx: Prisma.TransactionClient, kind: AdminDeletableEntityKind, id: string) {
    switch (kind) {
      case "user":
        await tx.$queryRaw`SELECT id FROM "User" WHERE role = 'admin' ORDER BY id FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${id} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "Team" WHERE "ownerUserId" = ${id} ORDER BY id FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "Subscription" WHERE "userId" = ${id} OR "teamId" IN (SELECT id FROM "Team" WHERE "ownerUserId" = ${id}) ORDER BY id FOR UPDATE`;
        return;
      case "plan":
        await tx.$queryRaw`SELECT id FROM "Plan" WHERE id = ${id} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "Subscription" WHERE "planId" = ${id} ORDER BY id FOR UPDATE`;
        return;
      case "subscription":
        await tx.$queryRaw`SELECT id FROM "Subscription" WHERE id = ${id} FOR UPDATE`;
        return;
      case "team":
        await tx.$queryRaw`SELECT id FROM "Team" WHERE id = ${id} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "Subscription" WHERE "teamId" = ${id} ORDER BY id FOR UPDATE`;
        return;
    }
  }

  private async deleteRow(tx: Prisma.TransactionClient, kind: AdminDeletableEntityKind, id: string) {
    switch (kind) {
      case "user":
        await tx.user.delete({ where: { id } });
        return;
      case "plan":
        await tx.plan.delete({ where: { id } });
        return;
      case "subscription":
        await tx.subscription.delete({ where: { id } });
        return;
      case "team":
        await tx.team.delete({ where: { id } });
        return;
    }
  }

  private async revokeLeasesBestEffort(kind: AdminDeletableEntityKind, id: string, scope: DeletionScope) {
    const reason = `${kind}_deleted`;
    try {
      if (scope.deletedUserId) {
        await this.runtimeSessionService.revokeUserLeases(scope.deletedUserId, reason);
      }
      for (const subscriptionId of scope.subscriptionIds) {
        await this.runtimeSessionService.revokeSubscriptionLeases(subscriptionId, reason);
      }
    } catch (error) {
      this.logger.warn(`Lease revocation before deleting ${kind} ${id} failed: ${readErrorMessage(error)}`);
    }
  }

  private publishAfterDelete(kind: AdminDeletableEntityKind, scope: DeletionScope) {
    const occurredAt = new Date().toISOString();
    try {
      if (scope.deletedUserId) {
        this.clientRuntimeEventsService.publishToUser(scope.deletedUserId, {
          type: "account_updated",
          occurredAt,
          reasonCode: "auth_invalid",
          reasonMessage: "当前账号已被删除。"
        });
      }
      const others = scope.affectedUserIds.filter((userId) => userId !== scope.deletedUserId);
      if (others.length > 0) {
        this.clientRuntimeEventsService.publishToUsers(others, {
          type: "subscription_updated",
          occurredAt,
          reasonCode: "admin_paused_connection",
          reasonMessage: "订阅已被管理员删除。"
        });
      }
    } catch (error) {
      this.logger.warn(`Client event publish after deleting ${kind} failed: ${readErrorMessage(error)}`);
    }
    try {
      this.adminRuntimeEventsService.publish({ type: "account_updated", occurredAt });
      this.adminRuntimeEventsService.publish({ type: "subscription_updated", occurredAt });
    } catch (error) {
      this.logger.warn(`Admin event publish after deleting ${kind} failed: ${readErrorMessage(error)}`);
    }
  }

  private async resolveScope(db: Db, kind: AdminDeletableEntityKind, id: string, actorUserId: string | null): Promise<DeletionScope> {
    switch (kind) {
      case "user":
        return this.resolveUserScope(db, id, actorUserId);
      case "plan":
        return this.resolvePlanScope(db, id);
      case "subscription":
        return this.resolveSubscriptionScope(db, id);
      case "team":
        return this.resolveTeamScope(db, id);
      default:
        throw new BadRequestException("不支持删除这种数据");
    }
  }

  private async resolveUserScope(db: Db, userId: string, actorUserId: string | null): Promise<DeletionScope> {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, displayName: true, role: true, subscriptionLink: { select: { userId: true } } }
    });
    if (!user) throw new NotFoundException("账号不存在或已被删除");

    let blockedReason: string | null = null;
    if (actorUserId && actorUserId === userId) {
      blockedReason = "不能删除当前登录的管理员账号。";
    } else if (user.role === "admin") {
      const otherAdmins = await db.user.count({ where: { role: "admin", id: { not: userId } } });
      if (otherAdmins === 0) blockedReason = "这是最后一个管理员账号，不能删除。";
    }

    const ownedTeams = await db.team.findMany({
      where: { ownerUserId: userId },
      select: { id: true, name: true, members: { select: { userId: true } } }
    });
    const ownedTeamIds = ownedTeams.map((team) => team.id);
    const subscriptions: SubscriptionSample[] = await db.subscription.findMany({
      where: { OR: [{ userId }, ...(ownedTeamIds.length > 0 ? [{ teamId: { in: ownedTeamIds } }] : [])] },
      select: SUBSCRIPTION_SAMPLE_SELECT
    });
    const personal = subscriptions.filter((row) => row.userId === userId);
    const teamSubs = subscriptions.filter((row) => row.teamId !== null);
    const memberships = await db.teamMember.findMany({
      where: { userId, teamId: { notIn: ownedTeamIds } },
      select: { team: { select: { name: true } } }
    });
    const ownedTeamMemberCount = ownedTeams.reduce((sum, team) => sum + team.members.filter((member) => member.userId !== userId).length, 0);
    const bindingWhere: Prisma.PanelClientBindingWhereInput = {
      OR: [{ userId }, ...(ownedTeamIds.length > 0 ? [{ teamId: { in: ownedTeamIds } }] : [])]
    };
    const subscriptionIds = subscriptions.map((row) => row.id);
    const [bindingCount, ledgerCount, ticketCount, sessionCount, routingRuleCount] = await Promise.all([
      db.panelClientBinding.count({ where: { AND: [bindingWhere, { status: { in: ["active", "disabled"] } }] } }),
      db.trafficLedger.count({ where: { OR: [{ userId }, ...(subscriptionIds.length > 0 ? [{ subscriptionId: { in: subscriptionIds } }] : [])] } }),
      db.supportTicket.count({ where: { userId } }),
      this.countActiveSessions(db, { OR: [{ userId }, ...(subscriptionIds.length > 0 ? [{ subscriptionId: { in: subscriptionIds } }] : [])] }),
      db.clientRoutingRule.count({ where: { userId } })
    ]);

    const affected = subscriptionUserIds(teamSubs);
    affected.add(userId);
    for (const team of ownedTeams) for (const member of team.members) affected.add(member.userId);

    return {
      name: user.displayName || user.email,
      blockedReason,
      related: [
        item("subscriptions", "个人订阅", personal.length, personal.map(describeSubscription)),
        item("ownedTeams", "名下团队（连同团队订阅一起删除）", ownedTeams.length, ownedTeams.map((team) => team.name)),
        item("ownedTeamMembers", "名下团队的其他成员（会失去团队订阅）", ownedTeamMemberCount),
        item("teamMemberships", "加入的其他团队（移出）", memberships.length, memberships.map((row) => row.team.name)),
        item("nodeAccounts", "节点上的账号（通知节点删除）", bindingCount),
        item("activeSessions", "在线连接（立即断开）", sessionCount),
        item("trafficRecords", "流量记录", ledgerCount),
        item("tickets", "工单", ticketCount),
        item("routingRules", "自定义分流规则", routingRuleCount),
        item("subscriptionLink", "第三方订阅链接（失效）", user.subscriptionLink ? 1 : 0)
      ],
      subscriptionIds,
      affectedUserIds: Array.from(affected),
      deletedUserId: userId,
      bindingWhere
    };
  }

  private async resolvePlanScope(db: Db, planId: string): Promise<DeletionScope> {
    const plan = await db.plan.findUnique({ where: { id: planId }, select: { id: true, name: true } });
    if (!plan) throw new NotFoundException("套餐不存在或已被删除");
    const subscriptions: SubscriptionSample[] = await db.subscription.findMany({
      where: { planId },
      select: SUBSCRIPTION_SAMPLE_SELECT
    });
    return this.subscriptionsScope(db, plan.name, subscriptions, { planId }, [
      item("subscriptions", "使用此套餐的订阅（一起删除）", subscriptions.length, subscriptions.map(describeSubscription))
    ]);
  }

  private async resolveSubscriptionScope(db: Db, subscriptionId: string): Promise<DeletionScope> {
    const subscription: SubscriptionSample | null = await db.subscription.findUnique({
      where: { id: subscriptionId },
      select: SUBSCRIPTION_SAMPLE_SELECT
    });
    if (!subscription) throw new NotFoundException("订阅不存在或已被删除");
    return this.subscriptionsScope(db, describeSubscription(subscription), [subscription], { id: subscriptionId }, []);
  }

  private async resolveTeamScope(db: Db, teamId: string): Promise<DeletionScope> {
    const team = await db.team.findUnique({
      where: { id: teamId },
      select: { id: true, name: true, members: { select: { userId: true, user: { select: { displayName: true, email: true } } } } }
    });
    if (!team) throw new NotFoundException("团队不存在或已被删除");
    const subscriptions: SubscriptionSample[] = await db.subscription.findMany({
      where: { teamId },
      select: SUBSCRIPTION_SAMPLE_SELECT
    });
    const scope = await this.subscriptionsScope(db, team.name, subscriptions, { teamId }, [
      item("members", "团队成员（移出团队，账号保留）", team.members.length, team.members.map((member) => member.user.displayName || member.user.email)),
      item("subscriptions", "团队订阅（一起删除）", subscriptions.length, subscriptions.map(describeSubscription))
    ]);
    const affected = new Set(scope.affectedUserIds);
    for (const member of team.members) affected.add(member.userId);
    return { ...scope, affectedUserIds: Array.from(affected), bindingWhere: { OR: [{ teamId }, ...(scope.subscriptionIds.length > 0 ? [{ subscriptionId: { in: scope.subscriptionIds } }] : [])] } };
  }

  private async subscriptionsScope(db: Db, 
    name: string,
    subscriptions: SubscriptionSample[],
    owner: Prisma.SubscriptionWhereInput,
    leading: AdminDeleteRelatedItemDto[]
  ): Promise<DeletionScope> {
    const subscriptionIds = subscriptions.map((row) => row.id);
    const bindingWhere: Prisma.PanelClientBindingWhereInput = { subscription: owner };
    const [bindingCount, ledgerCount, ticketCount, sessionCount] = subscriptionIds.length === 0
      ? [0, 0, 0, 0]
      : await Promise.all([
          db.panelClientBinding.count({ where: { AND: [bindingWhere, { status: { in: ["active", "disabled"] } }] } }),
          db.trafficLedger.count({ where: { subscriptionId: { in: subscriptionIds } } }),
          db.supportTicket.count({ where: { subscriptionId: { in: subscriptionIds } } }),
          this.countActiveSessions(db, { subscriptionId: { in: subscriptionIds } })
        ]);
    return {
      name,
      blockedReason: null,
      related: [
        ...leading,
        item("nodeAccounts", "节点上的账号（通知节点删除）", bindingCount),
        item("activeSessions", "在线连接（立即断开）", sessionCount),
        item("trafficRecords", "流量记录", ledgerCount),
        item("tickets", "关联工单（保留，解除与订阅的关联）", ticketCount)
      ],
      subscriptionIds,
      affectedUserIds: Array.from(subscriptionUserIds(subscriptions)),
      deletedUserId: null,
      bindingWhere
    };
  }

  private countActiveSessions(db: Db, where: Prisma.NodeSessionLeaseWhereInput) {
    return db.nodeSessionLease.count({
      where: { AND: [where, { status: "active", expiresAt: { gt: new Date() } }] }
    });
  }
}

/** 死锁或写冲突：和并发的开通/计量撞上了，整个事务重来即可。 */
function isTransientConflict(error: unknown) {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === "P2034") return true;
  return /deadlock detected|could not serialize/i.test(readErrorMessage(error));
}

function isRecordMissing(error: unknown) {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2025";
}
