import assert from "node:assert/strict";
import { RuntimeVersionService } from "../src/modules/common/runtime-version.service";

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
  await service.scheduleLatest();
  assert.equal(created,0,"管理员关闭开关后不能使用调度旧快照入队");
  enabled=true;locked=false;
  await service.scheduleLatest();
  assert.equal(created,1,"仅使用锁内重读的有效来源入队");

  const rows = new RuntimeVersionService({
    runtimeComponentDelivery:{findMany:async()=>[{componentId:"one",activeVersionId:"version"}]},
    runtimeComponentVersion:{findUnique:async()=>({id:"version",status:"ready",storedFilePath:"versions/version",fileHash:"new-hash",fileSizeBytes:1n,updatedAt:new Date()})}
  } as never, {publish(){}} as never);
  const result = await rows.clientRows([{id:"one",expectedHash:"old-hash"}] as never);
  assert.equal(result[0].expectedHash,"new-hash","旧组件 expectedHash 不得污染启用版本");
  console.log("component release safety regression passed");
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
