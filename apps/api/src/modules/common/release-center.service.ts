import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
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
import {
  assertReleaseArtifactTypeAllowed,
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

@Injectable()
export class ReleaseCenterService {
  private readonly logger = new Logger(ReleaseCenterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clientEventsPublisher: ClientEventsPublisher,
    private readonly adminRuntimeEventsService: AdminRuntimeEventsService
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
      throw new BadRequestException("Create a draft release and add an artifact before publishing.");
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
      throw new NotFoundException("Release record does not exist.");
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
      throw new BadRequestException("Use the upload endpoint to create uploaded artifacts.");
    }

    if (rawSource !== undefined && rawSource !== "external") {
      throw new BadRequestException("Release artifact source must be external.");
    }
    const source = "external";

    assertExternalReleaseArtifactDownloadUrl(input.downloadUrl);
    assertDesktopReleaseArtifactUsesHttps(release.platform as PlatformTarget, input.downloadUrl);
    const artifactId = createId("artifact");
    const isPrimary = normalizeOptionalBoolean(input.isPrimary);
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
          defaultMirrorPrefix: null,
          allowClientMirror: false,
          fileName: normalizeNullableText(input.fileName),
          storedFilePath: null,
          fileSizeBytes: null,
          fileHash: null,
          isPrimary: isPrimary ?? false,
          isFullPackage: true
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
      throw new NotFoundException("Release artifact does not exist.");
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
    const inferredExternalType =
      nextSource === "external" && input.downloadUrl !== undefined && input.type === undefined
        ? inferExternalReleaseArtifactType(platform, nextDownloadUrl, currentType)
        : undefined;
    const nextType = input.type ?? inferredExternalType ?? currentType;
    if (input.source === "uploaded" && current.source !== "uploaded") {
      throw new BadRequestException("Use the upload endpoint to switch to an uploaded artifact.");
    }

    if (nextSource === "uploaded" && input.downloadUrl !== undefined && input.downloadUrl.trim() !== current.downloadUrl) {
      throw new BadRequestException("Uploaded release artifact URLs are managed by the upload endpoint.");
    }
    if (nextSource === "uploaded" && !current.storedFilePath) {
      throw new BadRequestException("Uploaded release artifact is missing its stored file.");
    }

    if (nextSource === "external") {
      assertExternalReleaseArtifactDownloadUrl(nextDownloadUrl);
      assertDesktopReleaseArtifactUsesHttps(release.platform as PlatformTarget, nextDownloadUrl);
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
                fileSizeBytes: null,
                fileHash: null
              }
            : {}),
          ...(nextSource !== "external" && input.fileName !== undefined ? { fileName: normalizeNullableText(input.fileName) } : {}),
          ...(isPrimary !== undefined ? { isPrimary } : {}),
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
    if (!file) {
      throw new BadRequestException("Select an installer package file first.");
    }
    const platform = release.platform as PlatformTarget;
    const uploadType = inferUploadedReleaseArtifactType(platform, input.fileName || file.originalname, input.type);
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
      throw new BadRequestException("Select an installer package file first.");
    }
    const current = await this.prisma.releaseArtifact.findFirst({
      where: { id: artifactId, releaseId }
    });
    if (!current) {
      throw new NotFoundException("Release artifact does not exist.");
    }
    const release = await this.ensureReleaseExists(releaseId);
    this.assertReleaseArtifactsMutable(release);
    const platform = release.platform as PlatformTarget;
    const uploadType = inferUploadedReleaseArtifactType(platform, input.fileName || file.originalname, input.type);
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
      throw new NotFoundException("Release artifact does not exist.");
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

  async getReleaseArtifactDownloadDescriptor(artifactId: string) {
    const artifact = await this.prisma.releaseArtifact.findUnique({
      where: { id: artifactId },
      include: { release: true }
    });
    if (!artifact || artifact.source !== "uploaded" || !artifact.storedFilePath || artifact.release.status !== "published") {
      throw new NotFoundException("Installer package does not exist.");
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
      throw new NotFoundException("Release record does not exist.");
    }
    this.assertReleaseRecordMutable(release);
    const primaryArtifact = release.artifacts.find((item) => item.isPrimary) ?? release.artifacts[0];
    if (!primaryArtifact) {
      throw new BadRequestException("Add at least one installer artifact before publishing.");
    }
    let lastArtifactError: unknown = null;
    for (const artifact of release.artifacts) {
      try {
        await this.assertStoredReleaseArtifactReadable(artifact);
        lastArtifactError = null;
        break;
      } catch (error) {
        lastArtifactError = error;
      }
    }
    if (lastArtifactError) {
      throw lastArtifactError;
    }
    assertMinimumVersionNotAboveRelease(release.version, release.minimumVersion);
  }

  private async pickClientUsableArtifact(
    artifacts: ReleaseRowLike["artifacts"],
    platform: PlatformTarget,
    preferredType?: ReleaseArtifactType | null,
    clientMirrorPrefix?: string | null
  ) {
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
        await this.assertStoredReleaseArtifactReadable(artifact);
        const resolvedArtifact = resolveReleaseArtifactForClient(artifact, clientMirrorPrefix ?? null);
        return resolvedArtifact;
      } catch {
        if (clientMirrorPrefix?.trim()) {
          try {
            await this.assertStoredReleaseArtifactReadable(artifact);
            const resolvedArtifact = resolveReleaseArtifactForClient(artifact, null);
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
  }

  private assertReleaseArtifactsMutable(release: { status: string }) {
    if (release.status !== "draft") {
      throw new BadRequestException("Withdraw the release before editing artifacts.");
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
      throw new BadRequestException("The initial artifact only supports external links; create a draft first, then use the upload endpoint.");
    }
    assertReleaseArtifactTypeAllowed(platform, input.type);
    const deliveryMode = resolveReleaseArtifactDeliveryMode(platform, input.type, input.deliveryMode);
    assertExternalReleaseArtifactDownloadUrl(input.downloadUrl);
    assertDesktopReleaseArtifactUsesHttps(platform, input.downloadUrl);
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
      fileSizeBytes: null,
      fileHash: null,
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

    const fs = await import("node:fs/promises");
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await moveUploadedFile(file.path, absolutePath);

    return {
      absolutePath,
      storedFilePath,
      fileName: finalFileName,
      fileSizeBytes: BigInt(file.size),
      fileHash: null,
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
      throw new NotFoundException("Release record does not exist.");
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
      throw new NotFoundException("Release record does not exist.");
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
  if (normalized.endsWith(".exe")) {
    return "setup.exe";
  }
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
    if (pathname.endsWith(".exe")) {
      return "setup.exe";
    }
    return fallbackType;
  }
  if (platform === "macos") {
    return pathname.endsWith(".dmg") ? "dmg" : fallbackType;
  }
  if (platform === "android") {
    return pathname.endsWith(".apk") ? "apk" : fallbackType;
  }
  return pathname.endsWith(".ipa") ? "ipa" : fallbackType;
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
    throw new BadRequestException("minimumVersion must not be greater than release version.");
  }
}

function assertExternalReleaseArtifactDownloadUrl(rawUrl: string) {
  const normalized = rawUrl.trim();
  if (!normalized || !/^https?:\/\//i.test(normalized)) {
    throw new BadRequestException("External release artifact download URL must be a complete http/https URL.");
  }
}

function assertDesktopReleaseArtifactUsesHttps(platform: PlatformTarget, rawUrl: string) {
  if ((platform === "windows" || platform === "macos") && !/^https:\/\//i.test(rawUrl.trim())) {
    throw new BadRequestException("Desktop release artifact download URL must use HTTPS.");
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
