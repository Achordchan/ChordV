import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException
} from "@nestjs/common";
import { spawn } from "node:child_process";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Client as PgClient } from "pg";
import type {
  SystemUpdateCheckDto,
  SystemUpdateOperationDto,
  SystemUpdateOperationKind,
  SystemUpdateReleaseInfoDto,
  SystemUpdateRollbackVersionDto,
  SystemUpdateStartResultDto
} from "@chordv/shared";
import { PrismaService } from "./prisma.service";
import { DownloadMirrorService } from "./download-mirror.service";
import {
  buildExternalReleaseArtifactProbeUrl,
  compareSemver,
  createId,
  downloadExternalReleaseArtifactFile,
  normalizeVersion
} from "./release-center.utils";
import { fetchPublicHttpUrl } from "./remote-url.utils";
import {
  resolveSystemUpdateRuntimeConfig,
  SYSTEM_UPDATE_DESIRED_VERSION_FILE,
  SYSTEM_UPDATE_LAST_GOOD_VERSION_FILE,
  SYSTEM_UPDATE_MANIFEST_FLOOR_FILE,
  SYSTEM_UPDATE_PENDING_FILE,
  SYSTEM_UPDATE_PROMOTING_FILE,
  SYSTEM_UPDATE_RESULT_PREFIX,
  type SystemUpdateRuntimeConfig
} from "./system-update.constants";

const SYSTEM_UPDATE_LOCK_KEY_1 = 420_800;
const SYSTEM_UPDATE_LOCK_KEY_2 = 1;
const EXIT_FLUSH_DELAY_MS = 600;
const MANIFEST_FETCH_TIMEOUT_MS = 15_000;
const MAX_MANIFEST_BYTES = 256 * 1024;

type RawManifest = {
  version?: unknown;
  tag?: unknown;
  publishedAt?: unknown;
  changelog?: unknown;
  notes?: unknown;
  htmlUrl?: unknown;
  minSystemVersion?: unknown;
  artifact?: {
    url?: unknown;
    sha256?: unknown;
    sizeBytes?: unknown;
  };
};

type NormalizedRelease = SystemUpdateReleaseInfoDto & { downloadUrl: string; sha256: string };

type SystemUpdateCacheEntry = {
  checkedAt: number;
  release: NormalizedRelease | null;
  warning: string | null;
};

type OperationLock = {
  assertHeld: () => Promise<void>;
  release: () => Promise<void>;
};

/**
 * Verify a detached ed25519 signature over the exact manifest bytes.
 * @param manifestBytes raw bytes of the manifest as served
 * @param signatureBase64 base64 of the detached signature (manifest.json.sig)
 * @param publicKeyBase64 base64 of the DER (SPKI) ed25519 public key (pinned in config)
 * Returns false on any malformed input rather than throwing, so a bad key/sig is
 * treated as "not verified" (fail closed) at the call site.
 */
export function verifyManifestSignature(
  manifestBytes: Buffer,
  signatureBase64: string,
  publicKeyBase64: string
): boolean {
  try {
    const der = Buffer.from(publicKeyBase64.trim(), "base64");
    const publicKey = createPublicKey({ key: der, format: "der", type: "spki" });
    const signature = Buffer.from(signatureBase64.trim(), "base64");
    if (signature.length === 0) return false;
    return cryptoVerify(null, manifestBytes, publicKey, signature);
  } catch {
    return false;
  }
}

