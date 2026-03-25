import { BadRequestException, NotFoundException } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Agent, fetch as undiciFetch } from "undici";
import type {
  AdminReleaseArtifactDto,
  AdminReleaseRecordDto,
  PlatformTarget,
  ReleaseArtifactType,
  ReleaseChannel,
  ReleaseStatus,
  UpdateDeliveryMode
} from "@chordv/shared";

const RELEASE_ARTIFACT_DOWNLOAD_PREFIX = "/api/downloads/releases";

export type ReleaseArtifactRowLike = {
  id: string;
  releaseId: string;
  source: string;
  type: string;
  deliveryMode: string;
  downloadUrl: string;
  originDownloadUrl?: string | null;
  defaultMirrorPrefix: string | null;
  allowClientMirror: boolean;
  fileName: string | null;
  fileSizeBytes: bigint | null;
  fileHash: string | null;
  isPrimary: boolean;
  isFullPackage: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type ReleaseRowLike = {
  id: string;
  platform: string;
  channel: string;
  version: string;
  displayTitle: string;
  changelog: string[];
  minimumVersion: string;
  forceUpgrade: boolean;
  status: string;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  artifacts: ReleaseArtifactRowLike[];
};

export type ExternalReleaseArtifactMetadata = {
  resolvedUrl: string;
  fileName: string | null;
  fileSizeBytes: bigint | null;
  fileHash: string | null;
};

export function createId(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export function normalizeReleaseChannel(_channel: string | null | undefined): ReleaseChannel {
  return "stable";
}

export function normalizeVersion(value: string) {
  const normalized = value.trim();
  if (!normalized) {
    throw new BadRequestException("版本号不能为空");
  }
  return normalized;
}

export function normalizeChangelog(items?: string[]) {
  return (items ?? []).map((item) => item.trim()).filter(Boolean);
}

export function normalizeNullableText(value: string | null | undefined) {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value === null ? "" : value.trim();
  return normalized ? normalized : null;
}

export function normalizeBigInt(value: string | null | undefined) {
  if (value === undefined) {
    return undefined;
  }
  if (!value) {
    return null;
  }
  return BigInt(value.trim());
}

export function normalizeOptionalBoolean(value: boolean | string | null | undefined) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return undefined;
}

export function normalizePublishedAt(status: ReleaseStatus, publishedAt?: string | null) {
  if (status === "published") {
    return publishedAt ? new Date(publishedAt) : new Date();
  }
  if (publishedAt === undefined) {
    return undefined;
  }
  return publishedAt ? new Date(publishedAt) : null;
}

export function compareSemver(left: string, right: string) {
  const leftParts = parseSemver(left);
  const rightParts = parseSemver(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts.core[index] !== rightParts.core[index]) {
      return leftParts.core[index] - rightParts.core[index];
    }
  }
  if (leftParts.prerelease === rightParts.prerelease) {
    return 0;
  }
  if (!leftParts.prerelease) {
    return 1;
  }
  if (!rightParts.prerelease) {
    return -1;
  }
  return leftParts.prerelease.localeCompare(rightParts.prerelease, undefined, { numeric: true });
}

export function parseSemver(value: string) {
  const [corePart, prerelease = ""] = value.trim().split("-", 2);
  const core = corePart.split(".").map((item) => Number.parseInt(item, 10) || 0);
  while (core.length < 3) {
    core.push(0);
  }
  return { core, prerelease };
}

export function defaultDeliveryModeForArtifact(type: ReleaseArtifactType): UpdateDeliveryMode {
  if (type === "apk") {
    return "apk_download";
  }
  if (type === "external" || type === "ipa") {
    return "external_download";
  }
  return "desktop_installer_download";
}

export function defaultDeliveryModeForPlatform(platform: PlatformTarget): UpdateDeliveryMode {
  if (platform === "android") {
    return "apk_download";
  }
  if (platform === "ios") {
    return "external_download";
  }
  return "desktop_installer_download";
}

