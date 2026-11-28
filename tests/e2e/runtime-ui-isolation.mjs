import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { loadLocalEnvironment, PROJECT_ROOT, validateLocalEnvironment } from "../../scripts/mygo-local-config.mjs";
import { prepareSupportIsolation, readSupportPlan, startSupportIsolation } from "./support-isolation.mjs";
import { localPostgres } from "./local-postgres.mjs";
import { assertRuntimeDesktop, stageRuntimeAssets, verifyRuntimeAssets } from "./runtime-ui-assets.mjs";
import { prepareRuntimeNodes } from "./runtime-ui-nodes.mjs";

export const RUNTIME_UI_FORBIDDEN_PORTS = Object.freeze([3100,55437,5173,5174,36715,36763,36795,12027]);
export const RUNTIME_UI_PROXY_PORTS = Object.freeze({http:17890,socks:17891});
const serverBinary = path.join(PROJECT_ROOT,"output/local/chordv-server");
export const initialRuntimeProxyState = () => ({schema:1,testOnly:true,settings:[{service:"e2e-runtime-proxy",kind:"windows",values:{ProxyEnable:"0",ProxyServer:"",ProxyOverride:"<local>",AutoConfigURL:"",AutoDetect:"0"}}]});
const exists = async file => {try {await lstat(file);return true;} catch(error) {if(error.code === "ENOENT")return false;throw error;}};
const desktopEnvironment = plan => ({CHORDV_API_BASE_URL:`http://127.0.0.1:${plan.apiPort}`,CHORDV_MYGO_DATA_DIR:plan.desktopDataDir,CHORDV_E2E_PROXY_STATE:plan.proxyStateFile,CHORDV_GITHUB_RELEASE_REPOSITORY:"",CHORDV_GITHUB_RELEASE_PUBLIC_KEY:""});
export const runtimeAdminEnvironment = plan => ({CHORDV_DEV_API_TARGET:`http://127.0.0.1:${plan.apiPort}`,CHORDV_ADMIN_PORT:String(plan.reservedProviderPort)});

async function privateFile(file, mode = 0o600) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > 65536 || (stat.mode&0o777) !== mode || await realpath(file) !== file || (process.getuid && stat.uid !== process.getuid())) throw new Error("隔离计划/状态文件必须由当前用户独占、非链接且权限正确");
}

export async function prepareRuntimeUIIsolation() {
  let base;
  for (let attempt=0;attempt<5;attempt++) {
    base = await prepareSupportIsolation();
    if (![base.apiPort,base.postgresPort,base.providerPort].some(port => RUNTIME_UI_FORBIDDEN_PORTS.includes(port) || Object.values(RUNTIME_UI_PROXY_PORTS).includes(port))) break;
    await rm(base.root,{recursive:true});base = null;
  }
  if (!base) throw new Error("无法分配非主环境隔离端口");
  try {
    const desktopDataDir = path.join(base.root,".data/mygo/desktop");
    await mkdir(desktopDataDir,{mode:0o700});
    const proxyStateFile = path.join(desktopDataDir,"qa-proxy-state.json");
    await writeFile(proxyStateFile,JSON.stringify(initialRuntimeProxyState(),null,2)+"\n",{mode:0o600,flag:"wx"});
    const assets = await stageRuntimeAssets(base.root,desktopDataDir);
    const plan = {schema:1,scope:"runtime-ui-e2e-local",runId:randomUUID(),root:base.root,supportPlanFile:base.planFile,apiPort:base.apiPort,postgresPort:base.postgresPort,reservedProviderPort:base.providerPort,desktopDataDir,proxyStateFile,localProxyPorts:RUNTIME_UI_PROXY_PORTS,serverBinary,requiredDesktopBuild:"darwin-local-e2e",releaseRepository:"",assets};
    const planFile = path.join(base.root,"runtime-ui-plan.json");
    await writeFile(planFile,JSON.stringify(plan,null,2)+"\n",{mode:0o600,flag:"wx"});
    return {planFile,...plan,desktopEnvironment:desktopEnvironment(plan),adminEnvironment:runtimeAdminEnvironment(plan)};
  } catch(error) {await rm(base.root,{recursive:true});throw error;}
}

