import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type {
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
import { createId } from "./release-center.utils";
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
const DEFAULT_BULK_NODE_PROBE_CONCURRENCY = 10;
const NODE_PANEL_SYNC_PENDING_MESSAGE = "本地节点变更已保存，面板同步将在后台继续重试。";

@Injectable()
export class AdminNodeService {
  private readonly logger = new Logger(AdminNodeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly xuiService: XuiService,
    private readonly runtimeSessionService: RuntimeSessionService,
    private readonly clientEventsPublisher: ClientEventsPublisher
  ) {}

  async listAdminNodes(): Promise<AdminNodeRecordDto[]> {
    const rows = await this.prisma.node.findMany({
      orderBy: [{ recommended: "desc" }, { latencyMs: "asc" }, { createdAt: "desc" }]
    });
    const jobs = await this.prisma.panelSyncJob.findMany({
      where: {
        status: { in: ["pending", "running", "failed"] }
      },
      select: {
        nodeId: true,
        status: true,
        lastError: true,
        updatedAt: true
      },
      orderBy: [{ updatedAt: "desc" }]
    });
    const summaryByNode = new Map<
      string,
      { pending: number; running: number; failed: number; lastError: string | null }
    >();
    for (const job of jobs) {
      const summary = summaryByNode.get(job.nodeId) ?? { pending: 0, running: 0, failed: 0, lastError: null };
      if (job.status === "failed") {
        summary.failed += 1;
      } else if (job.status === "running") {
        summary.running += 1;
      } else {
        summary.pending += 1;
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

  async listPanelSyncJobs(): Promise<AdminPanelSyncJobDto[]> {
    const rows = await this.prisma.panelSyncJob.findMany({
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
    });

    return rows.map((row) => ({
      id: row.id,
      action: row.action as AdminPanelSyncJobDto["action"],
      status: row.status as AdminPanelSyncJobDto["status"],
      nodeId: row.nodeId,
      nodeName: row.node.name,
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
    const updated = await this.prisma.panelSyncJob.updateMany({
      where: {
        id: jobId,
        status: { in: ["pending", "failed"] }
      },
      data: {
        status: "pending",
        nextRunAt: new Date(),
        lockedAt: null,
        completedAt: null,
        lastError: null
      }
    });
    if (updated.count === 0) {
      throw new NotFoundException("面板同步任务不存在或已完成");
    }
    return this.listPanelSyncJobs();
  }

  async retryPanelSyncJobsForNode(nodeId: string): Promise<AdminPanelSyncJobDto[]> {
    const updated = await this.prisma.panelSyncJob.updateMany({
      where: {
        nodeId,
        status: { in: ["pending", "failed"] }
      },
      data: {
        status: "pending",
        nextRunAt: new Date(),
        lockedAt: null,
        completedAt: null,
        lastError: null
      }
    });
    if (updated.count === 0) {
      throw new NotFoundException("该节点暂无可重试的面板同步任务");
    }
    return this.listPanelSyncJobs();
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
    const current = await this.prisma.node.findUnique({ where: { id: nodeId } });
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

    const row = await this.prisma.node.upsert({
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

    let panelSyncPending = false;
    if (current && panelConnectionChanged && !nodeWillBeDisabled) {
      panelSyncPending = true;
      await this.tryRunAfterLocalNodeSave("revoke node leases for panel config change", () =>
        this.runtimeSessionService.revokeNodeLeases(nodeId, "node_panel_config_changed")
      );
      await this.tryRunAfterLocalNodeSave("queue old panel binding deletion for panel config change", async () => {
        const result = await this.runtimeSessionService.removePanelBindingsForNode(nodeId);
        if (result.failed.length > 0) {
          await this.runtimeSessionService.markPanelBindingsDeletedForNode(nodeId);
        }
      });
    }

    if (current && (panelWillBeDisabled || nodeWillBeDisabled)) {
      panelSyncPending = true;
      await this.tryRunAfterLocalNodeSave("revoke node leases after node disable", () =>
        this.runtimeSessionService.revokeNodeLeases(
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
        this.clientEventsPublisher.publishNodeAccessUpdatedForNode(row.id)
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
    const inbounds = await this.readNodePanelInboundsWithBudget(
      this.xuiService.listInbounds({
        id: createId("panel"),
        panelBaseUrl: input.panelBaseUrl,
        panelApiBasePath: input.panelApiBasePath ?? "/",
        panelUsername: input.panelUsername,
        panelPassword: input.panelPassword,
        panelInboundId: null
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
          new BadRequestException(
            `3x-ui inbound list read timed out after ${readListNodePanelInboundsBudgetMs()}ms; panel may be offline or too slow`
          )
        );
      }, readListNodePanelInboundsBudgetMs());
    });

    try {
      return await Promise.race([guardedTask, timeoutTask]);
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
    const current = await this.prisma.node.findUnique({ where: { id: nodeId } });
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
    if (input.subscriptionUrl !== undefined && input.subscriptionUrl.trim()) {
      const runtime = await this.readSubscriptionNodeForNodeSaveBestEffort(input.subscriptionUrl.trim());
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

    const row = await this.prisma.node.update({
      where: { id: current.id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(nextCountry ? { countryCode: nextCountry.countryCode, region: nextCountry.region } : {}),
        ...(input.provider !== undefined ? { provider: input.provider.trim() } : {}),
        ...(input.tags !== undefined ? { tags: normalizeTags(input.tags, input.name?.trim() || current.name) } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.recommended !== undefined ? { recommended: input.recommended } : {}),
        ...(input.subscriptionUrl !== undefined ? { subscriptionUrl: input.subscriptionUrl?.trim() || null } : {}),
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

    let panelSyncPending = false;
    if (panelConnectionChanged && !nodeWillBeDisabled) {
      panelSyncPending = true;
      await this.tryRunAfterLocalNodeSave("revoke node leases for panel config change", () =>
        this.runtimeSessionService.revokeNodeLeases(nodeId, "node_panel_config_changed")
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
      await this.tryRunAfterLocalNodeSave("revoke node leases after node disable", () =>
        this.runtimeSessionService.revokeNodeLeases(
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
        this.clientEventsPublisher.publishNodeAccessUpdatedForNode(nodeId)
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
    const current = await this.prisma.node.findUnique({ where: { id: nodeId } });
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
    const row = await this.prisma.node.update({
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

    await this.tryRunAfterLocalNodeSave("publish node access update after node refresh", () =>
      this.clientEventsPublisher.publishNodeAccessUpdatedForNode(nodeId)
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
    let settled = false;
    const runtimeTask = this.xuiService.getInboundRuntime(input).then(
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
    const current = await this.prisma.node.findUnique({ where: { id: nodeId } });
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
        await this.xuiService.checkNodeHealth({
          id: current.id,
          panelBaseUrl: current.panelBaseUrl,
          panelApiBasePath: current.panelApiBasePath,
          panelUsername: current.panelUsername,
          panelPassword: current.panelPassword,
          panelInboundId: current.panelInboundId
        });
        panelStatus = "online";
        panelError = null;
        panelLastSyncedAt = new Date();
      } catch (error) {
        panelStatus = "degraded";
        panelError = error instanceof Error ? error.message : "3x-ui 面板探测失败";
      }
    }
    const row = await this.prisma.node.update({
      where: { id: current.id },
      data: {
        probeStatus: result.status,
        probeLatencyMs: result.latencyMs,
        probeCheckedAt: new Date(),
        probeError: result.error,
        latencyMs: result.latencyMs ?? current.latencyMs,
        panelStatus,
        panelError,
        panelLastSyncedAt
      }
    });

    return toAdminNodeRecord(row);
  }

  private async markNodeProbeTimedOut(current: any, timeoutMs: number) {
    const checkedAt = new Date();
    const message = `node probe exceeded ${timeoutMs}ms`;
    const fallbackStatus = current.isActive && current.panelEnabled ? "degraded" : "offline";
    this.logger.warn(`Node ${current.id} probe exceeded ${timeoutMs}ms and will continue in background.`);
    try {
      const row = await this.prisma.node.update({
        where: { id: current.id },
        data: {
          probeStatus: "offline",
          probeLatencyMs: null,
          probeCheckedAt: checkedAt,
          probeError: message,
          panelStatus: fallbackStatus,
          panelError: fallbackStatus === "degraded" ? message : null
        }
      });
      return toAdminNodeRecord(row);
    } catch (error) {
      this.logger.warn(`Node ${current.id} probe timeout fallback update failed: ${readAdminNodeErrorMessage(error)}`);
      return toAdminNodeRecord({
        ...current,
        probeStatus: "offline",
        probeLatencyMs: null,
        probeCheckedAt: checkedAt,
        probeError: message,
        panelStatus: fallbackStatus,
        panelError: fallbackStatus === "degraded" ? message : null,
        updatedAt: checkedAt
      });
    }
  }

  async probeAllNodes() {
    const nodes = await this.prisma.node.findMany({ orderBy: { createdAt: "desc" } });
    const results = new Array<AdminNodeRecordDto>(nodes.length);
    let nextIndex = 0;
    const workerCount = Math.min(nodes.length, readBulkNodeProbeConcurrency());
    const workers = Array.from({ length: workerCount }, async () => {
      while (nextIndex < nodes.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await this.probeNodeForBulk(nodes[index]);
      }
    });
    await Promise.all(workers);
    return results;
  }

  private async probeNodeForBulk(node: Awaited<ReturnType<PrismaService["node"]["findMany"]>>[number]) {
    try {
      return await this.probeNodeWithBulkBudget(node.id);
    } catch (error) {
      const message = readAdminNodeErrorMessage(error);
      this.logger.warn(`Node ${node.id} bulk probe failed; continuing with remaining nodes: ${message}`);
      const checkedAt = new Date();
      const fallbackStatus = node.isActive && node.panelEnabled ? "degraded" : "offline";
      try {
        const row = await this.prisma.node.update({
          where: { id: node.id },
          data: {
            probeStatus: "offline",
            probeLatencyMs: null,
            probeCheckedAt: checkedAt,
            probeError: message,
            panelStatus: fallbackStatus,
            panelError: fallbackStatus === "degraded" ? message : null
          }
        });
        return toAdminNodeRecord(row);
      } catch (updateError) {
        this.logger.warn(`Node ${node.id} bulk probe fallback update failed: ${readAdminNodeErrorMessage(updateError)}`);
        return toAdminNodeRecord({
          ...node,
          probeStatus: "offline",
          probeLatencyMs: null,
          probeCheckedAt: checkedAt,
          probeError: message,
          panelStatus: fallbackStatus,
          panelError: fallbackStatus === "degraded" ? message : null,
          updatedAt: checkedAt
        });
      }
    }
  }

  private async probeNodeWithBulkBudget(nodeId: string) {
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
        reject(new Error(`bulk node probe exceeded ${readBulkNodeProbeBudgetMs()}ms`));
      }, readBulkNodeProbeBudgetMs());
    });

    try {
      return await Promise.race([probeTask, timeoutTask]);
    } finally {
      if (settled && timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  async deleteNode(nodeId: string) {
    const current = await this.prisma.node.findUnique({ where: { id: nodeId } });
    if (!current) {
      throw new NotFoundException("节点不存在");
    }

    await this.prisma.node.update({
      where: { id: current.id },
      data: {
        isActive: false,
        recommended: false,
        panelStatus: "offline",
        panelError: null
      }
    });
    await this.tryRunAfterLocalNodeSave("revoke node leases after node delete", () =>
      this.runtimeSessionService.revokeNodeLeases(nodeId, "node_deleted")
    );
    await this.tryRunAfterLocalNodeSave("queue panel binding deletion after node delete", () =>
      this.runtimeSessionService.removePanelBindingsForNode(nodeId)
    );
    const userIds = await this.runAfterLocalNodeSaveWithBudget(
      "resolve node access event targets after node delete",
      [] as string[],
      () => this.clientEventsPublisher.resolveUserIdsForNodeAccess(nodeId)
    );
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
    const timer = setTimeout(() => {
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const guardedTask = task().then(
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
          `Local node change saved, but delayed ${label} failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
      timeoutHandle = setTimeout(() => {
        if (!settled) {
          this.logger?.warn(
            `Local node change saved, but ${label} exceeded ${NODE_AFTER_SAVE_FOLLOW_UP_BUDGET_MS}ms and will continue in background.`
          );
        }
      }, NODE_AFTER_SAVE_FOLLOW_UP_BUDGET_MS);
      timeoutHandle.unref?.();
      void guardedTask
        .finally(() => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
        })
        .catch(() => undefined);
    }, NODE_AFTER_SAVE_DEFERRED_EFFECT_DELAY_MS);
    timer.unref?.();
  }

  private async resolveNodeRuntimeSource(input: ImportNodeInputDto, panelEnabled: boolean) {
    if (input.subscriptionUrl?.trim()) {
      return this.readImportRuntimeWithBudget(
        fetchSubscriptionNode(input.subscriptionUrl.trim()),
        "subscription runtime read"
      );
    }

    if (panelEnabled && input.panelBaseUrl && input.panelUsername && input.panelPassword) {
      return this.readImportRuntimeWithBudget(
        this.xuiService.getInboundRuntime({
          id: createId("panel_runtime"),
          panelBaseUrl: input.panelBaseUrl,
          panelApiBasePath: input.panelApiBasePath ?? "/",
          panelUsername: input.panelUsername,
          panelPassword: input.panelPassword,
          panelInboundId: input.panelInboundId ?? null
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
        throw error;
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
