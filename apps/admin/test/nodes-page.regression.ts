import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AdminLeaseRevocationJobDto, AdminNodeCommandJobDto } from "@chordv/shared";
import { filterLeaseRevocationJobs, filterNodeCommandJobs } from "../src/utils/admin-queue-filters";

const nodesPageSource = readFileSync(resolve(import.meta.dirname, "../src/pages/NodesPage.tsx"), "utf8");
const usersPageSource = readFileSync(resolve(import.meta.dirname, "../src/pages/UsersPage.tsx"), "utf8");
const subscriptionsPageSource = readFileSync(resolve(import.meta.dirname, "../src/pages/SubscriptionsPage.tsx"), "utf8");
const appSource = readFileSync(resolve(import.meta.dirname, "../src/App.tsx"), "utf8");

function extractAsyncFunctionBody(source: string, functionName: string) {
  const signature = `async function ${functionName}`;
  const signatureIndex = source.indexOf(signature);
  assert.notEqual(signatureIndex, -1, `${functionName} should exist`);

  const bodyStart = source.indexOf("{", signatureIndex);
  assert.notEqual(bodyStart, -1, `${functionName} should have a body`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(bodyStart + 1, index);
      }
    }
  }

  assert.fail(`${functionName} body should be closed`);
}

function makeLeaseJob(input: Partial<AdminLeaseRevocationJobDto>): AdminLeaseRevocationJobDto {
  return {
    id: input.id ?? "lease_job_1",
    reason: input.reason ?? "team_member_disconnected",
    status: input.status ?? "pending",
    subscriptionId: input.subscriptionId ?? null,
    userId: input.userId ?? null,
    nodeId: input.nodeId ?? null,
    nodeName: input.nodeName ?? null,
    attempts: input.attempts ?? 0,
    nextRunAt: input.nextRunAt ?? "2026-01-01T00:00:00.000Z",
    lockedAt: input.lockedAt ?? null,
    lastError: input.lastError ?? null,
    completedAt: input.completedAt ?? null,
    createdAt: input.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-01-01T00:00:00.000Z"
  };
}

function testTeamOnlyQueueFilterDoesNotHideLeaseRevocationJobs() {
  const jobs = [
    makeLeaseJob({
      id: "lease_job_team",
      subscriptionId: "subscription_team",
      userId: "user_1"
    })
  ];

  const result = filterLeaseRevocationJobs(jobs, { teamId: "team_1" });

  assert.deepEqual(
    result.map((job) => job.id),
    ["lease_job_team"],
    "team-level queue views must not hide lease revocation jobs that do not expose teamId"
  );
}

function testSpecificQueueFiltersStillApplyToLeaseRevocationJobs() {
  const jobs = [
    makeLeaseJob({ id: "match", subscriptionId: "subscription_1", userId: "user_1", nodeId: "node_1" }),
    makeLeaseJob({ id: "other", subscriptionId: "subscription_2", userId: "user_2", nodeId: "node_2" })
  ];

  assert.deepEqual(
    filterLeaseRevocationJobs(jobs, { subscriptionId: "subscription_1" }).map((job) => job.id),
    ["match"]
  );
  assert.deepEqual(
    filterLeaseRevocationJobs(jobs, { userId: "user_1" }).map((job) => job.id),
    ["match"]
  );
  assert.deepEqual(
    filterLeaseRevocationJobs(jobs, { nodeId: "node_1" }).map((job) => job.id),
    ["match"]
  );
}

function testPendingAndFailedBackgroundJobsAreRetryable() {
  assert.match(
    nodesPageSource,
    /return status === "pending" \|\| status === "failed";/,
    "pending and failed queue jobs must both be retryable because the backend accepts both statuses"
  );
  assert.match(
    nodesPageSource,
    /return summary\.pending > 0 \|\| summary\.failed > 0;/,
    "node-level retry buttons must be available for pending-only queues, not only failed queues"
  );
}

function testUserAndSubscriptionPendingPanelSyncUseYellowInlineStatus() {
  for (const [label, source] of [
    ["users", usersPageSource],
    ["subscriptions", subscriptionsPageSource]
  ] as const) {
    assert.match(
      source,
      /function PanelSyncInlineStatus/,
      `${label} page should expose inline panel sync status`
    );
    assert.match(
      source,
      /panelSyncStatus !== "pending" && \(summary\?\.total \?\? 0\) === 0/,
      `${label} page should only show inline status for pending or active queue summaries`
    );
    assert.match(
      source,
      /<Badge color="yellow" variant="light">/,
      `${label} page pending panel sync status should be yellow, not a red failure`
    );
    assert.match(
      source,
      /<Button[\s\S]*?color="yellow"[\s\S]*?onOpenLeaseRevocationQueue/,
      `${label} page should let admins open the lease revocation queue from pending inline status`
    );
  }
}

function testLeaseRevocationQueueRetryButtonsExposeScopedBusyState() {
  assert.match(
    nodesPageSource,
    /loading=\{props\.leaseRetryBusyKey === `lease-job:\$\{job\.id\}`\}[\s\S]*?disabled=\{!retryable \|\| \(props\.leaseRetryBusyKey !== null && props\.leaseRetryBusyKey !== `lease-job:\$\{job\.id\}`\)\}/,
    "lease revocation retry should show row-scoped busy state and block competing retry clicks"
  );
  assert.match(
    nodesPageSource,
    /loading=\{props\.leaseRetryBusyKey === `lease-node:\$\{job\.nodeId\}`\}[\s\S]*?disabled=\{!nodeRetryable \|\| \(props\.leaseRetryBusyKey !== null && props\.leaseRetryBusyKey !== `lease-node:\$\{job\.nodeId\}`\)\}/,
    "node-level lease revocation retry should show row-scoped busy state and block competing retry clicks"
  );
}