@Injectable()
export class SystemUpdateService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SystemUpdateService.name);
  private config: SystemUpdateRuntimeConfig = resolveSystemUpdateRuntimeConfig();
  private cache: SystemUpdateCacheEntry | null = null;
  // pids of long-running detached child process GROUPS (migrate/snapshot). Tracked
  // so a graceful shutdown mid-migration terminates the whole tree instead of
  // leaving it changing the DB after the app has gone (see onModuleDestroy).
  private readonly activeChildGroups = new Set<number>();
  // Monotonic suffix so concurrent durable writes never collide on a shared tmp path.
  private tmpSeq = 0;
  // Serializes the signed manifest-floor compare-and-write so concurrent update checks
  // cannot interleave and move the anti-replay floor backward (it must only advance).
  private manifestFloorLock: Promise<unknown> = Promise.resolve();
  // The supported deployment has one API process under one supervisor. Keep that
  // process fenced until cancelled staging has unwound, even if PostgreSQL already
  // dropped its advisory lock. This is not a multi-replica filesystem fencing token.
  private operationInFlight = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly downloadMirrorService: DownloadMirrorService
  ) {}

  async onModuleInit() {
    // Reconcile any operation that was in-flight across a restart. The
    // supervisor entrypoint drops an operation-result marker after promoting or
    // rolling back a staged version; anything left "running" without one was
    // interrupted.
    try {
      await this.reconcileOperationsOnBoot();
    } catch (error) {
      this.logger.warn(`System update boot reconciliation failed: ${this.describeError(error)}`);
    }
  }

  onModuleDestroy() {
    // Graceful shutdown (docker stop → SIGTERM, enableShutdownHooks is on): kill any
    // still-running detached migration/snapshot process group so it does not keep
    // mutating the database after the app has exited and the supervisor moves on.
    for (const pid of this.activeChildGroups) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    this.activeChildGroups.clear();
  }

  getCurrentVersion(): string {
    return this.config.currentVersion;
  }

  getRuntimeStatus() {
    return {
      currentVersion: this.config.currentVersion,
      enabled: this.config.enabled,
      manifestConfigured: Boolean(this.config.manifestUrl)
    };
  }

  /**
   * Promotion readiness gate. Proves not just DB connectivity but that the schema
   * the RUNNING release expects is actually present — a release that boots HTTP but
   * is missing a migration (new table/column) must fail this so the supervisor rolls
   * it back instead of marking it last-good. Throws a GENERIC error (details only in
   * logs) since this endpoint is unauthenticated and must not leak internal specifics.
   */
  async assertReady(): Promise<void> {
    try {
      await this.prisma.$queryRawUnsafe("SELECT 1");
    } catch (error) {
      this.logger.warn(`Readiness: database connectivity failed: ${this.describeError(error)}`);
      throw new ServiceUnavailableException("service not ready");
    }
    // Schema compatibility: every migration bundled with the running release must be
    // applied. The app runs with cwd = the release dir, so its own migrations live
    // under cwd/apps/api/prisma/migrations (same relative path in local dev).
    let pending: string[];
    try {
      pending = await this.detectPendingMigrations(process.cwd());
    } catch (error) {
      this.logger.warn(`Readiness: schema check failed: ${this.describeError(error)}`);
      throw new ServiceUnavailableException("service not ready");
    }
    if (pending.length > 0) {
      this.logger.warn(`Readiness: ${pending.length} unapplied migration(s): ${pending.join(", ")}`);
      throw new ServiceUnavailableException("service not ready");
    }
  }

  async checkUpdate(force: boolean): Promise<SystemUpdateCheckDto> {
    const now = Date.now();
    if (!force && this.cache && now - this.cache.checkedAt < this.config.cacheTtlMs) {
      return this.toCheckDto(this.cache, true);
    }

    if (!this.config.manifestUrl) {
      const entry: SystemUpdateCacheEntry = {
        checkedAt: now,
        release: null,
        warning: "未配置系统更新清单地址（CHORDV_SYSTEM_UPDATE_MANIFEST_URL）。"
      };
      this.cache = entry;
      return this.toCheckDto(entry, false);
    }

    try {
      const release = await this.fetchManifestRelease(this.config.manifestUrl);
      const entry: SystemUpdateCacheEntry = { checkedAt: now, release, warning: null };
      this.cache = entry;
      return this.toCheckDto(entry, false);
    } catch (error) {
      const warning = `检查更新失败：${this.describeError(error)}`;
      if (this.cache) {
        const stale: SystemUpdateCacheEntry = { ...this.cache, warning };
        return this.toCheckDto(stale, true);
      }
      const entry: SystemUpdateCacheEntry = { checkedAt: now, release: null, warning };
      this.cache = entry;
      return this.toCheckDto(entry, false);
    }
  }

  async listRollbackVersions(): Promise<SystemUpdateRollbackVersionDto[]> {
    if (!this.config.releasesDir) return [];
    let entries: string[];
    try {
      entries = await fs.readdir(this.config.releasesDir);
    } catch {
      return [];
    }
    const current = this.config.currentVersion;
    const versions: SystemUpdateRollbackVersionDto[] = [];
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const dir = path.join(this.config.releasesDir, name);
      let installedAt: string | null = null;
      try {
        const stat = await fs.stat(dir);
        if (!stat.isDirectory()) continue;
        installedAt = stat.mtime.toISOString();
      } catch {
        continue;
      }
      versions.push({ version: name, installedAt, isCurrent: name === current });
    }
    return versions.sort((left, right) => {
      try {
        return compareSemver(right.version, left.version);
      } catch {
        return right.version.localeCompare(left.version);
      }
    });
  }

  async listOperations(limit = 20): Promise<SystemUpdateOperationDto[]> {
    // Pick up a just-completed supervisor outcome so the audit list reflects it
    // even on an app instance that stayed up through the whole promotion.
    await this.consumeResultMarker().catch(() => undefined);
    const take = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 100) : 20;
    const rows = await this.prisma.systemUpdateOperation.findMany({
      orderBy: { startedAt: "desc" },
      take
    });
    return rows.map((row) => this.toOperationDto(row));
  }

  async getOperation(operationId: string): Promise<SystemUpdateOperationDto | null> {
    // The UI polls this during an update; consuming the marker here finalizes the
    // operation the moment the supervisor reports stabilization done/rolled-back.
    await this.consumeResultMarker().catch(() => undefined);
    const row = await this.prisma.systemUpdateOperation.findUnique({ where: { operationId } });
    return row ? this.toOperationDto(row) : null;
  }

  async startUpdate(
    actorLabel: string | null,
    actorUserId: string | null,
    expectedVersion?: string | null
  ): Promise<SystemUpdateStartResultDto> {
    this.assertOperational();
    await this.assertNoPromotionInFlight();
    const fromVersion = this.config.currentVersion;
    // Bind the operation to the version the admin actually reviewed/confirmed. A forced
    // re-fetch inside the background task could otherwise pick up a NEWER release
    // published between the UI check and the confirm, silently installing unreviewed
    // changes. Normalized so "v1.2.0" and "1.2.0" compare equal.
    const expected = expectedVersion && expectedVersion.trim() ? normalizeVersion(expectedVersion) : null;
    // Validation must finish before acquiring the dedicated advisory-lock connection.
    const operationId = createId("sysop");
    const lock = await this.acquireLock();
    await this.createOperationGuarded(lock, { operationId, kind: "update", actorLabel, actorUserId, fromVersion, toVersion: expected });
    void this.runUpdateInBackground(operationId, fromVersion, lock, expected);
    return { operationId, accepted: true, message: "更新任务已开始，服务将在完成后自动重启。" };
  }

  async startRollback(
    actorLabel: string | null,
    actorUserId: string | null,
    targetVersion?: string | null
  ): Promise<SystemUpdateStartResultDto> {
    this.assertOperational();
    await this.assertNoPromotionInFlight();
    const fromVersion = this.config.currentVersion;
    const target = await this.resolveRollbackTarget(targetVersion, fromVersion);
    const operationId = createId("sysop");
    const lock = await this.acquireLock();
    await this.createOperationGuarded(lock, {
      operationId,
      kind: "rollback",
      actorLabel,
      actorUserId,
      fromVersion,
      toVersion: target
    });
    void this.runRollbackInBackground(operationId, fromVersion, target, lock);
    return { operationId, accepted: true, message: `正在回滚到 v${target}，服务将自动重启。` };
  }

  async startRestart(actorLabel: string | null, actorUserId: string | null): Promise<SystemUpdateStartResultDto> {
    this.assertOperational();
    await this.assertNoPromotionInFlight();
    const operationId = createId("sysop");
    const lock = await this.acquireLock();
    const fromVersion = this.config.currentVersion;
    await this.createOperationGuarded(lock, {
      operationId,
      kind: "restart",
      actorLabel,
      actorUserId,
      fromVersion,
      toVersion: fromVersion
    });
    // Route restart through the SAME durable, health-gated marker path as a
    // promotion (kind=restart, same version): the supervisor promotes the current
    // version, health-gates + stabilizes it, and writes a success/failure result
    // marker. Otherwise a restart that opens the port then crashes would still be
    // audited as succeeded, and one that never boots would stay running forever.
    try {
      await lock.assertHeld();
      await this.writePendingMarker({ version: fromVersion, operationId, kind: "restart", migrationApplied: false });
    } catch (error) {
      await this.finishOperation(operationId, "failed", { failureReason: this.describeError(error) }).catch(
        () => undefined
      );
      await lock.release().catch(() => undefined);
      throw new ServiceUnavailableException(`无法写入重启标记：${this.describeError(error)}`);
    }
    // Lock stays held until process exit (see scheduleProcessExit) so no second
    // operation can slip in during the exit-flush window.
    this.scheduleProcessExit(`restart requested (operation ${operationId})`, lock, operationId);
    return { operationId, accepted: true, message: "服务正在重启。" };
  }

  private async runUpdateInBackground(
    operationId: string,
    fromVersion: string,
    lock: OperationLock,
    expectedVersion?: string | null
  ) {
    try {
      const check = await this.checkUpdate(true);
      await lock.assertHeld();
      // Only act on a manifest we just re-fetched cleanly. A forced refresh that
      // fell back to a stale cache (warning set / cached=true) could otherwise let
      // an admin install a package that was already withdrawn upstream.
      if (check.warning || check.cached) {
        await this.finishOperation(operationId, "failed", {
          failureReason: `无法确认最新版本（清单刷新失败）：${check.warning ?? "已回退到过期缓存"}。已取消更新。`
        });
        await lock.release().catch(() => undefined);
        return;
      }
      // Use this check's release, not mutable shared cache state from another check.
      const release = check.release;
      // Validate the confirmed target even if the refreshed feed was withdrawn or
      // moved back to the current/older version: that is not a successful update.
      if (expectedVersion && release?.version !== expectedVersion) {
        await this.finishOperation(operationId, "failed", {
          failureReason: `确认的版本 v${expectedVersion} 与当前最新版本 ${release ? `v${release.version}` : "（无可用版本）"} 不一致。已取消更新，请重新检查并确认。`
        });
        await lock.release().catch(() => undefined);
        return;
      }
      if (!check.hasUpdate || !release) {
        await this.finishOperation(operationId, "succeeded", {
          toVersion: fromVersion,
          failureReason: null
        });
        await lock.release().catch(() => undefined);
        return;
      }
      await this.markRunning(operationId, release.version);

      if (!release.downloadUrl || !release.sha256) {
        throw new BadRequestException("更新清单缺少下载地址或 SHA-256，已取消更新。");
      }
      const releaseDir = await this.downloadAndExtractRelease({
        ...release, downloadUrl: release.downloadUrl, sha256: release.sha256
      }, lock);
      await lock.assertHeld();
      const pendingMigrations = await this.detectPendingMigrations(releaseDir);
      const willMigrate = pendingMigrations.length > 0;
      if (willMigrate) {
        this.logger.warn(
          `Update ${release.version} carries ${pendingMigrations.length} pending migration(s): ${pendingMigrations.join(", ")}`
        );
      }

      // Persist the promotion INTENT, then exit. The pre-migration SNAPSHOT and the
      // MIGRATION itself are performed by the supervisor AFTER this process has exited
      // (see entrypoint.sh: run_snapshot + run_migrate before launch). This is
      // deliberate on two counts:
      //   1. The current code must never serve requests against a schema that a
      //      migration is concurrently changing (a dropped/renamed column would break
      //      live requests for the whole migration). With migrate moved past our exit,
      //      the old code is fully stopped before any DDL runs.
      //   2. No DB-touching worker is left running in THIS process, so an abrupt kill
      //      (SIGKILL/OOM) cannot orphan a migration/snapshot that keeps mutating the
      //      DB while the supervisor promotes or rolls back. Both are supervisor-owned.
      // migrationApplied travels in the marker so a later rollback can still warn that
      // the schema was changed; the supervisor takes the snapshot only when it is set.
      await lock.assertHeld();
      await this.writePendingMarker({
        version: release.version,
        operationId,
        kind: "update",
        migrationApplied: willMigrate
      });

      // Best-effort bookkeeping AFTER the promotion intent is durable.
      await this.pruneOldReleases(release.version, fromVersion).catch((error) =>
        this.logger.warn(`Prune old releases failed (non-fatal): ${this.describeError(error)}`)
      );
      await this.updateOperation(operationId, { migrationApplied: willMigrate }).catch((error) =>
        this.logger.warn(`Audit update failed (non-fatal): ${this.describeError(error)}`)
      );

      // Keep the advisory lock until the process actually exits (see
      // scheduleProcessExit): the DB session closing on exit releases it, which
      // closes the window where a second request could grab the lock before the
      // supervisor writes promoting.json.
      this.scheduleProcessExit(`staged update ${fromVersion} -> ${release.version} (operation ${operationId})`, lock, operationId);
    } catch (error) {
      const reason = this.describeError(error);
      this.logger.error(`System update failed (operation ${operationId}): ${reason}`);
      await this.clearPendingMarker().catch(() => undefined);
      await this.finishOperation(operationId, "failed", { failureReason: reason }).catch(() => undefined);
      await lock.release().catch(() => undefined);
    }
  }

  private async runRollbackInBackground(
    operationId: string,
    fromVersion: string,
    target: string,
    lock: OperationLock
  ) {
    try {
      await lock.assertHeld();
      await this.markRunning(operationId, target);
      await lock.assertHeld();
      await this.writePendingMarker({ version: target, operationId, kind: "rollback" });
      // Lock stays held until process exit (see scheduleProcessExit).
      this.scheduleProcessExit(`staged rollback ${fromVersion} -> ${target} (operation ${operationId})`, lock, operationId);
    } catch (error) {
      const reason = this.describeError(error);
      this.logger.error(`System rollback failed (operation ${operationId}): ${reason}`);
      await this.clearPendingMarker().catch(() => undefined);
      await this.finishOperation(operationId, "failed", { failureReason: reason }).catch(() => undefined);
      await lock.release().catch(() => undefined);
    }
  }

  private async downloadAndExtractRelease(release: NormalizedRelease, lock: OperationLock): Promise<string> {
    const releasesDir = this.config.releasesDir;
    if (!releasesDir) {
      throw new ServiceUnavailableException("未配置发布目录（CHORDV_SYSTEM_RELEASES_DIR）。");
    }
    const mirror = await this.resolveMirrorPrefix();
    const downloaded = await downloadExternalReleaseArtifactFile(release.downloadUrl, mirror);
    try {
      await lock.assertHeld();
      if (downloaded.fileHash.toLowerCase() !== release.sha256.toLowerCase()) {
        throw new BadRequestException(
          `更新包 SHA-256 校验不匹配（期望 ${release.sha256}，实际 ${downloaded.fileHash}）。`
        );
      }
      const finalDir = path.join(releasesDir, release.version);
      const stagingDir = path.join(releasesDir, `.staging-${release.version}-${Date.now()}`);
      await this.removeDirSafe(stagingDir);
      await fs.mkdir(stagingDir, { recursive: true });
      try {
        await this.extractTarball(downloaded.absolutePath, stagingDir);
        await lock.assertHeld();
        await this.removeDirSafe(finalDir);
        await fs.rename(stagingDir, finalDir);
      } catch (error) {
        // A malformed archive / full disk / I/O error must not leave the timestamped
        // staging dir behind — otherwise every retry accretes partial dirs and
        // eventually fills the releases volume.
        await this.removeDirSafe(stagingDir);
        throw error;
      }
      return finalDir;
    } finally {
      await downloaded.cleanup().catch(() => undefined);
    }
  }

  private async detectPendingMigrations(releaseDir: string): Promise<string[]> {
    const migrationsDir = path.join(releaseDir, "apps/api/prisma/migrations");
    let names: string[];
    try {
      const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
      names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    } catch (error) {
      // A production release ALWAYS ships this directory. If it is missing or
      // unreadable, that is a packaging error — fail closed rather than fail open
      // ("no pending migrations"), which would skip the snapshot+migration and let
      // a release whose code expects a schema get promoted anyway.
      throw new ServiceUnavailableException(
        `无法读取发布内的迁移目录（${migrationsDir}），发布包可能不完整：${this.describeError(error)}`
      );
    }
    let applied = new Set<string>();
    try {
      const rows = (await this.prisma.$queryRawUnsafe(
        `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`
      )) as Array<{ migration_name: string }>;
      applied = new Set(rows.map((row) => String(row.migration_name)));
    } catch (error) {
      // If the migration table is unreadable we cannot safely reason about
      // pending migrations; treat everything as pending so the snapshot gate runs.
      this.logger.warn(`Unable to read _prisma_migrations: ${this.describeError(error)}`);
      return names;
    }
    return names.filter((name) => !applied.has(name));
  }


  private async extractTarball(archivePath: string, destDir: string): Promise<void> {
    await this.runShell(
      "tar",
      ["-xzf", archivePath, "-C", destDir],
      { ...process.env },
      "更新包解压",
      10 * 60 * 1000
    );
  }

  private runShell(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    label: string,
    timeoutMs: number,
    cwd?: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // detached:true puts the child in its OWN process group so we can signal the
      // WHOLE tree (prisma shim → engine, pg_dump | gzip) on timeout — killing only
      // the direct child would leave descendants mutating the DB after we gave up.
      const child = spawn(command, args, { env, cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      let timedOut = false;
      // Track this group so a shutdown mid-run (onModuleDestroy) can terminate it.
      if (typeof child.pid === "number") this.activeChildGroups.add(child.pid);
      const untrack = () => {
        if (typeof child.pid === "number") this.activeChildGroups.delete(child.pid);
      };
      const killGroup = (signal: NodeJS.Signals) => {
        if (typeof child.pid === "number") {
          try {
            process.kill(-child.pid, signal); // negative pid == the process group
          } catch {
            child.kill(signal); // fall back to the direct child
          }
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup("SIGKILL");
        // Reject only after the group has actually gone (close fires below), so the
        // caller does not race ahead while descendants are still being torn down.
      }, timeoutMs);
      timer.unref?.();
      child.stdout?.on("data", () => undefined);
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        untrack();
        reject(new ServiceUnavailableException(`${label}启动失败：${error.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        untrack();
        if (timedOut) {
          reject(new ServiceUnavailableException(`${label}超时（${timeoutMs}ms），已终止整个进程组。`));
        } else if (code === 0) {
          resolve();
        } else {
          reject(new ServiceUnavailableException(`${label}失败（退出码 ${code}）：${stderr.trim().slice(-500)}`));
        }
      });
    });
  }

  private async resolveRollbackTarget(targetVersion: string | null | undefined, currentVersion: string): Promise<string> {
    const available = await this.listRollbackVersions();
    if (available.length === 0) {
      throw new BadRequestException("没有可回滚的历史版本。");
    }
    if (targetVersion && targetVersion.trim()) {
      const normalized = normalizeVersion(targetVersion);
      const match = available.find((item) => item.version === normalized);
      if (!match) {
        throw new BadRequestException(`版本 v${normalized} 不在可回滚列表中。`);
      }
      if (normalized === currentVersion) {
        throw new BadRequestException("目标版本与当前运行版本相同。");
      }
      return normalized;
    }
    // No explicit target: a rollback must go to an OLDER release. The list is sorted
    // descending, so the first entry strictly below the current version is the newest
    // release beneath it. Never default to a higher retained version — that is the one
    // we most likely just rolled FORWARD from, so "rolling back" to it would re-apply
    // the release the operator is trying to escape. A non-semver dir name can't be
    // proven older, so it is excluded from the implicit default (still selectable by
    // explicit version).
    const older = available.filter((item) => {
      if (item.isCurrent) return false;
      try {
        return compareSemver(item.version, currentVersion) < 0;
      } catch {
        return false;
      }
    });
    if (older.length === 0) {
      throw new BadRequestException("没有比当前版本更旧的可回滚版本，请指定明确的目标版本。");
    }
    return older[0].version;
  }

  private async fetchManifestRelease(manifestUrl: string): Promise<NormalizedRelease> {
    // The manifest carries the SHA-256 that is the ENTIRE trust anchor for the
    // downloaded archive, so it must never be trusted from the (third-party)
    // download mirror on its own — a malicious mirror could serve its own archive
    // plus a matching hash and get it executed inside the container.
    //
    //   - With a pinned ed25519 key (CHORDV_SYSTEM_UPDATE_MANIFEST_PUBLIC_KEY):
    //     the mirror may serve the manifest (availability), but a detached
    //     signature is verified against the pinned key before it is trusted.
    //   - Without a pinned key: the manifest is fetched DIRECT ONLY (never the
    //     mirror). The mirror is still used for the large artifact download,
    //     whose integrity the trusted SHA-256 then guarantees.
    const publicKey = this.config.manifestPublicKey;
    let manifestText: string;
    if (publicKey) {
      const mirror = await this.resolveMirrorPrefix();
      // Fetch the manifest + its detached signature together and verify as a PAIR.
      const fetchPair = async (useMirror: boolean) => {
        const prefix = useMirror ? mirror : null;
        const text = await this.fetchManifestText(manifestUrl, prefix);
        const signature = await this.fetchManifestText(`${manifestUrl}.sig`, prefix);
        return { text, ok: verifyManifestSignature(Buffer.from(text, "utf8"), signature, publicKey) };
      };
      let pair = await fetchPair(Boolean(mirror));
      if (!pair.ok && mirror) {
        // The manifest and .sig are fetched independently, so during a mirror cache
        // transition it can serve a stale manifest with a fresh signature (or vice
        // versa) — the pair fails to verify even though the direct origin is
        // consistent. Retry the PAIR direct-only before giving up, so a converging
        // mirror does not knock out update checks entirely.
        this.logger.warn("Signed manifest verification failed via mirror; retrying manifest+signature direct-only.");
        pair = await fetchPair(false);
      }
      if (!pair.ok) {
        throw new BadRequestException("更新清单签名校验失败（清单可能被篡改或加速镜像返回了非法内容）。");
      }
      manifestText = pair.text;
    } else {
      // No signature to authenticate the manifest, so the ONLY thing standing
      // between an on-path attacker and arbitrary-code execution is transport
      // security. A plain-HTTP manifest could be rewritten in transit (hash +
      // artifact URL together), so refuse it outright when unsigned.
      if (!/^https:\/\//i.test(manifestUrl.trim())) {
        throw new BadRequestException(
          "未配置清单签名公钥时，更新清单地址必须使用 HTTPS（或改用签名清单）。"
        );
      }
      // requireHttps across the whole redirect chain: with no signature, transport
      // security is the only integrity guarantee, so an https→http downgrade hop
      // (where an on-path attacker could swap the manifest + artifact hash) must be
      // rejected, not followed.
      manifestText = await this.fetchManifestText(manifestUrl, null, true);
    }
    const normalized = this.normalizeManifest(JSON.parse(manifestText) as RawManifest);
    if (publicKey) {
      // Freshness ratchet for the signed feed (a signature gives authenticity, not
      // freshness). Only in signed mode: the signature authenticates the version, so
      // the floor can't be poisoned by a forged high version, and the accelerate
      // mirror — the replay vector — is used ONLY when signing is configured.
      await this.enforceSignedManifestFloor(normalized.version);
    }
    return normalized;
  }

  private async enforceSignedManifestFloor(version: string): Promise<void> {
    // Serialize the read-compare-write: two concurrent signed checks (e.g. a UI poll
    // and a background check during a release transition) must not interleave, or one
    // accepting an OLDER version could persist its floor after one accepting a newer
    // version and move the floor backward. Chain on the lock; a rejected downgrade
    // propagates to THIS caller but must not poison the chain for later callers.
    const run = this.manifestFloorLock.then(() => this.enforceSignedManifestFloorLocked(version));
    this.manifestFloorLock = run.catch(() => undefined);
    return run;
  }

  private async enforceSignedManifestFloorLocked(version: string): Promise<void> {
    if (!this.config.stateDir) return;
    const floorFile = path.join(this.config.stateDir, SYSTEM_UPDATE_MANIFEST_FLOOR_FILE);
    let floor: string | null = null;
    try {
      floor = (await fs.readFile(floorFile, "utf8")).trim() || null;
    } catch {
      floor = null; // no floor yet (first accepted manifest)
    }
    if (floor) {
      let cmp = 0;
      try {
        cmp = compareSemver(version, floor);
      } catch {
        cmp = 0; // unparseable floor — don't block on it
      }
      if (cmp < 0) {
        // A correctly-signed but OLDER manifest than one we already accepted: reject
        // it as a replay/downgrade (a stale/malicious mirror trying to hide a newer
        // release). checkUpdate turns this into a surfaced warning + "no update".
        throw new BadRequestException(
          `更新清单版本 v${version} 低于已接受的最新版本 v${floor}，疑似回放/降级（加速镜像可能返回了过期清单），已拒绝。`
        );
      }
    }
    // Raise the floor when this signed manifest advertises a strictly newer version.
    let higher = !floor;
    if (floor) {
      try {
        higher = compareSemver(version, floor) > 0;
      } catch {
        higher = false;
      }
    }
    if (higher) {
      // FAIL CLOSED: if the floor cannot be durably advanced, do NOT accept the
      // manifest. Accepting-and-caching without ratcheting would leave a window where a
      // stale/malicious mirror could later replay an OLDER signed manifest (the floor
      // never moved), defeating the anti-replay guarantee. checkUpdate turns this into
      // a surfaced warning + "no update", and an update refuses to proceed on a warning.
      try {
        await this.writeFileDurable(floorFile, version);
      } catch (error) {
        throw new ServiceUnavailableException(
          `无法持久化更新清单版本阈值（状态卷可能不可写）：${this.describeError(error)}。为防回放攻击已拒绝本次检查。`
        );
      }
    }
  }

  private async fetchManifestText(
    manifestUrl: string,
    mirror: string | null,
    requireHttps = false,
    fetchUrl = fetchPublicHttpUrl
  ): Promise<string> {
    // mirror === null means direct-only; otherwise try the mirror then fall back
    // to direct (for availability only — authenticity is enforced by the caller).
    const candidates: string[] = [];
    if (mirror) {
      const proxied = buildExternalReleaseArtifactProbeUrl(manifestUrl, mirror);
      if (proxied !== manifestUrl) candidates.push(proxied);
    }
    candidates.push(manifestUrl);

    let lastError: unknown = null;
    for (const candidate of candidates) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), MANIFEST_FETCH_TIMEOUT_MS);
      timer.unref?.();
      try {
        const { response } = await fetchUrl(
          candidate,
          { method: "GET", signal: controller.signal, headers: { "user-agent": "ChordV-Admin/1.0" } },
          { errorPrefix: "System update manifest URL", requireHttps }
        );
        if (!response.ok) {
          // Error headers do not mean the body has finished. Abort immediately and
          // cancel the stream before clearing the timer or trying another origin.
          controller.abort();
          await response.body?.cancel().catch(() => undefined);
          throw new Error(`HTTP ${response.status}`);
        }
        return await this.readCappedText(response);
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("清单下载失败");
  }

  private async readCappedText(response: { body?: unknown; text: () => Promise<string> }): Promise<string> {
    // Stream-read with an incremental byte cap: a malicious/broken mirror could
    // otherwise return an arbitrarily large body and exhaust memory before any
    // post-hoc length check (response.text() buffers the whole thing first).
    // `body` is typed loosely to bridge the DOM vs node:stream/web ReadableStream
    // typings; we only touch the small reader surface we actually use.
    const body = response.body as
      | {
          getReader?: () => {
            read: () => Promise<{ done: boolean; value?: Uint8Array }>;
            cancel: () => Promise<unknown>;
          };
        }
      | null
      | undefined;
    if (!body || typeof body.getReader !== "function") {
      // No stream available (shouldn't happen with undici) — fall back but still cap.
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_MANIFEST_BYTES) {
        throw new Error("更新清单超过大小上限。");
      }
      return text;
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > MAX_MANIFEST_BYTES) {
            throw new Error("更新清单超过大小上限。");
          }
          chunks.push(value);
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  }

  private normalizeManifest(raw: RawManifest): NormalizedRelease {
    const version = typeof raw.version === "string" ? normalizeVersion(raw.version) : "";
    if (!version) {
      throw new BadRequestException("更新清单缺少有效的 version 字段。");
    }
    const artifact = raw.artifact ?? {};
    const downloadUrl = typeof artifact.url === "string" ? artifact.url.trim() : "";
    const sha256 = typeof artifact.sha256 === "string" ? artifact.sha256.trim() : "";
    if (!downloadUrl || !/^https?:\/\//i.test(downloadUrl)) {
      throw new BadRequestException("更新清单缺少有效的下载地址。");
    }
    if (!/^[a-f0-9]{64}$/i.test(sha256)) {
      throw new BadRequestException("更新清单缺少有效的 SHA-256。");
    }
    const changelog = Array.isArray(raw.changelog)
      ? raw.changelog.filter((item): item is string => typeof item === "string")
      : [];
    return {
      version,
      tag: typeof raw.tag === "string" ? raw.tag : null,
      publishedAt: typeof raw.publishedAt === "string" ? raw.publishedAt : null,
      changelog,
      notes: typeof raw.notes === "string" ? raw.notes : null,
      htmlUrl: typeof raw.htmlUrl === "string" ? raw.htmlUrl : null,
      downloadUrl,
      fileSizeBytes:
        typeof artifact.sizeBytes === "number" || typeof artifact.sizeBytes === "string"
          ? String(artifact.sizeBytes)
          : null,
      sha256
    };
  }

  private async resolveMirrorPrefix(): Promise<string | null> {
    try {
      const config = await this.downloadMirrorService.getEffectiveConfig();
      return config.defaultMirrorPrefix;
    } catch (error) {
      this.logger.warn(`Unable to read download mirror config: ${this.describeError(error)}`);
      return null;
    }
  }

  private toCheckDto(entry: SystemUpdateCacheEntry, cached: boolean): SystemUpdateCheckDto {
    const currentVersion = this.config.currentVersion;
    const latestVersion = entry.release?.version ?? currentVersion;
    let hasUpdate = false;
    if (entry.release) {
      try {
        hasUpdate = compareSemver(currentVersion, entry.release.version) < 0;
      } catch {
        hasUpdate = false;
      }
    }
    return {
      currentVersion,
      latestVersion,
      hasUpdate,
      cached,
      checkedAt: new Date(entry.checkedAt).toISOString(),
      release: entry.release
        ? {
            version: entry.release.version,
            tag: entry.release.tag,
            publishedAt: entry.release.publishedAt,
            changelog: entry.release.changelog,
            notes: entry.release.notes,
            htmlUrl: entry.release.htmlUrl,
            downloadUrl: entry.release.downloadUrl,
            fileSizeBytes: entry.release.fileSizeBytes,
            sha256: entry.release.sha256
          }
        : null,
      warning: entry.warning
    };
  }

  private assertOperational() {
    if (!this.config.enabled) {
      throw new BadRequestException("当前环境未启用系统自更新（仅生产容器部署可用）。");
    }
    if (!this.config.releasesDir || !this.config.stateDir) {
      throw new ServiceUnavailableException("系统更新目录未正确配置。");
    }
  }

  private promotingMarkerPath(): string | null {
    return this.config.stateDir ? path.join(this.config.stateDir, SYSTEM_UPDATE_PROMOTING_FILE) : null;
  }

  private async readPromotingMarker(): Promise<{ version?: string; operationId?: string; kind?: string } | null> {
    const file = this.promotingMarkerPath();
    if (!file) return null;
    try {
      return JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      return null;
    }
  }

  private async assertNoPromotionInFlight() {
    // The advisory lock is a per-session lock and cannot survive the process exit
    // that self-update requires, so it does not cover the supervisor's promote +
    // stabilize window. The persisted promoting marker does: while it exists, a
    // second admin (talking to the freshly-started, not-yet-stable API) must not
    // be able to start a competing operation.
    const marker = await this.readPromotingMarker();
    if (marker) {
      throw new ConflictException("已有系统更新正在提升/健康检查中，请稍后重试。");
    }
  }

  private async acquireLock(createClient = () => new PgClient({
    connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10_000, query_timeout: 10_000
  })): Promise<OperationLock> {
    if (!process.env.DATABASE_URL) {
      throw new ServiceUnavailableException("缺少 DATABASE_URL，无法获取系统更新锁。");
    }
    if (this.operationInFlight) {
      throw new ConflictException("已有系统操作正在执行或取消中，请稍后重试。");
    }
    const client = createClient();
    this.operationInFlight = true;
    let lost = false;
    let released = false;
    // Register before connect: pg emits errors on idle clients outside query promises.
    // Never reconnect this session: a new connection would not own the original lock.
    const markLost = () => { lost = true; };
    client.on("error", markLost);
    client.on("end", markLost);
    const assertHeld = async () => {
      if (lost || released) throw new ServiceUnavailableException("系统更新锁连接已断开，操作已取消。");
      try {
        await client.query("SELECT 1");
      } catch {
        lost = true;
      }
      if (lost) throw new ServiceUnavailableException("系统更新锁连接已断开，操作已取消。");
    };
    const release = async () => {
      if (released) return;
      released = true;
      try {
        if (!lost) await client.query("select pg_advisory_unlock($1, $2)", [
          SYSTEM_UPDATE_LOCK_KEY_1, SYSTEM_UPDATE_LOCK_KEY_2
        ]);
      } catch {
        // A dropped session already released its advisory lock.
      } finally {
        await client.end().catch(() => undefined);
        this.operationInFlight = false;
      }
    };
    try {
      await client.connect();
      const result = await client.query<{ locked: boolean }>(
        "select pg_try_advisory_lock($1, $2) as locked",
        [SYSTEM_UPDATE_LOCK_KEY_1, SYSTEM_UPDATE_LOCK_KEY_2]
      );
      if (!result.rows[0]?.locked) throw new ConflictException("已有系统更新/回滚/重启任务正在执行，请稍后重试。");
      await assertHeld();
      return { assertHeld, release };
    } catch (error) {
      await release();
      if (error instanceof ConflictException) throw error;
      throw new ServiceUnavailableException(`获取系统更新锁失败：${this.describeError(error)}`);
    }
  }

  private async createOperationGuarded(
    lock: OperationLock,
    input: {
      operationId: string;
      kind: SystemUpdateOperationKind;
      actorLabel: string | null;
      actorUserId: string | null;
      fromVersion: string | null;
      toVersion: string | null;
    }
  ) {
    // The advisory lock is held on a dedicated PG session; if the audit insert
    // fails we must release it here, or that session keeps the lock forever and
    // blocks every later update/rollback/restart until the process restarts.
    try {
      await lock.assertHeld();
      await this.createOperation(input);
      await lock.assertHeld();
    } catch (error) {
      await this.finishOperation(input.operationId, "failed", { failureReason: this.describeError(error) }).catch(() => undefined);
      await lock.release().catch(() => undefined);
      throw new ServiceUnavailableException(`创建系统操作记录失败：${this.describeError(error)}`);
    }
  }

  private async createOperation(input: {
    operationId: string;
    kind: SystemUpdateOperationKind;
    actorLabel: string | null;
    actorUserId: string | null;
    fromVersion: string | null;
    toVersion: string | null;
  }) {
    await this.prisma.systemUpdateOperation.create({
      data: {
        id: createId("sysrec"),
        operationId: input.operationId,
        kind: input.kind,
        status: "running",
        actorLabel: input.actorLabel,
        actorUserId: input.actorUserId,
        fromVersion: input.fromVersion,
        toVersion: input.toVersion
      }
    });
  }

  private async markRunning(operationId: string, toVersion: string) {
    await this.prisma.systemUpdateOperation.update({
      where: { operationId },
      data: { status: "running", toVersion }
    });
  }

  private async updateOperation(operationId: string, data: { migrationApplied?: boolean }) {
    await this.prisma.systemUpdateOperation.update({ where: { operationId }, data });
  }

  private async finishOperation(
    operationId: string,
    status: "succeeded" | "failed" | "rolled_back",
    data: { toVersion?: string; failureReason?: string | null }
  ) {
    await this.prisma.systemUpdateOperation.update({
      where: { operationId },
      data: {
        status,
        finishedAt: new Date(),
        ...(data.toVersion !== undefined ? { toVersion: data.toVersion } : {}),
        ...(data.failureReason !== undefined ? { failureReason: data.failureReason } : {})
      }
    });
  }

  private async writePendingMarker(marker: {
    version: string;
    operationId: string;
    kind: SystemUpdateOperationKind;
    migrationApplied?: boolean;
  }) {
    if (!this.config.stateDir) {
      throw new ServiceUnavailableException("未配置状态目录（CHORDV_SYSTEM_STATE_DIR）。");
    }
    await fs.mkdir(this.config.stateDir, { recursive: true });
    const file = path.join(this.config.stateDir, SYSTEM_UPDATE_PENDING_FILE);
    // migrationApplied travels through the markers so the "code rolled back but
    // schema was not" warning survives even if the best-effort DB write failed.
    // Write durably (tmp → fsync → rename → fsync dir): the very next step commits
    // a migration, so a power loss that lost this marker would strand old code on a
    // new schema. fs.writeFile alone only closes the fd, it does not fsync.
    await this.writeFileDurable(file, JSON.stringify({ migrationApplied: false, ...marker }));
  }

  private async writeFileDurable(file: string, contents: string) {
    // Per-write UNIQUE temp path (pid + monotonic seq): two concurrent durable writes
    // must never share the same tmp inode, or one could overwrite/rename the other's
    // half-written bytes (e.g. concurrent signed manifest-floor updates).
    const tmp = `${file}.tmp.${process.pid}.${(this.tmpSeq += 1)}`;
    try {
      const handle = await fs.open(tmp, "w");
      try {
        await handle.writeFile(contents, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tmp, file);
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
    await this.fsyncDir(path.dirname(file));
  }

  private async fsyncDir(dir: string) {
    // Best-effort fsync of a DIRECTORY: some platforms/filesystems reject opening
    // a directory for fsync (EISDIR/EINVAL/EPERM). The rename that precedes it is
    // already atomic; the dir fsync only hardens WHEN the entry reaches disk, so a
    // failure here is logged, not fatal.
    try {
      const handle = await fs.open(dir, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      this.logger.warn(`fsync dir ${dir} failed (non-fatal): ${this.describeError(error)}`);
    }
  }

  private async clearPendingMarker() {
    if (!this.config.stateDir) return;
    await fs.rm(path.join(this.config.stateDir, SYSTEM_UPDATE_PENDING_FILE), { force: true });
    await this.fsyncDir(this.config.stateDir).catch(() => undefined);
  }

  /**
   * Apply the supervisor's operation-result marker (if any) to the DB. The
   * supervisor writes it AFTER the health gate + stabilization window resolves
   * (success, rollback, or failure), so this — not "the app booted" — is the
   * authoritative signal that finalizes an update/rollback. Called on boot and on
   * every status poll, so a still-running app picks up the outcome without a reboot.
   */
  private async consumeResultMarker(): Promise<void> {
    if (!this.config.stateDir) return;
    // Drain EVERY per-operation result file (plus the legacy single file): the
    // supervisor writes one "operation-result.<op>.json" per operation so a second
    // operation never clobbers a first the app has not yet persisted. Ignore .tmp
    // files (an in-flight atomic write) and process oldest-first for stable ordering.
    let entries: string[];
    try {
      entries = await fs.readdir(this.config.stateDir);
    } catch {
      return;
    }
    const resultFiles = entries
      .filter(
        (name) =>
          name.startsWith(SYSTEM_UPDATE_RESULT_PREFIX) && name.endsWith(".json") && !name.includes(".tmp.")
      )
      .sort();
    for (const name of resultFiles) {
      await this.consumeOneResultMarker(path.join(this.config.stateDir, name));
    }
  }

  private async consumeOneResultMarker(resultFile: string): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(resultFile, "utf8");
    } catch {
      return; // consumed by a concurrent poll, or gone
    }
    let marker: {
      operationId?: string;
      status?: string;
      version?: string;
      reason?: string;
      migrationApplied?: boolean;
    };
    try {
      marker = JSON.parse(raw);
    } catch {
      this.logger.warn(`Discarding unparseable operation-result marker: ${path.basename(resultFile)}`);
      await fs.rm(resultFile, { force: true }).catch(() => undefined);
      return;
    }
    if (!marker.operationId || !marker.status) {
      await fs.rm(resultFile, { force: true }).catch(() => undefined);
      return;
    }
    const status =
      marker.status === "success" ? "succeeded" : marker.status === "rolledback" ? "rolled_back" : "failed";
    // For a rollback, marker.version is the version we rolled BACK to (last-good),
    // NOT the update target — so keep the operation's original toVersion (the
    // attempted release) intact and record the landing version in the reason
    // instead, or the audit would read "1.0.1 -> 1.0.1" and lose which release failed.
    const setToVersion = status !== "rolled_back" && Boolean(marker.version);
    const reason =
      status === "rolled_back" && marker.version
        ? `${marker.reason ?? "已自动回滚"}（当前运行 v${marker.version}）`
        : marker.reason;
    try {
      await this.prisma.systemUpdateOperation.update({
        where: { operationId: marker.operationId },
        data: {
          status,
          finishedAt: new Date(),
          ...(setToVersion ? { toVersion: marker.version } : {}),
          ...(reason ? { failureReason: reason } : {}),
          ...(typeof marker.migrationApplied === "boolean" ? { migrationApplied: marker.migrationApplied } : {})
        }
      });
      // Delete ONLY after the outcome is persisted; a transient DB error must keep
      // the marker so a later poll/boot can still record the real outcome.
      await fs.rm(resultFile, { force: true }).catch(() => undefined);
    } catch (error) {
      this.logger.warn(`Failed to persist operation-result marker (will retry): ${this.describeError(error)}`);
    }
  }

  private async reconcileOperationsOnBoot() {
    await this.consumeResultMarker();

    // Operations still "running"/"pending" with no result marker:
    //   - one whose promotion is still being stabilized by the supervisor
    //     (promoting marker matches, incl. a health-gated restart) is left running:
    //     success is NOT confirmed just because the port opened; the supervisor's
    //     result marker (written only after stabilization) finalizes it;
    //   - a restart with no in-flight promotion came back → succeeded;
    //   - anything else was interrupted before completing → failed.
    const promoting = await this.readPromotingMarker();
    const stale = await this.prisma.systemUpdateOperation.findMany({
      where: { status: { in: ["pending", "running"] } }
    });
    for (const op of stale) {
      if (promoting?.operationId && promoting.operationId === op.operationId) {
        // still in flight — leave it running for the supervisor to finalize
        continue;
      } else if (op.kind === "restart") {
        await this.finishOperation(op.operationId, "succeeded", {}).catch(() => undefined);
      } else {
        await this.finishOperation(op.operationId, "failed", {
          failureReason: "任务在服务重启期间中断，未确认完成。"
        }).catch(() => undefined);
      }
    }
  }

  private async pruneOldReleases(nextVersion: string, currentVersion: string) {
    if (!this.config.releasesDir) return;
    const keep = this.config.keepReleases;
    let versions: SystemUpdateRollbackVersionDto[];
    try {
      versions = await this.listRollbackVersions();
    } catch {
      return;
    }
    const protectedVersions = new Set([nextVersion, currentVersion]);
    const removable = versions
      .map((item) => item.version)
      .filter((version) => !protectedVersions.has(version));
    const toRemove = removable.slice(Math.max(keep - protectedVersions.size, 0));
    for (const version of toRemove) {
      await this.removeDirSafe(path.join(this.config.releasesDir, version));
    }
  }

  private async removeDirSafe(dir: string) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  private scheduleProcessExit(reason: string, lock: OperationLock, operationId: string) {
    // NOTE: callers deliberately do NOT release the advisory lock here. The lock is
    // held on the operation's dedicated PG session; letting process.exit close that
    // session is what releases it, so the lock stays held across the whole
    // exit-flush window. Releasing it earlier would open a gap where a second
    // request could acquire the lock before the supervisor writes promoting.json.
    this.logger.warn(`Scheduling process exit for self-update: ${reason}`);
    setTimeout(() => {
      void (async () => {
        try {
          await lock.assertHeld();
        } catch (error) {
          await this.clearPendingMarker().catch(() => undefined);
          await this.finishOperation(operationId, "failed", { failureReason: this.describeError(error) }).catch(() => undefined);
          await lock.release();
          this.logger.warn("Cancelled system operation after losing its lock; keeping the API running.");
          return;
        }
        this.logger.warn("Exiting process; supervisor will bring the service back up.");
        process.exit(0);
      })();
    }, EXIT_FLUSH_DELAY_MS);
  }

  private toOperationDto(row: {
    id: string;
    operationId: string;
    kind: string;
    status: string;
    actorLabel: string | null;
    fromVersion: string | null;
    toVersion: string | null;
    failureReason: string | null;
    migrationApplied: boolean;
    startedAt: Date;
    finishedAt: Date | null;
  }): SystemUpdateOperationDto {
    return {
      id: row.id,
      operationId: row.operationId,
      kind: row.kind as SystemUpdateOperationKind,
      status: row.status as SystemUpdateOperationDto["status"],
      actorLabel: row.actorLabel,
      fromVersion: row.fromVersion,
      toVersion: row.toVersion,
      failureReason: row.failureReason,
      migrationApplied: row.migrationApplied,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null
    };
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }
}