export function assertReleaseArtifactTypeAllowed(platform: PlatformTarget, type: ReleaseArtifactType) {
  const allowed =
    platform === "macos"
      ? ["dmg", "external"]
      : platform === "windows"
        ? ["setup.exe", "external"]
        : platform === "android"
          ? ["apk", "external"]
          : ["ipa", "external"];

  if (!allowed.includes(type)) {
    throw new BadRequestException(`当前平台仅支持这些产物类型：${allowed.join("、")}`);
  }
}

export async function ensureFileReadable(filePath: string) {
  try {
    await fs.access(filePath);
  } catch {
    throw new NotFoundException("安装包文件不存在或已丢失");
  }
}

export async function removeReleaseArtifactFile(filePath: string) {
  try {
    await fs.rm(filePath, { force: true });
  } catch {
    return;
  }
}

export async function removeReleaseArtifactDirectory(directoryPath: string) {
  try {
    await fs.rm(directoryPath, { recursive: true, force: true });
  } catch {
    return;
  }
}

export function releaseArtifactStorageRoot() {
  const customRoot = (process.env.CHORDV_RELEASE_STORAGE_ROOT ?? "").trim();
  if (customRoot) {
    return path.resolve(customRoot);
  }
  return path.resolve(process.cwd(), "storage", "releases");
}

export function resolveReleaseArtifactAbsolutePath(storedFilePath: string) {
  return path.resolve(releaseArtifactStorageRoot(), storedFilePath);
}

export function buildReleaseArtifactDownloadUrl(artifactId: string) {
  const publicBaseUrl = (process.env.CHORDV_PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const relativeUrl = `${RELEASE_ARTIFACT_DOWNLOAD_PREFIX}/${artifactId}`;
  return publicBaseUrl ? `${publicBaseUrl}${relativeUrl}` : relativeUrl;
}

export function sanitizeReleaseArtifactFileName(fileName: string) {
  const trimmed = fileName.trim();
  const safe = trimmed.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/_+/g, "_");
  return safe || `artifact_${Date.now()}`;
}

export async function calculateFileSha256(filePath: string) {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}

export function toPrismaReleaseArtifactType(
  type: ReleaseArtifactType
): "dmg" | "app" | "exe" | "setup_exe" | "apk" | "ipa" | "external" {
  if (type === "setup.exe") {
    return "setup_exe";
  }
  return type;
}

export function fromPrismaReleaseArtifactType(type: string): ReleaseArtifactType {
  if (type === "setup_exe") {
    return "setup.exe";
  }
  return type as ReleaseArtifactType;
}

export function pickPrimaryReleaseArtifact(
  artifacts: ReleaseArtifactRowLike[],
  preferredType?: ReleaseArtifactType | null
) {
  const normalizedType = preferredType ? toPrismaReleaseArtifactType(preferredType) : null;
  const typedPrimary = normalizedType ? artifacts.find((item) => item.type === normalizedType && item.isPrimary) : null;
  if (typedPrimary) {
    return typedPrimary;
  }
  const typedFallback = normalizedType ? artifacts.find((item) => item.type === normalizedType) : null;
  if (typedFallback) {
    return typedFallback;
  }
  return artifacts.find((item) => item.isPrimary) ?? artifacts[0] ?? null;
}

export function resolveReleaseArtifactForClient(
  artifact: ReleaseArtifactRowLike,
  clientMirrorPrefix: string | null
) {
  const resolvedUrl = buildReleaseArtifactDownloadUrlForClient(
    artifact.downloadUrl,
    artifact.defaultMirrorPrefix,
    clientMirrorPrefix,
    artifact.allowClientMirror
  );
  return {
    ...artifact,
    downloadUrl: resolvedUrl,
    originDownloadUrl: artifact.downloadUrl
  };
}

export function buildReleaseArtifactDownloadUrlForClient(
  originUrl: string,
  defaultMirrorPrefix: string | null,
  clientMirrorPrefix: string | null,
  allowClientMirror: boolean
) {
  if (allowClientMirror && clientMirrorPrefix?.trim()) {
    return joinMirrorPrefix(clientMirrorPrefix, originUrl);
  }
  if (defaultMirrorPrefix?.trim()) {
    return joinMirrorPrefix(defaultMirrorPrefix, originUrl);
  }
  return originUrl;
}

