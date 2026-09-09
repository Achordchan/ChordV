import { isNodeOnboardingReady } from "./node-onboarding-policy";
import { workLifecycle } from "../../work-lifecycle";
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException
} from "@nestjs/common";
import type {
  AdminLeaseRevocationJobDto,
  AdminNodeCommandJobDto,
  AdminNodeCommandSummariesDto,
  AdminNodeCommandSummaryDto,
  AdminNodeRecordDto,
  UpdateNodeInputDto
} from "@chordv/shared";
import { PrismaService } from "./prisma.service";
import { RuntimeSessionService } from "./runtime-session.service";
import { ClientEventsPublisher } from "./client-events.publisher";
import { AdminRuntimeEventsService } from "./admin-runtime-events.service";
import { throwLocalSaveAsServiceUnavailable } from "./prisma-error.utils";
import { normalizeTags, probeNodeConnectivity, resolveNodeCountry, toAdminNodeRecord } from "./node-import.utils";

export type AdminNodeProbeClock = {
  now: () => number;
};
const SYSTEM_ADMIN_NODE_PROBE_CLOCK: AdminNodeProbeClock = {
  now: () => Date.now()
};

const NODE_AFTER_SAVE_FOLLOW_UP_BUDGET_MS = 300;
const NODE_AFTER_SAVE_DEFERRED_EFFECT_DELAY_MS = 50;
const DEFAULT_BULK_NODE_PROBE_BUDGET_MS = 5_000;
const DEFAULT_BULK_NODE_PROBE_REQUEST_BUDGET_MS = 45_000;
const MAX_BULK_NODE_PROBE_REQUEST_BUDGET_MS = 45_000;
const DEFAULT_BULK_NODE_PROBE_CONCURRENCY = 10;
const BULK_NODE_PROBE_START_GUARD_MS = 5;
const NODE_COMMAND_JOB_PAGE_SIZE = 200;
const NODE_COMMAND_ERROR_SAMPLE_SIZE = 500;

@Injectable()
export class AdminNodeService {
  private readonly logger = new Logger(AdminNodeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly runtimeSessionService: RuntimeSessionService,
    private readonly clientEventsPublisher: ClientEventsPublisher,
    private readonly adminRuntimeEventsService?: AdminRuntimeEventsService
  ) {}

  async listAdminNodes(): Promise<AdminNodeRecordDto[]> {
    const rows = await runAdminNodeLocalOperation(
      () => this.prisma.node.findMany({
        include: {
          nodeAgents: {
            where: { revokedAt: null },
            orderBy: [{ lastSeenAt: "desc" }, { createdAt: "desc" }],
            take: 1
          }
        },
        orderBy: [{ recommended: "desc" }, { latencyMs: "asc" }, { createdAt: "desc" }]
      }),
      "节点列表读取失败，请刷新后重试。"
    );
    return rows.map((row) => toAdminNodeRecord(row));
  }

  async listLeaseRevocationJobs(): Promise<AdminLeaseRevocationJobDto[]> {
    const rows = await runAdminNodeLocalOperation(
      () => this.prisma.leaseRevocationJob.findMany({
        where: {
          status: { in: ["pending", "running", "failed"] }
        },
        orderBy: [{ status: "asc" }, { nextRunAt: "asc" }, { createdAt: "desc" }],
        take: 200
      }),
      "连接撤销队列读取失败，请刷新后重试。"
    );
    const nodeIds = Array.from(new Set(rows.map((row) => row.nodeId).filter((nodeId): nodeId is string => Boolean(nodeId))));
    let nodes: Array<{ id: string; name: string }> = [];
    if (nodeIds.length > 0) {
      try {
        nodes = await runAdminNodeLocalOperation(
          () => this.prisma.node.findMany({
            where: { id: { in: nodeIds } },
            select: { id: true, name: true }
          }),
          "连接撤销队列节点信息读取失败，请刷新后重试。"
        );
      } catch (error) {
        this.logger.warn(`Lease revocation queue loaded without node names: ${readAdminNodeErrorMessage(error)}`);
      }
    }
    const nodeNameById = new Map(nodes.map((node) => [node.id, node.name]));

    return rows.map((row) => ({
      id: row.id,
      reason: row.reason,
      status: row.status as AdminLeaseRevocationJobDto["status"],
      subscriptionId: row.subscriptionId,
      userId: row.userId,
      nodeId: row.nodeId,
      nodeName: row.nodeId ? nodeNameById.get(row.nodeId) ?? null : null,
      attempts: row.attempts,
      nextRunAt: row.nextRunAt.toISOString(),
      lockedAt: row.lockedAt?.toISOString() ?? null,
      lastError: row.lastError,
      completedAt: row.completedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString()
    }));
  }

