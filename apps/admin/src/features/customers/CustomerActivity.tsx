import { Stack, Text } from "@mantine/core";
import { findNodeCommandSummary } from "../../utils/node-command-summary";
import { PanelSyncInlineStatus, LeaseRevocationInlineStatus } from "./CustomerTaskStatus";
import type { UsersPageProps } from "./types";
import type { CustomerRecord } from "./customer-model";

export function customerTasks(customer: CustomerRecord, actions: UsersPageProps) {
  const summary = findNodeCommandSummary(actions.nodeCommandQueue.summaries, customer.team ? "teams" : "users", customer.team?.id ?? customer.user!.id);
  const item = customer.team ?? customer.subscription ?? customer.user;
  const jobs = actions.leaseRevocationJobs.filter(job => customer.user ? job.userId === customer.user.id
    : Boolean(customer.summary?.id && job.subscriptionId === customer.summary.id && job.userId === null));
  const pending = jobs.filter(job => ["pending", "running", "failed"].includes(job.status));
  const hasTasks = (summary?.total ?? 0) > 0 || (item?.panelSyncSummary?.total ?? 0) > 0 || item?.panelSyncStatus === "pending" || pending.length > 0;
  return { summary, item, jobs, hasTasks };
}
export function CustomerActivity({ customer, actions }: { customer: CustomerRecord; actions: UsersPageProps }) {
  const { summary, item, jobs, hasTasks } = customerTasks(customer, actions);
  const open = () => actions.onOpenLeaseRevocationQueue(customer.user ? { userId: customer.user.id, title: customer.name }
    : { teamId: customer.team!.id, teamSubscriptionIds: actions.allSubscriptions.filter(s => s.teamId === customer.team!.id).map(s => s.id), title: customer.name });
  return <Stack gap="lg"><div><Text fw={600} size="lg">执行状态</Text><Text size="sm" c="dimmed" mt={5}>账号与订阅的变更可能仍在下发，最终执行状态以任务结果为准。</Text></div>
    <PanelSyncInlineStatus item={item} commandSummary={summary} onOpenLeaseRevocationQueue={open}/>
    <LeaseRevocationInlineStatus jobs={jobs} retryBusyKey={actions.leaseRevocationRetryBusyKey} onRetryJob={actions.onRetryLeaseRevocationJob}/>
    {!hasTasks && <Text size="sm" c="dimmed">暂无待处理任务</Text>}
  </Stack>;
}
