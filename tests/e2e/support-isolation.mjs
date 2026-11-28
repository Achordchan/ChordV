import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnvironment, PROJECT_ROOT } from "../../scripts/mygo-local-config.mjs";
import { ensureLocalDatabase } from "../../scripts/mygo-local-db.mjs";
import { managedProcess, runBuild } from "./agent-harness.mjs";
import { createSupportProvider } from "./support-provider.mjs";

const randomSecret = () => randomBytes(32).toString("hex");
const baseEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "HOME", "TMPDIR", "SystemRoot", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "CHORDV_LOCAL_PG_BIN"].includes(key)));

async function unusedPorts() {
  const listeners = [];
  try {
    for (let index = 0; index < 3; index++) {
      const listener = net.createServer();
      await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
      listeners.push(listener);
    }
    return listeners.map((listener) => listener.address().port);
  } finally { await Promise.all(listeners.map((listener) => new Promise((resolve) => listener.close(resolve)))); }
}

// Preparation writes a dedicated temporary environment, without starting services.
export async function prepareSupportIsolation() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "chordv-support-e2e-")));
  const [apiPort, postgresPort, providerPort] = await unusedPorts();
  const plan = { schema:1, scope:"support-e2e-local", root:await realpath(root), apiPort, postgresPort, providerPort, createdAt:new Date().toISOString() };
  const configDir = path.join(root, ".data/mygo");
  await mkdir(configDir, { recursive:true, mode:0o700 });
  await writeFile(path.join(configDir, "local-env.json"), JSON.stringify({
    CHORDV_LOCAL_DATABASE_URL:`postgresql://chordv_local:${randomSecret()}@127.0.0.1:${postgresPort}/chordv_mygo_local?sslmode=disable`,
    CHORDV_LOCAL_JWT_SECRET:randomSecret(), CHORDV_LOCAL_AGENT_PEPPER:randomSecret()
  }), { mode:0o600, flag:"wx" });
  const planFile = path.join(root, "support-isolation-plan.json");
  await writeFile(planFile, JSON.stringify(plan,null,2)+"\n", {mode:0o600,flag:"wx"});
  return { planFile, ...plan, desktopEnvironment:{CHORDV_API_BASE_URL:`http://127.0.0.1:${apiPort}`,CHORDV_MYGO_DATA_DIR:path.join(root,".data/mygo/desktop")} };
}

export async function readSupportPlan(file) {
  const plan = JSON.parse(await readFile(file,"utf8"));
  const root = await realpath(plan.root);
  const temporary = await realpath(os.tmpdir());
  if (plan.schema!==1 || plan.scope!=="support-e2e-local" || !path.basename(root).startsWith("chordv-support-e2e-") || path.dirname(root)!==temporary || await realpath(file)!==path.join(root,"support-isolation-plan.json")) throw new Error("不是独立工单测试环境计划");
  const ports = [plan.apiPort,plan.postgresPort,plan.providerPort];
  if (new Set(ports).size!==3 || ports.some((port)=>!Number.isInteger(port)||port<1024||port>65535||[3100,55437,5173,5174].includes(port))) throw new Error("工单隔离端口不能使用现有 API、数据库或前端端口");
  return {...plan,root};
}

