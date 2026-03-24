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

export const releaseArtifactTypeOptions = [
  { value: "dmg", label: "DMG 安装包" },
  { value: "app", label: "APP 应用包" },
  { value: "exe", label: "EXE 单文件" },
  { value: "setup.exe", label: "Setup 安装器" },
  { value: "apk", label: "APK 安装包" },
  { value: "ipa", label: "IPA 安装包" },
  { value: "external", label: "外部下载页" }
] as const;

export const DEFAULT_GITHUB_MIRROR_PREFIX = "https://ghfast.top/{url}";

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
    status: record.status === "published" ? "published" : "draft",
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

export function isDesktopReleasePlatform(platform: AdminReleasePlatform) {
  return platform === "macos" || platform === "windows";
}
