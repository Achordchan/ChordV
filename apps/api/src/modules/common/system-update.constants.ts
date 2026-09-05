import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

/**
 * Runtime layout for the in-place backend self-update.
 *
 * Production (Docker) lays the app out as versioned release directories behind a
 * single symlink, supervised by an entrypoint script:
 *
 *   /app/releases/<version>/   one self-contained build (dist + node_modules + prisma)
 *   /app/current -> releases/<version>
 *   /app/state/                private supervisor <-> app coordination markers
 *   /app/public-state/         health-approved last-good-version only (admin read-only)
 *   /app/backups/              database snapshots (API-only persistent volume)
 *
 * The app never flips the symlink itself: it stages a new version and writes a
 * `pending` marker, then exits. The entrypoint promotes + health-gates + rolls
 * back, the same role systemd plays for sub2api.
 */

export const SYSTEM_UPDATE_PENDING_FILE = "pending.json";
// The supervisor writes one result file per operation ("operation-result.<op>.json")
// so a later operation never clobbers an earlier one the app has not consumed yet.
// The legacy single "operation-result.json" is still drained for forward-compat with
// an older supervisor image. The app matches both via SYSTEM_UPDATE_RESULT_PREFIX.
export const SYSTEM_UPDATE_RESULT_FILE = "operation-result.json";
export const SYSTEM_UPDATE_RESULT_PREFIX = "operation-result";
// Written by the supervisor while a promotion is being health-gated/stabilized;
// present == "a promotion is in flight" even across the process restart (when the
// advisory lock cannot be held). Cleared once stabilization succeeds or rolls back.
export const SYSTEM_UPDATE_PROMOTING_FILE = "promoting.json";
export const SYSTEM_UPDATE_DESIRED_VERSION_FILE = "desired-version";
export const SYSTEM_UPDATE_LAST_GOOD_VERSION_FILE = "last-good-version";
// Anti-replay/anti-downgrade ratchet for the SIGNED update feed: the highest signed
// manifest version ever accepted. A signature proves authenticity but not freshness,
// so a third-party mirror could replay an older, correctly-signed manifest to hide a
// newer release. We reject any signed manifest advertising a version below this floor.
export const SYSTEM_UPDATE_MANIFEST_FLOOR_FILE = "manifest-floor-version";

export type SystemUpdateRuntimeConfig = {
  currentVersion: string;
  enabled: boolean;
  releasesDir: string | null;
  stateDir: string | null;
  backupDir: string | null;
  manifestUrl: string | null;
  snapshotKeep: number;
  snapshotBeforeMigrate: boolean;
  healthTimeoutSeconds: number;
  cacheTtlMs: number;
  githubReleaseBaseUrl: string | null;
  manifestPublicKey: string | null;
};

function readEnv(name: string): string | null {
  const value = process.env[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const value = readEnv(name);
  if (value === null) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function readSnapshotEnabled(): boolean {
  const value = readEnv("CHORDV_SYSTEM_UPDATE_SNAPSHOT")?.toLowerCase();
  if (value == null || ["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error("CHORDV_SYSTEM_UPDATE_SNAPSHOT 必须为 true/false、1/0、yes/no 或 on/off。");
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const value = Number.parseInt(readEnv(name) ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function locateRepoSystemVersionFile(): string | null {
  // Walk up from the compiled file location to find a repo-root SYSTEM_VERSION
  // (used in local dev where no Docker release layout exists).
  let dir = __dirname;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(dir, "SYSTEM_VERSION");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function resolveCurrentVersion(releasesDir: string | null): string {
  const fromEnv = readEnv("CHORDV_SYSTEM_VERSION");
  if (fromEnv) return fromEnv.replace(/^v(?=\d)/i, "");

  const currentLink = readEnv("CHORDV_SYSTEM_CURRENT_LINK");
  const candidates = [
    currentLink ? path.join(currentLink, "SYSTEM_VERSION") : null,
    locateRepoSystemVersionFile()
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        const raw = readFileSync(candidate, "utf8").trim();
        if (raw) return raw.replace(/^v(?=\d)/i, "");
      }
    } catch {
      // ignore and fall through
    }
  }
  return "0.0.0";
}

export function resolveSystemUpdateRuntimeConfig(): SystemUpdateRuntimeConfig {
  const releasesDir = readEnv("CHORDV_SYSTEM_RELEASES_DIR");
  const stateDir = readEnv("CHORDV_SYSTEM_STATE_DIR");
  const enabled = readBooleanEnv("CHORDV_SYSTEM_UPDATE_ENABLED", Boolean(releasesDir && stateDir));
  return {
    currentVersion: resolveCurrentVersion(releasesDir),
    enabled,
    releasesDir,
    stateDir,
    backupDir: readEnv("CHORDV_SYSTEM_UPDATE_BACKUP_DIR") ?? "/app/backups",
    manifestUrl: readEnv("CHORDV_SYSTEM_UPDATE_MANIFEST_URL"),
    snapshotKeep: readPositiveIntEnv("CHORDV_SYSTEM_UPDATE_SNAPSHOT_KEEP", 5),
    snapshotBeforeMigrate: readSnapshotEnabled(),
    healthTimeoutSeconds: readPositiveIntEnv("CHORDV_SYSTEM_UPDATE_HEALTH_TIMEOUT_SECONDS", 90),
    cacheTtlMs: readPositiveIntEnv("CHORDV_SYSTEM_UPDATE_CACHE_TTL_MS", 10 * 60 * 1000),
    githubReleaseBaseUrl: readEnv("CHORDV_SYSTEM_UPDATE_GITHUB_RELEASE_BASE_URL"),
    // Base64 DER (SPKI) ed25519 public key. When set, the update manifest may be
    // fetched via the accelerate mirror but its detached signature is verified
    // against this key; when unset, the manifest is fetched direct-only.
    manifestPublicKey: readEnv("CHORDV_SYSTEM_UPDATE_MANIFEST_PUBLIC_KEY")
  };
}
