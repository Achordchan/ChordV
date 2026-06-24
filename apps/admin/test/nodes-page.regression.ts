import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AdminLeaseRevocationJobDto } from "@chordv/shared";
import { filterLeaseRevocationJobs } from "../src/utils/admin-queue-filters";

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
      /<Button[\s\S]*?color="yellow"[\s\S]*?onOpenPanelSyncQueue/,
      `${label} page should let admins open the sync queue from pending inline status`
    );
  }
}

function testNodeRefreshAndQueueRetryButtonsExposeScopedBusyState() {
  assert.match(
    nodesPageSource,
    /loading=\{props\.refreshingNodeId === item\.id\}[\s\S]*?disabled=\{props\.refreshingNodeId !== null && props\.refreshingNodeId !== item\.id\}/,
    "node refresh should only block other node refresh buttons, not leave the whole node page ambiguous"
  );
  assert.match(
    nodesPageSource,
    /loading=\{props\.panelRetryBusyKey === `job:\$\{job\.id\}`\}[\s\S]*?disabled=\{!retryable \|\| \(props\.panelRetryBusyKey !== null && props\.panelRetryBusyKey !== `job:\$\{job\.id\}`\)\}/,
    "panel sync retry should show row-scoped busy state and block competing retry clicks"
  );
  assert.match(
    nodesPageSource,
    /loading=\{props\.leaseRetryBusyKey === `lease-job:\$\{job\.id\}`\}[\s\S]*?disabled=\{!retryable \|\| \(props\.leaseRetryBusyKey !== null && props\.leaseRetryBusyKey !== `lease-job:\$\{job\.id\}`\)\}/,
    "lease revocation retry should show row-scoped busy state and block competing retry clicks"
  );
}

function testNodeParentActionsAlwaysReleaseBusyState() {
  const expectations = [
    ["handleProbeNode", /finally\s*{[\s\S]*?setProbingNodeId\(null\);[\s\S]*?probingBusyRef\.current = false;[\s\S]*?}/],
    ["handleProbeAllNodes", /finally\s*{[\s\S]*?setProbingAll\(false\);[\s\S]*?probingBusyRef\.current = false;[\s\S]*?}/],
    ["handleRefreshNode", /finally\s*{[\s\S]*?refreshingNodeRef\.current = null;[\s\S]*?setRefreshingNodeId\(null\);[\s\S]*?}/],
    ["handleRetryPanelSyncJob", /finally\s*{[\s\S]*?setPanelSyncRetryBusyKey\(null\);[\s\S]*?panelSyncRetryBusyRef\.current = false;[\s\S]*?}/],
    ["handleRetryNodePanelSyncJobs", /finally\s*{[\s\S]*?setPanelSyncRetryBusyKey\(null\);[\s\S]*?panelSyncRetryBusyRef\.current = false;[\s\S]*?}/],
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
testNodeRefreshAndQueueRetryButtonsExposeScopedBusyState();
testNodeParentActionsAlwaysReleaseBusyState();

console.log("admin nodes page regression checks passed");
