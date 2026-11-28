import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, readFile, readdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PROJECT_ROOT } from "../../scripts/mygo-local-config.mjs";
import { adminEvents, managedProcess, runBuild, waitForState } from "./agent-harness.mjs";
import { sqlID } from "./local-postgres.mjs";

const execute = promisify(execFile);
export const runtimeBuildEnvironment = (environment = process.env) => ({...Object.fromEntries(Object.entries(environment).filter(([key]) => ["PATH","HOME","TMPDIR","GOPATH","GOMODCACHE","GOCACHE"].includes(key))),CGO_ENABLED:"0",GOTOOLCHAIN:"local",GOPROXY:"off",GOSUMDB:"off",GOENV:"off",GOWORK:"off",GOTELEMETRY:"off"});
const versionParts = value => value.split(".").map(Number);
const compareVersions = (left,right) => {
  for (let index=0;index<3;index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
};

// Execute an already present toolchain binary, never the old Go auto-download wrapper.
export async function resolveRuntimeGoToolchain(environment = process.env) {
  const env = runtimeBuildEnvironment(environment);
  const module = await readFile(path.join(PROJECT_ROOT,"apps/agent/go.mod"),"utf8");
  const required = /^go (\d+\.\d+(?:\.\d+)?)$/m.exec(module)?.[1];
  if (!required) throw new Error("Agent go.mod 缺少可核对的Go版本要求");
  const minimum = versionParts(required), arch = process.arch === "x64" ? "amd64" : process.arch;
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const name = process.platform === "win32" ? "go.exe" : "go";
  const cache = environment.GOMODCACHE || path.join((environment.GOPATH || path.join(environment.HOME || os.homedir(),"go")).split(path.delimiter)[0],"pkg/mod");
  let cached = [];
  try {cached = await readdir(path.join(cache,"golang.org"));}
  catch(error) {if(error.code !== "ENOENT") throw error;}
  const tools = cached.map(entry => ({entry,match:/^toolchain@v0\.0\.1-go(\d+\.\d+\.\d+)\.([a-z0-9]+)-([a-z0-9]+)$/.exec(entry)}))
    .filter(({match}) => match && match[2] === platform && match[3] === arch && compareVersions(versionParts(match[1]),minimum) >= 0)
    .sort((a,b) => {
      const left = versionParts(a.match[1]), right = versionParts(b.match[1]);
      return left[0]-right[0] || left[1]-right[1] || right[2]-left[2];
    }).map(({entry}) => path.join(cache,"golang.org",entry,"bin",name));
  tools.push(...(environment.PATH || "").split(path.delimiter).filter(Boolean).map(directory => path.join(directory,name)));
  for (const candidate of [...new Set(tools)]) {
    try {
      const binary = await realpath(candidate);await access(binary,constants.X_OK);
      const {stdout} = await execute(binary,["version"],{env,cwd:os.tmpdir(),timeout:10000});
      const reported = /^go version go(\d+\.\d+(?:\.\d+)?) ([a-z0-9]+)\/([a-z0-9]+)\s*$/.exec(stdout);
      if (reported && reported[2] === platform && reported[3] === arch && compareVersions(versionParts(reported[1]),minimum) >= 0) return {binary,version:reported[1],requiredVersion:required,env};
    } catch {}
  }
  throw new Error(`没有已安装且可执行的本机Go ${required}+ 工具链；离线模式拒绝下载或自动切换`);
}

export function verifyRuntimeNodeProof(rows, snapshots, {userId, subscriptionId, nodeIds}) {
  if (!Array.isArray(rows) || rows.length !== 2 || nodeIds.length !== 2 || new Set(nodeIds).size !== 2) throw new Error("主用户必须在两个不同节点具有实际绑定");
  return nodeIds.map(nodeId => {
    const row = rows.find(value => value.nodeId === nodeId), live = snapshots.get(nodeId);
    if (!row || row.userId !== userId || row.subscriptionId !== subscriptionId || row.status !== "active" || row.commandStatus !== "completed" || row.commandType !== "ENSURE_USER" || typeof row.targetRevision !== "string" || !/^[1-9]\d*$/.test(row.targetRevision) || !row.id || !row.commandId || !row.uuid || !row.userKey || !Array.isArray(live?.users) || live.users.length !== 1 || (live.users[0].UUID ?? live.users[0].uuid) !== row.uuid || (live.users[0].Email ?? live.users[0].email) !== row.userKey) throw new Error("节点真实ENSURE_USER结果与Xray当前账号不一致");
    return {nodeId,bindingId:row.id,completedCommandId:row.commandId,targetRevision:row.targetRevision,installedUserVerified:true};
  });
}

async function currentBindings(db, {userId,subscriptionId}, nodeIds) {
  // Audit only. Every node/account/authorization write uses real admin APIs.
  return db.json(`BEGIN READ ONLY; SELECT coalesce(jsonb_agg(jsonb_build_object('id',b.id,'nodeId',b."nodeId",'userId',b."userId",'subscriptionId',b."subscriptionId",'status',b.status,'uuid',b."panelClientId",'userKey',b."panelClientEmail",'commandId',j.id,'commandType',j."commandType",'commandStatus',j.status,'targetRevision',j."targetRevision"::text)),'[]'::jsonb) FROM "PanelClientBinding" b LEFT JOIN LATERAL(SELECT id,"commandType",status,"targetRevision" FROM "NodeCommandJob" WHERE "bindingId"=b.id AND "commandType" IN('ENSURE_USER','ENABLE_USER') ORDER BY "targetRevision" DESC LIMIT 1) j ON true WHERE b."userId"=${sqlID(userId)} AND b."subscriptionId"=${sqlID(subscriptionId)} AND b."nodeId" IN(${nodeIds.map(sqlID).join(",")}); ROLLBACK;`);
}

export async function prepareRuntimeNodes({root,base,request,adminToken,db,client}) {
  const {binary:goBinary,env} = await resolveRuntimeGoToolchain(), source = path.join(PROJECT_ROOT,"apps/agent");
  const nodeBinary = path.join(root,"runtime-local-node"), agentBinary = path.join(root,"runtime-agent");
  await runBuild(goBinary,["build","-tags=e2e","-o",nodeBinary,"./internal/e2e/cmd/local-node"],{cwd:source,env});
  await runBuild(goBinary,["build","-o",agentBinary,"./cmd/chordv-agent"],{cwd:source,env});
  const owned = [], nodes = [], events = new EventEmitter(), stream = await adminEvents(base,adminToken);
  stream.events.on("change",() => events.emit("change"));
  const checkProcesses = () => {
    if (owned.some(proc => proc.child.exitCode !== null || proc.child.signalCode !== null)) throw new Error("独立节点或生产Agent提前退出");
  };
  const stop = async () => {
    const failures = [];
    for (const proc of [...owned].reverse()) {
      try {await proc.stop();} catch(error) {failures.push(error);}
    }
    await stream.stop();
    if (failures.length) throw new AggregateError(failures,"独立节点子进程清理未完全成功");
  };
  try {
    for (const label of ["A","B"]) {
      const fixture = managedProcess(nodeBinary,[],{cwd:root,env});
      owned.push(fixture);fixture.events.on("change",() => events.emit("change"));
      const live = await waitForState("本地真实Xray/Reality启动",() => fixture.ready,fixture.events,12000);
      if (!Number.isInteger(live.port) || !/^127\.0\.0\.1:\d+$/.test(live.grpc)) throw new Error("节点只允许回环入站及控制接口");
      const created = await request("POST","/api/admin/nodes/agent-native",{name:`运行UI真实节点${label}`,region:"本地",provider:"独立Runtime UI夹具",panelInbound:{mode:"validate_panel",listenPort:live.port,serverHost:"127.0.0.1",realityPublicKey:live.publicKey,shortId:live.shortId,serverNames:[live.serverName],flow:"",fingerprint:"chrome",spiderX:"/",panelVersion:"3.1.0",inboundTag:live.inboundTag,tagOverrideConfirmed:true}},adminToken);
      const agent = managedProcess(agentBinary,[],{cwd:root,env:{...env,CHORDV_API_BASE_URL:base,CHORDV_REGISTER_TOKEN:created.registerToken,CHORDV_NODE_PUBLIC_HOST:"127.0.0.1",XRAY_API_ADDRESS:live.grpc,XRAY_INBOUND_TAG:live.inboundTag,AGENT_DATABASE_PATH:path.join(root,`runtime-agent-${label}.db`),AGENT_CREDENTIALS_PATH:path.join(root,`runtime-agent-${label}-credentials.json`),AGENT_SAMPLE_INTERVAL_MS:"500",AGENT_HEARTBEAT_INTERVAL_MS:"1000"}});
      agent.ready.catch(() => {});owned.push(agent);agent.events.on("change",() => events.emit("change"));
      await waitForState("生产Agent真实注册及Reality入站校验",async() => {
        checkProcesses();
        return (await request("GET","/api/admin/nodes",undefined,adminToken)).find(node => node.id === created.node.id && node.isActive && node.registrationStatus === "agent_ready" && BigInt(node.inboundAppliedRevision) > 0n);
      },events);
      nodes.push({id:created.node.id,label,fixture,agent,port:live.port});
    }
    const nodeIds = nodes.map(node => node.id);
    await request("PUT",`/api/admin/subscriptions/${client.subscriptionId}/nodes`,{nodeIds},adminToken);
    const bindings = await waitForState("主用户在A/B双节点实际ENSURE_USER完成",async() => {
      checkProcesses();
      const rows = await currentBindings(db,client,nodeIds);
      if (rows.length !== 2 || rows.some(row => row.status !== "active" || row.commandStatus !== "completed")) return false;
      const snapshots = new Map(await Promise.all(nodes.map(async node => [node.id,await node.fixture.rpc("snapshot")])));
      return verifyRuntimeNodeProof(rows,snapshots,{...client,nodeIds});
    },events);
    checkProcesses();
    // Unlike the admin queue fixture, both production Agents remain alive.
    return {nodes,bindings,processes:owned,stop};
  } catch(error) { await stop();throw error; }
}
