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
  const adminSubscriptionSource = readFileSync(path.resolve(__dirname, "../src/modules/common/admin-subscription.service.ts"), "utf8");
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
    /const replayed = await tx\.nodeCommandJob\.findUnique\(\{ where: \{ dedupeKey \} \}\);\s*\n\s*if \(replayed\) \{\s*\n\s*return replayed;\s*\n\s*\}/,
    "已存在 dedupe key 的幂等重放必须直接返回旧命令，不得触碰 resolveExhaustedCommands"
  );
  assert.match(
    agentServiceSource,
    /if \(bindingTarget\) \{\s*\n\s*await resolveExhaustedCommands\(tx, \{\s*\n\s*bindingId: bindingTarget\.id,\s*\n\s*nodeId,\s*\n\s*commandType: input\.type\s*\n\s*\}\);\s*\n\s*\} else if \(!hasUserTargeting\(payload\)\) \{\s*\n\s*await resolveExhaustedCommands\(tx, \{ nodeId, commandType: input\.type \}\);\s*\n\s*\}/,
    "解决必须按绑定；无绑定却按用户定位的命令不得回退节点级（会清掉同节点其他用户的失败）"
  );
  assert.match(
    agentServiceSource,
    /function hasUserTargeting\(payload: unknown\) \{[\s\S]*?"bindingId", "userKey", "email", "uuid"/,
    "用户定位字段判定要覆盖 agent 寻址用户的全部字段"
  );
  assert.match(
    agentServiceSource,
    /if \(!binding \|\| binding\.nodeId !== nodeId\) \{\s*\n\s*throw new BadRequestException\("命令携带的用户绑定不属于该节点"\);/,
    "他节点的绑定必须被拒绝"
  );
  assert.match(
    directMeteringSource,
    /const replayed = await tx\.nodeCommandJob\.findUnique\(\{ where: \{ dedupeKey \} \}\);\s*\n\s*if \(replayed\) \{\s*\n\s*continue;\s*\n\s*\}\s*\n\s*\/\/ Re-managing the binding[\s\S]*?await resolveExhaustedCommands/,
    "自动停用的幂等重放同样不得解决耗尽行"
  );

  // 8) Re-enable provisioning that hits unsettled disable watermarks must be
  //    RETRIED durably: the binding's own "disabled" status is the marker, so
  //    retryPendingDirectProvisioning re-runs the per-subscription sync every
  //    tick until settlement lets the re-activation through. A one-shot warn
  //    would leave the node enabled with its users permanently disabled.
  //    The candidate scan must cover BOTH shapes — existing disabled/deleted
  //    bindings AND assigned nodes with no binding at all (initial
  //    provisioning that failed before its transaction committed leaves
  //    nothing behind but the assignment). Retries must also be FAIR (cursor
  //    rotation) and skip subscriptions whose direct traffic reset is in
  //    flight; the sync runs under the SHARED subscription usage lock. The
  //    local lock path needs no DATABASE_URL.
  const previousDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  const scannedCursors: Array<string> = [];
  const synced: Array<{ subscriptionId: string; skipActiveTargets: boolean | undefined }> = [];
  const subscriptionsPool = ["sub_1", "sub_2", "sub_3"];
  const cronService = Object.assign(Object.create(RuntimeSessionService.prototype), {
    directProvisioningRetryCursor: "",
    directTrafficResetsInFlight: new Map([["sub_2", 1]]),
    prisma: {
      $queryRaw: async (_template: TemplateStringsArray, cursor: string) => {
        scannedCursors.push(cursor);
        return subscriptionsPool
          .filter((id) => id > cursor)
          .map((subscriptionId) => ({ subscriptionId }));
      },
      $transaction: async (task: (tx: unknown) => Promise<unknown>) => task({})
    },
    syncSubscriptionPanelAccessLocked: async (
      subscriptionId: string,
      options?: { ensureOnly?: boolean; skipActiveTargets?: boolean; chunkSize?: number }
    ) => {
      synced.push({
        subscriptionId,
        skipActiveTargets: options?.skipActiveTargets,
        chunkSize: options?.chunkSize
      });
      return 0;
    },
    logDirectProvisioningRetry: () => undefined
  }) as RuntimeSessionService;
  const cron = cronService as unknown as {
    retryPendingDirectProvisioning(): Promise<void>;
    directProvisioningRetryCursor: string;
  };
  await cron.retryPendingDirectProvisioning();
  assert.deepEqual(
    synced,
    [
      { subscriptionId: "sub_1", skipActiveTargets: true, chunkSize: 25 },
      { subscriptionId: "sub_3", skipActiveTargets: true, chunkSize: 25 }
    ],
    "重置进行中的订阅必须跳过；恢复模式不得重确保活跃绑定；供给按分块事务运行"
  );
  assert.equal(cron.directProvisioningRetryCursor, "", "不满一批时游标回绕到起点");
  await cron.retryPendingDirectProvisioning();
  assert.equal(synced.length, 4, "周期重试持续进行");
  assert.equal(scannedCursors[1], "", "游标回绕后从头扫起");

  // Cursor advance: a full batch leaves the cursor at the last id, so a large
  // stuck population cannot starve subscriptions behind it.
  cron.directProvisioningRetryCursor = "sub_1";
  await cron.retryPendingDirectProvisioning();
  assert.deepEqual(
    scannedCursors[2],
    "sub_1",
    "游标推进后只扫其后的订阅"
  );
  process.env.DATABASE_URL = previousDatabaseUrl;

  // A reset's in-flight marker is released when the reset finishes, so the
  // reconciler picks the subscription up on a later tick.
  const releaseService = Object.assign(Object.create(RuntimeSessionService.prototype), {
    directTrafficResetsInFlight: new Map<string, number>()
  }) as unknown as {
    withDirectTrafficResetInFlight<T>(subscriptionId: string, task: () => Promise<T>): Promise<T>;
    directTrafficResetsInFlight: Map<string, number>;
  };
  let releaseObserved = 0;
  await releaseService.withDirectTrafficResetInFlight("sub_9", async () => {
    await releaseService.withDirectTrafficResetInFlight("sub_9", async () => {
      assert.equal(releaseService.directTrafficResetsInFlight.get("sub_9"), 2, "嵌套重入要计数");
    });
    assert.equal(
      releaseService.directTrafficResetsInFlight.has("sub_9"),
      true,
      "内层释放后外层仍在进行中"
    );
    releaseObserved = 1;
  });
  assert.equal(releaseObserved, 1);
  assert.equal(
    releaseService.directTrafficResetsInFlight.has("sub_9"),
    false,
    "重置结束后标记必须释放（可重入计数归零即删）"
  );
  assert.match(
    runtimeSessionSource,
    /@Cron\("\*\/30 \* \* \* \* \*"\)\s*\n\s*@DrainableJob\(\)\s*\n\s*async retryPendingDirectProvisioning/,
    "重试必须是周期任务（停用沉降是异步的，一次性重试不够）"
  );
  assert.match(
    runtimeSessionSource,
    /this\.directProvisioningRetryCursor =\s*\n\s*subscriptions\.length >= DIRECT_PROVISIONING_RETRY_BATCH_SIZE/,
    "游标必须按批推进并在不满一批时回绕"
  );
  assert.match(
    runtimeSessionSource,
    /if \(this\.directTrafficResetsInFlight\.has\(subscriptionId\)\) \{\s*\n\s*continue;\s*\n\s*\}/,
    "重试循环必须跳过重置进行中的订阅"
  );
  assert.match(
    runtimeSessionSource,
    /WHERE b\.status IN \('disabled', 'deleted'\)/,
    "候选必须包含 disabled 与 deleted 绑定"
  );
  // Per-branch assertions: extract each UNION branch so a sloppy cross-branch
  // match cannot hide a missing predicate (that is exactly how the personal
  // branch briefly shipped without WHERE b.id IS NULL).
  const cronSqlMatch = runtimeSessionSource.match(/SELECT "subscriptionId" FROM \(([\s\S]*?)\) candidates/);
  assert.ok(cronSqlMatch, "重试候选必须是单条 UNION SQL");
  const cronSqlBranches = cronSqlMatch[1]!.split("UNION");
  assert.equal(cronSqlBranches.length, 3, "三个候选分支：绑定 + 个人缺口 + 团队缺口");
  assert.match(
    cronSqlBranches[0]!,
    /JOIN "SubscriptionNodeAccess" na ON na\."subscriptionId" = b\."subscriptionId" AND na\."nodeId" = b\."nodeId"/,
    "既有绑定分支只认仍分配给订阅的节点——已撤销节点的禁用绑定不得让订阅永久留在轮换里"
  );
  assert.match(
    cronSqlBranches[0]!,
    /AND \(\s*\n\s*\(s\."userId" IS NOT NULL AND s\."userId" = b\."userId"[\s\S]*?OR \(s\."teamId" IS NOT NULL AND b\."userId" IS NOT NULL[\s\S]*?tm\."userId" = b\."userId"/,
    "既有绑定分支只认属主仍活跃（个人用户或团队成员）——被移除成员的绑定不得永久留在轮换里"
  );
  assert.match(
    cronSqlBranches[1]!,
    /s\."userId" IS NOT NULL[\s\S]*?b\."userId" = s\."userId"\s*\n\s*WHERE b\.id IS NULL/,
    "个人订阅的缺口必须按用户比对且只选无绑定的——已供给的订阅不得每轮重供给"
  );
  assert.match(
    cronSqlBranches[2]!,
    /JOIN "TeamMember" tm[\s\S]*?b\."userId" = tm\."userId"\s*\n\s*WHERE b\.id IS NULL/,
    "团队订阅的缺口必须按成员比对——一个成员供给失败不能被其他成员的既有绑定掩盖"
  );
  assert.match(
    runtimeSessionSource,
    /const activeBindingKeys = new Set<string>\(\s*\n\s*options\?\.skipActiveTargets/,
    "恢复模式的 sync 必须先取活跃绑定集合"
  );
  assert.match(
    runtimeSessionSource,
    /if \(activeBindingKeys\.has\(`\$\{access\.node\.id\}:\$\{target\.userId\}`\)\) \{\s*\n\s*continue;\s*\n\s*\}/,
    "恢复模式必须跳过已有活跃绑定的目标——不得每轮重确保（revision 与命令会无限增长）"
  );
  assert.match(
    runtimeSessionSource,
    /private async runDirectSubscriptionAccessSyncLocked\(subscriptionId: string\) \{\s*\n\s*return runWithSubscriptionProvisioningLock\(subscriptionId, \(\) =>\s*\n\s*this\.syncSubscriptionPanelAccessLocked\(subscriptionId, \{\s*\n\s*ensureOnly: true,\s*\n\s*skipActiveTargets: true,\s*\n\s*chunkSize: DIRECT_PROVISIONING_TX_BATCH_SIZE\s*\n\s*\}\)\s*\n\s*\);/,
    "重试与重启用供给必须持供给锁、以恢复模式运行、按分块事务供给"
  );

  // 9) Bulk provisioning must not run as one unbounded interactive
  //    transaction: a large team would always exceed any single budget, and a
  //    reconciler repeating it can never make progress. Bounded atomic chunks
  //    (each with an explicit timeout) keep the per-binding invariant while
  //    staying under the provisioning lock.
  assert.match(
    runtimeSessionSource,
    /async queueDirectSubscriptionAccessSync\(subscriptionId: string\) \{\s*\n\s*\/\/ Bounded atomic chunks under the SHARED provisioning lock[\s\S]*?return runWithSubscriptionProvisioningLock\(subscriptionId, \(\) =>\s*\n\s*this\.syncSubscriptionPanelAccessLocked\(subscriptionId, \{\s*\n\s*ensureOnly: true,\s*\n\s*chunkSize: DIRECT_PROVISIONING_TX_BATCH_SIZE\s*\n\s*\}\)\s*\n\s*\);/,
    "公共供给入口必须持供给锁并按分块事务供给"
  );
  assert.match(
    runtimeSessionSource,
    /for \(let index = 0; index < provisioningPairs\.length; index \+= options\.chunkSize\) \{\s*\n\s*const chunk = provisioningPairs\.slice\(index, index \+ options\.chunkSize\);[\s\S]*?\$transaction\([\s\S]*?\{ timeout: DIRECT_PROVISIONING_TX_TIMEOUT_MS \}/,
    "供给目标必须按 chunkSize 分块、每块显式超时的事务提交"
  );
  assert.match(
    runtimeSessionSource,
    /for \(const binding of unsettledBlockedBindings\) \{\s*\n\s*try \{\s*\n\s*await assertDirectTerminalWatermarksSettled\(writer, binding\);\s*\n\s*\} catch \{\s*\n\s*blockedPairKeys\.add\(`\$\{binding\.nodeId\}:\$\{binding\.userId\}`\);\s*\n\s*\}\s*\n\s*\}/,
    "未沉降的目标必须在分块前逐个识别并跳过——一个离线节点不得挡住其他健康节点的供给（队头阻塞）"
  );
  assert.match(
    runtimeSessionSource,
    /if \(blockedPairKeys\.has\(`\$\{access\.node\.id\}:\$\{target\.userId\}`\)\) \{\s*\n\s*continue;\s*\n\s*\}/,
    "被跳过的目标留给下轮重试（绑定保持 disabled，reconciler 会再来）"
  );
  assert.match(
    runtimeSessionSource,
    /provisioned \+= await runWithSubscriptionUsageLock\(subscriptionId, \(\) =>\s*\n\s*this\.prisma\.\$transaction\(/,
    "每个分块必须在 usage 锁下运行——计量随时可能并发改变资格（供给锁不排除计量）"
  );
  assert.match(
    runtimeSessionSource,
    /if \(!fresh \|\| !shouldProvisionPanelClients\(fresh\)\) \{\s*\n\s*return 0;\s*\n\s*\}/,
    "每块事务内必须重读订阅并用共享谓词重检资格——中途耗尽/停用不得被陈旧供给覆盖"
  );
  assert.match(
    runtimeSessionSource,
    /const targetStillEligible = fresh\.teamId[\s\S]*?if \(!targetStillEligible\) \{\s*\n\s*continue;\s*\n\s*\}/,
    "每块事务内必须逐目标重检（团队成员仍在/个人用户仍活跃）"
  );
  // 10) The traffic reset excludes provisioning with the PROVISIONING lock for
  //     its whole span but takes the USAGE lock only around the final counter
  //     transaction: settlement needs the agent's final batches accounted,
  //     and ingestion takes the usage lock — holding it during the settle wait
  //     would deadlock the reset against its own settlement.
  assert.match(
    adminSubscriptionSource,
    /await this\.runtimeSessionService\.withDirectTrafficResetInFlight\(subscription\.id, async \(\) => \{\s*\n\s*await runWithSubscriptionProvisioningLock\(subscription\.id, async \(\) => \{\s*\n\s*await this\.quiesceAndSettleDirectTrafficReset\(subscription\.id, targetUserId\);/,
    "流量重置必须从 quiesce 起持有供给锁（与供给互斥）"
  );
  assert.match(
    adminSubscriptionSource,
    /const resetSampledAt = new Date\(\);\s*\n\s*await runWithSubscriptionUsageLock\(subscription\.id, async \(\) => \{\s*\n\s*try \{/,
    "usage 锁只包最终计数事务——沉降等待期间计量批次必须能入账"
  );
  const usageLockUtilsSource = readFileSync(
    path.resolve(__dirname, "../src/modules/common/usage-lock.utils.ts"),
    "utf8"
  );
  assert.match(
    usageLockUtilsSource,
    /export async function runWithSubscriptionProvisioningLock/,
    "供给锁必须是独立锁键（不与 usage 锁共用键空间）"
  );

  console.log("runtime session regression passed (connect 门不反转、供给资格共享判定、节点禁用联动绑定、删除绑定保留计量基线)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
