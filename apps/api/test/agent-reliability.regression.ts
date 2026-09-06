import assert from "node:assert/strict";
import { AgentEventsService } from "../src/modules/agent/agent-events.service";
import { AgentService } from "../src/modules/agent/agent.service";

async function main() {
  await testDueCommandIsRepublished();
  await testRollbackStatusSurvivesHeartbeat();
  await testDirectCutoverStatusSurvivesHeartbeat();
  await testHeartbeatReturnsDesiredNodeRevision();
  console.log("agent reliability regression tests passed");
}

async function testDirectCutoverStatusSurvivesHeartbeat() {
  let nodeUpdateData: Record<string, unknown> | null = null;
  const agent = { id: "agent-record-1", nodeId: "node-1", bootId: "boot-1", lastAckSequence: 2n };
  const service = new AgentService({
    node: {
      findUnique: async () => ({ controlMode: "shadow_direct", controlStatus: "direct_cutover_pending", agentConfigRevision: 3n }),
      update: async ({ data }: { data: Record<string, unknown> }) => { nodeUpdateData = data; return data; }
    },
    nodeAgent: {
      findUnique: async () => ({ ...agent, revokedAt: null }),
      update: async ({ data }: { data: Record<string, unknown> }) => ({ ...agent, ...data, configRevision: 3n, lastAckSequence: 2n })
    }
  } as never, { publish() {} } as never, { publishSubscriptionUpdated: async () => undefined } as never);
  await service.heartbeat(agent as never, { bootId: "boot-1", version: "0.1.0", configRevision: "3", queueDepth: 0, xrayStatus: "healthy" });
  assert.equal(Object.hasOwn(nodeUpdateData ?? {}, "controlStatus"), false);
}

async function testDueCommandIsRepublished() {
  const published: Array<{ agentId: string; commandId: string }> = [];
  const updates: Array<Record<string, unknown>> = [];
  let findCall = 0;
  const job = {
    id: "command-1",
    nodeId: "node-1",
    agentId: "agent-record-1",
    commandType: "DISABLE_USER",
    targetRevision: 3n,
    payload: { bindingId: "binding-1" },
    status: "failed",
    attempts: 1,
    nextRunAt: new Date(0),
    createdAt: new Date(0)
  };
  const service = new AgentEventsService({
    nodeCommandJob: {
      findMany: async () => (++findCall === 1 ? [] : [job]),
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return { count: 1 };
      }
    },
    node: { updateMany: async () => ({ count: 0 }) }
  } as never);
  service.publish = ((agentId: string, command: { commandId: string }) => {
    published.push({ agentId, commandId: command.commandId });
  }) as typeof service.publish;

  await service.retryDueCommands();

  assert.deepEqual(published, [{ agentId: "agent-record-1", commandId: "command-1" }]);
  assert.equal(updates[0]?.status, "running");
  assert.deepEqual(updates[0]?.attempts, { increment: 1 });
}

async function testRollbackStatusSurvivesHeartbeat() {
  let nodeUpdateData: Record<string, unknown> | null = null;
  const agent = {
    id: "agent-record-1",
    nodeId: "node-1",
    bootId: "boot-1",
    lastAckSequence: 2n
  };
  const service = new AgentService({
    node: {
      findUnique: async () => ({ controlMode: "rollback_pending", agentConfigRevision: 3n }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        nodeUpdateData = data;
        return data;
      }
    },
    nodeAgent: {
      findUnique: async () => ({ ...agent, revokedAt: null }),
      update: async ({ data }: { data: Record<string, unknown> }) => ({
        ...agent,
        ...data,
        configRevision: 3n,
        lastAckSequence: 2n
      })
    }
  } as never, { publish() {} } as never, { publishSubscriptionUpdated: async () => undefined } as never);

  await service.heartbeat(agent as never, {
    bootId: "boot-1",
    version: "0.1.0",
    configRevision: "3",
    queueDepth: 0,
    xrayStatus: "healthy"
  });

  assert.equal(nodeUpdateData?.agentLastSeenAt instanceof Date, true);
  assert.equal(Object.hasOwn(nodeUpdateData ?? {}, "controlStatus"), false);
}

async function testHeartbeatReturnsDesiredNodeRevision() {
  let storedAgentRevision: bigint | null = null;
  const agent = {
    id: "agent-record-1",
    nodeId: "node-1",
    bootId: "boot-1",
    lastAckSequence: 2n
  };
  const service = new AgentService({
    node: {
      findUnique: async () => ({ controlMode: "shadow_direct", agentConfigRevision: 4n }),
      update: async () => ({})
    },
    nodeAgent: {
      findUnique: async () => ({ ...agent, revokedAt: null }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        storedAgentRevision = data.configRevision as bigint;
        return { ...agent, ...data, lastAckSequence: 2n };
      }
    }
  } as never, { publish() {} } as never, { publishSubscriptionUpdated: async () => undefined } as never);

  const response = await service.heartbeat(agent as never, {
    bootId: "boot-1",
    version: "0.1.0",
    configRevision: "3",
    queueDepth: 0,
    xrayStatus: "healthy"
  });

  assert.equal(storedAgentRevision, 3n, "后台必须记录 Agent 当前已应用的 revision");
  assert.equal(response.configRevision, "4", "Heartbeat 必须返回节点期望 revision 触发 Agent 刷新");
}

void main();
