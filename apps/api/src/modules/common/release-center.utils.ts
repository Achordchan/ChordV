import { BadRequestException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { inflateRawSync } from "node:zlib";
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
import { fetchPublicHttpUrl } from "./remote-url.utils";
import { RELEASE_ARTIFACT_MAX_UPLOAD_BYTES } from "./upload-limits";

const RELEASE_ARTIFACT_DOWNLOAD_PREFIX = "/api/downloads/releases";
const STRICT_SEMVER_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const DEFAULT_MAX_WINDOWS_FULL_UPDATE_ZIP_ENTRY_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_ZIP_VALIDATION_ENTRIES = 10_000;
const DEFAULT_EXTERNAL_RELEASE_METADATA_TIMEOUT_MS = 30_000;
const DEFAULT_EXTERNAL_RELEASE_DOWNLOAD_TIMEOUT_MS = 120_000;
const DEFAULT_EXTERNAL_RELEASE_DOWNLOAD_IDLE_TIMEOUT_MS = 15_000;
const MAX_EXTERNAL_RELEASE_ARTIFACT_BYTES = RELEASE_ARTIFACT_MAX_UPLOAD_BYTES;
const configuredMaxWindowsFullUpdateZipEntryBytes = Number(
  process.env.CHORDV_RELEASE_MAX_ZIP_ENTRY_BYTES ?? DEFAULT_MAX_WINDOWS_FULL_UPDATE_ZIP_ENTRY_BYTES
);
const MAX_WINDOWS_FULL_UPDATE_ZIP_ENTRY_BYTES =
  Number.isFinite(configuredMaxWindowsFullUpdateZipEntryBytes) && configuredMaxWindowsFullUpdateZipEntryBytes > 0
    ? Math.trunc(configuredMaxWindowsFullUpdateZipEntryBytes)
    : DEFAULT_MAX_WINDOWS_FULL_UPDATE_ZIP_ENTRY_BYTES;
const configuredMaxZipValidationEntries = Number(
  process.env.CHORDV_RELEASE_MAX_ZIP_VALIDATION_ENTRIES ?? DEFAULT_MAX_ZIP_VALIDATION_ENTRIES
);
const MAX_ZIP_VALIDATION_ENTRIES =
  Number.isFinite(configuredMaxZipValidationEntries) && configuredMaxZipValidationEntries > 0
    ? Math.trunc(configuredMaxZipValidationEntries)
    : DEFAULT_MAX_ZIP_VALIDATION_ENTRIES;

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
  storedFilePath?: string | null;
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
  const normalized = value.trim().replace(/^v(?=\d)/i, "");
  if (!normalized) {
    throw new BadRequestException("版本号不能为空");
  }
  if (!STRICT_SEMVER_PATTERN.test(normalized)) {
    throw new BadRequestException("版本号必须使用 SemVer 格式，例如 1.2.3 或 1.2.3-beta.1。");
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

export function normalizeFileSizeBytes(value: string | number | bigint | null | undefined) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  const normalized = typeof value === "string" ? value.trim() : value.toString();
  if (normalized === "") {
    return null;
  }
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new BadRequestException("文件大小必须是正整数，单位为字节。");
  }
  return BigInt(normalized);
}

export function normalizeSha256Input(value: string | null | undefined) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value.trim() === "") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new BadRequestException("SHA256 必须是 64 位十六进制字符串。");
  }
  return normalized;
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
  const normalized = normalizeVersion(value);
  const match = normalized.match(STRICT_SEMVER_PATTERN);
  if (!match) {
    throw new BadRequestException("版本号必须使用 SemVer 格式，例如 1.2.3 或 1.2.3-beta.1。");
  }
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? ""
  };
}

export function defaultDeliveryModeForArtifact(type: ReleaseArtifactType): UpdateDeliveryMode {
  if (type === "zip") {
    return "desktop_full_replace";
  }
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
  if (platform === "windows") {
    return "desktop_full_replace";
  }
  return "desktop_installer_download";
}

export function resolveReleaseArtifactDeliveryMode(
  platform: PlatformTarget,
  type: ReleaseArtifactType,
  requestedMode?: UpdateDeliveryMode | null
) {
  const deliveryMode = requestedMode ?? defaultDeliveryModeForArtifact(type);
  assertReleaseArtifactDeliveryAllowed(platform, type, deliveryMode);
  return deliveryMode;
}

