import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
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
  UpdateReleaseArtifactInputDto,
  UpdateReleaseInputDto,
  UploadReleaseArtifactInputDto
} from "@chordv/shared";
import { ClientEventsPublisher } from "./client-events.publisher";
import { PrismaService } from "./prisma.service";
import {
  assertExternalReleaseArtifactUrlMatchesType,
  assertReleaseArtifactTypeAllowed,
  buildReleaseArtifactDownloadUrl,
  calculateFileSha256,
  compareSemver,
  createId,
  defaultDeliveryModeForArtifact,
  defaultDeliveryModeForPlatform,
  ensureFileReadable,
  fetchExternalReleaseArtifactMetadata,
  normalizeBigInt,
  normalizeChangelog,
  normalizeNullableText,
  normalizeOptionalBoolean,
  normalizePublishedAt,
  normalizeReleaseChannel,
  normalizeVersion,
  pickPrimaryReleaseArtifact,
  releaseArtifactStorageRoot,
  removeReleaseArtifactDirectory,
  removeReleaseArtifactFile,
  resolveReleaseArtifactAbsolutePath,
  resolveReleaseArtifactForClient,
  sanitizeReleaseArtifactFileName,
  toAdminReleaseArtifactRecord,
  toAdminReleaseRecord,
  toPrismaReleaseArtifactType,
  fromPrismaReleaseArtifactType
} from "./release-center.utils";

type UploadedReleaseFile = {
  path: string;
  originalname: string;
  size: number;
};

