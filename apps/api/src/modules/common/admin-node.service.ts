import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException
} from "@nestjs/common";
import type {
  AdminLeaseRevocationJobDto,
  AdminNodePanelInboundDto,
  AdminNodeRecordDto,
  AdminPanelSyncJobDto,
  ImportNodeInputDto,
  UpdateNodeInputDto
} from "@chordv/shared";
import { XuiService } from "../xui/xui.service";
import { PrismaService } from "./prisma.service";
import { RuntimeSessionService } from "./runtime-session.service";
import { ClientEventsPublisher } from "./client-events.publisher";
import { AdminRuntimeEventsService } from "./admin-runtime-events.service";
import { createId } from "./release-center.utils";
import { throwLocalSaveAsServiceUnavailable } from "./prisma-error.utils";
import {
  fetchSubscriptionNode,
  normalizePanelApiBasePath,
  normalizeTags,
  parseVlessLink,
  probeNodeConnectivity,
  readRuntimeInboundId,
  resolveNodeCountry,
  toAdminNodeRecord,
  toNodeId
} from "./node-import.utils";

const NODE_AFTER_SAVE_FOLLOW_UP_BUDGET_MS = 300;
const NODE_AFTER_SAVE_DEFERRED_EFFECT_DELAY_MS = 50;
const DEFAULT_IMPORT_NODE_RUNTIME_READ_BUDGET_MS = 5_000;
const DEFAULT_LIST_NODE_PANEL_INBOUNDS_BUDGET_MS = 5_000;
const DEFAULT_BULK_NODE_PROBE_BUDGET_MS = 5_000;
const DEFAULT_BULK_NODE_PROBE_REQUEST_BUDGET_MS = 45_000;
const MAX_BULK_NODE_PROBE_REQUEST_BUDGET_MS = 45_000;
const DEFAULT_BULK_NODE_PROBE_CONCURRENCY = 10;
const BULK_NODE_PROBE_START_GUARD_MS = 5;
const NODE_PANEL_SYNC_RECENT_ERROR_LIMIT = 500;
const NODE_PANEL_SYNC_PENDING_MESSAGE = "本地节点变更已保存，面板同步将在后台继续重试。";

@Injectable()
export class AdminNodeService {
  private readonly logger = new Logger(AdminNodeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly xuiService: XuiService,
    private readonly runtimeSessionService: RuntimeSessionService,
    private readonly clientEventsPublisher: ClientEventsPublisher,
    private readonly adminRuntimeEventsService?: AdminRuntimeEventsService
  ) {}

  async listAdminNodes(): Promise<AdminNodeRecordDto[]> {
    const rows = await runAdminNodeLocalOperation(
      () => this.prisma.node.findMany({
        orderBy: [{ recommended: "desc" }, { latencyMs: "asc" }, { createdAt: "desc" }]
      }),
      "节点列表读取失败，请刷新后重试。"
    );
    const { jobCounts, recentFailedJobs } = await this.readNodePanelSyncSummaryBestEffort();
    const summaryByNode = new Map<
      string,
      { pending: number; running: number; failed: number; lastError: string | null }
    >();
    for (const job of jobCounts) {
      const summary = summaryByNode.get(job.nodeId) ?? { pending: 0, running: 0, failed: 0, lastError: null };
      if (job.status === "failed") {
        summary.failed += job._count._all;
      } else if (job.status === "running") {
        summary.running += job._count._all;
      } else {
        summary.pending += job._count._all;
      }
      summaryByNode.set(job.nodeId, summary);
    }
    for (const job of recentFailedJobs) {
      const summary = summaryByNode.get(job.nodeId);
      if (!summary || summary.lastError) {
        continue;
      }
      summary.lastError = job.lastError ?? summary.lastError;
      summaryByNode.set(job.nodeId, summary);
    }

    return rows.map((row) => {
      const record = toAdminNodeRecord(row);
      const summary = summaryByNode.get(row.id);
      return {
        ...record,
        panelSyncTotalCount: summary ? summary.pending + summary.running + summary.failed : 0,
        panelSyncPendingCount: summary?.pending ?? 0,
        panelSyncRunningCount: summary?.running ?? 0,
        panelSyncFailedCount: summary?.failed ?? 0,
        panelSyncLastError: summary?.lastError ?? null
      };
    });
  }

  private async readNodePanelSyncSummaryBestEffort() {
    try {
      const [jobCounts, recentFailedJobs] = await Promise.all([
        this.prisma.panelSyncJob.groupBy({
          by: ["nodeId", "status"],
          where: {
            status: { in: ["pending", "running", "failed"] }
          },
          _count: { _all: true }
        }),
        this.prisma.panelSyncJob.findMany({
          where: {
            status: "failed",
            lastError: { not: null }
          },
          select: {
            nodeId: true,
            lastError: true,
            updatedAt: true
          },
          orderBy: [{ updatedAt: "desc" }],
          take: NODE_PANEL_SYNC_RECENT_ERROR_LIMIT
        })
      ]);
      return { jobCounts, recentFailedJobs };
    } catch (error) {
      this.logger.warn(`Node list loaded without panel sync summary: ${readAdminNodeErrorMessage(error)}`);
      return { jobCounts: [], recentFailedJobs: [] };
    }
  }

  async listPanelSyncJobs(): Promise<AdminPanelSyncJobDto[]> {
    const rows = await runAdminNodeLocalOperation(
      () => this.prisma.panelSyncJob.findMany({
        where: {
          status: { in: ["pending", "running", "failed"] }
        },
        include: {
          node: {
            select: {
              name: true
            }
          }
        },
        orderBy: [{ status: "asc" }, { nextRunAt: "asc" }, { createdAt: "desc" }],
        take: 200
      }),
      "面板同步队列读取失败，请刷新后重试。"
    );

    return rows.map((row) => ({
      id: row.id,
      action: row.action as AdminPanelSyncJobDto["action"],
      status: row.status as AdminPanelSyncJobDto["status"],
      nodeId: row.nodeId,
      subscriptionId: row.subscriptionId,
      userId: row.userId,
      teamId: row.teamId,
      nodeName: row.node?.name ?? "已删除节点",
      panelClientEmail: row.panelClientEmail,
      attempts: row.attempts,
      nextRunAt: row.nextRunAt.toISOString(),
      lockedAt: row.lockedAt?.toISOString() ?? null,
      lastError: row.lastError,
      completedAt: row.completedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString()
    }));
  }