export function assertReleaseArtifactDeliveryAllowed(
  platform: PlatformTarget,
  type: ReleaseArtifactType,
  deliveryMode: UpdateDeliveryMode
) {
  if (platform === "windows") {
    if (type === "zip" && deliveryMode === "desktop_full_replace") {
      return;
    }
    if (type === "external" && deliveryMode === "external_download") {
      return;
    }
    throw new BadRequestException(
      "Windows 安装包必须使用 zip + desktop_full_replace，或 external + external_download。"
    );
  }

  if (platform === "macos") {
    if ((type === "dmg" && deliveryMode === "desktop_installer_download") || (type === "external" && deliveryMode === "external_download")) {
      return;
    }
    throw new BadRequestException("macOS 安装包必须使用 dmg + desktop_installer_download，或 external + external_download。");
  }

  if (platform === "android") {
    if ((type === "apk" && deliveryMode === "apk_download") || (type === "external" && deliveryMode === "external_download")) {
      return;
    }
    throw new BadRequestException("Android 安装包必须使用 apk + apk_download，或 external + external_download。");
  }

  if ((type === "ipa" && deliveryMode === "external_download") || (type === "external" && deliveryMode === "external_download")) {
    return;
  }
  throw new BadRequestException("iOS 安装包必须使用 ipa/external + external_download。");
}

export function assertReleaseArtifactClientUsable(artifact: ReleaseArtifactRowLike, platform: PlatformTarget) {
  const type = fromPrismaReleaseArtifactType(artifact.type);
  const deliveryMode = artifact.deliveryMode as UpdateDeliveryMode;
  assertReleaseArtifactTypeAllowed(platform, type);
  assertReleaseArtifactDeliveryAllowed(platform, type, deliveryMode);

  if (artifact.fileHash) {
    normalizeSha256Input(artifact.fileHash);
  }

  if (artifact.fileSizeBytes !== null && artifact.fileSizeBytes !== undefined && artifact.fileSizeBytes <= 0n) {
    throw new BadRequestException("安装包文件大小元数据必须是正数。");
  }

  if (deliveryMode === "desktop_full_replace") {
    assertFullUpdateDownloadUrlAllowed(artifact.downloadUrl);
  }
}

export function assertReleaseArtifactTypeAllowed(platform: PlatformTarget, type: ReleaseArtifactType) {
  const allowed =
    platform === "macos"
      ? ["dmg", "external"]
      : platform === "windows"
        ? ["zip", "external"]
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
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new NotFoundException("安装包文件不存在或已丢失");
    }
    throw new ServiceUnavailableException("安装包文件暂不可读，请检查服务器磁盘、目录权限或文件存储状态。");
  }
}

export async function readZipEntryData(filePath: string, entryName: string) {
  assertZipEntryPathSafe(entryName);
  const normalizedTarget = normalizeZipEntryName(entryName);
  if (!normalizedTarget || normalizedTarget.endsWith("/")) {
    throw new BadRequestException("ZIP 条目名称必须指向文件。");
  }
  const entries = await readZipCentralDirectoryEntries(filePath);
  const entry = entries.find((item) => normalizeZipEntryName(item.name) === normalizedTarget);
  if (!entry) {
    throw new BadRequestException(`ZIP 中找不到指定文件：${entryName}`);
  }
  assertZipEntryPathSafe(entry.name);
  return verifyZipEntryData(filePath, entry);
}

