import { BadRequestException, NotFoundException } from "@nestjs/common";
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

const RELEASE_ARTIFACT_DOWNLOAD_PREFIX = "/api/downloads/releases";
const STRICT_SEMVER_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const WINDOWS_FULL_UPDATE_REQUIRED_ENTRIES = new Set([
  "bin/xray.exe",
  "bin/geoip.dat",
  "bin/geosite.dat"
]);
const WINDOWS_FULL_UPDATE_ROOT_EXES = new Set(["chordv.exe", "chordv-desktop.exe"]);
const MIN_WINDOWS_FULL_UPDATE_PE_BYTES = 1024 * 1024;
const MIN_WINDOWS_FULL_UPDATE_GEO_BYTES = 64 * 1024;
const DEFAULT_MAX_EXTERNAL_RELEASE_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_WINDOWS_FULL_UPDATE_ZIP_ENTRY_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_ZIP_VALIDATION_ENTRIES = 10_000;
const DEFAULT_EXTERNAL_RELEASE_METADATA_TIMEOUT_MS = 30_000;
const DEFAULT_EXTERNAL_RELEASE_DOWNLOAD_TIMEOUT_MS = 120_000;
const configuredMaxExternalReleaseArtifactBytes = Number(
  process.env.CHORDV_RELEASE_MAX_UPLOAD_BYTES ?? DEFAULT_MAX_EXTERNAL_RELEASE_ARTIFACT_BYTES
);
const MAX_EXTERNAL_RELEASE_ARTIFACT_BYTES =
  Number.isFinite(configuredMaxExternalReleaseArtifactBytes) && configuredMaxExternalReleaseArtifactBytes > 0
    ? Math.trunc(configuredMaxExternalReleaseArtifactBytes)
    : DEFAULT_MAX_EXTERNAL_RELEASE_ARTIFACT_BYTES;
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
    throw new BadRequestException("Version must use semantic version format, for example 1.2.3 or 1.2.3-beta.1.");
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

export function normalizeFileSizeBytes(value: string | null | undefined) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value.trim() === "") {
    return null;
  }
  const normalized = value.trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new BadRequestException("File size must be a positive integer byte count.");
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
    throw new BadRequestException("SHA256 must be a 64-character hexadecimal string.");
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
    throw new BadRequestException("Version must use semantic version format, for example 1.2.3 or 1.2.3-beta.1.");
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
    if (type === "setup.exe" && deliveryMode === "desktop_installer_download") {
      return;
    }
    if (type === "external" && deliveryMode === "external_download") {
      return;
    }
    throw new BadRequestException(
      "Windows release artifacts must use zip + desktop_full_replace, setup.exe + desktop_installer_download, or external + external_download."
    );
  }

  if (platform === "macos") {
    if ((type === "dmg" && deliveryMode === "desktop_installer_download") || (type === "external" && deliveryMode === "external_download")) {
      return;
    }
    throw new BadRequestException("macOS release artifacts must use dmg + desktop_installer_download or external + external_download.");
  }

  if (platform === "android") {
    if ((type === "apk" && deliveryMode === "apk_download") || (type === "external" && deliveryMode === "external_download")) {
      return;
    }
    throw new BadRequestException("Android release artifacts must use apk + apk_download or external + external_download.");
  }

  if ((type === "ipa" && deliveryMode === "external_download") || (type === "external" && deliveryMode === "external_download")) {
    return;
  }
  throw new BadRequestException("iOS release artifacts must use ipa/external + external_download.");
}

export function assertReleaseArtifactClientUsable(artifact: ReleaseArtifactRowLike, platform: PlatformTarget) {
  const type = fromPrismaReleaseArtifactType(artifact.type);
  const deliveryMode = artifact.deliveryMode as UpdateDeliveryMode;
  assertReleaseArtifactTypeAllowed(platform, type);
  assertReleaseArtifactDeliveryAllowed(platform, type, deliveryMode);

  if (deliveryMode !== "none") {
    normalizeSha256Input(artifact.fileHash);
    if (!artifact.fileHash) {
      throw new BadRequestException("Client-visible release artifacts require SHA256 metadata.");
    }
  }

  if (deliveryMode === "desktop_full_replace") {
    if (!artifact.fileSizeBytes || artifact.fileSizeBytes <= 0n) {
      throw new BadRequestException("Full replacement updates require positive file size metadata.");
    }
    assertFullUpdateDownloadUrlAllowed(artifact.downloadUrl);
  }
}

