import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnvironment, PROJECT_ROOT } from "../../scripts/mygo-local-config.mjs";
import { prepareSupportIsolation, readSupportPlan, startSupportIsolation, verifySupportClientBootstrap } from "./support-isolation.mjs";
import { localPostgres, sqlID } from "./local-postgres.mjs";
import { prepareAdminNodes } from "./admin-ui-node-fixture.mjs";

export async function prepareAdminUIIsolation() {
  const base=await prepareSupportIsolation();
  let adminPort;
  for(let attempt=0;attempt<5;attempt++) {
    const listener=net.createServer();
    await new Promise((resolve,reject)=>{listener.once("error",reject);listener.listen(0,"127.0.0.1",resolve);});
    const port=listener.address().port;
    await new Promise(resolve=>listener.close(resolve));
    if(![base.apiPort,base.postgresPort,base.providerPort,3100,55437,5173,5174].includes(port)){adminPort=port;break;}
  }
  if(!adminPort)throw new Error("无法分配独立后台端口");
  const plan={schema:1,scope:"admin-ui-e2e-local",root:base.root,supportPlanFile:base.planFile,apiPort:base.apiPort,postgresPort:base.postgresPort,imagePort:base.providerPort,adminPort};
  const planFile=path.join(base.root,"admin-ui-plan.json");
  await writeFile(planFile,JSON.stringify(plan,null,2)+"\n",{mode:0o600,flag:"wx"});
  return {planFile,...plan,adminEnvironment:{CHORDV_DEV_API_TARGET:`http://127.0.0.1:${plan.apiPort}`,CHORDV_ADMIN_PORT:String(adminPort)}};
}

export async function readAdminUIPlan(file) {
  const plan=JSON.parse(await readFile(file,"utf8"));
  const base=await readSupportPlan(plan.supportPlanFile);
  if(plan.scope!=="admin-ui-e2e-local"||plan.schema!==1||plan.root!==base.root||await realpath(file)!==path.join(base.root,"admin-ui-plan.json")||plan.apiPort!==base.apiPort||plan.postgresPort!==base.postgresPort||plan.imagePort!==base.providerPort)throw new Error("不是独立后台UI测试计划");
  if(!Number.isInteger(plan.adminPort)||plan.adminPort<1024||plan.adminPort>65535||[base.apiPort,base.postgresPort,base.providerPort,3100,55437,5173,5174].includes(plan.adminPort))throw new Error("独立后台端口冲突");
  return plan;
}

function assertQueue(queue, jobs) {
  assert.ok(Array.isArray(queue.jobs));
  for(const scope of ["nodes","users","subscriptions","teams"])assert.ok(Array.isArray(queue.summaries[scope]));
  for(const expected of jobs) {
    const job=queue.jobs.find(job=>job.id===expected.id);
    assert.ok(job,`队列缺少夹具任务${expected.id}`);
    assert.equal(job.status,"cancelled");
    assert.equal(job.retryable,expected.retryable);
    assert.equal(job.dismissible,true);
    assert.equal(typeof job.targetRevision,"string");
    assert.equal(job.payload,undefined);
  }
}

export function classifyFixtureOrigins(rows, seededJobs = []) {
  const ids=new Set(seededJobs.map(job=>job.id));
  return rows.map(({dedupeKey,...row})=>({
    ...row,
    fixture:ids.has(row.id)||dedupeKey===`admin-ui-fixture:${row.id}`||(typeof dedupeKey==="string"&&dedupeKey.startsWith("admin-ui-dismiss-"))
  }));
}

