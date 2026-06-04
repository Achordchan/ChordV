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
    const jobs = await this.listPanelSyncJobs();
    const summaryByNode = new Map<string, { count: number; lastError: string | null }>();
    for (const job of jobs) {
      const summary = summaryByNode.get(job.nodeId) ?? { count: 0, lastError: null };
      summary.count += 1;
      summary.lastError = job.lastError ?? summary.lastError;
      summaryByNode.set(job.nodeId, summary);
    }

    return rows.map((row) => {
      const record = toAdminNodeRecord(row);
      const summary = summaryByNode.get(row.id);
      return {
        ...record,
        panelSyncPendingCount: summary?.count ?? 0,
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

    if (current && panelConnectionChanged && !nodeWillBeDisabled) {
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

    const record = await this.probeNode(row.id);
    if (current) {
      if (row.isActive && row.panelEnabled && (!current.panelEnabled || panelConnectionChanged || (!current.isActive && input.isActive === true))) {
        await this.tryRunAfterLocalNodeSave("queue panel access sync after node import", () =>
          this.runtimeSessionService.syncPanelAccessForNode(row.id)
        );
      }
      await this.tryRunAfterLocalNodeSave("publish node access update after node import", () =>
        this.clientEventsPublisher.publishNodeAccessUpdatedForNode(row.id)
      );
    }
    return record;
  }

  async listNodePanelInbounds(input: {
    panelBaseUrl: string;
    panelApiBasePath?: string;
    panelUsername: string;
    panelPassword: string;
  }): Promise<AdminNodePanelInboundDto[]> {
    const inbounds = await this.xuiService.listInbounds({
      id: createId("panel"),
      panelBaseUrl: input.panelBaseUrl,
      panelApiBasePath: input.panelApiBasePath ?? "/",
      panelUsername: input.panelUsername,
      panelPassword: input.panelPassword,
      panelInboundId: null
    }, {
      forceRelogin: true,
      strictCredentialCheck: true
    });

    return inbounds;
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
      derived = await fetchSubscriptionNode(input.subscriptionUrl);
    } else if (nextPanelEnabled && panelConfigTouched) {
      try {
        derived = await this.xuiService.getInboundRuntime({
          id: current.id,
          panelBaseUrl: nextPanelBaseUrl,
          panelApiBasePath: nextPanelApiBasePath,
          panelUsername: nextPanelUsername,
          panelPassword: nextPanelPassword,
          panelInboundId: nextPanelInboundId
        });
      } catch (error) {
        panelRuntimeError = error instanceof Error ? error.message : String(error);
        this.logger?.warn(`Local node panel config will be saved, but reading new panel runtime failed: ${panelRuntimeError}`);
      }
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
      where: { id: nodeId },
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

    if (panelConnectionChanged && !nodeWillBeDisabled) {
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

    return toAdminNodeRecord(row);
  }

  async refreshNode(nodeId: string): Promise<AdminNodeRecordDto> {
    const current = await this.prisma.node.findUnique({ where: { id: nodeId } });
    if (!current) {
      throw new NotFoundException("节点不存在");
    }
    let derived: ReturnType<typeof parseVlessLink> | Awaited<ReturnType<XuiService["getInboundRuntime"]>>;
    if (current.panelEnabled) {
      derived = await this.xuiService.getInboundRuntime({
        id: current.id,
        panelBaseUrl: current.panelBaseUrl,
        panelApiBasePath: current.panelApiBasePath,
        panelUsername: current.panelUsername,
        panelPassword: current.panelPassword,
        panelInboundId: current.panelInboundId
      });
    } else {
      if (!current.subscriptionUrl) {
        throw new BadRequestException("当前节点没有订阅地址");
      }
      derived = await fetchSubscriptionNode(current.subscriptionUrl);
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

  async probeNode(nodeId: string): Promise<AdminNodeRecordDto> {
    const current = await this.prisma.node.findUnique({ where: { id: nodeId } });
    if (!current) {
      throw new NotFoundException("节点不存在");
    }

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
      where: { id: nodeId },
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

  async probeAllNodes() {
    const nodes = await this.prisma.node.findMany({ orderBy: { createdAt: "desc" } });
    const results: AdminNodeRecordDto[] = [];
    for (const node of nodes) {
      results.push(await this.probeNode(node.id));
    }
    return results;
  }

  async deleteNode(nodeId: string) {
    const current = await this.prisma.node.findUnique({ where: { id: nodeId } });
    if (!current) {
      throw new NotFoundException("节点不存在");
    }

    let userIds: string[] = [];
    try {
      userIds = await this.clientEventsPublisher.resolveUserIdsForNodeAccess(nodeId);
    } catch (error) {
      this.logger?.warn(
        `Local node delete will continue, but resolving node access event targets failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    await this.prisma.node.update({
      where: { id: nodeId },
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
    try {
      this.clientEventsPublisher.publishNodeAccessUpdatedToUsers(userIds, nodeId);
    } catch (error) {
      this.logger?.warn(`Local node delete saved, but node access publish failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { ok: true };
  }

  private async tryRunAfterLocalNodeSave(label: string, task: () => Promise<unknown>) {
    try {
      await task();
    } catch (error) {
      this.logger?.warn(`Local node change saved, but ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async resolveNodeRuntimeSource(input: ImportNodeInputDto, panelEnabled: boolean) {
    if (input.subscriptionUrl?.trim()) {
      return fetchSubscriptionNode(input.subscriptionUrl.trim());
    }

    if (panelEnabled && input.panelBaseUrl && input.panelUsername && input.panelPassword) {
      return this.xuiService.getInboundRuntime({
        id: createId("panel_runtime"),
        panelBaseUrl: input.panelBaseUrl,
        panelApiBasePath: input.panelApiBasePath ?? "/",
        panelUsername: input.panelUsername,
        panelPassword: input.panelPassword,
        panelInboundId: input.panelInboundId ?? null
      });
    }

    throw new BadRequestException("请填写订阅地址，或完整配置 3x-ui 面板账号后读取入站并添加面板");
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
