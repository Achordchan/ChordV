import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  AdminRuntimeComponentFailureReportDto,
  AdminRuntimeComponentRecordDto,
  AdminRuntimeComponentValidationDto,
  ClientRuntimeComponentFailureReportInputDto,
  ClientRuntimeComponentsPlanDto,
  ClientRuntimeComponentsPlanInputDto,
  CreateRuntimeComponentInputDto,
  RuntimeComponentArchitecture,
  RuntimeComponentKind,
  RuntimeComponentValidationStatus,
  UpdateRuntimeComponentInputDto
} from "@chordv/shared";
import { fetch as undiciFetch } from "undici";
import { PrismaService } from "./prisma.service";
import { AuthSessionService } from "./auth-session.service";

@Injectable()
export class RuntimeComponentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authSessionService: AuthSessionService
  ) {}

  async listAdminRuntimeComponents(): Promise<AdminRuntimeComponentRecordDto[]> {
    const rows = await this.prisma.runtimeComponent.findMany({
      orderBy: [{ platform: "asc" }, { architecture: "asc" }, { kind: "asc" }]
    });
    return rows.map(toAdminRuntimeComponentRecord);
  }

  async createAdminRuntimeComponent(input: CreateRuntimeComponentInputDto): Promise<AdminRuntimeComponentRecordDto> {
    const created = await this.prisma.runtimeComponent.create({
      data: {
        id: createId("rtcomp"),
        platform: input.platform,
        architecture: input.architecture,
        kind: input.kind,
        source: input.source ?? "github_remote",
        originUrl: input.originUrl.trim(),
        defaultMirrorPrefix: normalizeNullableText(input.defaultMirrorPrefix),
        allowClientMirror: input.allowClientMirror ?? true,
        fileName: input.fileName.trim(),
        archiveEntryName: normalizeNullableText(input.archiveEntryName),
        expectedHash: normalizeNullableText(input.expectedHash),
        enabled: input.enabled ?? true
      }
    });
    return toAdminRuntimeComponentRecord(created);
  }

  async updateAdminRuntimeComponent(
    componentId: string,
    input: UpdateRuntimeComponentInputDto
  ): Promise<AdminRuntimeComponentRecordDto> {
    await this.ensureRuntimeComponentExists(componentId);
    const updated = await this.prisma.runtimeComponent.update({
      where: { id: componentId },
      data: {
        ...(input.source !== undefined ? { source: input.source } : {}),
        ...(input.originUrl !== undefined ? { originUrl: input.originUrl.trim() } : {}),
        ...(input.defaultMirrorPrefix !== undefined
          ? { defaultMirrorPrefix: normalizeNullableText(input.defaultMirrorPrefix) }
          : {}),
        ...(input.allowClientMirror !== undefined ? { allowClientMirror: input.allowClientMirror } : {}),
        ...(input.fileName !== undefined ? { fileName: input.fileName.trim() } : {}),
        ...(input.archiveEntryName !== undefined ? { archiveEntryName: normalizeNullableText(input.archiveEntryName) } : {}),
        ...(input.expectedHash !== undefined ? { expectedHash: normalizeNullableText(input.expectedHash) } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {})
      }
    });
    return toAdminRuntimeComponentRecord(updated);
  }

  async deleteAdminRuntimeComponent(componentId: string) {
    await this.ensureRuntimeComponentExists(componentId);
    await this.prisma.runtimeComponent.delete({
      where: { id: componentId }
    });
    return { id: componentId, deleted: true as const };
  }

  async validateAdminRuntimeComponent(componentId: string): Promise<AdminRuntimeComponentValidationDto> {
    const component = await this.prisma.runtimeComponent.findUnique({
      where: { id: componentId }
    });
    if (!component) {
      throw new NotFoundException("内核组件不存在");
    }
    const resolvedUrl = resolveRuntimeComponentUrl(component, null);
    if (!component.enabled) {
      return {
        componentId,
        status: "disabled",
        message: "当前内核组件已禁用，客户端不会使用它。",
        finalUrlPreview: resolvedUrl
      };
    }
    if (!isHttpUrl(resolvedUrl)) {
      return {
        componentId,
        status: "invalid_url",
        message: "内核组件链接无效，请填写完整的 http/https 地址。",
        finalUrlPreview: resolvedUrl
      };
    }
    try {
      const response = await undiciFetch(resolvedUrl, { method: "HEAD", redirect: "follow" });
      if (response.ok) {
        return {
          componentId,
          status: "ready",
          message: "链接可访问，客户端可以按当前配置下载。",
          finalUrlPreview: resolvedUrl,
          httpStatus: response.status
        };
      }
      return {
        componentId,
        status: "unreachable",
        message: `当前链接不可访问：HTTP ${response.status}`,
        finalUrlPreview: resolvedUrl,
        httpStatus: response.status
      };
    } catch (error) {
      return {
        componentId,
        status: "unreachable",
        message: `当前链接不可访问：${error instanceof Error ? error.message : String(error)}`,
        finalUrlPreview: resolvedUrl
      };
    }
  }

  async listRuntimeComponentFailureReports(limit = 100): Promise<AdminRuntimeComponentFailureReportDto[]> {
    const rows = await this.prisma.runtimeComponentFailureReport.findMany({
      orderBy: [{ createdAt: "desc" }],
      take: limit,
      include: {
        component: true
      }
    });
    return rows.map((row) => ({
      id: row.id,
      componentId: row.componentId,
      componentLabel: row.component
        ? `${translatePlatform(row.platform)}/${row.architecture}/${translateRuntimeComponentKind(row.kind)} · ${row.component.fileName}`
        : `${translatePlatform(row.platform)}/${row.architecture}/${translateRuntimeComponentKind(row.kind)}`,
      platform: row.platform,
      architecture: row.architecture as RuntimeComponentArchitecture,
      kind: row.kind as RuntimeComponentKind,
      reason: row.reason,
      message: row.message,
      effectiveUrl: row.effectiveUrl,
      appVersion: row.appVersion,
      userId: row.userId,
      createdAt: row.createdAt.toISOString()
    }));
  }

  async getClientRuntimeComponentsPlan(
    input: ClientRuntimeComponentsPlanInputDto
  ): Promise<ClientRuntimeComponentsPlanDto> {
    const rows = await this.prisma.runtimeComponent.findMany({
      where: {
        platform: input.platform,
        architecture: input.architecture,
        enabled: true
      },
      orderBy: [{ kind: "asc" }]
    });

    return {
      platform: input.platform,
      architecture: input.architecture,
      components: rows.map((row) => {
        const originUrl = row.originUrl.trim();
        const defaultMirrorPrefix = normalizeNullableText(row.defaultMirrorPrefix);
        const candidates = buildRuntimeComponentCandidates(originUrl, defaultMirrorPrefix, input.clientMirrorPrefix, row.allowClientMirror);
        return {
          id: row.id,
          platform: row.platform,
          architecture: row.architecture as RuntimeComponentArchitecture,
          kind: row.kind as RuntimeComponentKind,
          fileName: row.fileName,
          archiveEntryName: row.archiveEntryName,
          expectedHash: row.expectedHash,
          allowClientMirror: row.allowClientMirror,
          originUrl,
          defaultMirrorPrefix,
          resolvedUrl: candidates[0]?.url ?? originUrl,
          candidates
        };
      })
    };
  }

  async reportRuntimeComponentFailure(
    input: ClientRuntimeComponentFailureReportInputDto,
    authorization?: string
  ) {
    let userId: string | null = null;
    if (authorization) {
      try {
        const user = await this.authSessionService.authenticateAccessToken(authorization);
        userId = user.id;
      } catch {
        userId = null;
      }
    }

    await this.prisma.runtimeComponentFailureReport.create({
      data: {
        id: createId("rtfail"),
        componentId: input.componentId ?? null,
        platform: input.platform,
        architecture: input.architecture,
        kind: input.kind,
        reason: input.reason,
        message: normalizeNullableText(input.message),
        effectiveUrl: normalizeNullableText(input.effectiveUrl),
        appVersion: normalizeNullableText(input.appVersion),
        userId
      }
    });

    return { ok: true };
  }

  private async ensureRuntimeComponentExists(componentId: string) {
    const existing = await this.prisma.runtimeComponent.findUnique({
      where: { id: componentId }
    });
    if (!existing) {
      throw new NotFoundException("内核组件不存在");
    }
    return existing;
  }
}

