import type {
  RuntimeComponentDownloadCandidate,
  RuntimeComponentDownloadItem
} from "./runtimeComponents";
import { applyUpdateMirrorPrefix, normalizeMirrorPrefix } from "./updateState";

export const GEO_UPSTREAM_REPO = "Loyalsoldier/v2ray-rules-dat";
export const GEO_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const GEO_LAST_CHECK_STORAGE_KEY = "chordv.geo.lastCheckAt";
export const GEO_INSTALLED_TAG_STORAGE_KEY = "chordv.geo.installedReleaseTag";

export type GeoFileName = "geoip.dat" | "geosite.dat";
export type GeoComponentKind = "geoip" | "geosite";

export type GeoRemoteAsset = {
  kind: GeoComponentKind;
  fileName: GeoFileName;
  releaseTag: string;
  fileSizeBytes: number;
  checksumSha256: string;
  originUrl: string;
};

export type GeoRemotePlan = {
  releaseTag: string;
  publishedAt: string | null;
  assets: GeoRemoteAsset[];
};

export type RuntimeComponentLocalInfo = {
  kind: "xray" | "geoip" | "geosite";
  exists: boolean;
  path: string | null;
  sizeBytes: number | null;
  checksumSha256: string | null;
};

type GitHubReleaseAsset = {
  name?: string;
  size?: number;
  browser_download_url?: string;
};

type GitHubReleasePayload = {
  tag_name?: string;
  published_at?: string;
  assets?: GitHubReleaseAsset[];
};

export function shouldCheckGeoUpdate(lastCheckAtMs: number | null, nowMs = Date.now()) {
  if (!lastCheckAtMs || !Number.isFinite(lastCheckAtMs) || lastCheckAtMs <= 0) {
    return true;
  }
  return nowMs - lastCheckAtMs >= GEO_CHECK_INTERVAL_MS;
}

