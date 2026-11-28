import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { inspectRuntimeSources, MANUAL_ASSET_LABEL } from "./runtime-ui-assets.mjs";
import { assertRuntimePortsAvailable, claimFreshRuntimeUIPlan, initialRuntimeProxyState, prepareRuntimeUIIsolation, readRuntimeUIPlan, RUNTIME_UI_FORBIDDEN_PORTS, runtimeUIRequest, startRuntimeUIIsolation } from "./runtime-ui-isolation.mjs";
import { resolveRuntimeGoToolchain, runtimeBuildEnvironment, verifyRuntimeNodeProof } from "./runtime-ui-nodes.mjs";

test("runtime Go toolchain uses an existing executable for real offline version and small module build",async() => {
  const toolchain = await resolveRuntimeGoToolchain({...process.env,GOTOOLCHAIN:"go1.26.2",GOPROXY:"https://external.example.test",GOSUMDB:"sum.golang.org",GOROOT:"/not-a-real-goroot"});
  assert.equal(toolchain.binary,await realpath(toolchain.binary));assert.ok(path.isAbsolute(toolchain.binary));
  assert.deepEqual([toolchain.env.GOTOOLCHAIN,toolchain.env.GOPROXY,toolchain.env.GOSUMDB],["local","off","off"]);
  assert.equal(toolchain.env.GOROOT,undefined);assert.equal(toolchain.env.GOENV,"off");
  const root = await mkdtemp(path.join(os.tmpdir(),"chordv-runtime-go-e2e-")), execute = promisify(execFile);
  try {
    const version = await execute(toolchain.binary,["version"],{env:toolchain.env,cwd:root,timeout:10000});
    assert.match(version.stdout,new RegExp(`^go version go${toolchain.version.replaceAll(".","\\.")} `));
    await writeFile(path.join(root,"go.mod"),`module chordv-runtime-offline-check\n\ngo ${toolchain.requiredVersion}\n`,{flag:"wx"});
    await writeFile(path.join(root,"main.go"),"package main\nfunc main() {}\n",{flag:"wx"});
    const output = path.join(root,process.platform === "win32" ? "offline-check.exe" : "offline-check");
    await execute(toolchain.binary,["build","-o",output,"."],{env:toolchain.env,cwd:root,timeout:60000});
    assert.ok((await lstat(output)).size>1024);
    await execute(output,[],{env:toolchain.env,cwd:root,timeout:10000});
  } finally {await rm(root,{recursive:true,force:true});}
});

test("runtime Go toolchain refuses missing local executables without enabling downloads",async() => {
  const root = await mkdtemp(path.join(os.tmpdir(),"chordv-runtime-go-e2e-"));
  try {
    const environment = {HOME:root,GOMODCACHE:path.join(root,"missing-cache"),PATH:"",GOTOOLCHAIN:"auto"};
    assert.equal(runtimeBuildEnvironment(environment).GOTOOLCHAIN,"local");
    await assert.rejects(resolveRuntimeGoToolchain(environment),/已安装.*离线模式拒绝下载/);
  } finally {await rm(root,{recursive:true,force:true});}
});

async function withPrepared(t, run) {
  if (process.platform !== "darwin" || !process.env.CHORDV_TEST_XRAY_DIR) {
    return t.skip("仅在 macOS 显式设置 CHORDV_TEST_XRAY_DIR 时使用真实组件");
  }
  await inspectRuntimeSources();
  const plan = await prepareRuntimeUIIsolation();
  try {await run(plan);}
  finally {await rm(plan.root,{recursive:true,force:true});}
}

