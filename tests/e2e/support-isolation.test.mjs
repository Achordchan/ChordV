import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { prepareSupportIsolation, readSupportPlan, verifySupportClientBootstrap } from "./support-isolation.mjs";

test("support isolation preparation uses fresh credentials, distinct non-production ports and a separate desktop directory",async()=>{
  const prepared=await prepareSupportIsolation();
  try {
    const plan=await readSupportPlan(prepared.planFile);
    assert.equal(new Set([plan.apiPort,plan.postgresPort,plan.providerPort]).size,3);
    for(const port of [plan.apiPort,plan.postgresPort,plan.providerPort]) assert.ok(![3100,55437,5173,5174].includes(port));
    const configFile=path.join(plan.root,".data/mygo/local-env.json");
    const config=JSON.parse(await readFile(configFile,"utf8"));
    const database=new URL(config.CHORDV_LOCAL_DATABASE_URL);
    assert.equal(database.hostname,"127.0.0.1");
    assert.equal(database.port,String(plan.postgresPort));
    assert.equal(database.pathname,"/chordv_mygo_local");
    assert.ok(database.password.length>=32);
    assert.equal((await stat(configFile)).mode&0o777,0o600);
    assert.ok(prepared.desktopEnvironment.CHORDV_MYGO_DATA_DIR.startsWith(plan.root+path.sep));
    assert.doesNotMatch(JSON.stringify(prepared),/CHORDV_LOCAL_(?:JWT_SECRET|AGENT_PEPPER|DATABASE_URL)/);
    await assert.rejects(stat(path.join(plan.root,".data/mygo/postgres/PG_VERSION")),{code:"ENOENT"});
    await assert.rejects(stat(path.join(plan.root,"runtime.json")),{code:"ENOENT"});
  } finally {await rm(prepared.root,{recursive:true});}
});

for(const scenario of ["valid","missing-subscription","wrong-owner","invalid-expiry","bootstrap-http-failure"]) {
  test(`support client readiness performs login/bootstrap/logout and rejects an unusable subscription: ${scenario}`,async()=>{
    const calls=[];
    const credentials={clientEmail:"fixture-client@chordv.local",clientPassword:"test-only-password"};
    const server=createServer(async(req,res)=>{
      calls.push(`${req.method} ${req.url}`);
      let raw="";for await(const chunk of req)raw+=chunk;
      const response=(status,data)=>{res.writeHead(status,{"Content-Type":"application/json"});res.end(JSON.stringify(data));};
      if(req.url==="/api/auth/login") {
        assert.deepEqual(JSON.parse(raw),{email:credentials.clientEmail,password:credentials.clientPassword});
        return response(200,{accessToken:"test-only-access",refreshToken:"test-only-refresh"});
      }
      assert.equal(req.headers.authorization,"Bearer test-only-access");
      if(req.url==="/api/auth/logout") {
        assert.deepEqual(JSON.parse(raw),{refreshToken:"test-only-refresh"});
        return response(200,{ok:true});
      }
      if(scenario==="bootstrap-http-failure")return response(404,{message:"没有有效订阅"});
      const subscription={id:"fixture-subscription",ownerType:scenario==="wrong-owner"?"team":"user",state:"active",totalTrafficGb:1,remainingTrafficGb:1,expireAt:scenario==="invalid-expiry"?"invalid":new Date(Date.now()+3600000).toISOString()};
      return response(200,{user:{id:"fixture-client"},subscription:scenario==="missing-subscription"?null:subscription});
    });
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    try {
      const task=verifySupportClientBootstrap(`http://127.0.0.1:${server.address().port}`,credentials,{userId:"fixture-client",subscriptionId:"fixture-subscription"});
      if(scenario==="valid") {
        const result=await task;
        assert.equal(result.bootstrapVerified,true);
        assert.equal(result.remainingTrafficGb,1);
        assert.doesNotMatch(JSON.stringify(result),/test-only-access|test-only-refresh|test-only-password/);
      } else await assert.rejects(task,/bootstrap|隔离联调/);
      assert.deepEqual(calls,["POST /api/auth/login","GET /api/client/bootstrap","POST /api/auth/logout"]);
    } finally {await new Promise(resolve=>server.close(resolve));}
  });
}
