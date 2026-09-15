import "reflect-metadata";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { PrismaClient } from "@prisma/client";
import { FileMaintenanceService } from "../src/modules/common/file-maintenance.service";
import { StorageCatalogService } from "../src/modules/common/storage-catalog.service";
import { ReleaseCenterService } from "../src/modules/common/release-center.service";
import { RuntimeVersionService } from "../src/modules/common/runtime-version.service";
import { runtimeVersionPath } from "../src/modules/common/runtime-version-files";

async function main() {
  assert.equal(process.env.CHORDV_FILE_TEST_ISOLATED, "1", "Run only against the disposable integration database");
  const root=process.env.CHORDV_RELEASE_STORAGE_ROOT!;
  assert.ok(root.includes("chordv-files-test-"));
  const prisma=new PrismaClient();
  const files=new FileMaintenanceService(prisma as never);
  const events={publishReleaseCenterUpdated(){},publishVersionUpdated(){},publish(){}};
  const releases=new ReleaseCenterService(prisma as never,{} as never,events as never,{getEffectiveConfig:async()=>({defaultMirrorPrefix:null,allowClientMirror:false})} as never,files);
  const catalog=new StorageCatalogService(prisma as never,files);
  const versions=new RuntimeVersionService(prisma as never,events as never,files);
  try {
    for(const [id,version] of [["release_first","1.1.8"],["release_second","1.1.9"]]) await prisma.release.create({data:{id,version,platform:"macos",channel:"stable",displayTitle:version,changelog:[],minimumVersion:"0.0.0"}});
    const bytes=Buffer.from("file-management-test-package".repeat(200));
    const source=path.join(root,".incoming",randomUUID());await fs.mkdir(path.dirname(source),{recursive:true});await fs.writeFile(source,bytes);
    const first=await releases.uploadReleaseArtifact("release_first",{type:"dmg",isPrimary:true},{path:source,originalname:"ChordV.dmg",size:bytes.length,sourceUrl:"https://example.test/ChordV.dmg"});
    const firstId=first.artifacts[0].id;
    const original=await prisma.releaseArtifact.findUniqueOrThrow({where:{id:firstId}});
    assert.equal(original.sourceUrl,"https://example.test/ChordV.dmg");
    const second=await releases.reuseReleaseArtifact("release_second",firstId);
    const secondId=second.artifacts[0].id;
    const copied=await prisma.releaseArtifact.findUniqueOrThrow({where:{id:secondId}});
    const originalPath=path.join(root,original.storedFilePath!);let copiedPath=path.join(root,copied.storedFilePath!);
    assert.equal((await fs.stat(originalPath)).ino,(await fs.stat(copiedPath)).ino,"reused files share physical storage without sharing paths");
    await releases.reuseReleaseArtifact("release_second",firstId);
    assert.equal(await prisma.releaseArtifact.count({where:{releaseId:"release_second"}}),1,"reusing identical content must not create duplicate records");
    await files.process();
    copiedPath=path.join(root,(await prisma.releaseArtifact.findUniqueOrThrow({where:{id:secondId}})).storedFilePath!);
    await fs.unlink(copiedPath);
    await releases.reuseReleaseArtifact("release_second",firstId);
    const repaired=await prisma.releaseArtifact.findUniqueOrThrow({where:{id:secondId}});copiedPath=path.join(root,repaired.storedFilePath!);
    assert.deepEqual(await fs.readFile(copiedPath),bytes,"an identical re-import repairs a missing file instead of retaining a broken record");
    await prisma.release.update({where:{id:"release_second"},data:{status:"published"}});
    const client=await releases.checkClientUpdate({currentVersion:"1.0.0",platform:"macos",channel:"stable",artifactType:"dmg"});
    assert.ok(client.recommendedArtifact);assert.equal("sourceUrl" in client.recommendedArtifact!,false,"acquisition URLs must remain admin-only");
    await prisma.release.update({where:{id:"release_second"},data:{status:"draft"}});
    await files.enqueue(copiedPath,"测试使用中保护");await files.process();
    assert.deepEqual(await fs.readFile(copiedPath),bytes,"referenced files must not be removed");
    await releases.deleteReleaseArtifact("release_first",firstId);
    assert.ok(await prisma.fileCleanupJob.count()>0,"deletion must persist cleanup before returning");
    await new FileMaintenanceService(prisma as never).process();
    await assert.rejects(()=>fs.stat(originalPath));
    assert.deepEqual(await fs.readFile(copiedPath),bytes,"removing source must preserve reused data");

    const victim=path.join(root,"release_orphan","artifact_test","file_test_symlink");await fs.mkdir(path.dirname(victim),{recursive:true});
    const outside=path.join(path.dirname(root),"outside.txt");await fs.writeFile(outside,"must survive");await fs.symlink(outside,victim);
    const job=await files.enqueue(victim,"测试删除失败持久化");await files.process();
    const failed=await prisma.fileCleanupJob.findUniqueOrThrow({where:{id:job.id}});
    assert.equal(failed.attempts,1);assert.ok(failed.lastError);assert.equal(await fs.readFile(outside,"utf8"),"must survive");
    const blocked=await files.enqueue(outside,"测试越界路径保护");
    assert.equal(blocked.blocked,true);await files.process();assert.equal(await fs.readFile(outside,"utf8"),"must survive");
    await fs.unlink(victim);await fs.writeFile(victim,"owned-file");await files.retry(job.id);
    assert.equal(await prisma.fileCleanupJob.count({where:{id:job.id}}),0);
    await assert.rejects(()=>fs.stat(victim));

    // A failure after the temporary file has moved must clean the final path as well.
    const bad=path.join(root,".incoming",randomUUID());await fs.mkdir(path.dirname(bad),{recursive:true});await fs.writeFile(bad,"bad");
    const realDedup=files.deduplicate.bind(files);files.deduplicate=async()=>{throw new Error("injected preparation failure");};
    await assert.rejects(()=>releases.uploadReleaseArtifact("release_second",{type:"dmg"},{path:bad,originalname:"bad.dmg",size:3}));files.deduplicate=realDedup;
    assert.equal(await prisma.releaseArtifact.count({where:{releaseId:"release_second"}}),1);
    const afterFailure=await catalog.scan(new AbortController().signal,()=>{});
    assert.ok(!afterFailure.items.some(item=>item.name.endsWith("bad.dmg")),"failed preparation must not orphan the moved file");

    // Refuse installation mutation once the release became published during file preparation.
    const raceSource=path.join(root,".incoming",randomUUID());await fs.mkdir(path.dirname(raceSource),{recursive:true});await fs.writeFile(raceSource,bytes);
    files.deduplicate=async()=>{await prisma.release.update({where:{id:"release_second"},data:{status:"published"}});return false;};
    await assert.rejects(()=>releases.uploadReleaseArtifact("release_second",{type:"dmg"},{path:raceSource,originalname:"raced.dmg",size:bytes.length}));files.deduplicate=realDedup;
    await prisma.release.update({where:{id:"release_second"},data:{status:"draft"}});

    const componentId=randomUUID();await prisma.runtimeComponent.create({data:{id:componentId,platform:"macos",architecture:"arm64",kind:"geoip",source:"custom_remote",originUrl:"https://example.test/geoip.dat",fileName:"geoip.dat",enabled:true}});
    const ids:string[]=[];
    for(let i=0;i<22;i++) {
      const id=randomUUID();ids.push(id);const file=runtimeVersionPath(id);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);
      await prisma.runtimeComponentVersion.create({data:{id,componentId,sourceUrl:"https://example.test/geoip.dat",requestedVersion:String(i),status:"ready",storedFilePath:file,fileSizeBytes:BigInt(bytes.length),fileHash:createHash("sha256").update(bytes).digest("hex"),createdAt:new Date(Date.now()-(i===21?0:60*24*60*60_000)+(i*1000))}});
    }
    await prisma.runtimeComponentDelivery.create({data:{componentId,sourceUrl:"https://example.test/geoip.dat",activeVersionId:ids[0]}});
    const reused=await versions.acquire({componentId,sourceUrl:"https://example.test/geoip.dat",version:"21",autoLatest:false});assert.equal(reused.id,ids[21]);assert.equal(reused.reused,true);
    await assert.rejects(()=>versions.deleteVersion(ids[0]),/不能删除/);
    const originalEnqueue=files.enqueue.bind(files);files.enqueue=async()=>{throw new Error("injected queue persistence failure");};
    await versions.pruneVersions();assert.equal(await prisma.runtimeComponentVersion.count({where:{componentId}}),22,"database retention must roll back when queue creation fails");
    for(const id of ids) await fs.access(runtimeVersionPath(id));files.enqueue=originalEnqueue;
    await versions.pruneVersions();assert.equal(await prisma.runtimeComponentVersion.count({where:{componentId}}),21,"retain global newest 20 plus active, not 20 extra expired rows");
    await files.process();await fs.access(runtimeVersionPath(ids[0]));
    await versions.activate(ids[21]);
    const oldActive=await prisma.runtimeComponentVersion.findUniqueOrThrow({where:{id:ids[0]}});
    assert.ok(oldActive.retainUntil && oldActive.retainUntil.getTime()>Date.now()+29*24*60*60_000,"deactivating a long-lived version starts a fresh compatibility grace period");
    await assert.rejects(()=>versions.deleteVersion(ids[0]),/保留 30 天/);
    const history=await versions.history(componentId);assert.equal(history.items.length,20);assert.equal(history.hasMore,true);

    // Same-size corruption must queue a replacement, not reuse the damaged version.
    await fs.writeFile(runtimeVersionPath(ids[21]),Buffer.alloc(bytes.length,42));
    const reacquired=await versions.acquire({componentId,sourceUrl:"https://example.test/geoip.dat",version:"21",autoLatest:false});
    assert.equal(reacquired.reused,false);assert.notEqual(reacquired.id,ids[21]);

    // A malformed legacy candidate must not prevent valid new content from being saved.
    const invalidId=randomUUID();
    await prisma.releaseArtifact.create({data:{id:invalidId,releaseId:"release_second",source:"uploaded",type:"dmg",downloadUrl:"https://example.test/invalid.dmg",storedFilePath:outside,fileHash:"invalid-candidate-test",fileSizeBytes:3n}});
    const independent=path.join(root,".incoming",randomUUID());await fs.mkdir(path.dirname(independent),{recursive:true});await fs.writeFile(independent,"new");
    assert.equal(await files.deduplicate(independent,"invalid-candidate-test",3n),false);
    assert.equal(await fs.readFile(independent,"utf8"),"new");
    await prisma.releaseArtifact.delete({where:{id:invalidId}});

    // Downloads may remove their temporary entry after readdir but before lstat.
    const disappearing=path.join(tmpdir(),`chordv-upload-${randomUUID()}.dmg`);
    await fs.writeFile(disappearing,"temporary");
    const realLstat=fs.lstat;
    fs.lstat=(async (...args: Parameters<typeof fs.lstat>)=>{
      if(String(args[0])===disappearing) await fs.unlink(disappearing);
      return realLstat(...args);
    }) as typeof fs.lstat;
    try { await catalog.scan(new AbortController().signal,()=>{}); }
    finally { fs.lstat=realLstat;await fs.unlink(disappearing).catch(()=>{}); }

    const orphan=path.join(root,"release_orphan","artifact_test","file_test_old.dmg");await fs.mkdir(path.dirname(orphan),{recursive:true});await fs.writeFile(orphan,"orphan");
    const realNow=Date.now;Date.now=()=>realNow()+48*60*60_000;
    try{const scan=await catalog.scan(new AbortController().signal,()=>{});const entry=scan.items.find(item=>item.name.endsWith("file_test_old.dmg"));assert.equal(entry?.canCleanup,true);const anotherProcess=new StorageCatalogService(prisma as never,new FileMaintenanceService(prisma as never));assert.equal((await anotherProcess.list()).scannedAt,scan.scannedAt,"fresh service must read shared scan state");await anotherProcess.cleanup([entry!.id]);await assert.rejects(()=>fs.access(orphan));await fs.access(copiedPath);}finally{Date.now=realNow;}
    console.log("PASS: real PostgreSQL + files: reuse/dedup, source deletion protection, durable failure retry, preparation rollback, published guard, history retention and orphan recovery");
  } finally {await prisma.$disconnect();}
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
