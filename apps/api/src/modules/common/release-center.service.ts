import { workLifecycle } from "../../work-lifecycle";
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import * as path from "node:path";
import type {
  AdminReleaseRecordDto,
  ClientUpdateCheckDto,
  ClientUpdateCheckResultDto,
  CreateReleaseArtifactInputDto,
  CreateReleaseInputDto,
  PlatformTarget,
  ReleaseArtifactType,
  ReleaseChannel,
  ReleaseStatus,
  UpdateDeliveryMode,
  UpdateReleaseArtifactInputDto,
  UpdateReleaseInputDto,
  UploadReleaseArtifactInputDto
} from "@chordv/shared";
import { ClientEventsPublisher } from "./client-events.publisher";
import { AdminRuntimeEventsService } from "./admin-runtime-events.service";
import { PrismaService } from "./prisma.service";
import { DownloadMirrorService } from "./download-mirror.service";
import { throwLocalReadAsServiceUnavailable, throwLocalSaveAsServiceUnavailable } from "./prisma-error.utils";
import {
  assertReleaseArtifactClientUsable,
  assertReleaseArtifactTypeAllowed,
  downloadExternalReleaseArtifactFileStrict,
  buildReleaseArtifactDownloadUrl,
  compareSemver,
  createId,
  defaultDeliveryModeForArtifact,
  defaultDeliveryModeForPlatform,
  ensureFileReadable,
  normalizeChangelog,
  normalizeNullableText,
  normalizeOptionalBoolean,
  normalizePublishedAt,
  normalizeReleaseChannel,
  normalizeVersion,
  pickPrimaryReleaseArtifact,
  type ReleaseRowLike,
  releaseArtifactStorageRoot,
  removeReleaseArtifactDirectory,
  removeReleaseArtifactFile,
  readZipEntryData,
  resolveReleaseArtifactAbsolutePath,
  resolveReleaseArtifactDeliveryMode,
  resolveReleaseArtifactForClient,
  sanitizeReleaseArtifactFileName,
  toAdminReleaseArtifactRecord,
  toAdminReleaseRecord,
  toPrismaReleaseArtifactType,
  fromPrismaReleaseArtifactType
} from "./release-center.utils";
import { moveUploadedFile } from "./upload-file.utils";

type UploadedReleaseFile = {
  path: string;
  originalname: string;
  size: number;
};

type PreparedUploadedReleaseArtifactFile = {
  absolutePath: string;
  storedFilePath: string;
  fileName: string;
  fileSizeBytes: bigint;
  fileHash: string | null;
  downloadUrl: string;
};

type ReleaseFallbackArtifact = ReleaseRowLike["artifacts"][number];

const RELEASE_FILE_CLEANUP_BUDGET_MS = 300;
const RELEASE_RESPONSE_REFRESH_BUDGET_MS = 300;

function normalizeReleaseArtifactFileHash(value: string | null | undefined) {
  const raw = value?.trim() ?? "";
  if (!raw) {
    return null;
  }
  if (!/^[a-fA-F0-9]{64}$/.test(raw)) {
    return null;
  }
  return raw.toLowerCase();
}

function normalizeOptionalReleaseFileSizeBytes(value: string | number | bigint | null | undefined) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const text = String(value).trim();
  if (!/^[1-9]\d*$/.test(text)) {
    throw new BadRequestException("安装包文件大小必须是正整数。");
  }
  return BigInt(text);
}


