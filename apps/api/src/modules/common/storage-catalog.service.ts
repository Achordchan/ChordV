import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { Cron } from "@nestjs/schedule";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { DrainableJob } from "../../work-lifecycle";
import { PrismaService } from "./prisma.service";
import { FileMaintenanceService } from "./file-maintenance.service";
import { releaseArtifactStorageRoot } from "./release-center.utils";
import { runtimeVersionPath } from "./runtime-version-files";
import { canonicalManagedReference, cleanupPath, isManagedOrphan, managedPath } from "./storage-files";

type Reference = { label: string; protected: boolean; pending?:boolean; hash?: string | null };
type Entry = { id: string; name: string; category: string; sizeBytes: number; allocatedBytes: number; references: string[]; state: "referenced" | "orphan" | "protected" | "missing"; canCleanup: boolean; hash: string | null; modifiedAt: string | null; links: number };
type Snapshot = { diskFreeBytes?: number | null; scannedAt: string | null; entries: Entry[]; logicalBytes: number; allocatedBytes: number; hardlinkSavedBytes: number; warnings: string[] };
const AGE = 24*60*60_000;
@Injectable()
export class StorageCatalogService {
  private busy = false;
  private catalogId() { return createHash("sha256").update(releaseArtifactStorageRoot()).digest("hex"); }
  private async readSnapshot(): Promise<{snapshot: Snapshot; paths: Record<string,string>}> {
    const row = await this.prisma.storageCatalogSnapshot.findUnique({where:{id:this.catalogId()}});
    return row ? row.payload as unknown as {snapshot:Snapshot;paths:Record<string,string>} : {
      snapshot:{scannedAt:null,entries:[],logicalBytes:0,allocatedBytes:0,hardlinkSavedBytes:0,warnings:[]},paths:{}
    };
  }
  constructor(private readonly prisma: PrismaService, private readonly files: FileMaintenanceService) {}
  async list(page = 0, search = "", cleanupPage = 0) {
    const {snapshot} = await this.readSnapshot();
    const entries = snapshot.entries.filter(entry => `${entry.name} ${entry.references.join(" ")}`.toLowerCase().includes(search.toLowerCase()));
    const { entries: _entries, ...summary } = snapshot;
    return { ...summary, totalFiles: snapshot.entries.length, orphanCount: snapshot.entries.filter(entry=>entry.canCleanup).length,
      missingCount: snapshot.entries.filter(entry=>entry.state==="missing").length,
      reusableBytes: snapshot.entries.filter(entry=>entry.canCleanup).reduce((sum,entry)=>sum+(entry.links>1?0:entry.allocatedBytes),0),
      items: entries.slice(page*100, page*100+100), hasMore: entries.length>(page+1)*100,
      cleanupTotal: await this.prisma.fileCleanupJob.count(),
      cleanupJobs: await this.prisma.fileCleanupJob.findMany({ orderBy: [{createdAt:"asc"},{id:"asc"}], skip:cleanupPage*100, take:100 }) };
  }
  private async referenceMap() {
    const refs = new Map<string,Reference[]>();
    const warnings:string[]=[];
    const statuses:Record<string,string>={draft:"草稿",published:"已发布",archived:"已归档",queued:"等待获取",downloading:"下载中",verifying:"校验中",ready:"已保存",failed:"获取失败",unchanged:"内容未变化"};
    const add = async (raw: string, reference: Reference) => {
      try { const file=await canonicalManagedReference(raw);const list=refs.get(file)??[];list.push(reference);refs.set(file,list); }
      catch { warnings.push(`${reference.label}：引用路径异常 ${raw}，本次暂停孤立文件自动清理，请先在所属记录核对。`); }
    };
    const [artifacts, components, versions] = await Promise.all([
      this.prisma.releaseArtifact.findMany({ where: { storedFilePath: { not: null } }, include: { release: { select: { version: true, platform: true, status: true } } } }),
      this.prisma.runtimeComponent.findMany({ where: { storedFilePath: { not: null } } }),
      this.prisma.runtimeComponentVersion.findMany({ include: { component: { select: { kind: true, platform: true } } } })
    ]);
    for (const row of artifacts) await add(row.storedFilePath!, { label: `安装包 ${row.release.platform} ${row.release.version} · ${statuses[row.release.status]||row.release.status}`, protected:true, hash:row.fileHash });
    for (const row of components) await add(path.isAbsolute(row.storedFilePath!) ? row.storedFilePath! : path.join("runtime-components",row.storedFilePath!), { label:`旧组件 ${row.kind} ${row.platform}`, protected:true, hash:row.fileHash });
    for (const row of versions) {
      const running = ["queued","downloading","verifying"].includes(row.status);
      const protectedFile = running || row.status==="ready" || Boolean(row.storedFilePath);
      await add(runtimeVersionPath(row.id), { label:`组件 ${row.component.kind} ${row.component.platform} ${row.versionLabel || row.requestedVersion || row.id} · ${statuses[row.status]||row.status}`, pending:running, protected:protectedFile, hash:row.fileHash });
      if (row.storedFilePath) await add(row.storedFilePath, {label:`组件文件 ${row.component.kind} ${row.id}`,protected:true,hash:row.fileHash});
      if(running) await add(runtimeVersionPath(row.id)+".part", {label:`组件获取中 ${row.id}`,protected:true,pending:true});
    }
    return {refs,warnings};
  }
  async scan(signal: AbortSignal, progress: (value: { checked: number; message: string })=>void) {
    if (this.busy) throw new ConflictException("已有文件扫描正在进行，请稍后重试");
    this.busy = true;
    try {
      const referenceIndex = await this.referenceMap();
      const refs = referenceIndex.refs;
      const paths = new Map<string,string>(), entries: Entry[] = [], warnings: string[] = [...referenceIndex.warnings];
      const seenPaths = new Set<string>(), inodes = new Set<string>();
      let checked = 0, logicalBytes = 0, allocatedBytes = 0, hardlinkSavedBytes = 0;
      const root = releaseArtifactStorageRoot();
      const walk = async (directory: string, category: string, protectedTree = false, depth = 0): Promise<void> => {
        signal.throwIfAborted();
        if (depth > 40) { warnings.push(`目录层级过深：${directory}`); return; }
        const children = await fs.readdir(directory, {withFileTypes:true}).catch((error: NodeJS.ErrnoException) => {
          if(error.code!=="ENOENT") warnings.push(`无法读取 ${directory}：${error.code}`); return [];
        });
        for (const child of children) {
          signal.throwIfAborted();
          const absolute = path.join(directory,child.name);
          if (seenPaths.has(absolute)) continue;
          if (child.isSymbolicLink()) { warnings.push(`跳过符号链接：${absolute}`); continue; }
          if (child.isDirectory()) { await walk(absolute,category,protectedTree,depth+1); continue; }
          if (!child.isFile()) continue;
          const stat = await fs.lstat(absolute).catch(()=>null);
          if (!stat?.isFile()) continue;
          seenPaths.add(absolute); checked++;
          logicalBytes += stat.size;
          const key = `${stat.dev}:${stat.ino}`;
          if(!inodes.has(key)) { inodes.add(key); allocatedBytes += stat.blocks*512; }
          else hardlinkSavedBytes += stat.size;
          if (!protectedTree) {
            const references = refs.get(absolute) ?? [];
            const relative = path.relative(root,absolute);
            const known = category==="临时下载" || isManagedOrphan(relative);
            const protectedRef = references.some(ref=>ref.protected);
            const canCleanup = !referenceIndex.warnings.length && !protectedRef && known && Math.max(stat.mtimeMs,stat.ctimeMs) < Date.now()-AGE;
            const id = createHash("sha256").update(absolute).digest("hex"); paths.set(id,absolute);
            entries.push({id,name:category==="临时下载"?path.basename(absolute):relative,category,sizeBytes:stat.size,allocatedBytes:stat.blocks*512,links:stat.nlink,references:references.map(ref=>ref.label),hash:references.find(ref=>ref.hash)?.hash??null,state:protectedRef?"referenced":canCleanup?"orphan":"protected",canCleanup,modifiedAt:stat.mtime.toISOString()});
          }
          if(checked%200===0) progress({checked,message:`正在扫描${category}`});
        }
      };
      progress({checked:0,message:"正在核对托管文件引用"});
      await walk(root,"托管文件");
      for(const [absolute,references] of refs) {
        if(seenPaths.has(absolute) || !references.some(ref=>ref.protected)) continue;
        // Queue/downloading files may not have been created yet; missing ready/release files need attention.
        if(references.every(ref=>ref.pending)) continue;
        const accessError = await fs.lstat(absolute).then(()=>null).catch((error:NodeJS.ErrnoException)=>error);
        if (accessError?.code !== "ENOENT") { if(accessError)warnings.push(`文件暂不可读：${absolute} · ${accessError.code}`); continue; }
        entries.push({id:createHash("sha256").update(absolute).digest("hex"),name:path.relative(root,absolute),category:"托管文件",sizeBytes:0,allocatedBytes:0,links:0,references:references.map(ref=>ref.label),hash:null,state:"missing",canCleanup:false,modifiedAt:null});
      }
      for(const [category,base] of [["后台版本",process.env.CHORDV_SYSTEM_RELEASES_DIR],["数据库快照",process.env.CHORDV_SYSTEM_UPDATE_BACKUP_DIR]] as const) {
        if(!base) { warnings.push(`${category}目录未配置，本次未统计`); continue; }
        const before = logicalBytes, allocatedBefore = allocatedBytes;
        await walk(path.resolve(base),category,true);
        entries.push({id:category,name:path.resolve(base),category,sizeBytes:logicalBytes-before,allocatedBytes:allocatedBytes-allocatedBefore,links:1,references:[category==="后台版本"?"由后台更新保留策略管理，默认保留 3 个版本":"由迁移快照策略管理，默认保留 5 份"],hash:null,state:"protected",canCleanup:false,modifiedAt:null});
      }
      const tempEntries = await fs.readdir(tmpdir(), {withFileTypes:true});
      for(const entry of tempEntries) {
        const owned=/^chordv-(?:import|upload)-[a-f0-9-]{36}(?:\.[a-z0-9]+)?$/i.test(entry.name);
        if(!entry.isFile() || (!owned&&!/^[a-f0-9-]{36}\.[a-z0-9]+$/i.test(entry.name))) continue;
        const absolute = path.join(tmpdir(),entry.name);
        const stat = await fs.lstat(absolute).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") warnings.push(`临时文件暂不可读：${absolute} · ${error.code}`);
          return null;
        });
        if (!stat?.isFile()) continue;
        const id = createHash("sha256").update(absolute).digest("hex"); paths.set(id,absolute);
        const canCleanup = !referenceIndex.warnings.length&&owned&&Math.max(stat.mtimeMs,stat.ctimeMs)<Date.now()-AGE;
        logicalBytes+=stat.size; allocatedBytes+=stat.blocks*512;
        entries.push({id,name:entry.name,category:owned?"临时下载":"历史临时文件（归属未确认）",sizeBytes:stat.size,allocatedBytes:stat.blocks*512,links:stat.nlink,references:owned?[]:["无法确认归属，不自动删除"],hash:null,state:canCleanup?"orphan":"protected",canCleanup,modifiedAt:stat.mtime.toISOString()});
      }
      const disk = await fs.statfs(root).catch(()=>null);
      const snapshot: Snapshot = {scannedAt:new Date().toISOString(),entries,logicalBytes,allocatedBytes,hardlinkSavedBytes,warnings:warnings.length>100?[...warnings.slice(0,99),`另有 ${warnings.length-99} 条范围说明未展开`]:warnings,diskFreeBytes:disk?disk.bavail*disk.bsize:null};
      const payload = {snapshot,paths:Object.fromEntries(paths)} as unknown as Prisma.InputJsonValue;
      await this.prisma.storageCatalogSnapshot.upsert({where:{id:this.catalogId()},create:{id:this.catalogId(),payload},update:{payload}});
      return this.list();
    } finally { this.busy=false; }
  }
  async cleanup(ids: string[]) {
    const {snapshot,paths} = await this.readSnapshot();
    if (!snapshot.scannedAt) throw new BadRequestException("请先扫描文件");
    const candidates = ids.map(id=>snapshot.entries.find(entry=>entry.id===id));
    if(candidates.some(entry=>!entry?.canCleanup)) throw new BadRequestException("仅可清理扫描确认的过期未引用文件");
    const index = candidates.length ? await this.files.createReferenceIndex() : undefined;
    for(const entry of candidates) {
      const absolute = paths[entry!.id];
      const stat = await fs.lstat(cleanupPath(absolute)).catch(()=>null);
      if(!stat || Math.max(stat.mtimeMs,stat.ctimeMs)>Date.now()-AGE || await this.files.references(absolute,index)) continue;
      await this.files.enqueue(absolute,"扫描发现的过期未引用文件");
    }
    await this.files.process(); return {ok:true};
  }
  @Cron("0 10 4 * * *")
  @DrainableJob()
  async recoverOrphans() {
    if(this.busy) return;
    await this.scan(AbortSignal.timeout(10*60_000),()=>undefined);
    const {snapshot} = await this.readSnapshot();
    await this.cleanup(snapshot.entries.filter(entry=>entry.canCleanup).map(entry=>entry.id));
  }
}
