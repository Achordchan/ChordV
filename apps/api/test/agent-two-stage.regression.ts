import "reflect-metadata";
import assert from "node:assert/strict";
import { AgentRegisterService } from "../src/modules/agent/agent-register.service";
import { AgentService } from "../src/modules/agent/agent.service";
import { AgentAdminController } from "../src/modules/agent/agent-admin.controller";

// Stateful repository double exercises the real service lifecycle across calls.
// Transaction snapshots model rollback; PostgreSQL locking is not simulated.
async function main() {
  let node: any = null, agent: any = null;
  let tokens: any[] = [], jobs: any[] = [];
  const events: any[] = [];
  const assign = (row: any, data: any) => {
    for (const [key, value] of Object.entries(data)) {
      row[key] = value && typeof value === "object" && "increment" in value
        ? row[key] + (value as any).increment : value;
    }
    return row;
  };
  const prisma: any = {
    node: {
      create: async ({ data }: any) => node = { agentConfigRevision: 0n, inboundAppliedRevision: 0n,
        probeStatus: "unknown", createdAt: new Date(), updatedAt: new Date(), ...data },
      findUnique: async () => node ? { ...node, nodeAgents: agent && !agent.revokedAt ? [agent] : [] } : null,
      update: async ({ data }: any) => assign(node, data),
      updateMany: async ({ data }: any) => { assign(node, data); return { count: 1 }; }
    },
    agentRegisterToken: {
      create: async ({ data }: any) => { const row = { usedAt: null, ...data }; tokens.push(row); return row; },
      findUnique: async ({ where }: any) => tokens.find(row => row.tokenHash === where.tokenHash) ?? null,
      update: async ({ where, data }: any) => assign(tokens.find(row => row.id === where.id), data)
    },
    nodeAgent: {
      create: async ({ data }: any) => agent = { revokedAt: null, xrayStatus: "unknown", configRevision: 0n,
        lastSequence: 0n, lastAckSequence: 0n, queueDepth: 0, ...data },
      findFirst: async ({ where }: any) => {
        if (!agent || agent.revokedAt) return null;
        if (where.tokenHash && where.tokenHash !== agent.tokenHash) return null;
        if (where.nodeId?.not === agent.nodeId) return null;
        if (typeof where.nodeId === "string" && where.nodeId !== agent.nodeId) return null;
        if (where.id && where.id !== agent.id) return null;
        return agent;
      },
      findUnique: async () => agent,
      update: async ({ data }: any) => assign(agent, data)
    },
    nodeCommandJob: {
      findUnique: async ({ where }: any) => jobs.find(job => job.dedupeKey === where.dedupeKey) ?? null,
      findFirst: async ({ where }: any) => jobs.filter(job =>
        (!where.id || job.id === where.id) && (!where.status || (typeof where.status === "string" ? job.status === where.status : where.status.in.includes(job.status))) &&
        (!where.targetRevision || (typeof where.targetRevision === "bigint" ? job.targetRevision === where.targetRevision : job.targetRevision > where.targetRevision.gt))
      ).sort((a, b) => a.targetRevision > b.targetRevision ? -1 : 1)[0] ?? null,
      create: async ({ data }: any) => { const job = { status: "pending", lastError: null, createdAt: new Date(), ...data }; jobs.push(job); return job; },
      update: async ({ where, data }: any) => assign(jobs.find(job => job.id === where.id), data),
      updateMany: async ({ where, data }: any) => {
        const matches = jobs.filter(job => (!where.id || job.id === where.id) && (!where.dedupeKey || job.dedupeKey === where.dedupeKey) && (!where.status || job.status === where.status));
        for (const job of matches) assign(job, data);
        return { count: matches.length };
      }
    },
    $queryRaw: async () => [],
    $transaction: async (body: any) => {
      const before = structuredClone({ node, agent, tokens, jobs });
      try { return await body(prisma); }
      catch (error) { ({ node, agent, tokens, jobs } = before); throw error; }
    }
  };
  const adminEvents = { publish: (event: any) => events.push(event) };
  const register = new AgentRegisterService(prisma, adminEvents as never);
  const service = new AgentService(prisma, { publish() {} } as never, {} as never, adminEvents as never);
  const controller = new AgentAdminController(service, register);
  const created = await register.createAgentNode({ name: "two-stage-server" });
  assert.deepEqual(node.onboardingSpec, { mode: "awaiting_panel", activateOnFirstValidation: true });
  assert.equal(created.node.isActive, false);
  assert.equal((await register.getOnboarding(node.id)).mode, "environment");
  const registration = { registerToken: created.registerToken, agentToken: "chordv_agent_" + "a".repeat(43),
    hostname: "test-server", arch: "linux-x64" as const, agentVersion: "go-0.0.13", bootId: "test-boot" };
  await register.register(registration); // Deliberately no xrayInboundTag.
  assert.equal(jobs.length, 0, "registration must not queue an inbound task");
  assert.equal((await register.getOnboarding(node.id)).environmentReady, false, "registration alone is not readiness");
  const replay = await register.register(registration);
  assert.equal(replay.agentId, agent.agentId);
  assert.equal(jobs.length, 0);
  const payload = { mode: "validate_panel", listenPort: 443, serverHost: "node.example.com", realityPublicKey: Buffer.alloc(32, 7).toString("base64url"),
    shortId: "abcd", serverNames: ["example.com"], flow: "xtls-rprx-vision", fingerprint: "chrome", spiderX: "/", panelVersion: "auto" };
  const enqueue = () => service.queueCommand(node.id, { type: "ENSURE_INBOUND", payload, expectedInboundAppliedRevision: "0" });
  await assert.rejects(enqueue, /环境就绪/);
  assert.equal(node.agentConfigRevision, 0n);
  const heartbeat = { bootId: "test-boot", version: "go-0.0.13", configRevision: "0", queueDepth: 0, xrayStatus: "awaiting_inbound" as const };
  await service.heartbeat(agent, heartbeat);
  assert.equal((await register.getOnboarding(node.id)).environmentReady, true);
  agent.lastSeenAt = new Date(Date.now() - 61_000);
  await assert.rejects(enqueue, /环境就绪/);
  assert.equal((await register.getOnboarding(node.id)).environmentReady, false);
  await service.heartbeat(agent, heartbeat);
  const command = await enqueue();
  assert.equal(jobs.length, 1);
  const duplicate = await enqueue();
  assert.equal(duplicate.commandId, command.commandId, "pending validation remains single-flight");
  assert.equal(jobs.length, 1);
  assert.equal(node.isActive, false);
  await service.completeCommand(agent, command.commandId, { status: "failed", error: "公钥不一致" });
  const resumed = await register.getOnboarding(node.id);
  assert.equal(resumed.mode, "panel");
  assert.equal(resumed.command?.status, "failed");
  assert.equal(resumed.command?.lastError, "公钥不一致");
  assert.equal(resumed.spec?.realityPublicKey, payload.realityPublicKey);
  await controller.retryOnboarding(node.id);
  assert.ok(jobs.length > 1, "retry creates a new validation command");
  assert.equal((await register.getOnboarding(node.id)).command?.status, "pending");
  assert.equal(node.isActive, false);
  assert.equal(node.inboundAppliedRevision, 0n);
  const latestJob = jobs.at(-1);
  const inbound = {mode:"validate_panel",validated:true,inboundTag:"actual-inbound",serverPort:payload.listenPort,serverHost:payload.serverHost,realityPublicKey:payload.realityPublicKey,shortId:payload.shortId,serverName:payload.serverNames[0],flow:payload.flow,fingerprint:payload.fingerprint,spiderX:payload.spiderX};
  await service.completeCommand(agent, latestJob.id, {status:"completed",result:{inbound}});
  assert.equal(node.isActive,true,"first verified onboarding activates the new node");
  node.isActive=false;
  const recheck=await service.queueCommand(node.id,{type:"ENSURE_INBOUND",payload,expectedInboundAppliedRevision:String(node.inboundAppliedRevision)});
  await service.completeCommand(agent,recheck.commandId,{status:"completed",result:{inbound}});
  assert.equal(node.isActive,false,"revalidation cannot undo an operator's deactivation");
  assert.ok(events.some(event => event.type === "node_access_updated"));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
