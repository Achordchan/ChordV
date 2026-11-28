import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { PROJECT_ROOT } from "../../scripts/mygo-local-config.mjs";
import { adminEvents, managedProcess, runBuild, waitForState } from "./agent-harness.mjs";
import { sqlID } from "./local-postgres.mjs";

const buildEnvironment=()=>({...Object.fromEntries(Object.entries(process.env).filter(([key])=>["PATH","HOME","TMPDIR","GOPATH","GOMODCACHE","GOCACHE","GOTOOLCHAIN"].includes(key))),CGO_ENABLED:"0"});

// Node and binding state comes from the real Agent and Server, not SQL updates.
export async function prepareAdminNodes({root,base,request,adminToken,db,clientSubscriptions}) {
  const env=buildEnvironment(), source=path.join(PROJECT_ROOT,"apps/agent");
  const nodeBinary=path.join(root,"e2e-local-node"), agentBinary=path.join(root,"e2e-agent");
  await runBuild("go",["build","-tags=e2e","-o",nodeBinary,"./internal/e2e/cmd/local-node"],{cwd:source,env});
  await runBuild("go",["build","-o",agentBinary,"./cmd/chordv-agent"],{cwd:source,env});
  const owned=[],agents=[],nodes=[],events=new EventEmitter();
  const stream=await adminEvents(base,adminToken);
  stream.events.on("change",()=>events.emit("change"));
  const stop=async()=>{for(const proc of [...owned].reverse())await proc.stop();await stream.stop();};
  try {
    for(const label of ["A","B"]) {
      const fixture=managedProcess(nodeBinary,[],{cwd:root,env});
      owned.push(fixture);
      const live=await waitForState("真实本机节点启动",()=>fixture.ready,fixture.events,12000);
      const created=await request("POST","/api/admin/nodes/agent-native",{name:`UI测试节点${label}`,region:"本地",provider:"独立UI夹具",panelInbound:{mode:"validate_panel",listenPort:live.port,serverHost:"127.0.0.1",realityPublicKey:live.publicKey,shortId:live.shortId,serverNames:[live.serverName],flow:"",fingerprint:"chrome",spiderX:"/",panelVersion:"3.1.0",inboundTag:live.inboundTag,tagOverrideConfirmed:true}},adminToken);
      const agent=managedProcess(agentBinary,[],{cwd:root,env:{...env,CHORDV_API_BASE_URL:base,CHORDV_REGISTER_TOKEN:created.registerToken,CHORDV_NODE_PUBLIC_HOST:"127.0.0.1",XRAY_API_ADDRESS:live.grpc,XRAY_INBOUND_TAG:live.inboundTag,AGENT_DATABASE_PATH:path.join(root,`agent-${label}.db`),AGENT_CREDENTIALS_PATH:path.join(root,`agent-${label}-credentials.json`),AGENT_SAMPLE_INTERVAL_MS:"500",AGENT_HEARTBEAT_INTERVAL_MS:"1000"}});
      agent.ready.catch(()=>{});owned.push(agent);agents.push(agent);
      await waitForState("真实Agent入站校验",async()=>{
        if(agent.child.exitCode!==null)throw new Error("UI夹具Agent提前退出");
        return (await request("GET","/api/admin/nodes",undefined,adminToken)).find(node=>node.id===created.node.id&&node.isActive&&node.registrationStatus==="agent_ready"&&BigInt(node.inboundAppliedRevision)>0n);
      },events);
      nodes.push({id:created.node.id,label,fixture,pid:fixture.child.pid,setupAgentPid:agent.child.pid});
    }
    for(const subscriptionId of clientSubscriptions)await request("PUT",`/api/admin/subscriptions/${subscriptionId}/nodes`,{nodeIds:[nodes[0].id]},adminToken);
    await waitForState("真实服务端账号绑定与Agent安装完成",async()=>{
      const count=await db.json(`SELECT to_jsonb(count(*)) FROM "PanelClientBinding" b WHERE b."nodeId"=${sqlID(nodes[0].id)} AND b.status='active' AND EXISTS(SELECT 1 FROM "NodeCommandJob" j WHERE j."bindingId"=b.id AND j."commandType"='ENSURE_USER' AND j.status='completed');`);
      return count===2;
    },events);
    assert.equal((await nodes[0].fixture.rpc("snapshot")).users.length,2);
    // No consumers remain during UI actions: retry produces genuine pending work.
    for(const agent of agents)await agent.stop();
    await waitForState("真实初始化命令全部完成",async()=>{
      const queue=await request("GET","/api/admin/nodes/node-command-jobs",undefined,adminToken);
      return queue.jobs.length===0;
    },events);
    const bindings=await db.json(`SELECT jsonb_agg(jsonb_build_object('id',b.id,'userId',b."userId",'subscriptionId',b."subscriptionId",'sourceCommandId',(SELECT j.id FROM "NodeCommandJob" j WHERE j."bindingId"=b.id AND j."commandType"='ENSURE_USER' AND j.status='completed' ORDER BY j."targetRevision" DESC LIMIT 1)) ORDER BY b.id) FROM "PanelClientBinding" b WHERE b."nodeId"=${sqlID(nodes[0].id)} AND b.status='active';`);
    assert.equal(bindings.length,2);
    return {nodes,bindings,stop};
  } catch(error) {await stop();throw error;}
}
