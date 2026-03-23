import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  AdminRuntimeComponentFailureReportDto,
  AdminRuntimeComponentRecordDto,
  AdminRuntimeComponentValidationDto,
  ClientRuntimeComponentFailureReportInputDto,
  ClientRuntimeComponentsPlanDto,
  ClientRuntimeComponentsPlanInputDto,
  CreateRuntimeComponentInputDto,
  PlatformTarget,
  RuntimeComponentArchitecture,
  RuntimeComponentKind,
  UploadRuntimeComponentInputDto,
  UpdateRuntimeComponentInputDto
} from "@chordv/shared";
import { fetch as undiciFetch } from "undici";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { PrismaService } from "./prisma.service";
import { AuthSessionService } from "./auth-session.service";

const RUNTIME_COMPONENT_DOWNLOAD_PREFIX = "/api/downloads/runtime-components";
const SHARED_RULESET_PLATFORM: PlatformTarget = "macos";
const SHARED_RULESET_ARCHITECTURE: RuntimeComponentArchitecture = "arm64";

type UploadedRuntimeComponentFile = {
  path: string;
  originalname: string;
  size: number;
};

@Injectable()
export class RuntimeComponentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authSessionService: AuthSessionService
  ) {}

  async listAdminRuntimeComponents(): Promise<AdminRuntimeComponentRecordDto[]> {
    const rows = await this.prisma.runtimeComponent.findMany({
      orderBy: [{ updatedAt: "desc" }, { platform: "asc" }, { architecture: "asc" }, { kind: "asc" }]
    });
    return dedupeSharedRulesets(rows).map(toAdminRuntimeComponentRecord);
  }

  async createAdminRuntimeComponent(input: CreateRuntimeComponentInputDto): Promise<AdminRuntimeComponentRecordDto> {
    const originUrl = input.originUrl?.trim();
    if (!originUrl) {
      throw new BadRequestException("请填写组件下载直链");
    }
    const normalizedInput = normalizeRuntimeComponentIdentity(input.platform, input.architecture, input.kind);
    if (isSharedRuleset(input.kind)) {
      const existing = await this.findSharedRulesetRecord(input.kind);
      if (existing) {
        const updated = await this.prisma.runtimeComponent.update({
          where: { id: existing.id },
          data: {
            platform: normalizedInput.platform,
            architecture: normalizedInput.architecture,
            kind: input.kind,
            source: input.source ?? "github_remote",
            originUrl,
            defaultMirrorPrefix: normalizeNullableText(input.defaultMirrorPrefix),
            allowClientMirror: input.allowClientMirror ?? true,
            fileName: input.fileName.trim(),
            archiveEntryName: normalizeNullableText(input.archiveEntryName),
            expectedHash: normalizeNullableText(input.expectedHash),
            enabled: input.enabled ?? true
          }
        });
        await this.cleanupSharedRulesetDuplicates(input.kind, updated.id);
        return toAdminRuntimeComponentRecord(updated);
      }
    }

    const created = await this.prisma.runtimeComponent.create({
      data: {
        id: createId("rtcomp"),
        platform: normalizedInput.platform,
        architecture: normalizedInput.architecture,
        kind: input.kind,
        source: input.source ?? "github_remote",
        originUrl,
        defaultMirrorPrefix: normalizeNullableText(input.defaultMirrorPrefix),
        allowClientMirror: input.allowClientMirror ?? true,
        fileName: input.fileName.trim(),
        storedFilePath: null,
        fileSizeBytes: null,
        fileHash: null,
        archiveEntryName: normalizeNullableText(input.archiveEntryName),
        expectedHash: normalizeNullableText(input.expectedHash),
        enabled: input.enabled ?? true
      }
    });
    return toAdminRuntimeComponentRecord(created);
  }

  async uploadAdminRuntimeComponent(
    input: UploadRuntimeComponentInputDto,
    file?: UploadedRuntimeComponentFile
  ): Promise<AdminRuntimeComponentRecordDto> {
    if (!file) {
      throw new BadRequestException("请先选择要上传的内核组件文件");
    }
    const normalizedInput = normalizeRuntimeComponentIdentity(input.platform, input.architecture, input.kind);
    if (isSharedRuleset(input.kind)) {
      const existing = await this.findSharedRulesetRecord(input.kind);
      if (existing) {
        return this.replaceAdminRuntimeComponentUpload(existing.id, {
          ...input,
          platform: normalizedInput.platform,
          architecture: normalizedInput.architecture
        }, file);
      }
    }

    const componentId = createId("rtcomp");
    const prepared = await this.prepareUploadedRuntimeComponentFile(componentId, file, input.fileName);

    try {
      const created = await this.prisma.runtimeComponent.create({
        data: {
          id: componentId,
          platform: normalizedInput.platform,
          architecture: normalizedInput.architecture,
          kind: input.kind,
          source: "uploaded",
          originUrl: prepared.downloadUrl,
          defaultMirrorPrefix: null,
          allowClientMirror: false,
          fileName: prepared.fileName,
          storedFilePath: prepared.storedFilePath,
          fileSizeBytes: prepared.fileSizeBytes,
          fileHash: prepared.fileHash,
          archiveEntryName: null,
          expectedHash: normalizeNullableText(input.expectedHash) ?? prepared.fileHash,
          enabled: input.enabled ?? true
        }
      });
      if (isSharedRuleset(input.kind)) {
        await this.cleanupSharedRulesetDuplicates(input.kind, created.id);
      }
      return toAdminRuntimeComponentRecord(created);
    } catch (error) {
      await removeRuntimeComponentFile(prepared.absolutePath);
      throw error;
    }
  }

  async updateAdminRuntimeComponent(
    componentId: string,
    input: UpdateRuntimeComponentInputDto
  ): Promise<AdminRuntimeComponentRecordDto> {
    const current = await this.ensureRuntimeComponentExists(componentId);
    const normalizedIdentity = normalizeRuntimeComponentIdentity(current.platform, current.architecture as RuntimeComponentArchitecture, current.kind as RuntimeComponentKind);
    const nextSource = input.source ?? current.source;
    const nextOriginUrl = input.originUrl?.trim();
    if (nextSource !== "uploaded" && input.originUrl !== undefined && !nextOriginUrl) {
      throw new BadRequestException("请填写组件下载直链");
    }

    const updated = await this.prisma.runtimeComponent.update({
      where: { id: componentId },
      data: {
        ...(input.source !== undefined ? { source: input.source } : {}),
        ...(input.originUrl !== undefined ? { originUrl: nextOriginUrl } : {}),
        ...(input.defaultMirrorPrefix !== undefined
          ? { defaultMirrorPrefix: normalizeNullableText(input.defaultMirrorPrefix) }
          : {}),
        ...(input.allowClientMirror !== undefined ? { allowClientMirror: input.allowClientMirror } : {}),
        ...(input.fileName !== undefined ? { fileName: input.fileName.trim() } : {}),
        ...(input.archiveEntryName !== undefined ? { archiveEntryName: normalizeNullableText(input.archiveEntryName) } : {}),
        ...(input.expectedHash !== undefined ? { expectedHash: normalizeNullableText(input.expectedHash) } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(isSharedRuleset(current.kind as RuntimeComponentKind)
          ? {
              platform: normalizedIdentity.platform,
              architecture: normalizedIdentity.architecture
            }
          : {}),
        ...(nextSource === "uploaded"
          ? {
              defaultMirrorPrefix: null,
              allowClientMirror: false,
              archiveEntryName: null
            }
          : {})
      }
    });
    if (isSharedRuleset(updated.kind as RuntimeComponentKind)) {
      await this.cleanupSharedRulesetDuplicates(updated.kind as RuntimeComponentKind, updated.id);
    }
    return toAdminRuntimeComponentRecord(updated);
  }

  async replaceAdminRuntimeComponentUpload(
    componentId: string,
    input: UploadRuntimeComponentInputDto,
    file?: UploadedRuntimeComponentFile
  ): Promise<AdminRuntimeComponentRecordDto> {
    if (!file) {
      throw new BadRequestException("请先选择要上传的内核组件文件");
    }

    const current = await this.ensureRuntimeComponentExists(componentId);
    const normalizedInput = normalizeRuntimeComponentIdentity(input.platform, input.architecture, input.kind);
    const previousStoredFilePath = current.storedFilePath;
    const prepared = await this.prepareUploadedRuntimeComponentFile(componentId, file, input.fileName);

    try {
      const updated = await this.prisma.runtimeComponent.update({
        where: { id: componentId },
        data: {
          platform: normalizedInput.platform,
          architecture: normalizedInput.architecture,
          kind: input.kind,
          source: "uploaded",
          originUrl: prepared.downloadUrl,
          defaultMirrorPrefix: null,
          allowClientMirror: false,
          fileName: prepared.fileName,
          storedFilePath: prepared.storedFilePath,
          fileSizeBytes: prepared.fileSizeBytes,
          fileHash: prepared.fileHash,
          archiveEntryName: null,
          expectedHash: normalizeNullableText(input.expectedHash) ?? prepared.fileHash,
          enabled: input.enabled ?? current.enabled
        }
      });
      if (previousStoredFilePath && previousStoredFilePath !== prepared.storedFilePath) {
        await removeRuntimeComponentFile(resolveRuntimeComponentAbsolutePath(previousStoredFilePath));
      }
      if (isSharedRuleset(input.kind)) {
        await this.cleanupSharedRulesetDuplicates(input.kind, updated.id);
      }
      return toAdminRuntimeComponentRecord(updated);
    } catch (error) {
      await removeRuntimeComponentFile(prepared.absolutePath);
      throw error;
    }
  }

  async deleteAdminRuntimeComponent(componentId: string) {
    const existing = await this.ensureRuntimeComponentExists(componentId);
    await this.prisma.runtimeComponent.delete({
      where: { id: componentId }
    });
    if (existing.storedFilePath) {
      await removeRuntimeComponentFile(resolveRuntimeComponentAbsolutePath(existing.storedFilePath));
    }
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

    if (component.source === "uploaded") {
      return this.validateUploadedRuntimeComponent(componentId, component, resolvedUrl);
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

  async getClientRuntimeComponentsPlan(input: ClientRuntimeComponentsPlanInputDto): Promise<ClientRuntimeComponentsPlanDto> {
    const runtimeRows = await this.prisma.runtimeComponent.findMany({
      where: {
        platform: input.platform,
        architecture: input.architecture,
        kind: "xray",
        enabled: true
      },
      orderBy: [{ kind: "asc" }]
    });
    const sharedRulesetRows = dedupeSharedRulesets(
      await this.prisma.runtimeComponent.findMany({
        where: {
          kind: { in: ["geoip", "geosite"] },
          enabled: true
        },
        orderBy: [{ updatedAt: "desc" }]
      })
    );
    const rows = [...runtimeRows, ...sharedRulesetRows];

    return {
      platform: input.platform,
      architecture: input.architecture,
      components: rows.map((row) => {
        const originUrl = row.originUrl.trim();
        const defaultMirrorPrefix = row.source === "uploaded" ? null : normalizeNullableText(row.defaultMirrorPrefix);
        const allowClientMirror = row.source === "uploaded" ? false : row.allowClientMirror;
        const candidates =
          row.source === "uploaded"
            ? [{ label: "origin" as const, url: originUrl }]
            : buildRuntimeComponentCandidates(originUrl, defaultMirrorPrefix, input.clientMirrorPrefix, allowClientMirror);

        return {
          id: row.id,
          platform: row.platform,
          architecture: row.architecture as RuntimeComponentArchitecture,
          kind: row.kind as RuntimeComponentKind,
          fileName: row.fileName,
          archiveEntryName: row.archiveEntryName,
          expectedHash: row.expectedHash,
          allowClientMirror,
          originUrl,
          defaultMirrorPrefix,
          resolvedUrl: candidates[0]?.url ?? originUrl,
          candidates
        };
      })
    };
  }

  async cleanupSharedRulesetDuplicates(kind: RuntimeComponentKind, keepId: string) {
    if (!isSharedRuleset(kind)) {
      return;
    }
    const duplicates = await this.prisma.runtimeComponent.findMany({
      where: {
        kind
      },
      orderBy: [{ updatedAt: "desc" }]
    });
    for (const duplicate of duplicates) {
      if (duplicate.id === keepId) {
        continue;
      }
      await this.prisma.runtimeComponent.delete({ where: { id: duplicate.id } });
      if (duplicate.storedFilePath) {
        await removeRuntimeComponentFile(resolveRuntimeComponentAbsolutePath(duplicate.storedFilePath));
      }
    }
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

  async getRuntimeComponentDownloadDescriptor(componentId: string) {
    const component = await this.prisma.runtimeComponent.findUnique({
      where: { id: componentId }
    });
    if (!component || component.source !== "uploaded" || !component.storedFilePath) {
      throw new NotFoundException("内核组件不存在");
    }
    const absolutePath = resolveRuntimeComponentAbsolutePath(component.storedFilePath);
    await ensureFileReadable(absolutePath);
    return {
      absolutePath,
      fileName: component.fileName ?? path.basename(absolutePath)
    };
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

  private async findSharedRulesetRecord(kind: RuntimeComponentKind) {
    if (!isSharedRuleset(kind)) {
      return null;
    }
    return this.prisma.runtimeComponent.findFirst({
      where: { kind },
      orderBy: [{ updatedAt: "desc" }]
    });
  }

  private async validateUploadedRuntimeComponent(
    componentId: string,
    component: {
      storedFilePath: string | null;
      fileHash: string | null;
      fileSizeBytes: bigint | null;
    },
    resolvedUrl: string
  ): Promise<AdminRuntimeComponentValidationDto> {
    if (!component.storedFilePath) {
      return {
        componentId,
        status: "missing_file",
        message: "已上传组件记录不完整，请重新上传文件。",
        finalUrlPreview: resolvedUrl
      };
    }

    const absolutePath = resolveRuntimeComponentAbsolutePath(component.storedFilePath);
    try {
      await ensureFileReadable(absolutePath);
    } catch {
      return {
        componentId,
        status: "missing_file",
        message: "服务器上的内核组件文件已丢失，请重新上传。",
        finalUrlPreview: resolvedUrl
      };
    }

    const stat = await fs.stat(absolutePath);
    const actualFileHash = await calculateFileSha256(absolutePath);
    const actualFileSizeBytes = stat.size.toString();
    const hashMatches = !component.fileHash || component.fileHash === actualFileHash;
    const sizeMatches = !component.fileSizeBytes || component.fileSizeBytes.toString() === actualFileSizeBytes;

    if (!hashMatches || !sizeMatches) {
      return {
        componentId,
        status: "metadata_mismatch",
        message: "服务器文件存在，但记录里的大小或 Hash 与真实文件不一致，建议重新上传覆盖。",
        finalUrlPreview: resolvedUrl
      };
    }

    return {
      componentId,
      status: "ready",
      message: "已上传组件可用，客户端下载地址和文件元信息已匹配。",
      finalUrlPreview: resolvedUrl
    };
  }

  private async prepareUploadedRuntimeComponentFile(
    componentId: string,
    file: UploadedRuntimeComponentFile,
    preferredFileName?: string | null
  ) {
    const finalFileName = sanitizeStoredFileName(preferredFileName?.trim() || file.originalname || `${componentId}.bin`);
    const storedFilePath = path.join(componentId, finalFileName);
    const absolutePath = resolveRuntimeComponentAbsolutePath(storedFilePath);

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.rm(absolutePath, { force: true });
    await moveUploadedFile(file.path, absolutePath);

    return {
      absolutePath,
      storedFilePath,
      fileName: finalFileName,
      fileSizeBytes: BigInt(file.size),
      fileHash: await calculateFileSha256(absolutePath),
      downloadUrl: buildRuntimeComponentDownloadUrl(componentId)
    };
  }
}

async function moveUploadedFile(sourcePath: string, targetPath: string) {
  try {
    await fs.rename(sourcePath, targetPath);
    return;
  } catch (error) {
    if (!isCrossDeviceRenameError(error)) {
      throw error;
    }
  }

  await fs.copyFile(sourcePath, targetPath);
  await fs.unlink(sourcePath);
}

function isCrossDeviceRenameError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EXDEV";
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
      label: "client_mirror" as const,
      url: joinMirrorPrefix(clientMirrorPrefix, originUrl)
    });
  }
  if (defaultMirrorPrefix?.trim()) {
    candidates.push({
      label: "default_mirror" as const,
      url: joinMirrorPrefix(defaultMirrorPrefix, originUrl)
    });
  }
  candidates.push({
    label: "origin" as const,
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
    source?: "uploaded" | "github_remote" | "custom_remote";
    originUrl: string;
    defaultMirrorPrefix: string | null;
    allowClientMirror: boolean;
  },
  clientMirrorPrefix: string | null | undefined
) {
  if (component.source === "uploaded") {
    return component.originUrl.trim();
  }
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
  source: "uploaded" | "github_remote" | "custom_remote";
  originUrl: string;
  defaultMirrorPrefix: string | null;
  allowClientMirror: boolean;
  fileName: string;
  storedFilePath: string | null;
  fileSizeBytes: bigint | null;
  fileHash: string | null;
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
    allowClientMirror: row.source === "uploaded" ? false : row.allowClientMirror,
    fileName: row.fileName,
    fileSizeBytes: row.fileSizeBytes ? row.fileSizeBytes.toString() : null,
    fileHash: row.fileHash,
    archiveEntryName: row.archiveEntryName,
    expectedHash: row.expectedHash,
    enabled: row.enabled,
    finalUrlPreview: resolveRuntimeComponentUrl(row, null),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function dedupeSharedRulesets<
  T extends {
    kind: RuntimeComponentKind;
    updatedAt?: Date;
  }
>(rows: T[]) {
  const seen = new Set<RuntimeComponentKind>();
  const next: T[] = [];
  for (const row of rows) {
    if (!isSharedRuleset(row.kind)) {
      next.push(row);
      continue;
    }
    if (seen.has(row.kind)) {
      continue;
    }
    seen.add(row.kind);
    next.push(row);
  }
  return next;
}

function isSharedRuleset(kind: RuntimeComponentKind) {
  return kind === "geoip" || kind === "geosite";
}

function normalizeRuntimeComponentIdentity(
  platform: PlatformTarget,
  architecture: RuntimeComponentArchitecture,
  kind: RuntimeComponentKind
) {
  if (!isSharedRuleset(kind)) {
    return { platform, architecture };
  }
  return {
    platform: SHARED_RULESET_PLATFORM,
    architecture: SHARED_RULESET_ARCHITECTURE
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

function runtimeComponentStorageRoot() {
  const customRoot = (process.env.CHORDV_RELEASE_STORAGE_ROOT ?? "").trim();
  const baseRoot = customRoot ? path.resolve(customRoot) : path.resolve(process.cwd(), "storage", "releases");
  return path.resolve(baseRoot, "runtime-components");
}

function resolveRuntimeComponentAbsolutePath(storedFilePath: string) {
  return path.resolve(runtimeComponentStorageRoot(), storedFilePath);
}

function buildRuntimeComponentDownloadUrl(componentId: string) {
  const publicBaseUrl = (process.env.CHORDV_PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const relativeUrl = `${RUNTIME_COMPONENT_DOWNLOAD_PREFIX}/${componentId}`;
  return publicBaseUrl ? `${publicBaseUrl}${relativeUrl}` : relativeUrl;
}

function sanitizeStoredFileName(fileName: string) {
  const trimmed = fileName.trim();
  const safe = trimmed.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/_+/g, "_");
  return safe || `runtime_${Date.now()}`;
}

async function ensureFileReadable(filePath: string) {
  try {
    await fs.access(filePath);
  } catch {
    throw new NotFoundException("文件不存在或已丢失");
  }
}

async function removeRuntimeComponentFile(filePath: string) {
  try {
    await fs.rm(filePath, { force: true });
  } catch {
    return;
  }
}

async function calculateFileSha256(filePath: string) {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}

function createId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}