test("runtime UI prepare stages genuine read-only component bytes and strict file-proxy metadata without starting services",async t => {
  await withPrepared(t,async prepared => {
    const plan = await readRuntimeUIPlan(prepared.planFile);
    assert.equal(plan.requiredDesktopBuild,"darwin-local-e2e");
    assert.equal(plan.releaseRepository,"");
    assert.equal(new Set([plan.apiPort,plan.postgresPort,plan.reservedProviderPort,17890,17891]).size,5);
    assert.ok(![plan.apiPort,plan.postgresPort,plan.reservedProviderPort].some(port => RUNTIME_UI_FORBIDDEN_PORTS.includes(port)));
    assert.equal((await lstat(plan.proxyStateFile)).mode&0o777,0o600);
    assert.deepEqual(JSON.parse(await readFile(plan.proxyStateFile,"utf8")),initialRuntimeProxyState());
    assert.equal(prepared.desktopEnvironment.CHORDV_E2E_PROXY_STATE,plan.proxyStateFile);
    assert.equal(prepared.desktopEnvironment.CHORDV_MYGO_DATA_DIR,plan.desktopDataDir);
    assert.equal(prepared.desktopEnvironment.CHORDV_GITHUB_RELEASE_REPOSITORY,"");
    assert.equal(prepared.desktopEnvironment.CHORDV_API_BASE_URL,`http://127.0.0.1:${plan.apiPort}`);
    assert.deepEqual(prepared.adminEnvironment,{CHORDV_DEV_API_TARGET:`http://127.0.0.1:${plan.apiPort}`,CHORDV_ADMIN_PORT:String(plan.reservedProviderPort)});
    assert.notEqual(Number(prepared.adminEnvironment.CHORDV_ADMIN_PORT),plan.apiPort);
    assert.notEqual(Number(prepared.adminEnvironment.CHORDV_ADMIN_PORT),plan.postgresPort);
    for (const asset of plan.assets) {
      assert.equal(asset.provenance,MANUAL_ASSET_LABEL);assert.equal(asset.downloadEvidence,false);
      assert.notEqual((await lstat(asset.source)).ino,(await lstat(asset.target)).ino,"copies must never be hard links to user assets");
      const metadata = JSON.parse(await readFile(asset.metadata,"utf8"));
      assert.deepEqual(metadata,{kind:asset.kind,versionLabel:MANUAL_ASSET_LABEL,artifactSha256:asset.sha256,installedSha256:asset.sha256,installedSize:asset.size});
      assert.equal(metadata.ready,undefined);assert.equal(metadata.verified,undefined);
    }
    for (const name of ["runtime.json","runtime-ui-runtime.json","credentials.json","runtime-agent","runtime-local-node",".data/mygo/postgres"]) await assert.rejects(lstat(path.join(plan.root,name)),{code:"ENOENT"});
    assert.doesNotMatch(JSON.stringify(prepared),/clientPassword|adminPassword|CHORDV_LOCAL_(?:DATABASE_URL|JWT_SECRET|AGENT_PEPPER)/);
  });
});

test("runtime UI plans reject protected ports, substituted database/desktop paths, altered proxy state and component metadata",async t => {
  await withPrepared(t,async prepared => {
    const plan = await readRuntimeUIPlan(prepared.planFile), original = JSON.stringify(plan);
    const supportOriginal = await readFile(plan.supportPlanFile,"utf8");
    for (const port of [...RUNTIME_UI_FORBIDDEN_PORTS,17890,17891]) {
      const changed = {...plan,apiPort:port}, support = {...JSON.parse(supportOriginal),apiPort:port};
      await writeFile(plan.supportPlanFile,JSON.stringify(support));
      await writeFile(prepared.planFile,JSON.stringify(changed));
      await assert.rejects(readRuntimeUIPlan(prepared.planFile),/端口|计划/);
    }
    await writeFile(plan.supportPlanFile,supportOriginal);await writeFile(prepared.planFile,original);
    for (const changed of [{...plan,desktopDataDir:path.dirname(plan.desktopDataDir)},{...plan,proxyStateFile:path.join(plan.root,"outside.json")},{...plan,requiredDesktopBuild:"ordinary-app"},{...plan,releaseRepository:"not-an-empty/source"},{...plan,localProxyPorts:{http:12027,socks:17891}}]) {
      await writeFile(prepared.planFile,JSON.stringify(changed));
      await assert.rejects(readRuntimeUIPlan(prepared.planFile));
    }
    await writeFile(prepared.planFile,original);
    const configFile = path.join(plan.root,".data/mygo/local-env.json"), configOriginal = await readFile(configFile,"utf8");
    const config = JSON.parse(configOriginal), database = new URL(config.CHORDV_LOCAL_DATABASE_URL);
    database.port = String(plan.apiPort);config.CHORDV_LOCAL_DATABASE_URL = database.href;
    await writeFile(configFile,JSON.stringify(config));
    await assert.rejects(readRuntimeUIPlan(prepared.planFile),/数据库配置/);
    await writeFile(configFile,configOriginal);
    await chmod(plan.proxyStateFile,0o644);
    await assert.rejects(readRuntimeUIPlan(prepared.planFile),/权限/);
    await chmod(plan.proxyStateFile,0o600);
    const proxyOriginal = await readFile(plan.proxyStateFile,"utf8");
    await writeFile(plan.proxyStateFile,JSON.stringify({...initialRuntimeProxyState(),testOnly:false}));
    await assert.rejects(readRuntimeUIPlan(prepared.planFile),/代理JSON/);
    await writeFile(plan.proxyStateFile," ".repeat(65537));
    await assert.rejects(readRuntimeUIPlan(prepared.planFile),/权限/);
    await writeFile(plan.proxyStateFile,proxyOriginal);
    const backup = path.join(plan.root,"proxy-backup.json");
    await rename(plan.proxyStateFile,backup);await symlink(backup,plan.proxyStateFile);
    await assert.rejects(readRuntimeUIPlan(prepared.planFile),/非链接/);
    await rm(plan.proxyStateFile);await rename(backup,plan.proxyStateFile);
    await link(plan.proxyStateFile,backup);
    await assert.rejects(readRuntimeUIPlan(prepared.planFile),/独占/);
    await rm(backup);
    const component = plan.assets.find(asset => asset.kind === "geosite"), metadata = await readFile(component.metadata,"utf8");
    await chmod(component.metadata,0o600);await writeFile(component.metadata,JSON.stringify({...JSON.parse(metadata),installedSha256:"0".repeat(64)}));await chmod(component.metadata,0o400);
    await assert.rejects(readRuntimeUIPlan(prepared.planFile),/SHA\/size/);
    await chmod(component.metadata,0o600);await writeFile(component.metadata,metadata);await chmod(component.metadata,0o400);
    const assetLink = path.join(plan.root,"asset-hardlink");
    await link(component.target,assetLink);
    await assert.rejects(readRuntimeUIPlan(prepared.planFile),/独占/);await rm(assetLink);
    await readRuntimeUIPlan(prepared.planFile);
  });
});

