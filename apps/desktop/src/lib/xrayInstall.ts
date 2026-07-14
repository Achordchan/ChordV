import type { RuntimeComponentDownloadItem } from "./runtimeComponents";

export const XRAY_INSTALLED_IDENTITY_STORAGE_KEY = "chordv.xray.installedIdentity";

export type XrayInstalledIdentity = {
  componentId: string | null;
  versionLabel: string | null;
  fileName: string | null;
  originUrl: string | null;
  contentKey: string | null;
  /** Actual installed binary size on disk after extract, not remote archive size. */
  installedSizeBytes: number | null;
  installedAt: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function basenamePath(path: string | null | undefined, fallback = "xray") {
  const raw = String(path ?? "").trim();
  if (!raw) return fallback;
  const parts = raw.split(/[/\\]+/).filter(Boolean);
  return parts[parts.length - 1] || fallback;
}

export function resolveXrayVersionLabel(
  item: { fileName?: string | null; checksumSha256?: string | null } | null | undefined
) {
  if (!item) return null;
  const fileName = basenamePath(item.fileName, "");
  if (!fileName) return null;
  const match = fileName.match(/(\d+\.\d+\.\d+(?:[-_][\w.]+)?)/);
  if (match?.[1]) return match[1];
  // Generic names like xray/xray.exe are not version labels.
  if (/^xray(?:\.exe)?$/i.test(fileName)) return null;
  return fileName;
}

export function resolveXrayOriginUrl(item: RuntimeComponentDownloadItem | null | undefined) {
  if (!item) return null;
  // Content identity must track the origin artifact, never the currently selected mirror URL.
  const originCandidate = item.candidates.find((candidate) => candidate.source === "origin")?.url ?? null;
  const normalizedOrigin = String(originCandidate ?? "").trim();
  if (normalizedOrigin) return normalizedOrigin;
  // Fallback only when the plan has no explicit origin candidate.
  const fallback = String(item.selectedUrl ?? item.candidates[0]?.url ?? "").trim();
  return fallback || null;
}

/** Content identity for a plan item. componentId alone is only a slot id, not content. */
export function buildXrayContentKey(item: RuntimeComponentDownloadItem | null | undefined) {
  if (!item) return null;
  const parts = [
    String(item.id ?? "").trim(),
    String(item.fileName ?? "").trim(),
    resolveXrayVersionLabel(item) ?? "",
    resolveXrayOriginUrl(item) ?? "",
    String(item.archiveEntryName ?? "").trim()
  ];
  if (!parts[0] && !parts[1] && !parts[3]) {
    return null;
  }
  return parts.join("|");
}

export function readStoredXrayInstalledIdentity(storage: Storage = localStorage): XrayInstalledIdentity | null {
  const raw = storage.getItem(XRAY_INSTALLED_IDENTITY_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const componentId = typeof parsed.componentId === "string" ? parsed.componentId : null;
    const versionLabel = typeof parsed.versionLabel === "string" ? parsed.versionLabel : null;
    const fileName = typeof parsed.fileName === "string" ? parsed.fileName : null;
    const originUrl = typeof parsed.originUrl === "string" ? parsed.originUrl : null;
    const contentKey = typeof parsed.contentKey === "string" ? parsed.contentKey : null;
    const installedSizeBytesRaw = parsed.installedSizeBytes ?? parsed.fileSizeBytes;
    const installedSizeBytes =
      typeof installedSizeBytesRaw === "number"
      && Number.isFinite(installedSizeBytesRaw)
      && installedSizeBytesRaw > 0
        ? installedSizeBytesRaw
        : null;
    const installedAt =
      typeof parsed.installedAt === "number" && Number.isFinite(parsed.installedAt) && parsed.installedAt > 0
        ? parsed.installedAt
        : Date.now();
    if (!componentId && !versionLabel && !fileName && !originUrl && !contentKey && !installedSizeBytes) {
      return null;
    }
    return {
      componentId,
      versionLabel,
      fileName,
      originUrl,
      contentKey,
      installedSizeBytes,
      installedAt
    };
  } catch {
    return null;
  }
}

export function writeStoredXrayInstalledIdentity(
  identity: Omit<XrayInstalledIdentity, "installedAt"> & { installedAt?: number },
  storage: Storage = localStorage
) {
  const payload: XrayInstalledIdentity = {
    componentId: identity.componentId ?? null,
    versionLabel: identity.versionLabel ?? null,
    fileName: identity.fileName ?? null,
    originUrl: identity.originUrl ?? null,
    contentKey: identity.contentKey ?? null,
    installedSizeBytes:
      typeof identity.installedSizeBytes === "number"
      && Number.isFinite(identity.installedSizeBytes)
      && identity.installedSizeBytes > 0
        ? identity.installedSizeBytes
        : null,
    installedAt: identity.installedAt ?? Date.now()
  };
  storage.setItem(XRAY_INSTALLED_IDENTITY_STORAGE_KEY, JSON.stringify(payload));
}

export function clearStoredXrayInstalledIdentity(storage: Storage = localStorage) {
  storage.removeItem(XRAY_INSTALLED_IDENTITY_STORAGE_KEY);
}

export function buildXrayInstalledIdentityFromPlan(
  item: RuntimeComponentDownloadItem,
  installedSizeBytes?: number | null
): XrayInstalledIdentity {
  return {
    componentId: item.id ?? null,
    versionLabel: resolveXrayVersionLabel(item),
    fileName: item.fileName ?? null,
    originUrl: resolveXrayOriginUrl(item),
    contentKey: buildXrayContentKey(item),
    installedSizeBytes:
      typeof installedSizeBytes === "number" && Number.isFinite(installedSizeBytes) && installedSizeBytes > 0
        ? installedSizeBytes
        : null,
    installedAt: Date.now()
  };
}

/**
 * Compare local installed identity against the remote plan.
 * componentId alone is never enough, because the server reuses the same row id for in-place updates.
 */
export function isXrayIdentityCurrent(
  localIdentity: XrayInstalledIdentity | null | undefined,
  remote: RuntimeComponentDownloadItem | null | undefined,
  localSizeBytes?: number | null
) {
  if (!localIdentity || !remote) {
    return false;
  }

  // Installed size is part of identity: missing sizes are treated conservatively as not current.
  if (
    typeof localIdentity.installedSizeBytes !== "number"
    || !Number.isFinite(localIdentity.installedSizeBytes)
    || localIdentity.installedSizeBytes <= 0
    || typeof localSizeBytes !== "number"
    || !Number.isFinite(localSizeBytes)
    || localSizeBytes <= 0
    || localIdentity.installedSizeBytes !== localSizeBytes
  ) {
    return false;
  }

  const remoteKey = buildXrayContentKey(remote);
  if (localIdentity.contentKey && remoteKey) {
    return localIdentity.contentKey === remoteKey;
  }

  // Legacy records without contentKey: require multi-field match, never id-only.
  if (localIdentity.componentId && remote.id && localIdentity.componentId !== remote.id) {
    return false;
  }

  const remoteLabel = resolveXrayVersionLabel(remote);
  if (localIdentity.versionLabel || remoteLabel) {
    if (!localIdentity.versionLabel || !remoteLabel || localIdentity.versionLabel !== remoteLabel) {
      return false;
    }
  }

  if (localIdentity.fileName && remote.fileName && localIdentity.fileName !== remote.fileName) {
    return false;
  }

  const remoteOrigin = resolveXrayOriginUrl(remote);
  if (localIdentity.originUrl || remoteOrigin) {
    if (!localIdentity.originUrl || !remoteOrigin || localIdentity.originUrl !== remoteOrigin) {
      return false;
    }
  }

  // Without a content key / version / origin signal, refuse to claim "current".
  return Boolean(
    (localIdentity.versionLabel && remoteLabel && localIdentity.versionLabel === remoteLabel)
    || (localIdentity.originUrl && remoteOrigin && localIdentity.originUrl === remoteOrigin)
  );
}
