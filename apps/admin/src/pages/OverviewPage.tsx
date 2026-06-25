import type { ReactNode } from "react";
import { Button, Card, Group, Paper, SimpleGrid, Stack, Text, ThemeIcon, Title } from "@mantine/core";
import type { AdminNodeRecordDto, AdminSnapshotDto, AdminSubscriptionRecordDto } from "@chordv/shared";
import { IconBell, IconListDetails, IconMapPin, IconMessageCircle, IconUser, IconUsers } from "@tabler/icons-react";
import { CountryFlag } from "../components/CountryFlag";
import { StatusBadge } from "../features/shared/StatusBadge";
import { formatDateTime } from "../utils/admin-format";
import {
  nodePanelColor,
  nodeProbeColor,
  subscriptionStateColor,
  translatePanelStatus,
  translateProbeStatus,
  translateSubscriptionState
} from "../utils/admin-translate";

type OverviewPageProps = {
  snapshot: AdminSnapshotDto;
  onOpenSubscriptions: () => void;
  onOpenNodes: () => void;
  onOpenTickets: () => void;
  onOpenSyncQueue: () => void;
};

export function OverviewPage(props: OverviewPageProps) {
  const backgroundSyncQueueCount = props.snapshot.panelSyncJobs.length + props.snapshot.leaseRevocationJobs.length;
  const abnormalNodeCount = props.snapshot.nodes.filter((item) => {
    if (item.isActive === false) {
      return false;
    }
    return (
      item.panelStatus === "degraded" ||
      (item.panelEnabled && item.panelStatus === "offline") ||
      (item.panelSyncPendingCount ?? 0) > 0 ||
      (item.panelSyncRunningCount ?? 0) > 0 ||
      (item.panelSyncFailedCount ?? 0) > 0
    );
  }).length;

  return (
    <>
      <Card withBorder radius="xl" p="lg">
        <Stack gap="md">
          <Group justify="space-between">
            <div>
              <Title order={4}>待处理事项</Title>
            </div>
          </Group>
          <SimpleGrid cols={{ base: 1, md: 3 }} spacing="sm">
            <ActionCard
              title="待回复工单"
              count={props.snapshot.dashboard.waitingAdminTickets ?? 0}
              actionLabel="进入工单中心"
              tone="red"
              onClick={props.onOpenTickets}
            />
            <ActionCard
              title="后台同步任务"
              count={backgroundSyncQueueCount}
              actionLabel="查看同步任务"
              tone="yellow"
              onClick={props.onOpenSyncQueue}
            />
            <ActionCard
              title="异常节点"
              count={abnormalNodeCount}
              actionLabel="查看节点"
              tone="blue"
              onClick={props.onOpenNodes}
            />
          </SimpleGrid>
        </Stack>
      </Card>

      <SimpleGrid cols={{ base: 1, sm: 2, xl: 3 }} spacing="md">
        <MetricCard label="用户数" value={props.snapshot.dashboard.users} icon={<IconUsers size={18} />} />
        <MetricCard label="团队数" value={props.snapshot.dashboard.teams} icon={<IconUsers size={18} />} />
        <MetricCard label="有效套餐" value={props.snapshot.dashboard.activePlans} icon={<IconListDetails size={18} />} />
        <MetricCard label="有效订阅" value={props.snapshot.dashboard.activeSubscriptions} icon={<IconUser size={18} />} />
        <MetricCard label="启用节点" value={props.snapshot.dashboard.activeNodes} icon={<IconMapPin size={18} />} />
        <MetricCard label="在线公告" value={props.snapshot.dashboard.announcements} icon={<IconBell size={18} />} />
        <MetricCard label="待处理工单" value={props.snapshot.dashboard.waitingAdminTickets ?? 0} icon={<IconMessageCircle size={18} />} />
        <MetricCard label="处理中工单" value={props.snapshot.dashboard.openTickets ?? 0} icon={<IconMessageCircle size={18} />} />
        <MetricCard label="已关闭工单" value={props.snapshot.dashboard.closedTickets ?? 0} icon={<IconMessageCircle size={18} />} />
      </SimpleGrid>

      <SimpleGrid cols={{ base: 1, xl: 2 }}>
        <Card withBorder radius="xl" p="lg">
          <Stack gap="md">
            <Group justify="space-between">
              <Title order={4}>当前订阅</Title>
              <Button size="xs" variant="subtle" onClick={props.onOpenSubscriptions}>
                查看全部
              </Button>
            </Group>
            <CompactSubscriptionList items={props.snapshot.subscriptions.slice(0, 6)} />
          </Stack>
        </Card>
        <Card withBorder radius="xl" p="lg">
          <Stack gap="md">
            <Group justify="space-between">
              <Title order={4}>节点状态</Title>
              <Button size="xs" variant="subtle" onClick={props.onOpenNodes}>
                查看全部
              </Button>
            </Group>
            <CompactNodeList items={props.snapshot.nodes.slice(0, 6)} />
          </Stack>
        </Card>
      </SimpleGrid>
    </>
  );
}

