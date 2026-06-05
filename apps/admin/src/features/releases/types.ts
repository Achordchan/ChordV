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
  minimumVersion: string;
  forceUpgrade: boolean;
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
  isFullPackage: boolean;
  selectedFile: File | null;
};

export const releasePlatformOptions = [
  { value: "macos", label: "macOS" },
  { value: "windows", label: "Windows" },
  { value: "android", label: "Android" },
  { value: "ios", label: "iOS" }
] as const;

export const DEFAULT_GITHUB_MIRROR_PREFIX = "";

export function emptyReleaseEditorForm(platform: AdminReleasePlatform = "macos"): ReleaseEditorFormState {
  return {
    platform,
    status: "draft",
    version: "",
    minimumVersion: "",
    forceUpgrade: false,
    title: "",
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
    changelog: record.changelog.join("\n")
  };
}

export function emptyArtifactEditorForm(type: AdminReleaseArtifactType = "dmg"): ArtifactEditorFormState {
  return {
    source: "uploaded",
    type,
    downloadUrl: "",
    defaultMirrorPrefix: DEFAULT_GITHUB_MIRROR_PREFIX,
    allowClientMirror: false,
    fileName: "",
    isPrimary: true,
    isFullPackage: true,
    selectedFile: null
  };
}

export function toArtifactEditorForm(record: AdminReleaseArtifactRecordDto): ArtifactEditorFormState {
  return {
    source: record.source,
    type: record.type,
    downloadUrl: record.downloadUrl,
    defaultMirrorPrefix: record.defaultMirrorPrefix ?? "",
    allowClientMirror: record.allowClientMirror,
    fileName: record.fileName ?? "",
    isPrimary: record.isPrimary,
    isFullPackage: record.isFullPackage,
    selectedFile: null
  };
}
