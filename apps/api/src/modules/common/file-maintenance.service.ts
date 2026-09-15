import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import type { FileCleanupJob } from "@prisma/client";
import { Cron } from "@nestjs/schedule";
import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { DrainableJob } from "../../work-lifecycle";
import { PrismaService } from "./prisma.service";
import { releaseArtifactStorageRoot } from "./release-center.utils";
import { canonicalManagedReference, assertSafeFile, cleanupPath, hashStoredFile, managedPath, unlinkManagedFile } from "./storage-files";

type ReferenceIndex = { since: Date; paths: Set<string>; resolved: Map<string,string>; errors: Set<string> };

@Injectable()
export class FileMaintenanceService {
  private readonly logger = new Logger(FileMaintenanceService.name);
  private busy = false;
  constructor(private readonly prisma: PrismaService) {}
  async enqueue(value: string, reason: string, writer: Pick<PrismaService, "fileCleanupJob"> = this.prisma, blockedReason?: string) {
    const absolute = path.resolve(value);
    let lastError: string | undefined = blockedReason;
    try { cleanupPath(absolute); } catch(error) { lastError = error instanceof Error ? error.message : "清理路径异常"; this.logger.warn(`已登记受保护的异常清理路径：${absolute}`); }
    return writer.fileCleanupJob.upsert({ where: { path: absolute },
      create: { id: randomUUID(), path: absolute, reason, blocked:Boolean(lastError), ...(lastError?{lastError}: {}) }, update: { reason, blocked:Boolean(lastError), ...(lastError?{lastError}: {}) } });
  }
  async removeOrQueue(value: string, reason: string) {
    try {
      const absolute = cleanupPath(value);
      const exists=await fs.lstat(absolute).catch((error:NodeJS.ErrnoException)=>{if(error.code==="ENOENT")return null;throw error;});
      if(!exists)return;
      if (!await this.references(absolute)) await unlinkManagedFile(absolute);
    } catch (error) {
      await this.enqueue(value, reason).catch(queueError => this.logger.error(`文件清理任务未能保存：${String(queueError)}；原错误：${String(error)}`));
    }
  }
  async references(absolute: string, batch?: ReferenceIndex) {
    const root = releaseArtifactStorageRoot();
    const real = await fs.realpath(absolute).catch(()=>absolute);
    const relative = path.relative(root, absolute);
    const componentRelative = path.relative(path.join(root, "runtime-components"), absolute);
    const id = path.basename(absolute).replace(/\.part$/, "");
    const [artifact, component, version] = await Promise.all([
      this.prisma.releaseArtifact.findFirst({ where: { storedFilePath: { in: [absolute, real, relative] } }, select: { id: true } }),
      this.prisma.runtimeComponent.findFirst({ where: { storedFilePath: { in: [absolute, real, componentRelative] } }, select: { id: true } }),
      this.prisma.runtimeComponentVersion.findFirst({ where: { OR: [
        { storedFilePath: { in: [absolute, real, relative] } },
        ...(relative.startsWith(`runtime-components${path.sep}versions${path.sep}`) ? [{ id, status: { in: absolute.endsWith(".part") ? ["queued", "downloading", "verifying"] : ["queued", "downloading", "verifying", "ready"] } }] : [])
      ] }, select: { id: true } })
    ]);
    if (artifact || component || version) return true;
    const index = batch ?? await this.createReferenceIndex();
    // Recheck rows changed since the batch began so concurrent alias references
    // are included without reloading and resolving the full inventory each time.
    if (batch) await this.refreshReferenceIndex(index, true);
    const candidate = path.dirname(absolute) === path.resolve(tmpdir()) ? absolute : await canonicalManagedReference(absolute);
    if (index.paths.has(candidate)) return true;
    if (index.errors.size) throw new Error(`引用路径无法安全确认，已暂停清理：${[...index.errors].slice(0,3).join("；")}`);
    return false;
  }
  async createReferenceIndex(): Promise<ReferenceIndex> {
    const index: ReferenceIndex = {since:new Date(),paths:new Set(),resolved:new Map(),errors:new Set()};
    await this.refreshReferenceIndex(index, false);
    return index;
  }
  private async refreshReferenceIndex(index: ReferenceIndex, changesOnly: boolean) {
    const where = {storedFilePath:{not:null},...(changesOnly?{updatedAt:{gte:index.since}}:{})};
    const [artifacts, components, versions] = await Promise.all([
      this.prisma.releaseArtifact.findMany({where,select:{storedFilePath:true}}),
      this.prisma.runtimeComponent.findMany({where,select:{storedFilePath:true}}),
      this.prisma.runtimeComponentVersion.findMany({where,select:{storedFilePath:true}})
    ]);
    const rows = [...artifacts,...versions,...components.map(row=>({storedFilePath:path.isAbsolute(row.storedFilePath!)?row.storedFilePath:path.join("runtime-components",row.storedFilePath!)}))];
    for (const row of rows) {
      const raw = row.storedFilePath!;
      try {
        let canonical = index.resolved.get(raw);
        if (!canonical || changesOnly) {
          canonical = await canonicalManagedReference(raw);
          index.resolved.set(raw,canonical);
        }
        index.paths.add(canonical);
      } catch (error) {
        // Keep the batch usable; each potentially affected job persists this
        // diagnostic and backs off instead of silently aborting the worker.
        index.errors.add(`${raw}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  async retry(id: string) {
    const job = await this.prisma.fileCleanupJob.findUnique({where:{id}});
    if (!job) return {ok:true,processed:false};
    if (job.blocked) throw new BadRequestException("该清理任务需要先人工核对异常路径");
    await this.processJob(job);
    return {ok:true,processed:true};
  }
  @Cron("15 * * * * *")
  @DrainableJob()
  async process() {
    if (this.busy) return;
    this.busy = true;
    try {
      const jobs = await this.prisma.fileCleanupJob.findMany({ where: { nextAttemptAt: { lte: new Date() }, blocked:false }, take: 50, orderBy: { nextAttemptAt: "asc" } });
      const index = jobs.length ? await this.createReferenceIndex() : undefined;
      for (const job of jobs) await this.processJob(job,index);
    } catch (error) { this.logger.warn(`文件清理调度失败：${String(error)}`); }
    finally { this.busy = false; }
  }
  private async processJob(job: FileCleanupJob, index?: ReferenceIndex) {
    try {
      // Both explicit retries and scheduled work use the same live safety checks.
      if (!await this.references(job.path,index)) {
        if (job.reason.startsWith("扫描")) {
          const stat = await fs.lstat(job.path).catch(()=>null);
          if (stat && Math.max(stat.mtimeMs,stat.ctimeMs)>Date.now()-24*60*60_000) throw new Error("文件近期发生变化，延后清理");
        }
        await unlinkManagedFile(job.path);
      }
      await this.prisma.fileCleanupJob.deleteMany({where:{id:job.id}});
    } catch (error) {
      await this.prisma.fileCleanupJob.updateMany({where:{id:job.id},data:{
        attempts:{increment:1},lastError:error instanceof Error?error.message.slice(0,1000):"文件清理失败",
        nextAttemptAt:new Date(Date.now()+Math.min(24*60*60_000,60_000*2**Math.min(job.attempts,10)))
      }});
    }
  }
  async deduplicate(absolute: string, fileHash: string, size: bigint) {
    const [artifacts, versions, components] = await Promise.all([
      this.prisma.releaseArtifact.findMany({ where: { source: "uploaded", fileHash, fileSizeBytes: size, storedFilePath: { not: null } }, select: { storedFilePath: true }, take: 20 }),
      this.prisma.runtimeComponentVersion.findMany({ where: { status: "ready", fileHash, fileSizeBytes: size, storedFilePath: { not: null } }, select: { storedFilePath: true }, take: 20 }),
      this.prisma.runtimeComponent.findMany({ where: { source: "uploaded", fileHash, fileSizeBytes: size, storedFilePath: { not: null } }, select: { storedFilePath: true }, take: 20 })
    ]);
    const candidates = [...artifacts, ...versions, ...components.map(row=>({storedFilePath:path.isAbsolute(row.storedFilePath!)?row.storedFilePath:path.join("runtime-components",row.storedFilePath!)}))];
    for (const row of candidates) {
      const swap = `${absolute}.link-${randomUUID()}`;
      try {
        const candidate = managedPath(row.storedFilePath!);
        if (candidate === absolute) continue;
        await assertSafeFile(candidate);
        await fs.link(candidate, swap);
        if (await hashStoredFile(swap) !== fileHash) continue;
        await fs.rename(swap, absolute);
        return true;
      } catch (error) {
        // Deduplication is optional; the newly verified original remains available on any failure.
        this.logger.warn(`文件复用未完成，保留独立副本：${(error as NodeJS.ErrnoException).code ?? "校验失败"}`);
      } finally { await this.removeOrQueue(swap,"复用临时链接清理"); }
    }
    return false;
  }
  async stageExisting(value: string, expectedHash: string | null, expectedSize: bigint | null) {
    const source = managedPath(value);
    const stat = await assertSafeFile(source);
    if (!expectedHash || expectedSize === null || BigInt(stat.size) !== expectedSize) throw new BadRequestException("已有文件缺失校验信息或大小不符，请重新获取");
    const folder = managedPath(".incoming");
    await fs.mkdir(folder, { recursive: true });
    const destination = path.join(folder, randomUUID());
    try {
      try { await fs.link(source, destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
      }
      if (BigInt((await fs.stat(destination)).size) !== expectedSize) throw new BadRequestException("已有文件大小发生变化，请重新获取");
      if (await hashStoredFile(destination) !== expectedHash.toLowerCase()) throw new BadRequestException("已有文件校验失败，请重新获取");
      return destination;
    } catch(error) { await this.removeOrQueue(destination,"复用源文件校验失败"); throw error; }
  }
}