async function seedCancelledJobs(db,request,adminToken,nodeFixture,root) {
  const jobs=[],statements=[];
  for(const [index,type]of["ENSURE_USER","ENABLE_USER"].entries()) {
    const id=randomUUID(),binding=nodeFixture.bindings[index];
    const statement=`INSERT INTO "NodeCommandJob"(id,"dedupeKey","nodeId","agentId","commandType","targetRevision",payload,"bindingId","subscriptionId","userId","teamId",status,attempts,"lastError","nextRunAt","updatedAt") SELECT ${sqlID(id)},'admin-ui-fixture:${id}',j."nodeId",j."agentId",'${type}'::"NodeAgentCommandType",j."targetRevision",j.payload,j."bindingId",j."subscriptionId",j."userId",j."teamId",'cancelled',8,'仅UI夹具：重试耗尽状态，不代表物理Agent故障',now(),now() FROM "NodeCommandJob" j WHERE j.id=${sqlID(binding.sourceCommandId)} AND j."nodeId"=${sqlID(nodeFixture.nodes[0].id)} AND j."bindingId"=${sqlID(binding.id)} AND j.status='completed' RETURNING jsonb_build_object('id',id,'nodeId',"nodeId",'bindingId',"bindingId");`;
    const inserted=await db.json(statement);
    assert.equal(inserted.id,id);
    statements.push(statement);
    jobs.push({...inserted,type,retryable:true,sourceCommandId:binding.sourceCommandId,fixture:true});
  }
  const queued=await request("POST",`/api/admin/nodes/${nodeFixture.nodes[1].id}/agent-commands`,{type:"REFRESH_QUOTA",payload:{},dedupeKey:`admin-ui-dismiss-${randomUUID()}`},adminToken);
  const statement=`UPDATE "NodeCommandJob" SET status='cancelled',attempts=8,"resolvedAt"=NULL,"lastError"='仅UI夹具：只允许标记已处理，不代表物理Agent故障',"updatedAt"=now() WHERE id=${sqlID(queued.commandId)} AND "nodeId"=${sqlID(nodeFixture.nodes[1].id)} RETURNING jsonb_build_object('id',id,'nodeId',"nodeId");`;
  const inserted=await db.json(statement);statements.push(statement);
  jobs.push({...inserted,type:"REFRESH_QUOTA",retryable:false,fixture:true});
  await writeFile(path.join(root,"cancelled-job-fixture.sql"),"-- Only cancelled command rows are seeded. Node/binding state was built through real API and Agent.\n"+statements.join("\n"),{mode:0o600,flag:"wx"});
  return jobs;
}

