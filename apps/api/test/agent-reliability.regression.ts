import assert from "node:assert/strict";
import { AgentEventsService } from "../src/modules/agent/agent-events.service";
import { AgentService } from "../src/modules/agent/agent.service";

async function main() {
  await testDueCommandIsRepublished();
  await testExhaustionInterleavings();
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

async function testExhaustionInterleavings() {
  for (const scenario of ["replacement", "completed", "uncovered", "remove", "raw-user", "node-wide", "other-binding", "older"] as const) {
    const job: Record<string, any> = {
      id: "old", nodeId: "node-1", bindingId: "binding-1", commandType: "ENSURE_USER",
      targetRevision: 1n, status: "failed", attempts: 8, resolvedAt: null,
      dedupeKey: "old-key"
    };
    let scanCount = 0;
    let locked = false;
    let degraded = false;
    const replacements: Array<Record<string, any>> = [];
    const tx = {
      $queryRaw: async () => {
        locked = true;
        // The replacement commits after the candidate scan, before the sweep
        // acquires Node: this is the review's missing interleaving.
        if (scenario === "completed") job.status = "completed";
        else if (scenario !== "uncovered") replacements.push({
          nodeId: job.nodeId,
          bindingId: scenario === "other-binding" ? "binding-2" :
            ["raw-user", "node-wide"].includes(scenario) ? null : job.bindingId,
          commandType: scenario === "remove" ? "REMOVE_USER" : job.commandType,
          targetRevision: scenario === "older" ? 0n : 2n,
          payload: scenario === "raw-user" ? { email: "other@example.test" } : {},
          status: "completed"
        });
        return [];
      },
      nodeCommandJob: {
        findFirst: async () => {
          assert.equal(locked, true);
          return job.status === "completed" ? null : job;
        },
        findMany: async ({ where }: { where: any }) => {
          assert.equal(locked, true);
          return replacements.filter(row => row.nodeId === where.nodeId && row.targetRevision > where.targetRevision.gt &&
            where.OR.some((scope: any) => row.bindingId === scope.bindingId &&
              (typeof scope.commandType === "string" ? row.commandType === scope.commandType : scope.commandType.in.includes(row.commandType))));
        },
        update: async ({ data }: { data: any }) => { Object.assign(job, data); return job; }
      },
      node: { updateMany: async () => { degraded = true; return { count: 1 }; } }
    };
    const service = new AgentEventsService({
      nodeCommandJob: { findMany: async () => ++scanCount === 1 ? [{ ...job }] : [] },
      $transaction: async (run: (value: typeof tx) => Promise<unknown>) => run(tx)
    } as never);
    await service.retryDueCommands();
    if (scenario === "completed") {
      assert.equal(job.status, "completed", "扫描后完成的命令不得被取消覆盖");
      assert.equal(degraded, false);
    } else {
      const covered = ["replacement", "remove", "node-wide"].includes(scenario);
      assert.equal(job.status, "cancelled");
      assert.equal(job.resolvedAt instanceof Date, covered, scenario);
      assert.equal(degraded, !covered, scenario);
    }
  }
}
