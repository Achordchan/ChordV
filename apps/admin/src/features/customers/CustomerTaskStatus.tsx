import { ActionIcon, Badge, Button, Group, Stack, Text } from "@mantine/core";
import { IconListDetails, IconRefresh } from "@tabler/icons-react";
import type { AdminLeaseRevocationJobDto, AdminNodeCommandSummaryDto } from "@chordv/shared";
import { summarizeAdminDiagnosticMessage } from "../../utils/admin-filters";

export function PanelSyncInlineStatus(props: {
  item?: {
    panelSyncStatus?: "synced" | "pending";
    panelSyncMessage?: string | null;
    panelSyncSummary?: { pending: number; running: number; failed: number; total: number; lastError: string | null } | null;
  } | null;
  // Outstanding agent commands for this target. Panel-era records no longer
  // carry a summary after a list refresh, so the inline indicator must also
  // read the direct command aggregates or it disappears while provisioning is
  // still pending.
  commandSummary?: AdminNodeCommandSummaryDto | null;
  onOpenLeaseRevocationQueue: () => void;
}) {
  const summary = props.item?.panelSyncSummary;
  const commandSummary = props.commandSummary ?? null;
  if (props.item?.panelSyncStatus !== "pending" && (summary?.total ?? 0) === 0 && (commandSummary?.total ?? 0) === 0) {
    return null;
  }
  const label = commandSummary
    ? buildNodeCommandPendingLabel(commandSummary)
    : summary ? buildPanelSyncPendingLabel(summary) : "后台同步待处理";
  const detail = [
    summarizeAdminDiagnosticMessage(commandSummary?.lastError ?? summary?.lastError, "后台同步任务失败，请稍后重试或查看服务器日志。"),
    summarizeAdminDiagnosticMessage(props.item?.panelSyncMessage, "后台同步状态待确认，请打开同步任务查看。")
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Stack gap={2}>
      <Group gap={4} wrap="nowrap">
        <Badge color="yellow" variant="light">
          {label}
        </Badge>
        <Button
          size="xs"
          variant="subtle"
          color="yellow"
          leftSection={<IconListDetails size={12} />}
          onClick={(event) => {
            event.stopPropagation();
            props.onOpenLeaseRevocationQueue();
          }}
          title="查看后台同步任务"
        >
          查看任务
        </Button>
      </Group>
      {detail ? (
        <Text size="xs" c="dimmed" lineClamp={2}>
          {detail}
        </Text>
      ) : null}
    </Stack>
  );
}

export function isTeamMemberLeaseRevocationJob(job: AdminLeaseRevocationJobDto, userId: string, subscriptionId?: string | null) {
  if (job.userId !== userId) {
    return false;
  }
  return subscriptionId ? job.subscriptionId === subscriptionId || job.subscriptionId === null : true;
}

export function LeaseRevocationInlineStatus(props: {
  jobs: AdminLeaseRevocationJobDto[];
  retryBusyKey: string | null;
  onRetryJob: (jobId: string) => void;
}) {
  const activeJobs = props.jobs.filter((job) => job.status === "pending" || job.status === "running" || job.status === "failed");
  if (activeJobs.length === 0) {
    return null;
  }
  const failed = activeJobs.filter((job) => job.status === "failed");
  const running = activeJobs.filter((job) => job.status === "running");
  const retryable = failed[0] ?? null;
  const label =
    failed.length > 0
      ? `连接撤销待重试 ${failed.length}`
      : running.length > 0
        ? "连接撤销执行中"
        : `连接撤销待同步 ${activeJobs.length}`;
  const lastError = summarizeAdminDiagnosticMessage(
    failed.find((job) => job.lastError)?.lastError ?? activeJobs.find((job) => job.lastError)?.lastError,
    "连接撤销任务失败，请稍后重试或查看服务器日志。"
  );

  return (
    <Stack gap={2}>
      <Group gap={4} wrap="nowrap">
        <Badge color="yellow" variant="light">
          {label}
        </Badge>
        {retryable ? (
          <ActionIcon
            size="xs"
            variant="subtle"
            color="yellow"
            loading={props.retryBusyKey === `lease-job:${retryable.id}`}
            disabled={props.retryBusyKey !== null && props.retryBusyKey !== `lease-job:${retryable.id}`}
            onClick={(event) => {
              event.stopPropagation();
              props.onRetryJob(retryable.id);
            }}
            title="重试连接撤销"
            aria-label="重试连接撤销"
          >
            <IconRefresh size={12} />
          </ActionIcon>
        ) : null}
      </Group>
      {lastError ? (
        <Text size="xs" c="dimmed" lineClamp={2}>
          {lastError}
        </Text>
      ) : null}
    </Stack>
  );
}

function buildPanelSyncPendingLabel(summary: { pending: number; running: number; failed: number; total: number }) {
  const parts = [
    summary.pending > 0 ? `待同步 ${summary.pending}` : null,
    summary.running > 0 ? `执行中 ${summary.running}` : null,
    summary.failed > 0 ? `待重试 ${summary.failed}` : null
  ].filter(Boolean);
  return parts.length > 0 ? `面板同步${parts.join(" / ")}` : "后台同步待处理";
}

function buildNodeCommandPendingLabel(summary: { pending: number; running: number; failed: number; total: number }) {
  const parts = [
    summary.pending > 0 ? `待执行 ${summary.pending}` : null,
    summary.running > 0 ? `执行中 ${summary.running}` : null,
    summary.failed > 0 ? `待重试 ${summary.failed}` : null
  ].filter(Boolean);
  return parts.length > 0 ? `节点命令${parts.join(" / ")}` : "后台同步待处理";
}
