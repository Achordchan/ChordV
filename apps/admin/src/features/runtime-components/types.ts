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
  { value: "windows", label: "Windows" },
  { value: "macos", label: "macOS" },
  { value: "android", label: "Android" },
  { value: "ios", label: "iOS" }
] as const;

export const runtimeComponentArchitectureOptions = [
  { value: "x64", label: "x64" },
  { value: "arm64", label: "ARM64" }
] as const;

export const runtimeComponentKindOptions = [
  { value: "xray", label: "Xray" },
  { value: "geoip", label: "GeoIP" },
  { value: "geosite", label: "GeoSite" }
] as const;

export type RuntimeComponentSlotKey = "xray" | "geoip" | "geosite";

export const runtimeComponentSlots: Array<{
  key: RuntimeComponentSlotKey;
  title: string;
  summary: string;
  defaultFileName: string;
}> = [
  {
    key: "xray",
    title: "Xray",
    summary: "按平台和架构分别配置内核文件。",
    defaultFileName: "xray"
  },
  {
    key: "geoip",
    title: "GeoIP",
    summary: "全平台共用一份规则数据。",
    defaultFileName: "geoip.dat"
  },
  {
    key: "geosite",
    title: "GeoSite",
    summary: "全平台共用一份规则数据。",
    defaultFileName: "geosite.dat"
  }
];

export function defaultFileNameForKind(kind: AdminRuntimeComponentKind) {
  if (kind === "geoip") return "geoip.dat";
  if (kind === "geosite") return "geosite.dat";
  return "xray";
}

export function emptyRuntimeComponentEditorForm(
  kind: AdminRuntimeComponentKind = "xray",
  options?: {
    platform?: AdminReleasePlatform;
    architecture?: AdminRuntimeComponentArchitecture;
  }
): RuntimeComponentEditorFormState {
  const isRuleset = kind === "geoip" || kind === "geosite";
  return {
    platform: options?.platform ?? (isRuleset ? "macos" : "windows"),
    architecture: options?.architecture ?? (isRuleset ? "arm64" : "x64"),
    kind,
    source: "custom_remote",
    originUrl: "",
    defaultMirrorPrefix: "",
    allowClientMirror: true,
    fileName: defaultFileNameForKind(kind),
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
    source: record.source === "github_remote" ? "custom_remote" : record.source,
    originUrl: record.originUrl,
    defaultMirrorPrefix: record.defaultMirrorPrefix ?? "",
    allowClientMirror: record.allowClientMirror,
    fileName: record.fileName || defaultFileNameForKind(record.kind),
    archiveEntryName: record.archiveEntryName ?? "",
    expectedHash: record.expectedHash ?? "",
    enabled: record.enabled,
    selectedFile: null
  };
}

export function translateRuntimeComponentKind(kind: AdminRuntimeComponentKind) {
  if (kind === "xray") return "Xray";
  if (kind === "geoip") return "GeoIP";
  return "GeoSite";
}

export function translatePlatform(platform: AdminReleasePlatform) {
  if (platform === "macos") return "macOS";
  if (platform === "windows") return "Windows";
  if (platform === "android") return "Android";
  return "iOS";
}

export function displayRuntimeComponentTarget(record: AdminRuntimeComponentRecordDto) {
  if (record.kind === "geoip" || record.kind === "geosite") {
    return "全平台通用";
  }
  return `${translatePlatform(record.platform)} / ${record.architecture.toUpperCase()}`;
}

export function countMirrorPrefixes(value?: string | null) {
  if (!value) return 0;
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean).length;
}
