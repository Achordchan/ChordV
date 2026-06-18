import { BadGatewayException, BadRequestException, Injectable, Logger } from "@nestjs/common";
import * as fs from "node:fs/promises";
import type {
  AdminImageBedConfigDto,
  AdminImageBedFileDto,
  AdminImageBedFileListDto,
  DeleteAdminImageBedFileResultDto,
  UpdateAdminImageBedConfigInputDto
} from "@chordv/shared";
import { PrismaService } from "./prisma.service";
import { throwLocalSaveAsServiceUnavailable } from "./prisma-error.utils";
import { SUPPORT_TICKET_ATTACHMENT_MAX_BYTES } from "./upload-limits";

const IMAGE_BED_SETTING_KEY = "image-bed";
const DEFAULT_IMAGE_BED_BASE_URL = "https://image.achord.cn";
const DEFAULT_IMAGE_BED_UPLOAD_FOLDER = "support-tickets";
const DEFAULT_IMAGE_BED_UPLOAD_TIMEOUT_MS = 60_000;
const DEFAULT_IMAGE_BED_MANAGE_TIMEOUT_MS = 5_000;
const IMAGE_BED_CLEANUP_BUDGET_MS = readPositiveIntegerEnv("CHORDV_IMAGE_BED_CLEANUP_BUDGET_MS", 500);

type StoredImageBedConfig = {
  baseUrl?: string;
  apiToken?: string | null;
  uploadFolder?: string | null;
  uploadChannel?: string | null;
  channelName?: string | null;
};

type EffectiveImageBedConfig = {
  baseUrl: string;
  apiToken: string | null;
  uploadFolder: string | null;
  uploadChannel: string | null;
  channelName: string | null;
  tokenSource: "database" | "environment" | "none";
  updatedAt: Date | null;
};

export type UploadedTicketAttachmentFile = {
  path: string;
  originalname: string;
  mimetype: string;
  size: number;
};

export type UploadedImageBedFile = {
  url: string;
  providerFileId: string | null;
  fileName: string;
  mimeType: string;
  fileSizeBytes: bigint;
};

@Injectable()
export class ImageBedService {
  private readonly logger = new Logger(ImageBedService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getAdminConfig(): Promise<AdminImageBedConfigDto> {
    const config = await this.loadEffectiveConfig();
    return {
      baseUrl: config.baseUrl,
      uploadFolder: config.uploadFolder,
      uploadChannel: config.uploadChannel,
      channelName: config.channelName,
      hasToken: Boolean(config.apiToken),
      tokenPreview: config.apiToken ? maskToken(config.apiToken) : null,
      tokenSource: config.tokenSource,
      updatedAt: config.updatedAt?.toISOString() ?? null
    };
  }

  async updateAdminConfig(input: UpdateAdminImageBedConfigInputDto): Promise<AdminImageBedConfigDto> {
    const current = await this.readStoredConfig();
    const next: StoredImageBedConfig = {
      ...current.value,
      ...(input.baseUrl !== undefined ? { baseUrl: normalizeHttpBaseUrl(input.baseUrl, "baseUrl") } : {}),
      ...(input.uploadFolder !== undefined ? { uploadFolder: normalizeOptionalPath(input.uploadFolder) } : {}),
      ...(input.uploadChannel !== undefined ? { uploadChannel: normalizeOptionalText(input.uploadChannel) } : {}),
      ...(input.channelName !== undefined ? { channelName: normalizeOptionalText(input.channelName) } : {})
    };

    if (input.apiToken !== undefined) {
      next.apiToken = normalizeOptionalText(input.apiToken);
    }

    const storedValue = compactStoredConfig(next);
    let saved: { value: unknown; updatedAt: Date | null };
    try {
      saved = await this.prisma.systemSetting.upsert({
        where: { key: IMAGE_BED_SETTING_KEY },
        create: {
          key: IMAGE_BED_SETTING_KEY,
          value: storedValue
        },
        update: {
          value: storedValue
        }
      });
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "图床配置保存失败，请稍后重试。");
    }

    return buildAdminImageBedConfigDto(parseStoredConfig(saved.value), saved.updatedAt ?? null);
  }

