import assert from "node:assert/strict";
import { RuntimeVersionService } from "../src/modules/common/runtime-version.service";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { runtimeVersionPath } from "../src/modules/common/runtime-version-files";

async function main() {
  let locked = false, enabled = false, created = 0;
  const sourceUrl = "https://github.com/example/rules/releases/latest/download/geoip.dat";
  const tx = {
    $queryRaw: async () => { locked = true; },
    runtimeComponent: { findUnique: async () => ({ id: "one", kind: "geoip" }) },
    runtimeComponentDelivery: {
      findUnique: async () => { assert.equal(locked, true); return { autoLatest: enabled, sourceUrl, nextCheckAt: new Date(0) }; },
      update: async ({ data }: any) => { assert.deepEqual(Object.keys(data), ["nextCheckAt"]); }
    },
    runtimeComponentVersion: { findFirst: async () => null, create: async ({data}: any) => { assert.equal(data.sourceUrl, sourceUrl); created++; } }
  };
  const prisma = {
    runtimeComponentDelivery: {findMany: async () => [{componentId:"one",autoLatest:true,sourceUrl:"stale-source"}]},
    $transaction: async (run: any) => run(tx)
  };
  const service = new RuntimeVersionService(prisma as never, {publish(){}} as never);
  await assert.rejects(service.createSlot({kind:"xray",platform:"ios",architecture:"arm64",sourceUrl}),/iOS/);
  await service.scheduleLatest();
  assert.equal(created,0,"管理员关闭开关后不能使用调度旧快照入队");
  enabled=true;locked=false;
  await service.scheduleLatest();
  assert.equal(created,1,"仅使用锁内重读的有效来源入队");

  const rows = new RuntimeVersionService({
    runtimeComponentDelivery:{findMany:async()=>[{componentId:"one",activeVersionId:"version"}]},
    runtimeComponentVersion:{findUnique:async()=>({id:"version",status:"ready",storedFilePath:"versions/version",fileHash:"new-hash",fileSizeBytes:1n,updatedAt:new Date()})}
  } as never, {publish(){}} as never);
  const result = await rows.clientRows([{id:"one",kind:"xray",platform:"windows",expectedHash:"old-hash",archiveEntryName:"custom.exe"}] as never);
  assert.equal(result[0].expectedHash,"new-hash","旧组件 expectedHash 不得污染启用版本");
  assert.equal(result[0].archiveEntryName,"xray.exe");
  const guarded = new RuntimeVersionService({$transaction:async (fn:any)=>fn({
    $queryRaw:async()=>[],runtimeComponentDelivery:{findUnique:async()=>({activeVersionId:null})}
  })} as never,{publish(){}} as never);
  let edited=false;
  await assert.rejects(guarded.withLegacyEdit("one",async()=>{edited=true;}),/固定版本/);
  assert.equal(edited,false);
  await guarded.withLegacyEdit("one",async()=>{edited=true;},true);
  assert.equal(edited,true,"启用状态调整仍可保存");
  let lockedSource=false;
  const autoGuard=new RuntimeVersionService({$transaction:async(fn:any)=>fn({
    $queryRaw:async()=>{lockedSource=true;},
    runtimeComponent:{findUnique:async()=>({kind:"geoip"})},
    runtimeComponentDelivery:{findUnique:async()=>{assert.equal(lockedSource,true);return {sourceUrl:"https://example.com/fixed.dat"};}, update:async()=>{throw new Error("unexpected write");}}
  })} as never,{publish(){}} as never);
  await assert.rejects(autoGuard.setAutoLatest("one",true),/latest/);
  const root=await fs.mkdtemp(path.join(tmpdir(),"chordv-orphan-test-"));
  const previous=process.env.CHORDV_RELEASE_STORAGE_ROOT;
  process.env.CHORDV_RELEASE_STORAGE_ROOT=root;
  try {
    const old=runtimeVersionPath("00000000-0000-0000-0000-000000000001");
    const recent=runtimeVersionPath("00000000-0000-0000-0000-000000000002")+".part";
    await fs.mkdir(path.dirname(old),{recursive:true});await fs.writeFile(old,"orphan");await fs.writeFile(recent,"in-flight");await fs.utimes(old,0,0);
    const cleanup=new RuntimeVersionService({runtimeComponentDelivery:{findMany:async()=>[]},runtimeComponentVersion:{findUnique:async()=>null}} as never,{publish(){}} as never);
    await cleanup.pruneVersions();
    await assert.rejects(fs.access(old));await fs.access(recent);
    const versionId="00000000-0000-0000-0000-000000000003";
    await fs.writeFile(runtimeVersionPath(versionId),"validated-file");
    let componentEnabled=false;
    const activation=new RuntimeVersionService({$transaction:async(fn:any)=>fn({
      $queryRaw:async()=>[],
      runtimeComponentVersion:{findUnique:async()=>({id:versionId,componentId:"one",status:"ready",sourceUrl}),update:async()=>({})},
      runtimeComponentDelivery:{findUnique:async()=>({autoLatest:true,sourceUrl}),update:async()=>({})},
      runtimeComponent:{findUnique:async()=>({kind:"geoip",enabled:componentEnabled}),update:async()=>{componentEnabled=true;}}
    })} as never,{publish(){}} as never);
    await activation.activate(versionId,true);assert.equal(componentEnabled,false,"自动更新不重启已停用组件");
    await activation.activate(versionId,false);assert.equal(componentEnabled,true,"管理员显式启用仍能开启组件");
  } finally {
    if(previous===undefined)delete process.env.CHORDV_RELEASE_STORAGE_ROOT;else process.env.CHORDV_RELEASE_STORAGE_ROOT=previous;
    await fs.rm(root,{recursive:true,force:true});
  }
  console.log("component release safety regression passed");
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