async function readZipCentralDirectoryEntries(filePath: string) {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (stat.size < 22) {
      throw new BadRequestException("ZIP 文件过小，缺少有效的中央目录。");
    }
    const tailLength = Math.min(stat.size, 65_557);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, stat.size - tailLength);
    const eocdOffsetInTail = findEndOfCentralDirectory(tail);
    if (eocdOffsetInTail < 0) {
      throw new BadRequestException("ZIP 文件无效：缺少中央目录结束标记。");
    }

    const centralDirectorySize = tail.readUInt32LE(eocdOffsetInTail + 12);
    const centralDirectoryOffset = tail.readUInt32LE(eocdOffsetInTail + 16);
    if (centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) {
      throw new BadRequestException("发布校验暂不支持 ZIP64 全量替换安装包。");
    }
    if (centralDirectoryOffset + centralDirectorySize > stat.size) {
      throw new BadRequestException("ZIP 文件无效：中央目录指向文件范围之外。");
    }

    const centralDirectory = Buffer.alloc(centralDirectorySize);
    await handle.read(centralDirectory, 0, centralDirectorySize, centralDirectoryOffset);
    const entries = parseZipCentralDirectoryEntries(centralDirectory);
    if (entries.length > MAX_ZIP_VALIDATION_ENTRIES) {
      throw new BadRequestException(`ZIP 文件条目过多：${entries.length} 个，超过 ${MAX_ZIP_VALIDATION_ENTRIES} 个限制。`);
    }
    let totalCompressedSize = 0;
    let totalUncompressedSize = 0;
    for (const entry of entries) {
      totalCompressedSize += entry.compressedSize;
      totalUncompressedSize += entry.uncompressedSize;
      if (totalCompressedSize > MAX_EXTERNAL_RELEASE_ARTIFACT_BYTES || totalUncompressedSize > MAX_EXTERNAL_RELEASE_ARTIFACT_BYTES) {
        throw new BadRequestException("ZIP 解压后超过校验大小限制。");
      }
    }
    return entries;
  } finally {
    await handle.close();
  }
}

function findEndOfCentralDirectory(buffer: Buffer) {
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  return -1;
}

type ZipCentralDirectoryEntry = {
  name: string;
  compressionMethod: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

function parseZipCentralDirectoryEntries(buffer: Buffer) {
  const entries: ZipCentralDirectoryEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new BadRequestException("ZIP 文件无效：中央目录条目格式错误。");
    }
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const crc32 = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileNameStart = offset + 46;
    const fileNameEnd = fileNameStart + fileNameLength;
    if (fileNameEnd > buffer.length) {
      throw new BadRequestException("ZIP 文件无效：条目名称格式错误。");
    }
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw new BadRequestException("发布校验暂不支持 ZIP64 全量替换安装包条目。");
    }
    entries.push({
      name: buffer.subarray(fileNameStart, fileNameEnd).toString("utf8"),
      compressionMethod,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset
    });
    offset = fileNameEnd + extraLength + commentLength;
  }
  return entries;
}

async function verifyZipEntryData(filePath: string, entry: ZipCentralDirectoryEntry) {
  if (entry.name.replaceAll("\\", "/").endsWith("/")) {
    return Buffer.alloc(0);
  }
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw new BadRequestException(`ZIP 条目 ${entry.name} 使用了暂不支持的压缩方式：${entry.compressionMethod}`);
  }
  if (
    entry.compressedSize > MAX_WINDOWS_FULL_UPDATE_ZIP_ENTRY_BYTES ||
    entry.uncompressedSize > MAX_WINDOWS_FULL_UPDATE_ZIP_ENTRY_BYTES
  ) {
    throw new BadRequestException(
      `ZIP 条目 ${entry.name} 超过单文件校验限制：${MAX_WINDOWS_FULL_UPDATE_ZIP_ENTRY_BYTES} 字节。`
    );
  }

  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const localHeader = Buffer.alloc(30);
    const localHeaderRead = await handle.read(localHeader, 0, localHeader.length, entry.localHeaderOffset);
    if (localHeaderRead.bytesRead !== localHeader.length) {
      throw new BadRequestException(`ZIP 条目 ${entry.name} 的本地文件头读取不完整。`);
    }
    if (localHeader.readUInt32LE(0) !== 0x04034b50) {
      throw new BadRequestException(`ZIP 条目 ${entry.name} 的本地文件头无效。`);
    }
    const localFileNameLength = localHeader.readUInt16LE(26);
    const localExtraLength = localHeader.readUInt16LE(28);
    const dataOffset = entry.localHeaderOffset + 30 + localFileNameLength + localExtraLength;
    if (dataOffset + entry.compressedSize > stat.size) {
      throw new BadRequestException(`ZIP 条目 ${entry.name} 指向文件范围之外。`);
    }
    const compressedData = Buffer.alloc(entry.compressedSize);
    const dataRead = await handle.read(compressedData, 0, entry.compressedSize, dataOffset);
    if (dataRead.bytesRead !== entry.compressedSize) {
      throw new BadRequestException(`ZIP 条目 ${entry.name} 数据不完整。`);
    }
    const data =
      entry.compressionMethod === 0
        ? compressedData
        : inflateRawSync(compressedData, { finishFlush: 2 });
    if (data.length !== entry.uncompressedSize) {
      throw new BadRequestException(`ZIP 条目 ${entry.name} 的解压大小不一致。`);
    }
    if (crc32(data) !== entry.crc32) {
      throw new BadRequestException(`ZIP 条目 ${entry.name} 未通过 CRC 校验。`);
    }
    return data;
  } finally {
    await handle.close();
  }
}

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function normalizeZipEntryName(entry: string) {
  return entry.replaceAll("\\", "/");
}