  async retryPanelSyncJob(jobId: string): Promise<AdminPanelSyncJobDto[]> {
    const updated = await runAdminNodeLocalOperation(
      () => this.prisma.panelSyncJob.updateMany({
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
      "面板同步任务重试保存失败，请稍后重试。"
    );
    if (updated.count === 0) {
      throw new NotFoundException("面板同步任务不存在或已完成");
    }
    this.publishSyncQueueUpdatedBestEffort({});
    return this.listPanelSyncJobsAfterRetry();
  }

  async retryPanelSyncJobsForNode(nodeId: string): Promise<AdminPanelSyncJobDto[]> {
    const updated = await runAdminNodeLocalOperation(
      () => this.prisma.panelSyncJob.updateMany({
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
      "节点面板同步任务重试保存失败，请稍后重试。"
    );
    if (updated.count === 0) {
      throw new NotFoundException("该节点暂无可重试的面板同步任务");
    }
    this.publishSyncQueueUpdatedBestEffort({ nodeId });
    return this.listPanelSyncJobsAfterRetry();
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

  private async listPanelSyncJobsAfterRetry(): Promise<AdminPanelSyncJobDto[]> {
    try {
      return await this.listPanelSyncJobs();
    } catch (error) {
      const message = `Panel sync retry was saved, but queue refresh failed: ${readAdminNodeErrorMessage(error)}`;
      this.logger.warn(message);
      return [];
    }
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

  async importNodeFromSubscription(input: ImportNodeInputDto): Promise<AdminNodeRecordDto> {
    const panelBaseUrl = input.panelBaseUrl?.trim() || null;
    const panelUsername = input.panelUsername?.trim() || null;
    const panelPassword = input.panelPassword?.trim() || null;
    const panelEnabled = await this.resolveNodePanelEnabled({
      inputValue: input.panelEnabled,
      currentValue: null,
      panelBaseUrl,
      panelUsername,
      panelPassword,
      applyXuiDefault: true
    });
    const imported = await this.resolveNodeRuntimeSource(input, panelEnabled);
    const nodeId = toNodeId(imported.serverHost, imported.serverPort);
    const current = await runAdminNodeLocalOperation(
      () => this.prisma.node.findUnique({ where: { id: nodeId } }),
      "节点信息读取失败，请稍后重试。"
    );
    const nextPanelBaseUrl = panelBaseUrl ?? current?.panelBaseUrl ?? null;
    const nextPanelApiBasePath = normalizePanelApiBasePath(input.panelApiBasePath ?? current?.panelApiBasePath ?? "/");
    const nextPanelUsername = panelUsername ?? current?.panelUsername ?? null;
    const nextPanelPassword = panelPassword ?? current?.panelPassword ?? null;
    const resolvedInboundId = readRuntimeInboundId(imported);
    const nextPanelInboundId = input.panelInboundId ?? current?.panelInboundId ?? resolvedInboundId ?? null;
    const nextCountry = resolveNodeCountry({
      countryCode: input.countryCode,
      region: input.region,
      name: input.name?.trim() || imported.name,
      host: imported.serverHost
    });
    const nextPanelEnabled = await this.resolveNodePanelEnabled({
      inputValue: input.panelEnabled,
      currentValue: current?.panelEnabled ?? null,
      panelBaseUrl: nextPanelBaseUrl,
      panelUsername: nextPanelUsername,
      panelPassword: nextPanelPassword,
      applyXuiDefault: true
    });
    const panelConnectionChanged = Boolean(
      current?.panelEnabled &&
      nextPanelEnabled &&
      (
        nextPanelBaseUrl !== current.panelBaseUrl ||
        nextPanelApiBasePath !== current.panelApiBasePath ||
        nextPanelUsername !== current.panelUsername ||
        nextPanelPassword !== current.panelPassword ||
        nextPanelInboundId !== current.panelInboundId
      )
    );
    const panelWillBeDisabled = Boolean(current?.panelEnabled && !nextPanelEnabled);
    const nodeWillBeDisabled = Boolean(current?.isActive && input.isActive === false);

    let row: any;
    try {
      row = await this.prisma.node.upsert({
        where: { id: nodeId },
        create: {
          id: nodeId,
          name: input.name?.trim() || imported.name,
          countryCode: nextCountry.countryCode,
          region: nextCountry.region,
          provider: input.provider?.trim() || "自有节点",
          tags: normalizeTags(input.tags, imported.name),
          isActive: input.isActive ?? true,
          recommended: input.recommended ?? true,
          latencyMs: 0,
          protocol: "vless",
          security: "reality",
          serverHost: imported.serverHost,
          serverPort: imported.serverPort,
          uuid: imported.uuid,
          flow: imported.flow,
          realityPublicKey: imported.realityPublicKey,
          shortId: imported.shortId,
          serverName: imported.serverName,
          fingerprint: imported.fingerprint,
          spiderX: imported.spiderX,
          mldsa65Verify: imported.mldsa65Verify ?? "",
          subscriptionUrl: input.subscriptionUrl?.trim() || null,
          panelBaseUrl: nextPanelBaseUrl,
          panelApiBasePath: nextPanelApiBasePath,
          panelUsername: nextPanelUsername,
          panelPassword: nextPanelPassword,
          panelInboundId: nextPanelInboundId,
          panelEnabled: nextPanelEnabled,
          panelStatus: nextPanelEnabled ? current?.panelStatus ?? "offline" : "offline",
          panelError: nextPanelEnabled ? current?.panelError ?? null : null
        },
        update: {
          name: input.name?.trim() || imported.name,
          countryCode: nextCountry.countryCode,
          region: nextCountry.region,
          provider: input.provider?.trim() || "自有节点",
          tags: normalizeTags(input.tags, imported.name),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          recommended: input.recommended ?? true,
          latencyMs: 0,
          serverHost: imported.serverHost,
          serverPort: imported.serverPort,
          uuid: imported.uuid,
          flow: imported.flow,
          realityPublicKey: imported.realityPublicKey,
          shortId: imported.shortId,
          serverName: imported.serverName,
          fingerprint: imported.fingerprint,
          spiderX: imported.spiderX,
          mldsa65Verify: imported.mldsa65Verify ?? "",
          subscriptionUrl: input.subscriptionUrl?.trim() || null,
          panelBaseUrl: nextPanelBaseUrl,
          panelApiBasePath: nextPanelApiBasePath,
          panelUsername: nextPanelUsername,
          panelPassword: nextPanelPassword,
          panelInboundId: nextPanelInboundId,
          panelEnabled: nextPanelEnabled,
          ...(!nextPanelEnabled ? { panelStatus: "offline", panelError: null } : {})
        }
      });
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "节点导入保存失败，请刷新节点列表后重试。");
    }

    let panelSyncPending = false;
    if (current && panelConnectionChanged && !nodeWillBeDisabled) {
      panelSyncPending = true;
      await this.tryRunAfterLocalNodeSave("queue node lease revocation for panel config change", () =>
        this.runtimeSessionService.queueLeaseRevocationJobForNode(nodeId, "node_panel_config_changed")
      );
      await this.tryRunAfterLocalNodeSave("queue old panel binding deletion for panel config change", async () => {
        const result = await this.runtimeSessionService.removePanelBindingsForNode(nodeId, {
          panelBaseUrl: current.panelBaseUrl,
          panelApiBasePath: current.panelApiBasePath,
          panelUsername: current.panelUsername,
          panelPassword: current.panelPassword
        });
        if (result.failed.length > 0) {
          await this.runtimeSessionService.markPanelBindingsDeletedForNode(nodeId);
        }
      });
    }

    if (current && (panelWillBeDisabled || nodeWillBeDisabled)) {
      panelSyncPending = true;
      await this.tryRunAfterLocalNodeSave("queue node lease revocation after node disable", () =>
        this.runtimeSessionService.queueLeaseRevocationJobForNode(
          nodeId,
          nodeWillBeDisabled ? "node_disabled" : "node_panel_disabled"
        )
      );
      await this.tryRunAfterLocalNodeSave("queue panel disable after node disable", () =>
        this.runtimeSessionService.markPanelBindingsDisabledForNode(nodeId)
      );
    }

    const record = await this.probeNodeAfterLocalImport(row);
    if (current) {
      if (row.isActive && row.panelEnabled && (!current.panelEnabled || panelConnectionChanged || (!current.isActive && input.isActive === true))) {
        panelSyncPending = true;
        await this.tryRunAfterLocalNodeSave("queue panel access sync after node import", () =>
          this.runtimeSessionService.syncPanelAccessForNode(row.id)
        );
      }
      await this.tryRunAfterLocalNodeSave("publish node access update after node import", () =>
        this.publishNodeAccessUpdatedForNode(row.id)
      );
    }
    return panelSyncPending ? withNodePanelSyncPending(record) : record;
  }

  async listNodePanelInbounds(input: {
    panelBaseUrl: string;
    panelApiBasePath?: string;
    panelUsername: string;
    panelPassword: string;
  }): Promise<AdminNodePanelInboundDto[]> {
    const budgetMs = readListNodePanelInboundsBudgetMs();
    const inbounds = await this.readNodePanelInboundsWithBudget(
      this.xuiService.listInbounds({
        id: createId("panel"),
        panelBaseUrl: input.panelBaseUrl,
        panelApiBasePath: input.panelApiBasePath ?? "/",
        panelUsername: input.panelUsername,
        panelPassword: input.panelPassword,
        panelInboundId: null,
        panelRequestTimeoutMs: budgetMs,
        panelAbortSignal: AbortSignal.timeout(budgetMs)
      }, {
        forceRelogin: true,
        strictCredentialCheck: true
      })
    );

    return inbounds;
  }

  private async readNodePanelInboundsWithBudget(runtimeTask: Promise<AdminNodePanelInboundDto[]>) {
    let settled = false;
    const guardedTask = runtimeTask.then(
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
      this.logger?.warn(`Delayed 3x-ui inbound list read failed: ${readAdminNodeErrorMessage(error)}`);
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutTask = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        reject(
          new ServiceUnavailableException(
            `3x-ui inbound list read timed out after ${readListNodePanelInboundsBudgetMs()}ms; panel may be offline or too slow`
          )
        );
      }, readListNodePanelInboundsBudgetMs());
    });

    try {
      return await Promise.race([guardedTask, timeoutTask]);
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new ServiceUnavailableException(`3x-ui inbound list read failed: ${readAdminNodeErrorMessage(error)}`);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private async probeNodeAfterLocalImport(row: Parameters<typeof toAdminNodeRecord>[0]) {
    const fallbackRecord = toAdminNodeRecord(row);
    let settled = false;
    const probeTask = this.probeNode(row.id).then(
      (record) => {
        settled = true;
        return record;
      },
      (error) => {
        settled = true;
        throw error;
      }
    );
    void probeTask.catch((error) => {
      this.logger?.warn(
        `Local node import saved, but delayed initial probe failed for ${row.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutTask = new Promise<ReturnType<typeof toAdminNodeRecord>>((resolve) => {
      timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        this.logger?.warn(
          `Local node import saved, but initial probe exceeded ${NODE_AFTER_SAVE_FOLLOW_UP_BUDGET_MS}ms and will continue in background.`
        );
        resolve(fallbackRecord);
      }, NODE_AFTER_SAVE_FOLLOW_UP_BUDGET_MS);
    });

    try {
      return await Promise.race([probeTask, timeoutTask]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn(`Local node import saved, but initial probe failed for ${row.id}: ${message}`);
      return fallbackRecord;
    } finally {
      if (settled && timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
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

    const nextPanelBaseUrl = input.panelBaseUrl !== undefined ? input.panelBaseUrl?.trim() || null : current.panelBaseUrl;
    const nextPanelApiBasePath =
      input.panelApiBasePath !== undefined ? normalizePanelApiBasePath(input.panelApiBasePath) : current.panelApiBasePath;
    const nextPanelUsername = input.panelUsername !== undefined ? input.panelUsername?.trim() || null : current.panelUsername;
    const nextPanelPassword = input.panelPassword !== undefined ? input.panelPassword?.trim() || null : current.panelPassword;
    const nextPanelInboundId =
      input.panelInboundId !== undefined ? input.panelInboundId : current.panelInboundId;
    const nextPanelEnabled =
      input.panelEnabled !== undefined
        ? input.panelEnabled
        : await this.resolveNodePanelEnabled({
            inputValue: undefined,
            currentValue: current.panelEnabled,
            panelBaseUrl: nextPanelBaseUrl,
            panelUsername: nextPanelUsername,
            panelPassword: nextPanelPassword,
            applyXuiDefault: false
          });
    const panelConfigTouched =
      (input.panelBaseUrl !== undefined ? nextPanelBaseUrl !== current.panelBaseUrl : false) ||
      (input.panelApiBasePath !== undefined ? nextPanelApiBasePath !== current.panelApiBasePath : false) ||
      (input.panelUsername !== undefined ? nextPanelUsername !== current.panelUsername : false) ||
      (input.panelPassword !== undefined ? nextPanelPassword !== current.panelPassword : false) ||
      (input.panelInboundId !== undefined ? nextPanelInboundId !== current.panelInboundId : false) ||
      (input.panelEnabled !== undefined ? nextPanelEnabled !== current.panelEnabled : false);
    const panelConnectionChanged =
      current.panelEnabled &&
      nextPanelEnabled &&
      ((input.panelBaseUrl !== undefined ? nextPanelBaseUrl !== current.panelBaseUrl : false) ||
        (input.panelApiBasePath !== undefined ? nextPanelApiBasePath !== current.panelApiBasePath : false) ||
        (input.panelUsername !== undefined ? nextPanelUsername !== current.panelUsername : false) ||
        (input.panelPassword !== undefined ? nextPanelPassword !== current.panelPassword : false) ||
        (input.panelInboundId !== undefined ? nextPanelInboundId !== current.panelInboundId : false));
    const panelWillBeDisabled = current.panelEnabled && !nextPanelEnabled;
    const nodeWillBeDisabled = current.isActive && input.isActive === false;

    let derived: ReturnType<typeof parseVlessLink> | Awaited<ReturnType<XuiService["getInboundRuntime"]>> | null = null;
    let panelRuntimeError: string | null = null;
    const nextSubscriptionUrl = typeof input.subscriptionUrl === "string" ? input.subscriptionUrl.trim() : "";
    if (nextSubscriptionUrl) {
      const runtime = await this.readSubscriptionNodeForNodeSaveBestEffort(nextSubscriptionUrl);
      derived = runtime.derived;
      panelRuntimeError = runtime.errorMessage;
    } else if (nextPanelEnabled && panelConfigTouched) {
      const runtime = await this.readPanelRuntimeForNodeSaveBestEffort({
          id: current.id,
          panelBaseUrl: nextPanelBaseUrl,
          panelApiBasePath: nextPanelApiBasePath,
          panelUsername: nextPanelUsername,
          panelPassword: nextPanelPassword,
          panelInboundId: nextPanelInboundId
      });
      derived = runtime.derived;
      panelRuntimeError = runtime.errorMessage;
    }
    const derivedInboundId = readRuntimeInboundId(derived);
    const shouldPersistPanelEnabledByDefault = panelConfigTouched && input.panelEnabled === undefined && nextPanelEnabled !== current.panelEnabled;
    const shouldPersistDerivedInboundId = input.panelInboundId === undefined && derivedInboundId !== null;
    const countryTouched = input.countryCode !== undefined || input.region !== undefined;
    const nextCountry = countryTouched
      ? resolveNodeCountry({
          countryCode: input.countryCode ?? current.countryCode,
          region: input.region ?? current.region,
          name: input.name?.trim() || current.name,
          host: current.serverHost
        })
      : null;

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
          ...(input.recommended !== undefined ? { recommended: input.recommended } : {}),
          ...(input.subscriptionUrl !== undefined ? { subscriptionUrl: nextSubscriptionUrl || null } : {}),
          ...(input.panelBaseUrl !== undefined ? { panelBaseUrl: input.panelBaseUrl?.trim() || null } : {}),
          ...(input.panelApiBasePath !== undefined ? { panelApiBasePath: normalizePanelApiBasePath(input.panelApiBasePath) } : {}),
          ...(input.panelUsername !== undefined ? { panelUsername: input.panelUsername?.trim() || null } : {}),
          ...(input.panelPassword !== undefined ? { panelPassword: input.panelPassword?.trim() || null } : {}),
          ...(input.panelInboundId !== undefined
            ? { panelInboundId: input.panelInboundId }
            : shouldPersistDerivedInboundId
              ? { panelInboundId: derivedInboundId }
              : {}),
          ...(input.panelEnabled !== undefined
            ? { panelEnabled: input.panelEnabled }
            : shouldPersistPanelEnabledByDefault
              ? { panelEnabled: nextPanelEnabled }
              : {}),
          ...(input.isActive === false || !nextPanelEnabled ? { panelStatus: "offline", panelError: null } : {}),
          ...(panelRuntimeError ? { panelStatus: "degraded", panelError: panelRuntimeError } : {}),
          ...(derived
            ? {
                serverHost: derived.serverHost,
                serverPort: derived.serverPort,
                uuid: derived.uuid,
                flow: derived.flow,
                realityPublicKey: derived.realityPublicKey,
                shortId: derived.shortId,
                serverName: derived.serverName,
                fingerprint: derived.fingerprint,
                spiderX: derived.spiderX,
                mldsa65Verify: derived.mldsa65Verify ?? ""
              }
            : {})
        }
      });
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "节点保存失败，请刷新节点列表后重试。");
    }

    let panelSyncPending = false;
    if (panelConnectionChanged && !nodeWillBeDisabled) {
      panelSyncPending = true;
      await this.tryRunAfterLocalNodeSave("queue node lease revocation for panel config change", () =>
        this.runtimeSessionService.queueLeaseRevocationJobForNode(nodeId, "node_panel_config_changed")
      );
      await this.tryRunAfterLocalNodeSave("queue old panel binding deletion for panel config change", async () => {
        const result = await this.runtimeSessionService.removePanelBindingsForNode(nodeId, {
          panelBaseUrl: current.panelBaseUrl,
          panelApiBasePath: current.panelApiBasePath,
          panelUsername: current.panelUsername,
          panelPassword: current.panelPassword
        });
        if (result.failed.length > 0) {
          await this.runtimeSessionService.markPanelBindingsDeletedForNode(nodeId);
        }
      });
    }

    if ((current.isActive && input.isActive === false) || panelWillBeDisabled) {
      panelSyncPending = true;
      await this.tryRunAfterLocalNodeSave("queue node lease revocation after node disable", () =>
        this.runtimeSessionService.queueLeaseRevocationJobForNode(
          nodeId,
          nodeWillBeDisabled ? "node_disabled" : "node_panel_disabled"
        )
      );
      await this.tryRunAfterLocalNodeSave("queue panel disable after node disable", () =>
        this.runtimeSessionService.markPanelBindingsDisabledForNode(nodeId)
      );
    } else if (!current.isActive && input.isActive === true) {
      await this.tryRunAfterLocalNodeSave("clear pending panel disable jobs after node re-enable", () =>
        this.runtimeSessionService.clearPendingPanelDisableJobsForNode(nodeId)
      );
    }
    if (row.isActive && row.panelEnabled && (!current.panelEnabled || panelConnectionChanged || (!current.isActive && input.isActive === true))) {
      panelSyncPending = true;
      await this.tryRunAfterLocalNodeSave("queue panel access sync after node update", () =>
        this.runtimeSessionService.syncPanelAccessForNode(nodeId)
      );
    }
    const shouldPublishNodeUpdated =
      (input.isActive !== undefined && current.isActive !== input.isActive) ||
      input.name !== undefined ||
      countryTouched ||
      input.provider !== undefined ||
      input.tags !== undefined ||
      input.recommended !== undefined ||
      input.subscriptionUrl !== undefined ||
      panelConfigTouched ||
      Boolean(derived);
    if (shouldPublishNodeUpdated) {
      await this.tryRunAfterLocalNodeSave("publish node access update after node update", () =>
        this.publishNodeAccessUpdatedForNode(nodeId)
      );
    }

    const record = toAdminNodeRecord(row);
    return panelSyncPending ? withNodePanelSyncPending(record) : record;
  }

  private async readSubscriptionNodeForNodeSaveBestEffort(subscriptionUrl: string): Promise<{
    derived: ReturnType<typeof parseVlessLink> | null;
    errorMessage: string | null;
  }> {
    let settled = false;
    const runtimeTask = fetchSubscriptionNode(subscriptionUrl).then(
      (derived) => {
        settled = true;
        return { derived, errorMessage: null };
      },
      (error) => {
        settled = true;
        throw error;
      }
    );
    void runtimeTask.catch((error) => {
      this.logger?.warn(
        `Local node subscription URL will be saved, but delayed subscription runtime read failed: ${readAdminNodeErrorMessage(error)}`
      );
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutTask = new Promise<{ derived: null; errorMessage: string }>((resolve) => {
      timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        const message = "subscription runtime read is still running in background";
        this.logger?.warn(
          `Local node subscription URL will be saved, but reading subscription runtime exceeded ${NODE_AFTER_SAVE_FOLLOW_UP_BUDGET_MS}ms and will continue in background.`
        );
        resolve({ derived: null, errorMessage: message });
      }, NODE_AFTER_SAVE_FOLLOW_UP_BUDGET_MS);
    });

    try {
      return await Promise.race([runtimeTask, timeoutTask]);
    } catch (error) {
      const errorMessage = readAdminNodeErrorMessage(error);
      this.logger?.warn(`Local node subscription URL will be saved, but reading subscription runtime failed: ${errorMessage}`);
      return { derived: null, errorMessage };
    } finally {
      if (settled && timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  async refreshNode(nodeId: string): Promise<AdminNodeRecordDto> {
    const current = await runAdminNodeLocalOperation(
      () => this.prisma.node.findUnique({ where: { id: nodeId } }),
      "节点信息读取失败，请稍后重试。"
    );
    if (!current) {
      throw new NotFoundException("节点不存在");
    }
    if (!current.panelEnabled && !current.subscriptionUrl) {
      throw new BadRequestException("当前节点没有订阅地址");
    }
    let derived: ReturnType<typeof parseVlessLink> | Awaited<ReturnType<XuiService["getInboundRuntime"]>>;
    try {
      if (current.panelEnabled) {
        const runtime = await this.readPanelRuntimeForNodeSaveBestEffort({
          id: current.id,
          panelBaseUrl: current.panelBaseUrl,
          panelApiBasePath: current.panelApiBasePath,
          panelUsername: current.panelUsername,
          panelPassword: current.panelPassword,
          panelInboundId: current.panelInboundId
        });
        if (!runtime.derived) {
          return this.markNodeRuntimeRefreshDegraded(current, runtime.errorMessage ?? "panel runtime refresh is still running in background");
        }
        derived = runtime.derived;
      } else {
        const runtime = await this.readSubscriptionNodeForNodeSaveBestEffort(current.subscriptionUrl!);
        if (!runtime.derived) {
          return this.markNodeRuntimeRefreshDegraded(
            current,
            runtime.errorMessage ?? "subscription runtime refresh is still running in background"
          );
        }
        derived = runtime.derived;
      }
    } catch (error) {
      return this.markNodeRuntimeRefreshDegraded(current, readAdminNodeErrorMessage(error));
    }
    let row: any;
    try {
      row = await this.prisma.node.update({
        where: { id: nodeId },
        data: {
          serverHost: derived.serverHost,
          serverPort: derived.serverPort,
          uuid: derived.uuid,
          flow: derived.flow,
          realityPublicKey: derived.realityPublicKey,
          shortId: derived.shortId,
          serverName: derived.serverName,
          fingerprint: derived.fingerprint,
          spiderX: derived.spiderX,
          mldsa65Verify: derived.mldsa65Verify ?? ""
        }
      });
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "节点刷新结果保存失败，请稍后重试。");
    }

    await this.tryRunAfterLocalNodeSave("publish node access update after node refresh", () =>
      this.publishNodeAccessUpdatedForNode(nodeId)
    );
    return toAdminNodeRecord(row);
  }

  private async markNodeRuntimeRefreshDegraded(current: any, errorMessage: string): Promise<AdminNodeRecordDto> {
    const checkedAt = new Date();
    const message = errorMessage || "node runtime refresh failed";
    this.logger?.warn(`Node ${current.id} runtime refresh failed; keeping local runtime unchanged: ${message}`);
    try {
      const row = await this.prisma.node.update({
        where: { id: current.id },
        data: {
          panelStatus: "degraded",
          panelError: message
        }
      });
      return toAdminNodeRecord(row);
    } catch (error) {
      this.logger?.warn(`Node ${current.id} runtime refresh fallback update failed: ${readAdminNodeErrorMessage(error)}`);
      return toAdminNodeRecord({
        ...current,
        panelStatus: "degraded",
        panelError: message,
        updatedAt: checkedAt
      });
    }
  }

  private async readPanelRuntimeForNodeSaveBestEffort(input: {
    id: string;
    panelBaseUrl: string | null;
    panelApiBasePath: string | null;
    panelUsername: string | null;
    panelPassword: string | null;
    panelInboundId: number | null;
  }): Promise<{
    derived: Awaited<ReturnType<XuiService["getInboundRuntime"]>> | null;
    errorMessage: string | null;
  }> {
    const budgetMs = NODE_AFTER_SAVE_FOLLOW_UP_BUDGET_MS;
    let settled = false;
    const runtimeTask = this.xuiService.getInboundRuntime({
      ...input,
      panelRequestTimeoutMs: budgetMs,
      panelAbortSignal: AbortSignal.timeout(budgetMs)
    }).then(
      (derived) => {
        settled = true;
        return { derived, errorMessage: null };
      },
      (error) => {
        settled = true;
        throw error;
      }
    );
    void runtimeTask.catch((error) => {
      this.logger?.warn(
        `Local node panel config will be saved, but delayed panel runtime read failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutTask = new Promise<{ derived: null; errorMessage: string }>((resolve) => {
      timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        const message = "panel runtime read is still running in background";
        this.logger?.warn(
          `Local node panel config will be saved, but reading new panel runtime exceeded ${NODE_AFTER_SAVE_FOLLOW_UP_BUDGET_MS}ms and will continue in background.`
        );
        resolve({ derived: null, errorMessage: message });
      }, NODE_AFTER_SAVE_FOLLOW_UP_BUDGET_MS);
    });

    try {
      return await Promise.race([runtimeTask, timeoutTask]);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger?.warn(`Local node panel config will be saved, but reading new panel runtime failed: ${errorMessage}`);
      return { derived: null, errorMessage };
    } finally {
      if (settled && timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
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
    let settled = false;
    const probeTask = this.probeNodeUnchecked(current).then(
      (result) => {
        settled = true;
        return result;
      },
      (error) => {
        settled = true;
        throw error;
      }
    );
    void probeTask.catch((error) => {
      this.logger.warn(`Delayed node probe for ${current.id} failed: ${readAdminNodeErrorMessage(error)}`);
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutTask = new Promise<AdminNodeRecordDto>((resolve) => {
      timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        resolve(this.markNodeProbeTimedOut(current, readNodeProbeBudgetMs()));
      }, readNodeProbeBudgetMs());
    });

    try {
      return await Promise.race([probeTask, timeoutTask]);
    } finally {
      if (settled && timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private async probeNodeUnchecked(current: any): Promise<AdminNodeRecordDto> {
    const result = await probeNodeConnectivity(current.serverHost, current.serverPort, current.serverName, current.subscriptionUrl);
    let panelStatus = current.panelStatus;
    let panelError = current.panelError;
    let panelLastSyncedAt = current.panelLastSyncedAt;
    if (!current.isActive || !current.panelEnabled) {
      panelStatus = "offline";
      panelError = null;
    } else if (current.panelEnabled) {
      try {
        const panelProbeBudgetMs = readNodeProbeBudgetMs();
        await this.xuiService.checkNodeHealth({
          id: current.id,
          panelBaseUrl: current.panelBaseUrl,
          panelApiBasePath: current.panelApiBasePath,
          panelUsername: current.panelUsername,
          panelPassword: current.panelPassword,
          panelInboundId: current.panelInboundId,
          panelRequestTimeoutMs: panelProbeBudgetMs,
          panelAbortSignal: AbortSignal.timeout(panelProbeBudgetMs)
        });
        panelStatus = "online";
        panelError = null;
        panelLastSyncedAt = new Date();
      } catch (error) {
        panelStatus = "degraded";
        panelError = error instanceof Error ? error.message : "3x-ui 面板探测失败";
      }
    }
    const checkedAt = new Date();
    const data = {
      probeStatus: result.status,
      probeLatencyMs: result.latencyMs,
      probeCheckedAt: checkedAt,
      probeError: result.error,
      latencyMs: result.latencyMs ?? current.latencyMs,
      panelStatus,
      panelError,
      panelLastSyncedAt
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
    const message = `node probe exceeded ${timeoutMs}ms`;
    const fallbackStatus = current.isActive && current.panelEnabled ? "degraded" : "offline";
    this.logger.warn(`Node ${current.id} probe exceeded ${timeoutMs}ms and will continue in background.`);
    void this.prisma.node.update({
        where: { id: current.id },
        data: {
          panelStatus: fallbackStatus,
          panelError: fallbackStatus === "degraded" ? message : null
        }
      })
      .catch((error) => {
        this.logger.warn(`Node ${current.id} probe timeout fallback update failed: ${readAdminNodeErrorMessage(error)}`);
      });
    return toAdminNodeRecord({
      ...current,
      panelStatus: fallbackStatus,
      panelError: fallbackStatus === "degraded" ? message : null,
      updatedAt: checkedAt
    });
  }

  async probeAllNodes() {
    const nodes = await runAdminNodeLocalOperation(
      () => this.prisma.node.findMany({ orderBy: { createdAt: "desc" } }),
      "节点列表读取失败，请刷新后重试。"
    );
    const results = new Array<AdminNodeRecordDto>(nodes.length);
    let nextIndex = 0;
    const requestBudgetMs = readBulkNodeProbeRequestBudgetMs();
    const deadlineAt = Date.now() + requestBudgetMs;
    const workerCount = Math.min(nodes.length, readBulkNodeProbeConcurrency());
    const workers = Array.from({ length: workerCount }, async () => {
      while (nextIndex < nodes.length) {
        const remainingBudgetMs = deadlineAt - Date.now();
        if (remainingBudgetMs <= BULK_NODE_PROBE_START_GUARD_MS) {
          return;
        }
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await this.probeNodeForBulk(nodes[index], remainingBudgetMs);
      }
    });
    await Promise.all(workers);
    const skippedNodes = nodes.filter((_node, index) => !results[index]);
    if (skippedNodes.length > 0) {
      const checkedAt = new Date();
      this.logger.warn(
        `Bulk node probe request budget ${requestBudgetMs}ms exhausted; ${skippedNodes.length} nodes were marked for retry.`
      );
      void this.markBulkProbeSkippedNodes(skippedNodes, requestBudgetMs, checkedAt);
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
      const message = readAdminNodeErrorMessage(error);
      this.logger.warn(`Node ${node.id} bulk probe failed; continuing with remaining nodes: ${message}`);
      const checkedAt = new Date();
      const fallbackStatus = node.isActive && node.panelEnabled ? "degraded" : "offline";
      try {
        const row = await this.prisma.node.update({
          where: { id: node.id },
          data: {
            panelStatus: fallbackStatus,
            panelError: fallbackStatus === "degraded" ? message : null
          }
        });
        return toAdminNodeRecord(row);
      } catch (updateError) {
        this.logger.warn(`Node ${node.id} bulk probe fallback update failed: ${readAdminNodeErrorMessage(updateError)}`);
        return toAdminNodeRecord({
          ...node,
          panelStatus: fallbackStatus,
          panelError: fallbackStatus === "degraded" ? message : null,
          updatedAt: checkedAt
        });
      }
    }
  }

  private async probeNodeWithBulkBudget(nodeId: string, budgetMs = readBulkNodeProbeBudgetMs()) {
    let settled = false;
    const probeTask = this.probeNode(nodeId).then(
      (result) => {
        settled = true;
        return result;
      },
      (error) => {
        settled = true;
        throw error;
      }
    );
    void probeTask.catch((error) => {
      this.logger.warn(`Delayed bulk probe for node ${nodeId} failed: ${readAdminNodeErrorMessage(error)}`);
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutTask = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        reject(new Error(`bulk node probe exceeded ${budgetMs}ms`));
      }, Math.max(1, Math.min(budgetMs, readBulkNodeProbeBudgetMs())));
    });

    try {
      return await Promise.race([probeTask, timeoutTask]);
    } finally {
      if (settled && timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private async markBulkProbeSkippedNodes(
    nodes: Awaited<ReturnType<PrismaService["node"]["findMany"]>>,
    requestBudgetMs: number,
    checkedAt: Date
  ) {
    const groups = [
      {
        ids: nodes.filter((node) => node.isActive && node.panelEnabled).map((node) => node.id),
        panelStatus: "degraded" as const
      },
      {
        ids: nodes.filter((node) => !(node.isActive && node.panelEnabled)).map((node) => node.id),
        panelStatus: "offline" as const
      }
    ];
    await Promise.all(
      groups
        .filter((group) => group.ids.length > 0)
        .map((group) =>
          this.prisma.node
            .updateMany({
              where: { id: { in: group.ids } },
              data: {
                panelStatus: group.panelStatus,
                panelError:
                  group.panelStatus === "degraded"
                    ? `bulk node probe request budget ${requestBudgetMs}ms exhausted before this node was probed`
                    : null
              }
            })
            .catch((error) => {
              this.logger.warn(`Bulk probe skipped-node fallback update failed: ${readAdminNodeErrorMessage(error)}`);
            })
        )
    );
  }

  private buildBulkProbeSkippedRecord(
    node: Awaited<ReturnType<PrismaService["node"]["findMany"]>>[number],
    requestBudgetMs: number,
    checkedAt: Date
  ) {
    const message = `bulk node probe request budget ${requestBudgetMs}ms exhausted before this node was probed`;
    const panelStatus = node.isActive && node.panelEnabled ? "degraded" : "offline";
    return toAdminNodeRecord({
      ...node,
      panelStatus,
      panelError: panelStatus === "degraded" ? message : null,
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

    try {
      await this.prisma.node.update({
        where: { id: current.id },
        data: {
          isActive: false,
          recommended: false,
          panelStatus: "offline",
          panelError: null
        }
      });
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "节点删除保存失败，请刷新节点列表后重试。");
    }
    await this.tryRunAfterLocalNodeSave("queue lease revocation after node delete", () =>
      this.runtimeSessionService.queueLeaseRevocationJobForNode(nodeId, "node_deleted")
    );
    await this.tryRunAfterLocalNodeSave("queue panel binding deletion after node delete", async () => {
      const result = await this.runtimeSessionService.removePanelBindingsForNode(nodeId);
      if (result.failed.length > 0) {
        await this.runtimeSessionService.markPanelBindingsDeletedForNode(nodeId);
      }
    });
    const userIds = await this.runAfterLocalNodeSaveWithBudget(
      "resolve node access event targets after node delete",
      [] as string[],
      () => this.clientEventsPublisher.resolveUserIdsForNodeAccess(nodeId)
    );
    this.publishAdminNodeAccessUpdatedBestEffort(nodeId);
    try {
      this.clientEventsPublisher.publishNodeAccessUpdatedToUsers(userIds, nodeId);
    } catch (error) {
      this.logger?.warn(`Local node delete saved, but node access publish failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      ok: true,
      panelSyncStatus: "pending" as const,
      panelSyncMessage: NODE_PANEL_SYNC_PENDING_MESSAGE,
      message: NODE_PANEL_SYNC_PENDING_MESSAGE
    };
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
      return await Promise.race([guardedTask, timeoutTask]);
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
      await Promise.race([guardedTask, timeoutTask]);
    } catch {
      // The guarded task logs the failure; local node changes must remain committed.
    } finally {
      if (settled && timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private async resolveNodeRuntimeSource(input: ImportNodeInputDto, panelEnabled: boolean) {
    if (input.subscriptionUrl?.trim()) {
      return this.readImportRuntimeWithBudget(
        fetchSubscriptionNode(input.subscriptionUrl.trim()),
        "subscription runtime read"
      );
    }

    if (panelEnabled && input.panelBaseUrl && input.panelUsername && input.panelPassword) {
      const budgetMs = readImportNodeRuntimeBudgetMs();
      return this.readImportRuntimeWithBudget(
        this.xuiService.getInboundRuntime({
          id: createId("panel_runtime"),
          panelBaseUrl: input.panelBaseUrl,
          panelApiBasePath: input.panelApiBasePath ?? "/",
          panelUsername: input.panelUsername,
          panelPassword: input.panelPassword,
          panelInboundId: input.panelInboundId ?? null,
          panelRequestTimeoutMs: budgetMs,
          panelAbortSignal: AbortSignal.timeout(budgetMs)
        }),
        "3x-ui panel runtime read"
      );
    }

    throw new BadRequestException("请填写订阅地址，或完整配置 3x-ui 面板账号后读取入站并添加面板");
  }

  private async readImportRuntimeWithBudget<T>(runtimeTask: Promise<T>, label: string): Promise<T> {
    let settled = false;
    const guardedTask = runtimeTask.then(
      (result) => {
        settled = true;
        return result;
      },
      (error) => {
        settled = true;
        if (error instanceof HttpException) {
          throw error;
        }
        throw new ServiceUnavailableException(
          `${label} failed before local node import was saved: ${readAdminNodeErrorMessage(error)}`
        );
      }
    );
    void guardedTask.catch((error) => {
      this.logger?.warn(
        `Local node import failed before save because ${label} failed: ${readAdminNodeErrorMessage(error)}`
      );
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutTask = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        reject(
          new BadRequestException(
            `${label} timed out before local node import was saved; import failed and no node was saved`
          )
        );
      }, readImportNodeRuntimeBudgetMs());
    });

    try {
      return await Promise.race([guardedTask, timeoutTask]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private async resolveNodePanelEnabled(input: {
    inputValue?: boolean;
    currentValue: boolean | null;
    panelBaseUrl: string | null;
    panelUsername: string | null;
    panelPassword: string | null;
    applyXuiDefault: boolean;
  }) {
    if (input.inputValue !== undefined) {
      return input.inputValue;
    }
    if (!input.applyXuiDefault) {
      return input.currentValue ?? false;
    }

    const hasPanelConfig = Boolean(input.panelBaseUrl && input.panelUsername && input.panelPassword);
    if (!hasPanelConfig) {
      return input.currentValue ?? false;
    }

    return true;
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

function withNodePanelSyncPending(record: AdminNodeRecordDto): AdminNodeRecordDto {
  return {
    ...record,
    panelSyncStatus: "pending",
    panelSyncMessage: NODE_PANEL_SYNC_PENDING_MESSAGE,
    message: NODE_PANEL_SYNC_PENDING_MESSAGE
  };
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

function readImportNodeRuntimeBudgetMs() {
  return readPositiveIntegerEnv("CHORDV_IMPORT_NODE_RUNTIME_READ_TIMEOUT_MS", DEFAULT_IMPORT_NODE_RUNTIME_READ_BUDGET_MS);
}

function readListNodePanelInboundsBudgetMs() {
  return readPositiveIntegerEnv("CHORDV_LIST_NODE_PANEL_INBOUNDS_TIMEOUT_MS", DEFAULT_LIST_NODE_PANEL_INBOUNDS_BUDGET_MS);
}

function readBulkNodeProbeConcurrency() {
  return readPositiveIntegerEnv("CHORDV_BULK_NODE_PROBE_CONCURRENCY", DEFAULT_BULK_NODE_PROBE_CONCURRENCY);
}

function readNodeProbeBudgetMs() {
  return readPositiveIntegerEnv("CHORDV_NODE_PROBE_TIMEOUT_MS", readBulkNodeProbeBudgetMs());
}