export function joinMirrorPrefix(prefix: string, originUrl: string) {
  const trimmedPrefix = prefix.trim();
  if (!trimmedPrefix) {
    return originUrl;
  }
  if (trimmedPrefix.includes("{url}")) {
    return trimmedPrefix.replaceAll("{url}", originUrl);
  }
  return `${trimmedPrefix}${originUrl}`;
}

export async function fetchExternalReleaseArtifactMetadata(rawUrl: string, defaultMirrorPrefix?: string | null) {
  const preferredUrl = buildExternalReleaseArtifactProbeUrl(rawUrl, defaultMirrorPrefix);
  if (preferredUrl !== rawUrl) {
    try {
      return await fetchExternalReleaseArtifactMetadataWithFallback(preferredUrl, rawUrl);
    } catch {
    }
  }
  return fetchExternalReleaseArtifactMetadataWithFallback(rawUrl, rawUrl);
}

async function fetchExternalReleaseArtifactMetadataWithFallback(requestUrl: string, fallbackUrl: string) {
  const headResult = await requestExternalReleaseArtifactMetadata(requestUrl, "HEAD", fallbackUrl);
  if (headResult) {
    return headResult;
  }
  return requestExternalReleaseArtifactMetadata(requestUrl, "GET", fallbackUrl);
}

async function requestExternalReleaseArtifactMetadata(
  rawUrl: string,
  method: "HEAD" | "GET",
  fallbackUrl: string
): Promise<ExternalReleaseArtifactMetadata | null> {
  const dispatcher = createDispatcher(10_000, false);
  const headers: Record<string, string> = {
    "user-agent": "ChordV-Admin/1.0"
  };
  if (method === "GET") {
    headers.Range = "bytes=0-0";
  }

  let response: Awaited<ReturnType<typeof undiciFetch>> | null = null;
  try {
    response = await undiciFetch(rawUrl, {
      method,
      redirect: "follow",
      dispatcher,
      headers
    });

    if (!response.ok && response.status !== 206) {
      if (method === "HEAD" && (response.status === 403 || response.status === 405)) {
        return null;
      }
      throw new BadRequestException(`外部下载地址当前不可访问，HTTP ${response.status}`);
    }

    return {
      resolvedUrl: response.url || rawUrl,
      fileName: inferFileNameFromResponse(response, fallbackUrl),
      fileSizeBytes: readExternalFileSize(response.headers),
      fileHash: null
    };
  } catch (error) {
    if (method === "HEAD") {
      return null;
    }
    throw new BadRequestException(error instanceof Error ? error.message : "外部下载地址校验失败");
  } finally {
    try {
      await response?.body?.cancel();
    } catch {
    }
  }
}

export function buildExternalReleaseArtifactProbeUrl(originUrl: string, defaultMirrorPrefix?: string | null) {
  const prefix = defaultMirrorPrefix?.trim();
  if (!prefix) {
    return originUrl;
  }
  return joinMirrorPrefix(prefix, originUrl);
}

function readExternalFileSize(headers: { get(name: string): string | null }) {
  const contentRange = headers.get("content-range");
  const rangedSize = contentRange?.match(/\/(\d+)\s*$/)?.[1];
  if (rangedSize) {
    try {
      return BigInt(rangedSize);
    } catch {
      return null;
    }
  }

  const contentLength = headers.get("content-length");
  if (!contentLength) {
    return null;
  }
  const normalized = contentLength.trim();
  if (!normalized) {
    return null;
  }
  try {
    return BigInt(normalized);
  } catch {
    return null;
  }
}

