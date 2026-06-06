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
  changelog: string;
};

export type ArtifactEditorFormState = {
  source: "uploaded" | "external";
  type: AdminReleaseArtifactType;
  downloadUrl: string;
  defaultMirrorPrefix: string;
  allowClientMirror: boolean;
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
    changelog: ""
  };
}

export function toReleaseEditorForm(record: AdminReleaseRecordDto): ReleaseEditorFormState {
  return {
    platform: record.platform,
    status: record.status,
    version: record.version,
    title: record.title,
    changelog: record.changelog.join("\n")
  };
}

export function emptyArtifactEditorForm(type: AdminReleaseArtifactType = "dmg"): ArtifactEditorFormState {
  return {
    source: "external",
    type,
    downloadUrl: "",
    defaultMirrorPrefix: "",
    allowClientMirror: true,
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
    defaultMirrorPrefix: record.defaultMirrorPrefix ?? "",
    allowClientMirror: record.allowClientMirror,
    fileName: record.fileName ?? "",
    isPrimary: record.isPrimary,
    selectedFile: null
  };
}
