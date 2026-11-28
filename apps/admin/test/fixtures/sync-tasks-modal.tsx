import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import type { AdminNodeCommandJobDto, AdminNodeCommandQueueDto, AdminNodeCommandSummaryEntryDto } from "@chordv/shared";
import { SyncTasksModal } from "../../src/features/nodes/SyncTasksModal";
import type { LeaseRevocationQueueFilter } from "../../src/utils/admin-queue-filters";

// Only the standalone browser regression imports this prop fixture.
const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") ?? "empty";
function job(node: "a" | "b", index: number): AdminNodeCommandJobDto {
  return { id: `${node}-${index}`, nodeId: `node-${node}`, nodeName: `节点${node.toUpperCase()}`, commandType: "ENSURE_USER", status: "pending",
    attempts: 0, targetRevision: "1", subscriptionId: `subscription-${node}`, userId: `user-${node}`, lastError: null,
    nextRunAt: "2026-11-17T00:00:00Z", completedAt: null, createdAt: "2026-11-17T00:00:00Z", retryable: true, dismissible: true };
}
const summary = (key: string, total: number): AdminNodeCommandSummaryEntryDto => ({ key, total, pending: total, running: 0, failed: 0, lastError: null });
const scopedCount = scenario === "full" ? 200 : ["nonempty", "stale-error"].includes(scenario) ? 1 : 0;
const summaries: AdminNodeCommandQueueDto["summaries"] = {
  nodes: scenario === "global-empty" ? [] : scenario === "global" ? [summary("node-a", 203)] : [summary("node-a", 2), ...(scopedCount ? [summary("node-b", scopedCount)] : [])],
  users: [], subscriptions: [], teams: []
};
const globalQueue: AdminNodeCommandQueueDto = { jobs: scenario === "global-empty" ? [] : Array.from({ length: scenario === "global" ? 200 : 2 }, (_, i) => job("a", i)), summaries };
const scopedQueue: AdminNodeCommandQueueDto = { jobs: Array.from({ length: scopedCount }, (_, i) => job("b", i)), summaries };
const filterField = ({ node: "nodeId", user: "userId", subscription: "subscriptionId", team: "teamId" } as const)[params.get("scope") as "node"] ?? "nodeId";
const target = filterField.replace("Id", "");
let showAllClicks = 0;

declare global {
  interface Window {
    syncTasksFixture: { resolveEmpty: () => void; fail: () => void; showAllClicks: () => number };
  }
}
function Fixture() {
  const [filter, setFilter] = useState<LeaseRevocationQueueFilter | null>(scenario.startsWith("global") ? null : { [filterField]: `${target}-b`, title: "节点B的同步任务" });
  const [detail, setDetail] = useState<{ queue: AdminNodeCommandQueueDto | null; failed: boolean } | null>(scenario === "loading" ? null :
    { queue: scenario === "error" ? null : scopedQueue, failed: ["error", "stale-error"].includes(scenario) });
  window.syncTasksFixture = {
    resolveEmpty: () => setDetail({ queue: { jobs: [], summaries }, failed: false }),
    fail: () => setDetail({ queue: null, failed: true }),
    showAllClicks: () => showAllClicks
  };
  return <MantineProvider><SyncTasksModal opened leaseRevocationJobs={[]} nodeCommandQueue={globalQueue} nodeCommandQueueDetail={detail}
    leaseRetryBusyKey={null} filter={filter} onShowAll={() => { showAllClicks++; setFilter(null); }} onClose={() => {}}
    onRetryLeaseJob={() => {}} onRetryLeaseNode={() => {}} onRetryNodeCommand={() => {}} onDismissNodeCommand={() => {}} /></MantineProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