  async listAdminFiles(input?: {
    start?: number;
    count?: number;
    search?: string | null;
    dir?: string | null;
    recursive?: boolean;
  }): Promise<AdminImageBedFileListDto> {
    const config = await this.loadEffectiveConfig(true);
    const params = new URLSearchParams();
    params.set("start", String(clampInteger(input?.start, 0, 0, 10_000)));
    params.set("count", String(clampInteger(input?.count, 50, 1, 100)));
    params.set("fileType", "image");
    if (input?.search?.trim()) {
      params.set("search", input.search.trim());
    }
    const dir = normalizeOptionalPath(input?.dir) ?? config.uploadFolder;
    if (dir) {
      params.set("dir", dir);
    }
    if (input?.recursive) {
      params.set("recursive", "true");
    }

    const payload = await this.requestImageBedJson<Record<string, unknown>>(
      config,
      `/api/manage/list?${params.toString()}`
    );
    const rawFiles = Array.isArray(payload.files) ? payload.files : [];
    const directories = Array.isArray(payload.directories)
      ? payload.directories.filter((item): item is string => typeof item === "string")
      : [];

    return {
      files: rawFiles.map((item) => this.toAdminFileDto(config.baseUrl, item)).filter((item): item is AdminImageBedFileDto => item !== null),
      directories,
      totalCount: readNumber(payload.totalCount) ?? rawFiles.length,
      returnedCount: readNumber(payload.returnedCount) ?? rawFiles.length,
      indexLastUpdated: normalizeTimestamp(readString(payload.indexLastUpdated))
    };
  }

  async deleteAdminFile(input: { path: string; folder?: boolean }): Promise<DeleteAdminImageBedFileResultDto> {
    const normalizedPath = normalizeImageBedFilePath(input.path);
    const config = await this.loadEffectiveConfig(true);
    const query = input.folder ? "?folder=true" : "";
    const payload = await this.requestImageBedJson<Record<string, unknown>>(
      config,
      `/api/manage/delete/${encodePathSegments(normalizedPath)}${query}`,
      { allowBusinessFailure: true }
    );

    const failed = readStringArray(payload.failed);
    return {
      success: payload.success === true && failed.length === 0,
      fileId: readString(payload.fileId) ?? normalizedPath,
      deleted: readStringArray(payload.deleted),
      failed: failed.length > 0 ? failed : payload.success === false ? [readString(payload.message) ?? readString(payload.error) ?? normalizedPath] : []
    };
  }

