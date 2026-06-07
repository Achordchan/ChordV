import type {
  AdminReleaseArtifactRecordDto,
  AdminReleaseArtifactType,
  AdminReleasePlatform,
  AdminReleaseRecordDto,
  AdminReleaseStatus
} from "../../api/client";

export type ReleaseEditorFormState = {
  platform: AdminReleasePlatform;
  status: AdminReleaseStatus;
  version: string;
  title: string;
  artifactSource: "uploaded" | "external";
  downloadUrl: string;
  fileName: string;
  selectedFile: File | null;
  changelog: string;
};

export type ArtifactEditorFormState = {
  source: "uploaded" | "external";
  type: AdminReleaseArtifactType;
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
    title: "",
    artifactSource: "external",
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
    title: record.title,
    artifactSource: record.artifacts.find((artifact) => artifact.isPrimary)?.source ?? "external",
    downloadUrl: record.artifacts.find((artifact) => artifact.isPrimary)?.originDownloadUrl ?? "",
    fileName: record.artifacts.find((artifact) => artifact.isPrimary)?.fileName ?? "",
    selectedFile: null,
    changelog: record.changelog.join("\n")
  };
}

export function emptyArtifactEditorForm(type: AdminReleaseArtifactType = "dmg"): ArtifactEditorFormState {
  return {
    source: "external",
    type,
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
    downloadUrl: record.source === "external" ? record.originDownloadUrl ?? record.downloadUrl : "",
    fileName: record.fileName ?? "",
    isPrimary: record.isPrimary,
    selectedFile: null
  };
}
