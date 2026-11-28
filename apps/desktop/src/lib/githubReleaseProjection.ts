import type { ClientUpdateCheckResult, ReleaseChannel } from "../api/client";
import type { ClientRuntimeComponentsPlan } from "./runtimeComponents";
import { releaseAssetUrl, type GitHubReleaseManifest, type ReleaseArchitecture } from "./githubReleaseManifest";
import { githubTransportUrls, type GitHubReleaseConfiguration } from "./githubReleaseSource";
import { compareVersion, parseSemver } from "./releaseVersion";

export function projectGitHubUpdate(manifest: GitHubReleaseManifest, configuration: GitHubReleaseConfiguration, input: {
  platform: "macos" | "windows" | "android" | "ios";
  architecture: ReleaseArchitecture;
  currentVersion: string;
  currentBuild: number | null;
  channel: ReleaseChannel;
}): ClientUpdateCheckResult {
  if (!parseSemver(input.currentVersion)) throw new Error("当前客户端版本号无效。");
  const installer = manifest.installers.find(item => item.platform === input.platform && item.architecture === input.architecture);
  if (!installer) throw new Error("此 GitHub 版本尚未提供当前系统和架构的安装包。");
  const url = releaseAssetUrl(configuration.repository, manifest.tag, installer.fileName);
  const urls = githubTransportUrls(url, configuration);
  const isNewer = compareVersion(manifest.version, input.currentVersion) > 0
    || (compareVersion(manifest.version, input.currentVersion) === 0 && input.currentBuild !== null && manifest.build > input.currentBuild);
  return {
    platform: input.platform, channel: input.channel, releaseChannel: manifest.channel, latestBuild: manifest.build,
    currentVersion: input.currentVersion, latestVersion: manifest.version,
    minimumVersion: manifest.channel === "beta" ? "0.0.0" : manifest.minimumVersion,
    hasUpdate: isNewer, forceUpgrade: manifest.channel === "stable" && isNewer && (manifest.forceUpgrade || compareVersion(manifest.minimumVersion, input.currentVersion) > 0),
    title: manifest.title, changelog: manifest.changelog, publishedAt: manifest.publishedAt,
    deliveryMode: input.platform === "android" ? "apk_download" : "desktop_installer_download", downloadUrl: urls[0],
    artifact: {
      fileType: input.platform === "windows" ? "setup.exe" : input.platform === "android" ? "apk" : "dmg", downloadUrl: urls[0],
      originDownloadUrl: url, defaultMirrorPrefix: null, allowClientMirror: false,
      fileName: installer.fileName, fileSizeBytes: installer.sizeBytes, fileHash: installer.sha256,
      isPrimary: true, isFullPackage: true, downloadCandidates: urls
    }
  };
}

export function projectGitHubRuntimePlan(manifest: GitHubReleaseManifest, configuration: GitHubReleaseConfiguration, environment: {
  platform: "macos" | "windows";
  architecture: ReleaseArchitecture;
}): ClientRuntimeComponentsPlan {
  const components = manifest.runtimeComponents.filter(item => item.platform === environment.platform && item.architecture === environment.architecture);
  return {
    platform: environment.platform, architecture: environment.architecture,
    components: components.map(item => {
      const origin = releaseAssetUrl(configuration.repository, manifest.tag, item.fileName);
      const urls = githubTransportUrls(origin, configuration);
      return {
        id: `${manifest.tag}:${item.component}:${item.platform}:${item.architecture}`, revision: item.sha256, versionLabel: item.version,
        component: item.component, fileName: item.fileName,
        fileSizeBytes: item.sizeBytes, sourceFormat: item.sourceFormat, archiveEntryName: item.archiveEntryName ?? null,
        checksumSha256: item.sha256, selectedUrl: urls[0], displayName: item.component === "xray" ? "Xray 内核" : item.component === "geoip" ? "GeoIP 数据" : "GeoSite 数据",
        candidates: urls.map(url => ({ label: url === origin ? "GitHub" : "GitHub 加速", url, source: url === origin ? "origin" as const : "mirror" as const }))
      };
    })
  };
}
