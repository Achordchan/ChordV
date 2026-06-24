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
import { readZipEntryData } from "./release-center.utils";
import { fetchPublicHttpUrl } from "./remote-url.utils";
import { AdminRuntimeEventsService } from "./admin-runtime-events.service";

const RUNTIME_COMPONENT_DOWNLOAD_PREFIX = "/api/downloads/runtime-components";
const SHARED_RULESET_PLATFORM: PlatformTarget = "macos";
const SHARED_RULESET_ARCHITECTURE: RuntimeComponentArchitecture = "arm64";
const DEFAULT_REMOTE_RUNTIME_HASH_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_REMOTE_RUNTIME_HASH_TOTAL_TIMEOUT_MS = 15 * 1000;
const DEFAULT_REMOTE_RUNTIME_HASH_IDLE_TIMEOUT_MS = 5 * 1000;
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
    const expectedHash = normalizeExpectedHash(input.expectedHash);
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
              defaultMirrorPrefix: null,
              allowClientMirror: false,
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
          defaultMirrorPrefix: null,
          allowClientMirror: false,
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
              expectedHash: expectedHashForUploadedFile(preparedFile.fileHash),
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
    const normalizedExpectedHash =
      nextSource === "uploaded"
        ? input.expectedHash !== undefined
          ? expectedHashForUploadedFile(current.fileHash)
          : current.expectedHash
        : input.expectedHash !== undefined
          ? normalizeExpectedHash(input.expectedHash)
          : current.expectedHash;
    const remoteValidationInvalidated =
      nextSource !== "uploaded" &&
      (current.source === "uploaded" ||
        nextSource !== current.source ||
        nextOriginUrl !== current.originUrl ||
        normalizedExpectedHash !== current.expectedHash);
    const staleUploadedFilePath =
      remoteValidationInvalidated && current.storedFilePath ? current.storedFilePath : null;

    const updated = await this.withRuntimeComponentIdentityConflictGuard(() =>
      this.prisma.runtimeComponent.update({
        where: { id: componentId },
        data: {
          ...(input.source !== undefined ? { source: input.source } : {}),
          ...(input.originUrl !== undefined ? { originUrl: nextOriginUrl } : {}),
          ...(nextSource !== "uploaded" ? { defaultMirrorPrefix: null, allowClientMirror: false } : {}),
          ...(input.fileName !== undefined ? { fileName: nextFileName } : {}),
          ...(input.archiveEntryName !== undefined ? { archiveEntryName: normalizeNullableText(input.archiveEntryName) } : {}),
          ...(input.expectedHash !== undefined ? { expectedHash: normalizedExpectedHash } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
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
              expectedHash: expectedHashForUploadedFile(preparedFile.fileHash),
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

    try {
      if (component.expectedHash) {
        if (isPrivateOrReservedRuntimeComponentUrl(resolvedUrl)) {
          return {
            componentId,
            status: "unreachable",
            message: "远程运行组件链接指向内网或保留地址，不允许校验。",
            finalUrlPreview: resolvedUrl
          };
        }
        if (process.env.CHORDV_ALLOW_PRIVATE_REMOTE_URLS === "true") {
          const result = await this.validateRemoteRuntimeComponentHash(
            componentId,
            resolvedUrl,
            component.expectedHash,
            component.archiveEntryName
          );
          this.publishRuntimeComponentUpdatedBestEffort();
          return result;
        }
        this.startRemoteRuntimeComponentValidation(componentId, resolvedUrl, component.expectedHash, component.archiveEntryName);
        return {
          componentId,
          status: "pending_validation",
          message: "Remote runtime component validation has started in background. Refresh this list later for the latest result.",
          finalUrlPreview: resolvedUrl
        };
      }
      return {
        componentId,
        status: "metadata_mismatch",
        message: "远程内核组件缺少 SHA256 expectedHash，当前 Windows 客户端暂不能下发该组件。请填写校验哈希后重新验证。",
        finalUrlPreview: resolvedUrl
      };
    } catch (error) {
      return {
        componentId,
        status: "unreachable",
        message: `当前链接不可访问：${toUserRuntimeValidationMessage(error)}`,
        finalUrlPreview: resolvedUrl
      };
    }
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

    if (!hasCompleteRuntimeComponentSet(rows)) {
      return {
        platform: input.platform,
        architecture: input.architecture,
        components: []
      };
    }

    return {
      platform: input.platform,
      architecture: input.architecture,
      components: rows.map((row) => {
        const originUrl = row.originUrl.trim();
        const defaultMirrorPrefix = null;
        const allowClientMirror = false;
        const candidates = [{ label: "origin" as const, url: originUrl }];

        return {
          id: row.id,
          platform: row.platform,
          architecture: row.architecture as RuntimeComponentArchitecture,
          kind: row.kind as RuntimeComponentKind,
          fileName: row.fileName,
          fileSizeBytes: row.fileSizeBytes ? row.fileSizeBytes.toString() : null,
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

  private startRemoteRuntimeComponentValidation(
    componentId: string,
    resolvedUrl: string,
    expectedHash: string,
    archiveEntryName: string | null
  ) {
    const timer = setTimeout(() => {
      void this.validateRemoteRuntimeComponentHash(componentId, resolvedUrl, expectedHash, archiveEntryName)
        .then((result) => {
          if (result.status !== "ready") {
            this.logger.warn(`Runtime component ${componentId} background validation finished with ${result.status}: ${result.message}`);
            return this.persistAdminValidationFailure(componentId, resolvedUrl, result);
          }
          return undefined;
        })
        .catch((error) => {
          const message = readErrorMessage(error);
          this.logger.warn(`Runtime component ${componentId} background validation failed: ${message}`);
          return this.persistAdminValidationFailure(componentId, resolvedUrl, {
            componentId,
            status: "unreachable",
            message,
            finalUrlPreview: resolvedUrl
          });
        })
        .finally(() => {
          this.publishRuntimeComponentUpdatedBestEffort();
        });
    }, 0);
    timer.unref?.();
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

  private async validateRemoteRuntimeComponentHash(
    componentId: string,
    resolvedUrl: string,
    expectedHash: string,
    archiveEntryName: string | null
  ): Promise<AdminRuntimeComponentValidationDto> {
    const limits = getRemoteRuntimeHashLimits();
    const controller = new AbortController();
    let timeoutReason: "total" | "idle" | null = null;
    const archiveDownloadPath = archiveEntryName
      ? path.join(tmpdir(), `chordv-runtime-component-${randomUUID()}.download`)
      : null;
    const totalTimeout = setTimeout(() => {
      timeoutReason = "total";
      controller.abort();
    }, limits.totalTimeoutMs);
    try {
      const { response } = await fetchPublicHttpUrl(resolvedUrl, { method: "GET", signal: controller.signal }, {
        errorPrefix: "Remote runtime component URL"
      });
      if (!response.ok) {
        return {
          componentId,
          status: "unreachable",
          message: `远程组件当前不可访问，HTTP ${response.status}。`,
          finalUrlPreview: resolvedUrl,
          httpStatus: response.status
        };
      }

      const contentLength = parseContentLength(response.headers.get("content-length"));
      if (contentLength !== null && contentLength > limits.maxBytes) {
        return {
          componentId,
          status: "metadata_mismatch",
          message: `远程组件文件过大：${contentLength} 字节，超过 ${limits.maxBytes} 字节限制。`,
          finalUrlPreview: resolvedUrl,
          httpStatus: response.status
        };
      }

      const metadata = await hashResponseBody(response, {
        maxBytes: limits.maxBytes,
        idleTimeoutMs: limits.idleTimeoutMs,
        writePath: archiveDownloadPath,
        onIdleTimeout: () => {
          timeoutReason = "idle";
          controller.abort();
        }
      });
      const actualFileHash = archiveEntryName
        ? createHash("sha256")
            .update(await readZipEntryData(archiveDownloadPath as string, archiveEntryName))
            .digest("hex")
        : metadata.fileHash;
      if (actualFileHash !== expectedHash) {
        return {
          componentId,
          status: "metadata_mismatch",
          message: "远程组件 SHA256 与预期 Hash 不一致。",
          finalUrlPreview: resolvedUrl,
          httpStatus: response.status
        };
      }

      try {
        await this.prisma.runtimeComponent.update({
          where: { id: componentId },
          data: {
            fileSizeBytes: metadata.fileSizeBytes,
            fileHash: actualFileHash,
            expectedHash
          }
        });
      } catch (error) {
        return {
          componentId,
          status: "save_failed",
          message: "远程组件可访问且 Hash 匹配，但保存校验结果失败，请稍后重试。",
          finalUrlPreview: resolvedUrl,
          httpStatus: response.status,
          actualFileSizeBytes: metadata.fileSizeBytes.toString(),
          actualFileHash
        };
      }

      return {
        componentId,
        status: "ready",
        message: "远程组件可访问，SHA256 已匹配。",
        finalUrlPreview: resolvedUrl,
        httpStatus: response.status,
        actualFileSizeBytes: metadata.fileSizeBytes.toString(),
        actualFileHash
      };
    } catch (error) {
      if (error instanceof RemoteRuntimeHashSizeError) {
        controller.abort();
        return {
          componentId,
          status: "metadata_mismatch",
          message: error.message,
          finalUrlPreview: resolvedUrl
        };
      }
      if (timeoutReason) {
        const timeoutMs = timeoutReason === "total" ? limits.totalTimeoutMs : limits.idleTimeoutMs;
        return {
          componentId,
          status: "unreachable",
          message: `远程组件下载校验超时：${timeoutMs}ms（${timeoutReason === "total" ? "总耗时" : "读数据空闲"}）。`,
          finalUrlPreview: resolvedUrl
        };
      }
      throw error;
    } finally {
      clearTimeout(totalTimeout);
      if (archiveDownloadPath) {
        this.startRuntimeComponentFileCleanupBestEffort(archiveDownloadPath, "temporary remote runtime archive");
      }
    }
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
    defaultMirrorPrefix: null,
    allowClientMirror: false,
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
  if (latestValidationFailure && latestValidationFailure.createdAt.getTime() >= row.updatedAt.getTime()) {
    const status = toRuntimeComponentDeliveryStatus(latestValidationFailure.reason);
    return {
      deliverable: false,
      status,
      message: latestValidationFailure.message ?? "后台校验失败，客户端不会获取该组件。"
    };
  }
  if (!hasPositiveFileSize(row.fileSizeBytes)) {
    return {
      deliverable: false,
      status: "pending_validation",
      message: "远程直链还没有文件大小，校验前不会下发。"
    };
  }
  const expectedHash = isValidSha256(row.expectedHash) ? row.expectedHash.toLowerCase() : null;
  const fileHash = isValidSha256(row.fileHash) ? row.fileHash.toLowerCase() : null;
  if (!expectedHash) {
    return {
      deliverable: false,
      status: "missing_hash",
      message: "远程直链缺少 expectedHash，不会下发给客户端。"
    };
  }
  if (!fileHash) {
    return {
      deliverable: false,
      status: "pending_validation",
      message: "远程直链还没有校验结果，不会下发给客户端。"
    };
  }
  if (fileHash !== expectedHash) {
    return {
      deliverable: false,
      status: "metadata_mismatch",
      message: "远程文件 Hash 与预期不一致，不会下发给客户端。"
    };
  }
  return {
    deliverable: true,
    status: "ready",
    message: "远程直链已校验通过，可下发给客户端。"
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

function normalizeExpectedHash(value?: string | null) {
  const normalized = normalizeNullableText(value);
  if (!normalized) {
    return null;
  }
  if (!/^[a-f0-9]{64}$/i.test(normalized)) {
    throw new BadRequestException("校验值 SHA256 必须是 64 位十六进制字符串。");
  }
  return normalized.toLowerCase();
}

function expectedHashForUploadedFile(fileHash: string | null | undefined) {
  return isValidSha256(fileHash) ? fileHash.toLowerCase() : null;
}


async function hashResponseBody(
  response: { body: any },
  options: {
    maxBytes: number;
    idleTimeoutMs: number;
    writePath?: string | null;
    onIdleTimeout: () => void;
  }
) {
  const hash = createHash("sha256");
  let fileSizeBytes = 0n;
  if (!response.body) {
    return {
      fileSizeBytes,
      fileHash: hash.digest("hex")
    };
  }

  const reader = response.body.getReader() as {
    read: () => Promise<{ done: boolean; value?: Uint8Array }>;
    releaseLock: () => void;
  };
  const output = options.writePath ? await fs.open(options.writePath, "w") : null;
  try {
    while (true) {
      const { done, value } = await readRuntimeComponentBodyChunkWithIdleTimeout(
        reader,
        options.idleTimeoutMs,
        options.onIdleTimeout
      );
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      hash.update(value);
      if (output) {
        await output.write(value);
      }
      fileSizeBytes += BigInt(value.byteLength);
      if (fileSizeBytes > BigInt(options.maxBytes)) {
        throw new RemoteRuntimeHashSizeError(`远程组件文件过大：已下载内容超过 ${options.maxBytes} 字节限制。`);
      }
    }
  } finally {
    if (output) {
      await output.close();
    }
    reader.releaseLock();
  }

  return {
    fileSizeBytes,
    fileHash: hash.digest("hex")
  };
}

async function readRuntimeComponentBodyChunkWithIdleTimeout(
  reader: {
    read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  },
  idleTimeoutMs: number,
  onIdleTimeout: () => void
) {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutTask = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      onIdleTimeout();
      reject(new Error("远程组件下载读数据超时。"));
    }, idleTimeoutMs);
    timeoutHandle.unref?.();
  });
  try {
    return await Promise.race([reader.read(), timeoutTask]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
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
  if (!isValidSha256(component.fileHash)) {
    throw new BadRequestException("上传型运行组件缺少 SHA256 元数据。");
  }
  return {
    absolutePath,
    fileSizeBytes: actualSize,
    fileHash: component.fileHash
  };
}

class RemoteRuntimeHashSizeError extends Error {}

function getRemoteRuntimeHashLimits() {
  return {
    maxBytes: readPositiveIntegerEnv("CHORDV_RUNTIME_REMOTE_HASH_MAX_BYTES", DEFAULT_REMOTE_RUNTIME_HASH_MAX_BYTES),
    totalTimeoutMs: readPositiveIntegerEnv(
      "CHORDV_RUNTIME_REMOTE_HASH_TOTAL_TIMEOUT_MS",
      DEFAULT_REMOTE_RUNTIME_HASH_TOTAL_TIMEOUT_MS
    ),
    idleTimeoutMs: readPositiveIntegerEnv(
      "CHORDV_RUNTIME_REMOTE_HASH_IDLE_TIMEOUT_MS",
      DEFAULT_REMOTE_RUNTIME_HASH_IDLE_TIMEOUT_MS
    )
  };
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
      const rawExpectedHash = row.expectedHash;
      const rawFileHash = row.fileHash;
      const expectedHash = isValidSha256(rawExpectedHash) ? rawExpectedHash.toLowerCase() : null;
      const fileHash = isValidSha256(rawFileHash) ? rawFileHash.toLowerCase() : null;
      if (
        isHttpUrl(row.originUrl) &&
        hasPositiveFileSize(row.fileSizeBytes) &&
        expectedHash !== null &&
        fileHash !== null &&
        fileHash === expectedHash
      ) {
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

function isValidSha256(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
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
