import { fetchPublicHttpUrl } from "./remote-url.utils";

const GITHUB_LATEST_CACHE_TTL_MS = 15 * 60 * 1000;
const GITHUB_RELEASE_RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;

export type GithubLatestReleaseAsset = {
  originUrl: string;
  fileName: string;
  fileSizeBytes: bigint | null;
  sha256: string | null;
  revision: string;
  versionLabel: string;
};

export type GithubLatestDownloadTarget = {
  owner: string;
  repo: string;
  assetName: string;
};

type CacheEntry = {
  expiresAt: number;
  body: string;
};

type PublicHttpFetcher = typeof fetchPublicHttpUrl;

const latestReleaseCache = new Map<string, CacheEntry>();
const latestReleaseRequests = new Map<string, Promise<string>>();

export function parseGithubLatestDownloadUrl(rawUrl: string): GithubLatestDownloadTarget | null {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    return null;
  }
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/releases\/latest\/download\/([^/]+)$/i);
  if (!match) {
    return null;
  }
  return {
    owner: decodeURIComponent(match[1]),
    repo: decodeURIComponent(match[2]),
    assetName: decodeURIComponent(match[3])
  };
}

export function parseGithubLatestReleasePayload(body: string, assetName: string): GithubLatestReleaseAsset {
  const payload = JSON.parse(body) as {
    tag_name?: unknown;
    published_at?: unknown;
    assets?: Array<{
      name?: unknown;
      size?: unknown;
      digest?: unknown;
      updated_at?: unknown;
      browser_download_url?: unknown;
    }>;
  };
  const asset = payload.assets?.find((item) => item.name === assetName);
  if (!asset || typeof asset.browser_download_url !== "string") {
    throw new Error("GitHub latest release does not contain asset " + assetName);
  }
  const tagName = typeof payload.tag_name === "string" ? payload.tag_name.trim() : "";
  const revision = typeof asset.updated_at === "string"
    ? asset.updated_at
    : typeof payload.published_at === "string"
      ? payload.published_at
      : tagName;
  if (!tagName || !revision) {
    throw new Error("GitHub latest release metadata is incomplete");
  }
  const digest = typeof asset.digest === "string" ? asset.digest.trim() : "";
  const sha256 = /^sha256:[a-fA-F0-9]{64}$/.test(digest) ? digest.slice(7).toLowerCase() : null;
  const fileSizeBytes = typeof asset.size === "number" && Number.isSafeInteger(asset.size) && asset.size > 0
    ? BigInt(asset.size)
    : null;
  return {
    originUrl: asset.browser_download_url,
    fileName: assetName,
    fileSizeBytes,
    sha256,
    revision,
    versionLabel: tagName.replace(/^v/i, "")
  };
}

export async function resolveGithubLatestReleaseAsset(
  rawUrl: string,
  fetcher: PublicHttpFetcher = fetchPublicHttpUrl,
  nowMs = Date.now()
): Promise<GithubLatestReleaseAsset | null> {
  const target = parseGithubLatestDownloadUrl(rawUrl);
  if (!target) {
    return null;
  }
  const repoKey = [target.owner, target.repo].join("/").toLowerCase();
  const cached = latestReleaseCache.get(repoKey);
  let body = cached && cached.expiresAt > nowMs ? cached.body : null;
  if (!body) {
    let request = latestReleaseRequests.get(repoKey);
    if (!request) {
      request = fetchGithubLatestReleasePayload(target, fetcher);
      latestReleaseRequests.set(repoKey, request);
    }
    try {
      body = await request;
      latestReleaseCache.set(repoKey, {
        expiresAt: nowMs + GITHUB_LATEST_CACHE_TTL_MS,
        body
      });
    } catch (error) {
      if (!cached?.body) {
        throw error;
      }
      body = cached.body;
    } finally {
      latestReleaseRequests.delete(repoKey);
    }
  }
  return parseGithubLatestReleasePayload(body, target.assetName);
}

async function fetchGithubLatestReleasePayload(
  target: GithubLatestDownloadTarget,
  fetcher: PublicHttpFetcher
) {
  const apiUrl = "https://api.github.com/repos/"
    + encodeURIComponent(target.owner)
    + "/"
    + encodeURIComponent(target.repo)
    + "/releases/latest";
  const { response } = await fetcher(
    apiUrl,
    {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "ChordV-runtime-component-resolver"
      },
      signal: AbortSignal.timeout(5_000)
    },
    { errorPrefix: "GitHub latest release" }
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("GitHub latest release returned HTTP " + response.status);
  }
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > GITHUB_RELEASE_RESPONSE_LIMIT_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("GitHub latest release response is too large");
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > GITHUB_RELEASE_RESPONSE_LIMIT_BYTES) {
    throw new Error("GitHub latest release response is too large");
  }
  return body;
}

export function clearGithubLatestReleaseCacheForTest() {
  latestReleaseCache.clear();
  latestReleaseRequests.clear();
}