function buildRuntimeComponentCandidates(
  originUrl: string,
  defaultMirrorPrefix: string | null,
  clientMirrorPrefix: string | null | undefined,
  allowClientMirror: boolean
) {
  const candidates: ClientRuntimeComponentsPlanDto["components"][number]["candidates"] = [];
  if (allowClientMirror && clientMirrorPrefix?.trim()) {
    candidates.push({
      label: "client_mirror",
      url: joinMirrorPrefix(clientMirrorPrefix, originUrl)
    });
  }
  if (defaultMirrorPrefix?.trim()) {
    candidates.push({
      label: "default_mirror",
      url: joinMirrorPrefix(defaultMirrorPrefix, originUrl)
    });
  }
  candidates.push({
    label: "origin",
    url: originUrl
  });
  return candidates;
}

function joinMirrorPrefix(prefix: string, originUrl: string) {
  const normalizedPrefix = prefix.trim();
  if (!normalizedPrefix) {
    return originUrl;
  }
  if (normalizedPrefix.includes("{url}")) {
    return normalizedPrefix.replaceAll("{url}", originUrl);
  }
  if (normalizedPrefix.endsWith("/")) {
    return `${normalizedPrefix}${originUrl}`;
  }
  return `${normalizedPrefix}/${originUrl}`;
}