async function calculateUploadedReleaseArtifactSha256(absolutePath: string) {
  const { createHash } = await import("node:crypto");
  const { createReadStream } = await import("node:fs");
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(absolutePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}


const MIN_WINDOWS_FULL_UPDATE_PE_BYTES = 1024 * 1024;
const MIN_WINDOWS_FULL_UPDATE_GEO_BYTES = 64 * 1024;

async function assertWindowsFullUpdateZipEntry(
  absolutePath: string,
  entryName: string,
  minimumBytes: number,
  requireMzHeader = false
) {
  const data = await readZipEntryData(absolutePath, entryName);
  if (data.byteLength < minimumBytes) {
    throw new BadRequestException(`Windows 全量更新 ZIP 中的 ${entryName} 过小。`);
  }
  if (requireMzHeader && (data[0] !== 0x4d || data[1] !== 0x5a)) {
    throw new BadRequestException(`Windows 全量更新 ZIP 中的 ${entryName} 不是有效的 PE 文件。`);
  }
}

async function assertWindowsFullUpdateZipContents(absolutePath: string) {
  await assertWindowsFullUpdateZipEntry(
    absolutePath,
    "ChordV.exe",
    MIN_WINDOWS_FULL_UPDATE_PE_BYTES,
    true
  );
  await assertWindowsFullUpdateZipEntry(
    absolutePath,
    "bin/xray.exe",
    MIN_WINDOWS_FULL_UPDATE_PE_BYTES,
    true
  );
  await assertWindowsFullUpdateZipEntry(
    absolutePath,
    "bin/geoip.dat",
    MIN_WINDOWS_FULL_UPDATE_GEO_BYTES
  );
  await assertWindowsFullUpdateZipEntry(
    absolutePath,
    "bin/geosite.dat",
    MIN_WINDOWS_FULL_UPDATE_GEO_BYTES
  );
}

@Injectable()
export class ReleaseCenterService {
  private readonly logger = new Logger(ReleaseCenterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clientEventsPublisher: ClientEventsPublisher,
    private readonly adminRuntimeEventsService: AdminRuntimeEventsService,
    private readonly downloadMirrorService: DownloadMirrorService) {}

  async listAdminReleases(input?: { platform?: PlatformTarget; status?: ReleaseStatus }): Promise<AdminReleaseRecordDto[]> {
    try {
      const rows = await this.prisma.release.findMany({
        where: {
          ...(input?.platform ? { platform: input.platform } : {}),
          ...(input?.status ? { status: input.status } : {})
        },
        include: {
          artifacts: {
            orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }]
          }
        },
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }]
      });
      return rows.map(toAdminReleaseRecord);
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "发布列表暂时不可用，请稍后重试。");
    }
  }

  async createRelease(input: CreateReleaseInputDto): Promise<AdminReleaseRecordDto> {
    if ((input.status ?? "draft") === "published") {
      throw new BadRequestException("请先创建草稿并添加安装包，再发布版本。");
    }

    const releaseId = createId("release");
    const version = normalizeVersion(input.version);
    const minimumVersion = input.minimumVersion?.trim() ? normalizeVersion(input.minimumVersion) : version;
    const displayTitle = input.displayTitle?.trim() || version;
    assertMinimumVersionNotAboveRelease(version, minimumVersion);
    const baseReleaseData = {
      id: releaseId,
      platform: input.platform,
      channel: normalizeReleaseChannel(input.channel),
      version,
      displayTitle,
      changelog: normalizeChangelog(input.changelog),
      minimumVersion,
      forceUpgrade: input.forceUpgrade ?? false,
      status: input.status ?? "draft",
      publishedAt: normalizePublishedAt(input.status ?? "draft", input.publishedAt)
    };

    if (input.initialArtifact) {
      const preparedArtifact = await this.prepareInitialExternalReleaseArtifact(input.platform, releaseId, input.initialArtifact);
      const created = await this.createReleaseWithUniqueVersionGuard(async () =>
        this.prisma.$transaction(async (tx) => {
          const release = await tx.release.create({
            data: baseReleaseData,
            include: {
              artifacts: true
            }
          });
          const artifact = await tx.releaseArtifact.create({
            data: preparedArtifact
          });
          return { release, artifact };
        })
      );

      return this.getAdminReleaseBestEffort(
        created.release.id,
        toAdminReleaseRecord({
          ...created.release,
          artifacts: [created.artifact]
        }),
        "create release response refresh"
      ).finally(() => this.publishReleaseCenterUpdatedBestEffort());
    }

    const created = await this.createReleaseWithUniqueVersionGuard(() =>
      this.prisma.release.create({
        data: baseReleaseData,
        include: {
          artifacts: true
        }
      })
    );
    this.publishReleaseCenterUpdatedBestEffort();
    return toAdminReleaseRecord(created);
  }

  async updateRelease(releaseId: string, input: UpdateReleaseInputDto): Promise<AdminReleaseRecordDto> {
    const current = await this.ensureReleaseExists(releaseId);
    this.assertReleaseRecordMutable(current);
    const nextMinimumVersion = input.minimumVersion !== undefined ? normalizeVersion(input.minimumVersion) : current.minimumVersion;
    assertMinimumVersionNotAboveRelease(current.version, nextMinimumVersion);

    const baseData = {
      ...(input.displayTitle !== undefined ? { displayTitle: input.displayTitle.trim() || current.version } : {}),
      ...(input.changelog !== undefined ? { changelog: normalizeChangelog(input.changelog) } : {}),
      ...(input.minimumVersion !== undefined ? { minimumVersion: nextMinimumVersion } : {}),
      ...(input.forceUpgrade !== undefined ? { forceUpgrade: input.forceUpgrade } : {}),
      ...(input.status === undefined && input.publishedAt !== undefined && current.status === "published"
        ? { publishedAt: input.publishedAt ? new Date(input.publishedAt) : null }
        : {})
    };

    if (input.status === "published") {
      await this.assertReleasePublishable(releaseId);
      let updated: ReleaseRowLike;
      try {
        updated = await this.prisma.release.update({
          where: { id: releaseId },
          data: {
            ...baseData,
            status: "published",
            publishedAt: normalizePublishedAt("published", input.publishedAt ?? undefined)
          },
          include: {
            artifacts: {
              orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }]
            }
          }
        });
      } catch (error) {
        throwLocalSaveAsServiceUnavailable(error, "发布记录保存失败，请刷新发布中心后重试。");
      }
      this.publishVersionUpdatedBestEffort(
        updated.platform as PlatformTarget,
        updated.channel as ReleaseChannel
      );
      this.publishReleaseCenterUpdatedBestEffort();
      return toAdminReleaseRecord(updated);
    }

    if (input.status === "draft") {
      let updated: ReleaseRowLike;
      try {
        updated = await this.prisma.release.update({
          where: { id: releaseId },
          data: {
            ...baseData,
            status: "draft",
            publishedAt: null
          },
          include: {
            artifacts: {
              orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }]
            }
          }
        });
      } catch (error) {
        throwLocalSaveAsServiceUnavailable(error, "发布记录保存失败，请刷新发布中心后重试。");
      }
      if (current.status === "published") {
        this.publishVersionUpdatedBestEffort(
          updated.platform as PlatformTarget,
          updated.channel as ReleaseChannel
        );
      }
      this.publishReleaseCenterUpdatedBestEffort();
      return toAdminReleaseRecord(updated);
    }

    if (Object.keys(baseData).length > 0) {
      let updated: ReleaseRowLike;
      try {
        updated = await this.prisma.release.update({
          where: { id: releaseId },
          data: baseData,
          include: {
            artifacts: {
              orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }]
            }
          }
        });
      } catch (error) {
        throwLocalSaveAsServiceUnavailable(error, "发布记录保存失败，请刷新发布中心后重试。");
      }
      if (current.status === "published") {
        this.publishVersionUpdatedBestEffort(
          updated.platform as PlatformTarget,
          updated.channel as ReleaseChannel
        );
      }
      this.publishReleaseCenterUpdatedBestEffort();
      return toAdminReleaseRecord(updated);
    }

    return this.getAdminRelease(releaseId);
  }

  async publishRelease(releaseId: string, publishedAt?: string | null): Promise<AdminReleaseRecordDto> {
    await this.assertReleasePublishable(releaseId);
    let updated: ReleaseRowLike;
    try {
      updated = await this.prisma.release.update({
        where: { id: releaseId },
        data: {
          status: "published",
          publishedAt: normalizePublishedAt("published", publishedAt)
        },
        include: {
          artifacts: {
            orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }]
          }
        }
      });
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "发布记录保存失败，请刷新发布中心后重试。");
    }
    this.publishVersionUpdatedBestEffort(
      updated.platform as PlatformTarget,
      updated.channel as ReleaseChannel
    );
    this.publishReleaseCenterUpdatedBestEffort();
    return toAdminReleaseRecord(updated);
  }

  async unpublishRelease(releaseId: string): Promise<AdminReleaseRecordDto> {
    const current = await this.ensureReleaseExists(releaseId);
    this.assertReleaseRecordMutable(current);
    let updated: ReleaseRowLike;
    try {
      updated = await this.prisma.release.update({
        where: { id: releaseId },
        data: {
          status: "draft",
          publishedAt: null
        },
        include: {
          artifacts: {
            orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }]
          }
        }
      });
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "发布记录保存失败，请刷新发布中心后重试。");
    }
    this.publishVersionUpdatedBestEffort(
      updated.platform as PlatformTarget,
      updated.channel as ReleaseChannel
    );
    this.publishReleaseCenterUpdatedBestEffort();
    return toAdminReleaseRecord(updated);
  }

  async deleteRelease(releaseId: string): Promise<{ ok: true; releaseId: string }> {
    let release: any;
    try {
      release = await this.prisma.release.findUnique({
        where: { id: releaseId },
        include: {
          artifacts: true
        }
      });
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "发布记录暂时不可用，请稍后重试。");
    }
    if (!release) {
      throw new NotFoundException("发布记录不存在。");
    }

    this.assertReleaseRecordMutable(release);

    const storedFilePaths = release.artifacts
      .map((artifact: { storedFilePath?: string | null }) => artifact.storedFilePath)
      .filter((value: string | null | undefined): value is string => Boolean(value));

    try {
      await this.prisma.release.delete({
        where: { id: releaseId }
      });
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "发布记录删除失败，请刷新发布中心后重试。");
    }

    this.startReleaseCleanupBestEffort("release artifact files after release delete", async () => {
      await workLifecycle.all(
        storedFilePaths.map((storedFilePath: string) =>
          removeReleaseArtifactFile(resolveReleaseArtifactAbsolutePath(storedFilePath))
        )
      );
      await removeReleaseArtifactDirectory(path.join(releaseArtifactStorageRoot(), releaseId));
    });

    if (release.status === "published") {
      this.publishVersionUpdatedBestEffort(
        release.platform as PlatformTarget,
        release.channel as ReleaseChannel
      );
    }
    this.publishReleaseCenterUpdatedBestEffort();

    return {
      ok: true,
      releaseId
    };
  }

  private publishReleaseCenterUpdatedBestEffort() {
    try {
      this.adminRuntimeEventsService.publishReleaseCenterUpdated();
    } catch (error) {
      this.logger.warn(
        `Local release change saved, but admin release_center_updated publish failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private publishVersionUpdatedBestEffort(
    platform?: PlatformTarget | null,
    channel: ReleaseChannel = "stable",
    latestVersion?: string | null
  ) {
    void workLifecycle.track(this.clientEventsPublisher.publishVersionUpdated(platform, channel, latestVersion)).catch((error) => {
      this.logger.warn(
        `Local release change saved, but version_updated publish failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
    try {
      this.adminRuntimeEventsService.publishVersionUpdated({
        platform: platform ?? null,
        channel,
        latestVersion: latestVersion ?? null
      });
    } catch (error) {
      this.logger.warn(
        `Local release change saved, but admin version_updated publish failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async createReleaseArtifact(releaseId: string, input: CreateReleaseArtifactInputDto): Promise<AdminReleaseRecordDto> {
    const release = await this.ensureReleaseExists(releaseId);
    this.assertReleaseArtifactsMutable(release);
    assertReleaseArtifactTypeAllowed(release.platform as PlatformTarget, input.type);
    const deliveryMode = resolveReleaseArtifactDeliveryMode(
      release.platform as PlatformTarget,
      input.type,
      input.deliveryMode
    );
    const rawSource = (input as { source?: string }).source;
    if (rawSource === "uploaded") {
      throw new BadRequestException("上传型安装包请通过上传入口创建。");
    }

    if (rawSource !== undefined && rawSource !== "external") {
      throw new BadRequestException("安装包来源必须是外部链接。");
    }
    const source = "external";

    assertExternalReleaseArtifactDownloadUrl(input.downloadUrl);
    const artifactId = createId("artifact");
    const isPrimary = normalizeOptionalBoolean(input.isPrimary);
    let createdArtifact: ReleaseFallbackArtifact;
    try {
      createdArtifact = await this.prisma.$transaction(async (tx) => {
        if (isPrimary) {
          await tx.releaseArtifact.updateMany({
            where: { releaseId },
            data: { isPrimary: false }
          });
        }
        return tx.releaseArtifact.create({
          data: {
            id: artifactId,
            releaseId,
            source,
            type: toPrismaReleaseArtifactType(input.type),
            deliveryMode,
            downloadUrl: input.downloadUrl.trim(),
            defaultMirrorPrefix: null,
            allowClientMirror: false,
            fileName: normalizeNullableText(input.fileName),
            storedFilePath: null,
            fileSizeBytes: normalizeOptionalReleaseFileSizeBytes((input as { fileSizeBytes?: string | number | null }).fileSizeBytes),
            fileHash: normalizeReleaseArtifactFileHash((input as { fileHash?: string | null }).fileHash),
            isPrimary: isPrimary ?? false,
            isFullPackage: true
          }
        });
      });
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "安装包信息保存失败，请刷新发布中心后重试。");
    }
    return this.getAdminReleaseBestEffort(
      releaseId,
      this.buildArtifactMutationFallback(release, [this.fallbackArtifactFromCreate(createdArtifact)]),
      "create release artifact response refresh"
    ).finally(() => this.publishReleaseCenterUpdatedBestEffort());
  }

  async updateReleaseArtifact(
    releaseId: string,
    artifactId: string,
    input: UpdateReleaseArtifactInputDto
  ): Promise<AdminReleaseRecordDto> {
    let current: any;
    try {
      current = await this.prisma.releaseArtifact.findFirst({
        where: { id: artifactId, releaseId }
      });
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "发布包信息读取失败，请稍后重试。");
    }
    if (!current) {
      throw new NotFoundException("安装包不存在。");
    }
    const release = await this.ensureReleaseExists(releaseId);
    this.assertReleaseArtifactsMutable(release);
    if (input.type !== undefined) {
      assertReleaseArtifactTypeAllowed(release.platform as PlatformTarget, input.type);
    }
    const platform = release.platform as PlatformTarget;
    const nextSource = input.source ?? current.source;
    const currentType = fromPrismaReleaseArtifactType(current.type);
    const nextDownloadUrl = input.downloadUrl ?? current.downloadUrl;
    const keepsExplicitWindowsFullReplace =
      platform === "windows" &&
      nextSource === "external" &&
      input.downloadUrl !== undefined &&
      input.type === undefined &&
      input.deliveryMode === undefined &&
      currentType === "zip" &&
      current.deliveryMode === "desktop_full_replace" &&
      !isClearlyNonZipWindowsDownloadUrl(nextDownloadUrl);
    const inferredExternalType =
      nextSource === "external" && input.downloadUrl !== undefined && input.type === undefined
        ? keepsExplicitWindowsFullReplace
          ? currentType
          : inferExternalReleaseArtifactType(platform, nextDownloadUrl, currentType)
        : undefined;
    const nextType = input.type ?? inferredExternalType ?? currentType;
    if (input.source === "uploaded" && current.source !== "uploaded") {
      throw new BadRequestException("切换为上传型安装包时，请使用上传入口。");
    }

    if (nextSource === "uploaded" && input.downloadUrl !== undefined && input.downloadUrl.trim() !== current.downloadUrl) {
      throw new BadRequestException("上传型安装包的下载地址由上传入口管理。");
    }
    if (nextSource === "uploaded" && !current.storedFilePath) {
      throw new BadRequestException("上传型安装包缺少已保存文件。");
    }

    if (nextSource === "external") {
      assertExternalReleaseArtifactDownloadUrl(nextDownloadUrl);
    }
    const nextDeliveryMode = resolveReleaseArtifactDeliveryMode(
      platform,
      nextType,
      input.deliveryMode ?? (input.type !== undefined || inferredExternalType !== undefined ? undefined : (current.deliveryMode as UpdateDeliveryMode))
    );
    const metadataIdentityChanged =
      input.source !== undefined ||
      input.type !== undefined ||
      input.deliveryMode !== undefined ||
      input.downloadUrl !== undefined;
    const nextExternalFileName =
      (input.fileName !== undefined ? normalizeNullableText(input.fileName) : metadataIdentityChanged ? null : current.fileName);
    const isPrimary = normalizeOptionalBoolean(input.isPrimary);
    if (nextSource === "uploaded") {
      const nextUploadedFileName = input.fileName !== undefined ? normalizeNullableText(input.fileName) : current.fileName;
      await this.assertUploadedReleaseArtifactValidForWindowsFullUpdate({
        platform,
        type: nextType,
        deliveryMode: nextDeliveryMode,
        absolutePath: resolveReleaseArtifactAbsolutePath(current.storedFilePath),
        fileName: nextUploadedFileName,
        version: release.version
      });
    }
    let updatedArtifact: ReleaseFallbackArtifact;
    try {
      updatedArtifact = await this.prisma.$transaction(async (tx) => {
        if (isPrimary) {
          await tx.releaseArtifact.updateMany({
            where: { releaseId },
            data: { isPrimary: false }
          });
        }
        return tx.releaseArtifact.update({
          where: { id: artifactId },
          data: {
            ...(input.source !== undefined ? { source: input.source } : {}),
            ...(input.type !== undefined || inferredExternalType !== undefined ? { type: toPrismaReleaseArtifactType(nextType) } : {}),
            ...(input.deliveryMode !== undefined || input.type !== undefined || inferredExternalType !== undefined
              ? { deliveryMode: nextDeliveryMode }
              : {}),
            ...(input.downloadUrl !== undefined ? { downloadUrl: input.downloadUrl.trim() } : {}),
            ...(nextSource === "external" ? { defaultMirrorPrefix: null, allowClientMirror: false } : {}),
            ...(nextSource !== "external" ? { defaultMirrorPrefix: null } : {}),
            ...(nextSource === "external"
              ? {
                  fileName: nextExternalFileName,
                  // 外链地址变化后旧哈希作废；未显式提供新元数据时清空，避免继续信任失效校验值。
                  fileSizeBytes:
                    (input as { fileSizeBytes?: string | number | null }).fileSizeBytes !== undefined
                      ? normalizeOptionalReleaseFileSizeBytes((input as { fileSizeBytes?: string | number | null }).fileSizeBytes)
                      : input.downloadUrl !== undefined && input.downloadUrl.trim() !== current.downloadUrl
                        ? null
                        : current.fileSizeBytes,
                  fileHash:
                    (input as { fileHash?: string | null }).fileHash !== undefined
                      ? normalizeReleaseArtifactFileHash((input as { fileHash?: string | null }).fileHash)
                      : input.downloadUrl !== undefined && input.downloadUrl.trim() !== current.downloadUrl
                        ? null
                        : current.fileHash
                }
              : {}),
            ...(nextSource !== "external" && input.fileName !== undefined ? { fileName: normalizeNullableText(input.fileName) } : {}),
            ...(isPrimary !== undefined ? { isPrimary } : {}),
            ...(input.source === "external" ? { storedFilePath: null } : {}),
            ...(input.source === "uploaded" ? { allowClientMirror: false } : {})
          }
        });
      });
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "安装包信息保存失败，请刷新发布中心后重试。");
    }
    if (current.storedFilePath && input.source === "external") {
      this.startRemoveReleaseArtifactFileBestEffort(current.storedFilePath, "old uploaded release artifact after switching to external");
    }
    return this.getAdminReleaseBestEffort(
      releaseId,
      this.buildArtifactMutationFallback(release, [this.fallbackArtifactFromCreate(updatedArtifact)]),
      "update release artifact response refresh"
    ).finally(() => this.publishReleaseCenterUpdatedBestEffort());
  }

  async uploadReleaseArtifact(
    releaseId: string,
    input: UploadReleaseArtifactInputDto,
    file?: UploadedReleaseFile
  ): Promise<AdminReleaseRecordDto> {
    const release = await this.ensureReleaseExists(releaseId);
    this.assertReleaseArtifactsMutable(release);
    if (!file) {
      throw new BadRequestException("请先选择要上传的安装包文件。");
    }
    const platform = release.platform as PlatformTarget;
    const uploadType = inferUploadedReleaseArtifactType(platform, input.fileName || file.originalname, input.type);
    assertUploadedReleaseArtifactFileAllowed(platform, file.originalname);
    if (input.fileName) {
      assertUploadedReleaseArtifactFileAllowed(platform, input.fileName);
    }
    assertReleaseArtifactTypeAllowed(platform, uploadType);
    const deliveryMode = resolveReleaseArtifactDeliveryMode(
      platform,
      uploadType,
      uploadType === input.type ? input.deliveryMode : null
    );
    const isPrimary = normalizeOptionalBoolean(input.isPrimary);

    const artifactId = createId("artifact");
    let prepared: PreparedUploadedReleaseArtifactFile | null = null;
    try {
      prepared = await this.prepareUploadedReleaseArtifactFile(releaseId, artifactId, file, input.fileName);
      const preparedFile = prepared;
      await this.assertUploadedReleaseArtifactValidForWindowsFullUpdate({
        platform,
        type: uploadType,
        deliveryMode,
        absolutePath: preparedFile.absolutePath,
        fileName: preparedFile.fileName,
        version: release.version
      });
      const createdArtifact = await this.prisma.$transaction(async (tx) => {
        if (isPrimary) {
          await tx.releaseArtifact.updateMany({
            where: { releaseId },
            data: { isPrimary: false }
          });
        }
        return tx.releaseArtifact.create({
          data: {
            id: artifactId,
            releaseId,
            source: "uploaded",
            type: toPrismaReleaseArtifactType(uploadType),
            deliveryMode,
            downloadUrl: preparedFile.downloadUrl,
            defaultMirrorPrefix: null,
            allowClientMirror: false,
            fileName: preparedFile.fileName,
            storedFilePath: preparedFile.storedFilePath,
            fileSizeBytes: preparedFile.fileSizeBytes,
            fileHash: preparedFile.fileHash,
            isPrimary: isPrimary ?? false,
            isFullPackage: true
          }
        });
      });
      const fallback = this.buildArtifactMutationFallback(release, [this.fallbackArtifactFromCreate(createdArtifact)]);
      return this.getAdminReleaseBestEffort(releaseId, fallback, "upload release artifact response refresh")
        .finally(() => this.publishReleaseCenterUpdatedBestEffort());
    } catch (error) {
      await this.cleanupFailedReleaseArtifactUpload(prepared ? prepared.absolutePath : file.path, "failed release artifact upload");
      throwLocalSaveAsServiceUnavailable(error, "安装包保存失败，请刷新发布中心后重试；已尝试清理本次上传文件。");
    }
  }

  async replaceReleaseArtifactUpload(
    releaseId: string,
    artifactId: string,
    input: UploadReleaseArtifactInputDto,
    file?: UploadedReleaseFile
  ): Promise<AdminReleaseRecordDto> {
    if (!file) {
      throw new BadRequestException("请先选择要上传的安装包文件。");
    }
    let current: any;
    try {
      current = await this.prisma.releaseArtifact.findFirst({
        where: { id: artifactId, releaseId }
      });
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "安装包信息暂时不可用，请稍后重试。");
    }
    if (!current) {
      throw new NotFoundException("安装包不存在。");
    }
    const release = await this.ensureReleaseExists(releaseId);
    this.assertReleaseArtifactsMutable(release);
    const platform = release.platform as PlatformTarget;
    const uploadType = inferUploadedReleaseArtifactType(platform, input.fileName || file.originalname, input.type);
    assertUploadedReleaseArtifactFileAllowed(platform, file.originalname);
    if (input.fileName) {
      assertUploadedReleaseArtifactFileAllowed(platform, input.fileName);
    }
    assertReleaseArtifactTypeAllowed(platform, uploadType);
    const deliveryMode = resolveReleaseArtifactDeliveryMode(
      platform,
      uploadType,
      uploadType === input.type ? input.deliveryMode : null
    );

    const previousStoredFilePath = current.storedFilePath;
    const isPrimary = normalizeOptionalBoolean(input.isPrimary);
    let prepared: PreparedUploadedReleaseArtifactFile | null = null;
    try {
      prepared = await this.prepareUploadedReleaseArtifactFile(releaseId, artifactId, file, input.fileName);
      const preparedFile = prepared;
      await this.assertUploadedReleaseArtifactValidForWindowsFullUpdate({
        platform,
        type: uploadType,
        deliveryMode,
        absolutePath: preparedFile.absolutePath,
        fileName: preparedFile.fileName,
        version: release.version
      });
      const updatedArtifact = await this.prisma.$transaction(async (tx) => {
        if (isPrimary) {
          await tx.releaseArtifact.updateMany({
            where: { releaseId },
            data: { isPrimary: false }
          });
        }
        return tx.releaseArtifact.update({
          where: { id: artifactId },
          data: {
            source: "uploaded",
            type: toPrismaReleaseArtifactType(uploadType),
            deliveryMode,
            downloadUrl: preparedFile.downloadUrl,
            defaultMirrorPrefix: null,
            allowClientMirror: false,
            fileName: preparedFile.fileName,
            storedFilePath: preparedFile.storedFilePath,
            fileSizeBytes: preparedFile.fileSizeBytes,
            fileHash: preparedFile.fileHash,
            isPrimary: isPrimary ?? current.isPrimary,
            isFullPackage: true
          }
        });
      });
      const fallback = this.buildArtifactMutationFallback(release, [this.fallbackArtifactFromCreate(updatedArtifact)]);
      if (prepared && previousStoredFilePath && previousStoredFilePath !== prepared.storedFilePath) {
        this.startRemoveReleaseArtifactFileBestEffort(previousStoredFilePath, "old uploaded release artifact after replacement");
      }
      return this.getAdminReleaseBestEffort(releaseId, fallback, "replace release artifact response refresh")
        .finally(() => this.publishReleaseCenterUpdatedBestEffort());
    } catch (error) {
      await this.cleanupFailedReleaseArtifactUpload(
        prepared ? prepared.absolutePath : file.path,
        "failed release artifact replacement upload"
      );
      throwLocalSaveAsServiceUnavailable(error, "安装包替换失败，请刷新发布中心后重试；已尝试清理本次上传文件。");
    }
  }

  async deleteReleaseArtifact(releaseId: string, artifactId: string): Promise<AdminReleaseRecordDto> {
    const release = await this.ensureReleaseExists(releaseId);
    this.assertReleaseArtifactsMutable(release);
    let artifact: any;
    try {
      artifact = await this.prisma.releaseArtifact.findFirst({
        where: { id: artifactId, releaseId }
      });
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "安装包信息暂时不可用，请稍后重试。");
    }
    if (!artifact) {
      throw new NotFoundException("安装包不存在。");
    }
    let siblings: any[];
    try {
      siblings = await this.prisma.releaseArtifact.findMany({
        where: { releaseId },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }]
      });
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "安装包列表暂时不可用，请稍后重试。");
    }
    const nextPrimary = artifact.isPrimary ? siblings.find((item) => item.id !== artifactId) ?? null : null;
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.releaseArtifact.delete({
          where: { id: artifactId }
        });
        if (nextPrimary) {
          await tx.releaseArtifact.update({
            where: { id: nextPrimary.id },
            data: { isPrimary: true }
          });
        }
      });
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "安装包信息删除失败，请刷新发布中心后重试。");
    }
    if (artifact.storedFilePath) {
      this.startRemoveReleaseArtifactFileBestEffort(artifact.storedFilePath, "deleted release artifact file");
    }
    const fallbackArtifacts = siblings
      .filter((item) => item.id !== artifactId)
      .map((item) =>
        nextPrimary && item.id === nextPrimary.id
          ? this.fallbackArtifactFromCreate({ ...item, isPrimary: true, updatedAt: new Date() })
          : this.fallbackArtifactFromCreate(item)
      );
    return this.getAdminReleaseBestEffort(
      releaseId,
      this.buildArtifactMutationFallback(release, fallbackArtifacts, { replaceArtifacts: true }),
      "delete release artifact response refresh"
    ).finally(() => this.publishReleaseCenterUpdatedBestEffort());
  }

  async getReleaseArtifactDownloadDescriptor(artifactId: string) {
    let artifact: any;
    try {
      artifact = await this.prisma.releaseArtifact.findUnique({
        where: { id: artifactId },
        include: { release: true }
      });
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "安装包下载信息暂时不可用，请稍后重试。");
    }
    if (!artifact || artifact.source !== "uploaded" || !artifact.storedFilePath || artifact.release.status !== "published") {
      throw new NotFoundException("安装包不存在。");
    }
    await this.assertStoredReleaseArtifactReadable(artifact);
    const absolutePath = resolveReleaseArtifactAbsolutePath(artifact.storedFilePath);
    return {
      absolutePath,
      fileName: artifact.fileName ?? path.basename(absolutePath)
    };
  }

  async checkClientUpdate(input: ClientUpdateCheckDto): Promise<ClientUpdateCheckResultDto> {
    const effectiveChannel = normalizeReleaseChannel(input.channel);
    let releases: ReleaseRowLike[];
    if (Object.prototype.hasOwnProperty.call(this, "findLatestPublishedRelease")) {
      const latestRelease = await this.findLatestPublishedRelease(effectiveChannel, input.platform);
      releases = latestRelease ? [latestRelease] : [];
    } else {
      releases = await this.findPublishedReleaseCandidates(effectiveChannel, input.platform);
    }
    const latestPublishedRelease = releases[0] ?? null;
    if (!latestPublishedRelease) {
      return {
        hasUpdate: false,
        forceUpgrade: false,
        blockedByMinimumVersion: false,
        forcedByRelease: false,
        updateRequirement: "optional",
        currentVersion: input.currentVersion,
        latestVersion: input.currentVersion,
        minimumVersion: input.currentVersion,
        platform: input.platform,
        channel: effectiveChannel,
        changelog: [],
        deliveryMode: "none",
        recommendedArtifact: null,
        downloadUrl: null,
        fileName: null,
        fileSizeBytes: null,
        fileHash: null,
        publishedAt: null
      };
    }

    const preferredArtifactType = input.platform === "windows" ? "zip" : input.artifactType ?? null;
    const fallbackDeliveryMode = preferredArtifactType
      ? defaultDeliveryModeForArtifact(preferredArtifactType)
      : defaultDeliveryModeForPlatform(input.platform);

    for (const release of releases) {
      if (compareSemver(release.minimumVersion, release.version) > 0) {
        continue;
      }

      const resolvedArtifact = await this.pickClientUsableArtifact(
        release.artifacts,
        input.platform,
        preferredArtifactType,
        input.clientMirrorPrefix ?? null
      );
      if (!resolvedArtifact) {
        continue;
      }

      const latestVersionComparison = compareSemver(release.version, input.currentVersion);
      const mustUpgrade = compareSemver(input.currentVersion, release.minimumVersion) < 0;
      const forcedByRelease = release.forceUpgrade;

      if (latestVersionComparison <= 0 && !mustUpgrade) {
        return {
          hasUpdate: false,
          forceUpgrade: false,
          blockedByMinimumVersion: false,
          forcedByRelease: false,
          updateRequirement: "optional",
          currentVersion: input.currentVersion,
          latestVersion: input.currentVersion,
          minimumVersion: release.minimumVersion,
          platform: input.platform,
          channel: effectiveChannel,
          changelog: release.changelog,
          deliveryMode: (resolvedArtifact?.deliveryMode as ClientUpdateCheckResultDto["deliveryMode"] | undefined)
            ?? fallbackDeliveryMode,
          recommendedArtifact: resolvedArtifact ? toAdminReleaseArtifactRecord(resolvedArtifact) : null,
          downloadUrl: null,
          fileName: null,
          fileSizeBytes: null,
          fileHash: null,
          publishedAt: release.publishedAt?.toISOString() ?? null
        };
      }

      return {
        hasUpdate: latestVersionComparison > 0,
        forceUpgrade: mustUpgrade || forcedByRelease,
        blockedByMinimumVersion: mustUpgrade,
        forcedByRelease,
        updateRequirement: mustUpgrade ? "required_minimum" : forcedByRelease ? "required_release" : "optional",
        currentVersion: input.currentVersion,
        latestVersion: release.version,
        minimumVersion: release.minimumVersion,
        platform: input.platform,
        channel: effectiveChannel,
        changelog: release.changelog,
        deliveryMode: (resolvedArtifact?.deliveryMode as ClientUpdateCheckResultDto["deliveryMode"] | undefined)
          ?? fallbackDeliveryMode,
        recommendedArtifact: resolvedArtifact ? toAdminReleaseArtifactRecord(resolvedArtifact) : null,
        downloadUrl: resolvedArtifact?.downloadUrl ?? null,
        fileName: resolvedArtifact?.fileName ?? null,
        fileSizeBytes: resolvedArtifact?.fileSizeBytes?.toString() ?? null,
        fileHash: resolvedArtifact?.fileHash ?? null,
        publishedAt: release.publishedAt?.toISOString() ?? null
      };
    }

    return {
      hasUpdate: false,
      forceUpgrade: false,
      blockedByMinimumVersion: false,
      forcedByRelease: false,
      updateRequirement: "optional",
      currentVersion: input.currentVersion,
      latestVersion: input.currentVersion,
      minimumVersion: latestPublishedRelease.minimumVersion,
      platform: input.platform,
      channel: effectiveChannel,
      changelog: latestPublishedRelease.changelog,
      deliveryMode: fallbackDeliveryMode,
      recommendedArtifact: null,
      downloadUrl: null,
      fileName: null,
      fileSizeBytes: null,
      fileHash: null,
      publishedAt: latestPublishedRelease.publishedAt?.toISOString() ?? null
    };
  }

  async findLatestPublishedRelease(channel: ReleaseChannel, platform?: ClientUpdateCheckDto["platform"]) {
    return (await this.findPublishedReleaseCandidates(channel, platform))[0] ?? null;
  }

  private async findPublishedReleaseCandidates(channel: ReleaseChannel, platform?: ClientUpdateCheckDto["platform"]) {
    let rows: ReleaseRowLike[];
    try {
      rows = await this.prisma.release.findMany({
        where: {
          channel,
          status: "published",
          ...(platform ? { platform } : {})
        },
        include: {
          artifacts: {
            orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }]
          }
        }
      });
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "已发布版本查询暂时不可用，请稍后重试。");
    }

    if (rows.length === 0) {
      return [];
    }

    return rows.sort((left, right) => {
      const versionDiff = compareSemver(right.version, left.version);
      if (versionDiff !== 0) {
        return versionDiff;
      }
      return (right.publishedAt?.getTime() ?? 0) - (left.publishedAt?.getTime() ?? 0);
    });
  }

  private async assertReleasePublishable(releaseId: string) {
    let release: ReleaseRowLike | null;
    try {
      release = await this.prisma.release.findUnique({
        where: { id: releaseId },
        include: {
          artifacts: {
            orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }]
          }
        }
      });
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "发布前检查暂时不可用，请稍后重试。");
    }
    if (!release) {
      throw new NotFoundException("发布记录不存在。");
    }
    this.assertReleaseRecordMutable(release);
    const primaryArtifact = release.artifacts.find((item) => item.isPrimary) ?? release.artifacts[0];
    if (!primaryArtifact) {
      throw new BadRequestException("发布前请至少添加一个安装包。");
    }
    let lastArtifactError: unknown = null;
    for (const artifact of release.artifacts) {
      try {
        assertReleaseArtifactClientUsable(artifact, release.platform as PlatformTarget);
        await this.assertStoredReleaseArtifactReadable(artifact);
        await this.assertReleaseArtifactContentMatchesMetadata(
          artifact,
          release.platform as PlatformTarget
        );
        lastArtifactError = null;
        break;
      } catch (error) {
        lastArtifactError = error;
      }
    }
    if (lastArtifactError) {
      throw new BadRequestException(
        `当前发布没有可供客户端下载的 ${release.platform} 安装包：${readReleaseErrorMessage(lastArtifactError)}`
      );
    }
    assertMinimumVersionNotAboveRelease(release.version, release.minimumVersion);
  }


  private async assertReleaseArtifactContentMatchesMetadata(
    artifact: ReleaseRowLike["artifacts"][number],
    platform: PlatformTarget
  ) {
    const expectedSize = artifact.fileSizeBytes;
    const expectedHash = normalizeReleaseArtifactFileHash(artifact.fileHash);
    if (expectedSize === null || expectedSize === undefined || expectedSize <= 0n) {
      throw new BadRequestException("安装包缺少可验证的文件大小。");
    }

    let absolutePath: string;
    let actualSize: bigint;
    let actualHash: string;
    let cleanup: (() => Promise<void>) | null = null;

    try {
      if (artifact.source === "uploaded") {
        if (!artifact.storedFilePath) {
          throw new BadRequestException("上传型安装包缺少已保存文件。");
        }
        absolutePath = resolveReleaseArtifactAbsolutePath(artifact.storedFilePath);
        const fs = await import("node:fs/promises");
        const stat = await fs.stat(absolutePath);
        actualSize = BigInt(stat.size);
        actualHash = await calculateUploadedReleaseArtifactSha256(absolutePath);
      } else {
        const downloaded = await this.downloadExternalReleaseArtifactForValidation(artifact.downloadUrl);
        absolutePath = downloaded.absolutePath;
        actualSize = downloaded.fileSizeBytes;
        actualHash = downloaded.fileHash.toLowerCase();
        cleanup = downloaded.cleanup;
      }

      if (actualSize !== expectedSize) {
        throw new BadRequestException(
          `安装包实际大小与填写值不一致：填写 ${expectedSize} 字节，实际 ${actualSize} 字节。`
        );
      }
      if (expectedHash && actualHash !== expectedHash) {
        throw new BadRequestException("安装包实际 SHA-256 与填写值不一致。");
      }

      if (
        platform === "windows" &&
        fromPrismaReleaseArtifactType(artifact.type) === "zip" &&
        artifact.deliveryMode === "desktop_full_replace"
      ) {
        await assertWindowsFullUpdateZipContents(absolutePath);
      }
    } finally {
      if (cleanup) {
        await cleanup().catch((error) => {
          this.logger.warn(
            `External release validation temp-file cleanup failed: ${error instanceof Error ? error.message : String(error)}`
          );
        });
      }
    }
  }

  private downloadExternalReleaseArtifactForValidation(rawUrl: string) {
    return downloadExternalReleaseArtifactFileStrict(rawUrl);
  }

  private async pickClientUsableArtifact(
    artifacts: ReleaseRowLike["artifacts"],
    platform: PlatformTarget,
    preferredType?: ReleaseArtifactType | null,
    clientMirrorPrefix?: string | null
  ) {
    const globalMirror = await this.downloadMirrorService.getEffectiveConfig();
    const scopedArtifacts = preferredType
      ? artifacts.filter((item) => {
          const artifactType = fromPrismaReleaseArtifactType(item.type);
          return artifactType === preferredType || artifactType === "external";
        })
      : artifacts;
    const preferred = pickPrimaryReleaseArtifact(scopedArtifacts, preferredType);
    const candidates = preferred
      ? [preferred, ...scopedArtifacts.filter((item) => item.id !== preferred.id)]
      : scopedArtifacts;
    for (const artifact of candidates) {
      try {
        assertReleaseArtifactClientUsable(artifact, platform);
        await this.assertStoredReleaseArtifactReadable(artifact);
        const resolvedArtifact = resolveReleaseArtifactForClient(artifact, clientMirrorPrefix ?? null, { defaultMirrorPrefix: globalMirror.defaultMirrorPrefix, allowClientMirror: globalMirror.allowClientMirror });
        return resolvedArtifact;
      } catch {
        if (clientMirrorPrefix?.trim()) {
          try {
            assertReleaseArtifactClientUsable(artifact, platform);
            await this.assertStoredReleaseArtifactReadable(artifact);
            const resolvedArtifact = resolveReleaseArtifactForClient(artifact, null, { defaultMirrorPrefix: globalMirror.defaultMirrorPrefix, allowClientMirror: globalMirror.allowClientMirror });
            return resolvedArtifact;
          } catch {
          }
        }
      }
    }
    return null;
  }

  private async assertStoredReleaseArtifactReadable(artifact: ReleaseRowLike["artifacts"][number]) {
    if (artifact.source !== "uploaded") {
      return;
    }
    if (!artifact.storedFilePath) {
      throw new BadRequestException("上传型安装包缺少已保存文件。");
    }
    const absolutePath = resolveReleaseArtifactAbsolutePath(artifact.storedFilePath);
    await ensureFileReadable(absolutePath);
  }

  private async assertUploadedReleaseArtifactValidForWindowsFullUpdate(input: {
    platform: PlatformTarget;
    type: ReleaseArtifactType;
    deliveryMode: UpdateDeliveryMode;
    absolutePath: string | null;
    fileName?: string | null;
    version: string;
  }) {
    if (input.platform !== "windows" || input.type !== "zip" || input.deliveryMode !== "desktop_full_replace") {
      return;
    }
    const fileName = input.fileName?.trim() || (input.absolutePath ? path.basename(input.absolutePath) : "");
    if (!fileName.toLowerCase().endsWith(".zip")) {
      throw new BadRequestException("Windows 静默全量更新只支持 ZIP。");
    }
    if (!input.absolutePath) {
      throw new BadRequestException("Windows 静默全量更新 ZIP 不可用。");
    }
    await ensureFileReadable(input.absolutePath);
  }

  private assertReleaseArtifactsMutable(release: { status: string }) {
    if (release.status !== "draft") {
      throw new BadRequestException("请先撤回发布，再编辑安装包。");
    }
  }

  private assertReleaseRecordMutable(release: { status: string }) {
    if (release.status === "archived") {
      throw new BadRequestException("已归档的发布记录只读。");
    }
  }

  private async prepareInitialExternalReleaseArtifact(
    platform: PlatformTarget,
    releaseId: string,
    input: CreateReleaseArtifactInputDto
  ) {
    const source = input.source ?? "external";
    if (source !== "external") {
      throw new BadRequestException("创建发布时只能直接添加外链安装包；如需上传文件，请先创建草稿再使用上传入口。");
    }
    assertReleaseArtifactTypeAllowed(platform, input.type);
    const deliveryMode = resolveReleaseArtifactDeliveryMode(platform, input.type, input.deliveryMode);
    assertExternalReleaseArtifactDownloadUrl(input.downloadUrl);
    const artifactId = createId("artifact");

    return {
      id: artifactId,
      releaseId,
      source,
      type: toPrismaReleaseArtifactType(input.type),
      deliveryMode,
      downloadUrl: input.downloadUrl.trim(),
      defaultMirrorPrefix: null,
      allowClientMirror: false,
      fileName: normalizeNullableText(input.fileName),
      storedFilePath: null,
      fileSizeBytes: normalizeOptionalReleaseFileSizeBytes((input as { fileSizeBytes?: string | number | null }).fileSizeBytes),
      fileHash: normalizeReleaseArtifactFileHash((input as { fileHash?: string | null }).fileHash),
      isPrimary: true,
      isFullPackage: true
    };
  }

  private async prepareUploadedReleaseArtifactFile(
    releaseId: string,
    artifactId: string,
    file: UploadedReleaseFile,
    preferredFileName?: string | null
  ) {
    const finalFileName = sanitizeReleaseArtifactFileName(preferredFileName?.trim() || file.originalname || `${artifactId}.bin`);
    const storedFilePath = path.join(releaseId, artifactId, `${createId("file")}_${finalFileName}`);
    const absolutePath = resolveReleaseArtifactAbsolutePath(storedFilePath);

    try {
      const fs = await import("node:fs/promises");
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await moveUploadedFile(file.path, absolutePath);
      const fileHash = await calculateUploadedReleaseArtifactSha256(absolutePath);

      return {
        absolutePath,
        storedFilePath,
        fileName: finalFileName,
        fileSizeBytes: BigInt(file.size),
        fileHash,
        downloadUrl: buildReleaseArtifactDownloadUrl(artifactId)
      };
    } catch (error) {
      throw mapUploadedFilePreparationError(error, "release artifact upload");
    }
  }

  private async getAdminReleaseBestEffort(releaseId: string, fallback: AdminReleaseRecordDto, label: string) {
    let settled = false;
    const refreshTask = this.getAdminRelease(releaseId).then(
      (release) => {
        settled = true;
        return release;
      },
      (error) => {
        settled = true;
        throw error;
      }
    );
    void refreshTask.catch((error) => {
      this.logger.warn(
        `Local release change saved, but delayed ${label} failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutTask = new Promise<AdminReleaseRecordDto>((resolve) => {
      timeoutHandle = setTimeout(() => {
        if (!settled) {
          this.logger.warn(`Local release change saved, but ${label} exceeded ${RELEASE_RESPONSE_REFRESH_BUDGET_MS}ms.`);
        }
        resolve(fallback);
      }, RELEASE_RESPONSE_REFRESH_BUDGET_MS);
      timeoutHandle.unref?.();
    });

    try {
      return await Promise.race([workLifecycle.track(refreshTask), timeoutTask]);
    } catch (error) {
      this.logger.warn(
        `Local release change saved, but ${label} failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return fallback;
    } finally {
      if (settled && timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private async createReleaseWithUniqueVersionGuard<T>(task: () => Promise<T>): Promise<T> {
    try {
      return await task();
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) {
        throw new ConflictException("相同平台和渠道下已存在这个版本号。");
      }
      throwLocalSaveAsServiceUnavailable(error, "发布记录保存失败，请刷新发布中心后重试。");
    }
  }

  private async getAdminRelease(releaseId: string): Promise<AdminReleaseRecordDto> {
    let row: ReleaseRowLike | null;
    try {
      row = await this.prisma.release.findUnique({
        where: { id: releaseId },
        include: {
          artifacts: {
            orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }]
          }
        }
      });
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "发布记录暂时不可用，请稍后重试。");
    }
    if (!row) {
      throw new NotFoundException("发布记录不存在。");
    }
    return toAdminReleaseRecord(row);
  }

  private buildArtifactMutationFallback(
    release: {
      id: string;
      platform: string;
      channel?: string;
      status: string;
      version: string;
      displayTitle?: string;
      changelog?: string[];
      minimumVersion: string;
      forceUpgrade?: boolean;
      publishedAt?: Date | null;
      createdAt?: Date;
      updatedAt?: Date;
      artifacts?: ReleaseFallbackArtifact[];
    },
    changedArtifacts: ReleaseFallbackArtifact[],
    options: { replaceArtifacts?: boolean } = {}
  ): AdminReleaseRecordDto {
    const now = new Date();
    const artifacts = options.replaceArtifacts
      ? changedArtifacts
      : mergeReleaseFallbackArtifacts(release.artifacts ?? [], changedArtifacts);
    return toAdminReleaseRecord({
      id: release.id,
      platform: release.platform,
      channel: release.channel ?? "stable",
      version: release.version,
      displayTitle: release.displayTitle ?? release.version,
      changelog: release.changelog ?? [],
      minimumVersion: release.minimumVersion,
      forceUpgrade: release.forceUpgrade ?? false,
      status: release.status,
      publishedAt: release.publishedAt ?? null,
      createdAt: release.createdAt ?? now,
      updatedAt: release.updatedAt ?? now,
      artifacts
    });
  }

  private fallbackArtifactFromCreate(row: ReleaseFallbackArtifact): ReleaseFallbackArtifact {
    return row;
  }

  private async removeReleaseArtifactFileBestEffort(storedFilePath: string, label: string) {
    await this.runReleaseCleanupBestEffort(label, () =>
      removeReleaseArtifactFile(resolveReleaseArtifactAbsolutePath(storedFilePath))
    );
  }

  private startRemoveReleaseArtifactFileBestEffort(storedFilePath: string, label: string) {
    this.startReleaseCleanupBestEffort(label, () =>
      removeReleaseArtifactFile(resolveReleaseArtifactAbsolutePath(storedFilePath))
    );
  }

  private async cleanupFailedReleaseArtifactUpload(absolutePath: string | null, label: string) {
    await this.runReleaseCleanupBestEffort(label, () =>
      absolutePath ? removeReleaseArtifactFile(absolutePath) : Promise.resolve()
    );
  }

  private async runReleaseCleanupBestEffort(label: string, task: () => Promise<unknown>) {
    let settled = false;
    const cleanupTask = task().then(
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
        `Local release change saved, but delayed ${label} cleanup failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutTask = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        this.logger.warn(
          `Local release change saved, but ${label} cleanup exceeded ${RELEASE_FILE_CLEANUP_BUDGET_MS}ms and will continue in background.`
        );
        resolve();
      }, RELEASE_FILE_CLEANUP_BUDGET_MS);
    });

    try {
      await Promise.race([workLifecycle.track(cleanupTask), timeoutTask]);
    } catch (error) {
      this.logger.warn(
        `Local release change saved, but ${label} cleanup failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      if (settled && timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private startReleaseCleanupBestEffort(label: string, task: () => Promise<unknown>) {
    const timer = workLifecycle.defer(() => {
      return this.runReleaseCleanupBestEffort(label, task).catch((error) => {
        this.logger.warn(
          `Local release change saved, but background ${label} cleanup failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    }, 0);
    timer.unref?.();
  }

  private async ensureReleaseExists(releaseId: string) {
    let row: any;
    try {
      row = await this.prisma.release.findUnique({
        where: { id: releaseId },
        select: {
          id: true,
          platform: true,
          channel: true,
          status: true,
          version: true,
          displayTitle: true,
          changelog: true,
          minimumVersion: true,
          forceUpgrade: true,
          publishedAt: true,
          createdAt: true,
          updatedAt: true,
          artifacts: {
            orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }]
          }
        }
      });
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "发布记录暂时不可用，请稍后重试。");
    }
    if (!row) {
      throw new NotFoundException("发布记录不存在。");
    }
    return row;
  }
}

