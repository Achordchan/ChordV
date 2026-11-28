import { isGitHubReleaseRepository } from "@chordv/shared";
import { compareVersion, parseSemver } from "./releaseVersion";

export type ReleasePlatform = "macos" | "windows" | "linux" | "android";
export type ReleaseArchitecture = "x64" | "arm64";
export type ReleaseChannel = "stable" | "beta";
export type ReleaseAsset = {
  platform: ReleasePlatform;
  architecture: ReleaseArchitecture;
  fileName: string;
  sha256: string;
  sizeBytes: number;
};
export type ReleaseComponent = ReleaseAsset & {
  component: "xray" | "geoip" | "geosite";
  version: string;
  sourceFormat: "direct" | "zip_entry";
  archiveEntryName?: string;
};
export type GitHubReleaseManifest = {
  schemaVersion: 1 | 2;
  sourceCommit?: string;
  tagBinding?: { mode: "source-commit" } | { mode: "signed-manifest-tree"; repository: string };
  version: string;
  tag: string;
  channel: ReleaseChannel;
  build: number;
  minimumVersion: string;
  forceUpgrade: boolean;
  title: string;
  changelog: string[];
  publishedAt: string;
  installers: ReleaseAsset[];
  runtimeComponents: ReleaseComponent[];
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GitHub 发布清单格式无效。");
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, maximum = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(`发布清单${label}无效。`);
  return value;
}
function positiveInteger(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`发布清单${label}无效。`);
  return Number(value);
}
export function normalizeReleaseRepository(value: string) {
  const repository = value.trim();
  if (!isGitHubReleaseRepository(repository)) {
    throw new Error("GitHub 发布仓库应填写 owner/repository。");
  }
  return repository;
}
export function assertReleaseFileName(value: unknown) {
  const fileName = text(value, "文件名");
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(fileName) || fileName.includes("..")) throw new Error("发布文件名包含无效路径。");
  return fileName;
}
function asset(value: unknown): ReleaseAsset {
  const item = object(value);
  if (!["macos", "windows", "linux", "android"].includes(String(item.platform))) throw new Error("发布清单平台无效。");
  if (item.architecture !== "x64" && item.architecture !== "arm64") throw new Error("发布清单架构无效。");
  const sha256 = text(item.sha256, "SHA256").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("发布文件缺少有效 SHA256。");
  return {
    platform: item.platform as ReleasePlatform, architecture: item.architecture,
    fileName: assertReleaseFileName(item.fileName), sha256, sizeBytes: positiveInteger(item.sizeBytes, "文件大小")
  };
}
function component(value: unknown): ReleaseComponent {
  const item = object(value), result = asset(item);
  if (!["xray", "geoip", "geosite"].includes(String(item.component))) throw new Error("发布清单组件类型无效。");
  if (item.sourceFormat !== "direct" && item.sourceFormat !== "zip_entry") throw new Error("组件下载格式无效。");
  let archiveEntryName: string | undefined;
  if (item.sourceFormat === "zip_entry") {
    archiveEntryName = text(item.archiveEntryName, "归档条目");
    if (archiveEntryName.startsWith("/") || archiveEntryName.includes("\\")
        || archiveEntryName.split("/").some(part => !part || part === "." || part === "..")
        || archiveEntryName.includes(":")) throw new Error("组件归档条目路径无效。");
  }
  return { ...result, component: item.component as ReleaseComponent["component"], version: text(item.version, "组件版本"), sourceFormat: item.sourceFormat, ...(archiveEntryName ? { archiveEntryName } : {}) };
}
function unique<T>(values: T[], key: (value: T) => string) {
  const keys = values.map(key);
  if (new Set(keys).size !== keys.length) throw new Error("发布清单包含重复的平台或组件。");
}
export function parseReleaseManifest(body: string, channel?: ReleaseChannel): GitHubReleaseManifest {
  if (body.length > 1024 * 1024) throw new Error("GitHub 发布清单过大。");
  const value = object(JSON.parse(body));
  const version = text(value.version, "版本号", 64), semver = parseSemver(version);
  if ((value.schemaVersion !== 1 && value.schemaVersion !== 2) || !semver || version.startsWith("v") || value.tag !== `v${version}`) throw new Error("发布清单版本与标签不一致。");
  let tagBinding: GitHubReleaseManifest["tagBinding"];
  if (value.schemaVersion === 2) {
    const binding = object(value.tagBinding);
    if (binding.mode !== "signed-manifest-tree" || typeof binding.repository !== "string"
        || binding.repository !== normalizeReleaseRepository(binding.repository).toLowerCase()
        || typeof value.sourceCommit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.sourceCommit)) throw new Error("发布清单绑定模式、仓库或源码来源无效。");
    tagBinding = { mode: "signed-manifest-tree", repository: binding.repository };
  } else if (value.schemaVersion !== 1 || value.tagBinding !== undefined && object(value.tagBinding).mode !== "source-commit") {
    throw new Error("发布清单绑定模式与版本不匹配。");
  } else if (value.tagBinding !== undefined) tagBinding = { mode: "source-commit" };
  if (value.channel !== "stable" && value.channel !== "beta") throw new Error("发布渠道无效。");
  if (channel && channel !== value.channel) throw new Error("发布清单渠道不匹配。");
  if ((value.channel === "stable") !== (semver.prerelease.length === 0)) throw new Error("稳定版与测试版标签不匹配。");
  const minimumVersion = text(value.minimumVersion, "最低版本", 64);
  if (!parseSemver(minimumVersion) || compareVersion(minimumVersion, version) > 0) throw new Error("最低支持版本无效。");
  if (typeof value.forceUpgrade !== "boolean" || !Array.isArray(value.changelog) || !value.changelog.every(item => typeof item === "string" && item.length <= 4000)) throw new Error("更新说明或强制更新设置无效。");
  const publishedAt = text(value.publishedAt, "发布时间");
  if (!Number.isFinite(Date.parse(publishedAt))) throw new Error("发布时间无效。");
  if (!Array.isArray(value.installers) || !value.installers.length || !Array.isArray(value.runtimeComponents)) throw new Error("发布清单缺少安装包或组件列表。");
  const installers = value.installers.map(asset), runtimeComponents = value.runtimeComponents.map(component);
  unique(installers, item => `${item.platform}:${item.architecture}`);
  unique(runtimeComponents, item => `${item.component}:${item.platform}:${item.architecture}`);
  for (const item of installers) {
    const extension = item.platform === "windows" ? /\.exe$/i : item.platform === "macos" ? /\.dmg$/i : item.platform === "android" ? /\.apk$/i : /\.(?:deb|rpm|tar\.gz)$/i;
    if (!extension.test(item.fileName)) throw new Error("安装包类型与平台不匹配。");
  }
  return {
    schemaVersion: value.schemaVersion as 1 | 2, ...(tagBinding ? { tagBinding } : {}), ...(typeof value.sourceCommit === "string" ? { sourceCommit: value.sourceCommit } : {}),
    version, tag: value.tag as string, channel: value.channel, build: positiveInteger(value.build, "构建号"),
    minimumVersion, forceUpgrade: value.forceUpgrade, title: text(value.title, "标题"), changelog: value.changelog as string[],
    publishedAt, installers, runtimeComponents
  };
}
export function releaseAssetUrl(repository: string, tag: string, fileName: string) {
  const version = tag.startsWith("v") ? tag.slice(1) : "";
  if (!parseSemver(version) || version.startsWith("v")) throw new Error("下载必须使用固定发布标签。");
  return `https://github.com/${normalizeReleaseRepository(repository)}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assertReleaseFileName(fileName))}`;
}

export function assertReleaseNotReplayed(manifest: GitHubReleaseManifest, highest: { version: string; build: number } | null) {
  if (highest && (compareVersion(manifest.version, highest.version) < 0
      || (compareVersion(manifest.version, highest.version) === 0 && manifest.build < highest.build))) {
    throw new Error("更新源返回了较旧的发布清单，请稍后重试。");
  }
}
