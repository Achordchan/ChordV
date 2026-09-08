import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { RuntimeSessionService } from "../src/modules/common/runtime-session.service";
import { applyDirectBatch } from "../src/modules/agent/agent-direct-metering";
import { buildSnapshotKey, shouldProvisionPanelClients } from "../src/modules/common/runtime-session.utils";
import { usesAgentControl } from "../src/modules/common/node-control-mode";
import { isNodeOnboardingReady } from "../src/modules/common/node-onboarding-policy";

// R3 regression trio: three behaviors a review round caught being broken by
// the panel retirement — every one of them silently wrong without these.

// 1) The connect gate must ADMIT direct_primary (the only supported mode now).
//    An inverted condition rejects every connection to a registered, enabled
//    node — no normal client can connect at all.
const runtimeSessionSource = readFileSync(path.resolve(__dirname, "../src/modules/common/runtime-session.service.ts"), "utf8");
assert.equal(usesAgentControl("direct_primary"), true, "direct_primary 必须由 agent 控制");
assert.equal(usesAgentControl("xui_primary"), false, "xui_primary 不再受支持");
assert.match(
  runtimeSessionSource,
  /if \(!usesAgentControl\(node\.controlMode\)\) \{\s*\n\s*throw new ForbiddenException\("当前节点控制模式不可用"\);/,
  "connect 的门槛必须是「非 agent 控制才拒绝」，反转会让所有 direct 节点无法连接"
);
assert.doesNotMatch(
  runtimeSessionSource,
  /if \(usesAgentControl\(node\.controlMode\)\) \{\s*\n\s*throw new ForbiddenException/,
  "connect 不得拒绝 agent 控制的节点"
);

// 2) Provisioning eligibility must go through the SHARED predicate: it carries
//    the team/account status checks a bare subscription.state check drops —
//    renewing an active subscription of a DISABLED team would otherwise
//    re-provision (ENSURE_USER) credentials the team shutdown disabled.
const baseSubscription = {
  state: "active" as const,
  expireAt: new Date(Date.now() + 86_400_000),
  remainingTrafficGb: 100
};
assert.equal(shouldProvisionPanelClients(baseSubscription), true, "活跃订阅应供给");
assert.equal(
  shouldProvisionPanelClients({ ...baseSubscription, team: { status: "suspended" as never } }),
  false,
  "被停用团队的订阅不得供给（绕过会恢复团队停用禁用的凭据）"
);
assert.equal(
  shouldProvisionPanelClients({ ...baseSubscription, user: { status: "disabled" as const } }),
  false,
  "被停用账户的订阅不得供给"
);
assert.equal(
  shouldProvisionPanelClients({ ...baseSubscription, remainingTrafficGb: 0 }),
  false,
  "流量耗尽的订阅不得供给"
);
assert.match(
  runtimeSessionSource,
  /const shouldProvision = shouldProvisionPanelClients\(subscription\);/,
  "供给资格必须走共享判定函数，不得内联简化"
);

// 3) Disabling a node must disable its bindings too: getConfig does not check
//    node.isActive, so previously issued credentials would keep working on the
//    disabled node outside the managed client's lease handling.
const adminNodeSource = readFileSync(path.resolve(__dirname, "../src/modules/common/admin-node.service.ts"), "utf8");
assert.match(
  adminNodeSource,
  /markPanelBindingsDisabledForNode\(nodeId\)/,
  "禁用节点必须同时禁用其绑定（否则已发凭据在 getConfig 下继续可用）"
);
assert.match(
  runtimeSessionSource,
  /async markPanelBindingsDisabledForNode\(nodeId: string\) \{[\s\S]*?markPanelBindingsDisabledForSubscription\(subscription\.id, \{ nodeIds: \[nodeId\] \}\)/,
  "节点级禁用必须逐订阅按节点过滤执行"
);

// Guard the gate's neighbors too: an onboarding-ready direct node must pass
// the policy check that the connect path relies on.
assert.equal(
  isNodeOnboardingReady({
    registrationStatus: "agent_ready",
    protocol: "vless",
    security: "reality",
    uuid: "11111111-1111-4111-8111-111111111111",
    realityPublicKey: "k".repeat(43),
    serverName: "www.microsoft.com",
    fingerprint: "chrome",
    serverHost: "203.0.113.7",
    serverPort: 443
  }),
  true,
  "agent_ready + 已部署参数的节点必须可连"
);

// 4) Deleting a binding must NOT drop its traffic snapshot. The snapshot is the
//    accounting BASELINE, not panel residue: REMOVE_USER only queues the
//    command, so the agent can still report usage up to its final removal
//    sample afterwards. Without the baseline every late batch is billed as a
//    full counter reading (from zero), inflating the subscription's usage.
async function main() {
  const snapshotKey = buildSnapshotKey("node_1", "sub_1", "user_1");
  const snapshots = new Map<string, { snapshotKey: string; uplinkBytes: bigint; downlinkBytes: bigint; counterGeneration: string }>([
    [snapshotKey, { snapshotKey, uplinkBytes: 1000n, downlinkBytes: 500n, counterGeneration: "gen-1" }]
  ]);
  const binding = {
    id: "binding_1",
    nodeId: "node_1",
    subscriptionId: "sub_1",
    userId: "user_1",
    teamId: "team_1",
    panelClientEmail: "member@example.invalid",
    panelClientId: "11111111-1111-4111-8111-111111111111",
    status: "active",
    source: "direct",
    directDisableWatermarks: null,
    lastUplinkBytes: 1000n,
    lastDownlinkBytes: 500n,
    subscription: {
      id: "sub_1",
      state: "active",
      expireAt: new Date(Date.now() + 86_400_000),
      totalTrafficBytes: 10_000n,
      totalTrafficGb: 0,
      usedTrafficBytes: 0n,
      usedTrafficGb: 0,
      remainingTrafficGb: 100
    }
  };
  const subscriptionUpdates: Array<{ usedTrafficBytes: bigint }> = [];
  const ledgerRows: Array<{ usedTrafficBytes: bigint }> = [];
  const writer = {
    panelClientBinding: {
      findMany: async () => [binding],
      updateMany: async ({ data }: { data: { status: string } }) => {
        binding.status = data.status;
        return { count: 1 };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(binding, data);
        return binding;
      }
    },
    trafficSnapshot: {
      // The regression: queueing the delete must not touch the baseline.
      deleteMany: async () => {
        throw new Error("删除绑定不得删除计量基线（末次样本仍会到达）");
      },
      findMany: async ({ where }: { where: { snapshotKey: { in: string[] } } }) =>
        [...snapshots.values()].filter((snapshot) => where.snapshotKey.in.includes(snapshot.snapshotKey)),
      updateMany: async () => ({ count: 0 }),
      upsert: async ({ where, create }: { where: { snapshotKey: string }; create: Record<string, unknown> }) => {
        snapshots.set(where.snapshotKey, {
          snapshotKey: where.snapshotKey,
          uplinkBytes: create.uplinkBytes as bigint,
          downlinkBytes: create.downlinkBytes as bigint,
          counterGeneration: create.counterGeneration as string
        });
        return create;
      }
    },
    subscription: {
      update: async ({ data }: { data: { usedTrafficBytes: bigint } }) => {
        subscriptionUpdates.push(data);
        return data;
      }
    },
    trafficLedger: {
      createMany: async ({ data }: { data: Array<{ usedTrafficBytes: bigint }> }) => {
        ledgerRows.push(...data);
        return { count: data.length };
      }
    }
  };
  const service = Object.assign(Object.create(RuntimeSessionService.prototype), {
    queueDirectBindingCommand: async () => undefined,
    publishSyncQueueUpdatedBestEffort: () => undefined
  }) as RuntimeSessionService;
  const queued = await service.queuePanelDeleteJobsForSubscriptionTx(writer as never, "sub_1");
  assert.equal(queued, 1, "删除应逐绑定排队 REMOVE_USER");
  assert.equal(binding.status, "deleted", "排队后绑定应标记为 deleted");
  assert.equal(snapshots.size, 1, "删除绑定不得删除计量基线");

  // The agent's final sample arrives after the binding was marked deleted (the
  // watermark is only reported with the command result, and may itself still be
  // unacknowledged): it must be billed as a DELTA against the surviving baseline.
  await applyDirectBatch(writer as never, "agent_1", "node_1", new Date(), "boot-1", 7n, [
    {
      bindingId: "binding_1",
      counterGeneration: "gen-1",
      uplinkBytes: "1500",
      downlinkBytes: "700",
      uplinkDeltaBytes: "500",
      downlinkDeltaBytes: "200"
    }
  ]);
  assert.equal(ledgerRows.length, 1, "末次样本必须入账");
  assert.equal(ledgerRows[0]?.usedTrafficBytes, 700n, "末次样本必须按基线差额计费，而不是从零起算");
  assert.equal(subscriptionUpdates[0]?.usedTrafficBytes, 700n, "订阅已用流量必须只增加差额");

  // 5) The transaction-scoped entry point must actually use the caller's
  //    writer: falling back to the root client would silently drop the
  //    surrounding transaction and let half-applied provisioning commit.
  const scopedService = Object.assign(Object.create(RuntimeSessionService.prototype), {
    prisma: {
      subscription: {
        findUnique: async () => {
          throw new Error("事务作用域入口不得使用根客户端");
        }
      }
    }
  }) as RuntimeSessionService;
  const scopedCount = await scopedService.queueDirectSubscriptionAccessSyncTx(
    { subscription: { findUnique: async () => null } } as never,
    "sub_missing"
  );
  assert.equal(scopedCount, 0, "订阅不存在时事务作用域入口应返回 0");

  // 6) User commands must carry their binding target as COLUMNS. The admin
  //    queue aggregates outstanding commands per subscription/user/team to
  //    keep the pending indicator alive across list refreshes, and it cannot
  //    read the payload JSON for that. Both enqueue sites must write them.
  const bindingColumns = /bindingId: binding\.id,\s*\n\s*subscriptionId: binding\.subscriptionId,\s*\n\s*userId: binding\.userId,\s*\n\s*teamId: binding\.teamId/;
  assert.match(runtimeSessionSource, bindingColumns, "queueDirectBindingCommand 必须写入绑定的订阅/用户/团队列");
  const directMeteringSource = readFileSync(
    path.resolve(__dirname, "../src/modules/agent/agent-direct-metering.ts"),
    "utf8"
  );
  assert.match(directMeteringSource, bindingColumns, "自动停用命令也必须写入绑定的订阅/用户/团队列");

  // 7) Resolving exhausted (cancelled) commands must only happen when a
  //    GENUINELY NEW command is ordered. An idempotent replay hitting an
  //    existing dedupe key orders nothing — resolving then would clear a
  //    newer retry-exhausted failure with no replacement in flight.
  const agentServiceSource = readFileSync(
    path.resolve(__dirname, "../src/modules/agent/agent.service.ts"),
    "utf8"
  );
  assert.match(
    agentServiceSource,
    /const replayed = await tx\.nodeCommandJob\.findUnique\(\{ where: \{ dedupeKey \} \}\);\s*\n\s*if \(replayed\) \{\s*\n\s*return replayed;\s*\n\s*\}\s*\n\s*\/\/ Target-less commands[\s\S]*?await resolveExhaustedCommands\(tx, \{ nodeId, commandType: input\.type \}\);/,
    "已存在 dedupe key 的幂等重放必须直接返回旧命令，不得触碰 resolveExhaustedCommands"
  );
  assert.match(
    directMeteringSource,
    /const replayed = await tx\.nodeCommandJob\.findUnique\(\{ where: \{ dedupeKey \} \}\);\s*\n\s*if \(replayed\) \{\s*\n\s*continue;\s*\n\s*\}\s*\n\s*\/\/ Re-managing the binding[\s\S]*?await resolveExhaustedCommands/,
    "自动停用的幂等重放同样不得解决耗尽行"
  );

  console.log("runtime session regression passed (connect 门不反转、供给资格共享判定、节点禁用联动绑定、删除绑定保留计量基线)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