function inferUploadedReleaseArtifactType(
  platform: PlatformTarget,
  fileName: string | null | undefined,
  fallbackType: ReleaseArtifactType
): ReleaseArtifactType {
  if (platform !== "windows") {
    return fallbackType;
  }
  const normalized = fileName?.trim().toLowerCase() ?? "";
  if (normalized.endsWith(".zip")) {
    return "zip";
  }
  return fallbackType;
}

function inferExternalReleaseArtifactType(
  platform: PlatformTarget,
  downloadUrl: string,
  fallbackType: ReleaseArtifactType
): ReleaseArtifactType {
  const pathname = inferUrlPathname(downloadUrl);
  if (platform === "windows") {
    if (pathname.endsWith(".zip")) {
      return "zip";
    }
    return "external";
  }
  if (platform === "macos") {
    return pathname.endsWith(".dmg") ? "dmg" : fallbackType;
  }
  if (platform === "android") {
    return pathname.endsWith(".apk") ? "apk" : fallbackType;
  }
  return pathname.endsWith(".ipa") ? "ipa" : fallbackType;
}

function isClearlyNonZipWindowsDownloadUrl(downloadUrl: string) {
  const pathname = inferUrlPathname(downloadUrl);
  return pathname.endsWith(".exe") || pathname.endsWith(".dmg") || pathname.endsWith(".apk") || pathname.endsWith(".ipa");
}