  /**
   * Active agent commands — the direct track's replacement for the retired
   * panel sync queue. User commands carry their binding target as columns
   * (denormalized at enqueue), so the queue can be filtered and aggregated per
   * subscription/user/team without reading the payload JSON. The detail list
   * is capped; when a target filter is given it applies SERVER-SIDE so an
   * administrator can always inspect a known-busy target whose commands fall
   * outside the global first page.
   */
  async listNodeCommandJobs(filter?: { nodeId?: string; subscriptionId?: string; userId?: string; teamId?: string }) {
    // Scope constraints INTERSECT (AND), matching the lease queue's filter
    // semantics: a team member's view supplies subscriptionId + userId +
    // teamId together and means exactly that member, not everyone else's
    // commands under the same team or subscription.
    const scoped = {
      ...(filter?.nodeId ? { nodeId: filter.nodeId } : {}),
      ...(filter?.subscriptionId ? { subscriptionId: filter.subscriptionId } : {}),
      ...(filter?.userId ? { userId: filter.userId } : {}),
      ...(filter?.teamId ? { teamId: filter.teamId } : {})
    };
    const hasFilter = Object.keys(scoped).length > 0;
    const rows = await runAdminNodeLocalOperation(
      () => this.prisma.nodeCommandJob.findMany({
        where: {
          // "cancelled" here is RETRY-EXHAUSTED (retryDueCommands gave up
          // after 8 attempts): the requested operation never happened, so it
          // stays listed as an unresolved failure until a newer command for
          // the same target resolves it (resolvedAt) or it is re-ordered.
          // Superseded commands are excluded by their renamed dedupe keys.
          OR: [
            { status: { in: ["pending", "running", "failed"] } },
            { status: "cancelled", resolvedAt: null }
          ],
          ...(hasFilter ? scoped : {})
        },
        orderBy: [{ status: "asc" }, { nextRunAt: "asc" }, { createdAt: "desc" }],
        take: NODE_COMMAND_JOB_PAGE_SIZE,
        include: { node: { select: { name: true } } }
      }),
      "节点命令队列读取失败，请刷新后重试。"
    );

    return rows.map((row) => ({
      id: row.id,
      nodeId: row.nodeId,
      nodeName: row.node?.name ?? null,
      commandType: row.commandType as AdminNodeCommandJobDto["commandType"],
      status: row.status as AdminNodeCommandJobDto["status"],
      attempts: row.attempts,
      targetRevision: row.targetRevision.toString(),
      subscriptionId: row.subscriptionId,
      userId: row.userId,
      lastError: row.lastError,
      nextRunAt: row.nextRunAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString()
    }));
  }

