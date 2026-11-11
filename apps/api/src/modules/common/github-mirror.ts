/**
 * 公开 GitHub Release 文件经公共加速镜像分发给客户端。GEO 与客户端安装包共用这套规则：
 * 只下发固定标签的地址，客户端测速选最快的，下载后必须和后台比对过的哈希（安装包还有签名）一致。
 */

/** 后台“全局下载镜像”留空时使用的公共 GitHub 加速镜像。 */
export const DEFAULT_GITHUB_MIRROR_PREFIXES = [
  "https://ghfast.top/",
  "https://gh-proxy.com/",
  "https://hk.gh-proxy.com/",
  "https://edgeone.gh-proxy.com/",
  "https://ghproxy.net/"
].join("\n");

/** 只有固定到某个 Release 标签的 GitHub 文件地址才能交给公共加速镜像，latest 会被镜像缓存成旧版。 */
export function pinnedGithubReleaseAssetUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.search || url.hash) return null;
    return /^\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+$/.test(url.pathname) ? url.href : null;
  } catch {
    return null;
  }
}

function isHttpUrl(value: string) {
  return /^https?:\/\//i.test(value.trim());
}

function splitMirrorPrefixes(value: string | null | undefined) {
  return String(value ?? "")
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function applyMirrorPrefix(originUrl: string, mirrorPrefix: string) {
  const prefix = mirrorPrefix.trim();
  if (prefix.includes("{url}")) return prefix.replaceAll("{url}", originUrl);
  return prefix.endsWith("/") ? `${prefix}${originUrl}` : `${prefix}/${originUrl}`;
}

/** 各加速镜像在前，GitHub 直连最后；不含服务器副本。 */
export function githubMirrorDownloadUrls(githubAssetUrl: string, mirrorPrefixes: string | null | undefined) {
  const urls: string[] = [];
  const push = (url: string) => {
    const normalized = url.trim();
    if (normalized && isHttpUrl(normalized) && !urls.includes(normalized)) urls.push(normalized);
  };
  for (const prefix of splitMirrorPrefixes(mirrorPrefixes ?? DEFAULT_GITHUB_MIRROR_PREFIXES)) {
    push(applyMirrorPrefix(githubAssetUrl, prefix));
  }
  push(githubAssetUrl);
  return urls;
}

/**
 * 顺序：各加速镜像 → GitHub 直连 → 服务器副本。服务器副本必须保持唯一的 origin 且放在最后：
 * 旧客户端按 origin 地址判断 GEO 是否换版，改掉它会让所有人重下一遍；它也是镜像全挂时的兜底。
 */
export function buildGithubMirroredCandidates(input: { githubAssetUrl: string; serverCopyUrl: string; mirrorPrefixes: string | null }) {
  const candidates: Array<{ label: "client_mirror" | "default_mirror" | "origin"; url: string }> = [];
  for (const url of githubMirrorDownloadUrls(input.githubAssetUrl, input.mirrorPrefixes)) {
    if (url !== input.serverCopyUrl.trim()) candidates.push({ label: "default_mirror", url });
  }
  if (isHttpUrl(input.serverCopyUrl)) candidates.push({ label: "origin", url: input.serverCopyUrl.trim() });
  return candidates;
}
