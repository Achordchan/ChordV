import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException
} from "@nestjs/common";
import { spawn } from "node:child_process";
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
    const rows = await this.prisma.systemUpdateOperation.findMany({
      orderBy: { startedAt: "desc" },
      take: Math.min(Math.max(limit, 1), 100)
    });
    return rows.map((row) => this.toOperationDto(row));
  }

  async getOperation(operationId: string): Promise<SystemUpdateOperationDto | null> {
    const row = await this.prisma.systemUpdateOperation.findUnique({ where: { operationId } });
    return row ? this.toOperationDto(row) : null;
  }

  async startUpdate(actorLabel: string | null, actorUserId: string | null): Promise<SystemUpdateStartResultDto> {
    this.assertOperational();
    const operationId = createId("sysop");
    const lock = await this.acquireLock();
    const fromVersion = this.config.currentVersion;
    await this.createOperation({ operationId, kind: "update", actorLabel, actorUserId, fromVersion, toVersion: null });
    void this.runUpdateInBackground(operationId, fromVersion, lock);
    return { operationId, accepted: true, message: "更新任务已开始，服务将在完成后自动重启。" };
  }

  async startRollback(
    actorLabel: string | null,
    actorUserId: string | null,
    targetVersion?: string | null
  ): Promise<SystemUpdateStartResultDto> {
    this.assertOperational();
    const fromVersion = this.config.currentVersion;
    const target = await this.resolveRollbackTarget(targetVersion, fromVersion);
    const operationId = createId("sysop");
    const lock = await this.acquireLock();
    await this.createOperation({
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
    const operationId = createId("sysop");
    const lock = await this.acquireLock();
    const fromVersion = this.config.currentVersion;
    await this.createOperation({
      operationId,
      kind: "restart",
      actorLabel,
      actorUserId,
      fromVersion,
      toVersion: fromVersion
    });
    // No pending marker: the supervisor simply restarts the current version.
    this.scheduleProcessExit(`restart requested (operation ${operationId})`, async () => {
      await lock.release().catch(() => undefined);
    });
    return { operationId, accepted: true, message: "服务正在重启。" };
  }

  private async runUpdateInBackground(operationId: string, fromVersion: string, lock: OperationLock) {
    try {
      const check = await this.checkUpdate(true);
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
        await this.removeDirSafe(releaseDir);
        throw error;
      }

      await this.writePendingMarker({ version: release.version, operationId, kind: "update" });
      await this.updateOperation(operationId, { migrationApplied });
      await this.pruneOldReleases(release.version, fromVersion);

      this.scheduleProcessExit(
        `staged update ${fromVersion} -> ${release.version} (operation ${operationId})`,
        async () => {
          await lock.release().catch(() => undefined);
        }
      );
    } catch (error) {
      const reason = this.describeError(error);
      this.logger.error(`System update failed (operation ${operationId}): ${reason}`);
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
      this.scheduleProcessExit(
        `staged rollback ${fromVersion} -> ${target} (operation ${operationId})`,
        async () => {
          await lock.release().catch(() => undefined);
        }
      );
    } catch (error) {
      const reason = this.describeError(error);
      this.logger.error(`System rollback failed (operation ${operationId}): ${reason}`);
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
    await this.runShell(
      "sh",
      ["-c", 'set -o pipefail; pg_dump "$DATABASE_URL" | gzip > "$SNAPSHOT_TARGET"'],
      { ...process.env, DATABASE_URL: databaseUrl, SNAPSHOT_TARGET: target },
      "数据库快照",
      10 * 60 * 1000
    );
    this.logger.log(`Database snapshot created before migration: ${target}`);
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
    const mirror = await this.resolveMirrorPrefix();
    const raw = await this.fetchManifestJson(manifestUrl, mirror);
    return this.normalizeManifest(raw);
  }

  private async fetchManifestJson(manifestUrl: string, mirror: string | null): Promise<RawManifest> {
    const candidates: string[] = [];
    const proxied = buildExternalReleaseArtifactProbeUrl(manifestUrl, mirror);
    if (proxied !== manifestUrl) candidates.push(proxied);
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
        const text = await this.readCappedText(response);
        return JSON.parse(text) as RawManifest;
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("清单下载失败");
  }

  private async readCappedText(response: { text: () => Promise<string> }): Promise<string> {
    const text = await response.text();
    if (text.length > MAX_MANIFEST_BYTES) {
      throw new Error("更新清单超过大小上限。");
    }
    return text;
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

  private async reconcileOperationsOnBoot() {
    if (this.config.stateDir) {
      const resultFile = path.join(this.config.stateDir, SYSTEM_UPDATE_RESULT_FILE);
      try {
        const raw = await fs.readFile(resultFile, "utf8");
        const parsed = JSON.parse(raw) as {
          operationId?: string;
          status?: string;
          version?: string;
          reason?: string;
        };
        if (parsed.operationId && parsed.status) {
          const status =
            parsed.status === "success"
              ? "succeeded"
              : parsed.status === "rolledback"
                ? "rolled_back"
                : "failed";
          await this.prisma.systemUpdateOperation
            .update({
              where: { operationId: parsed.operationId },
              data: {
                status,
                finishedAt: new Date(),
                ...(parsed.version ? { toVersion: parsed.version } : {}),
                ...(parsed.reason ? { failureReason: parsed.reason } : {})
              }
            })
            .catch(() => undefined);
        }
        await fs.rm(resultFile, { force: true });
      } catch {
        // no result marker; fall through to stale sweep
      }
    }

    // Any operation still "running"/"pending" that we cannot account for from a
    // supervisor result marker is resolved by observing the version we actually
    // came back on. The running app IS the proof of a successful promotion:
    //   - restart ops that come back are successful by definition;
    //   - an update/rollback whose target == the version now running promoted
    //     cleanly and is serving traffic → succeeded (the supervisor only writes
    //     a result marker for the failure/rollback path, so success has none);
    //   - anything else (target != current, no marker) was interrupted before
    //     the new version took effect → failed.
    const current = this.config.currentVersion;
    const stale = await this.prisma.systemUpdateOperation.findMany({
      where: { status: { in: ["pending", "running"] } }
    });
    for (const op of stale) {
      if (op.kind === "restart") {
        await this.finishOperation(op.operationId, "succeeded", {}).catch(() => undefined);
      } else if (op.toVersion && op.toVersion === current) {
        await this.finishOperation(op.operationId, "succeeded", { toVersion: current }).catch(() => undefined);
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

  private scheduleProcessExit(reason: string, beforeExit: () => Promise<void>) {
    this.logger.warn(`Scheduling process exit for self-update: ${reason}`);
    setTimeout(() => {
      void (async () => {
        await beforeExit().catch(() => undefined);
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
