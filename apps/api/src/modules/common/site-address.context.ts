import { AsyncLocalStorage } from "node:async_hooks";
import type { SiteAddressConfigDto } from "@chordv/shared";

// Request-local snapshots keep synchronous URL serializers consistent without
// changing process.env or leaking one request's configuration into another.
export const siteAddressContext = new AsyncLocalStorage<SiteAddressConfigDto>();
export function publicSiteOrigin(): string {
  return siteAddressContext.getStore()?.primaryOrigin
    ?? (process.env.CHORDV_PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, "");
}

/**
 * Origin used for public file downloads (installers, runtime components).
 *
 * CHORDV_PUBLIC_DOWNLOAD_BASE_URL lets downloads go through a separate, CDN-cached
 * host (e.g. a Cloudflare-proxied dl.<domain>) while the admin panel, client API
 * and agents keep talking to the primary origin directly. Unset or invalid values
 * fall back to the primary site origin, so existing deployments are unchanged.
 */
export function publicDownloadOrigin(): string {
  const raw = (process.env.CHORDV_PUBLIC_DOWNLOAD_BASE_URL ?? "").trim();
  return parseBareHttpOrigin(raw) ?? publicSiteOrigin();
}

function parseBareHttpOrigin(raw: string): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return url.origin;
}

/**
 * Appends a content-version query so a CDN never serves stale bytes after a file
 * is replaced under the same id (the cache key includes the query string).
 */
export function withContentVersion(url: string, fileHash: string | null | undefined): string {
  const hash = (fileHash ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{16,}$/.test(hash)) {
    return url;
  }
  return `${url}${url.includes("?") ? "&" : "?"}v=${hash.slice(0, 16)}`;
}
