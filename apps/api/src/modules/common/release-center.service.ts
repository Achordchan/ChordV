import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import * as path from "node:path";
import type {
  AdminReleaseArtifactValidationDto,
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
import { PrismaService } from "./prisma.service";
import {
  assertReleaseArtifactClientUsable,
  assertReleaseArtifactDeliveryAllowed,
  assertExternalReleaseArtifactUrlMatchesType,
  assertReleaseArtifactTypeAllowed,
  assertWindowsFullUpdateZipFile,
  buildReleaseArtifactDownloadUrl,
  calculateFileSha256,
  compareSemver,
  createId,
  defaultDeliveryModeForArtifact,
  defaultDeliveryModeForPlatform,
  downloadExternalReleaseArtifactFile,
  downloadExternalReleaseArtifactFileStrict,
  ensureFileReadable,
  fetchExternalReleaseArtifactMetadata,
  normalizeChangelog,
  normalizeFileSizeBytes,
  normalizeNullableText,
  normalizeOptionalBoolean,
  normalizePublishedAt,
  normalizeReleaseChannel,
  normalizeSha256Input,
  normalizeVersion,
  pickPrimaryReleaseArtifact,
  type ReleaseRowLike,
  releaseArtifactStorageRoot,
  removeReleaseArtifactDirectory,
  removeReleaseArtifactFile,
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
  fileHash: string;
  downloadUrl: string;
};

type ReleaseFallbackArtifact = ReleaseRowLike["artifacts"][number];

const RELEASE_FILE_CLEANUP_BUDGET_MS = 300;

@Injectable()
export class ReleaseCenterService {
  private readonly logger = new Logger(ReleaseCenterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clientEventsPublisher: ClientEventsPublisher
  ) {}

  async listAdminReleases(input?: { platform?: PlatformTarget; status?: ReleaseStatus }): Promise<AdminReleaseRecordDto[]> {
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
  }

  async createRelease(input: CreateReleaseInputDto): Promise<AdminReleaseRecordDto> {
    if ((input.status ?? "draft") === "published") {
      throw new BadRequestException("请先创建草稿并补充安装产物，再执行发布。");
    }

    const releaseId = createId("release");
    const version = normalizeVersion(input.version);
    const minimumVersion = normalizeVersion(input.minimumVersion);
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
      const created = await this.prisma.$transaction(async (tx) => {
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
      });

      return this.getAdminReleaseBestEffort(
        created.release.id,
        toAdminReleaseRecord({
          ...created.release,
          artifacts: [created.artifact]
        }),
        "create release response refresh"
      );
    }

    const created = await this.prisma.release.create({
      data: baseReleaseData,
      include: {
        artifacts: true
      }
    });
    return toAdminReleaseRecord(created);
  }

  async updateRelease(releaseId: string, input: UpdateReleaseInputDto): Promise<AdminReleaseRecordDto> {
    const current = await this.ensureReleaseExists(releaseId);
    this.assertReleaseRecordMutable(current);
    const nextMinimumVersion = input.minimumVersion !== undefined ? normalizeVersion(input.minimumVersion) : current.minimumVersion;
    assertMinimumVersionNotAboveRelease(current.version, nextMinimumVersion);

    const baseData = {
      ...(input.displayTitle !== undefined ? { displayTitle: input.displayTitle.trim() } : {}),
      ...(input.changelog !== undefined ? { changelog: normalizeChangelog(input.changelog) } : {}),
      ...(input.minimumVersion !== undefined ? { minimumVersion: nextMinimumVersion } : {}),
      ...(input.forceUpgrade !== undefined ? { forceUpgrade: input.forceUpgrade } : {}),
      ...(input.status === undefined && input.publishedAt !== undefined && current.status === "published"
        ? { publishedAt: input.publishedAt ? new Date(input.publishedAt) : null }
        : {})
    };

    if (input.status === "published") {
      await this.assertReleasePublishable(releaseId);
      const updated = await this.prisma.release.update({
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
      this.publishVersionUpdatedBestEffort(
        updated.platform as PlatformTarget,
        updated.channel as ReleaseChannel
      );
      return toAdminReleaseRecord(updated);
    }

    if (input.status === "draft") {
      const updated = await this.prisma.release.update({
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
      if (current.status === "published") {
        this.publishVersionUpdatedBestEffort(
          updated.platform as PlatformTarget,
          updated.channel as ReleaseChannel
        );
      }
      return toAdminReleaseRecord(updated);
    }

    if (Object.keys(baseData).length > 0) {
      const updated = await this.prisma.release.update({
        where: { id: releaseId },
        data: baseData,
        include: {
          artifacts: {
            orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }]
          }
        }
      });
      if (current.status === "published") {
        this.publishVersionUpdatedBestEffort(
          updated.platform as PlatformTarget,
          updated.channel as ReleaseChannel
        );
      }
      return toAdminReleaseRecord(updated);
    }

    return this.getAdminRelease(releaseId);
  }

  async publishRelease(releaseId: string, publishedAt?: string | null): Promise<AdminReleaseRecordDto> {
    await this.assertReleasePublishable(releaseId);
    const updated = await this.prisma.release.update({
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
    this.publishVersionUpdatedBestEffort(
      updated.platform as PlatformTarget,
      updated.channel as ReleaseChannel
    );
    return toAdminReleaseRecord(updated);
  }

  async unpublishRelease(releaseId: string): Promise<AdminReleaseRecordDto> {
    const current = await this.ensureReleaseExists(releaseId);
    this.assertReleaseRecordMutable(current);
    const updated = await this.prisma.release.update({
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
    this.publishVersionUpdatedBestEffort(
      updated.platform as PlatformTarget,
      updated.channel as ReleaseChannel
    );
    return toAdminReleaseRecord(updated);
  }

  async deleteRelease(releaseId: string): Promise<{ ok: true; releaseId: string }> {
    const release = await this.prisma.release.findUnique({
      where: { id: releaseId },
      include: {
        artifacts: true
      }
    });
    if (!release) {
      throw new NotFoundException("发布记录不存在");
    }

    this.assertReleaseRecordMutable(release);

    const storedFilePaths = release.artifacts
      .map((artifact) => artifact.storedFilePath)
      .filter((value): value is string => Boolean(value));

    await this.prisma.release.delete({
      where: { id: releaseId }
    });

    await this.runReleaseCleanupBestEffort("release artifact files after release delete", async () => {
      await Promise.all(
        storedFilePaths.map((storedFilePath) =>
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

    return {
      ok: true,
      releaseId
    };
  }

  private publishVersionUpdatedBestEffort(
    platform?: PlatformTarget | null,
    channel: ReleaseChannel = "stable",
    latestVersion?: string | null
  ) {
    void this.clientEventsPublisher.publishVersionUpdated(platform, channel, latestVersion).catch((error) => {
      this.logger.warn(
        `Local release change saved, but version_updated publish failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
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
      throw new BadRequestException("创建上传产物时请使用上传接口。");
    }

    if (rawSource !== undefined && rawSource !== "external") {
      throw new BadRequestException("Release artifact source must be external.");
    }
    const source = "external";

    const defaultMirrorPrefix = normalizeNullableText(input.defaultMirrorPrefix);
    assertExternalReleaseArtifactUrlMatchesType(input.type, input.downloadUrl);
    const externalMetadata = await this.resolveExternalReleaseArtifactMetadata(
      input.type,
      input.downloadUrl,
      defaultMirrorPrefix
    );
    const fileSizeBytes = externalMetadata?.fileSizeBytes ?? normalizeFileSizeBytes(input.fileSizeBytes) ?? null;
    const fileHash = externalMetadata?.fileHash ?? normalizeSha256Input(input.fileHash) ?? null;
    const artifactId = createId("artifact");
    const isPrimary = normalizeOptionalBoolean(input.isPrimary);
    const isFullPackage = normalizeOptionalBoolean(input.isFullPackage);
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
          source,
          type: toPrismaReleaseArtifactType(input.type),
          deliveryMode,
          downloadUrl: input.downloadUrl.trim(),
          defaultMirrorPrefix,
          allowClientMirror: input.allowClientMirror ?? true,
          fileName: externalMetadata?.fileName ?? normalizeNullableText(input.fileName),
          storedFilePath: null,
          fileSizeBytes,
          fileHash,
          isPrimary: isPrimary ?? false,
          isFullPackage: isFullPackage ?? true
        }
      });
    });
    return this.getAdminReleaseBestEffort(
      releaseId,
      this.buildArtifactMutationFallback(release, [this.fallbackArtifactFromCreate(createdArtifact)]),
      "create release artifact response refresh"
    );
  }

  async updateReleaseArtifact(
    releaseId: string,
    artifactId: string,
    input: UpdateReleaseArtifactInputDto
  ): Promise<AdminReleaseRecordDto> {
    const current = await this.prisma.releaseArtifact.findFirst({
      where: { id: artifactId, releaseId }
    });
    if (!current) {
      throw new NotFoundException("发布产物不存在");
    }
    const release = await this.ensureReleaseExists(releaseId);
    this.assertReleaseArtifactsMutable(release);
    if (input.type !== undefined) {
      assertReleaseArtifactTypeAllowed(release.platform as PlatformTarget, input.type);
    }
    const nextSource = input.source ?? current.source;
    const nextType = input.type ?? fromPrismaReleaseArtifactType(current.type);
    const nextDownloadUrl = input.downloadUrl ?? current.downloadUrl;
    const nextDefaultMirrorPrefix =
      nextSource === "external"
        ? input.defaultMirrorPrefix !== undefined
          ? normalizeNullableText(input.defaultMirrorPrefix)
          : current.defaultMirrorPrefix
        : null;
    if (input.source === "uploaded" && current.source !== "uploaded") {
      throw new BadRequestException("切换为上传产物时请使用上传接口。");
    }

    if (nextSource === "uploaded" && input.downloadUrl !== undefined && input.downloadUrl.trim() !== current.downloadUrl) {
      throw new BadRequestException("Uploaded release artifact URLs are managed by the upload endpoint.");
    }
    if (nextSource === "uploaded" && !current.storedFilePath) {
      throw new BadRequestException("Uploaded release artifact is missing its stored file.");
    }

    if (nextSource === "external") {
      assertExternalReleaseArtifactUrlMatchesType(nextType, nextDownloadUrl);
    }
    const nextDeliveryMode = resolveReleaseArtifactDeliveryMode(
      release.platform as PlatformTarget,
      nextType,
      input.deliveryMode ?? (input.type !== undefined ? undefined : (current.deliveryMode as UpdateDeliveryMode))
    );
    const metadataIdentityChanged =
      input.source !== undefined ||
      input.type !== undefined ||
      input.deliveryMode !== undefined ||
      input.downloadUrl !== undefined ||
      input.defaultMirrorPrefix !== undefined;
    const externalMetadata =
      nextSource === "external"
        ? await this.resolveExternalReleaseArtifactMetadata(nextType, nextDownloadUrl, nextDefaultMirrorPrefix)
        : null;
    const nextExternalFileName =
      externalMetadata?.fileName ??
      (input.fileName !== undefined ? normalizeNullableText(input.fileName) : metadataIdentityChanged ? null : current.fileName);
    const nextExternalFileSizeBytes =
      externalMetadata?.fileSizeBytes ??
      normalizeFileSizeBytes(input.fileSizeBytes) ??
      (metadataIdentityChanged ? null : current.fileSizeBytes);
    const nextExternalFileHash =
      externalMetadata?.fileHash ??
      normalizeSha256Input(input.fileHash) ??
      (metadataIdentityChanged ? null : current.fileHash);
    const isPrimary = normalizeOptionalBoolean(input.isPrimary);
    const isFullPackage = normalizeOptionalBoolean(input.isFullPackage);
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
          ...(input.source !== undefined ? { source: input.source } : {}),
          ...(input.type !== undefined ? { type: toPrismaReleaseArtifactType(input.type) } : {}),
          ...(input.deliveryMode !== undefined || input.type !== undefined ? { deliveryMode: nextDeliveryMode } : {}),
          ...(input.downloadUrl !== undefined ? { downloadUrl: input.downloadUrl.trim() } : {}),
          ...(nextSource === "external" && input.defaultMirrorPrefix !== undefined ? { defaultMirrorPrefix: nextDefaultMirrorPrefix } : {}),
          ...(nextSource !== "external" ? { defaultMirrorPrefix: null } : {}),
          ...(input.allowClientMirror !== undefined ? { allowClientMirror: input.allowClientMirror } : {}),
          ...(nextSource === "external"
            ? {
                fileName: nextExternalFileName,
                fileSizeBytes: nextExternalFileSizeBytes,
                fileHash: nextExternalFileHash
              }
            : {}),
          ...(nextSource !== "external" && input.fileName !== undefined ? { fileName: normalizeNullableText(input.fileName) } : {}),
          ...(nextSource !== "external" && input.fileSizeBytes !== undefined ? { fileSizeBytes: normalizeFileSizeBytes(input.fileSizeBytes) } : {}),
          ...(nextSource !== "external" && input.fileHash !== undefined ? { fileHash: normalizeSha256Input(input.fileHash) } : {}),
          ...(isPrimary !== undefined ? { isPrimary } : {}),
          ...(isFullPackage !== undefined ? { isFullPackage } : {}),
          ...(input.source === "external" ? { storedFilePath: null } : {}),
          ...(input.source === "uploaded" ? { allowClientMirror: false } : {})
        }
      });
    });
    if (current.storedFilePath && input.source === "external") {
      await this.removeReleaseArtifactFileBestEffort(current.storedFilePath, "old uploaded release artifact after switching to external");
    }
    return this.getAdminReleaseBestEffort(
      releaseId,
      this.buildArtifactMutationFallback(release, [this.fallbackArtifactFromCreate(updatedArtifact)]),
      "update release artifact response refresh"
    );
  }

  async uploadReleaseArtifact(
    releaseId: string,
    input: UploadReleaseArtifactInputDto,
    file?: UploadedReleaseFile
  ): Promise<AdminReleaseRecordDto> {
    const release = await this.ensureReleaseExists(releaseId);
    this.assertReleaseArtifactsMutable(release);
    assertReleaseArtifactTypeAllowed(release.platform as PlatformTarget, input.type);
    const deliveryMode = resolveReleaseArtifactDeliveryMode(
      release.platform as PlatformTarget,
      input.type,
      input.deliveryMode
    );
    if (!file) {
      throw new BadRequestException("请先选择要上传的安装包文件");
    }
    const isPrimary = normalizeOptionalBoolean(input.isPrimary);
    const isFullPackage = normalizeOptionalBoolean(input.isFullPackage);

    const artifactId = createId("artifact");
    let prepared: PreparedUploadedReleaseArtifactFile | null = null;
    try {
      prepared = await this.prepareUploadedReleaseArtifactFile(releaseId, artifactId, file, input.fileName);
      if (deliveryMode === "desktop_full_replace") {
        await assertWindowsFullUpdateZipFile(prepared.absolutePath, prepared.fileName, release.version);
      }
      const preparedFile = prepared;
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
            type: toPrismaReleaseArtifactType(input.type),
            deliveryMode,
            downloadUrl: preparedFile.downloadUrl,
            defaultMirrorPrefix: null,
            allowClientMirror: false,
            fileName: preparedFile.fileName,
            storedFilePath: preparedFile.storedFilePath,
            fileSizeBytes: preparedFile.fileSizeBytes,
            fileHash: preparedFile.fileHash,
            isPrimary: isPrimary ?? false,
            isFullPackage: isFullPackage ?? true
          }
        });
      });
      const fallback = this.buildArtifactMutationFallback(release, [this.fallbackArtifactFromCreate(createdArtifact)]);
      return this.getAdminReleaseBestEffort(releaseId, fallback, "upload release artifact response refresh");
    } catch (error) {
      await this.cleanupFailedReleaseArtifactUpload(prepared ? prepared.absolutePath : file.path, "failed release artifact upload");
      throw error;
    }
  }

  async replaceReleaseArtifactUpload(
    releaseId: string,
    artifactId: string,
    input: UploadReleaseArtifactInputDto,
    file?: UploadedReleaseFile
  ): Promise<AdminReleaseRecordDto> {
    if (!file) {
      throw new BadRequestException("请先选择要上传的安装包文件");
    }
    const current = await this.prisma.releaseArtifact.findFirst({
      where: { id: artifactId, releaseId }
    });
    if (!current) {
      throw new NotFoundException("发布产物不存在");
    }
    const release = await this.ensureReleaseExists(releaseId);
    this.assertReleaseArtifactsMutable(release);
    assertReleaseArtifactTypeAllowed(release.platform as PlatformTarget, input.type);
    const deliveryMode = resolveReleaseArtifactDeliveryMode(
      release.platform as PlatformTarget,
      input.type,
      input.deliveryMode
    );

    const previousStoredFilePath = current.storedFilePath;
    const isPrimary = normalizeOptionalBoolean(input.isPrimary);
    const isFullPackage = normalizeOptionalBoolean(input.isFullPackage);
    let prepared: PreparedUploadedReleaseArtifactFile | null = null;
    try {
      prepared = await this.prepareUploadedReleaseArtifactFile(releaseId, artifactId, file, input.fileName);
      if (deliveryMode === "desktop_full_replace") {
        await assertWindowsFullUpdateZipFile(prepared.absolutePath, prepared.fileName, release.version);
      }
      const preparedFile = prepared;
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
            type: toPrismaReleaseArtifactType(input.type),
            deliveryMode,
            downloadUrl: preparedFile.downloadUrl,
            defaultMirrorPrefix: null,
            allowClientMirror: false,
            fileName: preparedFile.fileName,
            storedFilePath: preparedFile.storedFilePath,
            fileSizeBytes: preparedFile.fileSizeBytes,
            fileHash: preparedFile.fileHash,
            isPrimary: isPrimary ?? current.isPrimary,
            isFullPackage: isFullPackage ?? current.isFullPackage
          }
        });
      });
      const fallback = this.buildArtifactMutationFallback(release, [this.fallbackArtifactFromCreate(updatedArtifact)]);
      if (prepared && previousStoredFilePath && previousStoredFilePath !== prepared.storedFilePath) {
        await this.removeReleaseArtifactFileBestEffort(previousStoredFilePath, "old uploaded release artifact after replacement");
      }
      return this.getAdminReleaseBestEffort(releaseId, fallback, "replace release artifact response refresh");
    } catch (error) {
      await this.cleanupFailedReleaseArtifactUpload(
        prepared ? prepared.absolutePath : file.path,
        "failed release artifact replacement upload"
      );
      throw error;
    }
  }

  async deleteReleaseArtifact(releaseId: string, artifactId: string): Promise<AdminReleaseRecordDto> {
    const release = await this.ensureReleaseExists(releaseId);
    this.assertReleaseArtifactsMutable(release);
    const artifact = await this.prisma.releaseArtifact.findFirst({
      where: { id: artifactId, releaseId }
    });
    if (!artifact) {
      throw new NotFoundException("发布产物不存在");
    }
    const siblings = await this.prisma.releaseArtifact.findMany({
      where: { releaseId },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }]
    });
    const nextPrimary = artifact.isPrimary ? siblings.find((item) => item.id !== artifactId) ?? null : null;
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
    if (artifact.storedFilePath) {
      await this.removeReleaseArtifactFileBestEffort(artifact.storedFilePath, "deleted release artifact file");
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
    );
  }

  async validateReleaseArtifact(releaseId: string, artifactId: string): Promise<AdminReleaseArtifactValidationDto> {
    const artifact = await this.prisma.releaseArtifact.findFirst({
      where: { id: artifactId, releaseId }
    });
    if (!artifact) {
      throw new NotFoundException("发布产物不存在");
    }

    const release = await this.ensureReleaseExists(releaseId);
    const releasePlatform = release.platform as PlatformTarget;
    const artifactType = fromPrismaReleaseArtifactType(artifact.type);
    const artifactDeliveryMode = artifact.deliveryMode as UpdateDeliveryMode;
    try {
      assertReleaseArtifactTypeAllowed(releasePlatform, artifactType);
      assertReleaseArtifactDeliveryAllowed(releasePlatform, artifactType, artifactDeliveryMode);
    } catch (error) {
      return {
        artifactId,
        status: "metadata_mismatch",
        message: error instanceof Error ? error.message : "Release artifact protocol is invalid."
      };
    }

    if (artifact.source === "external") {
      const url = artifact.downloadUrl.trim();
      if (!url || !/^https?:\/\//i.test(url)) {
        return {
          artifactId,
          status: "missing_download_url",
          message: "外部下载地址为空或格式不正确，请填写完整的 http/https 地址。"
        };
      }
      try {
        assertExternalReleaseArtifactUrlMatchesType(artifactType, url);
        const metadata = await this.resolveExternalReleaseArtifactMetadata(
          artifactType,
          url,
          artifact.defaultMirrorPrefix
        );
        const actualFileSizeBytes = metadata?.fileSizeBytes?.toString() ?? null;
        const actualFileHash = metadata?.fileHash ?? null;
        const nextFileName = metadata?.fileName ?? artifact.fileName ?? null;
        const nextFileSizeBytes = metadata?.fileSizeBytes ?? artifact.fileSizeBytes ?? null;
        const nextFileHash = metadata?.fileHash ?? artifact.fileHash ?? null;

        if (
          artifactDeliveryMode !== "desktop_full_replace" &&
          (
          nextFileName !== artifact.fileName ||
          nextFileSizeBytes?.toString() !== artifact.fileSizeBytes?.toString() ||
          nextFileHash !== artifact.fileHash
          )
        ) {
          try {
            await this.prisma.releaseArtifact.update({
              where: { id: artifactId },
              data: {
                fileName: nextFileName,
                fileSizeBytes: nextFileSizeBytes,
                fileHash: nextFileHash
              }
            });
          } catch (error) {
            return {
              artifactId,
              status: "metadata_mismatch",
              message: `External artifact is reachable, but saving refreshed metadata failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
              actualFileSizeBytes,
              actualFileHash
            };
          }
        }

        const clientResolvedArtifact = resolveReleaseArtifactForClient(
          {
            ...artifact,
            fileName: nextFileName,
            fileSizeBytes: nextFileSizeBytes,
            fileHash: nextFileHash
          },
          null
        );
        if (artifactDeliveryMode !== "desktop_full_replace") {
          try {
            assertReleaseArtifactClientUsable(clientResolvedArtifact, releasePlatform);
          } catch (error) {
            return {
              artifactId,
              status: "metadata_mismatch",
              message: error instanceof Error ? error.message : "Release artifact is not client-usable.",
              actualFileSizeBytes,
              actualFileHash
            };
          }
        }

        if (artifactDeliveryMode === "desktop_full_replace") {
          const downloadUrl = clientResolvedArtifact.downloadUrl;
          const downloaded = await downloadExternalReleaseArtifactFileStrict(downloadUrl);
          const requiredFileSizeBytes = nextFileSizeBytes ?? downloaded.fileSizeBytes;
          const requiredFileHash = normalizeSha256Input(nextFileHash ?? downloaded.fileHash);
          if (nextFileSizeBytes && nextFileSizeBytes !== downloaded.fileSizeBytes) {
            await this.cleanupDownloadedExternalReleaseArtifact(downloaded);
            return {
              artifactId,
              status: "metadata_mismatch",
              message: `Full replacement ZIP size mismatch: expected ${nextFileSizeBytes.toString()}, got ${downloaded.fileSizeBytes.toString()}.`,
              actualFileSizeBytes: downloaded.fileSizeBytes.toString(),
              actualFileHash: downloaded.fileHash
            };
          }
          if (nextFileHash && nextFileHash !== downloaded.fileHash) {
            await this.cleanupDownloadedExternalReleaseArtifact(downloaded);
            return {
              artifactId,
              status: "metadata_mismatch",
              message: "Full replacement ZIP SHA256 does not match metadata.",
              actualFileSizeBytes: downloaded.fileSizeBytes.toString(),
              actualFileHash: downloaded.fileHash
            };
          }
          if (!nextFileSizeBytes || !nextFileHash || downloaded.fileName !== nextFileName) {
            try {
              await this.prisma.releaseArtifact.update({
                where: { id: artifactId },
                data: {
                  fileName: downloaded.fileName ?? nextFileName,
                  fileSizeBytes: requiredFileSizeBytes,
                  fileHash: requiredFileHash
                }
              });
            } catch (error) {
              await this.cleanupDownloadedExternalReleaseArtifact(downloaded);
              return {
                artifactId,
                status: "metadata_mismatch",
                message: `External artifact is reachable, but saving refreshed metadata failed: ${
                  error instanceof Error ? error.message : String(error)
                }`,
                actualFileSizeBytes: downloaded.fileSizeBytes.toString(),
                actualFileHash: downloaded.fileHash
              };
            }
          }
          let metadataError: string | null = null;
          if (!requiredFileSizeBytes || requiredFileSizeBytes <= 0n) {
            metadataError = "Full replacement updates require positive file size metadata before publishing.";
          } else if (!requiredFileHash) {
            metadataError = "Full replacement updates require SHA256 metadata before publishing.";
          } else {
            try {
              normalizeSha256Input(requiredFileHash);
            } catch (error) {
              metadataError = error instanceof Error ? error.message : "Full replacement update SHA256 metadata is invalid.";
            }
          }
          if (metadataError) {
            await this.cleanupDownloadedExternalReleaseArtifact(downloaded);
            return {
              artifactId,
              status: "metadata_mismatch",
              message: metadataError,
              actualFileSizeBytes: downloaded.fileSizeBytes.toString(),
              actualFileHash: downloaded.fileHash
            };
          }
          if (!requiredFileSizeBytes || !requiredFileHash) {
            await this.cleanupDownloadedExternalReleaseArtifact(downloaded);
            return {
              artifactId,
              status: "metadata_mismatch",
              message: "Full replacement updates require positive size and SHA256 metadata.",
              actualFileSizeBytes: downloaded.fileSizeBytes.toString(),
              actualFileHash: downloaded.fileHash
            };
          }
          const resolvedArtifact = resolveReleaseArtifactForClient(
            {
              ...artifact,
              fileSizeBytes: requiredFileSizeBytes,
              fileHash: requiredFileHash
            },
            null
          );
          try {
            assertReleaseArtifactClientUsable(resolvedArtifact, releasePlatform);
          } catch (error) {
            await this.cleanupDownloadedExternalReleaseArtifact(downloaded);
            return {
              artifactId,
              status: "metadata_mismatch",
              message: error instanceof Error ? error.message : "Full replacement update URL is invalid.",
              actualFileSizeBytes: downloaded.fileSizeBytes.toString(),
              actualFileHash: downloaded.fileHash
            };
          }

          try {
            assertReleaseArtifactClientUsable(
              {
                ...resolvedArtifact,
                downloadUrl: downloaded.resolvedUrl,
                fileSizeBytes: requiredFileSizeBytes,
                fileHash: requiredFileHash
              },
              releasePlatform
            );
            if (downloaded.fileSizeBytes !== requiredFileSizeBytes) {
              return {
                artifactId,
                status: "metadata_mismatch",
                message: `Full replacement ZIP size mismatch: expected ${requiredFileSizeBytes.toString()}, got ${downloaded.fileSizeBytes.toString()}.`,
                actualFileSizeBytes: downloaded.fileSizeBytes.toString(),
                actualFileHash: downloaded.fileHash
              };
            }
            if (downloaded.fileHash !== requiredFileHash) {
              return {
                artifactId,
                status: "metadata_mismatch",
                message: "Full replacement ZIP SHA256 does not match metadata.",
                actualFileSizeBytes: downloaded.fileSizeBytes.toString(),
                actualFileHash: downloaded.fileHash
              };
            }
            await assertWindowsFullUpdateZipFile(downloaded.absolutePath, downloaded.fileName ?? artifact.fileName, release.version);
          } catch (error) {
            return {
              artifactId,
              status: "metadata_mismatch",
              message: error instanceof Error ? error.message : "Windows full replacement ZIP is invalid.",
              actualFileSizeBytes: downloaded.fileSizeBytes.toString(),
              actualFileHash: downloaded.fileHash
            };
          } finally {
            await this.cleanupDownloadedExternalReleaseArtifact(downloaded);
          }
        }

        return {
          artifactId,
          status: "ready",
          message:
            actualFileSizeBytes || actualFileHash
              ? "外部下载地址可访问，已回填可识别的文件元信息。"
              : "外部下载地址可访问，但当前链接没有返回文件大小或 Hash。",
          actualFileSizeBytes,
          actualFileHash
        };
      } catch (error) {
        return {
          artifactId,
          status: "invalid_link",
          message: error instanceof Error ? error.message : "外部下载地址与安装器类型不匹配。"
        };
      }
    }

    if (!artifact.storedFilePath) {
      return {
        artifactId,
        status: "missing_file",
        message: "上传文件记录不完整，请重新上传安装包。"
      };
    }

    const absolutePath = resolveReleaseArtifactAbsolutePath(artifact.storedFilePath);
    try {
      await ensureFileReadable(absolutePath);
    } catch {
      return {
        artifactId,
        status: "missing_file",
        message: "服务器上的安装包文件已丢失，请重新上传。"
      };
    }

    const stat = await import("node:fs/promises").then((module) => module.stat(absolutePath));
    const actualFileHash = await calculateFileSha256(absolutePath);
    const actualFileSizeBytes = stat.size.toString();
    const hashMatches = !artifact.fileHash || artifact.fileHash === actualFileHash;
    const sizeMatches = !artifact.fileSizeBytes || artifact.fileSizeBytes.toString() === actualFileSizeBytes;

    if (!hashMatches || !sizeMatches) {
      return {
        artifactId,
        status: "metadata_mismatch",
        message: "服务器文件存在，但记录里的大小或 Hash 与真实文件不一致，建议重新上传覆盖。",
        actualFileSizeBytes,
        actualFileHash
      };
    }

    const nextFileSizeBytes = artifact.fileSizeBytes ?? BigInt(actualFileSizeBytes);
    const nextFileHash = artifact.fileHash ?? actualFileHash;
    if (!artifact.fileSizeBytes || !artifact.fileHash) {
      try {
        await this.prisma.releaseArtifact.update({
          where: { id: artifactId },
          data: {
            fileSizeBytes: nextFileSizeBytes,
            fileHash: nextFileHash
          }
        });
      } catch (error) {
        return {
          artifactId,
          status: "metadata_mismatch",
          message: `Uploaded artifact is readable, but saving refreshed metadata failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          actualFileSizeBytes,
          actualFileHash
        };
      }
    }

    const resolvedUploadedArtifact = resolveReleaseArtifactForClient(
      {
        ...artifact,
        fileSizeBytes: nextFileSizeBytes,
        fileHash: nextFileHash
      },
      null
    );
    try {
      assertReleaseArtifactClientUsable(resolvedUploadedArtifact, releasePlatform);
    } catch (error) {
      return {
        artifactId,
        status: "metadata_mismatch",
        message: error instanceof Error ? error.message : "Release artifact is not client-usable.",
        actualFileSizeBytes,
        actualFileHash
      };
    }

    if (artifactDeliveryMode === "desktop_full_replace") {
      if (artifact.defaultMirrorPrefix) {
        return {
          artifactId,
          status: "metadata_mismatch",
          message: "Uploaded full replacement artifacts cannot use a default mirror prefix.",
          actualFileSizeBytes,
          actualFileHash
        };
      }
      try {
        await assertWindowsFullUpdateZipFile(absolutePath, artifact.fileName, release.version);
      } catch (error) {
        return {
          artifactId,
          status: "metadata_mismatch",
          message: error instanceof Error ? error.message : "Windows full replacement ZIP is invalid.",
          actualFileSizeBytes,
          actualFileHash
        };
      }
    }

    return {
      artifactId,
      status: "ready",
      message: "服务器文件可用，下载地址和文件元信息已匹配。",
      actualFileSizeBytes,
      actualFileHash
    };
  }

  async getReleaseArtifactDownloadDescriptor(artifactId: string) {
    const artifact = await this.prisma.releaseArtifact.findUnique({
      where: { id: artifactId },
      include: { release: true }
    });
    if (!artifact || artifact.source !== "uploaded" || !artifact.storedFilePath || artifact.release.status !== "published") {
      throw new NotFoundException("安装包不存在");
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
    const release = await this.findLatestPublishedRelease(effectiveChannel, input.platform);
    if (!release) {
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
    if (compareSemver(release.minimumVersion, release.version) > 0) {
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
        deliveryMode: defaultDeliveryModeForPlatform(input.platform),
        recommendedArtifact: null,
        downloadUrl: null,
        fileName: null,
        fileSizeBytes: null,
        fileHash: null,
        publishedAt: null
      };
    }

    const preferredArtifactType = input.platform === "windows" ? "zip" : input.artifactType ?? null;
    const resolvedArtifact = await this.pickClientUsableArtifact(
      release.artifacts,
      input.platform,
      preferredArtifactType,
      input.clientMirrorPrefix ?? null
    );
    const fallbackDeliveryMode = preferredArtifactType
      ? defaultDeliveryModeForArtifact(preferredArtifactType)
      : defaultDeliveryModeForPlatform(input.platform);
    const latestVersionComparison = compareSemver(release.version, input.currentVersion);
    const mustUpgrade = compareSemver(input.currentVersion, release.minimumVersion) < 0;
    const forcedByRelease = release.forceUpgrade;

    if (!resolvedArtifact) {
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
        deliveryMode: fallbackDeliveryMode,
        recommendedArtifact: null,
        downloadUrl: null,
        fileName: null,
        fileSizeBytes: null,
        fileHash: null,
        publishedAt: release.publishedAt?.toISOString() ?? null
      };
    }

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

  async findLatestPublishedRelease(channel: ReleaseChannel, platform?: ClientUpdateCheckDto["platform"]) {
    const rows = await this.prisma.release.findMany({
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

    if (rows.length === 0) {
      return null;
    }

    return rows.sort((left, right) => {
      const versionDiff = compareSemver(right.version, left.version);
      if (versionDiff !== 0) {
        return versionDiff;
      }
      return (right.publishedAt?.getTime() ?? 0) - (left.publishedAt?.getTime() ?? 0);
    })[0];
  }

  private async assertReleasePublishable(releaseId: string) {
    const release = await this.prisma.release.findUnique({
      where: { id: releaseId },
      include: {
        artifacts: {
          orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }]
        }
      }
    });
    if (!release) {
      throw new NotFoundException("发布记录不存在");
    }
    this.assertReleaseRecordMutable(release);
    const primaryArtifact = release.artifacts.find((item) => item.isPrimary) ?? release.artifacts[0];
    if (!primaryArtifact) {
      throw new BadRequestException("请先上传或配置至少一个安装产物，再发布版本");
    }
    assertMinimumVersionNotAboveRelease(release.version, release.minimumVersion);
    if (release.platform === "windows") {
      const windowsFullReplaceArtifact = release.artifacts.find(
        (artifact) =>
          fromPrismaReleaseArtifactType(artifact.type) === "zip" &&
          (artifact.deliveryMode as UpdateDeliveryMode) === "desktop_full_replace"
      );
      if (!windowsFullReplaceArtifact) {
        throw new BadRequestException("Windows releases require a ZIP full replacement artifact before publishing.");
      }
    }
    const validationByArtifactId = new Map<string, AdminReleaseArtifactValidationDto>();
    for (const artifact of release.artifacts) {
      const artifactValidation = await this.validateReleaseArtifact(releaseId, artifact.id);
      validationByArtifactId.set(artifact.id, artifactValidation);
      if (artifactValidation.status !== "ready") {
        throw new BadRequestException(`Release artifact ${artifact.fileName ?? artifact.id} is not publishable: ${artifactValidation.message}`);
      }
    }
    const validation = validationByArtifactId.get(primaryArtifact.id) ?? (await this.validateReleaseArtifact(releaseId, primaryArtifact.id));
    if (validation.status !== "ready") {
      throw new BadRequestException(`主下载产物当前不可发布：${validation.message}`);
    }
  }

  private async pickClientUsableArtifact(
    artifacts: ReleaseRowLike["artifacts"],
    platform: PlatformTarget,
    preferredType?: ReleaseArtifactType | null,
    clientMirrorPrefix?: string | null
  ) {
    const scopedArtifacts = preferredType
      ? artifacts.filter((item) => fromPrismaReleaseArtifactType(item.type) === preferredType)
      : artifacts;
    const preferred = pickPrimaryReleaseArtifact(scopedArtifacts, preferredType);
    const candidates = preferred
      ? [preferred, ...scopedArtifacts.filter((item) => item.id !== preferred.id)]
      : scopedArtifacts;
    for (const artifact of candidates) {
      try {
        await this.assertStoredReleaseArtifactReadable(artifact);
        const resolvedArtifact = resolveReleaseArtifactForClient(artifact, clientMirrorPrefix ?? null);
        assertReleaseArtifactClientUsable(resolvedArtifact, platform);
        return resolvedArtifact;
      } catch {
        if (clientMirrorPrefix?.trim()) {
          try {
            await this.assertStoredReleaseArtifactReadable(artifact);
            const resolvedArtifact = resolveReleaseArtifactForClient(artifact, null);
            assertReleaseArtifactClientUsable(resolvedArtifact, platform);
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
      throw new BadRequestException("Uploaded release artifact is missing its stored file.");
    }
    const absolutePath = resolveReleaseArtifactAbsolutePath(artifact.storedFilePath);
    await ensureFileReadable(absolutePath);
    const fs = await import("node:fs/promises");
    const stat = await fs.stat(absolutePath);
    if (!artifact.fileSizeBytes || artifact.fileSizeBytes !== BigInt(stat.size)) {
      throw new BadRequestException("Uploaded release artifact size metadata does not match the stored file.");
    }
    if (!artifact.fileHash) {
      throw new BadRequestException("Uploaded release artifact is missing SHA256 metadata.");
    }
    const actualHash = await calculateFileSha256(absolutePath);
    if (actualHash !== artifact.fileHash) {
      throw new BadRequestException("Uploaded release artifact SHA256 metadata does not match the stored file.");
    }
  }

  private assertReleaseArtifactsMutable(release: { status: string }) {
    if (release.status !== "draft") {
      throw new BadRequestException("请先撤回发布，再调整安装产物。");
    }
  }

  private assertReleaseRecordMutable(release: { status: string }) {
    if (release.status === "archived") {
      throw new BadRequestException("Archived releases are read-only.");
    }
  }

  private async prepareInitialExternalReleaseArtifact(
    platform: PlatformTarget,
    releaseId: string,
    input: CreateReleaseArtifactInputDto
  ) {
    const source = input.source ?? "external";
    if (source !== "external") {
      throw new BadRequestException("首个安装产物只支持外部链接，请先创建草稿后再走上传接口。");
    }
    assertReleaseArtifactTypeAllowed(platform, input.type);
    const deliveryMode = resolveReleaseArtifactDeliveryMode(platform, input.type, input.deliveryMode);
    assertExternalReleaseArtifactUrlMatchesType(input.type, input.downloadUrl);

    const defaultMirrorPrefix = normalizeNullableText(input.defaultMirrorPrefix);
    const externalMetadata = await this.resolveExternalReleaseArtifactMetadata(
      input.type,
      input.downloadUrl,
      defaultMirrorPrefix
    );
    const fileSizeBytes = externalMetadata?.fileSizeBytes ?? normalizeFileSizeBytes(input.fileSizeBytes) ?? null;
    const fileHash = externalMetadata?.fileHash ?? normalizeSha256Input(input.fileHash) ?? null;
    const artifactId = createId("artifact");
    const isFullPackage = normalizeOptionalBoolean(input.isFullPackage);

    return {
      id: artifactId,
      releaseId,
      source,
      type: toPrismaReleaseArtifactType(input.type),
      deliveryMode,
      downloadUrl: input.downloadUrl.trim(),
      defaultMirrorPrefix,
      allowClientMirror: input.allowClientMirror ?? true,
      fileName: externalMetadata?.fileName ?? normalizeNullableText(input.fileName),
      storedFilePath: null,
      fileSizeBytes,
      fileHash,
      isPrimary: true,
      isFullPackage: isFullPackage ?? true
    };
  }

  private async resolveExternalReleaseArtifactMetadata(
    type: ReleaseArtifactType,
    rawUrl: string,
    defaultMirrorPrefix?: string | null
  ) {
    assertExternalReleaseArtifactUrlMatchesType(type, rawUrl);
    return fetchExternalReleaseArtifactMetadata(rawUrl, defaultMirrorPrefix);
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

    const fs = await import("node:fs/promises");
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await moveUploadedFile(file.path, absolutePath);

    return {
      absolutePath,
      storedFilePath,
      fileName: finalFileName,
      fileSizeBytes: BigInt(file.size),
      fileHash: await calculateFileSha256(absolutePath),
      downloadUrl: buildReleaseArtifactDownloadUrl(artifactId)
    };
  }

  private async getAdminReleaseBestEffort(releaseId: string, fallback: AdminReleaseRecordDto, label: string) {
    try {
      return await this.getAdminRelease(releaseId);
    } catch (error) {
      this.logger.warn(
        `Local release change saved, but ${label} failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return fallback;
    }
  }

  private async getAdminRelease(releaseId: string): Promise<AdminReleaseRecordDto> {
    const row = await this.prisma.release.findUnique({
      where: { id: releaseId },
      include: {
        artifacts: {
          orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }]
        }
      }
    });
    if (!row) {
      throw new NotFoundException("发布记录不存在");
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

  private async cleanupDownloadedExternalReleaseArtifact(
    downloaded: Awaited<ReturnType<typeof downloadExternalReleaseArtifactFileStrict>>
  ) {
    await this.runReleaseCleanupBestEffort("temporary external release artifact", downloaded.cleanup);
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
      await Promise.race([cleanupTask, timeoutTask]);
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

  private async ensureReleaseExists(releaseId: string) {
    const row = await this.prisma.release.findUnique({
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
    if (!row) {
      throw new NotFoundException("发布记录不存在");
    }
    return row;
  }
}

function assertMinimumVersionNotAboveRelease(version: string, minimumVersion: string) {
  if (compareSemver(minimumVersion, version) > 0) {
    throw new BadRequestException("minimumVersion must not be greater than release version.");
  }
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