  async uploadSupportTicketAttachment(
    file: UploadedTicketAttachmentFile,
    options: { timeoutMs?: number | null } = {}
  ): Promise<UploadedImageBedFile> {
    try {
      this.assertSupportTicketAttachment(file);
      const config = await this.loadEffectiveConfig(true);
      const url = new URL("/upload", config.baseUrl);
      url.searchParams.set("returnFormat", "full");
      if (config.uploadFolder) {
        url.searchParams.set("uploadFolder", config.uploadFolder);
      }
      if (config.uploadChannel) {
        url.searchParams.set("uploadChannel", config.uploadChannel);
      }
      if (config.channelName) {
        url.searchParams.set("channelName", config.channelName);
      }

      const body = new FormData();
      const buffer = await fs.readFile(file.path);
      body.set("file", new Blob([new Uint8Array(buffer)], { type: file.mimetype }), sanitizeFileName(file.originalname));

      const response = await fetchImageBed(
        url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiToken}`
          },
          body
        },
        readUploadTimeoutMs(options.timeoutMs)
      );
      const rawBody = await response.text();
      if (!response.ok) {
        throw new BadGatewayException(readImageBedError(rawBody) || `Image bed upload failed with HTTP ${response.status}.`);
      }

      const payload = parseJson(rawBody);
      if (payload && typeof payload === "object" && (payload as Record<string, unknown>).success === false) {
        const record = payload as Record<string, unknown>;
        throw new BadGatewayException(readString(record.message) ?? readString(record.error) ?? "Image bed upload failed.");
      }
      const publicUrl = extractUploadedUrl(config.baseUrl, payload);
      if (!publicUrl) {
        throw new BadGatewayException("Image bed upload response did not include a file URL.");
      }

      return {
        url: publicUrl,
        providerFileId: extractUploadedFileId(publicUrl, payload),
        fileName: sanitizeFileName(file.originalname),
        mimeType: file.mimetype,
        fileSizeBytes: BigInt(file.size)
      };
    } finally {
      if (file?.path) {
        await fs.rm(file.path, { force: true }).catch(() => undefined);
      }
    }
  }

  async deleteUploadedSupportTicketAttachmentBestEffort(uploaded: UploadedImageBedFile | null | undefined) {
    const path = uploaded?.providerFileId ?? uploaded?.url;
    if (!path) {
      return;
    }
    let settled = false;
    const cleanupTask = this.deleteAdminFile({ path })
      .then((result) => {
        if (!result.success) {
          this.logger.warn(
            `Support ticket attachment cleanup failed for ${path}: ${result.failed.join(", ") || "delete returned unsuccessful"}`
          );
        }
      })
      .catch((error) => {
        this.logger.warn(
          `Support ticket attachment cleanup failed for ${path}: ${error instanceof Error ? error.message : String(error)}`
        );
      })
      .finally(() => {
        settled = true;
      });
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutTask = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(() => {
        if (!settled) {
          this.logger.warn(
            `Support ticket attachment cleanup exceeded ${IMAGE_BED_CLEANUP_BUDGET_MS}ms for ${path}; continuing in background.`
          );
        }
        resolve();
      }, IMAGE_BED_CLEANUP_BUDGET_MS);
      timeoutHandle.unref?.();
    });
    await Promise.race([cleanupTask, timeoutTask]);
    if (settled && timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }

  private async requestImageBedJson<T>(
    config: EffectiveImageBedConfig,
    pathAndQuery: string,
    options: { allowBusinessFailure?: boolean } = {}
  ): Promise<T> {
    const url = new URL(pathAndQuery, config.baseUrl);
    const response = await fetchImageBed(
      url,
      {
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
          Accept: "application/json"
        }
      },
      readImageBedManageTimeoutMs()
    );
    const rawBody = await response.text();
    if (!response.ok) {
      throw new BadGatewayException(readImageBedError(rawBody) || `Image bed request failed with HTTP ${response.status}.`);
    }
    const payload = parseJson(rawBody);
    if (!payload || typeof payload !== "object") {
      throw new BadGatewayException("Image bed response was not valid JSON.");
    }
    const record = payload as Record<string, unknown>;
    if (record.success === false && !options.allowBusinessFailure) {
      throw new BadGatewayException(readString(record.message) ?? readString(record.error) ?? "Image bed request failed.");
    }
    return payload as T;
  }

  private toAdminFileDto(baseUrl: string, input: unknown): AdminImageBedFileDto | null {
    if (!input || typeof input !== "object") {
      return null;
    }
    const record = input as Record<string, unknown>;
    const name = readString(record.name);
    const fileId =
      readString(record.fullId) ??
      readString(record.fileId) ??
      readString(record.path) ??
      readString(record.key) ??
      name;
    if (!fileId) {
      return null;
    }
    const metadata = readRecord(record.metadata);
    const mimeType = readString(metadata?.["File-Mime"]) ?? readString(metadata?.fileType) ?? null;
    const fileSizeBytes = readString(metadata?.["File-Size"]) ?? readString(metadata?.fileSize) ?? null;
    const timestamp = readString(metadata?.TimeStamp) ?? readString(metadata?.timestamp);
    return {
      name: fileId,
      url: new URL(`/file/${encodePathSegments(fileId)}`, baseUrl).toString(),
      mimeType,
      fileSizeBytes,
      uploadedAt: normalizeTimestamp(timestamp),
      channel: readString(metadata?.Channel) ?? readString(metadata?.channel)
    };
  }

  assertSupportTicketAttachment(file: UploadedTicketAttachmentFile) {
    if (!file) {
      throw new BadRequestException("Attachment file is required.");
    }
    if (!file.mimetype?.startsWith("image/")) {
      throw new BadRequestException("Only image attachments are supported.");
    }
    if (!Number.isFinite(file.size) || file.size <= 0) {
      throw new BadRequestException("Attachment file is empty.");
    }
    if (file.size > SUPPORT_TICKET_ATTACHMENT_MAX_BYTES) {
      throw new BadRequestException(`Attachment file exceeds ${SUPPORT_TICKET_ATTACHMENT_MAX_BYTES} bytes.`);
    }
  }

  private async loadEffectiveConfig(requireToken = false): Promise<EffectiveImageBedConfig> {
    const stored = await this.readStoredConfig();
    const storedToken = normalizeOptionalText(stored.value.apiToken);
    const envToken = normalizeOptionalText(process.env.CHORDV_IMAGE_BED_TOKEN);
    const apiToken = storedToken ?? envToken;
    const tokenSource = storedToken ? "database" : envToken ? "environment" : "none";
    if (requireToken && !apiToken) {
      throw new BadRequestException("Image bed API token is not configured.");
    }

    return {
      baseUrl: normalizeHttpBaseUrl(stored.value.baseUrl ?? process.env.CHORDV_IMAGE_BED_BASE_URL ?? DEFAULT_IMAGE_BED_BASE_URL, "baseUrl"),
      apiToken,
      uploadFolder:
        normalizeOptionalPath(stored.value.uploadFolder) ??
        normalizeOptionalPath(process.env.CHORDV_IMAGE_BED_UPLOAD_FOLDER) ??
        DEFAULT_IMAGE_BED_UPLOAD_FOLDER,
      uploadChannel: normalizeOptionalText(stored.value.uploadChannel ?? process.env.CHORDV_IMAGE_BED_UPLOAD_CHANNEL),
      channelName: normalizeOptionalText(stored.value.channelName ?? process.env.CHORDV_IMAGE_BED_CHANNEL_NAME),
      tokenSource,
      updatedAt: stored.updatedAt
    };
  }

  private async readStoredConfig(): Promise<{ value: StoredImageBedConfig; updatedAt: Date | null }> {
    let row: { value: unknown; updatedAt: Date | null } | null;
    try {
      row = await this.prisma.systemSetting.findUnique({
        where: { key: IMAGE_BED_SETTING_KEY }
      });
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "图床配置读取失败，请稍后重试。");
    }
    if (!row) {
      return { value: {}, updatedAt: null };
    }
    return {
      value: parseStoredConfig(row.value),
      updatedAt: row.updatedAt
    };
  }
}

function parseStoredConfig(value: unknown): StoredImageBedConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  return {
    baseUrl: readString(record.baseUrl) ?? undefined,
    apiToken: readString(record.apiToken) ?? null,
    uploadFolder: readString(record.uploadFolder) ?? null,
    uploadChannel: readString(record.uploadChannel) ?? null,
    channelName: readString(record.channelName) ?? null
  };
}

function compactStoredConfig(value: StoredImageBedConfig): Record<string, string | null> {
  return {
    baseUrl: value.baseUrl ?? null,
    apiToken: value.apiToken ?? null,
    uploadFolder: value.uploadFolder ?? null,
    uploadChannel: value.uploadChannel ?? null,
    channelName: value.channelName ?? null
  };
}

function buildAdminImageBedConfigDto(value: StoredImageBedConfig, updatedAt: Date | null): AdminImageBedConfigDto {
  const storedToken = normalizeOptionalText(value.apiToken);
  const envToken = normalizeOptionalText(process.env.CHORDV_IMAGE_BED_TOKEN);
  const apiToken = storedToken ?? envToken;
  const tokenSource = storedToken ? "database" : envToken ? "environment" : "none";
  return {
    baseUrl: normalizeHttpBaseUrl(value.baseUrl ?? process.env.CHORDV_IMAGE_BED_BASE_URL ?? DEFAULT_IMAGE_BED_BASE_URL, "baseUrl"),
    uploadFolder:
      normalizeOptionalPath(value.uploadFolder) ??
      normalizeOptionalPath(process.env.CHORDV_IMAGE_BED_UPLOAD_FOLDER) ??
      DEFAULT_IMAGE_BED_UPLOAD_FOLDER,
    uploadChannel: normalizeOptionalText(value.uploadChannel ?? process.env.CHORDV_IMAGE_BED_UPLOAD_CHANNEL),
    channelName: normalizeOptionalText(value.channelName ?? process.env.CHORDV_IMAGE_BED_CHANNEL_NAME),
    hasToken: Boolean(apiToken),
    tokenPreview: apiToken ? maskToken(apiToken) : null,
    tokenSource,
    updatedAt: updatedAt?.toISOString() ?? null
  };
}

function normalizeHttpBaseUrl(value: string, fieldName: string) {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new BadRequestException(`${fieldName} is required.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new BadRequestException(`${fieldName} must be a valid URL.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new BadRequestException(`${fieldName} must be an HTTP URL.`);
  }
  return parsed.origin;
}

function normalizeOptionalText(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeOptionalPath(value: unknown) {
  const text = normalizeOptionalText(value);
  if (!text) {
    return null;
  }
  return text
    .replace(/\\/g, "/")
    .split("/")
    .map((item) => item.trim())
    .filter(Boolean)
    .join("/");
}

function normalizeImageBedFilePath(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new BadRequestException("File path is required.");
  }
  let pathValue = trimmed;
  try {
    const parsed = new URL(trimmed);
    pathValue = parsed.pathname;
  } catch {
    // Plain file IDs from the list API are expected.
  }
  try {
    pathValue = decodeURIComponent(pathValue);
  } catch {
    throw new BadRequestException("Invalid image bed file path.");
  }
  pathValue = pathValue.replace(/^\/+/, "").replace(/^file\/+/, "");
  if (!pathValue || pathValue.includes("..")) {
    throw new BadRequestException("Invalid image bed file path.");
  }
  return pathValue;
}

function sanitizeFileName(value: string) {
  const cleaned = value.trim().replace(/[\\/:*?"<>|]+/g, "_");
  return cleaned || "attachment";
}

function encodePathSegments(value: string) {
  return value
    .split("/")
    .filter(Boolean)
    .map((item) => encodeURIComponent(item))
    .join("/");
}

function extractUploadedUrl(baseUrl: string, payload: unknown): string | null {
  const first = Array.isArray(payload) ? payload[0] : payload;
  if (!first || typeof first !== "object") {
    return null;
  }
  const record = first as Record<string, unknown>;
  const candidate = readString(record.fileUrl) ?? readString(record.url) ?? readString(record.src);
  if (!candidate) {
    return null;
  }
  return candidate.startsWith("http://") || candidate.startsWith("https://")
    ? candidate
    : new URL(candidate, baseUrl).toString();
}

function extractUploadedFileId(publicUrl: string, payload: unknown) {
  const first = Array.isArray(payload) ? payload[0] : payload;
  if (first && typeof first === "object") {
    const record = first as Record<string, unknown>;
    const explicitId = readString(record.fullId) ?? readString(record.fileId);
    if (explicitId) {
      return explicitId;
    }
  }
  try {
    return decodeURIComponent(new URL(publicUrl).pathname).replace(/^\/+/, "").replace(/^file\/+/, "") || null;
  } catch {
    return null;
  }
}

function readImageBedError(rawBody: string) {
  const parsed = parseJson(rawBody);
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    return readString(record.message) ?? readString(record.error);
  }
  return rawBody.trim().slice(0, 200);
}

function parseJson(value: string): unknown {
  if (!value.trim()) {
    return {};
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function fetchImageBed(url: URL, init: RequestInit, timeoutMs: number) {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (reason) {
    const message = reason instanceof Error && (reason.name === "AbortError" || reason.name === "TimeoutError")
      ? `Image bed request timed out after ${timeoutMs}ms.`
      : reason instanceof Error
        ? `Image bed request failed: ${reason.message}`
        : "Image bed request failed.";
    throw new BadGatewayException(message);
  }
}

function readImageBedUploadTimeoutMs() {
  return readPositiveIntegerEnv(
    "CHORDV_IMAGE_BED_UPLOAD_TIMEOUT_MS",
    readPositiveIntegerEnv("CHORDV_IMAGE_BED_TIMEOUT_MS", DEFAULT_IMAGE_BED_UPLOAD_TIMEOUT_MS)
  );
}

function readUploadTimeoutMs(value: number | null | undefined) {
  return Number.isFinite(value) && Number(value) > 0 ? Math.trunc(Number(value)) : readImageBedUploadTimeoutMs();
}

function readImageBedManageTimeoutMs() {
  return readPositiveIntegerEnv(
    "CHORDV_IMAGE_BED_MANAGE_TIMEOUT_MS",
    readPositiveIntegerEnv("CHORDV_IMAGE_BED_TIMEOUT_MS", DEFAULT_IMAGE_BED_MANAGE_TIMEOUT_MS)
  );
}

function readRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function readNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeTimestamp(value: string | null) {
  if (!value) {
    return null;
  }
  const numeric = Number(value);
  const date = Number.isFinite(numeric) ? new Date(numeric) : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(value as number)));
}

function readPositiveIntegerEnv(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function maskToken(token: string) {
  if (token.length <= 14) {
    return `${token.slice(0, 3)}...`;
  }
  return `${token.slice(0, 8)}...${token.slice(-6)}`;
}
