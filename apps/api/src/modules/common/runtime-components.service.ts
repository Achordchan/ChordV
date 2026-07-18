import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
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
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { PrismaService } from "./prisma.service";
import { throwLocalReadAsServiceUnavailable, throwLocalSaveAsServiceUnavailable } from "./prisma-error.utils";
import { AuthSessionService } from "./auth-session.service";
import { moveUploadedFile } from "./upload-file.utils";
import { fetchPublicHttpUrl } from "./remote-url.utils";
import { AdminRuntimeEventsService } from "./admin-runtime-events.service";
import { DownloadMirrorService } from "./download-mirror.service";

const RUNTIME_COMPONENT_DOWNLOAD_PREFIX = "/api/downloads/runtime-components";
const SHARED_RULESET_PLATFORM: PlatformTarget = "macos";
const SHARED_RULESET_ARCHITECTURE: RuntimeComponentArchitecture = "arm64";
const DEFAULT_SHARED_RULESET_CLEANUP_BUDGET_MS = 300;
const DEFAULT_RUNTIME_COMPONENT_FILE_CLEANUP_BUDGET_MS = 300;
const ADMIN_RUNTIME_VALIDATION_REPORT_VERSION = "admin_validation";

type UploadedRuntimeComponentFile = {
  path: string;
  originalname: string;
  size: number;
};

type PreparedUploadedRuntimeComponentFile = {
  absolutePath: string;
  storedFilePath: string;
  fileName: string;
  fileSizeBytes: bigint;
  fileHash: string;
  downloadUrl: string;
};

@Injectable()
export class RuntimeComponentsService {
  private readonly logger = new Logger(RuntimeComponentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authSessionService: AuthSessionService,
    private readonly downloadMirrorService: DownloadMirrorService,
    private readonly adminRuntimeEventsService?: AdminRuntimeEventsService
  ) {}

