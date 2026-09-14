import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { Prisma, RuntimeComponent } from "@prisma/client";
import * as path from "node:path";
import { DrainableJob } from "../../work-lifecycle";
import { ClientEventsPublisher } from "./client-events.publisher";
import { PrismaService } from "./prisma.service";
import { AdminRuntimeEventsService } from "./admin-runtime-events.service";
import { parseGithubLatestDownloadUrl } from "./github-latest-release";
import { prepareRuntimeVersion, runtimeVersionPath, runtimeVersionUrl } from "./runtime-version-files";

export type RuntimeSourceInput = { componentId: string; sourceUrl: string; version?: string; autoLatest: boolean };
const EVERY_SIX_HOURS = 6 * 60 * 60_000;
@Injectable()
export class RuntimeVersionService {
  private busy = false;
  private readonly logger = new Logger(RuntimeVersionService.name);
  constructor(private readonly prisma: PrismaService, private readonly events: AdminRuntimeEventsService, @Optional() private readonly clientEvents?: ClientEventsPublisher) {}
  private publish() { try { this.events.publish({ type: "runtime_component_updated", occurredAt: new Date().toISOString() }); } catch (error) { this.logger.warn("组件状态事件发送失败"); } }
  async withLegacyEdit<T>(componentId: string, action: (tx: Prisma.TransactionClient) => Promise<T>, enabledOnly = false): Promise<T> {
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "RuntimeComponent" WHERE id = ${componentId} FOR UPDATE`;
      const policy = await tx.runtimeComponentDelivery.findUnique({ where: { componentId } });
      if (policy && !enabledOnly) throw new BadRequestException("该组件已配置固定版本获取，请在运行组件页管理；上传与镜像页仅可调整启用状态。");
      return action(tx);
    });
  }
  async createSlot(input: {kind: "xray" | "geoip" | "geosite"; platform: "windows" | "macos" | "android" | "ios"; architecture: "x64" | "arm64"; sourceUrl: string}) {
    const platform = input.kind === "xray" ? input.platform : "macos";
    const architecture = input.kind === "xray" ? input.architecture : "arm64";
    const existing = await this.prisma.runtimeComponent.findFirst({where: input.kind === "xray" ? {kind:input.kind,platform,architecture} : {kind:input.kind}});
    if(existing) throw new BadRequestException("该组件已存在，请在对应行选择版本或设置来源");
    return this.prisma.runtimeComponent.create({data:{id:randomUUID(),kind:input.kind,platform,architecture,source:"custom_remote",originUrl:input.sourceUrl,fileName:input.kind === "xray" ? "xray" : input.kind + ".dat",enabled:false,allowClientMirror:false}});
  }
  async list() {
    const components = await this.prisma.runtimeComponent.findMany({ orderBy: [{ kind: "asc" }, { platform: "asc" }] });
    const policies = await this.prisma.runtimeComponentDelivery.findMany();
    const rows = await Promise.all(components.map(async component => {
      const versions = await this.prisma.runtimeComponentVersion.findMany({ where: { componentId: component.id }, orderBy: { createdAt: "desc" }, take: 20 });
      const policy = policies.find(p => p.componentId === component.id);
      const active = policy?.activeVersionId ? await this.prisma.runtimeComponentVersion.findUnique({ where: { id: policy.activeVersionId } }) : null;
      const serialize = (v: typeof versions[number]) => ({ ...v, fileSizeBytes: v.fileSizeBytes?.toString() ?? null, bytesReceived: v.bytesReceived.toString(), storedFilePath: undefined });
      return { id: component.id, kind: component.kind, platform: component.platform, architecture: component.architecture,
        sourceUrl: policy?.sourceUrl ?? component.originUrl, autoLatest: policy?.autoLatest ?? false, enabled: component.enabled,
        managed: Boolean(policy), active: active ? serialize(active) : null, versions: versions.map(serialize) };
    }));
    return rows;
  }
  async acquire(input: RuntimeSourceInput) {
    const component = await this.prisma.runtimeComponent.findUnique({ where: { id: input.componentId } });
    if (!component) throw new NotFoundException("组件不存在");
    let url: URL; try { url = new URL(input.sourceUrl.trim()); } catch { throw new BadRequestException("请填写有效来源地址"); }
    if (url.protocol !== "https:" || url.username || url.password) throw new BadRequestException("组件来源必须是无凭据的 HTTPS 地址");
    const latest = parseGithubLatestDownloadUrl(url.href);
    if ((component.kind === "xray" && input.autoLatest) || (!input.autoLatest && latest)) throw new BadRequestException("Xray 必须指定固定版本，不能跟随 latest");
    if (input.autoLatest && !latest) throw new BadRequestException("自动获取最新需填写 GitHub latest/download 文件地址");
    const version = input.version?.trim() || null;
    if (!latest && !version) throw new BadRequestException("请填写固定版本号");
    const tag = url.hostname === "github.com" ? url.pathname.match(/\/releases\/download\/([^/]+)\//)?.[1] : null;
    if (tag && decodeURIComponent(tag) !== version) throw new BadRequestException("所选版本与 GitHub 下载地址中的标签不一致");
    const job = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "RuntimeComponent" WHERE id = ${component.id} FOR UPDATE`;
      const current = await tx.runtimeComponent.findUnique({ where: { id: component.id } });
      if (!current || current.kind !== component.kind || current.platform !== component.platform || current.architecture !== component.architecture) throw new BadRequestException("组件目标已变更，请刷新后重试");
      const pending = await tx.runtimeComponentVersion.findFirst({ where: { componentId: component.id, status: { in: ["queued", "downloading", "verifying"] } } });
      if (pending) throw new BadRequestException("已有获取任务，请等待完成");
      await tx.runtimeComponentDelivery.upsert({ where: { componentId: component.id },
        create: { componentId: component.id, sourceUrl: url.href, selectedVersion: version, autoLatest: input.autoLatest, nextCheckAt: new Date(Date.now() + EVERY_SIX_HOURS) },
        update: { sourceUrl: url.href, selectedVersion: version, autoLatest: input.autoLatest, nextCheckAt: new Date(Date.now() + EVERY_SIX_HOURS) } });
      return tx.runtimeComponentVersion.create({ data: { id: randomUUID(), componentId: component.id, sourceUrl: url.href, requestedVersion: version, autoActivate: input.autoLatest && component.kind !== "xray" } });
    });
    this.publish(); return { id: job.id };
  }
  async setAutoLatest(componentId: string, enabled: boolean) {
    await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "RuntimeComponent" WHERE id = ${componentId} FOR UPDATE`;
      const component = await tx.runtimeComponent.findUnique({ where: { id: componentId } });
      const policy = await tx.runtimeComponentDelivery.findUnique({ where: { componentId } });
      if (!component || !policy) throw new BadRequestException("请先配置获取来源");
      if (component.kind === "xray") throw new BadRequestException("Xray 只支持固定版本");
      if (enabled && !parseGithubLatestDownloadUrl(policy.sourceUrl)) throw new BadRequestException("请先设置 GitHub latest/download 来源");
      await tx.runtimeComponentDelivery.update({ where: { componentId }, data: { autoLatest: enabled, nextCheckAt: new Date() } });
    });
    this.publish(); return { ok: true };
  }
  async activate(id: string, automatic = false) {
    await this.prisma.$transaction(async tx => {
      const candidate = await tx.runtimeComponentVersion.findUnique({ where: { id } });
      if (!candidate) throw new BadRequestException("文件尚未准备好");
      await tx.$queryRaw`SELECT id FROM "RuntimeComponent" WHERE id = ${candidate.componentId} FOR UPDATE`;
      const version = await tx.runtimeComponentVersion.findUnique({ where: { id } });
      if (!version || version.status !== "ready") throw new BadRequestException("文件尚未准备好");
      await fs.access(runtimeVersionPath(id));
      const policy = await tx.runtimeComponentDelivery.findUnique({where:{componentId:version.componentId}});
      const component = await tx.runtimeComponent.findUnique({where:{id:version.componentId}});
      if(automatic && (!policy?.autoLatest || policy.sourceUrl !== version.sourceUrl || component?.kind === "xray")) return;
      await tx.runtimeComponent.update({ where: { id: version.componentId }, data: { enabled: true } });
      await tx.runtimeComponentDelivery.update({ where: { componentId: version.componentId }, data: { activeVersionId: id, notifyPending: true } });
      await tx.runtimeComponentVersion.update({ where: { id }, data: { publishedAt: new Date() } });
    });
    this.publish();
    await this.flushNotifications();
    return { ok: true };
  }
  private notifying = false;
  @Cron("*/30 * * * * *")
  @DrainableJob()
  async flushNotifications() {
    if (!this.clientEvents || this.notifying) return;
    this.notifying = true;
    try {
      const pending = await this.prisma.runtimeComponentDelivery.findMany({where:{notifyPending:true},include:{component:true},take:50});
      for (const policy of pending) {
        await this.clientEvents.publishRuntimeComponentsUpdated(policy.component.kind === "xray" ? policy.component.platform : null);
        await this.prisma.runtimeComponentDelivery.updateMany({where:{componentId:policy.componentId,activeVersionId:policy.activeVersionId,notifyPending:true},data:{notifyPending:false}});
      }
    } catch (error) { this.logger.warn("组件启用已保存，客户端通知待重试：" + (error instanceof Error ? error.message : String(error))); }
    finally { this.notifying = false; }
  }
  // Persistent work is claimed atomically across API processes. UI progress uses SSE.
  @Cron("*/10 * * * * *")
  @DrainableJob()
  async processPending() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.prisma.runtimeComponentVersion.updateMany({ where: { status: { in: ["downloading", "verifying"] }, updatedAt: { lt: new Date(Date.now() - 15 * 60_000) } }, data: { status: "failed", lastError: "获取任务中断，请重新获取" } });
      const job = await this.prisma.runtimeComponentVersion.findFirst({ where: { status: "queued" }, orderBy: { createdAt: "asc" } });
      if (!job) return;
      const claim = await this.prisma.runtimeComponentVersion.updateMany({ where: { id: job.id, status: "queued" }, data: { status: "downloading" } });
      if (!claim.count) return;
      this.publish();
      try {
        const component = await this.prisma.runtimeComponent.findUnique({ where: { id: job.componentId } });
        if (!component) throw new NotFoundException("组件不存在");
        const result = await prepareRuntimeVersion(job.sourceUrl, job.requestedVersion, job.id, async (bytesReceived, status) => {
          await this.prisma.runtimeComponentVersion.update({ where: { id: job.id }, data: { bytesReceived, status } }); this.publish();
        }, component);
        const policy = await this.prisma.runtimeComponentDelivery.findUnique({ where: { componentId: job.componentId } });
        const activeVersion = policy?.activeVersionId ? await this.prisma.runtimeComponentVersion.findUnique({ where: { id: policy.activeVersionId } }) : null;
        if (job.autoActivate && activeVersion?.fileHash === result.fileHash) {
          await fs.rm(runtimeVersionPath(job.id), { force: true });
          await this.prisma.runtimeComponentVersion.update({ where: { id: job.id }, data: { ...result, status: "unchanged", storedFilePath: null } });
          this.publish(); return;
        }
        await this.prisma.runtimeComponentVersion.update({ where: { id: job.id }, data: { ...result, status: "ready", lastError: null } });
        if (job.autoActivate) await this.activate(job.id, true);
        this.publish();
      } catch (error) {
        await this.prisma.runtimeComponentVersion.update({ where: { id: job.id }, data: { status: "failed", lastError: error instanceof Error ? error.message : "组件获取失败" } }); this.publish();
      }
    } catch (error) { this.logger.error("组件获取调度失败", error); }
    finally { this.busy = false; }
  }
  @Cron("0 */5 * * * *")
  @DrainableJob()
  async scheduleLatest() {
    const due = await this.prisma.runtimeComponentDelivery.findMany({ where: { autoLatest: true, nextCheckAt: { lte: new Date() } }, take: 20 });
    for (const policy of due) {
      try {
        await this.prisma.$transaction(async tx => {
          await tx.$queryRaw`SELECT id FROM "RuntimeComponent" WHERE id = ${policy.componentId} FOR UPDATE`;
          const current = await tx.runtimeComponentDelivery.findUnique({ where: { componentId: policy.componentId } });
          const component = await tx.runtimeComponent.findUnique({ where: { id: policy.componentId } });
          if (!current?.autoLatest || current.nextCheckAt > new Date() || !component || component.kind === "xray") return;
          if (!parseGithubLatestDownloadUrl(current.sourceUrl)) return;
          const pending = await tx.runtimeComponentVersion.findFirst({ where: { componentId: component.id, status: { in: ["queued", "downloading", "verifying"] } } });
          if (pending) return;
          await tx.runtimeComponentDelivery.update({ where: { componentId: component.id }, data: { nextCheckAt: new Date(Date.now() + EVERY_SIX_HOURS) } });
          await tx.runtimeComponentVersion.create({ data: { id: randomUUID(), componentId: component.id, sourceUrl: current.sourceUrl, autoActivate: true } });
        });
      }
      catch (error) { this.logger.warn(error instanceof Error ? error.message : "规则获取排队失败"); }
    }
  }
  async clientRows<T extends RuntimeComponent>(rows: T[]): Promise<Array<T & { runtimeVersionLabel?: string }>> {
    const policies = await this.prisma.runtimeComponentDelivery.findMany({ where: { componentId: { in: rows.map(r => r.id) } } });
    const result: Array<T & { runtimeVersionLabel?: string }> = [];
    for (const row of rows) {
      const policy = policies.find(p => p.componentId === row.id);
      if (!policy?.activeVersionId) { result.push(row); continue; }
      const version = await this.prisma.runtimeComponentVersion.findUnique({ where: { id: policy.activeVersionId } });
      if (!version || version.status !== "ready" || !version.storedFilePath) continue;
      result.push({ ...row, source: "uploaded", originUrl: runtimeVersionUrl(version.id), fileName: version.fileName || row.fileName,
        // Existing storage validator resolves absolute paths under the releases root/runtime-components.
        storedFilePath: version.storedFilePath, fileSizeBytes: version.fileSizeBytes, fileHash: version.fileHash, expectedHash: version.fileHash,
        archiveEntryName: row.kind === "xray" ? (row.platform === "windows" ? "xray.exe" : "xray") : null,
        runtimeVersionLabel: version.versionLabel ?? undefined, defaultMirrorPrefix: null, allowClientMirror: false, updatedAt: version.publishedAt ?? version.updatedAt });
    }
    return result;
  }
  async download(id: string) {
    const version = await this.prisma.runtimeComponentVersion.findUnique({ where: { id } });
    if (!version?.publishedAt || version.status !== "ready") throw new NotFoundException("文件不可下载");
    return { absolutePath: runtimeVersionPath(id), fileName: version.fileName || "component.bin" };
  }

  // Keep active data, the newest 20 historical versions, and a 30-day window
  // for offline-client downloads and operator rollback. Running jobs are never pruned.
  @Cron("0 30 3 * * *")
  @DrainableJob()
  async pruneVersions() {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60_000);
    const policies = await this.prisma.runtimeComponentDelivery.findMany({ select: { componentId: true } });
    for (const policy of policies) {
      try {
        await this.prisma.$transaction(async tx => {
          await tx.$queryRaw`SELECT id FROM "RuntimeComponent" WHERE id = ${policy.componentId} FOR UPDATE`;
          const current = await tx.runtimeComponentDelivery.findUnique({ where: { componentId: policy.componentId } });
          const expired = await tx.runtimeComponentVersion.findMany({
            where: { componentId: policy.componentId, status: { in: ["ready", "failed", "unchanged"] },
              createdAt: { lt: cutoff }, OR: [{ publishedAt: null }, { publishedAt: { lt: cutoff } }],
              ...(current?.activeVersionId ? { id: { not: current.activeVersionId } } : {}) },
            orderBy: { createdAt: "desc" }, skip: 20, take: 200
          });
          for (const version of expired) {
            await fs.rm(runtimeVersionPath(version.id), { force: true });
            await fs.rm(`${runtimeVersionPath(version.id)}.part`, { force: true });
            await tx.runtimeComponentVersion.delete({ where: { id: version.id } });
          }
        }, { timeout: 30_000 });
      } catch (error) { this.logger.warn(`组件历史清理失败：${String(error)}`); }
    }
    // Cascading component deletion removes rows, not files. Only remove
    // orphaned UUID assets older than a day, never paths supplied by a record.
    const directory = path.dirname(runtimeVersionPath("00000000-0000-0000-0000-000000000000"));
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []; throw error;
    });
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9-]{36}(?:\.part)?$/.test(entry.name)) continue;
      const filename = path.join(directory, entry.name);
      const stat = await fs.stat(filename).catch(() => null);
      if (!stat || stat.mtimeMs > Date.now() - 24 * 60 * 60_000) continue;
      const id = entry.name.replace(/\.part$/, "");
      if (!await this.prisma.runtimeComponentVersion.findUnique({ where: { id } })) await fs.rm(filename, { force: true });
    }
  }
}
