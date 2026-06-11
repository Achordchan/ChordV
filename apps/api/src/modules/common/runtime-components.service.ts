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
import { tmpdir } from "node:os";
import * as path from "node:path";
import { PrismaService } from "./prisma.service";
import { throwPrismaTransientAsServiceUnavailable } from "./prisma-error.utils";
import { AuthSessionService } from "./auth-session.service";
import { moveUploadedFile } from "./upload-file.utils";
import { readZipEntryData } from "./release-center.utils";
import { fetchPublicHttpUrl } from "./remote-url.utils";

const RUNTIME_COMPONENT_DOWNLOAD_PREFIX = "/api/downloads/runtime-components";
const SHARED_RULESET_PLATFORM: PlatformTarget = "macos";
const SHARED_RULESET_ARCHITECTURE: RuntimeComponentArchitecture = "arm64";
const DEFAULT_REMOTE_RUNTIME_HASH_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_REMOTE_RUNTIME_HASH_TOTAL_TIMEOUT_MS = 15 * 1000;
const DEFAULT_REMOTE_RUNTIME_HASH_IDLE_TIMEOUT_MS = 5 * 1000;
const DEFAULT_SHARED_RULESET_CLEANUP_BUDGET_MS = 300;
const DEFAULT_RUNTIME_COMPONENT_FILE_CLEANUP_BUDGET_MS = 300;

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
    private readonly authSessionService: AuthSessionService
  ) {}

  async listAdminRuntimeComponents(): Promise<AdminRuntimeComponentRecordDto[]> {
    const rows = await this.prisma.runtimeComponent.findMany({
      orderBy: [{ updatedAt: "desc" }, { platform: "asc" }, { architecture: "asc" }, { kind: "asc" }]
    });
    return dedupeSharedRulesets(rows).map(toAdminRuntimeComponentRecord);
  }

  async createAdminRuntimeComponent(input: CreateRuntimeComponentInputDto): Promise<AdminRuntimeComponentRecordDto> {
    const rawSource = (input as { source?: string }).source;
    if (rawSource === "uploaded") {
      throw new BadRequestException("Uploaded runtime components must be created through the upload endpoint.");
    }
    const originUrl = input.originUrl?.trim();
    if (!originUrl || !isHttpUrl(originUrl)) {
      throw new BadRequestException("Remote runtime components require a valid HTTP(S) origin URL.");
    }
    const source = input.source ?? "github_remote";
    const expectedHash = normalizeExpectedHash(input.expectedHash);
    const normalizedInput = normalizeRuntimeComponentIdentity(input.platform, input.architecture, input.kind);
    const fileName = normalizeRequiredText(input.fileName, "fileName");
    if (isSharedRuleset(input.kind)) {
      const existing = await this.findSharedRulesetRecord(input.kind);
      if (existing) {
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
        await this.cleanupSharedRulesetDuplicatesBestEffort(input.kind, updated.id);
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
      const expectedHash = normalizeExpectedHash(input.expectedHash);
      assertExpectedHashMatchesFile(expectedHash, preparedFile.fileHash);
      const created = await this.withRuntimeComponentIdentityConflictGuard(() =>
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
            expectedHash: expectedHash ?? preparedFile.fileHash,
            enabled: input.enabled ?? true
          }
        })
      );
      await this.cleanupSharedRulesetDuplicatesBestEffort(input.kind, created.id);
      return toAdminRuntimeComponentRecord(created);
    } catch (error) {
      await this.removeRuntimeComponentFileBestEffort(
        prepared ? prepared.absolutePath : file.path,
        "failed runtime component upload"
      );
      throwPrismaTransientAsServiceUnavailable(error, "内核组件保存暂时繁忙，请刷新后重试；已清理本次上传文件。");
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
      throw new BadRequestException("Uploaded runtime components must be created through the upload endpoint.");
    }
    if (nextSource === "uploaded" && input.originUrl !== undefined && nextOriginUrl !== current.originUrl) {
      throw new BadRequestException("Uploaded runtime component URLs are managed by the upload endpoint.");
    }
    if (nextSource === "uploaded" && !current.storedFilePath) {
      throw new BadRequestException("Uploaded runtime component is missing its stored file.");
    }
    if (nextSource !== "uploaded" && (!nextOriginUrl || !isHttpUrl(nextOriginUrl))) {
      throw new BadRequestException("Remote runtime components require a valid HTTP(S) origin URL.");
    }
    const normalizedExpectedHash =
      input.expectedHash !== undefined ? normalizeExpectedHash(input.expectedHash) : current.expectedHash;
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
    await this.cleanupSharedRulesetDuplicatesBestEffort(updated.kind as RuntimeComponentKind, updated.id);
    await this.removeRuntimeComponentFileBestEffort(
      staleUploadedFilePath ? resolveRuntimeComponentAbsolutePath(staleUploadedFilePath) : null,
      "stale runtime component upload"
    );
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
      const expectedHash = normalizeExpectedHash(input.expectedHash);
      assertExpectedHashMatchesFile(expectedHash, preparedFile.fileHash);
      const updated = await this.withRuntimeComponentIdentityConflictGuard(() =>
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
            expectedHash: expectedHash ?? preparedFile.fileHash,
            enabled: input.enabled ?? current.enabled
          }
        })
      );
      await this.removeRuntimeComponentFileBestEffort(
        previousStoredFilePath && previousStoredFilePath !== preparedFile.storedFilePath
          ? resolveRuntimeComponentAbsolutePath(previousStoredFilePath)
          : null,
        "old runtime component upload"
      );
      await this.cleanupSharedRulesetDuplicatesBestEffort(input.kind, updated.id);
      return toAdminRuntimeComponentRecord(updated);
    } catch (error) {
      await this.removeRuntimeComponentFileBestEffort(
        prepared ? prepared.absolutePath : file.path,
        "failed runtime component replacement upload"
      );
      throwPrismaTransientAsServiceUnavailable(error, "内核组件替换暂时繁忙，请刷新后重试；已清理本次上传文件。");
    }
  }

  async deleteAdminRuntimeComponent(componentId: string) {
    const existing = await this.ensureRuntimeComponentExists(componentId);
    await this.prisma.runtimeComponent.delete({
      where: { id: componentId }
    });
    await this.removeRuntimeComponentFileBestEffort(
      existing.storedFilePath ? resolveRuntimeComponentAbsolutePath(existing.storedFilePath) : null,
      "deleted runtime component upload"
    );
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
      if (component.expectedHash) {
        return await this.validateRemoteRuntimeComponentHash(
          componentId,
          resolvedUrl,
          component.expectedHash,
          component.archiveEntryName
        );
      }
      if (!component.expectedHash) {
        return {
          componentId,
          status: "metadata_mismatch",
          message: "远程内核组件缺少 SHA256 expectedHash，客户端不会下发该组件。请填写校验哈希后重新验证。",
          finalUrlPreview: resolvedUrl
        };
      }
      return {
        componentId,
        status: "metadata_mismatch",
        message: "远程内核组件缺少 SHA256 expectedHash，客户端不会下发该组件。请填写校验哈希后重新验证。",
        finalUrlPreview: resolvedUrl
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
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new BadRequestException("Runtime failure report limit must be an integer between 1 and 200.");
    }
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
      const component = await this.prisma.runtimeComponent.findUnique({
        where: { id: componentId },
        select: { id: true }
      });
      if (!component) {
        throw new BadRequestException("Runtime component does not exist.");
      }
    }

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

    return { ok: true };
  }

  async getRuntimeComponentDownloadDescriptor(componentId: string) {
    const component = await this.prisma.runtimeComponent.findUnique({
      where: { id: componentId }
    });
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
          message: `Remote runtime component is not reachable: HTTP ${response.status}`,
          finalUrlPreview: resolvedUrl,
          httpStatus: response.status
        };
      }

      const contentLength = parseContentLength(response.headers.get("content-length"));
      if (contentLength !== null && contentLength > limits.maxBytes) {
        return {
          componentId,
          status: "metadata_mismatch",
          message: `Remote runtime component is too large: ${contentLength} bytes exceeds ${limits.maxBytes} bytes.`,
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
          message: "Remote runtime component SHA256 does not match expectedHash.",
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
          status: "metadata_mismatch",
          message: `Remote runtime component is reachable and expectedHash matches, but saving refreshed metadata failed: ${readErrorMessage(error)}`,
          finalUrlPreview: resolvedUrl,
          httpStatus: response.status,
          actualFileSizeBytes: metadata.fileSizeBytes.toString(),
          actualFileHash
        };
      }

      return {
        componentId,
        status: "ready",
        message: "Remote runtime component is reachable and expectedHash matches.",
        finalUrlPreview: resolvedUrl,
        httpStatus: response.status
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
          message: `Remote runtime component download timed out after ${timeoutMs}ms (${timeoutReason}).`,
          finalUrlPreview: resolvedUrl
        };
      }
      throw error;
    } finally {
      clearTimeout(totalTimeout);
      if (archiveDownloadPath) {
        await this.removeRuntimeComponentFileBestEffort(archiveDownloadPath, "temporary remote runtime archive");
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

  private async withRuntimeComponentIdentityConflictGuard<T>(task: () => Promise<T>): Promise<T> {
    try {
      return await task();
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) {
        throw new ConflictException("A runtime component already exists for this platform, architecture, and kind.");
      }
      throw error;
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
    defaultMirrorPrefix: null,
    allowClientMirror: false,
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

function normalizeRequiredText(value: string | null | undefined, fieldName: string) {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new BadRequestException(`${fieldName} must not be empty.`);
  }
  return trimmed;
}

function normalizeExpectedHash(value?: string | null) {
  const normalized = normalizeNullableText(value);
  if (!normalized) {
    return null;
  }
  if (!/^[a-f0-9]{64}$/i.test(normalized)) {
    throw new BadRequestException("SHA256 must be a 64-character hexadecimal string.");
  }
  return normalized.toLowerCase();
}

function assertExpectedHashMatchesFile(expectedHash: string | null, actualHash: string) {
  if (expectedHash && expectedHash !== actualHash) {
    throw new BadRequestException("Uploaded runtime component SHA256 does not match expectedHash.");
  }
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
  let idleTimeout: ReturnType<typeof setTimeout> | null = null;
  const output = options.writePath ? await fs.open(options.writePath, "w") : null;
  const resetIdleTimeout = () => {
    if (idleTimeout) {
      clearTimeout(idleTimeout);
    }
    idleTimeout = setTimeout(options.onIdleTimeout, options.idleTimeoutMs);
  };
  try {
    resetIdleTimeout();
    while (true) {
      const { done, value } = await reader.read();
      resetIdleTimeout();
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
        throw new RemoteRuntimeHashSizeError(
          `Remote runtime component is too large: streamed bytes exceed ${options.maxBytes} bytes.`
        );
      }
    }
  } finally {
    if (idleTimeout) {
      clearTimeout(idleTimeout);
    }
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

async function assertStoredRuntimeComponentReadable(component: {
  storedFilePath: string | null;
  fileSizeBytes?: bigint | number | null;
  fileHash?: string | null;
  expectedHash?: string | null;
}) {
  if (!component.storedFilePath) {
    throw new NotFoundException("Uploaded runtime component is missing its stored file.");
  }
  const absolutePath = resolveRuntimeComponentAbsolutePath(component.storedFilePath);
  await ensureFileReadable(absolutePath);
  const stat = await fs.stat(absolutePath);
  const actualSize = BigInt(stat.size);
  if (!hasPositiveFileSize(component.fileSizeBytes) || toBigInt(component.fileSizeBytes) !== actualSize) {
    throw new BadRequestException("Uploaded runtime component size metadata does not match the stored file.");
  }
  if (!isValidSha256(component.fileHash)) {
    throw new BadRequestException("Uploaded runtime component is missing SHA256 metadata.");
  }
  if (component.expectedHash && component.expectedHash !== component.fileHash) {
    throw new BadRequestException("Uploaded runtime component expectedHash does not match the stored file.");
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
      if (isHttpUrl(row.originUrl) && hasPositiveFileSize(row.fileSizeBytes) && isValidSha256(row.expectedHash)) {
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

function isValidSha256(value: string | null | undefined) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function readErrorMessage(error: unknown) {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : String(error);
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
  const message = error instanceof Error && error.message.trim().length > 0 ? error.message : String(error);
  if (code === "ENOSPC" || code === "EACCES" || code === "EPERM") {
    return new ServiceUnavailableException(`${label} storage is currently unavailable: ${code ?? message}`);
  }
  if (code === "ENOENT") {
    return new BadRequestException(`${label} temporary file is missing; please select the file again and retry.`);
  }
  return new ServiceUnavailableException(`${label} file preparation failed: ${message}`);
}

function readErrorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : null;
}

function assertPathInsideRoot(storageRoot: string, resolvedPath: string) {
  const relativePath = path.relative(storageRoot, resolvedPath);
  if (relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))) {
    return;
  }
  throw new BadRequestException("Stored runtime component path resolves outside the runtime storage root.");
}