function assertZipEntryPathSafe(entry: string) {
  const normalized = entry.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[a-z]:\//i.test(normalized)) {
    throw new BadRequestException(`ZIP 条目路径不安全：${entry}`);
  }
  const parts = normalized.split("/");
  if (parts.some((part, index) => part === ".." || (part === "" && index !== parts.length - 1))) {
    throw new BadRequestException(`ZIP 条目路径不安全：${entry}`);
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
  const storageRoot = releaseArtifactStorageRoot();
  const resolvedPath = path.resolve(storageRoot, storedFilePath);
  assertPathInsideRoot(storageRoot, resolvedPath);
  return resolvedPath;
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
): "dmg" | "app" | "exe" | "setup_exe" | "zip" | "apk" | "ipa" | "external" {
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
  clientMirrorPrefix: string | null,
  options?: {
    defaultMirrorPrefix?: string | null;
    allowClientMirror?: boolean;
  }
) {
  const originUrl = artifact.downloadUrl;
  // 上传产物走本站相对路径，不套加速镜像。
  if (artifact.source === "uploaded" || !isHttpReleaseUrl(originUrl)) {
    return {
      ...artifact,
      downloadUrl: originUrl,
      originDownloadUrl: originUrl,
      defaultMirrorPrefix: null,
      allowClientMirror: false
    };
  }

  const defaultMirrorPrefix = options?.defaultMirrorPrefix ?? null;
  const allowClientMirror = options?.allowClientMirror ?? true;
  const resolvedUrl = buildReleaseArtifactDownloadUrlForClient(
    originUrl,
    defaultMirrorPrefix,
    clientMirrorPrefix,
    allowClientMirror
  );
  return {
    ...artifact,
    downloadUrl: resolvedUrl,
    originDownloadUrl: originUrl,
    defaultMirrorPrefix,
    allowClientMirror
  };
}

export function buildReleaseArtifactDownloadUrlForClient(
  originUrl: string,
  defaultMirrorPrefix: string | null,
  clientMirrorPrefix: string | null,
  allowClientMirror: boolean
) {
  if (!isHttpReleaseUrl(originUrl)) {
    return originUrl;
  }
  if (allowClientMirror && clientMirrorPrefix?.trim()) {
    return joinMirrorPrefix(firstMirrorPrefix(clientMirrorPrefix) ?? clientMirrorPrefix, originUrl);
  }
  const defaultPrefix = firstMirrorPrefix(defaultMirrorPrefix);
  if (defaultPrefix) {
    return joinMirrorPrefix(defaultPrefix, originUrl);
  }
  return originUrl;
}

