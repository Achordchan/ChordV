import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
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
  SYSTEM_UPDATE_PENDING_FILE,
  SYSTEM_UPDATE_PROMOTING_FILE,
  SYSTEM_UPDATE_RESULT_FILE,
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
export class SystemUpdateService implements OnModuleInit {
  private readonly logger = new Logger(SystemUpdateService.name);
  private config: SystemUpdateRuntimeConfig = resolveSystemUpdateRuntimeConfig();
  private cache: SystemUpdateCacheEntry | null = null;

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
    const rows = await this.prisma.systemUpdateOperation.findMany({
      orderBy: { startedAt: "desc" },
      take: Math.min(Math.max(limit, 1), 100)
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

  async startUpdate(actorLabel: string | null, actorUserId: string | null): Promise<SystemUpdateStartResultDto> {
    this.assertOperational();
    await this.assertNoPromotionInFlight();
    const operationId = createId("sysop");
    const lock = await this.acquireLock();
    const fromVersion = this.config.currentVersion;
    await this.createOperationGuarded(lock, { operationId, kind: "update", actorLabel, actorUserId, fromVersion, toVersion: null });
    void this.runUpdateInBackground(operationId, fromVersion, lock);
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
    // No pending marker: the supervisor simply restarts the current version.
    // Lock stays held until process exit (see scheduleProcessExit) so no second
    // operation can slip in during the exit-flush window.
    void lock;
    this.scheduleProcessExit(`restart requested (operation ${operationId})`);
    return { operationId, accepted: true, message: "服务正在重启。" };
  }

  private async runUpdateInBackground(operationId: string, fromVersion: string, lock: OperationLock) {
    try {
      const check = await this.checkUpdate(true);
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
      const release = this.cache?.release ?? null;
      if (!check.hasUpdate || !release) {
        await this.finishOperation(operationId, "succeeded", {
          toVersion: fromVersion,
          failureReason: null
        });
        await lock.release().catch(() => undefined);
        return;
      }
      await this.markRunning(operationId, release.version);

      const releaseDir = await this.downloadAndExtractRelease(release);
      let migrationApplied = false;
      try {
        migrationApplied = await this.applyPendingMigrations(releaseDir, release.version);
      } catch (error) {
        // Migration failed → DB is unchanged (or the failed migration is recorded
        // by prisma); safe to abort without promoting.
        await this.removeDirSafe(releaseDir);
        throw error;
      }

      // ---- point of no return ----
      // If a migration ran, the database is now on the NEW schema and only the new
      // code matches it. Non-critical bookkeeping (prune, audit flag) must NOT
      // abort the promotion — otherwise the old code keeps serving a migrated DB.
      // So best-effort those, and treat only writePendingMarker (which activates
      // the new code) as the load-bearing step.
      await this.pruneOldReleases(release.version, fromVersion).catch((error) =>
        this.logger.warn(`Prune old releases failed (non-fatal): ${this.describeError(error)}`)
      );
      await this.updateOperation(operationId, { migrationApplied }).catch((error) =>
        this.logger.warn(`Audit update failed (non-fatal): ${this.describeError(error)}`)
      );

      try {
        await this.writePendingMarker({ version: release.version, operationId, kind: "update" });
      } catch (error) {
        if (migrationApplied) {
          // Worst case: DB migrated but the new code cannot be staged. Do NOT quietly
          // mark "failed" and keep running old code on the new schema — surface it so
          // an operator can promote manually or restore the pre-migration snapshot.
          const reason = this.describeError(error);
          this.logger.error(
            `CRITICAL: migration for ${release.version} applied but staging failed: ${reason}. ` +
              `Old code is running against the new schema — manual promotion or snapshot restore required.`
          );
          await this.finishOperation(operationId, "failed", {
            toVersion: release.version,
            failureReason: `迁移已执行但暂存新版本失败：${reason}。旧代码正运行在新库结构上，需人工介入（手动切换或用迁移前快照恢复）。`
          }).catch(() => undefined);
          await lock.release().catch(() => undefined);
          return;
        }
        throw error; // no migration ran → normal abort is safe
      }

      // Keep the advisory lock until the process actually exits (see
      // scheduleProcessExit): the DB session closing on exit releases it, which
      // closes the window where a second request could grab the lock before the
      // supervisor writes promoting.json.
      this.scheduleProcessExit(`staged update ${fromVersion} -> ${release.version} (operation ${operationId})`);
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
      await this.markRunning(operationId, target);
      await this.writePendingMarker({ version: target, operationId, kind: "rollback" });
      // Lock stays held until process exit (see scheduleProcessExit).
      this.scheduleProcessExit(`staged rollback ${fromVersion} -> ${target} (operation ${operationId})`);
    } catch (error) {
      const reason = this.describeError(error);
      this.logger.error(`System rollback failed (operation ${operationId}): ${reason}`);
      await this.clearPendingMarker().catch(() => undefined);
      await this.finishOperation(operationId, "failed", { failureReason: reason }).catch(() => undefined);
      await lock.release().catch(() => undefined);
    }
  }

  private async downloadAndExtractRelease(release: NormalizedRelease): Promise<string> {
    const releasesDir = this.config.releasesDir;
    if (!releasesDir) {
      throw new ServiceUnavailableException("未配置发布目录（CHORDV_SYSTEM_RELEASES_DIR）。");
    }
    const mirror = await this.resolveMirrorPrefix();
    const downloaded = await downloadExternalReleaseArtifactFile(release.downloadUrl, mirror);
    try {
      if (downloaded.fileHash.toLowerCase() !== release.sha256.toLowerCase()) {
        throw new BadRequestException(
          `更新包 SHA-256 校验不匹配（期望 ${release.sha256}，实际 ${downloaded.fileHash}）。`
        );
      }
      const finalDir = path.join(releasesDir, release.version);
      const stagingDir = path.join(releasesDir, `.staging-${release.version}-${Date.now()}`);
      await this.removeDirSafe(stagingDir);
      await fs.mkdir(stagingDir, { recursive: true });
      await this.extractTarball(downloaded.absolutePath, stagingDir);
      await this.removeDirSafe(finalDir);
      await fs.rename(stagingDir, finalDir);
      return finalDir;
    } finally {
      await downloaded.cleanup().catch(() => undefined);
    }
  }

  private async applyPendingMigrations(releaseDir: string, version: string): Promise<boolean> {
    const pending = await this.detectPendingMigrations(releaseDir);
    if (pending.length === 0) {
      return false;
    }
    this.logger.warn(
      `Update ${version} carries ${pending.length} pending migration(s): ${pending.join(", ")}`
    );
    if (this.config.snapshotBeforeMigrate) {
      await this.snapshotDatabase(version);
    }
    await this.runPrismaMigrateDeploy(releaseDir);
    return true;
  }

  private async detectPendingMigrations(releaseDir: string): Promise<string[]> {
    const migrationsDir = path.join(releaseDir, "apps/api/prisma/migrations");
    let names: string[];
    try {
      const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
      names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    } catch {
      return [];
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

  private async snapshotDatabase(version: string): Promise<void> {
    const databaseUrl = process.env.DATABASE_URL?.trim();
    if (!databaseUrl) {
      throw new ServiceUnavailableException("缺少 DATABASE_URL，无法在迁移前创建数据库快照。");
    }
    const backupDir = this.config.backupDir ?? (this.config.stateDir ? path.join(this.config.stateDir, "backups") : null);
    if (!backupDir) {
      throw new ServiceUnavailableException("未配置数据库快照目录（CHORDV_SYSTEM_UPDATE_BACKUP_DIR）。");
    }
    await fs.mkdir(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = path.join(backupDir, `pre-migrate-${version}-${stamp}.sql.gz`);
    // Use bash (present in the bookworm runtime image): `set -o pipefail` is a
    // bashism — under dash (Debian's /bin/sh) it aborts before pg_dump runs.
    try {
      await this.runShell(
        "bash",
        ["-c", 'set -o pipefail; pg_dump "$DATABASE_URL" | gzip > "$SNAPSHOT_TARGET"'],
        { ...process.env, DATABASE_URL: databaseUrl, SNAPSHOT_TARGET: target },
        "数据库快照",
        10 * 60 * 1000
      );
    } catch (error) {
      // A failed pg_dump/gzip leaves a truncated .sql.gz behind — remove it so a
      // later restore can't pick up a corrupt snapshot and it doesn't waste space.
      await fs.rm(target, { force: true }).catch(() => undefined);
      throw error;
    }
    this.logger.log(`Database snapshot created before migration: ${target}`);
    await this.pruneSnapshots(backupDir);
  }

  private async pruneSnapshots(backupDir: string): Promise<void> {
    // Unbounded pg_dump snapshots would fill the state volume and then break
    // future snapshots, pending markers, and audit writes. Keep the newest N.
    const keep = this.config.snapshotKeep;
    try {
      const entries = await fs.readdir(backupDir);
      const names = entries.filter((name) => /^pre-migrate-.*\.sql\.gz$/.test(name));
      const withTime = await Promise.all(
        names.map(async (name) => {
          const stat = await fs.stat(path.join(backupDir, name)).catch(() => null);
          return { name, mtime: stat ? stat.mtimeMs : 0 };
        })
      );
      // Newest first, then drop everything beyond the keep count.
      const removable = withTime.sort((a, b) => b.mtime - a.mtime).slice(keep);
      for (const { name } of removable) {
        await fs.rm(path.join(backupDir, name), { force: true }).catch(() => undefined);
      }
      if (removable.length > 0) {
        this.logger.log(`Pruned ${removable.length} old database snapshot(s), keeping ${keep}.`);
      }
    } catch (error) {
      this.logger.warn(`Snapshot pruning failed: ${this.describeError(error)}`);
    }
  }

  private async runPrismaMigrateDeploy(releaseDir: string): Promise<void> {
    const prismaBin = path.join(releaseDir, "node_modules/.bin/prisma");
    const schemaPath = path.join(releaseDir, "apps/api/prisma/schema.prisma");
    await this.runShell(
      prismaBin,
      ["migrate", "deploy", "--schema", schemaPath],
      { ...process.env },
      "数据库迁移",
      10 * 60 * 1000,
      releaseDir
    );
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
      const child = spawn(command, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new ServiceUnavailableException(`${label}超时（${timeoutMs}ms）。`));
      }, timeoutMs);
      timer.unref?.();
      child.stdout?.on("data", () => undefined);
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new ServiceUnavailableException(`${label}启动失败：${error.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
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
    const previous = available.find((item) => !item.isCurrent);
    if (!previous) {
      throw new BadRequestException("没有可回滚的历史版本。");
    }
    return previous.version;
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
      manifestText = await this.fetchManifestText(manifestUrl, mirror);
      const signature = await this.fetchManifestText(`${manifestUrl}.sig`, mirror);
      if (!verifyManifestSignature(Buffer.from(manifestText, "utf8"), signature, publicKey)) {
        throw new BadRequestException("更新清单签名校验失败（清单可能被篡改或加速镜像返回了非法内容）。");
      }
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
      manifestText = await this.fetchManifestText(manifestUrl, null);
    }
    return this.normalizeManifest(JSON.parse(manifestText) as RawManifest);
  }

  private async fetchManifestText(manifestUrl: string, mirror: string | null): Promise<string> {
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
        const { response } = await fetchPublicHttpUrl(
          candidate,
          { method: "GET", signal: controller.signal, headers: { "user-agent": "ChordV-Admin/1.0" } },
          { errorPrefix: "System update manifest URL" }
        );
        if (!response.ok) {
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

  private async acquireLock(): Promise<OperationLock> {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new ServiceUnavailableException("缺少 DATABASE_URL，无法获取系统更新锁。");
    }
    const client = new PgClient({ connectionString });
    await client.connect();
    let acquired = false;
    try {
      const result = await client.query<{ locked: boolean }>(
        "select pg_try_advisory_lock($1, $2) as locked",
        [SYSTEM_UPDATE_LOCK_KEY_1, SYSTEM_UPDATE_LOCK_KEY_2]
      );
      acquired = Boolean(result.rows[0]?.locked);
    } catch (error) {
      await client.end().catch(() => undefined);
      throw new ServiceUnavailableException(`获取系统更新锁失败：${this.describeError(error)}`);
    }
    if (!acquired) {
      await client.end().catch(() => undefined);
      throw new ConflictException("已有系统更新/回滚/重启任务正在执行，请稍后重试。");
    }
    return {
      release: async () => {
        try {
          await client.query("select pg_advisory_unlock($1, $2)", [
            SYSTEM_UPDATE_LOCK_KEY_1,
            SYSTEM_UPDATE_LOCK_KEY_2
          ]);
        } catch {
          // ignore
        }
        await client.end().catch(() => undefined);
      }
    };
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
      await this.createOperation(input);
    } catch (error) {
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

  private async writePendingMarker(marker: { version: string; operationId: string; kind: SystemUpdateOperationKind }) {
    if (!this.config.stateDir) {
      throw new ServiceUnavailableException("未配置状态目录（CHORDV_SYSTEM_STATE_DIR）。");
    }
    await fs.mkdir(this.config.stateDir, { recursive: true });
    const file = path.join(this.config.stateDir, SYSTEM_UPDATE_PENDING_FILE);
    await fs.writeFile(file, JSON.stringify(marker), "utf8");
  }

  private async clearPendingMarker() {
    if (!this.config.stateDir) return;
    await fs.rm(path.join(this.config.stateDir, SYSTEM_UPDATE_PENDING_FILE), { force: true });
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
    const resultFile = path.join(this.config.stateDir, SYSTEM_UPDATE_RESULT_FILE);
    let raw: string;
    try {
      raw = await fs.readFile(resultFile, "utf8");
    } catch {
      return; // no marker
    }
    let marker: { operationId?: string; status?: string; version?: string; reason?: string };
    try {
      marker = JSON.parse(raw);
    } catch {
      this.logger.warn("Discarding unparseable operation-result marker.");
      await fs.rm(resultFile, { force: true }).catch(() => undefined);
      return;
    }
    if (!marker.operationId || !marker.status) {
      await fs.rm(resultFile, { force: true }).catch(() => undefined);
      return;
    }
    const status =
      marker.status === "success" ? "succeeded" : marker.status === "rolledback" ? "rolled_back" : "failed";
    try {
      await this.prisma.systemUpdateOperation.update({
        where: { operationId: marker.operationId },
        data: {
          status,
          finishedAt: new Date(),
          ...(marker.version ? { toVersion: marker.version } : {}),
          ...(marker.reason ? { failureReason: marker.reason } : {})
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
    //   - restart ops that come back are successful by definition;
    //   - an update/rollback whose promotion is still being stabilized by the
    //     supervisor (promoting marker matches) is left running — its success is
    //     NOT confirmed just because the port opened; the supervisor's result
    //     marker (written only after stabilization) will finalize it;
    //   - anything else was interrupted before completing → failed.
    const promoting = await this.readPromotingMarker();
    const stale = await this.prisma.systemUpdateOperation.findMany({
      where: { status: { in: ["pending", "running"] } }
    });
    for (const op of stale) {
      if (op.kind === "restart") {
        await this.finishOperation(op.operationId, "succeeded", {}).catch(() => undefined);
      } else if (promoting?.operationId && promoting.operationId === op.operationId) {
        // still in flight — leave it running for the supervisor to finalize
        continue;
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

  private scheduleProcessExit(reason: string, beforeExit?: () => Promise<void>) {
    // NOTE: callers deliberately do NOT release the advisory lock here. The lock is
    // held on the operation's dedicated PG session; letting process.exit close that
    // session is what releases it, so the lock stays held across the whole
    // exit-flush window. Releasing it earlier would open a gap where a second
    // request could acquire the lock before the supervisor writes promoting.json.
    this.logger.warn(`Scheduling process exit for self-update: ${reason}`);
    setTimeout(() => {
      void (async () => {
        if (beforeExit) await beforeExit().catch(() => undefined);
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