export function assertReleaseArtifactTypeAllowed(platform: PlatformTarget, type: ReleaseArtifactType) {
  const allowed =
    platform === "macos"
      ? ["dmg", "external"]
      : platform === "windows"
        ? ["zip", "setup.exe", "external"]
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

export async function assertWindowsFullUpdateZipFile(filePath: string, fileName?: string | null, expectedVersion?: string | null) {
  const displayName = fileName ?? path.basename(filePath);
  if (!displayName.toLowerCase().endsWith(".zip")) {
    throw new BadRequestException("Windows full replacement artifacts must be .zip files.");
  }

  const entries = await readZipCentralDirectoryEntries(filePath);
  const normalizedEntries = new Set<string>();
  const expectedVersionCore = expectedVersion ? parseSemver(expectedVersion).core : null;
  let hasRootExe = false;

  for (const entry of entries) {
    assertZipEntryPathSafe(entry.name);
    const normalized = normalizeZipEntryName(entry.name);
    if (!normalized || normalized.endsWith("/")) {
      continue;
    }
    normalizedEntries.add(normalized);
    const data = await verifyZipEntryData(filePath, entry);
    const parts = normalized.split("/");
    if (parts.length === 1 && WINDOWS_FULL_UPDATE_ROOT_EXES.has(parts[0].toLowerCase())) {
      assertWindowsPeData(data, normalized, MIN_WINDOWS_FULL_UPDATE_PE_BYTES);
      assertWindowsPeProductVersion(data, normalized, expectedVersionCore);
      hasRootExe = true;
    }
    if (normalized === "bin/xray.exe") {
      assertWindowsPeData(data, normalized, MIN_WINDOWS_FULL_UPDATE_PE_BYTES);
    } else if (normalized === "bin/geoip.dat" || normalized === "bin/geosite.dat") {
      assertMinimumEntrySize(data, normalized, MIN_WINDOWS_FULL_UPDATE_GEO_BYTES);
    }
  }

  if (!hasRootExe) {
    throw new BadRequestException("Windows full replacement ZIP must contain ChordV.exe or chordv-desktop.exe at the root.");
  }

  const missingEntries = [...WINDOWS_FULL_UPDATE_REQUIRED_ENTRIES].filter((entry) => !normalizedEntries.has(entry));
  if (missingEntries.length > 0) {
    throw new BadRequestException(`Windows full replacement ZIP is missing required files: ${missingEntries.join(", ")}`);
  }
}

export async function readZipEntryData(filePath: string, entryName: string) {
  assertZipEntryPathSafe(entryName);
  const normalizedTarget = normalizeZipEntryName(entryName);
  if (!normalizedTarget || normalizedTarget.endsWith("/")) {
    throw new BadRequestException("ZIP entry name must point to a file.");
  }
  const entries = await readZipCentralDirectoryEntries(filePath);
  const entry = entries.find((item) => normalizeZipEntryName(item.name) === normalizedTarget);
  if (!entry) {
    throw new BadRequestException(`ZIP entry not found: ${entryName}`);
  }
  assertZipEntryPathSafe(entry.name);
  return verifyZipEntryData(filePath, entry);
}

async function readZipCentralDirectoryEntries(filePath: string) {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (stat.size < 22) {
      throw new BadRequestException("ZIP file is too small to contain a valid central directory.");
    }
    const tailLength = Math.min(stat.size, 65_557);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, stat.size - tailLength);
    const eocdOffsetInTail = findEndOfCentralDirectory(tail);
    if (eocdOffsetInTail < 0) {
      throw new BadRequestException("Invalid ZIP file: missing end of central directory.");
    }

    const centralDirectorySize = tail.readUInt32LE(eocdOffsetInTail + 12);
    const centralDirectoryOffset = tail.readUInt32LE(eocdOffsetInTail + 16);
    if (centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) {
      throw new BadRequestException("ZIP64 full replacement packages are not supported by the release validator.");
    }
    if (centralDirectoryOffset + centralDirectorySize > stat.size) {
      throw new BadRequestException("Invalid ZIP file: central directory points outside the package.");
    }

    const centralDirectory = Buffer.alloc(centralDirectorySize);
    await handle.read(centralDirectory, 0, centralDirectorySize, centralDirectoryOffset);
    const entries = parseZipCentralDirectoryEntries(centralDirectory);
    if (entries.length > MAX_ZIP_VALIDATION_ENTRIES) {
      throw new BadRequestException(`ZIP file has too many entries: ${entries.length} exceeds ${MAX_ZIP_VALIDATION_ENTRIES}.`);
    }
    let totalCompressedSize = 0;
    let totalUncompressedSize = 0;
    for (const entry of entries) {
      totalCompressedSize += entry.compressedSize;
      totalUncompressedSize += entry.uncompressedSize;
      if (totalCompressedSize > MAX_EXTERNAL_RELEASE_ARTIFACT_BYTES || totalUncompressedSize > MAX_EXTERNAL_RELEASE_ARTIFACT_BYTES) {
        throw new BadRequestException("ZIP file expands beyond the validation size limit.");
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
      throw new BadRequestException("Invalid ZIP file: malformed central directory entry.");
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
      throw new BadRequestException("Invalid ZIP file: malformed entry name.");
    }
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw new BadRequestException("ZIP64 full replacement package entries are not supported by the release validator.");
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
    throw new BadRequestException(`Unsupported ZIP compression method for ${entry.name}: ${entry.compressionMethod}`);
  }
  if (
    entry.compressedSize > MAX_WINDOWS_FULL_UPDATE_ZIP_ENTRY_BYTES ||
    entry.uncompressedSize > MAX_WINDOWS_FULL_UPDATE_ZIP_ENTRY_BYTES
  ) {
    throw new BadRequestException(
      `ZIP entry ${entry.name} exceeds the per-file validation limit of ${MAX_WINDOWS_FULL_UPDATE_ZIP_ENTRY_BYTES} bytes.`
    );
  }

  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const localHeader = Buffer.alloc(30);
    const localHeaderRead = await handle.read(localHeader, 0, localHeader.length, entry.localHeaderOffset);
    if (localHeaderRead.bytesRead !== localHeader.length) {
      throw new BadRequestException(`Invalid ZIP local header for ${entry.name}: short read.`);
    }
    if (localHeader.readUInt32LE(0) !== 0x04034b50) {
      throw new BadRequestException(`Invalid ZIP local header for ${entry.name}.`);
    }
    const localFileNameLength = localHeader.readUInt16LE(26);
    const localExtraLength = localHeader.readUInt16LE(28);
    const dataOffset = entry.localHeaderOffset + 30 + localFileNameLength + localExtraLength;
    if (dataOffset + entry.compressedSize > stat.size) {
      throw new BadRequestException(`ZIP entry ${entry.name} points outside the package.`);
    }
    const compressedData = Buffer.alloc(entry.compressedSize);
    const dataRead = await handle.read(compressedData, 0, entry.compressedSize, dataOffset);
    if (dataRead.bytesRead !== entry.compressedSize) {
      throw new BadRequestException(`ZIP entry ${entry.name} data is truncated.`);
    }
    const data =
      entry.compressionMethod === 0
        ? compressedData
        : inflateRawSync(compressedData, { finishFlush: 2 });
    if (data.length !== entry.uncompressedSize) {
      throw new BadRequestException(`ZIP entry ${entry.name} has an invalid uncompressed size.`);
    }
    if (crc32(data) !== entry.crc32) {
      throw new BadRequestException(`ZIP entry ${entry.name} failed CRC validation.`);
    }
    return data;
  } finally {
    await handle.close();
  }
}

