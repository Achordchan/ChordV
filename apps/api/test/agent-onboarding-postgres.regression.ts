import "reflect-metadata";
import assert from "node:assert/strict";
import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AgentRegisterService } from "../src/modules/agent/agent-register.service";
import { AgentService } from "../src/modules/agent/agent.service";
import { AgentAdminController } from "../src/modules/agent/agent-admin.controller";
import { normalizePanelInbound } from "../src/modules/agent/panel-inbound";

async function main() {
  const url = process.env.CHORDV_TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('/chordv_onboarding_test')) throw new Error('Requires the dedicated chordv_onboarding_test database');
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const eventLog: unknown[] = [];
  const adminEvents = { publish: (event: unknown) => eventLog.push(event) };
  const registration = new AgentRegisterService(prisma as never, adminEvents as never);
  const service = new AgentService(prisma as never, { publish() {} } as never, {} as never, adminEvents as never);
  const ids: string[] = [];
  const spec = normalizePanelInbound({ mode: 'validate_panel', panelVersion: 'auto', listenPort: 443,
    serverHost: 'node.example.com', realityPublicKey: Buffer.alloc(32, 1).toString('base64url'),
    shortId: 'ab', serverNames: ['example.com'], flow: 'xtls-rprx-vision' });
  try {
    const created = await registration.createAgentNode({ name: 'Go onboarding transaction', panelInbound: { ...spec, uuid: 'DISCARD', privateKey: 'DISCARD' } });
    ids.push(created.node.id);
    const stored = await prisma.node.findUniqueOrThrow({ where: { id: created.node.id } });
    assert.deepEqual(stored.onboardingSpec, spec);
    assert.equal(stored.isActive, false); assert.equal(stored.serverPort, 0);
    const resolved = await registration.resolveTokenNode(created.registerToken);
    assert.deepEqual(resolved?.spec, spec);
    const input = { registerToken: created.registerToken, agentToken: `test-${randomUUID()}`, agentVersion: 'go-0.0.11', bootId: randomUUID(), xrayInboundTag: 'in-443-tcp' };
    await assert.rejects(registration.register({ ...input, agentVersion: '0.0.11' }), /Go agent/);
    assert.equal(await prisma.nodeAgent.count({ where: { nodeId: created.node.id } }), 0);
    // The command insert failure happens inside a real PostgreSQL transaction.
    // It must roll back the consumed token, credentials and node lifecycle.
    const failingDB = new Proxy(prisma, { get(target, key) {
      if (key !== '$transaction') return Reflect.get(target, key);
      return (callback: (tx: unknown) => unknown, options: unknown) => target.$transaction(async tx => callback(new Proxy(tx, { get(inner, property) {
        if (property !== 'nodeCommandJob') return Reflect.get(inner, property);
        return { create() { throw new Error('injected-command-insert-failure'); } };
      } })), options as never);
    } });
    const failing = new AgentRegisterService(failingDB as never, adminEvents as never);
    await assert.rejects(failing.register(input), /injected-command-insert-failure/);
    assert.equal((await registration.resolveTokenNode(created.registerToken))?.usable, true);
    assert.equal(await prisma.nodeAgent.count({ where: { nodeId: created.node.id } }), 0);
    const [one, two] = await Promise.all([registration.register(input), registration.register(input)]);
    assert.deepEqual(one, two);
    assert.equal(await prisma.nodeAgent.count({ where: { nodeId: created.node.id } }), 1);
    assert.equal(await prisma.nodeCommandJob.count({ where: { nodeId: created.node.id } }), 1);
    const legacyId = randomUUID(); ids.push(legacyId);
    await prisma.node.create({ data: { ...stored, id: legacyId, name: 'Existing Node agent', onboardingSpec: Prisma.DbNull,
      registrationStatus: 'agent_ready', isActive: true, serverHost: spec.serverHost, serverPort: 443,
      agentConfigRevision: 1n, inboundAppliedRevision: 1n } });
    const legacyAgent = await prisma.nodeAgent.create({ data: { id: randomUUID(), agentId: `legacy-${legacyId}`, nodeId: legacyId,
      tokenHash: randomUUID(), tokenPrefix: 'legacy-test', version: '0.0.10' } });
    await prisma.nodeCommandJob.create({ data: { id: randomUUID(), nodeId: legacyId, agentId: legacyAgent.id,
      commandType: 'ENSURE_INBOUND', targetRevision: 1n, status: 'completed', dedupeKey: `legacy:${legacyId}`,
      payload: { inboundTag: 'vless-in', listenPort: 443, serverNames: ['example.com'], realityDest: 'example.com:443' } } });
    const legacy = await registration.getOnboarding(legacyId);
    assert.equal(legacy.mode, 'legacy'); assert.equal(legacy.spec, null);
    assert.equal(legacy.node.registrationStatus, 'agent_ready'); assert.equal(legacy.node.isActive, true);
    assert.equal(legacy.node.agent?.version, '0.0.10');
    assert.equal(legacy.command?.status, 'completed');
    const controller = new AgentAdminController(service, registration);
    await assert.rejects(controller.retryOnboarding(legacyId), /旧版节点不适用/);
    assert.equal(await prisma.nodeCommandJob.count({ where: { nodeId: legacyId } }), 1, 'legacy retries must not enqueue panel jobs');
    const state = await registration.getOnboarding(created.node.id);
    assert.equal(state.node.agent?.version, 'go-0.0.11');
    assert.equal(state.command?.status, 'pending');
    assert.equal(state.node.inboundAppliedRevision, '0');
    const agent = await prisma.nodeAgent.findFirstOrThrow({ where: { nodeId: created.node.id } });
    const job = await prisma.nodeCommandJob.findFirstOrThrow({ where: { nodeId: created.node.id } });
    assert.equal((job.payload as Record<string, unknown>).inboundTag, input.xrayInboundTag);
    assert.equal((await registration.resolveTokenNode(created.registerToken))?.spec?.inboundTag, input.xrayInboundTag);
    const report = { mode: 'validate_panel', validated: true, inboundTag: input.xrayInboundTag,
      serverPort: spec.listenPort, serverHost: spec.serverHost, realityPublicKey: spec.realityPublicKey,
      shortId: spec.shortId, serverName: spec.serverNames[0], flow: spec.flow, fingerprint: spec.fingerprint, spiderX: spec.spiderX };
    await assert.rejects(service.completeCommand(agent, job.id, { status: 'completed', result: { inbound: { ...report, serverPort: 8443 } } }), /不一致/);
    assert.equal((await prisma.nodeCommandJob.findUniqueOrThrow({ where: { id: job.id } })).status, 'pending');
    await service.completeCommand(agent, job.id, { status: 'completed', result: { inbound: report } });
    const ready = await registration.getOnboarding(created.node.id);
    assert.equal(ready.command?.status, 'completed');
    assert.equal(ready.node.inboundAppliedRevision, ready.command?.targetRevision);
    assert.equal(ready.node.isActive, true, 'first verified onboarding activates new nodes');
    assert.equal(ready.node.serverPort, 443);
    assert.ok(eventLog.length >= 3, 'registration and completion must publish admin status events');
    await registration.register(input);
    assert.equal(await prisma.nodeCommandJob.count({ where: { nodeId: created.node.id } }), 1);
    await prisma.node.update({ where: { id: created.node.id }, data: { isActive: false } });
    const revalidation = await service.queueCommand(created.node.id, {
      type: 'ENSURE_INBOUND', payload: spec,
      expectedInboundAppliedRevision: ready.node.inboundAppliedRevision
    });
    await service.completeCommand(agent, revalidation.commandId, { status: 'completed', result: { inbound: report } });
    assert.equal((await registration.getOnboarding(created.node.id)).node.isActive, false, 'revalidation preserves deliberate deactivation');
    console.log('PostgreSQL onboarding passed: atomic registration, report validation, first activation and revalidation state preservation');
  } finally {
    await prisma.node.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
