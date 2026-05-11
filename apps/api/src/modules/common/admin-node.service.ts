import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
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
      action: "disable_client",
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
        subscriptionUrl: input.subscriptionUrl?.trim() || null,
        panelBaseUrl: nextPanelBaseUrl,
        panelApiBasePath: nextPanelApiBasePath,
        panelUsername: nextPanelUsername,
        panelPassword: nextPanelPassword,
        panelInboundId: nextPanelInboundId,
        panelEnabled: nextPanelEnabled,
        panelStatus: current?.panelStatus ?? "offline"
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
        subscriptionUrl: input.subscriptionUrl?.trim() || null,
        panelBaseUrl: nextPanelBaseUrl,
        panelApiBasePath: nextPanelApiBasePath,
        panelUsername: nextPanelUsername,
        panelPassword: nextPanelPassword,
        panelInboundId: nextPanelInboundId,
        panelEnabled: nextPanelEnabled
      }
    });

    const record = await this.probeNode(row.id);
    if (current) {
      await this.clientEventsPublisher.publishNodeAccessUpdatedForNode(row.id);
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

    let derived: ReturnType<typeof parseVlessLink> | Awaited<ReturnType<XuiService["getInboundRuntime"]>> | null = null;
    if (input.subscriptionUrl !== undefined && input.subscriptionUrl.trim()) {
      derived = await fetchSubscriptionNode(input.subscriptionUrl);
    } else if (nextPanelEnabled && panelConfigTouched) {
      derived = await this.xuiService.getInboundRuntime({
        id: current.id,
        panelBaseUrl: input.panelBaseUrl ?? current.panelBaseUrl,
        panelApiBasePath: input.panelApiBasePath ?? current.panelApiBasePath,
        panelUsername: input.panelUsername ?? current.panelUsername,
        panelPassword: input.panelPassword ?? current.panelPassword,
        panelInboundId: input.panelInboundId ?? current.panelInboundId ?? null
      });
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
              spiderX: derived.spiderX
            }
          : {})
      }
    });

    if (current.isActive && input.isActive === false) {
      await this.runtimeSessionService.revokeNodeLeases(nodeId, "node_disabled");
      await this.runtimeSessionService.markPanelBindingsDisabledForNode(nodeId);
    } else if (!current.isActive && input.isActive === true) {
      await this.runtimeSessionService.clearPendingPanelDisableJobsForNode(nodeId);
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
      await this.clientEventsPublisher.publishNodeAccessUpdatedForNode(nodeId);
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
        spiderX: derived.spiderX
      }
    });

    await this.clientEventsPublisher.publishNodeAccessUpdatedForNode(nodeId);
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
    if (current.panelEnabled) {
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
    const userIds = await this.clientEventsPublisher.resolveUserIdsForNodeAccess(nodeId);
    await this.prisma.node.delete({ where: { id: nodeId } });
    this.clientEventsPublisher.publishNodeAccessUpdatedToUsers(userIds, nodeId);
    return { ok: true };
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

    throw new BadRequestException("请填写订阅地址，或完整配置 3x-ui 面板账号后读取入站并导入节点");
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