function inferFileNameFromResponse(
  response: { headers: { get(name: string): string | null }; url: string },
  fallbackUrl: string
) {
  const fromHeader = parseContentDispositionFileName(response.headers.get("content-disposition"));
  if (fromHeader) {
    return fromHeader;
  }

  const effectiveUrl = response.url || fallbackUrl;
  try {
    const pathname = new URL(effectiveUrl).pathname;
    const fileName = path.posix.basename(pathname);
    if (!fileName || fileName === "/") {
      return null;
    }
    return decodeURIComponent(fileName);
  } catch {
    return null;
  }
}

function parseContentDispositionFileName(value: string | null) {
  if (!value) {
    return null;
  }

  const utf8Match = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim().replace(/^"+|"+$/g, ""));
    } catch {
      return utf8Match[1].trim().replace(/^"+|"+$/g, "");
    }
  }

  const fileNameMatch = value.match(/filename\s*=\s*([^;]+)/i);
  if (!fileNameMatch?.[1]) {
    return null;
  }

  return fileNameMatch[1].trim().replace(/^"+|"+$/g, "") || null;
}

export function assertExternalReleaseArtifactUrlMatchesType(type: ReleaseArtifactType, rawUrl: string) {
  const url = rawUrl.trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new BadRequestException("外部下载地址为空或格式不正确，请填写完整的 http/https 地址。");
  }
  if (type === "external") {
    return;
  }

  let pathname = "";
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    throw new BadRequestException("外部下载地址格式不正确，请检查链接。");
  }

  if (type === "dmg" && !pathname.endsWith(".dmg")) {
    throw new BadRequestException("当前产物类型是 DMG 安装包，下载地址必须指向 .dmg 文件。");
  }
  if (type === "setup.exe" && !pathname.endsWith(".exe")) {
    throw new BadRequestException("当前产物类型是 Setup 安装器，下载地址必须指向 .exe 文件。");
  }
  if (type === "apk" && !pathname.endsWith(".apk")) {
    throw new BadRequestException("当前产物类型是 APK 安装包，下载地址必须指向 .apk 文件。");
  }
  if (type === "ipa" && !pathname.endsWith(".ipa")) {
    throw new BadRequestException("当前产物类型是 IPA 安装包，下载地址必须指向 .ipa 文件。");
  }
}

export function toAdminReleaseArtifactRecord(row: ReleaseArtifactRowLike): AdminReleaseArtifactDto {
  return {
    id: row.id,
    releaseId: row.releaseId,
    source: row.source as "uploaded" | "external",
    type: fromPrismaReleaseArtifactType(row.type),
    deliveryMode: row.deliveryMode as UpdateDeliveryMode,
    downloadUrl: row.downloadUrl,
    originDownloadUrl: row.originDownloadUrl ?? row.downloadUrl,
    finalUrlPreview: buildReleaseArtifactDownloadUrlForClient(
      row.originDownloadUrl ?? row.downloadUrl,
      row.defaultMirrorPrefix,
      null,
      row.allowClientMirror
    ),
    defaultMirrorPrefix: row.defaultMirrorPrefix,
    allowClientMirror: row.allowClientMirror,
    fileName: row.fileName,
    fileSizeBytes: row.fileSizeBytes?.toString() ?? null,
    fileHash: row.fileHash,
    isPrimary: row.isPrimary,
    isFullPackage: row.isFullPackage,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export function toAdminReleaseRecord(row: ReleaseRowLike): AdminReleaseRecordDto {
  return {
    id: row.id,
    platform: row.platform as AdminReleaseRecordDto["platform"],
    channel: normalizeReleaseChannel(row.channel),
    version: row.version,
    displayTitle: row.displayTitle,
    changelog: row.changelog,
    minimumVersion: row.minimumVersion,
    forceUpgrade: row.forceUpgrade,
    status: row.status === "published" ? "published" : "draft",
    publishedAt: row.publishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    artifacts: row.artifacts.map(toAdminReleaseArtifactRecord)
  };
}

function createDispatcher(timeoutMs: number, allowInsecureTls: boolean) {
  return new Agent({
    connectTimeout: timeoutMs,
    connect: {
      rejectUnauthorized: !allowInsecureTls
    }
  });
}