function isHttpReleaseUrl(value: string | null | undefined) {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

function firstMirrorPrefix(value: string | null | undefined) {
  if (!value) return null;
  const items = value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
  return items[0] ?? null;
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

export async function downloadExternalReleaseArtifactFile(rawUrl: string, defaultMirrorPrefix?: string | null) {
  const preferredUrl = buildExternalReleaseArtifactProbeUrl(rawUrl, defaultMirrorPrefix);
  if (preferredUrl !== rawUrl) {
    try {
      return await requestExternalReleaseArtifactFile(preferredUrl, rawUrl);
    } catch {
    }
  }
  return requestExternalReleaseArtifactFile(rawUrl, rawUrl);
}

export async function downloadExternalReleaseArtifactFileStrict(rawUrl: string) {
  return requestExternalReleaseArtifactFile(rawUrl, rawUrl);
}

async function requestExternalReleaseArtifactFile(rawUrl: string, fallbackUrl: string) {
  const dispatcher = createDispatcher(120_000, false);
  const timeout = createAbortTimeout(
    readPositiveIntegerEnv("CHORDV_RELEASE_EXTERNAL_DOWNLOAD_TIMEOUT_MS", DEFAULT_EXTERNAL_RELEASE_DOWNLOAD_TIMEOUT_MS),
    "外部全量更新 ZIP 下载请求"
  );
  let response: Awaited<ReturnType<typeof undiciFetch>> | null = null;
  try {
    const fetched = await fetchPublicHttpUrl(
      rawUrl,
      {
        method: "GET",
        dispatcher,
        signal: timeout.signal,
        headers: {
          "user-agent": "ChordV-Admin/1.0"
        }
      },
      { errorPrefix: "External release artifact URL" }
    );
    response = fetched.response;
    const resolvedUrl = fetched.resolvedUrl;
    if (!response.ok) {
      throw new BadRequestException(`外部全量更新 ZIP 当前不可访问，HTTP ${response.status}。`);
    }
    assertFullUpdateDownloadUrlAllowed(resolvedUrl);
    const contentLength = readExternalFileSize(response.headers);
    if (contentLength !== null && contentLength > BigInt(MAX_EXTERNAL_RELEASE_ARTIFACT_BYTES)) {
      throw new BadRequestException(`外部全量更新 ZIP 超过 ${MAX_EXTERNAL_RELEASE_ARTIFACT_BYTES} 字节限制。`);
    }
    const absolutePath = path.join(tmpdir(), `chordv-release-artifact-${randomUUID()}.zip`);
    const hash = createHash("sha256");
    let fileSizeBytes = 0n;
    let fileHandle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      if (!response.body) {
        throw new BadRequestException("外部全量更新 ZIP 响应内容为空。");
      }
      fileHandle = await fs.open(absolutePath, "wx");
      const reader = (response.body as {
        getReader?: () => {
          read: () => Promise<{ done: boolean; value?: Uint8Array }>;
          releaseLock?: () => void;
        };
      }).getReader?.();
      if (!reader) {
        throw new BadRequestException("外部全量更新 ZIP 响应内容不可读取。");
      }
      try {
        while (true) {
          const { done, value } = await readExternalReleaseBodyChunkWithIdleTimeout(reader);
          if (done) {
            break;
          }
          if (!value) {
            continue;
          }
          const buffer = Buffer.from(value);
          fileSizeBytes += BigInt(buffer.byteLength);
          if (fileSizeBytes > BigInt(MAX_EXTERNAL_RELEASE_ARTIFACT_BYTES)) {
            throw new BadRequestException(`外部全量更新 ZIP 超过 ${MAX_EXTERNAL_RELEASE_ARTIFACT_BYTES} 字节限制。`);
          }
          hash.update(buffer);
          await fileHandle.write(buffer);
        }
      } finally {
        reader.releaseLock?.();
      }
      await fileHandle.close();
      fileHandle = null;
    } catch (error) {
      await fileHandle?.close().catch(() => undefined);
      await fs.rm(absolutePath, { force: true }).catch(() => undefined);
      throw error;
    }
    return {
      absolutePath,
      resolvedUrl,
      fileName: inferFileNameFromResponse({ headers: response.headers, url: resolvedUrl }, fallbackUrl),
      fileSizeBytes,
      fileHash: hash.digest("hex"),
      cleanup: async () => {
        await fs.rm(absolutePath, { force: true });
      }
    };
  } catch (error) {
    throw new BadRequestException(toUserExternalReleaseArtifactMessage(error, "外部全量更新 ZIP 校验失败。"));
  } finally {
    timeout.clear();
    try {
      await response?.body?.cancel();
    } catch {
    }
  }
}

async function readExternalReleaseBodyChunkWithIdleTimeout(reader: {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
}) {
  const idleTimeoutMs = readPositiveIntegerEnv(
    "CHORDV_RELEASE_EXTERNAL_DOWNLOAD_IDLE_TIMEOUT_MS",
    DEFAULT_EXTERNAL_RELEASE_DOWNLOAD_IDLE_TIMEOUT_MS
  );
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutTask = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`外部全量更新 ZIP 连续 ${idleTimeoutMs}ms 没有返回数据。`));
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
  const timeout = createAbortTimeout(
    readPositiveIntegerEnv("CHORDV_RELEASE_EXTERNAL_METADATA_TIMEOUT_MS", DEFAULT_EXTERNAL_RELEASE_METADATA_TIMEOUT_MS),
    `外部安装包 ${method} 请求`
  );
  try {
    const fetched = await fetchPublicHttpUrl(
      rawUrl,
      {
        method,
        dispatcher,
        headers,
        signal: timeout.signal
      },
      { errorPrefix: "External release artifact URL" }
    );
    response = fetched.response;
    const resolvedUrl = fetched.resolvedUrl;

    if (!response.ok && response.status !== 206) {
      if (method === "HEAD" && (response.status === 403 || response.status === 405)) {
        return null;
      }
      throw new BadRequestException(`外部下载地址当前不可访问，HTTP ${response.status}`);
    }

    return {
      resolvedUrl,
      fileName: inferFileNameFromResponse({ headers: response.headers, url: resolvedUrl }, fallbackUrl),
      fileSizeBytes: readExternalFileSize(response.headers),
      fileHash: null
    };
  } catch (error) {
    if (method === "HEAD") {
      return null;
    }
    if (timeout.signal.aborted) {
      const reason = timeout.signal.reason;
      throw new BadRequestException(reason instanceof Error ? reason.message : `${method} 请求超时。`);
    }
    throw new BadRequestException(toUserExternalReleaseArtifactMessage(error, "外部下载地址校验失败"));
  } finally {
    timeout.clear();
    try {
      await response?.body?.cancel();
    } catch {
    }
  }
}