export function readStoredGeoLastCheckAt(storage: Storage = localStorage) {
  const raw = storage.getItem(GEO_LAST_CHECK_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function writeStoredGeoLastCheckAt(valueMs: number, storage: Storage = localStorage) {
  storage.setItem(GEO_LAST_CHECK_STORAGE_KEY, String(valueMs));
}

export function readStoredGeoInstalledTag(storage: Storage = localStorage) {
  return storage.getItem(GEO_INSTALLED_TAG_STORAGE_KEY);
}

export function writeStoredGeoInstalledTag(tag: string, storage: Storage = localStorage) {
  storage.setItem(GEO_INSTALLED_TAG_STORAGE_KEY, tag);
}

export function parseSha256Sum(content: string) {
  const match = content.trim().match(/\b([a-fA-F0-9]{64})\b/);
  return match?.[1]?.toLowerCase() ?? null;
}

export function buildGithubReleaseLatestApiUrl(repo = GEO_UPSTREAM_REPO) {
  return `https://api.github.com/repos/${repo}/releases/latest`;
}

export function buildGeoOriginUrl(releaseTag: string, fileName: string) {
  return `https://github.com/${GEO_UPSTREAM_REPO}/releases/download/${encodeURIComponent(releaseTag)}/${fileName}`;
}

export function buildGeoDownloadCandidates(
  originUrl: string,
  releaseTag: string,
  fileName: string,
  clientMirrorPrefix?: string | null,
  serverMirrorPrefixes?: string[] | null
): RuntimeComponentDownloadCandidate[] {
  const candidates: RuntimeComponentDownloadCandidate[] = [];
  const seen = new Set<string>();
  const push = (
    label: string,
    url: string,
    source: RuntimeComponentDownloadCandidate["source"]
  ) => {
    const normalized = url.trim();
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    candidates.push({ label, url: normalized, source });
  };

  // Client custom prefixes first.
  const clientPrefixes = String(clientMirrorPrefix ?? "")
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  for (const prefix of clientPrefixes) {
    push("client_mirror", applyUpdateMirrorPrefix(originUrl, normalizeMirrorPrefix(prefix) ?? prefix), "client_override");
  }

  // Admin-configured mirrors next.
  for (const prefix of serverMirrorPrefixes ?? []) {
    const normalized = prefix.trim();
    if (!normalized) continue;
    push("server_mirror", applyUpdateMirrorPrefix(originUrl, normalized), "server_mirror");
  }

  // Built-in accelerators before official GitHub.
  push(
    "ghproxy",
    `https://mirror.ghproxy.com/${originUrl}`,
    "server_mirror"
  );
  push(
    "ghfast",
    `https://ghfast.top/${originUrl}`,
    "server_mirror"
  );
  push(
    "jsDelivr GitHub",
    `https://cdn.jsdelivr.net/gh/${GEO_UPSTREAM_REPO}@${releaseTag}/${fileName}`,
    "server_mirror"
  );

  // Official origin last.
  push("GitHub", originUrl, "origin");

  return candidates;
}

export function buildGeoComponentItem(
  asset: GeoRemoteAsset,
  clientMirrorPrefix?: string | null,
  serverMirrorPrefixes?: string[] | null
): RuntimeComponentDownloadItem {
  const candidates = buildGeoDownloadCandidates(
    asset.originUrl,
    asset.releaseTag,
    asset.fileName,
    clientMirrorPrefix,
    serverMirrorPrefixes
  );
  return {
    id: `geo_external_${asset.kind}_${asset.releaseTag}`,
    component: asset.kind,
    fileName: asset.fileName,
    fileSizeBytes: asset.fileSizeBytes,
    sourceFormat: "direct",
    archiveEntryName: null,
    checksumSha256: asset.checksumSha256,
    candidates,
    selectedUrl: candidates[0]?.url ?? asset.originUrl,
    displayName: asset.kind === "geoip" ? "GeoIP 数据" : "GeoSite 数据"
  };
}

export function parseGithubReleasePayload(
  raw: string
): { tag: string; publishedAt: string | null; assets: GitHubReleaseAsset[] } | null {
  let payload: GitHubReleasePayload;
  try {
    payload = JSON.parse(raw) as GitHubReleasePayload;
  } catch {
    return null;
  }
  const tag = payload.tag_name?.trim();
  if (!tag) {
    return null;
  }
  return {
    tag,
    publishedAt: payload.published_at ?? null,
    assets: Array.isArray(payload.assets) ? payload.assets : []
  };
}

export function findReleaseAsset(assets: GitHubReleaseAsset[], fileName: string) {
  return assets.find((asset) => asset.name === fileName) ?? null;
}

export function buildGeoRemoteAssetsFromRelease(
  release: { tag: string; publishedAt: string | null; assets: GitHubReleaseAsset[] },
  checksums: Partial<Record<GeoFileName, string>>
): GeoRemotePlan | null {
  const geoip = findReleaseAsset(release.assets, "geoip.dat");
  const geosite = findReleaseAsset(release.assets, "geosite.dat");
  const geoipHash = checksums["geoip.dat"];
  const geositeHash = checksums["geosite.dat"];
  if (!geoip?.browser_download_url || !geosite?.browser_download_url || !geoipHash || !geositeHash) {
    return null;
  }
  if (!geoip.size || !geosite.size || geoip.size <= 0 || geosite.size <= 0) {
    return null;
  }

  return {
    releaseTag: release.tag,
    publishedAt: release.publishedAt,
    assets: [
      {
        kind: "geoip",
        fileName: "geoip.dat",
        releaseTag: release.tag,
        fileSizeBytes: geoip.size,
        checksumSha256: geoipHash,
        originUrl: geoip.browser_download_url
      },
      {
        kind: "geosite",
        fileName: "geosite.dat",
        releaseTag: release.tag,
        fileSizeBytes: geosite.size,
        checksumSha256: geositeHash,
        originUrl: geosite.browser_download_url
      }
    ]
  };
}

export function isLocalGeoCurrent(
  local: RuntimeComponentLocalInfo | null | undefined,
  remote: GeoRemoteAsset
) {
  if (!local?.exists || !local.checksumSha256 || !local.sizeBytes) {
    return false;
  }
  if (local.sizeBytes !== remote.fileSizeBytes) {
    return false;
  }
  return local.checksumSha256.toLowerCase() === remote.checksumSha256.toLowerCase();
}

export function pickGeoCandidateUrls(item: RuntimeComponentDownloadItem) {
  return item.candidates.map((candidate) => candidate.url).filter(Boolean);
}
