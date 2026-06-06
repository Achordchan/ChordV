import type {
  AdminSupportTicketDetailDto as SharedAdminSupportTicketDetailDto,
  AdminSupportTicketSummaryDto as SharedAdminSupportTicketSummaryDto,
  AdminImageBedConfigDto,
  AdminImageBedFileListDto,
  AdminReleaseArtifactDto as SharedAdminReleaseArtifactDto,
  AdminRuntimeComponentFailureReportDto as SharedAdminRuntimeComponentFailureReportDto,
  AdminRuntimeComponentRecordDto as SharedAdminRuntimeComponentRecordDto,
  AdminRuntimeComponentValidationDto as SharedAdminRuntimeComponentValidationDto,
  AdminReleaseRecordDto as SharedAdminReleaseRecordDto,
  CreateReleaseArtifactInputDto,
  CreateReleaseInputDto,
  DeleteAdminImageBedFileResultDto,
  CreateRuntimeComponentInputDto,
  ReplyClientSupportTicketInputDto,
  ReleaseArtifactType,
  ReleaseStatus,
  RuntimeComponentArchitecture,
  RuntimeComponentKind,
  RuntimeComponentSource,
  SupportTicketStatus,
  UpdateDeliveryMode,
  UpdateAdminImageBedConfigInputDto,
  UploadedSupportTicketAttachmentInputDto,
  UpdateReleaseArtifactInputDto,
  UpdateReleaseInputDto,
  UpdateRuntimeComponentInputDto
} from "@chordv/shared";
import { request } from "./base";

const IMAGE_BED_ACTION_TIMEOUT_MS = 75 * 1000;
const ADMIN_READ_TIMEOUT_MS = 60 * 1000;
const ADMIN_ACTION_TIMEOUT_MS = 60 * 1000;
const LONG_ADMIN_ACTION_TIMEOUT_MS = 10 * 60 * 1000;

export * from "./announcements";
export * from "./auth";
export * from "./nodes";
export * from "./plans";
export * from "./policies";
export * from "./subscriptions";
export * from "./teams";
export * from "./users";