@Injectable()
export class ReleaseCenterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clientEventsPublisher: ClientEventsPublisher
  ) {}

  async listAdminReleases(): Promise<AdminReleaseRecordDto[]> {
    const rows = await this.prisma.release.findMany({
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
    const baseReleaseData = {
      id: releaseId,
      platform: input.platform,
      channel: normalizeReleaseChannel(input.channel),
      version: normalizeVersion(input.version),
      displayTitle: input.displayTitle.trim(),
      changelog: normalizeChangelog(input.changelog),
      minimumVersion: normalizeVersion(input.minimumVersion),
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
        await tx.releaseArtifact.create({
          data: preparedArtifact
        });
        return release;
      });

      return this.getAdminRelease(created.id);
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

    const baseData = {
      ...(input.displayTitle !== undefined ? { displayTitle: input.displayTitle.trim() } : {}),
      ...(input.changelog !== undefined ? { changelog: normalizeChangelog(input.changelog) } : {}),
      ...(input.minimumVersion !== undefined ? { minimumVersion: normalizeVersion(input.minimumVersion) } : {}),
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
      await this.clientEventsPublisher.publishVersionUpdated(
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
        await this.clientEventsPublisher.publishVersionUpdated(
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
        await this.clientEventsPublisher.publishVersionUpdated(
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
    await this.clientEventsPublisher.publishVersionUpdated(
      updated.platform as PlatformTarget,
      updated.channel as ReleaseChannel
    );
    return toAdminReleaseRecord(updated);
  }

  async unpublishRelease(releaseId: string): Promise<AdminReleaseRecordDto> {
    await this.ensureReleaseExists(releaseId);
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
    await this.clientEventsPublisher.publishVersionUpdated(
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

    const storedFilePaths = release.artifacts
      .map((artifact) => artifact.storedFilePath)
      .filter((value): value is string => Boolean(value));

    await this.prisma.release.delete({
      where: { id: releaseId }
    });

    await Promise.all(
      storedFilePaths.map((storedFilePath) =>
        removeReleaseArtifactFile(resolveReleaseArtifactAbsolutePath(storedFilePath))
      )
    );
    await removeReleaseArtifactDirectory(path.join(releaseArtifactStorageRoot(), releaseId));

    if (release.status === "published") {
      await this.clientEventsPublisher.publishVersionUpdated(
        release.platform as PlatformTarget,
        release.channel as ReleaseChannel
      );
    }

    return {
      ok: true,
      releaseId
    };
  }

  async createReleaseArtifact(releaseId: string, input: CreateReleaseArtifactInputDto): Promise<AdminReleaseRecordDto> {
    const release = await this.ensureReleaseExists(releaseId);
    this.assertReleaseArtifactsMutable(release);
    assertReleaseArtifactTypeAllowed(release.platform as PlatformTarget, input.type);
    const source = input.source ?? "external";
    if (source === "uploaded") {
      throw new BadRequestException("创建上传产物时请使用上传接口。");
    }

    const defaultMirrorPrefix = normalizeNullableText(input.defaultMirrorPrefix);
    assertExternalReleaseArtifactUrlMatchesType(input.type, input.downloadUrl);
    const externalMetadata = await this.resolveExternalReleaseArtifactMetadata(
      input.type,
      input.downloadUrl,
      defaultMirrorPrefix
    );
    const artifactId = createId("artifact");
    const isPrimary = normalizeOptionalBoolean(input.isPrimary);
    const isFullPackage = normalizeOptionalBoolean(input.isFullPackage);
    await this.prisma.$transaction(async (tx) => {
      if (isPrimary) {
        await tx.releaseArtifact.updateMany({
          where: { releaseId },
          data: { isPrimary: false }
        });
      }
      await tx.releaseArtifact.create({
        data: {
          id: artifactId,
          releaseId,
          source,
          type: toPrismaReleaseArtifactType(input.type),
          deliveryMode: input.deliveryMode ?? defaultDeliveryModeForArtifact(input.type),
          downloadUrl: input.downloadUrl.trim(),
          defaultMirrorPrefix,
          allowClientMirror: input.allowClientMirror ?? true,
          fileName: externalMetadata?.fileName ?? normalizeNullableText(input.fileName),
          storedFilePath: null,
          fileSizeBytes: externalMetadata?.fileSizeBytes ?? normalizeBigInt(input.fileSizeBytes),
          fileHash: externalMetadata?.fileHash ?? normalizeNullableText(input.fileHash),
          isPrimary: isPrimary ?? false,
          isFullPackage: isFullPackage ?? true
        }
      });
    });
    return this.getAdminRelease(releaseId);
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
      input.defaultMirrorPrefix !== undefined ? normalizeNullableText(input.defaultMirrorPrefix) : current.defaultMirrorPrefix;
    if (input.source === "uploaded" && current.source !== "uploaded") {
      throw new BadRequestException("切换为上传产物时请使用上传接口。");
    }

    const externalMetadata =
      nextSource === "external"
        ? await this.resolveExternalReleaseArtifactMetadata(nextType, nextDownloadUrl, nextDefaultMirrorPrefix)
        : null;
    if (nextSource === "external") {
      assertExternalReleaseArtifactUrlMatchesType(nextType, nextDownloadUrl);
    }
    const isPrimary = normalizeOptionalBoolean(input.isPrimary);
    const isFullPackage = normalizeOptionalBoolean(input.isFullPackage);
    await this.prisma.$transaction(async (tx) => {
      if (isPrimary) {
        await tx.releaseArtifact.updateMany({
          where: { releaseId },
          data: { isPrimary: false }
        });
      }
      await tx.releaseArtifact.update({
        where: { id: artifactId },
        data: {
          ...(input.source !== undefined ? { source: input.source } : {}),
          ...(input.type !== undefined ? { type: toPrismaReleaseArtifactType(input.type) } : {}),
          ...(input.deliveryMode !== undefined ? { deliveryMode: input.deliveryMode } : {}),
          ...(input.downloadUrl !== undefined ? { downloadUrl: input.downloadUrl.trim() } : {}),
          ...(input.defaultMirrorPrefix !== undefined ? { defaultMirrorPrefix: nextDefaultMirrorPrefix } : {}),
          ...(input.allowClientMirror !== undefined ? { allowClientMirror: input.allowClientMirror } : {}),
          ...(nextSource === "external"
            ? {
                fileName: externalMetadata?.fileName ?? normalizeNullableText(input.fileName) ?? current.fileName,
                fileSizeBytes: externalMetadata?.fileSizeBytes ?? normalizeBigInt(input.fileSizeBytes) ?? current.fileSizeBytes,
                fileHash: externalMetadata?.fileHash ?? normalizeNullableText(input.fileHash) ?? current.fileHash
              }
            : {}),
          ...(nextSource !== "external" && input.fileName !== undefined ? { fileName: normalizeNullableText(input.fileName) } : {}),
          ...(nextSource !== "external" && input.fileSizeBytes !== undefined ? { fileSizeBytes: normalizeBigInt(input.fileSizeBytes) } : {}),
          ...(nextSource !== "external" && input.fileHash !== undefined ? { fileHash: normalizeNullableText(input.fileHash) } : {}),
          ...(isPrimary !== undefined ? { isPrimary } : {}),
          ...(isFullPackage !== undefined ? { isFullPackage } : {}),
          ...(input.source === "external" ? { storedFilePath: null } : {}),
          ...(input.source === "uploaded" ? { defaultMirrorPrefix: null, allowClientMirror: true } : {})
        }
      });
    });
    if (current.storedFilePath && input.source === "external") {
      await removeReleaseArtifactFile(resolveReleaseArtifactAbsolutePath(current.storedFilePath));
    }
    return this.getAdminRelease(releaseId);
  }

  async uploadReleaseArtifact(
    releaseId: string,
    input: UploadReleaseArtifactInputDto,
    file?: UploadedReleaseFile
  ): Promise<AdminReleaseRecordDto> {
    const release = await this.ensureReleaseExists(releaseId);
    this.assertReleaseArtifactsMutable(release);
    assertReleaseArtifactTypeAllowed(release.platform as PlatformTarget, input.type);
    if (!file) {
      throw new BadRequestException("请先选择要上传的安装包文件");
    }
    const isPrimary = normalizeOptionalBoolean(input.isPrimary);
    const isFullPackage = normalizeOptionalBoolean(input.isFullPackage);

    const artifactId = createId("artifact");
    const prepared = await this.prepareUploadedReleaseArtifactFile(releaseId, artifactId, file, input.fileName);

    try {
      await this.prisma.$transaction(async (tx) => {
        if (isPrimary) {
          await tx.releaseArtifact.updateMany({
            where: { releaseId },
            data: { isPrimary: false }
          });
        }
        await tx.releaseArtifact.create({
          data: {
            id: artifactId,
            releaseId,
            source: "uploaded",
            type: toPrismaReleaseArtifactType(input.type),
            deliveryMode: input.deliveryMode ?? defaultDeliveryModeForArtifact(input.type),
            downloadUrl: prepared.downloadUrl,
            defaultMirrorPrefix: null,
            allowClientMirror: true,
            fileName: prepared.fileName,
            storedFilePath: prepared.storedFilePath,
            fileSizeBytes: prepared.fileSizeBytes,
            fileHash: prepared.fileHash,
            isPrimary: isPrimary ?? false,
            isFullPackage: isFullPackage ?? true
          }
        });
      });
    } catch (error) {
      await removeReleaseArtifactFile(prepared.absolutePath);
      throw error;
    }

    return this.getAdminRelease(releaseId);
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

    const previousStoredFilePath = current.storedFilePath;
    const isPrimary = normalizeOptionalBoolean(input.isPrimary);
    const isFullPackage = normalizeOptionalBoolean(input.isFullPackage);
    const prepared = await this.prepareUploadedReleaseArtifactFile(releaseId, artifactId, file, input.fileName);

    try {
      await this.prisma.$transaction(async (tx) => {
        if (isPrimary) {
          await tx.releaseArtifact.updateMany({
            where: { releaseId },
            data: { isPrimary: false }
          });
        }
        await tx.releaseArtifact.update({
          where: { id: artifactId },
          data: {
            source: "uploaded",
            type: toPrismaReleaseArtifactType(input.type),
            deliveryMode: input.deliveryMode ?? defaultDeliveryModeForArtifact(input.type),
            downloadUrl: prepared.downloadUrl,
            defaultMirrorPrefix: null,
            allowClientMirror: true,
            fileName: prepared.fileName,
            storedFilePath: prepared.storedFilePath,
            fileSizeBytes: prepared.fileSizeBytes,
            fileHash: prepared.fileHash,
            isPrimary: isPrimary ?? current.isPrimary,
            isFullPackage: isFullPackage ?? current.isFullPackage
          }
        });
      });
    } catch (error) {
      await removeReleaseArtifactFile(prepared.absolutePath);
      throw error;
    }

    if (previousStoredFilePath && previousStoredFilePath !== prepared.storedFilePath) {
      await removeReleaseArtifactFile(resolveReleaseArtifactAbsolutePath(previousStoredFilePath));
    }

    return this.getAdminRelease(releaseId);
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
      await removeReleaseArtifactFile(resolveReleaseArtifactAbsolutePath(artifact.storedFilePath));
    }
    return this.getAdminRelease(releaseId);
  }

  async validateReleaseArtifact(releaseId: string, artifactId: string): Promise<AdminReleaseArtifactValidationDto> {
    const artifact = await this.prisma.releaseArtifact.findFirst({
      where: { id: artifactId, releaseId }
    });
    if (!artifact) {
      throw new NotFoundException("发布产物不存在");
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
        assertExternalReleaseArtifactUrlMatchesType(fromPrismaReleaseArtifactType(artifact.type), url);
        const metadata = await this.resolveExternalReleaseArtifactMetadata(
          fromPrismaReleaseArtifactType(artifact.type),
          url,
          artifact.defaultMirrorPrefix
        );
        const actualFileSizeBytes = metadata?.fileSizeBytes?.toString() ?? null;
        const actualFileHash = metadata?.fileHash ?? null;
        const nextFileName = metadata?.fileName ?? artifact.fileName ?? null;
        const nextFileSizeBytes = metadata?.fileSizeBytes ?? artifact.fileSizeBytes ?? null;
        const nextFileHash = metadata?.fileHash ?? artifact.fileHash ?? null;

        if (
          nextFileName !== artifact.fileName ||
          nextFileSizeBytes?.toString() !== artifact.fileSizeBytes?.toString() ||
          nextFileHash !== artifact.fileHash
        ) {
          await this.prisma.releaseArtifact.update({
            where: { id: artifactId },
            data: {
              fileName: nextFileName,
              fileSizeBytes: nextFileSizeBytes,
              fileHash: nextFileHash
            }
          });
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
      where: { id: artifactId }
    });
    if (!artifact || artifact.source !== "uploaded" || !artifact.storedFilePath) {
      throw new NotFoundException("安装包不存在");
    }
    const absolutePath = resolveReleaseArtifactAbsolutePath(artifact.storedFilePath);
    await ensureFileReadable(absolutePath);
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

    const recommendedArtifact = pickPrimaryReleaseArtifact(release.artifacts, input.artifactType);
    const resolvedArtifact = recommendedArtifact ? resolveReleaseArtifactForClient(recommendedArtifact, input.clientMirrorPrefix ?? null) : null;
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
          ?? defaultDeliveryModeForPlatform(input.platform),
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
        ?? defaultDeliveryModeForPlatform(input.platform),
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
    const primaryArtifact = release.artifacts.find((item) => item.isPrimary) ?? release.artifacts[0];
    if (!primaryArtifact) {
      throw new BadRequestException("请先上传或配置至少一个安装产物，再发布版本");
    }
    const validation = await this.validateReleaseArtifact(releaseId, primaryArtifact.id);
    if (validation.status !== "ready") {
      throw new BadRequestException(`主下载产物当前不可发布：${validation.message}`);
    }
  }

  private assertReleaseArtifactsMutable(release: { status: string }) {
    if (release.status === "published") {
      throw new BadRequestException("请先撤回发布，再调整安装产物。");
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
    assertExternalReleaseArtifactUrlMatchesType(input.type, input.downloadUrl);

    const defaultMirrorPrefix = normalizeNullableText(input.defaultMirrorPrefix);
    const externalMetadata = await this.resolveExternalReleaseArtifactMetadata(
      input.type,
      input.downloadUrl,
      defaultMirrorPrefix
    );
    const artifactId = createId("artifact");
    const isFullPackage = normalizeOptionalBoolean(input.isFullPackage);

    return {
      id: artifactId,
      releaseId,
      source,
      type: toPrismaReleaseArtifactType(input.type),
      deliveryMode: input.deliveryMode ?? defaultDeliveryModeForArtifact(input.type),
      downloadUrl: input.downloadUrl.trim(),
      defaultMirrorPrefix,
      allowClientMirror: input.allowClientMirror ?? true,
      fileName: externalMetadata?.fileName ?? normalizeNullableText(input.fileName),
      storedFilePath: null,
      fileSizeBytes: externalMetadata?.fileSizeBytes ?? normalizeBigInt(input.fileSizeBytes),
      fileHash: externalMetadata?.fileHash ?? normalizeNullableText(input.fileHash),
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
    const storedFilePath = path.join(releaseId, artifactId, finalFileName);
    const absolutePath = resolveReleaseArtifactAbsolutePath(storedFilePath);

    const fs = await import("node:fs/promises");
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.rm(absolutePath, { force: true });
    await fs.rename(file.path, absolutePath);

    return {
      absolutePath,
      storedFilePath,
      fileName: finalFileName,
      fileSizeBytes: BigInt(file.size),
      fileHash: await calculateFileSha256(absolutePath),
      downloadUrl: buildReleaseArtifactDownloadUrl(artifactId)
    };
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

  private async ensureReleaseExists(releaseId: string) {
    const row = await this.prisma.release.findUnique({
      where: { id: releaseId },
      select: { id: true, platform: true, status: true }
    });
    if (!row) {
      throw new NotFoundException("发布记录不存在");
    }
    return row;
  }
}