export async function readRuntimeUIPlan(file) {
  await privateFile(file);
  const plan = JSON.parse(await readFile(file,"utf8"));
  if (plan.schema !== 1 || plan.scope !== "runtime-ui-e2e-local" || !/^[a-f0-9-]{36}$/.test(plan.runId ?? "") || typeof plan.root !== "string" || plan.desktopDataDir !== path.join(plan.root,".data/mygo/desktop") || plan.proxyStateFile !== path.join(plan.desktopDataDir,"qa-proxy-state.json") || plan.supportPlanFile !== path.join(plan.root,"support-isolation-plan.json") || await realpath(file) !== path.join(plan.root,"runtime-ui-plan.json")) throw new Error("不是全新运行UI隔离计划");
  await assertRuntimeDesktop(plan.root,plan.desktopDataDir);
  await privateFile(plan.supportPlanFile);
  const support = await readSupportPlan(plan.supportPlanFile);
  const ports = [plan.apiPort,plan.postgresPort,plan.reservedProviderPort];
  if (support.root !== plan.root || support.apiPort !== plan.apiPort || support.postgresPort !== plan.postgresPort || support.providerPort !== plan.reservedProviderPort || new Set(ports).size !== 3 || ports.some(port => RUNTIME_UI_FORBIDDEN_PORTS.includes(port) || Object.values(RUNTIME_UI_PROXY_PORTS).includes(port)) || !isDeepStrictEqual(plan.localProxyPorts,RUNTIME_UI_PROXY_PORTS)) throw new Error("运行UI端口计划与独立数据库/生产固定代理口冲突");
  if (plan.serverBinary !== serverBinary || plan.requiredDesktopBuild !== "darwin-local-e2e" || plan.releaseRepository !== "") throw new Error("只能使用本地API和带e2e标签的Darwin桌面产物，发布仓库必须为空");
  const configFile = path.join(plan.root,".data/mygo/local-env.json");
  await privateFile(configFile);
  const config = JSON.parse(await readFile(configFile,"utf8"));
  validateLocalEnvironment(config);
  if (Object.keys(config).sort().join(",") !== ["CHORDV_LOCAL_DATABASE_URL","CHORDV_LOCAL_JWT_SECRET","CHORDV_LOCAL_AGENT_PEPPER"].sort().join(",") || Number(new URL(config.CHORDV_LOCAL_DATABASE_URL).port) !== plan.postgresPort) throw new Error("数据库配置不是本次独立计划");
  await privateFile(plan.proxyStateFile);
  if (!isDeepStrictEqual(JSON.parse(await readFile(plan.proxyStateFile,"utf8")),initialRuntimeProxyState())) throw new Error("代理JSON不是本次固定的初始测试契约");
  await verifyRuntimeAssets(plan.root,plan.desktopDataDir,plan.assets);
  return plan;
}

export async function claimFreshRuntimeUIPlan(file) {
  const plan = await readRuntimeUIPlan(file);
  for (const candidate of ["runtime.json","credentials.json","runtime-ui-runtime.json","runtime-agent","runtime-local-node",".runtime-ui-started.json",".data/mygo/postgres"]) {
    if (await exists(path.join(plan.root,candidate))) throw new Error("运行UI环境已经使用或包含旧运行状态；必须重新prepare，不能复活旧root");
  }
  if (!isDeepStrictEqual((await readdir(plan.root)).sort(),[".data","runtime-ui-plan.json","support-isolation-plan.json"]) || !isDeepStrictEqual((await readdir(path.join(plan.root,".data/mygo"))).sort(),["desktop","local-env.json"])) throw new Error("隔离root含旧Agent数据库、凭据或其他运行状态");
  if (!isDeepStrictEqual((await readdir(plan.desktopDataDir)).sort(),["bin","qa-proxy-state.json"])) throw new Error("桌面目录含旧会话或运行状态");
  const lock = await open(path.join(plan.root,".runtime-ui-started.json"),"wx",0o600);
  try {await lock.writeFile(JSON.stringify({runId:plan.runId,supervisor:process.pid})+"\n");}
  finally {await lock.close();}
  return plan;
}

