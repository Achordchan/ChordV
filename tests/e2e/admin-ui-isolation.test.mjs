import assert from "node:assert/strict";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { classifyFixtureOrigins, prepareAdminUIIsolation, readAdminUIPlan } from "./admin-ui-isolation.mjs";
import { loadLocalEnvironment } from "../../scripts/mygo-local-config.mjs";

test("admin UI prepare composes the existing isolation plan without starting services or exposing credentials",async()=>{
  const prepared=await prepareAdminUIIsolation();
  try {
    const plan=await readAdminUIPlan(prepared.planFile);
    assert.equal(new Set([plan.apiPort,plan.postgresPort,plan.imagePort,plan.adminPort]).size,4);
    for(const port of [plan.apiPort,plan.postgresPort,plan.imagePort,plan.adminPort])assert.ok(![3100,55437,5173,5174].includes(port));
    assert.equal((await stat(prepared.planFile)).mode&0o777,0o600);
    assert.equal(prepared.adminEnvironment.CHORDV_DEV_API_TARGET,`http://127.0.0.1:${plan.apiPort}`);
    assert.equal(prepared.adminEnvironment.CHORDV_ADMIN_PORT,String(plan.adminPort));
    const local=await loadLocalEnvironment({root:plan.root,env:{CHORDV_LOCAL_API_PORT:String(plan.apiPort),CHORDV_LOCAL_ADMIN_PORT:String(plan.adminPort)}});
    assert.ok(local.CHORDV_LOCAL_ORIGINS.includes(`http://127.0.0.1:${plan.adminPort}`));
    assert.doesNotMatch(JSON.stringify(prepared),/password|apiToken|controlToken|JWT_SECRET|AGENT_PEPPER/);
    await assert.rejects(stat(path.join(plan.root,".data/mygo/postgres/PG_VERSION")),{code:"ENOENT"});
    await assert.rejects(stat(path.join(plan.root,"runtime.json")),{code:"ENOENT"});
  } finally {await rm(prepared.root,{recursive:true});}
});

test("admin UI plan rejects main-environment ports and a substituted database/API plan",async()=>{
  const prepared=await prepareAdminUIIsolation();
  try {
    const original=JSON.parse(await readFile(prepared.planFile,"utf8"));
    for(const changed of [{...original,adminPort:5174},{...original,apiPort:3100},{...original,postgresPort:55437},{...original,imagePort:original.adminPort}]) {
      await writeFile(prepared.planFile,JSON.stringify(changed),{mode:0o600});
      await assert.rejects(readAdminUIPlan(prepared.planFile),/计划|端口/);
    }
  } finally {await rm(prepared.root,{recursive:true});}
});

test("fixture provenance survives supersede error changes and never relabels genuine replacement commands",()=>{
  const seeded=[{id:"seed-ensure",sourceCommandId:"real-completed"},{id:"seed-enable"},{id:"seed-dismiss"}];
  const rows=[
    {id:"seed-ensure",type:"ENSURE_USER",status:"cancelled",resolved:true,fixture:false,lastError:"已由更新命令替代"},
    {id:"seed-enable",type:"ENABLE_USER",status:"cancelled",resolved:true,fixture:false,lastError:null},
    {id:"seed-dismiss",type:"REFRESH_QUOTA",status:"cancelled",resolved:true,fixture:true},
    {id:"real-completed",type:"ENSURE_USER",status:"completed",resolved:false,fixture:false},
    {id:"real-pending",type:"ENSURE_USER",status:"pending",resolved:false,fixture:false,lastError:"仅UI夹具这几个字不能决定来源"}
  ];
  const before=structuredClone(rows);
  const labelled=classifyFixtureOrigins(rows,seeded);
  assert.deepEqual(labelled.map(row=>row.fixture),[true,true,true,false,false]);
  assert.deepEqual(rows,before,"classification must not mutate its input");
  const withoutFixture=values=>values.map(({fixture,...row})=>row);
  assert.deepEqual(withoutFixture(labelled),withoutFixture(before));
  assert.deepEqual(labelled.filter(row=>row.status==="pending").map(row=>row.id),["real-pending"]);
});

test("stable dedupe origin covers partial startup reports without depending on error wording",()=>{
  const rows=[
    {id:"seed-1",status:"cancelled",dedupeKey:"admin-ui-fixture:seed-1",lastError:"已由更新命令替代"},
    {id:"seed-2",status:"cancelled",dedupeKey:"admin-ui-dismiss-origin-id",lastError:null},
    {id:"real-1",status:"pending",dedupeKey:"binding-id:ENSURE_USER:4",lastError:"仅UI夹具"},
    {id:"real-2",status:"completed",dedupeKey:"admin-ui-fixture:different-id"}
  ];
  const labelled=classifyFixtureOrigins(rows);
  assert.deepEqual(labelled.map(row=>row.fixture),[true,true,false,false]);
  assert.ok(labelled.every(row=>row.dedupeKey===undefined));
});
