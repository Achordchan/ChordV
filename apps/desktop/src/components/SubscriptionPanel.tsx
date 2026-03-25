import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Indicator,
  Menu,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
  UnstyledButton
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import type { ClientBootstrapDto } from "@chordv/shared";
import {
  IconBell,
  IconChevronRight,
  IconDots,
  IconLifebuoy,
  IconLogout,
  IconRefresh,
  IconRosetteDiscountCheck,
  IconSparkles
} from "@tabler/icons-react";

export type SubscriptionServerProbe = {
  status: "checking" | "healthy" | "slow" | "failed";
  label: string;
  detail: string;
};

type SubscriptionPanelProps = {
  bootstrap: ClientBootstrapDto;
  hasUnreadAnnouncements: boolean;
  hasUnreadTickets: boolean;
  refreshing: boolean;
  updateBusy: boolean;
  hasUpdate: boolean;
  serverProbe: SubscriptionServerProbe;
  serverProbeBusy?: boolean;
  onOpenAnnouncements: () => void;
  onOpenTickets: () => void;
  onRefreshServerProbe?: () => void;
  onRefresh: () => void;
  onCheckUpdate: () => void;
  onLogout: () => void;
};

export function SubscriptionPanel(props: SubscriptionPanelProps) {
  const isMobile = useMediaQuery("(max-width: 760px)");
  const isTeam = props.bootstrap.subscription.ownerType === "team";
  const title = isTeam ? props.bootstrap.team?.name ?? props.bootstrap.subscription.teamName ?? "团队订阅" : props.bootstrap.user.displayName;
  const subtitle = isTeam ? props.bootstrap.subscription.planName : `${props.bootstrap.subscription.planName} · 个人订阅`;
  const metrics = [
    { label: isTeam ? "团队剩余流量" : "剩余流量", value: `${formatTrafficGb(props.bootstrap.subscription.remainingTrafficGb)} GB` },
    { label: isTeam ? "团队总流量" : "总流量", value: `${formatTrafficGb(props.bootstrap.subscription.totalTrafficGb)} GB` },
    { label: isTeam ? "团队已使用" : "已使用", value: `${formatTrafficGb(props.bootstrap.subscription.usedTrafficGb)} GB` },
    { label: "到期时间", value: formatDate(props.bootstrap.subscription.expireAt) },
    ...(isTeam ? [{ label: "我已使用", value: `${formatTrafficGb(props.bootstrap.subscription.memberUsedTrafficGb ?? 0)} GB` }] : [])
  ];
  const serverColor = probeColor(props.serverProbe.status);

  if (isMobile) {
    return (
      <Paper
        withBorder
        radius={28}
        p="lg"
        className={isTeam ? "subscription-card subscription-card--team subscription-card--mobile" : "subscription-card subscription-card--mobile"}
      >
        <Stack gap="md">
          <Group justify="space-between" align="flex-start" wrap="nowrap" className="subscription-mobile__head">
            <Stack gap={4} style={{ minWidth: 0, flex: 1 }}>
              <Group gap="xs" wrap="nowrap" align="center">
                <Title order={2} style={{ lineHeight: 1.05 }} className="subscription-mobile__title">
                  {title}
                </Title>
                {isTeam ? (
                  <ThemeIcon variant="light" color="amber" radius="xl" size={28}>
                    <IconSparkles size={16} />
                  </ThemeIcon>
                ) : null}
              </Group>
              <Text c={isTeam ? "rgba(255,255,255,0.82)" : "dimmed"} size="sm" lineClamp={1}>
                {props.bootstrap.user.email}
              </Text>
              <Group gap="xs" wrap="wrap" className="subscription-mobile__meta">
                <Text c={isTeam ? "white" : "dimmed"} size="sm">
                  {subtitle}
                </Text>
                {isTeam ? (
                  <Badge variant="light" color="amber">
                    高级订阅
                  </Badge>
                ) : null}
              </Group>
            </Stack>

            <Menu shadow="md" width={180} position="bottom-end">
              <Menu.Target>
                <ActionIcon variant={isTeam ? "white" : "default"} color={isTeam ? "dark" : "gray"} radius="xl" size={38}>
                  <IconDots size={18} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item
                  leftSection={<IconRefresh size={14} />}
                  onClick={props.onRefresh}
                  disabled={props.refreshing}
                >
                  刷新订阅
                </Menu.Item>
                <Menu.Item
                  leftSection={<IconRosetteDiscountCheck size={14} />}
                  onClick={props.onCheckUpdate}
                  disabled={props.updateBusy}
                >
                  {props.hasUpdate ? "查看更新" : "检查更新"}
                </Menu.Item>
                <Menu.Divider />
                <Menu.Item color="red" leftSection={<IconLogout size={14} />} onClick={props.onLogout}>
                  退出登录
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>

          <Paper
            withBorder
            radius="xl"
            p="sm"
            className="subscription-mobile__network"
            style={{
              background: isTeam ? "rgba(255,255,255,0.08)" : "rgba(248, 250, 252, 0.92)",
              borderColor: isTeam ? "rgba(255,255,255,0.12)" : "rgba(148, 163, 184, 0.18)"
            }}
          >
            <Group justify="space-between" align="center" wrap="nowrap">
              <Stack gap={2}>
                <Text size="xs" c={isTeam ? "rgba(255,255,255,0.7)" : "dimmed"}>
                  线路状态
                </Text>
                <Text fw={700} c={isTeam ? "white" : undefined}>
                  {props.serverProbe.label}
                </Text>
                <Text size="xs" c={isTeam ? "rgba(255,255,255,0.78)" : "dimmed"} lineClamp={2}>
                  {props.serverProbe.detail}
                </Text>
              </Stack>
              <Tooltip
                withArrow
                multiline
                w={220}
                position="bottom-end"
                classNames={{ tooltip: "subscription-server-tooltip-surface" }}
                label={
                  <div className="subscription-server-tooltip">
                    <Text size="sm" fw={700}>
                      {props.serverProbe.label}
                    </Text>
                    <Text size="xs">{props.serverProbe.detail}</Text>
                  </div>
                }
              >
                <ActionIcon
                  variant="light"
                  color={serverColor}
                  radius="xl"
                  size={42}
                  onClick={props.onRefreshServerProbe}
                  loading={props.serverProbeBusy}
                >
                  <IconRefresh size={18} />
                </ActionIcon>
              </Tooltip>
            </Group>
          </Paper>

          <SimpleGrid cols={2} spacing="sm" verticalSpacing="sm" className="subscription-mobile__actions">
            <Indicator
              inline
              disabled={!props.hasUnreadAnnouncements}
              color="red"
              size={9}
              offset={6}
              position="top-end"
              className="subscription-announcement-indicator"
            >
              <Button
                variant={isTeam ? "white" : "default"}
                color={isTeam ? "dark" : "gray"}
                radius="xl"
                leftSection={<IconBell size={16} />}
                rightSection={<IconChevronRight size={14} />}
                justify="space-between"
                fullWidth
                onClick={props.onOpenAnnouncements}
              >
                公告
              </Button>
            </Indicator>
            <Indicator
              inline
              disabled={!props.hasUnreadTickets}
              color="red"
              size={9}
              offset={6}
              position="top-end"
              className="subscription-announcement-indicator"
            >
              <Button
                variant={isTeam ? "white" : "default"}
                color={isTeam ? "dark" : "gray"}
                radius="xl"
                leftSection={<IconLifebuoy size={16} />}
                rightSection={<IconChevronRight size={14} />}
                justify="space-between"
                fullWidth
                onClick={props.onOpenTickets}
              >
                工单
              </Button>
            </Indicator>
          </SimpleGrid>

          <SimpleGrid cols={2} spacing="sm" verticalSpacing="sm" className="subscription-mobile__metrics">
            {metrics.map((item) => (
              <MetricItem
                key={item.label}
                label={item.label}
                value={item.value}
                inverse={isTeam}
                compactValue={item.label === "到期时间"}
              />
            ))}
          </SimpleGrid>
        </Stack>
      </Paper>
    );
  }

  return (
    <Paper
      withBorder
      radius="md"
      p="md"
      className={isTeam ? "subscription-card subscription-card--team" : "subscription-card"}
    >
      <div className="subscription-shell">
        <div className="subscription-head">
          <div className="subscription-copy">
            <Group gap="sm" align="baseline" wrap="wrap" className="subscription-title-row">
              <Title order={2}>{title}</Title>
              <Text c={isTeam ? "rgba(255,255,255,0.82)" : "dimmed"} size="sm" className="subscription-email">
                {props.bootstrap.user.email}
              </Text>
            </Group>
            <Group gap="xs" wrap="wrap" className="subscription-subtitle-row">
              <Text c={isTeam ? "white" : "dimmed"} className="subscription-subtitle">
                {subtitle}
              </Text>
              {isTeam ? (
                <Badge variant="light" color="amber">
                  高级订阅
                </Badge>
              ) : null}
            </Group>
          </div>

          <Group gap="xs" align="center" className="subscription-actions subscription-actions--toolbar">
            {isTeam ? <IconSparkles size={18} className="team-icon" /> : null}
            <Tooltip
              withArrow
              multiline
              w={260}
              position="bottom-end"
              classNames={{ tooltip: "subscription-server-tooltip-surface" }}
              label={
                <div className="subscription-server-tooltip">
                  <Text size="sm" fw={700}>
                    {props.serverProbe.label}
                  </Text>
                  <Text size="xs">{props.serverProbe.detail}</Text>
                </div>
              }
            >
              <UnstyledButton
                type="button"
                className={`subscription-server-indicator subscription-server-indicator--${props.serverProbe.status}`}
                aria-label={props.serverProbe.label}
                onClick={props.onRefreshServerProbe}
                disabled={props.serverProbeBusy}
              >
                <span className="subscription-server-indicator__dot" aria-hidden="true" />
              </UnstyledButton>
            </Tooltip>
            <Indicator
              inline
              disabled={!props.hasUnreadAnnouncements}
              color="red"
              size={9}
              offset={6}
              position="top-end"
              className="subscription-announcement-indicator"
            >
              <Button
                variant={isTeam ? "white" : "default"}
                color={isTeam ? "dark" : "gray"}
                size="xs"
                leftSection={<IconBell size={14} />}
                className="subscription-secondary-button subscription-toolbar-button"
                onClick={props.onOpenAnnouncements}
              >
                公告
              </Button>
            </Indicator>
            <Indicator
              inline
              disabled={!props.hasUnreadTickets}
              color="red"
              size={9}
              offset={6}
              position="top-end"
              className="subscription-announcement-indicator"
            >
              <Button
                variant={isTeam ? "white" : "default"}
                color={isTeam ? "dark" : "gray"}
                size="xs"
                leftSection={<IconLifebuoy size={14} />}
                className="subscription-secondary-button subscription-toolbar-button"
                onClick={props.onOpenTickets}
              >
                工单
              </Button>
            </Indicator>
            <Button
              variant={isTeam ? "white" : "default"}
              color={isTeam ? "dark" : "gray"}
              size="xs"
              leftSection={<IconRefresh size={14} />}
              className="subscription-secondary-button subscription-toolbar-button"
              loading={props.refreshing}
              onClick={props.onRefresh}
            >
              刷新
            </Button>
            <Button
              variant={props.hasUpdate ? "filled" : isTeam ? "white" : "default"}
              color={props.hasUpdate ? "blue" : isTeam ? "dark" : "gray"}
              size="xs"
              className="subscription-secondary-button subscription-toolbar-button"
              loading={props.updateBusy}
              onClick={props.onCheckUpdate}
            >
              {props.hasUpdate ? "查看更新" : "检查更新"}
            </Button>
            <Button
              variant={isTeam ? "white" : "default"}
              color={isTeam ? "dark" : "gray"}
              size="xs"
              leftSection={<IconLogout size={14} />}
              className="subscription-secondary-button subscription-logout subscription-toolbar-button"
              onClick={props.onLogout}
            >
              退出登录
            </Button>
          </Group>
        </div>

        <div className="subscription-metrics">
          {metrics.map((item) => (
            <MetricItem
              key={item.label}
              label={item.label}
              value={item.value}
              inverse={isTeam}
              compactValue={item.label === "到期时间"}
            />
          ))}
        </div>
      </div>
    </Paper>
  );
}

function probeColor(status: SubscriptionServerProbe["status"]) {
  if (status === "healthy") return "green";
  if (status === "slow") return "yellow";
  if (status === "failed") return "red";
  return "gray";
}

function MetricItem(props: { label: string; value: string; inverse?: boolean; compactValue?: boolean }) {
  return (
    <Paper withBorder radius="md" p="md" className={props.inverse ? "metric-item metric-item--inverse" : "metric-item"}>
      <Text size="sm" c={props.inverse ? "rgba(255,255,255,0.72)" : "dimmed"} className="metric-label">
        {props.label}
      </Text>
      <Text fw={700} mt="xs" className={props.compactValue ? "metric-value metric-value--compact" : "metric-value"}>
        {props.value}
      </Text>
    </Paper>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hour = `${date.getHours()}`.padStart(2, "0");
  const minute = `${date.getMinutes()}`.padStart(2, "0");
  return `${year}/${month}/${day} ${hour}:${minute}`;
}

function formatTrafficGb(value: number) {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return value.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}
