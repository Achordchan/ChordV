import { AsyncLocalStorage } from "node:async_hooks";
import type { SiteAddressConfigDto } from "@chordv/shared";

// Request-local snapshots keep synchronous URL serializers consistent without
// changing process.env or leaking one request's configuration into another.
export const siteAddressContext = new AsyncLocalStorage<SiteAddressConfigDto>();
export function publicSiteOrigin(): string {
  return siteAddressContext.getStore()?.primaryOrigin
    ?? (process.env.CHORDV_PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, "");
}
