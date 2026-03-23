import type {
  AdminRuntimeComponentArchitecture,
  AdminRuntimeComponentKind,
  AdminRuntimeComponentRecordDto,
  AdminRuntimeComponentSource,
  AdminReleasePlatform
} from "../../api/client";

export type RuntimeComponentEditorFormState = {
  platform: AdminReleasePlatform;
  architecture: AdminRuntimeComponentArchitecture;
  kind: AdminRuntimeComponentKind;
  source: AdminRuntimeComponentSource;
  originUrl: string;
  defaultMirrorPrefix: string;
  allowClientMirror: boolean;
  fileName: string;
  archiveEntryName: string;
  expectedHash: string;
  enabled: boolean;
  selectedFile: File | null;
};

export const runtimeComponentPlatformOptions = [
  { value: "macos", label: "macOS" },
  { value: "windows", label: "Windows" },
  { value: "android", label: "Android" },
  { value: "ios", label: "iOS" }
] as const;

export const runtimeComponentArchitectureOptions = [
  { value: "x64", label: "x64" },
  { value: "arm64", label: "ARM64" }
] as const;

export const runtimeComponentKindOptions = [
  { value: "xray", label: "Xray 内核" },
  { value: "geoip", label: "GeoIP 数据" },
  { value: "geosite", label: "GeoSite 数据" }
] as const;

export function runtimeComponentSourceOptions(current?: AdminRuntimeComponentSource) {
  const options: Array<{ value: AdminRuntimeComponentSource; label: string }> = [
    { value: "uploaded", label: "上传到服务器" },
    { value: "custom_remote", label: "远程直链" }
  ];
  if (current === "github_remote") {
    options.push({ value: "github_remote", label: "远程直链（旧配置）" });
  }
  return options;
}

export function emptyRuntimeComponentEditorForm(): RuntimeComponentEditorFormState {
  return {
    platform: "macos",
    architecture: "arm64",
    kind: "xray",
    source: "uploaded",
    originUrl: "",
    defaultMirrorPrefix: "",
    allowClientMirror: false,
    fileName: "",
    archiveEntryName: "",
    expectedHash: "",
    enabled: true,
    selectedFile: null
  };
}

export function toRuntimeComponentEditorForm(record: AdminRuntimeComponentRecordDto): RuntimeComponentEditorFormState {
  return {
    platform: record.platform,
    architecture: record.architecture,
    kind: record.kind,
    source: record.source,
    originUrl: record.originUrl,
    defaultMirrorPrefix: record.defaultMirrorPrefix ?? "",
    allowClientMirror: record.allowClientMirror,
    fileName: record.fileName,
    archiveEntryName: record.archiveEntryName ?? "",
    expectedHash: record.expectedHash ?? "",
    enabled: record.enabled,
    selectedFile: null
  };
}

export function translateRuntimeComponentKind(kind: AdminRuntimeComponentKind) {
  if (kind === "xray") return "Xray 内核";
  if (kind === "geoip") return "GeoIP 数据";
  return "GeoSite 数据";
}