export async function startAdminUIIsolation(file) {
  const plan=await readAdminUIPlan(file);
  let environment,image,nodeFixture,db,adminSession;
  const fixture={scope:plan.scope,artificialCancelledState:true,physicalAgentFaultSimulated:false};
  let stopped=false;
  const request=async(method,route,body,token)=>{
    const response=await fetch(`http://127.0.0.1:${plan.apiPort}${route}`,{method,headers:{"Content-Type":"application/json",...(token?{Authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(35000)});
    if(!response.ok)throw new Error(`独立后台 ${method} ${route} 失败 (${response.status})`);
    return response.json();
  };
  const stop=async()=>{
    if(stopped)return;stopped=true;
    if(db&&nodeFixture) {
      const rows=await db.json(`SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'type',"commandType",'status',status,'resolved',"resolvedAt" IS NOT NULL,'dedupeKey',"dedupeKey")),'[]'::jsonb) FROM "NodeCommandJob" WHERE "nodeId" IN(${nodeFixture.nodes.map(node=>sqlID(node.id)).join(",")});`).catch(()=>null);
      fixture.finalJobs=rows===null?null:classifyFixtureOrigins(rows,fixture.jobs);
    }
    await nodeFixture?.stop();
    await image?.stop();
    const imageReport=image?.snapshot();
    await environment?.stop();
    await writeFile(path.join(PROJECT_ROOT,"output/local/admin-ui-e2e-report.json"),JSON.stringify({...fixture,image:imageReport,cleaned:true},null,2)+"\n",{mode:0o600});
  };
  try {
    environment=await startSupportIsolation(plan.supportPlanFile,{adminPort:plan.adminPort,enableSupportProvider:false,reportName:"admin-ui-base-report.json"});
    const {createImageProvider}=await import("./image-provider.mjs");
    image=await createImageProvider({port:plan.imagePort});
    const local=await loadLocalEnvironment({root:plan.root,env:{CHORDV_LOCAL_API_PORT:String(plan.apiPort),CHORDV_LOCAL_ADMIN_PORT:String(plan.adminPort)}});
    db=await localPostgres(local,{root:plan.root});
    const credentials=JSON.parse(await readFile(environment.ready.credentialsFile,"utf8"));
    adminSession=await request("POST","/api/auth/admin/login",{email:credentials.adminEmail,password:credentials.adminPassword});
    await request("PATCH","/api/admin/image-bed/config",image.getConfig(),adminSession.accessToken);
    const support=await request("GET","/api/admin/support-integration",undefined,adminSession.accessToken);
    assert.equal(support.enabled,false);
    const imageConfig=await request("GET","/api/admin/image-bed/config",undefined,adminSession.accessToken);
    assert.equal(imageConfig.baseUrl,image.origin);assert.equal(imageConfig.hasToken,true);
    await request("GET","/api/admin/image-bed/files",undefined,adminSession.accessToken);
    const subscriptions=await request("GET","/api/admin/subscriptions",undefined,adminSession.accessToken);
    const first=subscriptions.find(item=>item.id===environment.ready.clientAccess.subscriptionId);
    assert.ok(first);
    const secondary={clientEmail:`admin-ui-client-${randomUUID()}@chordv.local`,clientPassword:randomBytes(32).toString("hex")};
    const user=await request("POST","/api/admin/users",{email:secondary.clientEmail,password:secondary.clientPassword,displayName:"后台任务联调用户",role:"user"},adminSession.accessToken);
    const second=await request("POST","/api/admin/subscriptions",{userId:user.id,planId:first.planId,expireAt:new Date(Date.now()+3600000).toISOString()},adminSession.accessToken);
    await verifySupportClientBootstrap(environment.ready.apiBase,secondary,{userId:user.id,subscriptionId:second.id});
    await writeFile(path.join(plan.root,"secondary-client-credentials.json"),JSON.stringify(secondary,null,2)+"\n",{mode:0o600,flag:"wx"});
    nodeFixture=await prepareAdminNodes({root:plan.root,base:environment.ready.apiBase,request,adminToken:adminSession.accessToken,db,clientSubscriptions:[first.id,second.id]});
    fixture.jobs=await seedCancelledJobs(db,request,adminSession.accessToken,nodeFixture,plan.root);
    const queue=await request("GET","/api/admin/nodes/node-command-jobs",undefined,adminSession.accessToken);
    assertQueue(queue,fixture.jobs);assert.equal(queue.jobs.length,3);
    const clientSession=await request("POST","/api/auth/login",{email:credentials.clientEmail,password:credentials.clientPassword});
    try {
      const ticket=await request("POST","/api/client/tickets",{title:"后台图文回复联调",body:"独立测试账号通过真实客户端接口创建。用于验证文字、图片上传与回复。"},clientSession.accessToken);
      fixture.ticketId=ticket.id;
      const detail=await request("GET",`/api/admin/tickets/${ticket.id}`,undefined,adminSession.accessToken);
      assert.equal(detail.messages.length,1);assert.equal(detail.messages[0].authorRole,"user");
    } finally {await request("POST","/api/auth/logout",{refreshToken:clientSession.refreshToken},clientSession.accessToken);}
    const imageCredentialsFile=path.join(plan.root,"image-provider-credentials.json");
    await writeFile(imageCredentialsFile,JSON.stringify({origin:image.origin,...image.credentials},null,2)+"\n",{mode:0o600,flag:"wx"});
    const ready={event:"ready",scope:plan.scope,apiBase:environment.ready.apiBase,adminOrigin:`http://127.0.0.1:${plan.adminPort}`,imageOrigin:image.origin,postgresPort:plan.postgresPort,credentialsFile:environment.ready.credentialsFile,imageCredentialsFile,adminEnvironment:{CHORDV_DEV_API_TARGET:environment.ready.apiBase,CHORDV_ADMIN_PORT:String(plan.adminPort)},pids:{...environment.ready.pids,imageProvider:process.pid,nodeFixtures:nodeFixture.nodes.map(node=>node.pid)},setupAgentsStopped:true,nodes:nodeFixture.nodes.map(({id,label})=>({id,label})),...fixture};
    await writeFile(path.join(plan.root,"admin-ui-runtime.json"),JSON.stringify(ready,null,2)+"\n",{mode:0o600,flag:"wx"});
    await request("POST","/api/auth/logout",{refreshToken:adminSession.refreshToken},adminSession.accessToken);adminSession=null;
    fixture.startupVerified=true;
    return {ready,stop,apiProcess:environment.apiProcess};
  } catch(error) {
    fixture.result="startup-failed";
    fixture.error=error.message;
    if(adminSession)await request("POST","/api/auth/logout",{refreshToken:adminSession.refreshToken},adminSession.accessToken).catch(()=>{});
    await stop();throw error;
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);
  if(args.length===1&&args[0]==="--prepare")process.stdout.write(JSON.stringify({event:"prepared",...await prepareAdminUIIsolation()},null,2)+"\n");
  else if(args.length===2&&args[0]==="--start") {
    const environment=await startAdminUIIsolation(args[1]);
    process.stdout.write(JSON.stringify(environment.ready)+"\n");
    let expectedStop=false;
    await new Promise(resolve=>{const requested=()=>{expectedStop=true;resolve();};process.once("SIGINT",requested);process.once("SIGTERM",requested);environment.apiProcess.child.once("exit",()=>{if(!expectedStop)process.exitCode=1;resolve();});});
    await environment.stop();
  } else throw new Error("用法：--prepare；确认计划后 --start <计划文件>，不启动GUI或Vite");
}