  /**
   * Exact outstanding-command counts per node/subscription/user/team. The
   * detail list above is paginated, so it must never be the source of a
   * "synced" verdict: a node with 300 queued users would otherwise read as
   * synced once its commands fell off the first page.
   */
  async listNodeCommandSummaries(): Promise<AdminNodeCommandSummariesDto> {
    const rows = await runAdminNodeLocalOperation(
      () => this.prisma.nodeCommandJob.groupBy({
        by: ["nodeId", "subscriptionId", "userId", "teamId", "status"],
        where: {
          // Cancelled = retry-exhausted and NOT yet resolved, an UNRESOLVED
          // failure the operator must still see; resolved ones (a newer
          // command took over the target) drop out. Superseded commands never
          // carry the cancelled status.
          OR: [
            { status: { in: ["pending", "running", "failed"] } },
            { status: "cancelled", resolvedAt: null }
          ]
        },
        _count: { _all: true }
      }),
      "节点命令统计读取失败，请刷新后重试。"
    );
    const recentErrors = await this.listRecentNodeCommandErrors();

    const nodes = new Map<string, AdminNodeCommandSummaryDto>();
    const subscriptions = new Map<string, AdminNodeCommandSummaryDto>();
    const users = new Map<string, AdminNodeCommandSummaryDto>();
    const teams = new Map<string, AdminNodeCommandSummaryDto>();
    const addCount = (map: Map<string, AdminNodeCommandSummaryDto>, key: string | null, status: string, count: number) => {
      if (!key) {
        return;
      }
      const summary = map.get(key) ?? { pending: 0, running: 0, failed: 0, total: 0, lastError: null };
      if (status === "failed" || status === "cancelled") {
        // Cancelled = retry-exhausted: it never completed, so it reads as a
        // failure the operator still needs to resolve.
        summary.failed += count;
      } else if (status === "running") {
        summary.running += count;
      } else {
        summary.pending += count;
      }
      summary.total += count;
      map.set(key, summary);
    };
    const addError = (map: Map<string, AdminNodeCommandSummaryDto>, key: string | null, error: string | null) => {
      if (!key || !error) {
        return;
      }
      const summary = map.get(key) ?? { pending: 0, running: 0, failed: 0, total: 0, lastError: null };
      summary.lastError = summary.lastError ?? error;
      map.set(key, summary);
    };

    for (const row of rows) {
      const count = row._count?._all ?? 0;
      addCount(nodes, row.nodeId, row.status, count);
      addCount(subscriptions, row.subscriptionId, row.status, count);
      addCount(users, row.userId, row.status, count);
      addCount(teams, row.teamId, row.status, count);
    }
    // Newest first: the first error seen for a target is the one to show.
    for (const error of recentErrors) {
      addError(nodes, error.nodeId, error.lastError);
      addError(subscriptions, error.subscriptionId, error.lastError);
      addError(users, error.userId, error.lastError);
      addError(teams, error.teamId, error.lastError);
    }

    const toEntries = (map: Map<string, AdminNodeCommandSummaryDto>) =>
      Array.from(map, ([key, summary]) => ({ key, ...summary })).sort((a, b) => a.key.localeCompare(b.key));
    return {
      nodes: toEntries(nodes),
      subscriptions: toEntries(subscriptions),
      users: toEntries(users),
      teams: toEntries(teams)
    };
  }

  private async listRecentNodeCommandErrors() {
    try {
      return await runAdminNodeLocalOperation(
        () => this.prisma.nodeCommandJob.findMany({
          where: {
            OR: [
              { status: { in: ["pending", "running", "failed"] } },
              { status: "cancelled", resolvedAt: null }
            ],
            lastError: { not: null }
          },
          orderBy: { createdAt: "desc" },
          take: NODE_COMMAND_ERROR_SAMPLE_SIZE,
          select: {
            nodeId: true,
            subscriptionId: true,
            userId: true,
            teamId: true,
            lastError: true
          }
        }),
        "节点命令错误读取失败，请刷新后重试。"
      );
    } catch (error) {
      this.logger.warn(`Node command summaries loaded without errors: ${readAdminNodeErrorMessage(error)}`);
      return [];
    }
  }

  async retryLeaseRevocationJob(jobId: string): Promise<AdminLeaseRevocationJobDto[]> {
    const updated = await runAdminNodeLocalOperation(
      () => this.prisma.leaseRevocationJob.updateMany({
        where: {
          id: jobId,
          status: { in: ["pending", "failed"] }
        },
        data: {
          status: "pending",
          nextRunAt: new Date(),
          lockedAt: null,
          completedAt: null,
          attempts: 0,
          lastError: null
        }
      }),
      "连接撤销任务重试保存失败，请稍后重试。"
    );
    if (updated.count === 0) {
      throw new NotFoundException("连接撤销任务不存在或已完成");
    }
    this.publishSyncQueueUpdatedBestEffort({});
    return this.listLeaseRevocationJobsAfterRetry();
  }