function assertMinimumEntrySize(data: Buffer, label: string, minBytes: number) {
  if (data.length < minBytes) {
    throw new BadRequestException(`${label} is too small: expected at least ${minBytes} bytes, got ${data.length}.`);
  }
}

function assertWindowsPeData(data: Buffer, label: string, minBytes: number) {
  assertMinimumEntrySize(data, label, minBytes);
  if (data.length < 0x40 || data[0] !== 0x4d || data[1] !== 0x5a) {
    throw new BadRequestException(`${label} is not a Windows PE executable.`);
  }
  const peHeaderOffset = data.readUInt32LE(0x3c);
  if (peHeaderOffset <= 0 || peHeaderOffset + 4 > data.length || data.readUInt32LE(peHeaderOffset) !== 0x00004550) {
    throw new BadRequestException(`${label} has an invalid Windows PE header.`);
  }
}

function assertWindowsPeProductVersion(data: Buffer, label: string, expectedVersionCore: number[] | null) {
  if (!expectedVersionCore) {
    return;
  }
  const version = readWindowsPeProductVersion(data);
  if (!version) {
    throw new BadRequestException(`${label} does not contain a readable Windows product version.`);
  }
  const actualCore = version.slice(0, 3);
  const matches = expectedVersionCore.every((part, index) => actualCore[index] === part);
  if (!matches) {
    throw new BadRequestException(
      `${label} product version ${version.join(".")} does not match release version ${expectedVersionCore.join(".")}.`
    );
  }
}