test("runtime UI startup claim refuses any old database/runtime and cannot be claimed twice",async t => {
  await withPrepared(t,async prepared => {
    for (const name of ["runtime.json","credentials.json","runtime-ui-runtime.json","runtime-agent","runtime-agent-A.db","runtime-agent-B-credentials.json",".data/mygo/old-env.json"]) {
      const file = path.join(prepared.root,name);await writeFile(file,"owned-boundary-sentinel",{mode:0o600,flag:"wx"});
      await assert.rejects(startRuntimeUIIsolation(prepared.planFile),/旧.*状态/);
      assert.equal(await readFile(file,"utf8"),"owned-boundary-sentinel");await rm(file);
    }
    const session = path.join(prepared.desktopDataDir,"session.json");await writeFile(session,"owned-session-sentinel",{flag:"wx",mode:0o600});
    await assert.rejects(startRuntimeUIIsolation(prepared.planFile),/旧会话/);
    assert.equal(await readFile(session,"utf8"),"owned-session-sentinel");await rm(session);
    const database = path.join(prepared.root,".data/mygo/postgres");await mkdir(database);
    await assert.rejects(claimFreshRuntimeUIPlan(prepared.planFile),/旧运行状态/);await rm(database,{recursive:true});
    await claimFreshRuntimeUIPlan(prepared.planFile);
    await assert.rejects(claimFreshRuntimeUIPlan(prepared.planFile),/旧运行状态/);
    await assert.rejects(lstat(path.join(prepared.root,"runtime.json")),{code:"ENOENT"});
    await assert.rejects(lstat(database),{code:"ENOENT"});
  });
});

test("fixed proxy-port availability checks refuse an occupied listener without killing or replacing it",async() => {
  const server = net.createServer();await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  try {
    const port = server.address().port;
    await assert.rejects(assertRuntimePortsAvailable([port]),/占用/);
    assert.equal(server.listening,true);
  } finally {await new Promise(resolve => server.close(resolve));}
});

test("runtime API client rejects external/main/proxy URLs before making a request",async() => {
  for (const base of ["https://external.example.test","http://127.0.0.1","http://127.0.0.1:36715","http://127.0.0.1:3100","http://127.0.0.1:17890","http://user:pass@127.0.0.1:54321","http://127.0.0.1:54321/other"]) await assert.rejects(runtimeUIRequest(base,"GET","/api/health"),/回环API/);
});

test("runtime API client refuses redirects instead of reaching another environment",async() => {
  let received = 0;
  const server = createServer((_request,response) => {received++;response.writeHead(302,{Location:"http://127.0.0.1:36715/api/health"});response.end();});
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  try {
    await assert.rejects(runtimeUIRequest(`http://127.0.0.1:${server.address().port}`,"GET","/api/health"));
    assert.equal(received,1);
  } finally {await new Promise(resolve => server.close(resolve));}
});

test("two-node readiness contract rejects A-only, pending B, wrong user and missing real Xray identity",() => {
  const expected = {userId:"unit-user",subscriptionId:"unit-subscription",nodeIds:["node-A","node-B"]};
  const rows = expected.nodeIds.map((nodeId,index) => ({id:`binding-${index}`,nodeId,userId:expected.userId,subscriptionId:expected.subscriptionId,status:"active",commandId:`command-${index}`,commandType:"ENSURE_USER",commandStatus:"completed",targetRevision:"2",uuid:`unit-only-uuid-${index}`,userKey:`unit-only-key-${index}`}));
  const snapshots = new Map(rows.map(row => [row.nodeId,{users:[{UUID:row.uuid,Email:row.userKey}]}]));
  assert.equal(verifyRuntimeNodeProof(rows,snapshots,expected).length,2);
  assert.doesNotMatch(JSON.stringify(verifyRuntimeNodeProof(rows,snapshots,expected)),/unit-only/);
  assert.throws(() => verifyRuntimeNodeProof(rows.slice(0,1),snapshots,expected),/两个/);
  for (const change of [{commandStatus:"pending"},{userId:"another-user"},{commandType:"ENABLE_USER"},{targetRevision:"0"},{targetRevision:"not-a-revision"}]) assert.throws(() => verifyRuntimeNodeProof([rows[0],{...rows[1],...change}],snapshots,expected),/不一致/);
  assert.throws(() => verifyRuntimeNodeProof(rows,new Map([["node-A",snapshots.get("node-A")],["node-B",{users:[]}]]),expected),/不一致/);
});