function resolveRuntimeComponentUrl(
  component: {
    originUrl: string;
    defaultMirrorPrefix: string | null;
    allowClientMirror: boolean;
  },
  clientMirrorPrefix: string | null | undefined
) {
  const candidates = buildRuntimeComponentCandidates(
    component.originUrl.trim(),
    normalizeNullableText(component.defaultMirrorPrefix),
    clientMirrorPrefix,
    component.allowClientMirror
  );
  return candidates[0]?.url ?? component.originUrl.trim();
}

function toAdminRuntimeComponentRecord(row: {
  id: string;
  platform: "macos" | "windows" | "android" | "ios";
  architecture: "x64" | "arm64";
  kind: "xray" | "geoip" | "geosite";
  source: "github_remote" | "custom_remote";
  originUrl: string;
  defaultMirrorPrefix: string | null;
  allowClientMirror: boolean;
  fileName: string;
  archiveEntryName: string | null;
  expectedHash: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}): AdminRuntimeComponentRecordDto {
  return {
    id: row.id,
    platform: row.platform,
    architecture: row.architecture,
    kind: row.kind,
    source: row.source,
    originUrl: row.originUrl,
    defaultMirrorPrefix: row.defaultMirrorPrefix,
    allowClientMirror: row.allowClientMirror,
    fileName: row.fileName,
    archiveEntryName: row.archiveEntryName,
    expectedHash: row.expectedHash,
    enabled: row.enabled,
    finalUrlPreview: resolveRuntimeComponentUrl(row, null),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function normalizeNullableText(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isHttpUrl(value: string) {
  return /^https?:\/\//i.test(value.trim());
}

function translatePlatform(platform: "macos" | "windows" | "android" | "ios") {
  if (platform === "macos") return "macOS";
  if (platform === "windows") return "Windows";
  if (platform === "android") return "Android";
  return "iOS";
}

function translateRuntimeComponentKind(kind: "xray" | "geoip" | "geosite") {
  if (kind === "xray") return "Xray 内核";
  if (kind === "geoip") return "GeoIP 数据";
  return "GeoSite 数据";
}

function createId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}