  async listAdminRuntimeComponents(): Promise<AdminRuntimeComponentRecordDto[]> {
    try {
      const rows = await this.prisma.runtimeComponent.findMany({
        orderBy: [{ updatedAt: "desc" }, { platform: "asc" }, { architecture: "asc" }, { kind: "asc" }]
      });
      const dedupedRows = dedupeSharedRulesets(rows);
      const latestValidationFailures = await this.listLatestAdminValidationFailures(dedupedRows.map((row) => row.id));
      return await Promise.all(
        dedupedRows.map((row) => toAdminRuntimeComponentRecord(row, latestValidationFailures.get(row.id) ?? null))
      );
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "Runtime component list is temporarily unavailable.");
    }
  }

  async createAdminRuntimeComponent(input: CreateRuntimeComponentInputDto): Promise<AdminRuntimeComponentRecordDto> {
    const rawSource = (input as { source?: string }).source;
    if (rawSource === "uploaded") {
      throw new BadRequestException("上传型运行组件请通过上传入口创建。");
    }
    const originUrl = input.originUrl?.trim();
    if (!originUrl || !isHttpUrl(originUrl)) {
      throw new BadRequestException("远程运行组件需要填写有效的 HTTP(S) 源地址。");
    }
    const source = input.source ?? "github_remote";
    const expectedHash = requireRuntimeComponentSha256(input.expectedHash);
    const normalizedInput = normalizeRuntimeComponentIdentity(input.platform, input.architecture, input.kind);
    const fileName = normalizeRequiredText(input.fileName, "fileName");
    if (isSharedRuleset(input.kind)) {
      const existing = await this.findSharedRulesetRecord(input.kind);
      if (existing) {
        const staleUploadedFilePath = existing.storedFilePath;
        const updated = await this.withRuntimeComponentIdentityConflictGuard(() =>
          this.prisma.runtimeComponent.update({
            where: { id: existing.id },
            data: {
              platform: normalizedInput.platform,
              architecture: normalizedInput.architecture,
              kind: input.kind,
              source,
              originUrl,
              defaultMirrorPrefix: normalizeMirrorPrefixList(input.defaultMirrorPrefix),
              allowClientMirror: Boolean(input.allowClientMirror),
              fileName,
              storedFilePath: null,
              fileSizeBytes: null,
              fileHash: null,
              archiveEntryName: normalizeNullableText(input.archiveEntryName),
              expectedHash,
              enabled: input.enabled ?? true
            }
          })
        );
        this.startSharedRulesetDuplicatesCleanup(input.kind, updated.id);
        this.startRuntimeComponentStoredFileCleanupBestEffort(staleUploadedFilePath, "stale shared ruleset upload");
        this.publishRuntimeComponentUpdatedBestEffort();
        return toAdminRuntimeComponentRecord(updated);
      }
    }

    const created = await this.withRuntimeComponentIdentityConflictGuard(() =>
      this.prisma.runtimeComponent.create({
        data: {
          id: createId("rtcomp"),
          platform: normalizedInput.platform,
          architecture: normalizedInput.architecture,
          kind: input.kind,
          source,
          originUrl,
          defaultMirrorPrefix: normalizeMirrorPrefixList(input.defaultMirrorPrefix),
          allowClientMirror: Boolean(input.allowClientMirror),
          fileName,
          storedFilePath: null,
          fileSizeBytes: null,
          fileHash: null,
          archiveEntryName: normalizeNullableText(input.archiveEntryName),
          expectedHash,
          enabled: input.enabled ?? true
        }
      })
    );
    this.publishRuntimeComponentUpdatedBestEffort();
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
    let prepared: PreparedUploadedRuntimeComponentFile | null = null;
    try {
      const preparedFile = await this.prepareUploadedRuntimeComponentFile(componentId, file, input.fileName);
      prepared = preparedFile;
      const created = await this.withRuntimeComponentIdentityConflictGuard(
        () =>
          this.prisma.runtimeComponent.create({
            data: {
              id: componentId,
              platform: normalizedInput.platform,
              architecture: normalizedInput.architecture,
              kind: input.kind,
              source: "uploaded",
              originUrl: preparedFile.downloadUrl,
              defaultMirrorPrefix: null,
              allowClientMirror: false,
              fileName: preparedFile.fileName,
              storedFilePath: preparedFile.storedFilePath,
              fileSizeBytes: preparedFile.fileSizeBytes,
              fileHash: preparedFile.fileHash,
              archiveEntryName: null,
              expectedHash: null,
              enabled: input.enabled ?? true
            }
          }),
        "内核组件保存失败，请刷新后重试；已尝试清理本次上传文件。"
      );
      this.startSharedRulesetDuplicatesCleanup(input.kind, created.id);
      this.publishRuntimeComponentUpdatedBestEffort();
      return toAdminRuntimeComponentRecord(created);
    } catch (error) {
      await this.removeRuntimeComponentFileBestEffort(
        prepared ? prepared.absolutePath : file.path,
        "failed runtime component upload"
      );
      throwLocalSaveAsServiceUnavailable(error, "内核组件保存失败，请刷新后重试；已尝试清理本次上传文件。");
    }
  }

  async updateAdminRuntimeComponent(
    componentId: string,
    input: UpdateRuntimeComponentInputDto
  ): Promise<AdminRuntimeComponentRecordDto> {
    const current = await this.ensureRuntimeComponentExists(componentId);
    const normalizedIdentity = normalizeRuntimeComponentIdentity(current.platform, current.architecture as RuntimeComponentArchitecture, current.kind as RuntimeComponentKind);
    const nextSource = input.source ?? current.source;
    const nextOriginUrl =
      input.originUrl !== undefined ? normalizeRequiredText(input.originUrl, "originUrl") : current.originUrl.trim();
    const nextFileName =
      input.fileName !== undefined ? normalizeRequiredText(input.fileName, "fileName") : current.fileName;
    if (nextSource === "uploaded" && current.source !== "uploaded") {
      throw new BadRequestException("上传型运行组件请通过上传入口创建。");
    }
    if (nextSource === "uploaded" && input.originUrl !== undefined && nextOriginUrl !== current.originUrl) {
      throw new BadRequestException("上传型运行组件的下载地址由上传入口管理。");
    }
    if (nextSource === "uploaded" && !current.storedFilePath) {
      throw new BadRequestException("上传型运行组件缺少已保存文件。");
    }
    if (nextSource !== "uploaded" && (!nextOriginUrl || !isHttpUrl(nextOriginUrl))) {
      throw new BadRequestException("远程运行组件需要填写有效的 HTTP(S) 源地址。");
    }
    // 上传型组件以服务端 fileHash 为准，忽略客户端手填 expectedHash。
    // 远程组件在 originUrl/source 变化时必须提供新哈希，禁止继承旧哈希。
    const remoteValidationInvalidated =
      nextSource !== "uploaded" &&
      (current.source === "uploaded" ||
        nextSource !== current.source ||
        nextOriginUrl !== current.originUrl);
    if (remoteValidationInvalidated && input.expectedHash === undefined) {
      throw new BadRequestException("修改远程组件来源地址后必须同时提供新的 expectedHash。");
    }
    const normalizedExpectedHash =
      nextSource === "uploaded"
        ? null
        : input.expectedHash !== undefined
          ? requireRuntimeComponentSha256(input.expectedHash)
          : normalizeSha256Hex(current.expectedHash);
    const staleUploadedFilePath =
      remoteValidationInvalidated && current.storedFilePath ? current.storedFilePath : null;

    const updated = await this.withRuntimeComponentIdentityConflictGuard(() =>
      this.prisma.runtimeComponent.update({
        where: { id: componentId },
        data: {
          ...(input.source !== undefined ? { source: input.source } : {}),
          ...(input.originUrl !== undefined ? { originUrl: nextOriginUrl } : {}),
          ...(input.fileName !== undefined ? { fileName: nextFileName } : {}),
          ...(input.archiveEntryName !== undefined ? { archiveEntryName: normalizeNullableText(input.archiveEntryName) } : {}),
          expectedHash: normalizedExpectedHash,
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          ...(input.defaultMirrorPrefix !== undefined
            ? { defaultMirrorPrefix: normalizeMirrorPrefixList(input.defaultMirrorPrefix) }
            : {}),
          ...(input.allowClientMirror !== undefined ? { allowClientMirror: Boolean(input.allowClientMirror) } : {}),
          ...(remoteValidationInvalidated
            ? {
                storedFilePath: null,
                fileSizeBytes: null,
                fileHash: null
              }
            : {}),
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
      })
    );
    this.startSharedRulesetDuplicatesCleanup(updated.kind as RuntimeComponentKind, updated.id);
    this.startRuntimeComponentStoredFileCleanupBestEffort(staleUploadedFilePath, "stale runtime component upload");
    this.publishRuntimeComponentUpdatedBestEffort();
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
    let prepared: PreparedUploadedRuntimeComponentFile | null = null;
    try {
      const preparedFile = await this.prepareUploadedRuntimeComponentFile(componentId, file, input.fileName);
      prepared = preparedFile;
      const updated = await this.withRuntimeComponentIdentityConflictGuard(
        () =>
          this.prisma.runtimeComponent.update({
            where: { id: componentId },
            data: {
              platform: normalizedInput.platform,
              architecture: normalizedInput.architecture,
              kind: input.kind,
              source: "uploaded",
              originUrl: preparedFile.downloadUrl,
              defaultMirrorPrefix: null,
              allowClientMirror: false,
              fileName: preparedFile.fileName,
              storedFilePath: preparedFile.storedFilePath,
              fileSizeBytes: preparedFile.fileSizeBytes,
              fileHash: preparedFile.fileHash,
              archiveEntryName: null,
              expectedHash: null,
              enabled: input.enabled ?? current.enabled
            }
          }),
        "内核组件替换失败，请刷新后重试；已尝试清理本次上传文件。"
      );
      this.startRuntimeComponentStoredFileCleanupBestEffort(
        previousStoredFilePath && previousStoredFilePath !== preparedFile.storedFilePath ? previousStoredFilePath : null,
        "old runtime component upload"
      );
      this.startSharedRulesetDuplicatesCleanup(input.kind, updated.id);
      this.publishRuntimeComponentUpdatedBestEffort();
      return toAdminRuntimeComponentRecord(updated);
    } catch (error) {
      await this.removeRuntimeComponentFileBestEffort(
        prepared ? prepared.absolutePath : file.path,
        "failed runtime component replacement upload"
      );
      throwLocalSaveAsServiceUnavailable(error, "内核组件替换失败，请刷新后重试；已尝试清理本次上传文件。");
    }
  }

  async deleteAdminRuntimeComponent(componentId: string) {
    const existing = await this.ensureRuntimeComponentExists(componentId);
    try {
      await this.prisma.runtimeComponent.delete({
        where: { id: componentId }
      });
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "内核组件删除失败，请刷新后重试。");
    }
    this.startRuntimeComponentStoredFileCleanupBestEffort(existing.storedFilePath, "deleted runtime component upload");
    this.publishRuntimeComponentUpdatedBestEffort();
    return { id: componentId, deleted: true as const };
  }

  async validateAdminRuntimeComponent(componentId: string): Promise<AdminRuntimeComponentValidationDto> {
    let component: Awaited<ReturnType<typeof this.prisma.runtimeComponent.findUnique>>;
    try {
      component = await this.prisma.runtimeComponent.findUnique({
        where: { id: componentId }
      });
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "Runtime component detail is temporarily unavailable.");
    }
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
      const result = await this.validateUploadedRuntimeComponent(componentId, component, resolvedUrl);
      this.publishRuntimeComponentUpdatedBestEffort();
      return result;
    }

    if (!isHttpUrl(resolvedUrl)) {
      return {
        componentId,
        status: "invalid_url",
        message: "内核组件链接无效，请填写完整的 http/https 地址。",
        finalUrlPreview: resolvedUrl
      };
    }

    if (isPrivateOrReservedRuntimeComponentUrl(resolvedUrl)) {
      return {
        componentId,
        status: "unreachable",
        message: "远程运行组件链接指向内网或保留地址，不允许使用。",
        finalUrlPreview: resolvedUrl
      };
    }

    return {
      componentId,
      status: "ready",
      message: "远程更新地址有效，客户端将按地址下载。",
      finalUrlPreview: resolvedUrl
    };
  }

  async listRuntimeComponentFailureReports(limit = 100): Promise<AdminRuntimeComponentFailureReportDto[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new BadRequestException("运行组件失败记录数量必须是 1 到 200 之间的整数。");
    }
    let rows: any[];
    try {
      rows = await this.prisma.runtimeComponentFailureReport.findMany({
        orderBy: [{ createdAt: "desc" }],
        take: limit,
        include: {
          component: true
        }
      });
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "Runtime failure report list is temporarily unavailable.");
    }
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
    let runtimeRows: Awaited<ReturnType<typeof this.prisma.runtimeComponent.findMany>>;
    let sharedRuleRowsRaw: Awaited<ReturnType<typeof this.prisma.runtimeComponent.findMany>>;
    try {
      runtimeRows = await this.prisma.runtimeComponent.findMany({
        where: {
          platform: input.platform,
          architecture: input.architecture,
          kind: "xray",
          enabled: true
        },
        orderBy: [{ kind: "asc" }]
      });
      sharedRuleRowsRaw = await this.prisma.runtimeComponent.findMany({
        where: {
          kind: { in: ["geoip", "geosite"] },
          enabled: true
        },
        orderBy: [{ updatedAt: "desc" }]
      });
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "Runtime component plan is temporarily unavailable.");
    }
    const sharedRulesetRows = dedupeSharedRulesets(sharedRuleRowsRaw);
    const rows = await filterClientUsableRuntimeComponents([...runtimeRows, ...sharedRulesetRows]);
    const globalMirror = await this.downloadMirrorService.getEffectiveConfig();
    const components = rows
      .map((row) => {
        const originUrl = row.originUrl.trim();
        const isRemoteHttp = row.source !== "uploaded" && isHttpUrl(originUrl);
        const defaultMirrorPrefix = isRemoteHttp ? globalMirror.defaultMirrorPrefix : null;
        const allowClientMirror = isRemoteHttp ? globalMirror.allowClientMirror : false;
        const clientMirrorPrefix = allowClientMirror ? normalizeMirrorPrefixList(input.clientMirrorPrefix) : null;
        const candidates = isRemoteHttp
          ? buildRuntimeComponentDownloadCandidates({
              originUrl,
              defaultMirrorPrefix,
              clientMirrorPrefix
            })
          : [{ label: "origin" as const, url: originUrl }];
        const expectedHash = normalizeSha256Hex(row.source === "uploaded" ? row.fileHash : (row.fileHash ?? row.expectedHash));

        return {
          id: row.id,
          platform: row.platform,
          architecture: row.architecture as RuntimeComponentArchitecture,
          kind: row.kind as RuntimeComponentKind,
          fileName: row.fileName,
          fileSizeBytes: row.fileSizeBytes ? row.fileSizeBytes.toString() : null,
          archiveEntryName: resolveClientRuntimeComponentArchiveEntryName({
            platform: row.platform,
            kind: row.kind as RuntimeComponentKind,
            fileName: row.fileName,
            originUrl,
            archiveEntryName: row.archiveEntryName
          }),
          expectedHash,
          allowClientMirror,
          originUrl,
          defaultMirrorPrefix,
          resolvedUrl: candidates[0]?.url ?? originUrl,
          candidates
        };
      })
      .filter((component) => Boolean(component.expectedHash));

    // 先过滤不可交付组件，再检查三类必要组件是否齐全，避免返回残缺计划。
    if (!hasCompleteRuntimeComponentSet(components)) {
      return {
        platform: input.platform,
        architecture: input.architecture,
        components: []
      };
    }

    return {
      platform: input.platform,
      architecture: input.architecture,
      components
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

    const componentId = normalizeNullableText(input.componentId);
    if (componentId) {
      let component: { id: string } | null;
      try {
        component = await this.prisma.runtimeComponent.findUnique({
          where: { id: componentId },
          select: { id: true }
        });
      } catch (error) {
        throwLocalReadAsServiceUnavailable(error, "Runtime component detail is temporarily unavailable.");
      }
      if (!component) {
        throw new BadRequestException("运行组件不存在。");
      }
    }

    try {
      await this.prisma.runtimeComponentFailureReport.create({
        data: {
          id: createId("rtfail"),
          componentId,
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
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "运行组件失败记录保存失败，请稍后重试。");
    }

    return { ok: true };
  }

  async getRuntimeComponentDownloadDescriptor(componentId: string) {
    let component: Awaited<ReturnType<typeof this.prisma.runtimeComponent.findUnique>>;
    try {
      component = await this.prisma.runtimeComponent.findUnique({
        where: { id: componentId }
      });
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "Runtime component download lookup is temporarily unavailable.");
    }
    if (!component || component.source !== "uploaded" || !component.storedFilePath || !component.enabled) {
      throw new NotFoundException("内核组件不存在");
    }
    const { absolutePath } = await assertStoredRuntimeComponentReadable(component);
    return {
      absolutePath,
      fileName: component.fileName ?? path.basename(absolutePath)
    };
  }

  private async ensureRuntimeComponentExists(componentId: string) {
    let existing: Awaited<ReturnType<typeof this.prisma.runtimeComponent.findUnique>>;
    try {
      existing = await this.prisma.runtimeComponent.findUnique({
        where: { id: componentId }
      });
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "Runtime component detail is temporarily unavailable.");
    }
    if (!existing) {
      throw new NotFoundException("内核组件不存在");
    }
    return existing;
  }

  private async findSharedRulesetRecord(kind: RuntimeComponentKind) {
    if (!isSharedRuleset(kind)) {
      return null;
    }
    try {
      return await this.prisma.runtimeComponent.findFirst({
        where: { kind },
        orderBy: [{ updatedAt: "desc" }]
      });
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "Shared runtime ruleset lookup is temporarily unavailable.");
    }
  }

  private publishRuntimeComponentUpdatedBestEffort() {
    try {
      this.adminRuntimeEventsService?.publishRuntimeComponentUpdated();
    } catch (error) {
      this.logger.warn(`Runtime component validation event publish failed: ${readErrorMessage(error)}`);
    }
  }

  private async persistAdminValidationFailure(
    componentId: string,
    resolvedUrl: string,
    result: AdminRuntimeComponentValidationDto
  ) {
    try {
      const component = await this.prisma.runtimeComponent.findUnique({
        where: { id: componentId },
        select: {
          id: true,
          platform: true,
          architecture: true,
          kind: true
        }
      });
      if (!component) {
        return;
      }
      await this.prisma.runtimeComponentFailureReport.create({
        data: {
          id: createId("rtfail"),
          componentId,
          platform: component.platform,
          architecture: component.architecture,
          kind: component.kind,
          reason: result.status,
          message: result.message,
          effectiveUrl: result.finalUrlPreview || resolvedUrl,
          appVersion: ADMIN_RUNTIME_VALIDATION_REPORT_VERSION,
          userId: null
        }
      });
    } catch (error) {
      this.logger.warn(`Runtime component ${componentId} validation failure report save failed: ${readErrorMessage(error)}`);
    }
  }

  private async listLatestAdminValidationFailures(componentIds: string[]) {
    const latestByComponent = new Map<
      string,
      {
        componentId: string | null;
        reason: string;
        message: string | null;
        effectiveUrl: string | null;
        createdAt: Date;
      }
    >();
    if (componentIds.length === 0) {
      return latestByComponent;
    }
    const rows = await this.prisma.runtimeComponentFailureReport.findMany({
      where: {
        componentId: { in: componentIds },
        appVersion: ADMIN_RUNTIME_VALIDATION_REPORT_VERSION
      },
      orderBy: [{ createdAt: "desc" }]
    });
    for (const row of rows) {
      if (row.componentId && !latestByComponent.has(row.componentId)) {
        latestByComponent.set(row.componentId, row);
      }
    }
    return latestByComponent;
  }

  private async cleanupSharedRulesetDuplicatesBestEffort(kind: RuntimeComponentKind, keepId: string) {
    let settled = false;
    const cleanupTask = this.cleanupSharedRulesetDuplicates(kind, keepId).then(
      () => {
        settled = true;
      },
      (error) => {
        settled = true;
        throw error;
      }
    );
    void cleanupTask.catch((error) => {
      this.logger.warn(
        `Runtime component ${keepId} saved, but delayed shared ruleset cleanup failed: ${readErrorMessage(error)}`
      );
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutTask = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        this.logger.warn(
          `Runtime component ${keepId} saved, but shared ruleset cleanup exceeded ${readSharedRulesetCleanupBudgetMs()}ms and will continue in background.`
        );
        resolve();
      }, readSharedRulesetCleanupBudgetMs());
    });

    try {
      await Promise.race([cleanupTask, timeoutTask]);
    } catch (error) {
      this.logger.warn(
        `Runtime component ${keepId} saved, but shared ruleset cleanup failed: ${readErrorMessage(error)}`
      );
    } finally {
      if (settled && timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private startSharedRulesetDuplicatesCleanup(kind: RuntimeComponentKind, keepId: string) {
    const timer = setTimeout(() => {
      void this.cleanupSharedRulesetDuplicatesBestEffort(kind, keepId).catch((error) => {
        this.logger.warn(`Runtime component ${keepId} saved, but background shared ruleset cleanup failed: ${readErrorMessage(error)}`);
      });
    }, 0);
    timer.unref?.();
  }

  private async removeRuntimeComponentFileBestEffort(absolutePath: string | null, label: string) {
    if (!absolutePath) {
      return;
    }
    let settled = false;
    const cleanupTask = removeRuntimeComponentFile(absolutePath).then(
      () => {
        settled = true;
      },
      (error) => {
        settled = true;
        throw error;
      }
    );
    void cleanupTask.catch((error) => {
      this.logger.warn(`Runtime component saved, but delayed ${label} cleanup failed: ${readErrorMessage(error)}`);
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutTask = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        this.logger.warn(
          `Runtime component saved, but ${label} cleanup exceeded ${readRuntimeComponentFileCleanupBudgetMs()}ms and will continue in background.`
        );
        resolve();
      }, readRuntimeComponentFileCleanupBudgetMs());
    });

    try {
      await Promise.race([cleanupTask, timeoutTask]);
    } catch (error) {
      this.logger.warn(`Runtime component saved, but ${label} cleanup failed: ${readErrorMessage(error)}`);
    } finally {
      if (settled && timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private startRuntimeComponentFileCleanupBestEffort(absolutePath: string | null, label: string) {
    if (!absolutePath) {
      return;
    }
    const timer = setTimeout(() => {
      void this.removeRuntimeComponentFileBestEffort(absolutePath, label).catch((error) => {
        this.logger.warn(`Runtime component saved, but background ${label} cleanup failed: ${readErrorMessage(error)}`);
      });
    }, 0);
    timer.unref?.();
  }

  private startRuntimeComponentStoredFileCleanupBestEffort(storedFilePath: string | null, label: string) {
    if (!storedFilePath) {
      return;
    }
    const timer = setTimeout(() => {
      let absolutePath: string;
      try {
        absolutePath = resolveRuntimeComponentAbsolutePath(storedFilePath);
      } catch (error) {
        this.logger.warn(`Runtime component saved, but ${label} cleanup path is invalid: ${readErrorMessage(error)}`);
        return;
      }
      void this.removeRuntimeComponentFileBestEffort(absolutePath, label).catch((error) => {
        this.logger.warn(`Runtime component saved, but background ${label} cleanup failed: ${readErrorMessage(error)}`);
      });
    }, 0);
    timer.unref?.();
  }

  private async validateUploadedRuntimeComponent(
    componentId: string,
    component: {
      storedFilePath: string | null;
      fileHash: string | null;
      expectedHash: string | null;
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

    try {
      const metadata = await assertStoredRuntimeComponentReadable(component);
      return {
        componentId,
        status: "ready",
        message: "已上传组件可用，客户端下载地址和文件元信息已匹配。",
        finalUrlPreview: resolvedUrl,
        actualFileSizeBytes: metadata.fileSizeBytes.toString(),
        actualFileHash: metadata.fileHash
      };
    } catch (error) {
      return {
        componentId,
        status: error instanceof NotFoundException ? "missing_file" : "metadata_mismatch",
        message: "服务器文件存在状态或元数据异常，建议重新上传覆盖。",
        finalUrlPreview: resolvedUrl
      };
    }
  }

  private async prepareUploadedRuntimeComponentFile(
    componentId: string,
    file: UploadedRuntimeComponentFile,
    preferredFileName?: string | null
  ) {
    const finalFileName = sanitizeStoredFileName(preferredFileName?.trim() || file.originalname || `${componentId}.bin`);
    const storedFilePath = path.join(componentId, `${createId("file")}_${finalFileName}`);
    const absolutePath = resolveRuntimeComponentAbsolutePath(storedFilePath);

    try {
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await moveUploadedFile(file.path, absolutePath);

      return {
        absolutePath,
        storedFilePath,
        fileName: finalFileName,
        fileSizeBytes: BigInt(file.size),
        fileHash: await calculateFileSha256(absolutePath),
        downloadUrl: buildRuntimeComponentDownloadUrl(componentId)
      };
    } catch (error) {
      throw mapUploadedFilePreparationError(error, "runtime component upload");
    }
  }

  private async withRuntimeComponentIdentityConflictGuard<T>(
    task: () => Promise<T>,
    localSaveFailureMessage = "内核组件保存失败，请刷新后重试。"
  ): Promise<T> {
    try {
      return await task();
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) {
        throw new ConflictException("相同平台、架构和类型的内核组件已存在。");
      }
      throwLocalSaveAsServiceUnavailable(error, localSaveFailureMessage);
    }
  }
}


function normalizeMirrorPrefixList(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  const parts = value
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return null;
  }
  return parts.join("\n");
}

function splitMirrorPrefixes(value: string | null | undefined) {
  const normalized = normalizeMirrorPrefixList(value);
  if (!normalized) {
    return [] as string[];
  }
  return normalized.split("\n").map((item) => item.trim()).filter(Boolean);
}

function applyRuntimeMirrorPrefix(originUrl: string, mirrorPrefix: string) {
  const prefix = mirrorPrefix.trim();
  if (!prefix) {
    return originUrl;
  }
  if (prefix.includes("{url}")) {
    return prefix.replaceAll("{url}", originUrl);
  }
  if (prefix.endsWith("/")) {
    return `${prefix}${originUrl}`;
  }
  return `${prefix}/${originUrl}`;
}

function buildRuntimeComponentDownloadCandidates(input: {
  originUrl: string;
  defaultMirrorPrefix?: string | null;
  clientMirrorPrefix?: string | null;
}) {
  const candidates: Array<{ label: "client_mirror" | "default_mirror" | "origin"; url: string }> = [];
  const seen = new Set<string>();
  const push = (label: "client_mirror" | "default_mirror" | "origin", url: string) => {
    const normalized = url.trim();
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    candidates.push({ label, url: normalized });
  };

  for (const prefix of splitMirrorPrefixes(input.clientMirrorPrefix)) {
    push("client_mirror", applyRuntimeMirrorPrefix(input.originUrl, prefix));
  }
  for (const prefix of splitMirrorPrefixes(input.defaultMirrorPrefix)) {
    push("default_mirror", applyRuntimeMirrorPrefix(input.originUrl, prefix));
  }
  push("origin", input.originUrl);
  return candidates;
}


function resolveClientRuntimeComponentArchiveEntryName(input: {
  platform?: string;
  kind: RuntimeComponentKind;
  fileName: string;
  originUrl: string;
  archiveEntryName: string | null | undefined;
}) {
  const explicit = normalizeNullableText(input.archiveEntryName);
  if (explicit) {
    return explicit;
  }

  const references = [input.fileName, input.originUrl].map((value) => String(value ?? "").toLowerCase());
  const looksLikeZip = references.some((value) => value.includes(".zip"));
  if (!looksLikeZip) {
    return null;
  }

  if (input.kind === "xray") {
    if (input.platform === "windows" || references.some((value) => value.includes("windows"))) {
      return "xray.exe";
    }
    return "xray";
  }
  if (input.kind === "geoip") {
    return "geoip.dat";
  }
  if (input.kind === "geosite") {
    return "geosite.dat";
  }
  return null;
}

function resolveRuntimeComponentUrl(
  component: {
    source?: "uploaded" | "github_remote" | "custom_remote";
    originUrl: string;
  },
  _clientMirrorPrefix: string | null | undefined
) {
  return component.originUrl.trim();
}

async function toAdminRuntimeComponentRecord(row: {
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
}, latestValidationFailure: {
  reason: string;
  message: string | null;
  effectiveUrl: string | null;
  createdAt: Date;
} | null = null): Promise<AdminRuntimeComponentRecordDto> {
  const clientDelivery = await resolveAdminRuntimeComponentClientDelivery(row, latestValidationFailure);
  return {
    id: row.id,
    platform: row.platform,
    architecture: row.architecture,
    kind: row.kind,
    source: row.source,
    originUrl: row.originUrl,
    defaultMirrorPrefix: normalizeMirrorPrefixList(row.defaultMirrorPrefix),
    allowClientMirror: Boolean(row.allowClientMirror),
    fileName: row.fileName,
    fileSizeBytes: row.fileSizeBytes ? row.fileSizeBytes.toString() : null,
    fileHash: row.fileHash,
    archiveEntryName: row.archiveEntryName,
    expectedHash: row.expectedHash,
    enabled: row.enabled,
    clientDeliverable: clientDelivery.deliverable,
    clientDeliveryStatus: clientDelivery.status,
    clientDeliveryMessage: clientDelivery.message,
    finalUrlPreview: resolveRuntimeComponentUrl(row, null),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}


function normalizeSha256Hex(value: string | null | undefined) {
  const raw = value?.trim() ?? "";
  if (!/^[a-fA-F0-9]{64}$/.test(raw)) {
    return null;
  }
  return raw.toLowerCase();
}

function requireRuntimeComponentSha256(value: string | null | undefined) {
  const normalized = normalizeSha256Hex(value);
  if (!normalized) {
    throw new BadRequestException("远程运行组件必须提供有效的 64 位 SHA-256 expectedHash。");
  }
  return normalized;
}
function hasValidRuntimeComponentHash(row: {
  source?: string;
  fileHash?: string | null;
  expectedHash?: string | null;
}) {
  // 上传型以服务端落盘 fileHash 为准；远程型允许 fileHash 或 expectedHash。
  if (row.source === "uploaded") {
    return Boolean(normalizeSha256Hex(row.fileHash));
  }
  return Boolean(normalizeSha256Hex(row.fileHash ?? row.expectedHash));
}

async function resolveAdminRuntimeComponentClientDelivery(row: {
  source: "uploaded" | "github_remote" | "custom_remote";
  originUrl: string;
  storedFilePath: string | null;
  fileSizeBytes: bigint | null;
  fileHash: string | null;
  expectedHash: string | null;
  enabled: boolean;
  updatedAt: Date;
}, latestValidationFailure: {
  reason: string;
  message: string | null;
  effectiveUrl: string | null;
  createdAt: Date;
} | null = null): Promise<{
  deliverable: boolean;
  status: NonNullable<AdminRuntimeComponentRecordDto["clientDeliveryStatus"]>;
  message: string;
}> {
  if (!row.enabled) {
    return {
      deliverable: false,
      status: "disabled",
      message: "该组件已停用，客户端不会获取。"
    };
  }
  if (row.source === "uploaded") {
    if (!row.storedFilePath) {
      return {
        deliverable: false,
        status: "missing_file",
        message: "上传型组件缺少服务器文件记录，不会下发给客户端。"
      };
    }
    try {
      await assertStoredRuntimeComponentReadable(row);
    } catch (error) {
      return {
        deliverable: false,
        status: "missing_file",
        message: `上传型组件服务器文件不可用，不会下发给客户端：${readErrorMessage(error)}`
      };
    }
    if (!hasValidRuntimeComponentHash(row)) {
      return {
        deliverable: false,
        status: "missing_file",
        message: "组件缺少有效的 SHA-256 校验值，不会下发给客户端。"
      };
    }
    return {
      deliverable: true,
      status: "ready",
      message: "上传型组件会从本服务器下发给客户端。"
    };
  }
  if (!isHttpUrl(row.originUrl)) {
    return {
      deliverable: false,
      status: "invalid_url",
      message: "远程直链不是有效的 http/https 地址，不会下发给客户端。"
    };
  }
  if (!hasValidRuntimeComponentHash(row)) {
    return {
      deliverable: false,
      status: "missing_file",
      message: "远程组件缺少有效的 SHA-256 校验值，不会下发给客户端。"
    };
  }
  return {
    deliverable: true,
    status: "ready",
    message: "远程更新地址有效，可下发给客户端。"
  };
}

function toRuntimeComponentDeliveryStatus(reason: string): NonNullable<AdminRuntimeComponentRecordDto["clientDeliveryStatus"]> {
  if (
    reason === "metadata_mismatch" ||
    reason === "missing_file" ||
    reason === "invalid_url" ||
    reason === "unreachable" ||
    reason === "save_failed"
  ) {
    return reason;
  }
  return "unreachable";
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

function hasCompleteRuntimeComponentSet(rows: Array<{ kind: string }>) {
  const kinds = new Set(rows.map((row) => row.kind));
  return kinds.has("xray") && kinds.has("geoip") && kinds.has("geosite");
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

function isPrivateOrReservedRuntimeComponentUrl(value: string) {
  if (process.env.CHORDV_ALLOW_PRIVATE_REMOTE_URLS === "true") {
    return false;
  }
  let hostname: string;
  try {
    hostname = new URL(value).hostname;
  } catch {
    return false;
  }
  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    const parts = hostname.split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return true;
    }
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  if (ipVersion === 6) {
    const normalized = hostname.toLowerCase();
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("ff")
    );
  }
  return false;
}

function normalizeRequiredText(value: string | null | undefined, fieldName: string) {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new BadRequestException(`${translateRuntimeComponentField(fieldName)}不能为空。`);
  }
  return trimmed;
}





function readSharedRulesetCleanupBudgetMs() {
  return readPositiveIntegerEnv("CHORDV_SHARED_RULESET_CLEANUP_BUDGET_MS", DEFAULT_SHARED_RULESET_CLEANUP_BUDGET_MS);
}

function readRuntimeComponentFileCleanupBudgetMs() {
  return readPositiveIntegerEnv(
    "CHORDV_RUNTIME_COMPONENT_FILE_CLEANUP_BUDGET_MS",
    DEFAULT_RUNTIME_COMPONENT_FILE_CLEANUP_BUDGET_MS
  );
}

function readPositiveIntegerEnv(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function parseContentLength(value: string | null) {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function filterClientUsableRuntimeComponents<T extends {
  source: string;
  storedFilePath: string | null;
  originUrl: string;
  fileSizeBytes?: bigint | number | null;
  fileHash?: string | null;
  expectedHash?: string | null;
}>(rows: T[]) {
  const usableRows: T[] = [];
  for (const row of rows) {
    if (row.source !== "uploaded") {
      if (isHttpUrl(row.originUrl)) {
        usableRows.push(row);
      }
      continue;
    }
    if (!row.storedFilePath) {
      continue;
    }
    try {
      await assertStoredRuntimeComponentReadable(row);
      usableRows.push(row);
    } catch {
      continue;
    }
  }
  return usableRows;
}

function hasPositiveFileSize(value: bigint | number | null | undefined) {
  if (typeof value === "bigint") {
    return value > 0n;
  }
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function toBigInt(value: bigint | number | null | undefined) {
  if (typeof value === "bigint") {
    return value;
  }
  return typeof value === "number" && Number.isFinite(value) ? BigInt(value) : null;
}


async function assertStoredRuntimeComponentReadable(component: {
  storedFilePath: string | null;
  fileSizeBytes?: bigint | number | null;
  fileHash?: string | null;
  expectedHash?: string | null;
}) {
  if (!component.storedFilePath) {
    throw new NotFoundException("上传型运行组件缺少已保存文件。");
  }
  const absolutePath = resolveRuntimeComponentAbsolutePath(component.storedFilePath);
  await ensureFileReadable(absolutePath);
  const stat = await statReadableFile(absolutePath);
  const actualSize = BigInt(stat.size);
  if (!hasPositiveFileSize(component.fileSizeBytes) || toBigInt(component.fileSizeBytes) !== actualSize) {
    throw new BadRequestException("上传型运行组件的文件大小元数据与已保存文件不一致。");
  }
  const expectedHash = (component.fileHash ?? component.expectedHash ?? "").trim();
  if (!expectedHash) {
    throw new BadRequestException("上传型运行组件缺少 SHA-256 校验值。");
  }
  if (!/^[a-fA-F0-9]{64}$/.test(expectedHash)) {
    throw new BadRequestException("上传型运行组件 SHA-256 校验值无效。");
  }
  const actualHash = await calculateFileSha256(absolutePath);
  if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new BadRequestException("上传型运行组件文件内容与 SHA-256 校验值不一致。");
  }
  return {
    absolutePath,
    fileSizeBytes: actualSize,
    fileHash: actualHash
  };
}



function readErrorMessage(error: unknown) {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : String(error);
}

function toUserRuntimeValidationMessage(error: unknown) {
  const message = readErrorMessage(error);
  if (/private or reserved/i.test(message)) {
    return "不能使用内网或保留地址。";
  }
  if (/HTTP\s*(\d+)/i.test(message)) {
    return `远程服务返回 HTTP ${RegExp.$1}。`;
  }
  if (/too large/i.test(message)) {
    return "远程文件超过允许大小。";
  }
  if (/timed out|timeout|aborted|abort/i.test(message)) {
    return "请求超时，请稍后重试。";
  }
  if (/fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|socket/i.test(message)) {
    return "网络连接失败，请检查下载地址。";
  }
  return "请检查下载地址是否可直接访问。";
}

function translateRuntimeComponentField(fieldName: string) {
  if (fieldName === "fileName") {
    return "输出文件名";
  }
  if (fieldName === "originUrl") {
    return "远程直链下载地址";
  }
  return fieldName;
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
  const storageRoot = runtimeComponentStorageRoot();
  const resolvedPath = path.resolve(storageRoot, storedFilePath);
  assertPathInsideRoot(storageRoot, resolvedPath);
  return resolvedPath;
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
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new NotFoundException("文件不存在或已丢失");
    }
    throw new ServiceUnavailableException("文件暂不可读，请检查服务器磁盘、目录权限或文件存储状态。");
  }
}

async function statReadableFile(filePath: string) {
  try {
    return await fs.stat(filePath);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new NotFoundException("文件不存在或已丢失");
    }
    throw new ServiceUnavailableException("文件暂不可读，请检查服务器磁盘、目录权限或文件存储状态。");
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
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function isPrismaUniqueConstraintError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

function mapUploadedFilePreparationError(error: unknown, label: string) {
  if (error instanceof BadRequestException || error instanceof NotFoundException || error instanceof ConflictException) {
    return error;
  }
  const code = readErrorCode(error);
  if (code === "ENOSPC" || code === "EACCES" || code === "EPERM") {
    return new ServiceUnavailableException(`${translateUploadPreparationLabel(label)}存储暂不可用，请检查服务器磁盘空间或目录权限。`);
  }
  if (code === "ENOENT") {
    return new BadRequestException(`${translateUploadPreparationLabel(label)}临时文件不存在，请重新选择文件后再上传。`);
  }
  return new ServiceUnavailableException(`${translateUploadPreparationLabel(label)}文件处理失败，请稍后重试。`);
}

function readErrorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : null;
}

function translateUploadPreparationLabel(label: string) {
  if (label === "runtime component upload") {
    return "运行组件上传";
  }
  return label;
}

function assertPathInsideRoot(storageRoot: string, resolvedPath: string) {
  const relativePath = path.relative(storageRoot, resolvedPath);
  if (relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))) {
    return;
  }
  throw new BadRequestException("已保存的运行组件路径超出存储目录。");
}