// Direct provisioning is stored in NodeCommandJob, not the lease queue: the
// pending inline status must lead to those commands, filtered by the same
// subscription/user/node scope.
function testNodeCommandQueueShowsDirectProvisioning() {
  const commands: AdminNodeCommandJobDto[] = [
    {
      id: "cmd_ensure",
      nodeId: "node_1",
      nodeName: "东京",
      commandType: "ENSURE_USER",
      status: "pending",
      attempts: 0,
      targetRevision: "7",
      subscriptionId: "subscription_1",
      userId: "user_1",
      lastError: null,
      nextRunAt: "2026-01-01T00:00:05.000Z",
      completedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z"
    },
    {
      id: "cmd_other",
      nodeId: "node_2",
      nodeName: "大阪",
      commandType: "REMOVE_USER",
      status: "failed",
      attempts: 3,
      targetRevision: "9",
      subscriptionId: "subscription_2",
      userId: "user_2",
      lastError: "agent offline",
      nextRunAt: "2026-01-01T00:00:10.000Z",
      completedAt: null,
      createdAt: "2026-01-01T00:00:01.000Z"
    }
  ];

  assert.deepEqual(
    filterNodeCommandJobs(commands, { subscriptionId: "subscription_1" }).map((job) => job.id),
    ["cmd_ensure"],
    "订阅视角必须能看到属于它的 ENSURE_USER 命令"
  );
  assert.deepEqual(filterNodeCommandJobs(commands, { userId: "user_1" }).map((job) => job.id), ["cmd_ensure"]);
  assert.deepEqual(filterNodeCommandJobs(commands, { nodeId: "node_2" }).map((job) => job.id), ["cmd_other"]);
  assert.deepEqual(filterNodeCommandJobs(commands, { teamId: "team_1" }).map((job) => job.id), [
    "cmd_ensure",
    "cmd_other"
  ], "团队视角不得隐藏不暴露 teamId 的命令");

  assert.match(
    nodesPageSource,
    /filterNodeCommandJobs\(props\.nodeCommandJobs, props\.filter\)/,
    "队列抽屉必须按当前过滤条件展示节点命令"
  );
  assert.match(nodesPageSource, /节点命令同步/, "队列抽屉必须包含节点命令分区");
  assert.match(nodesPageSource, /translateNodeCommandType\(job\.commandType\)/);
  assert.match(
    appSource,
    /<PanelSyncQueueDrawer[\s\S]*?nodeCommandJobs=\{snapshot\.nodeCommandJobs\}/,
    "抽屉必须拿到快照里的节点命令"
  );
  assert.match(
    nodesPageSource,
    /summarizeNodeCommandJobsForNode\(props\.nodeCommandJobs, props\.node\.id\)/,
    "节点行的同步状态必须统计该节点的命令"
  );
  assert.match(
    nodesPageSource,
    /if \(leaseSummary\.total <= 0 && commandSummary\.total <= 0\) \{\s*return \(\s*<Badge color="green" variant="light">\s*已同步/,
    "只有连接撤销与节点命令都为空时才能显示已同步"
  );
  assert.match(nodesPageSource, /buildBackgroundSyncLabel\("节点命令", commandSummary\)/);
  assert.match(
    appSource,
    /<NodesPage[\s\S]*?nodeCommandJobs=\{snapshot\.nodeCommandJobs\}/,
    "节点页必须拿到快照里的节点命令"
  );
}

function testNodeParentActionsAlwaysReleaseBusyState() {
  const expectations = [
    ["handleProbeNode", /finally\s*{[\s\S]*?setProbingNodeId\(null\);[\s\S]*?probingBusyRef\.current = false;[\s\S]*?}/],
    ["handleProbeAllNodes", /finally\s*{[\s\S]*?setProbingAll\(false\);[\s\S]*?probingBusyRef\.current = false;[\s\S]*?}/],
    ["handleRetryLeaseRevocationJob", /finally\s*{[\s\S]*?setLeaseRevocationRetryBusyKey\(null\);[\s\S]*?leaseRevocationRetryBusyRef\.current = false;[\s\S]*?}/],
    ["handleRetryNodeLeaseRevocationJobs", /finally\s*{[\s\S]*?setLeaseRevocationRetryBusyKey\(null\);[\s\S]*?leaseRevocationRetryBusyRef\.current = false;[\s\S]*?}/],
    ["handleDeleteNode", /finally\s*{[\s\S]*?setDeleteNodeSubmitting\(false\);[\s\S]*?deleteNodeSubmittingRef\.current = false;[\s\S]*?}/]
  ] as const;

  for (const [functionName, pattern] of expectations) {
    assert.match(
      extractAsyncFunctionBody(appSource, functionName),
      pattern,
      `${functionName} must release its busy state in finally`
    );
  }
}

testTeamOnlyQueueFilterDoesNotHideLeaseRevocationJobs();
testSpecificQueueFiltersStillApplyToLeaseRevocationJobs();
testPendingAndFailedBackgroundJobsAreRetryable();
testUserAndSubscriptionPendingPanelSyncUseYellowInlineStatus();
testLeaseRevocationQueueRetryButtonsExposeScopedBusyState();
testNodeCommandQueueShowsDirectProvisioning();
testNodeParentActionsAlwaysReleaseBusyState();

console.log("admin nodes page regression checks passed");