export function buildExternalReleaseArtifactProbeUrl(originUrl: string, defaultMirrorPrefix?: string | null) {
  const prefix = firstMirrorPrefix(defaultMirrorPrefix);
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

export function assertFullUpdateDownloadUrlAllowed(rawUrl: string) {
  const normalized = rawUrl.trim();
  if (!normalized) {
    throw new BadRequestException("全量替换更新下载地址不能为空。");
  }
  if (!/^https?:\/\//i.test(normalized)) {
    if (normalized.startsWith("/")) {
      return;
    }
    throw new BadRequestException("全量替换更新下载地址必须是完整的 http/https 地址或服务器相对路径。");
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
      null,
      null,
      false
    ),
    defaultMirrorPrefix: null,
    allowClientMirror: false,
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
    displayTitle: row.displayTitle?.trim() || row.version,
    changelog: row.changelog,
    minimumVersion: row.minimumVersion,
    forceUpgrade: row.forceUpgrade,
    status: row.status as AdminReleaseRecordDto["status"],
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

function createAbortTimeout(timeoutMs: number, label: string) {
  const controller = new AbortController();
  const handle = setTimeout(() => {
    controller.abort(new Error(`${label}超时：${timeoutMs}ms。`));
  }, timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(handle)
  };
}

function toUserExternalReleaseArtifactMessage(error: unknown, fallback: string) {
  const message = error instanceof Error && error.message.trim().length > 0 ? error.message : String(error);
  if (!message.trim()) {
    return fallback;
  }
  if (/private or reserved/i.test(message)) {
    return "外部下载地址不能指向内网或保留地址。";
  }
  if (/HTTP\s*(\d+)/i.test(message)) {
    return `外部下载地址当前不可访问，HTTP ${RegExp.$1}。`;
  }
  if (/timed out|timeout|超时|stalled/i.test(message)) {
    return message.includes("外部") ? message : "外部下载地址请求超时，请稍后重试。";
  }
  if (/fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|socket/i.test(message)) {
    return "外部下载地址网络连接失败，请检查地址是否可直接访问。";
  }
  if (/too large|exceeds|超过/i.test(message)) {
    return message.includes("外部") ? message : "外部下载文件超过允许大小。";
  }
  return message.includes("External") ? fallback : message;
}

function readPositiveIntegerEnv(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function assertPathInsideRoot(storageRoot: string, resolvedPath: string) {
  const relativePath = path.relative(storageRoot, resolvedPath);
  if (relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))) {
    return;
  }
  throw new BadRequestException("已保存的安装包路径超出存储目录。");
}