// Startup-only availability checks. No process is killed or substituted.
export async function assertRuntimePortsAvailable(ports = Object.values(RUNTIME_UI_PROXY_PORTS)) {
  const listeners = [];
  try {
    for (const port of ports) {
      const server = net.createServer();
      await new Promise((resolve,reject) => {server.once("error",reject);server.listen(port,"127.0.0.1",resolve);});
      listeners.push(server);
    }
  } catch {throw new Error("生产固定本地代理端口17890/17891被占用；拒绝启动，不杀进程或换口");}
  finally {await Promise.all(listeners.map(server => new Promise(resolve => server.close(resolve))));}
}

export async function runtimeUIRequest(base,method,route,body,token) {
  const url = new URL(base);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || Number(url.port)<1024 || url.pathname !== "/" || url.username || url.password || url.search || url.hash || RUNTIME_UI_FORBIDDEN_PORTS.includes(Number(url.port)) || Object.values(RUNTIME_UI_PROXY_PORTS).includes(Number(url.port)) || !route.startsWith("/api/")) throw new Error("运行UI请求只允许本次回环API，不访问主服务或外网");
  const response = await fetch(base+route,{method,redirect:"error",headers:{"Content-Type":"application/json",...(token?{Authorization:`Bearer ${token}`}:{})},body:body === undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  const result = await response.json();
  if (!response.ok) throw new Error(`运行UI ${method} ${route} 失败 (${response.status})`);
  return result;
}

async function verifyClientNodes(request,credentials,expected,nodeIds) {
  const session = await request("POST","/api/auth/login",{email:credentials.clientEmail,password:credentials.clientPassword});
  try {
    const bootstrap = await request("GET","/api/client/bootstrap",undefined,session.accessToken);
    const nodes = await request("GET","/api/client/nodes",undefined,session.accessToken);
    if (bootstrap.user?.id !== expected.userId || bootstrap.subscription?.id !== expected.subscriptionId || bootstrap.subscription.state !== "active" || !Array.isArray(nodes) || nodes.length !== 2 || nodeIds.some(id => !nodes.some(node => node.id === id && node.serverHost === "127.0.0.1"))) throw new Error("主用户客户端实际授权列表不是双本地节点");
    return {userId:expected.userId,subscriptionId:expected.subscriptionId,nodeIds,clientAuthorizationVerified:true};
  } finally {await request("POST","/api/auth/logout",{refreshToken:session.refreshToken},session.accessToken);}
}

// Explicit --start only; imports, preparation and default unit tests never run it.
export async function startRuntimeUIIsolation(file) {
  const plan = await claimFreshRuntimeUIPlan(file);
  let environment, nodeFixture, adminSession, request, stopped = false;
  const report = {scope:plan.scope,runId:plan.runId,guiStartedByHelper:false,hostProxyOperationsByHelper:false,downloadEvidence:false};
  const stop = async () => {
    if (stopped) return;stopped = true;
    try {
      report.testProxyJSONRestored = isDeepStrictEqual(JSON.parse(await readFile(plan.proxyStateFile,"utf8")),initialRuntimeProxyState());
    } catch {report.testProxyJSONRestored = false;}
    const failures = [];
    for (const cleanup of [() => nodeFixture?.stop(),() => environment?.stop()]) {
      try {await cleanup();} catch(error) {failures.push(error);}
    }
    if (!failures.length) {
      try {await rm(plan.root,{recursive:true,force:true});} catch(error) {failures.push(error);}
    }
    await mkdir(path.join(PROJECT_ROOT,"output/local"),{recursive:true});
    await writeFile(path.join(PROJECT_ROOT,"output/local/runtime-ui-e2e-report.json"),JSON.stringify({...report,cleaned:failures.length === 0,cleanupFailureCount:failures.length,rootRetained:await exists(plan.root)},null,2)+"\n",{mode:0o600});
    if (failures.length) throw new AggregateError(failures,"独立运行UI环境清理未完成；不把残留root报告为已清理");
  };
  try {
    await assertRuntimePortsAvailable();
    const binary = await lstat(serverBinary);
    if (!binary.isFile() || binary.isSymbolicLink() || !(binary.mode&0o111)) throw new Error("请先构建本地Go API二进制，启动器不下载或部署");
    environment = await startSupportIsolation(plan.supportPlanFile,{enableSupportProvider:false,adminPort:plan.reservedProviderPort,reportName:"runtime-ui-base-report.json"});
    const base = environment.ready.apiBase;
    request = (method,route,body,token) => runtimeUIRequest(base,method,route,body,token);
    const local = await loadLocalEnvironment({root:plan.root,env:{CHORDV_LOCAL_API_PORT:String(plan.apiPort)}});
    const db = await localPostgres(local,{root:plan.root});
    const credentials = JSON.parse(await readFile(environment.ready.credentialsFile,"utf8"));
    adminSession = await request("POST","/api/auth/admin/login",{email:credentials.adminEmail,password:credentials.adminPassword});
    const client = {userId:environment.ready.clientAccess.userId,subscriptionId:environment.ready.clientAccess.subscriptionId};
    nodeFixture = await prepareRuntimeNodes({root:plan.root,base,request,adminToken:adminSession.accessToken,db,client});
    const access = await verifyClientNodes(request,credentials,client,nodeFixture.nodes.map(node => node.id));
    await request("POST","/api/auth/logout",{refreshToken:adminSession.refreshToken},adminSession.accessToken);adminSession = null;
    if (nodeFixture.processes.some(proc => proc.child.exitCode !== null || proc.child.signalCode !== null)) throw new Error("节点/Agent在GUI就绪前退出");
    const ready = {event:"ready",scope:plan.scope,root:plan.root,apiBase:base,postgresPort:plan.postgresPort,credentialsFile:environment.ready.credentialsFile,desktopEnvironment:desktopEnvironment(plan),adminEnvironment:runtimeAdminEnvironment(plan),requiredDesktopBuild:plan.requiredDesktopBuild,localProxyPorts:plan.localProxyPorts,manualAssets:plan.assets,downloadEvidence:false,clientAccess:access,nodes:nodeFixture.nodes.map(node => ({id:node.id,label:node.label,fixturePid:node.fixture.child.pid,agentPid:node.agent.child.pid,agentsKeptRunning:true})),bindings:nodeFixture.bindings,pids:environment.ready.pids,guiStartedByHelper:false};
    report.nodes = ready.nodes;
    await writeFile(path.join(plan.root,"runtime-ui-runtime.json"),JSON.stringify(ready,null,2)+"\n",{mode:0o600,flag:"wx"});
    return {ready,stop,processes:[environment.apiProcess,...nodeFixture.processes]};
  } catch(error) {
    report.startupFailed = true;
    if (adminSession) await request("POST","/api/auth/logout",{refreshToken:adminSession.refreshToken},adminSession.accessToken).catch(() => {});
    await stop();throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--prepare") process.stdout.write(JSON.stringify({event:"prepared",...await prepareRuntimeUIIsolation()},null,2)+"\n");
  else if (args.length === 2 && args[0] === "--start") {
    const environment = await startRuntimeUIIsolation(args[1]);
    process.stdout.write(JSON.stringify(environment.ready)+"\n");
    let expectedStop = false;
    await new Promise(resolve => {
      const requested = () => {expectedStop=true;resolve();};
      process.once("SIGINT",requested);process.once("SIGTERM",requested);
      for (const proc of environment.processes) {
        proc.child.once("exit",() => {if(!expectedStop)process.exitCode=1;resolve();});
        if (proc.child.exitCode !== null || proc.child.signalCode !== null) {process.exitCode=1;resolve();}
      }
    });
    await environment.stop();
  } else throw new Error("用法：--prepare只准备；主流程确认后--start <新计划>，不启动GUI，不接受旧环境");
}
