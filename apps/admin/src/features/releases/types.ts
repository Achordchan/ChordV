import type {
  AdminReleaseArtifactRecordDto,
  AdminReleaseArtifactType,
  AdminReleasePlatform,
  AdminReleaseRecordDto,
  AdminReleaseStatus,
  CreateAdminReleaseInputDto,
  CreateAdminReleaseArtifactInputDto,
  UpdateAdminReleaseInputDto
} from "../../api/client";

export type ReleaseEditorFormState = {
  platform: AdminReleasePlatform;
  status: AdminReleaseStatus;
  version: string;
  minimumVersion: string;
  forceUpgrade: boolean;
  title: string;
  artifactSource: "uploaded" | "external";
  externalDeliveryMode: "auto" | "windows_full_replace_zip";
  downloadUrl: string;
  fileName: string;
  selectedFile: File | null;
  changelog: string;
};

export type ArtifactEditorFormState = {
  source: "uploaded" | "external";
  type: AdminReleaseArtifactType;
  externalDeliveryMode: "auto" | "windows_full_replace_zip";
  downloadUrl: string;
  fileName: string;
  isPrimary: boolean;
  selectedFile: File | null;
};

export const releasePlatformOptions = [
  { value: "macos", label: "macOS" },
  { value: "windows", label: "Windows" },
  { value: "android", label: "Android" },
  { value: "ios", label: "iOS" }
] as const;

export function emptyReleaseEditorForm(platform: AdminReleasePlatform = "macos"): ReleaseEditorFormState {
  return {
    platform,
    status: "draft",
    version: "",
    minimumVersion: "",
    forceUpgrade: false,
    title: "",
    artifactSource: "external",
    externalDeliveryMode: platform === "windows" ? "windows_full_replace_zip" : "auto",
    downloadUrl: "",
    fileName: "",
    selectedFile: null,
    changelog: ""
  };
}

export function toReleaseEditorForm(record: AdminReleaseRecordDto): ReleaseEditorFormState {
  return {
    platform: record.platform,
    status: record.status,
    version: record.version,
    minimumVersion: record.minimumVersion,
    forceUpgrade: record.forceUpgrade,
    title: record.title,
    artifactSource: record.artifacts.find((artifact) => artifact.isPrimary)?.source ?? "external",
    externalDeliveryMode:
      record.platform === "windows" &&
      record.artifacts.find((artifact) => artifact.isPrimary)?.type === "zip" &&
      record.artifacts.find((artifact) => artifact.isPrimary)?.deliveryMode === "desktop_full_replace"
        ? "windows_full_replace_zip"
        : "auto",
    downloadUrl: record.artifacts.find((artifact) => artifact.isPrimary)?.originDownloadUrl ?? "",
    fileName: record.artifacts.find((artifact) => artifact.isPrimary)?.fileName ?? "",
    selectedFile: null,
    changelog: record.changelog.join("\n")
  };
}

export function buildCreateReleasePayload(
  form: ReleaseEditorFormState,
  initialArtifact?: CreateAdminReleaseArtifactInputDto
): CreateAdminReleaseInputDto {
  const version = form.version.trim();
  return {
    platform: form.platform,
    status: "draft",
    version,
    minimumVersion: resolveReleaseMinimumVersion(form),
    forceUpgrade: form.forceUpgrade,
    title: form.title.trim() || undefined,
    changelog: splitReleaseChangelog(form.changelog),
    ...(initialArtifact !== undefined ? { initialArtifact } : {})
  };
}

export function buildUpdateReleasePayload(form: ReleaseEditorFormState): UpdateAdminReleaseInputDto {
  return {
    title: form.title.trim(),
    changelog: splitReleaseChangelog(form.changelog),
    minimumVersion: resolveReleaseMinimumVersion(form),
    forceUpgrade: form.forceUpgrade
  };
}

function resolveReleaseMinimumVersion(form: ReleaseEditorFormState) {
  return form.minimumVersion.trim() || form.version.trim();
}

function splitReleaseChangelog(value: string) {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function emptyArtifactEditorForm(
  type: AdminReleaseArtifactType = "dmg",
  source: ArtifactEditorFormState["source"] = "external"
): ArtifactEditorFormState {
  return {
    source,
    type,
    externalDeliveryMode: type === "zip" ? "windows_full_replace_zip" : "auto",
    downloadUrl: "",
    fileName: "",
    isPrimary: true,
    selectedFile: null
  };
}

export function toArtifactEditorForm(record: AdminReleaseArtifactRecordDto): ArtifactEditorFormState {
  return {
    source: record.source,
    type: record.type,
    externalDeliveryMode:
      record.source === "external" && record.type === "zip" && record.deliveryMode === "desktop_full_replace"
        ? "windows_full_replace_zip"
        : "auto",
    downloadUrl: record.source === "external" ? record.originDownloadUrl ?? record.downloadUrl : "",
    fileName: record.fileName ?? "",
    isPrimary: record.isPrimary,
    selectedFile: null
  };
}
