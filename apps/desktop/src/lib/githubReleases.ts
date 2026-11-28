import { readReleaseTextResponse } from "./releaseTextResponse";
import { normalizeReleaseRepository } from "./githubReleaseManifest";
import type { ClientReleaseHistoryItemDto } from "@chordv/shared";
import type { ClientUpdateCheckResult, ReleaseChannel } from "../api/client";
import { APP_BUILD_NUMBER } from "./buildInfo";
import { authorizeReleaseManifest, fetchRemoteText, loadDesktopRuntimeEnvironment, verifyReleaseManifestSignature } from "./runtime";
import { compareVersion, parseSemver } from "./releaseVersion";
import { projectGitHubRuntimePlan, projectGitHubUpdate } from "./githubReleaseProjection";
import { GITHUB_RELEASE_NOT_CONFIGURED, GitHubReleaseConfigurationError, GitHubReleaseSource, ReleaseChannelNotPublishedError, type GitHubReleaseConfiguration } from "./githubReleaseSource";
import type { ClientRuntimeComponentsPlan } from "./runtimeComponents";

export function readGitHubReleaseConfiguration(): GitHubReleaseConfiguration {
  const env = import.meta.env;
  const repository = String(env?.VITE_GITHUB_RELEASE_REPOSITORY ?? "").trim();
  if (!repository) throw new GitHubReleaseConfigurationError(GITHUB_RELEASE_NOT_CONFIGURED);
  const publicKey = String(env?.VITE_GITHUB_RELEASE_PUBLIC_KEY ?? "").trim().replaceAll("\\n", "\n");
  return { repository, publicKey };
}

async function readGitHubText(url: string) {
  const native = await fetchRemoteText(url);
  if (native) return native;
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000), credentials: "omit", cache: "no-store" });
  return readReleaseTextResponse(url, response);
}
let releaseSource: { key: string; source: GitHubReleaseSource } | null = null;
function source(configuration: GitHubReleaseConfiguration) {
  const key = JSON.stringify(configuration);
  if (releaseSource?.key === key) return releaseSource.source;
  const next = new GitHubReleaseSource(configuration, {
    read: readGitHubText, verify: verifyReleaseManifestSignature, authorize: authorizeReleaseManifest,
    readHighest: key => {
      try {
        const value = JSON.parse(localStorage.getItem(key) ?? "null");
        return value && parseSemver(value.version) && Number.isSafeInteger(value.build) ? value : null;
      } catch { return null; }
    },
    writeHighest: (key, value) => { localStorage.setItem(key, JSON.stringify(value)); }
  });
  releaseSource = { key, source: next };
  return next;
}
async function loadChannel(channel: ReleaseChannel, configuration: GitHubReleaseConfiguration, force = false) {
  try { return await source(configuration).load(channel, force); }
  catch (reason) {
    if (channel !== "beta" || !(reason instanceof ReleaseChannelNotPublishedError)) throw reason;
    return source(configuration).load("stable", force);
  }
}

export async function checkGitHubClientUpdate(input: {
  currentVersion: string;
  platform?: "macos" | "windows" | "android" | "ios";
  channel?: ReleaseChannel;
  force?: boolean;
}): Promise<ClientUpdateCheckResult> {
  const configuration = readGitHubReleaseConfiguration();
  const manifest = await loadChannel(input.channel ?? "stable", configuration, input.force);
  const environment = await loadDesktopRuntimeEnvironment();
  const platform = input.platform ?? environment?.platform;
  if (!platform || !environment) throw new Error("请在桌面客户端中检查对应平台的安装包。");
  return projectGitHubUpdate(manifest, configuration, {
    platform, architecture: environment.architecture, currentVersion: input.currentVersion,
    currentBuild: APP_BUILD_NUMBER, channel: input.channel ?? "stable"
  });
}

export async function fetchGitHubRuntimeComponentsPlan(input?: { channel?: ReleaseChannel }): Promise<ClientRuntimeComponentsPlan | null> {
  const environment = await loadDesktopRuntimeEnvironment();
  if (!environment) return null;
  const configuration = readGitHubReleaseConfiguration();
  const manifest = await loadChannel(input?.channel ?? "stable", configuration);
  return projectGitHubRuntimePlan(manifest, configuration, environment);
}

export async function fetchGitHubReleaseHistory(input: { channel: ReleaseChannel; page: number }): Promise<{ items: ClientReleaseHistoryItemDto[]; hasMore: boolean }> {
  const configuration = readGitHubReleaseConfiguration();
  if (!Number.isSafeInteger(input.page) || input.page < 1) throw new Error("更新日志页码无效。");
  const response = await readGitHubText(`https://api.github.com/repos/${normalizeReleaseRepository(configuration.repository)}/releases?per_page=30${input.page === 1 ? "" : `&page=${input.page}`}`);
  if (response.status !== 200) throw new Error("GitHub 更新日志读取失败。");
  const releases: unknown = JSON.parse(response.body);
  if (!Array.isArray(releases)) throw new Error("GitHub 更新日志格式无效。");
  const items = releases.filter(item => {
    if (!item || item.draft !== false || typeof item.tag_name !== "string" || !item.tag_name.startsWith("v")) return false;
    const version = parseSemver(item.tag_name);
    return version && item.prerelease === (version.prerelease.length > 0) && (input.channel === "beta" || !item.prerelease);
  }).map(item => ({
      version: String(item.tag_name).slice(1), releaseChannel: item.prerelease ? "beta" as const : "stable" as const,
      title: typeof item.name === "string" ? item.name : item.tag_name,
      changelog: typeof item.body === "string" ? item.body.split(/\r?\n/).map((line: string) => line.replace(/^[-*# ]+/, "").trim()).filter(Boolean) : [],
      publishedAt: typeof item.published_at === "string" ? item.published_at : null, build: null
    })).sort((a, b) => compareVersion(b.version, a.version));
  // Only use the relation as a signal; never navigate to an address supplied by the header.
  return { items, hasMore: /(?:^|,)\s*<[^>]+>\s*;\s*rel="next"(?=\s*(?:,|$))/i.test(response.link ?? "") };
}