function assertUploadedReleaseArtifactFileAllowed(platform: PlatformTarget, fileName: string | null | undefined) {
  if (platform !== "windows") {
    return;
  }
  const normalized = fileName?.trim().toLowerCase() ?? "";
  if (!normalized.endsWith(".zip")) {
    throw new BadRequestException("Windows 静默全量更新只支持 ZIP。");
  }
}

function inferUrlPathname(downloadUrl: string) {
  try {
    return new URL(downloadUrl.trim()).pathname.toLowerCase();
  } catch {
    return downloadUrl.trim().toLowerCase();
  }
}

function assertMinimumVersionNotAboveRelease(version: string, minimumVersion: string) {
  if (compareSemver(minimumVersion, version) > 0) {
    throw new BadRequestException("最低可用版本不能高于发布版本。");
  }
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
    return new ServiceUnavailableException(`${translateReleaseUploadPreparationLabel(label)}存储暂不可用，请检查服务器磁盘空间或目录权限。`);
  }
  if (code === "ENOENT") {
    return new BadRequestException(`${translateReleaseUploadPreparationLabel(label)}临时文件不存在，请重新选择文件后再上传。`);
  }
  return new ServiceUnavailableException(`${translateReleaseUploadPreparationLabel(label)}文件处理失败，请稍后重试。`);
}

function readErrorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : null;
}

function readReleaseErrorMessage(error: unknown) {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : String(error);
}

function assertExternalReleaseArtifactDownloadUrl(rawUrl: string) {
  const normalized = rawUrl.trim();
  if (!normalized || !/^https?:\/\//i.test(normalized)) {
    throw new BadRequestException("外链安装包下载地址必须是完整的 http/https 地址。");
  }
}

function translateReleaseUploadPreparationLabel(label: string) {
  if (label === "release artifact upload") {
    return "安装包上传";
  }
  return label;
}

function mergeReleaseFallbackArtifacts(
  currentArtifacts: ReleaseFallbackArtifact[],
  changedArtifacts: ReleaseFallbackArtifact[]
) {
  const changedById = new Map(changedArtifacts.map((artifact) => [artifact.id, artifact]));
  const changedHasPrimary = changedArtifacts.some((artifact) => artifact.isPrimary);
  const merged = currentArtifacts.map((artifact) => {
    const changed = changedById.get(artifact.id);
    if (changed) {
      changedById.delete(artifact.id);
      return changed;
    }
    return changedHasPrimary ? { ...artifact, isPrimary: false } : artifact;
  });
  merged.push(...changedById.values());
  return merged.sort((left, right) => {
    if (left.isPrimary !== right.isPrimary) {
      return left.isPrimary ? -1 : 1;
    }
    return left.createdAt.getTime() - right.createdAt.getTime();
  });
}