  async retryLeaseRevocationJobsForNode(nodeId: string): Promise<AdminLeaseRevocationJobDto[]> {
    const updated = await runAdminNodeLocalOperation(
      () => this.prisma.leaseRevocationJob.updateMany({
        where: {
          nodeId,
          status: { in: ["pending", "failed"] }
        },
        data: {
          status: "pending",
          nextRunAt: new Date(),
          lockedAt: null,
          completedAt: null,
          attempts: 0,
          lastError: null
        }
      }),
      "节点连接撤销任务重试保存失败，请稍后重试。"
    );
    if (updated.count === 0) {
      throw new NotFoundException("该节点暂无可重试的连接撤销任务");
    }
    this.publishSyncQueueUpdatedBestEffort({ nodeId });
    return this.listLeaseRevocationJobsAfterRetry();
  }

  private async listLeaseRevocationJobsAfterRetry(): Promise<AdminLeaseRevocationJobDto[]> {
    try {
      return await this.listLeaseRevocationJobs();
    } catch (error) {
      const message = `Lease revocation retry was saved, but queue refresh failed: ${readAdminNodeErrorMessage(error)}`;
      this.logger.warn(message);
      return [];
    }
  }

  async updateNode(nodeId: string, input: UpdateNodeInputDto): Promise<AdminNodeRecordDto> {
    const current = await runAdminNodeLocalOperation(
      () => this.prisma.node.findUnique({ where: { id: nodeId } }),
      "节点信息读取失败，请稍后重试。"
    );
    if (!current) {
      throw new NotFoundException("节点不存在");
    }

    const nodeWillBeDisabled = current.isActive && input.isActive === false;
    const countryTouched = input.countryCode !== undefined || input.region !== undefined;
    const nextCountry = countryTouched
      ? resolveNodeCountry({
          countryCode: input.countryCode ?? current.countryCode,
          region: input.region ?? current.region,
          name: input.name?.trim() || current.name,
          host: current.serverHost
        })
      : null;

    // Connection parameters come from the agent's inbound report; enabling a
    // node still requires a deployed inbound.
    if ((input.isActive ?? current.isActive) && !isNodeOnboardingReady(current)) {
      throw new BadRequestException("节点尚未完成 Agent 注册或入站配置，不能启用。");
    }
    let row: any;
    try {
      row = await this.prisma.node.update({
        where: { id: current.id },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(nextCountry ? { countryCode: nextCountry.countryCode, region: nextCountry.region } : {}),
          ...(input.provider !== undefined ? { provider: input.provider.trim() } : {}),
          ...(input.tags !== undefined ? { tags: normalizeTags(input.tags, input.name?.trim() || current.name) } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          ...(input.recommended !== undefined ? { recommended: input.recommended } : {})
        }
      });
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "节点保存失败，请刷新节点列表后重试。");
    }

    if (nodeWillBeDisabled) {
      await this.tryRunAfterLocalNodeSave("queue node lease revocation after node disable", () =>
        this.runtimeSessionService.queueLeaseRevocationJobForNode(nodeId, "node_disabled")
      );
      // Disabling the node must also disable its bindings: getConfig does not
      // check node.isActive, so previously issued credentials would keep
      // working outside the managed client's lease handling.
      await this.tryRunAfterLocalNodeSave("queue binding disable after node disable", () =>
        this.runtimeSessionService.markPanelBindingsDisabledForNode(nodeId)
      );
    } else if (!current.isActive && input.isActive === true) {
      // Re-enabling must restore the bindings the disable path took down:
      // getConfig only serves ACTIVE bindings, so a config refresh alone
      // never brings the old credentials back.
      await this.tryRunAfterLocalNodeSave("queue direct access sync after node re-enable", () =>
        this.runtimeSessionService.syncDirectAccessForNode(nodeId)
      );
    }
    const shouldPublishNodeUpdated =
      (input.isActive !== undefined && current.isActive !== input.isActive) ||
      input.name !== undefined ||
      countryTouched ||
      input.provider !== undefined ||
      input.tags !== undefined ||
      input.recommended !== undefined;
    if (shouldPublishNodeUpdated) {
      await this.tryRunAfterLocalNodeSave("publish node access update after node update", () =>
        this.publishNodeAccessUpdatedForNode(nodeId)
      );
    }