export type AdminReleasePlatform = "macos" | "windows" | "android" | "ios";
export type AdminReleaseStatus = ReleaseStatus;
export type AdminReleaseArtifactType = ReleaseArtifactType;
export type AdminRuntimeComponentArchitecture = RuntimeComponentArchitecture;
export type AdminRuntimeComponentKind = RuntimeComponentKind;
export type AdminRuntimeComponentSource = RuntimeComponentSource;
export type AdminReleaseArtifactRecordDto = {
  id: string;
  source: "uploaded" | "external";
  type: AdminReleaseArtifactType;
  deliveryMode: UpdateDeliveryMode;
  downloadUrl: string;
  originDownloadUrl?: string | null;
  finalUrlPreview?: string | null;
  defaultMirrorPrefix?: string | null;
  allowClientMirror: boolean;
  fileName?: string | null;
  fileSizeBytes?: string | null;
  fileHash?: string | null;
  isPrimary: boolean;
  isFullPackage: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type AdminReleaseRecordDto = {
  id: string;
  platform: AdminReleasePlatform;
  status: AdminReleaseStatus;
  version: string;
  minimumVersion: string;
  forceUpgrade: boolean;
  title: string;
  changelog: string[];
  deliveryMode: UpdateDeliveryMode;
  publishedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  artifacts: AdminReleaseArtifactRecordDto[];
};

export type AdminRuntimeComponentRecordDto = SharedAdminRuntimeComponentRecordDto;
export type AdminRuntimeComponentValidationDto = SharedAdminRuntimeComponentValidationDto;
export type AdminRuntimeComponentFailureReportDto = SharedAdminRuntimeComponentFailureReportDto;
export type AdminSupportTicketSummaryDto = SharedAdminSupportTicketSummaryDto;
export type AdminSupportTicketDetailDto = SharedAdminSupportTicketDetailDto;
export type CreateAdminReleaseArtifactInputDto = Omit<CreateReleaseArtifactInputDto, "defaultMirrorPrefix" | "allowClientMirror">;
export type UpdateAdminReleaseArtifactInputDto = Omit<UpdateReleaseArtifactInputDto, "defaultMirrorPrefix" | "allowClientMirror">;
export type ReplyAdminSupportTicketInputDto = ReplyClientSupportTicketInputDto;

export type CreateAdminReleaseInputDto = {
  platform: AdminReleasePlatform;
  status: Extract<AdminReleaseStatus, "draft" | "published">;
  version: string;
  minimumVersion: string;
  forceUpgrade: boolean;
  title: string;
  changelog: string[];
  initialArtifact?: CreateAdminReleaseArtifactInputDto | null;
};

export type UpdateAdminReleaseInputDto = {
  title?: string;
  changelog?: string[];
  minimumVersion?: string;
  forceUpgrade?: boolean;
  status?: Extract<AdminReleaseStatus, "draft" | "published">;
  publishedAt?: string | null;
};

export type UploadAdminReleaseArtifactInputDto = {
  source?: "uploaded";
  type: AdminReleaseArtifactType;
  deliveryMode?: UpdateDeliveryMode;
  fileName?: string | null;
  isPrimary?: boolean;
};
export type CreateAdminRuntimeComponentInputDto = CreateRuntimeComponentInputDto;
export type UpdateAdminRuntimeComponentInputDto = UpdateRuntimeComponentInputDto;
export type UploadAdminRuntimeComponentInputDto = {
  platform: AdminReleasePlatform;
  architecture: AdminRuntimeComponentArchitecture;
  kind: AdminRuntimeComponentKind;
  fileName?: string | null;
  expectedHash?: string | null;
  enabled?: boolean;
};

export type FetchAdminReleasesFilters = {
  platform?: AdminReleasePlatform;
  status?: AdminReleaseStatus;
};

function buildReleaseQuery(filters?: FetchAdminReleasesFilters) {
  if (!filters) return "";
  const params = new URLSearchParams();
  if (filters.platform) params.set("platform", filters.platform);
  if (filters.status) params.set("status", filters.status);
  const query = params.toString();
  return query ? `?${query}` : "";
}

function inferDeliveryMode(artifacts: SharedAdminReleaseArtifactDto[]): UpdateDeliveryMode {
  const primary = artifacts.find((item) => item.isPrimary) ?? artifacts[0];
  return primary?.deliveryMode ?? "none";
}

function mapArtifact(record: SharedAdminReleaseArtifactDto): AdminReleaseArtifactRecordDto {
  return {
    id: record.id,
    source: record.source,
    type: record.type,
    deliveryMode: record.deliveryMode,
    downloadUrl: record.downloadUrl,
    originDownloadUrl: record.originDownloadUrl ?? record.downloadUrl,
    finalUrlPreview: record.finalUrlPreview ?? record.downloadUrl,
    defaultMirrorPrefix: record.defaultMirrorPrefix ?? null,
    allowClientMirror: record.allowClientMirror ?? false,
    fileName: record.fileName ?? null,
    fileSizeBytes: record.fileSizeBytes ?? null,
    fileHash: record.fileHash ?? null,
    isPrimary: record.isPrimary,
    isFullPackage: record.isFullPackage,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function mapRelease(record: SharedAdminReleaseRecordDto): AdminReleaseRecordDto {
  const artifacts = record.artifacts.map(mapArtifact);
  return {
    id: record.id,
    platform: record.platform,
    status: record.status,
    version: record.version,
    minimumVersion: record.minimumVersion,
    forceUpgrade: record.forceUpgrade,
    title: record.displayTitle,
    changelog: record.changelog,
    deliveryMode: inferDeliveryMode(record.artifacts),
    publishedAt: record.publishedAt ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    artifacts
  };
}

export async function fetchAdminReleases(filters?: FetchAdminReleasesFilters) {
  const records = await request<SharedAdminReleaseRecordDto[]>(`/admin/releases${buildReleaseQuery(filters)}`, {
    timeoutMs: ADMIN_READ_TIMEOUT_MS
  });
  return records.map(mapRelease);
}

export async function createAdminRelease(input: CreateAdminReleaseInputDto) {
  const version = input.version.trim();
  const payload: CreateReleaseInputDto = {
    platform: input.platform,
    channel: "stable",
    version,
    displayTitle: input.title.trim() || version,
    changelog: input.changelog,
    minimumVersion: input.minimumVersion,
    forceUpgrade: input.forceUpgrade,
    status: input.status,
    initialArtifact: input.initialArtifact ?? undefined
  };
  const record = await request<SharedAdminReleaseRecordDto>("/admin/releases", {
    method: "POST",
    body: JSON.stringify(payload),
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
  return mapRelease(record);
}

export async function updateAdminRelease(releaseId: string, input: UpdateAdminReleaseInputDto) {
  const payload: UpdateReleaseInputDto = {
    ...(input.title !== undefined ? { displayTitle: input.title } : {}),
    ...(input.changelog !== undefined ? { changelog: input.changelog } : {}),
    ...(input.minimumVersion !== undefined ? { minimumVersion: input.minimumVersion } : {}),
    ...(input.forceUpgrade !== undefined ? { forceUpgrade: input.forceUpgrade } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.publishedAt !== undefined ? { publishedAt: input.publishedAt } : {})
  };
  const record = await request<SharedAdminReleaseRecordDto>(`/admin/releases/${releaseId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
  return mapRelease(record);
}

export async function publishAdminRelease(releaseId: string) {
  const record = await request<SharedAdminReleaseRecordDto>(`/admin/releases/${releaseId}/publish`, {
    method: "POST",
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
  return mapRelease(record);
}

export async function unpublishAdminRelease(releaseId: string) {
  const record = await request<SharedAdminReleaseRecordDto>(`/admin/releases/${releaseId}/unpublish`, {
    method: "POST",
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
  return mapRelease(record);
}

export async function deleteAdminRelease(releaseId: string) {
  return request<{ ok: boolean; releaseId: string }>(`/admin/releases/${releaseId}`, {
    method: "DELETE",
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
}

export async function createAdminReleaseArtifact(releaseId: string, input: CreateAdminReleaseArtifactInputDto) {
  const record = await request<SharedAdminReleaseRecordDto>(`/admin/releases/${releaseId}/artifacts`, {
    method: "POST",
    body: JSON.stringify(input),
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
  return mapRelease(record);
}

export async function updateAdminReleaseArtifact(
  releaseId: string,
  artifactId: string,
  input: UpdateAdminReleaseArtifactInputDto
) {
  const record = await request<SharedAdminReleaseRecordDto>(`/admin/releases/${releaseId}/artifacts/${artifactId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
  return mapRelease(record);
}

export async function deleteAdminReleaseArtifact(releaseId: string, artifactId: string) {
  const record = await request<SharedAdminReleaseRecordDto>(`/admin/releases/${releaseId}/artifacts/${artifactId}`, {
    method: "DELETE",
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
  return mapRelease(record);
}

export async function uploadAdminReleaseArtifact(
  releaseId: string,
  input: UploadAdminReleaseArtifactInputDto,
  file: File
) {
  const body = new FormData();
  body.set("type", input.type);
  if (input.source) body.set("source", input.source);
  if (input.deliveryMode) body.set("deliveryMode", input.deliveryMode);
  if (input.fileName) body.set("fileName", input.fileName);
  if (input.isPrimary !== undefined) body.set("isPrimary", String(input.isPrimary));
  body.set("file", file);
  const record = await request<SharedAdminReleaseRecordDto>(`/admin/releases/${releaseId}/artifacts/upload`, {
    method: "POST",
    body,
    timeoutMs: LONG_ADMIN_ACTION_TIMEOUT_MS
  });
  return mapRelease(record);
}

export async function replaceAdminReleaseArtifactUpload(
  releaseId: string,
  artifactId: string,
  input: UploadAdminReleaseArtifactInputDto,
  file: File
) {
  const body = new FormData();
  body.set("type", input.type);
  if (input.source) body.set("source", input.source);
  if (input.deliveryMode) body.set("deliveryMode", input.deliveryMode);
  if (input.fileName) body.set("fileName", input.fileName);
  if (input.isPrimary !== undefined) body.set("isPrimary", String(input.isPrimary));
  body.set("file", file);
  const record = await request<SharedAdminReleaseRecordDto>(`/admin/releases/${releaseId}/artifacts/${artifactId}/upload`, {
    method: "POST",
    body,
    timeoutMs: LONG_ADMIN_ACTION_TIMEOUT_MS
  });
  return mapRelease(record);
}

export async function fetchAdminRuntimeComponents() {
  return request<SharedAdminRuntimeComponentRecordDto[]>("/admin/runtime-components", {
    timeoutMs: ADMIN_READ_TIMEOUT_MS
  });
}

export async function fetchAdminRuntimeComponentFailures(limit = 50) {
  return request<SharedAdminRuntimeComponentFailureReportDto[]>(`/admin/runtime-components/failures?limit=${limit}`, {
    timeoutMs: ADMIN_READ_TIMEOUT_MS
  });
}

export async function createAdminRuntimeComponent(input: CreateAdminRuntimeComponentInputDto) {
  return request<SharedAdminRuntimeComponentRecordDto>("/admin/runtime-components", {
    method: "POST",
    body: JSON.stringify(input),
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
}

export async function uploadAdminRuntimeComponent(input: UploadAdminRuntimeComponentInputDto, file: File) {
  const body = new FormData();
  body.set("platform", input.platform);
  body.set("architecture", input.architecture);
  body.set("kind", input.kind);
  if (input.fileName) body.set("fileName", input.fileName);
  if (input.expectedHash) body.set("expectedHash", input.expectedHash);
  if (input.enabled !== undefined) body.set("enabled", String(input.enabled));
  body.set("file", file);
  return request<SharedAdminRuntimeComponentRecordDto>("/admin/runtime-components/upload", {
    method: "POST",
    body,
    timeoutMs: LONG_ADMIN_ACTION_TIMEOUT_MS
  });
}

export async function updateAdminRuntimeComponent(componentId: string, input: UpdateAdminRuntimeComponentInputDto) {
  return request<SharedAdminRuntimeComponentRecordDto>(`/admin/runtime-components/${componentId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
}

export async function replaceAdminRuntimeComponentUpload(
  componentId: string,
  input: UploadAdminRuntimeComponentInputDto,
  file: File
) {
  const body = new FormData();
  body.set("platform", input.platform);
  body.set("architecture", input.architecture);
  body.set("kind", input.kind);
  if (input.fileName) body.set("fileName", input.fileName);
  if (input.expectedHash) body.set("expectedHash", input.expectedHash);
  if (input.enabled !== undefined) body.set("enabled", String(input.enabled));
  body.set("file", file);
  return request<SharedAdminRuntimeComponentRecordDto>(`/admin/runtime-components/${componentId}/upload`, {
    method: "POST",
    body,
    timeoutMs: LONG_ADMIN_ACTION_TIMEOUT_MS
  });
}

export async function deleteAdminRuntimeComponent(componentId: string) {
  return request<{ id: string; deleted: true }>(`/admin/runtime-components/${componentId}`, {
    method: "DELETE",
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
}

export async function verifyAdminRuntimeComponent(componentId: string) {
  return request<SharedAdminRuntimeComponentValidationDto>(`/admin/runtime-components/${componentId}/verify`, {
    method: "POST",
    timeoutMs: LONG_ADMIN_ACTION_TIMEOUT_MS
  });
}

export type FetchAdminSupportTicketsFilters = {
  status?: SupportTicketStatus;
  ownerType?: "personal" | "team";
  userEmail?: string;
  keyword?: string;
};

export type FetchAdminImageBedFilesInput = {
  start?: number;
  count?: number;
  search?: string;
  dir?: string;
  recursive?: boolean;
};

export async function fetchAdminImageBedConfig() {
  return request<AdminImageBedConfigDto>("/admin/image-bed/config", {
    timeoutMs: ADMIN_READ_TIMEOUT_MS
  });
}

export async function updateAdminImageBedConfig(input: UpdateAdminImageBedConfigInputDto) {
  return request<AdminImageBedConfigDto>("/admin/image-bed/config", {
    method: "PATCH",
    body: JSON.stringify(input),
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
}

export async function fetchAdminImageBedFiles(input?: FetchAdminImageBedFilesInput) {
  const params = new URLSearchParams();
  if (input?.start !== undefined) params.set("start", String(input.start));
  if (input?.count !== undefined) params.set("count", String(input.count));
  if (input?.search?.trim()) params.set("search", input.search.trim());
  if (input?.dir?.trim()) params.set("dir", input.dir.trim());
  if (input?.recursive !== undefined) params.set("recursive", String(input.recursive));
  const query = params.toString();
  return request<AdminImageBedFileListDto>(`/admin/image-bed/files${query ? `?${query}` : ""}`, {
    timeoutMs: IMAGE_BED_ACTION_TIMEOUT_MS
  });
}

export async function deleteAdminImageBedFile(path: string, folder?: boolean) {
  const params = new URLSearchParams({ path });
  if (folder) params.set("folder", "true");
  return request<DeleteAdminImageBedFileResultDto>(`/admin/image-bed/files?${params.toString()}`, {
    method: "DELETE",
    timeoutMs: IMAGE_BED_ACTION_TIMEOUT_MS
  });
}

export async function fetchAdminSupportTickets() {
  return request<SharedAdminSupportTicketSummaryDto[]>("/admin/tickets", {
    timeoutMs: ADMIN_READ_TIMEOUT_MS
  });
}

export async function fetchAdminSupportTicketDetail(ticketId: string) {
  return request<SharedAdminSupportTicketDetailDto>(`/admin/tickets/${ticketId}`, {
    timeoutMs: ADMIN_READ_TIMEOUT_MS
  });
}

export async function replyAdminSupportTicket(ticketId: string, input: ReplyAdminSupportTicketInputDto) {
  return request<SharedAdminSupportTicketDetailDto>(`/admin/tickets/${ticketId}/replies`, {
    method: "POST",
    body: JSON.stringify(input),
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
}

export async function replyAdminSupportTicketWithAttachment(
  ticketId: string,
  input: UploadedSupportTicketAttachmentInputDto,
  file: File
) {
  const body = new FormData();
  if (input.body?.trim()) {
    body.set("body", input.body.trim());
  }
  body.set("file", file);
  return request<SharedAdminSupportTicketDetailDto>(`/admin/tickets/${ticketId}/attachments`, {
    method: "POST",
    body,
    timeoutMs: IMAGE_BED_ACTION_TIMEOUT_MS
  });
}

export async function closeAdminSupportTicket(ticketId: string) {
  return request<SharedAdminSupportTicketDetailDto>(`/admin/tickets/${ticketId}/close`, {
    method: "POST",
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
}

export async function reopenAdminSupportTicket(ticketId: string) {
  return request<SharedAdminSupportTicketDetailDto>(`/admin/tickets/${ticketId}/reopen`, {
    method: "POST",
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
}