function readWindowsPeProductVersion(data: Buffer) {
  for (let offset = 0; offset + 24 <= data.length; offset += 1) {
    if (data.readUInt32LE(offset) !== 0xfeef04bd) {
      continue;
    }
    const productVersionMs = data.readUInt32LE(offset + 16);
    const productVersionLs = data.readUInt32LE(offset + 20);
    return [
      productVersionMs >>> 16,
      productVersionMs & 0xffff,
      productVersionLs >>> 16,
      productVersionLs & 0xffff
    ];
  }
  return null;
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
    throw new BadRequestException(`Unsafe ZIP entry path: ${entry}`);
  }
  const parts = normalized.split("/");
  if (parts.some((part, index) => part === ".." || (part === "" && index !== parts.length - 1))) {
    throw new BadRequestException(`Unsafe ZIP entry path: ${entry}`);
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
  clientMirrorPrefix: string | null
) {
  const defaultMirrorPrefix = artifact.source === "external" ? artifact.defaultMirrorPrefix : null;
  const allowClientMirror = artifact.source === "uploaded" ? false : artifact.allowClientMirror;
  const resolvedUrl = buildReleaseArtifactDownloadUrlForClient(
    artifact.downloadUrl,
    defaultMirrorPrefix,
    clientMirrorPrefix,
    allowClientMirror
  );
  return {
    ...artifact,
    downloadUrl: resolvedUrl,
    originDownloadUrl: artifact.downloadUrl,
    allowClientMirror
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
    "External full update ZIP request"
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
      throw new BadRequestException(`External full update ZIP is not accessible: HTTP ${response.status}`);
    }
    assertFullUpdateDownloadUrlAllowed(resolvedUrl);
    const contentLength = readExternalFileSize(response.headers);
    if (contentLength !== null && contentLength > BigInt(MAX_EXTERNAL_RELEASE_ARTIFACT_BYTES)) {
      throw new BadRequestException(`External full update ZIP exceeds the ${MAX_EXTERNAL_RELEASE_ARTIFACT_BYTES} byte limit.`);
    }
    const absolutePath = path.join(tmpdir(), `chordv-release-artifact-${randomUUID()}.zip`);
    const hash = createHash("sha256");
    let fileSizeBytes = 0n;
    let fileHandle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      if (!response.body) {
        throw new BadRequestException("External full update ZIP response body is empty.");
      }
      fileHandle = await fs.open(absolutePath, "wx");
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        const buffer = Buffer.from(chunk);
        fileSizeBytes += BigInt(buffer.byteLength);
        if (fileSizeBytes > BigInt(MAX_EXTERNAL_RELEASE_ARTIFACT_BYTES)) {
          throw new BadRequestException(`External full update ZIP exceeds the ${MAX_EXTERNAL_RELEASE_ARTIFACT_BYTES} byte limit.`);
        }
        hash.update(buffer);
        await fileHandle.write(buffer);
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
    throw new BadRequestException(error instanceof Error ? error.message : "External full update ZIP validation failed.");
  } finally {
    timeout.clear();
    try {
      await response?.body?.cancel();
    } catch {
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
    `External release artifact ${method} request`
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
    throw new BadRequestException(error instanceof Error ? error.message : "外部下载地址校验失败");
  } finally {
    timeout.clear();
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

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new BadRequestException("外部下载地址格式不正确，请检查链接。");
  }

  const pathname = parsedUrl.pathname.toLowerCase();

  if (type === "dmg" && !pathname.endsWith(".dmg")) {
    throw new BadRequestException("当前产物类型是 DMG 安装包，下载地址必须指向 .dmg 文件。");
  }
  if (type === "setup.exe" && !pathname.endsWith(".exe")) {
    throw new BadRequestException("当前产物类型是 Setup 安装器，下载地址必须指向 .exe 文件。");
  }
  if (type === "zip" && !pathname.endsWith(".zip")) {
    throw new BadRequestException("ZIP full update artifact URLs must point to a .zip file.");
  }
  if (type === "zip" && parsedUrl.protocol !== "https:" && !isLocalhostUrl(parsedUrl)) {
    throw new BadRequestException("ZIP full update artifact URLs must use HTTPS.");
  }
  if (type === "apk" && !pathname.endsWith(".apk")) {
    throw new BadRequestException("当前产物类型是 APK 安装包，下载地址必须指向 .apk 文件。");
  }
  if (type === "ipa" && !pathname.endsWith(".ipa")) {
    throw new BadRequestException("当前产物类型是 IPA 安装包，下载地址必须指向 .ipa 文件。");
  }
}

function isLocalhostUrl(url: URL) {
  const hostname = url.hostname.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function assertFullUpdateDownloadUrlAllowed(rawUrl: string) {
  const normalized = rawUrl.trim();
  if (!normalized) {
    throw new BadRequestException("Full replacement update download URL is empty.");
  }
  if (!/^https?:\/\//i.test(normalized)) {
    if (normalized.startsWith("/")) {
      return;
    }
    throw new BadRequestException("Full replacement update download URLs must be HTTPS or server-relative paths.");
  }
  const parsedUrl = new URL(normalized);
  if (parsedUrl.protocol !== "https:" && !isLocalhostUrl(parsedUrl)) {
    throw new BadRequestException("Full replacement update download URLs must use HTTPS.");
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
    allowClientMirror: row.source === "uploaded" ? false : row.allowClientMirror,
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
    controller.abort(new Error(`${label} timed out after ${timeoutMs}ms.`));
  }, timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(handle)
  };
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
  throw new BadRequestException("Stored release artifact path resolves outside the release storage root.");
}
