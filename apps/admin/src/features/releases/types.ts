import type {
  AdminReleaseArtifactRecordDto,
  AdminReleaseArtifactType,
  AdminReleaseChannel,
  AdminReleasePlatform,
  AdminReleaseRecordDto,
  AdminReleaseStatus
} from "../../api/client";

export type ReleaseEditorFormState = {
  platform: AdminReleasePlatform;
  channel: AdminReleaseChannel;
  status: AdminReleaseStatus;
  version: string;
  minimumVersion: string;
  forceUpgrade: boolean;
  title: string;
  releaseNotes: string;
  changelog: string;
};

export type ArtifactEditorFormState = {
  source: "uploaded" | "external";
  type: AdminReleaseArtifactType;
  downloadUrl: string;
  defaultMirrorPrefix: string;
  allowClientMirror: boolean;
  fileName: string;
  fileSizeBytes: number | "";
  fileHash: string;
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

export const releaseChannelOptions = [
  { value: "stable", label: "正式版" }
] as const;

export const releaseStatusOptions = [
  { value: "draft", label: "草稿" },
  { value: "published", label: "已发布" },
  { value: "archived", label: "已归档" }
] as const;

export const releaseArtifactTypeOptions = [
  { value: "dmg", label: "DMG 安装包" },
  { value: "app", label: "APP 应用包" },
  { value: "exe", label: "EXE 单文件" },
  { value: "setup.exe", label: "Setup 安装器" },
  { value: "apk", label: "APK 安装包" },
  { value: "ipa", label: "IPA 安装包" },
  { value: "external", label: "外部下载页" }
] as const;

export const DEFAULT_GITHUB_MIRROR_PREFIX = "";

export function releaseArtifactTypeOptionsForPlatform(platform: AdminReleasePlatform, currentType?: AdminReleaseArtifactType) {
  const allowed = new Set<AdminReleaseArtifactType>(
    platform === "macos"
      ? ["dmg"]
      : platform === "windows"
        ? ["setup.exe"]
        : platform === "android"
          ? ["apk"]
          : ["ipa", "external"]
  );

  const filtered = releaseArtifactTypeOptions.filter((item) => allowed.has(item.value as AdminReleaseArtifactType));
  if (currentType && !allowed.has(currentType)) {
    const legacy = releaseArtifactTypeOptions.find((item) => item.value === currentType);
    if (legacy) {
      return [{ ...legacy, label: `${legacy.label}（旧格式）` }, ...filtered];
    }
  }
  return filtered;
}

export function emptyReleaseEditorForm(platform: AdminReleasePlatform = "macos", channel: AdminReleaseChannel = "stable"): ReleaseEditorFormState {
  return {
    platform,
    channel,
    status: "draft",
    version: "",
    minimumVersion: "",
    forceUpgrade: false,
    title: "",
    releaseNotes: "",
    changelog: ""
  };
}

export function toReleaseEditorForm(record: AdminReleaseRecordDto): ReleaseEditorFormState {
  return {
    platform: record.platform,
    channel: record.channel,
    status: record.status,
    version: record.version,
    minimumVersion: record.minimumVersion,
    forceUpgrade: record.forceUpgrade,
    title: record.title,
    releaseNotes: record.releaseNotes ?? "",
    changelog: record.changelog.join("\n")
  };
}

export function emptyArtifactEditorForm(type: AdminReleaseArtifactType = "dmg"): ArtifactEditorFormState {
  return {
    source: "uploaded",
    type,
    downloadUrl: "",
    defaultMirrorPrefix: DEFAULT_GITHUB_MIRROR_PREFIX,
    allowClientMirror: true,
    fileName: "",
    fileSizeBytes: "",
    fileHash: "",
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
    fileSizeBytes: record.fileSizeBytes ?? "",
    fileHash: record.fileHash ?? "",
    isPrimary: record.isPrimary,
    isFullPackage: record.isFullPackage,
    selectedFile: null
  };
}