function ActionCard(props: {
  title: string;
  count: number;
  actionLabel: string;
  tone: "red" | "yellow" | "blue";
  onClick: () => void;
}) {
  const hasWork = props.count > 0;
  return (
    <Paper withBorder radius="lg" p="md">
      <Stack gap="sm">
        <Group justify="space-between" align="start">
          <div>
            <Text fw={700}>{props.title}</Text>
          </div>
          <ThemeIcon color={hasWork ? props.tone : "gray"} variant="light" radius="lg">
            <Text fw={700} size="sm">
              {props.count}
            </Text>
          </ThemeIcon>
        </Group>
        <Button size="xs" variant={hasWork ? "light" : "default"} color={props.tone} onClick={props.onClick}>
          {props.actionLabel}
        </Button>
      </Stack>
    </Paper>
  );
}

function MetricCard(props: { label: string; value: number | string; icon: ReactNode }) {
  return (
    <Paper withBorder radius="xl" p="lg" className="metric-card">
      <Group justify="space-between">
        <div>
          <Text size="sm" c="dimmed">
            {props.label}
          </Text>
          <Title order={2} mt="sm">
            {props.value}
          </Title>
        </div>
        <ThemeIcon size={42} radius="lg" variant="light">
          {props.icon}
        </ThemeIcon>
      </Group>
    </Paper>
  );
}

function CompactSubscriptionList({ items }: { items: AdminSubscriptionRecordDto[] }) {
  return (
    <Stack gap="sm">
      {items.map((item) => (
        <Paper key={item.id} withBorder radius="lg" p="md">
          <Group justify="space-between" align="start">
            <div>
              <Text fw={600}>{item.userDisplayName}</Text>
              <Text size="sm" c="dimmed">
                {item.planName} · 到期 {formatDateTime(item.expireAt)}
              </Text>
            </div>
            <StatusBadge color={subscriptionStateColor(item.state)} label={translateSubscriptionState(item.state)} />
          </Group>
        </Paper>
      ))}
    </Stack>
  );
}

function CompactNodeList({ items }: { items: AdminNodeRecordDto[] }) {
  return (
    <Stack gap="sm">
      {items.map((item) => {
        const status = compactNodeStatus(item);

        return (
          <Paper key={item.id} withBorder radius="lg" p="md">
            <Group justify="space-between" align="start" wrap="nowrap">
              <div style={{ minWidth: 0 }}>
                <Text fw={600} lineClamp={1}>
                  {item.name}
                </Text>
                <Group gap={6} wrap="nowrap">
                  <CountryFlag code={item.countryCode} size="sm" />
                  <Text size="sm" c="dimmed" lineClamp={1} style={{ minWidth: 0, flex: 1 }}>
                    {item.region} · {item.serverHost}:{item.serverPort}
                  </Text>
                </Group>
                <Text size="xs" c="dimmed" lineClamp={1}>
                  3x-ui：{translatePanelStatus(item.panelStatus, item.panelEnabled)} · 探测：{translateProbeStatus(item.probeStatus)}
                  {buildNodePanelSyncText(item)}
                </Text>
              </div>
              <StatusBadge color={status.color} label={status.label} />
            </Group>
          </Paper>
        );
      })}
    </Stack>
  );
}

function compactNodeStatus(item: AdminNodeRecordDto) {
  if (item.isActive === false) {
    return { color: "gray", label: "已禁用" };
  }

  if (
    (item.panelSyncPendingCount ?? 0) > 0 ||
    (item.panelSyncRunningCount ?? 0) > 0 ||
    (item.panelSyncFailedCount ?? 0) > 0
  ) {
    return { color: "yellow", label: "待同步" };
  }

  if (item.panelStatus === "degraded") {
    return { color: nodePanelColor(item.panelStatus, item.panelEnabled), label: "面板异常" };
  }

  if (item.panelEnabled && item.panelStatus === "offline") {
    return { color: nodePanelColor(item.panelStatus, item.panelEnabled), label: "面板失联" };
  }

  return { color: nodeProbeColor(item.probeStatus), label: translateProbeStatus(item.probeStatus) };
}

function buildNodePanelSyncText(item: AdminNodeRecordDto) {
  const parts = [
    (item.panelSyncPendingCount ?? 0) > 0 ? `待同步 ${item.panelSyncPendingCount}` : null,
    (item.panelSyncRunningCount ?? 0) > 0 ? `执行中 ${item.panelSyncRunningCount}` : null,
    (item.panelSyncFailedCount ?? 0) > 0 ? `待重试 ${item.panelSyncFailedCount}` : null
  ].filter(Boolean);
  return parts.length > 0 ? ` · 面板同步${parts.join(" / ")}` : "";
}
