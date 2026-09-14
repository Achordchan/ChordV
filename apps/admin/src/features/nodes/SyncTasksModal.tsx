import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import { IconCircleCheck } from "@tabler/icons-react";
import type { AdminLeaseRevocationJobDto, AdminNodeCommandQueueDto } from "@chordv/shared";
import { DataSkeleton } from "../shared/DataSkeleton";
import { filterLeaseRevocationJobs, hasLeaseRevocationQueueFilter, hasNodeCommandQueueFilter, type LeaseRevocationQueueFilter } from "../../utils/admin-queue-filters";
import { sumNodeCommandSummaries } from "../../utils/node-command-summary";
import { nodeCommandStatusColor, translateNodeCommandStatus, translateNodeCommandType } from "../../utils/admin-translate";
import { formatDateTime } from "../../utils/admin-format";
import dialogStyles from "../editors/EditorDialog.module.css";
import styles from "./SyncTasksModal.module.css";

export function SyncTasksModal(props: {
  opened: boolean;
  leaseRevocationJobs: AdminLeaseRevocationJobDto[];
  nodeCommandQueue: AdminNodeCommandQueueDto;
  // Server-side filtered detail for the CURRENT target (keyed by filter in
  // App; null when absent or failed): the cached list above is capped, so a
  // busy target's commands may fall outside it entirely.
  nodeCommandQueueDetail?: { queue: AdminNodeCommandQueueDto | null; failed: boolean } | null;
  leaseRetryBusyKey: string | null;
  filter?: LeaseRevocationQueueFilter | null;
  onClose: () => void;
  onShowAll?: () => void;
  onRetryLeaseJob: (jobId: string) => void;
  onRetryLeaseNode: (nodeId: string) => void;
}) {
  const leases = filterLeaseRevocationJobs(props.leaseRevocationJobs, props.filter);
  const scoped = hasNodeCommandQueueFilter(props.filter);
  const filtered = scoped || hasLeaseRevocationQueueFilter(props.filter);
  const detail = props.nodeCommandQueueDetail;
  const commands = scoped ? detail?.queue?.jobs ?? [] : props.nodeCommandQueue.jobs;
  const loading = scoped && !detail?.queue && !detail?.failed;
  const failed = scoped && Boolean(detail?.failed);
  const commandTotal = sumNodeCommandSummaries((scoped ? detail?.queue : props.nodeCommandQueue)?.summaries, "nodes");
  const empty = !loading && !failed && leases.length === 0 && commands.length === 0 && commandTotal === 0;
  return <Modal opened={props.opened} onClose={props.onClose} centered size={empty ? 480 : 720} title="同步任务" classNames={{content: dialogStyles.content, header: dialogStyles.header, title: dialogStyles.title, body: dialogStyles.body}}>
    <Stack className={styles.body} gap="lg">
      {filtered ? <Group justify="space-between"><Text size="sm" c="dimmed">{props.filter?.title ?? "当前对象"}</Text>{props.onShowAll ? <Button variant="subtle" color="teal.9" size="compact-sm" onClick={props.onShowAll}>查看全部</Button> : null}</Group> : null}
      {empty ? <div className={styles.empty}><IconCircleCheck size={32} stroke={1.4}/><Text fw={600}>暂无待处理任务</Text><Text size="sm" c="dimmed">{filtered ? "当前对象没有待处理的同步任务。" : "连接撤销和节点命令均无待处理任务。"}</Text></div> : <>
        {leases.length > 0 ? <section><Text className={styles.heading}>连接撤销 <span>{leases.length}</span></Text><ul className={styles.list}>{leases.map(job => {
          const retryable = job.status === "pending" || job.status === "failed";
          return <li key={job.id} className={styles.row}>
            <Group justify="space-between" align="flex-start" wrap="nowrap"><div className={styles.identity}><Text fw={550}>{leaseRevocationJobTargetLabel(job)}</Text><Text size="sm" c="dimmed">{translateLeaseRevocationReason(job.reason)}</Text></div><Text size="sm" c={leaseRevocationStatusColor(job.status)}>{translateLeaseRevocationStatus(job.status)}</Text></Group>
            <Group justify="space-between" mt="sm" align="flex-start"><details className={styles.details}><summary>{job.lastError ? "查看错误与执行详情" : "执行详情"}</summary><dl><div><dt>尝试次数</dt><dd>{job.attempts}</dd></div><div><dt>下次执行</dt><dd>{formatDateTime(job.nextRunAt)}</dd></div></dl>{job.lastError ? <p className={styles.error}>{job.lastError}</p> : null}
              {retryable && job.nodeId && !props.filter?.subscriptionId && !props.filter?.userId && !props.filter?.teamId ? <Button variant="subtle" color="teal.9" size="xs" loading={props.leaseRetryBusyKey === `lease-node:${job.nodeId}`} disabled={props.leaseRetryBusyKey !== null && props.leaseRetryBusyKey !== `lease-node:${job.nodeId}`} onClick={() => props.onRetryLeaseNode(job.nodeId!)}>重试该节点的连接撤销任务</Button> : null}
            </details>{retryable ? <Button size="xs" variant="light" color="teal.9" loading={props.leaseRetryBusyKey === `lease-job:${job.id}`} disabled={props.leaseRetryBusyKey !== null && props.leaseRetryBusyKey !== `lease-job:${job.id}`} onClick={() => props.onRetryLeaseJob(job.id)}>重试</Button> : null}</Group>
          </li>;
        })}</ul></section> : null}
        {loading || failed || commands.length > 0 || commandTotal > 0 ? <section><Text className={styles.heading}>节点命令</Text>
          {failed ? <Text size="sm" c="red" role="alert">节点命令加载失败。{commands.length ? "以下保留上次结果，可能已过期。" : "请关闭后重新打开任务列表。"}</Text> : null}
          {loading ? <DataSkeleton rows={3}/> : null}
          {commandTotal > commands.length ? <Text size="xs" c="dimmed">仅展示最近 {commands.length} 条命令，仍有其他待处理命令。</Text> : null}
          <ul className={styles.list}>{commands.map(job => <li key={job.id} className={styles.row}><Group justify="space-between" align="flex-start" wrap="nowrap"><div className={styles.identity}><Text fw={550}>{translateNodeCommandType(job.commandType)}</Text><Text size="sm" c="dimmed">{job.nodeName ?? job.nodeId}</Text></div><Text size="sm" c={nodeCommandStatusColor(job.status)}>{translateNodeCommandStatus(job.status)}</Text></Group><details className={styles.details}><summary>{job.lastError ? "查看错误与执行详情" : "执行详情"}</summary><dl><div><dt>尝试次数</dt><dd>{job.attempts}</dd></div><div><dt>下次执行</dt><dd>{formatDateTime(job.nextRunAt)}</dd></div></dl>{job.lastError ? <p className={styles.error}>{job.lastError}</p> : null}</details></li>)}</ul>
        </section> : null}
      </>}
    </Stack>
  </Modal>;
}
function leaseRevocationJobTargetLabel(job: AdminLeaseRevocationJobDto) {
  return job.nodeName ?? job.nodeId ?? job.subscriptionId ?? job.userId ?? "全局连接";
}

function translateLeaseRevocationReason(reason: string) {
  const labels: Record<string, string> = {
    admin_user_disconnected: "管理员断开连接",
    connection_taken_over: "连接被接管",
    lease_expired: "连接租约过期",
    node_access_revoked: "节点授权取消",
    node_deleted: "节点删除",
    subscription_expired: "订阅到期",
    subscription_exhausted: "流量耗尽",
    subscription_inactive: "订阅不可用",
    subscription_paused: "订阅暂停",
    subscription_user_disabled: "账号禁用",
    team_disabled: "团队停用",
    team_member_removed: "团队成员移除",
    team_membership_missing: "团队成员关系失效",
    user_disabled: "账号禁用"
  };
  return labels[reason] ?? reason.replace(/_/g, " ");
}

function translateLeaseRevocationStatus(status: AdminLeaseRevocationJobDto["status"]) {
  if (status === "pending") return "等待";
  if (status === "running") return "执行中";
  if (status === "failed") return "待重试";
  return "完成";
}

function leaseRevocationStatusColor(status: AdminLeaseRevocationJobDto["status"]) {
  if (status === "pending") return "yellow";
  if (status === "running") return "blue";
  if (status === "failed") return "yellow";
  if (status === "completed") return "green";
  return "gray";
}
