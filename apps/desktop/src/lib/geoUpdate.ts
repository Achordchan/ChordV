import type { RuntimeComponentDownloadItem } from "./runtimeComponents";

export const GEO_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const GEO_LAST_CHECK_STORAGE_KEY = "chordv.geo.lastCheckAt";
export const GEO_INSTALLED_PLAN_REVISION_STORAGE_KEY = "chordv.geo.installedPlanRevision";
export const LEGACY_GEO_INSTALLED_TAG_STORAGE_KEY = "chordv.geo.installedReleaseTag";

export type RuntimeComponentLocalInfo = {
  kind: "xray" | "geoip" | "geosite";
  exists: boolean;
  path: string | null;
  sizeBytes: number | null;
  checksumSha256: string | null;
  versionLabel: string | null;
};

export function shouldCheckGeoUpdate(lastCheckAtMs: number | null, nowMs = Date.now()) {
  if (!lastCheckAtMs || !Number.isFinite(lastCheckAtMs) || lastCheckAtMs <= 0) {
    return true;
  }
  return nowMs - lastCheckAtMs >= GEO_CHECK_INTERVAL_MS;
}

export function readStoredGeoLastCheckAt(storage: Storage = localStorage) {
  const raw = storage.getItem(GEO_LAST_CHECK_STORAGE_KEY);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function writeStoredGeoLastCheckAt(valueMs: number, storage: Storage = localStorage) {
  storage.setItem(GEO_LAST_CHECK_STORAGE_KEY, String(valueMs));
}

export function clearStoredGeoLastCheckAt(storage: Storage = localStorage) {
  storage.removeItem(GEO_LAST_CHECK_STORAGE_KEY);
}

export function readStoredGeoPlanRevision(storage: Storage = localStorage) {
  return storage.getItem(GEO_INSTALLED_PLAN_REVISION_STORAGE_KEY);
}

export function readStoredGeoVersionLabel(storage: Storage = localStorage) {
  const planLabel = resolveStoredGeoPlanVersionLabel(readStoredGeoPlanRevision(storage));
  const legacyLabel = String(storage.getItem(LEGACY_GEO_INSTALLED_TAG_STORAGE_KEY) ?? "").trim();
  return planLabel ?? (legacyLabel || null);
}

export function writeStoredGeoPlanRevision(revision: string, storage: Storage = localStorage) {
  storage.setItem(GEO_INSTALLED_PLAN_REVISION_STORAGE_KEY, revision);
  storage.removeItem(LEGACY_GEO_INSTALLED_TAG_STORAGE_KEY);
}

export function clearStoredGeoPlanRevision(storage: Storage = localStorage) {
  storage.removeItem(GEO_INSTALLED_PLAN_REVISION_STORAGE_KEY);
  storage.removeItem(LEGACY_GEO_INSTALLED_TAG_STORAGE_KEY);
}

function resolveOriginUrl(item: RuntimeComponentDownloadItem) {
  return item.candidates.find((candidate) => candidate.source === "origin")?.url
    ?? item.selectedUrl
    ?? "";
}

function resolveReleaseTag(value: string) {
  const match = value.match(/\/releases\/download\/([^/?#|]+)/i);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export function resolveStoredGeoPlanVersionLabel(revision: string | null) {
  if (!revision) {
    return null;
  }
  const labels = [...revision.matchAll(/\/releases\/download\/([^/?#|]+)/gi)]
    .map((match) => decodeURIComponent(match[1]))
    .filter(Boolean);
  return labels.length > 0 && labels.every((label) => label === labels[0]) ? labels[0] : null;
}

export function resolveGeoPlanVersionLabel(items: RuntimeComponentDownloadItem[]) {
  const labels = items
    .filter((item) => item.component === "geoip" || item.component === "geosite")
    .map((item) => resolveReleaseTag(resolveOriginUrl(item)));
  return labels.length === 2 && labels.every((label) => label && label === labels[0]) ? labels[0] : null;
}

export function buildGeoPlanRevision(items: RuntimeComponentDownloadItem[]) {
  const geoItems = items
    .filter((item) => item.component === "geoip" || item.component === "geosite")
    .sort((left, right) => left.component.localeCompare(right.component));
  if (geoItems.length !== 2 || geoItems[0].component === geoItems[1].component) {
    return null;
  }
  return geoItems.map((item) => [
    item.component,
    item.id,
    item.revision ?? "",
    item.fileName,
    item.fileSizeBytes ?? "",
    item.checksumSha256 ?? "",
    item.archiveEntryName ?? "",
    resolveOriginUrl(item)
  ].join("|")).join("||");
}

export function isGeoPlanCurrent(
  localInfos: { geoip: RuntimeComponentLocalInfo | null; geosite: RuntimeComponentLocalInfo | null },
  items: RuntimeComponentDownloadItem[],
  installedRevision: string | null
) {
  const remoteRevision = buildGeoPlanRevision(items);
  return Boolean(
    remoteRevision
    && installedRevision === remoteRevision
    && localInfos.geoip?.exists
    && (localInfos.geoip.sizeBytes ?? 0) > 0
    && localInfos.geosite?.exists
    && (localInfos.geosite.sizeBytes ?? 0) > 0
  );
}