async function localRequest(base, method, route, body, accessToken) {
  const url = new URL(base);
  if (url.protocol!=="http:"||url.hostname!=="127.0.0.1") throw new Error("隔离联调只接受本机 API");
  const response = await fetch(base+route,{method,headers:{"Content-Type":"application/json",...(accessToken?{Authorization:`Bearer ${accessToken}`}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  const result = await response.json();
  if (!response.ok) throw new Error(`隔离联调 ${method} ${route} 失败 (${response.status})`);
  return result;
}

async function apiReady(process, base) {
  const deadline = Date.now()+20000;
  for (let delay=50;Date.now()<deadline;delay=Math.min(delay*2,1000)) {
    if (process.child.exitCode!==null||process.child.signalCode!==null) throw new Error("隔离 API 在启动时退出");
    try {
      const response = await fetch(`${base}/api/health`,{signal:AbortSignal.timeout(1000)});
      if (response.ok&&(await response.json()).mode==="local") return;
    } catch {}
    // Startup-only readiness: SSE does not exist until this listener is ready.
    await new Promise((resolve)=>setTimeout(resolve,delay));
  }
  throw new Error("隔离 API 未在20秒内就绪");
}

export async function verifySupportClientBootstrap(base, credentials, expected) {
  const session=await localRequest(base,"POST","/api/auth/login",{email:credentials.clientEmail,password:credentials.clientPassword});
  try {
    const bootstrap=await localRequest(base,"GET","/api/client/bootstrap",undefined,session.accessToken);
    const subscription=bootstrap.subscription;
    if(bootstrap.user?.id!==expected.userId||subscription?.id!==expected.subscriptionId||subscription.ownerType!=="user"||subscription.state!=="active"||subscription.totalTrafficGb!==1||subscription.remainingTrafficGb!==1||!Number.isFinite(Date.parse(subscription.expireAt))||Date.parse(subscription.expireAt)<=Date.now()) throw new Error("工单测试客户端bootstrap未取得预期的有效1GB个人订阅");
    return {userId:bootstrap.user.id,subscriptionId:subscription.id,state:subscription.state,remainingTrafficGb:subscription.remainingTrafficGb,expireAt:subscription.expireAt,bootstrapVerified:true};
  } finally {
    await localRequest(base,"POST","/api/auth/logout",{refreshToken:session.refreshToken},session.accessToken);
  }
}

// Explicit opt-in only. This does not start, replace or stop any GUI or port 3100.
export async function startSupportIsolation(planFile, { adminPort, enableSupportProvider = true, reportName = "support-e2e-report.json" } = {}) {
  if(path.basename(reportName)!==reportName||!reportName.endsWith(".json"))throw new Error("隔离报告必须使用本地JSON文件名");
  const plan = await readSupportPlan(planFile);
  const local = await loadLocalEnvironment({root:plan.root,env:{CHORDV_LOCAL_API_PORT:String(plan.apiPort),...(adminPort===undefined?{}:{CHORDV_LOCAL_ADMIN_PORT:String(adminPort)})}});
  const env = {...baseEnvironment(),...local};
  const binary = path.join(PROJECT_ROOT,"output/local/chordv-server");
  const webhookSecret = randomSecret();
  const credentials = {adminEmail:`support-admin-${randomUUID()}@chordv.local`,adminPassword:randomSecret(),clientEmail:`support-client-${randomUUID()}@chordv.local`,clientPassword:randomSecret()};
  let database, provider, apiProcess;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await apiProcess?.stop();
    await provider?.stop();
    await database?.stop();
    const report = {scope:plan.scope,apiPort:plan.apiPort,postgresPort:plan.postgresPort,providerPort:plan.providerPort,provider:provider?.snapshot(),cleaned:true};
    await writeFile(path.join(PROJECT_ROOT,"output/local",reportName),JSON.stringify(report,null,2)+"\n",{mode:0o600});
    await rm(plan.root,{recursive:true});
  };
  try {
    database = await ensureLocalDatabase(local,{root:plan.root,env:baseEnvironment()});
    if(enableSupportProvider) provider = await createSupportProvider({port:plan.providerPort,onEvent:async(event)=>{
      if (event.type!=="unread-changed") return;
      const id=randomUUID(), timestamp=String(Math.floor(Date.now()/1000));
      const raw=JSON.stringify({id,type:"request.unread.changed",createdAt:new Date().toISOString(),data:{externalUserId:event.userId,request:{id:"local-support-request"},unreadCount:event.unreadCount,contactUnreadCount:event.unreadCount}});
      const signature="v1="+createHmac("sha256",webhookSecret).update(timestamp+"."+raw).digest("hex");
      const response=await fetch(`${local.CHORDV_API_BASE_URL}/api/integrations/achord-connect/webhook`,{method:"POST",headers:{"Content-Type":"application/json","X-Achord-Timestamp":timestamp,"X-Achord-Event-Id":id,"X-Achord-Signature":signature},body:raw,signal:AbortSignal.timeout(10000)});
      if (!response.ok) throw new Error("隔离 API 拒绝工单未读 webhook");
      await response.body?.cancel();
    }});
    await runBuild(binary,["--migrate"],{cwd:plan.root,env});
    await runBuild(binary,["--create-admin",credentials.adminEmail],{cwd:plan.root,env:{...env,CHORDV_LOCAL_ADMIN_PASSWORD:credentials.adminPassword}});
    apiProcess = managedProcess(binary,[],{cwd:plan.root,env});
    apiProcess.ready.catch(()=>{});
    await apiReady(apiProcess,local.CHORDV_API_BASE_URL);
    // Unique credentials prove that this is our fresh cluster before settings change.
    const admin=await localRequest(local.CHORDV_API_BASE_URL,"POST","/api/auth/admin/login",{email:credentials.adminEmail,password:credentials.adminPassword});
    const client=await localRequest(local.CHORDV_API_BASE_URL,"POST","/api/admin/users",{email:credentials.clientEmail,password:credentials.clientPassword,displayName:"本地工单联调用户",role:"user"},admin.accessToken);
    const clientPlan=await localRequest(local.CHORDV_API_BASE_URL,"POST","/api/admin/plans",{name:"本地工单联调套餐",scope:"personal",totalTrafficGb:1,renewable:false,maxConcurrentSessions:1,isActive:true},admin.accessToken);
    const clientSubscription=await localRequest(local.CHORDV_API_BASE_URL,"POST","/api/admin/subscriptions",{userId:client.id,planId:clientPlan.id,expireAt:new Date(Date.now()+3600000).toISOString()},admin.accessToken);
    await localRequest(local.CHORDV_API_BASE_URL,"PUT","/api/admin/support-integration",provider?{baseUrl:provider.origin,clientId:provider.credentials.clientId,clientSecret:provider.credentials.clientSecret,webhookSecret,enabled:true}:{enabled:false},admin.accessToken);
    const clientAccess=await verifySupportClientBootstrap(local.CHORDV_API_BASE_URL,credentials,{userId:client.id,subscriptionId:clientSubscription.id});
    await localRequest(local.CHORDV_API_BASE_URL,"POST","/api/auth/logout",{refreshToken:admin.refreshToken},admin.accessToken);
    const credentialsFile=path.join(plan.root,"credentials.json");
    await writeFile(credentialsFile,JSON.stringify({...credentials,clientId:client.id},null,2)+"\n",{mode:0o600,flag:"wx"});
    const ready={event:"ready",scope:plan.scope,apiBase:local.CHORDV_API_BASE_URL,providerOrigin:provider?.origin,postgresPort:plan.postgresPort,pids:{supervisor:process.pid,...(provider?{provider:process.pid}:{}),api:apiProcess.child.pid,postgres:database.child?.pid},credentialsFile,clientAccess,desktopEnvironment:{CHORDV_API_BASE_URL:local.CHORDV_API_BASE_URL,CHORDV_MYGO_DATA_DIR:local.CHORDV_MYGO_DATA_DIR}};
    await writeFile(path.join(plan.root,"runtime.json"),JSON.stringify(ready,null,2)+"\n",{mode:0o600,flag:"wx"});
    return {ready,provider,apiProcess,stop};
  } catch(error) { await stop(); throw error; }
}

if (process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);
  if (args.length===1&&args[0]==="--prepare") {
    process.stdout.write(JSON.stringify({event:"prepared",...await prepareSupportIsolation()},null,2)+"\n");
  } else if (args.length===2&&args[0]==="--start") {
    const environment=await startSupportIsolation(args[1]);
    process.stdout.write(JSON.stringify(environment.ready)+"\n");
    let expectedStop=false;
    await new Promise((resolve)=>{
      const requested=()=>{expectedStop=true;resolve();};
      process.once("SIGINT",requested); process.once("SIGTERM",requested);
      environment.apiProcess.child.once("exit",()=>{if(!expectedStop)process.exitCode=1;resolve();});
    });
    await environment.stop();
  } else throw new Error("用法：--prepare 仅准备隔离环境；确认后 --start <计划文件> 启动独立工单环境，不启动GUI");
}