    return toAdminNodeRecord(row);
  }

  async probeNode(nodeId: string): Promise<AdminNodeRecordDto> {
    const current = await runAdminNodeLocalOperation(
      () => this.prisma.node.findUnique({ where: { id: nodeId } }),
      "节点信息读取失败，请稍后重试。"
    );
    if (!current) {
      throw new NotFoundException("节点不存在");
    }

    return this.probeNodeWithRequestBudget(current);
  }

  private async probeNodeWithRequestBudget(current: any): Promise<AdminNodeRecordDto> {
    const probeTask = this.probeNodeUnchecked(current);
    void probeTask.catch((error) => {
      this.logger.warn(`Delayed node probe for ${current.id} failed: ${readAdminNodeErrorMessage(error)}`);
    });

    // Budget covers the WAITING window only: a slow or hung remote call is
    // abandoned to its owner instead of holding a self-update drain work item.
    return await workLifecycle.awaitWithBudgetElse(probeTask, readNodeProbeBudgetMs(), () =>
      this.markNodeProbeTimedOut(current, readNodeProbeBudgetMs())
    );
  }

  private async probeNodeUnchecked(current: any): Promise<AdminNodeRecordDto> {
    const result = await probeNodeConnectivity(current.serverHost, current.serverPort, current.serverName, current.subscriptionUrl);
    const checkedAt = new Date();
    const data = {
      probeStatus: result.status,
      probeLatencyMs: result.latencyMs,
      probeCheckedAt: checkedAt,
      probeError: result.error,
      latencyMs: result.latencyMs ?? current.latencyMs
    };
    let row: any;
    try {
      row = await this.prisma.node.update({
        where: { id: current.id },
        data
      });
    } catch (error) {
      this.logger?.warn(`Node ${current.id} probe result update failed: ${readAdminNodeErrorMessage(error)}`);
      row = {
        ...current,
        ...data,
        updatedAt: checkedAt
      };
    }

    return toAdminNodeRecord(row);
  }

  private markNodeProbeTimedOut(current: any, timeoutMs: number) {
    const checkedAt = new Date();
    // Timeout is not a confirmed outage; the background probe keeps going.
    this.logger.warn(
      `Node ${current.id} probe exceeded ${timeoutMs}ms; keeping previous result while probe continues in background.`
    );
    return toAdminNodeRecord({
      ...current,
      updatedAt: checkedAt
    });
  }

  async probeAllNodes(clock: AdminNodeProbeClock = SYSTEM_ADMIN_NODE_PROBE_CLOCK) {
    const nodes = await runAdminNodeLocalOperation(
      () => this.prisma.node.findMany({ orderBy: { createdAt: "desc" } }),
      "节点列表读取失败，请刷新后重试。"
    );
    const results = new Array<AdminNodeRecordDto>(nodes.length);
    let nextIndex = 0;
    const requestBudgetMs = readBulkNodeProbeRequestBudgetMs();
    const deadlineAt = clock.now() + requestBudgetMs;
    const workerCount = Math.min(nodes.length, readBulkNodeProbeConcurrency());
    const workers = Array.from({ length: workerCount }, async () => {
      while (nextIndex < nodes.length) {
        const remainingBudgetMs = deadlineAt - clock.now();
        if (remainingBudgetMs <= BULK_NODE_PROBE_START_GUARD_MS) {
          return;
        }
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await this.probeNodeForBulk(nodes[index], remainingBudgetMs);
      }
    });
    await workLifecycle.all(workers);
    const skippedNodes = nodes.filter((_node, index) => !results[index]);
    if (skippedNodes.length > 0) {
      const checkedAt = new Date();
      this.logger.warn(
        `Bulk node probe request budget ${requestBudgetMs}ms exhausted; ${skippedNodes.length} nodes were marked for retry.`
      );
      void workLifecycle.track(this.markBulkProbeSkippedNodes(skippedNodes, requestBudgetMs, checkedAt));
      for (const node of skippedNodes) {
        const index = nodes.findIndex((item) => item.id === node.id);
        results[index] = this.buildBulkProbeSkippedRecord(node, requestBudgetMs, checkedAt);
      }
    }
    return results;
  }

  private async probeNodeForBulk(node: Awaited<ReturnType<PrismaService["node"]["findMany"]>>[number], budgetMs?: number) {
    try {
      return await this.probeNodeWithBulkBudget(node.id, budgetMs);
    } catch (error) {
      this.logger.warn(`Node ${node.id} bulk probe failed; continuing with remaining nodes: ${readAdminNodeErrorMessage(error)}`);
      return toAdminNodeRecord({
        ...node,
        updatedAt: new Date()
      });
    }
  }

  private async probeNodeWithBulkBudget(nodeId: string, budgetMs = readBulkNodeProbeBudgetMs()) {
    const probeTask = this.probeNode(nodeId);
    void probeTask.catch((error) => {
      this.logger.warn(`Delayed bulk probe for node ${nodeId} failed: ${readAdminNodeErrorMessage(error)}`);
    });

    // Budget covers the WAITING window only: a slow or hung remote call is
    // abandoned to its owner instead of holding a self-update drain work item.
    return await workLifecycle.awaitWithBudget(
      probeTask,
      Math.max(1, Math.min(budgetMs, readBulkNodeProbeBudgetMs())),
      () => new Error(`bulk node probe exceeded ${budgetMs}ms`)
    );
  }

  private async markBulkProbeSkippedNodes(
    nodes: Awaited<ReturnType<PrismaService["node"]["findMany"]>>,
    requestBudgetMs: number,
    _checkedAt: Date
  ) {
    // Skipping due to bulk budget is not a confirmed outage; nothing changes.
    this.logger.warn(
      `Bulk node probe skipped ${nodes.length} nodes after ${requestBudgetMs}ms request budget.`
    );
  }

  private buildBulkProbeSkippedRecord(
    node: Awaited<ReturnType<PrismaService["node"]["findMany"]>>[number],
    requestBudgetMs: number,
    checkedAt: Date
  ) {
    return toAdminNodeRecord({
      ...node,
      probeError: `bulk node probe request budget ${requestBudgetMs}ms exhausted before this node was probed`,
      updatedAt: checkedAt
    });
  }


  async deleteNode(nodeId: string) {
    const current = await runAdminNodeLocalOperation(
      () => this.prisma.node.findUnique({ where: { id: nodeId } }),
      "节点信息读取失败，请稍后重试。"
    );
    if (!current) {
      throw new NotFoundException("节点不存在");
    }

    // Capture targets before hard delete removes node access rows.
    const userIds = await this.runAfterLocalNodeSaveWithBudget(
      "resolve node access event targets before node delete",
      [] as string[],
      () => this.clientEventsPublisher.resolveUserIdsForNodeAccess(nodeId)
    );

    // No panel to clean up remotely anymore: revoke live client leases, then
    // hard delete — per-node rows (bindings, agents, jobs, batches) cascade.
    await this.tryRunAfterLocalNodeSave("revoke local leases after node delete", () =>
      this.runtimeSessionService.revokeNodeLeases(nodeId, "node_deleted")
    );
    await this.tryRunAfterLocalNodeSave("queue lease revocation after node delete", () =>
      this.runtimeSessionService.queueLeaseRevocationJobForNode(nodeId, "node_deleted")
    );

    try {
      await this.prisma.node.delete({ where: { id: current.id } });
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "节点删除失败，请刷新节点列表后重试。");
    }

    this.publishAdminNodeAccessUpdatedBestEffort(nodeId);
    try {
      this.clientEventsPublisher.publishNodeAccessUpdatedToUsers(userIds, nodeId);
    } catch (error) {
      this.logger?.warn(
        `Node delete completed, but node access publish failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    for (const userId of userIds) {
      try {
        await this.clientEventsPublisher.publishSubscriptionUpdated({ userId });
      } catch (error) {
        this.logger?.warn(
          `Node delete completed, but subscription refresh publish failed for ${userId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    return { ok: true as const, deleted: true as const };
  }

  private async publishNodeAccessUpdatedForNode(nodeId: string) {
    this.publishAdminNodeAccessUpdatedBestEffort(nodeId);
    await this.clientEventsPublisher.publishNodeAccessUpdatedForNode(nodeId);
  }

  private publishAdminNodeAccessUpdatedBestEffort(nodeId: string) {
    if (!this.adminRuntimeEventsService) {
      return;
    }
    try {
      this.adminRuntimeEventsService.publish({
        type: "node_access_updated",
        occurredAt: new Date().toISOString(),
        nodeId
      });
    } catch (error) {
      this.logger?.warn(
        `Local node change saved, but admin node_access_updated publish failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private publishSyncQueueUpdatedBestEffort(input: { nodeId?: string | null }) {
    if (!this.adminRuntimeEventsService) {
      return;
    }
    try {
      this.adminRuntimeEventsService.publish({
        type: "sync_queue_updated",
        occurredAt: new Date().toISOString(),
        nodeId: input.nodeId ?? null
      });
    } catch (error) {
      this.logger?.warn(
        `Local sync queue change saved, but admin sync_queue_updated publish failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async runAfterLocalNodeSaveWithBudget<T>(label: string, timeoutResult: T, task: () => Promise<T>): Promise<T> {
    let settled = false;
    const guardedTask = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, NODE_AFTER_SAVE_DEFERRED_EFFECT_DELAY_MS);
      timer.unref?.();
    }).then(task).then(
      (result) => {
        settled = true;
        return result;
      },
      (error) => {
        settled = true;
        throw error;
      }
    );
    void guardedTask.catch((error) => {
      this.logger?.warn(
        `Local node change saved, but delayed ${label} failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutTask = new Promise<T>((resolve) => {
      timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        this.logger?.warn(
          `Local node change saved, but ${label} exceeded ${NODE_AFTER_SAVE_FOLLOW_UP_BUDGET_MS}ms and will continue in background.`
        );
        resolve(timeoutResult);
      }, NODE_AFTER_SAVE_FOLLOW_UP_BUDGET_MS);
    });

    try {
      return await Promise.race([workLifecycle.track(guardedTask), timeoutTask]);
    } catch (error) {
      this.logger?.warn(`Local node change saved, but ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
      return timeoutResult;
    } finally {
      if (settled && timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private async tryRunAfterLocalNodeSave(label: string, task: () => Promise<unknown>) {
    let settled = false;
    const guardedTask = Promise.resolve()
      .then(task)
      .then(
        () => {
          settled = true;
        },
        (error) => {
          settled = true;
          throw error;
        }
      );
    void guardedTask.catch((error) => {
      this.logger?.warn(
        `Local node change saved, but ${label} failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutTask = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(() => {
        if (!settled) {
          this.logger?.warn(
            `Local node change saved, but ${label} exceeded ${NODE_AFTER_SAVE_FOLLOW_UP_BUDGET_MS}ms and will continue in background.`
          );
        }
        resolve();
      }, NODE_AFTER_SAVE_FOLLOW_UP_BUDGET_MS);
      timeoutHandle.unref?.();
    });

    try {
      await Promise.race([workLifecycle.track(guardedTask), timeoutTask]);
    } catch {
      // The guarded task logs the failure; local node changes must remain committed.
    } finally {
      if (settled && timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

}

function readAdminNodeErrorMessage(error: unknown) {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : String(error);
}

async function runAdminNodeLocalOperation<T>(operation: () => Promise<T>, message: string): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throwLocalSaveAsServiceUnavailable(error, message);
  }
}

function readPositiveIntegerEnv(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readBulkNodeProbeBudgetMs() {
  return readPositiveIntegerEnv("CHORDV_BULK_NODE_PROBE_TIMEOUT_MS", DEFAULT_BULK_NODE_PROBE_BUDGET_MS);
}

function readBulkNodeProbeRequestBudgetMs() {
  return Math.min(
    readPositiveIntegerEnv("CHORDV_BULK_NODE_PROBE_REQUEST_TIMEOUT_MS", DEFAULT_BULK_NODE_PROBE_REQUEST_BUDGET_MS),
    MAX_BULK_NODE_PROBE_REQUEST_BUDGET_MS
  );
}




function readBulkNodeProbeConcurrency() {
  return readPositiveIntegerEnv("CHORDV_BULK_NODE_PROBE_CONCURRENCY", DEFAULT_BULK_NODE_PROBE_CONCURRENCY);
}

function readNodeProbeBudgetMs() {
  return readPositiveIntegerEnv("CHORDV_NODE_PROBE_TIMEOUT_MS", readBulkNodeProbeBudgetMs());
}

