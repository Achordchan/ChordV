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
import { formatSupportUnreadBadge } from "../lib/supportPortal";
import {
  IconBell,
  IconChevronRight,
  IconDots,
  IconFolderOpen,
  IconLifebuoy,
  IconLogout,
  IconRefresh,
  IconRosetteDiscountCheck,
  IconSparkles
} from "@tabler/icons-react";

export type SubscriptionServerProbe = {
  status: "checking" | "healthy" | "failed";
  label: string;
  detail: string;
};

type SubscriptionPanelProps = {
  bootstrap: ClientBootstrapDto;
  hasUnreadAnnouncements: boolean;
  /** 新工单系统的未读总数；大于 0 时“工单”按钮显示数字角标。 */
  supportUnreadCount: number;
  /** 正在申请打开地址并打开工单窗口。 */
  supportOpening?: boolean;
  refreshing: boolean;
  updateBusy: boolean;
  updateStatusDescription?: string;
  hasUpdate: boolean;
  forceUpdate?: boolean;
  /** 新版本已下载并校验完成：按钮变为“重启更新”，点击直接安装。 */
  updateReady?: { version: string | null } | null;
  serverProbe: SubscriptionServerProbe;
  serverProbeBusy?: boolean;
  onOpenAnnouncements: () => void;
  onOpenTickets: () => void;
  onRefreshServerProbe?: () => void;
  onRefresh: () => void;
  onCheckUpdate: () => void;
  onInstallUpdate?: () => void;
  /** 只在 macOS / Windows 传入；不传时不显示“本地文件”入口。 */
  onOpenLocalFiles?: () => void;
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
  const supportBadge = formatSupportUnreadBadge(props.supportUnreadCount);
  const supportLabel = supportBadge ? `工单，${props.supportUnreadCount} 条未读` : "工单";
  // 强制更新有自己的倒计时安装流程，按钮保持“必须更新”。
  const updateReady = Boolean(props.updateReady && props.onInstallUpdate && !props.forceUpdate);
  const updateReadyTitle = `ChordV ${props.updateReady?.version ?? "新版本"} 已下载并校验完成。点击后应用会退出并自动安装，完成后重新打开。`;

  if (isMobile) {
    return (
      <Paper
        withBorder
        p="lg"
        className={isTeam ? "subscription-card subscription-card--team subscription-card--mobile" : "subscription-card subscription-card--mobile"}
      >
        <Stack gap="md">
          <Group justify="space-between" align="flex-start" wrap="nowrap" className="subscription-mobile__head">
            <Stack gap={4} style={{ minWidth: 0, flex: 1 }}>
              <Group gap="xs" wrap="nowrap" align="center">
                <Title order={2} className="subscription-mobile__title">
                  {title}
                </Title>
                {isTeam ? (
                  <ThemeIcon variant="light" color="yellow" radius="xl" size={28}>
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
                  <Badge variant="light" color="yellow">
                    高级订阅
                  </Badge>
                ) : null}
              </Group>
            </Stack>

            <Menu shadow="md" width={180} position="bottom-end">
              <Menu.Target>
                <ActionIcon variant={isTeam ? "white" : "default"} color={isTeam ? "dark" : "gray"} size={38} aria-label="更多操作">
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
                  color={updateReady ? "teal" : undefined}
                  onClick={updateReady ? props.onInstallUpdate : props.onCheckUpdate}
                  disabled={props.updateBusy}
                  title={updateReady ? updateReadyTitle : props.updateStatusDescription}
                >
                  {props.forceUpdate ? "必须更新" : updateReady ? "重启更新" : props.hasUpdate ? "有新版本" : "检查更新"}
                </Menu.Item>
                {props.onOpenLocalFiles ? (
                  <Menu.Item leftSection={<IconFolderOpen size={14} />} onClick={props.onOpenLocalFiles}>
                    本地文件
                  </Menu.Item>
                ) : null}
                <Menu.Divider />
                <Menu.Item color="red" leftSection={<IconLogout size={14} />} onClick={props.onLogout}>
                  退出登录
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>

          <div className="subscription-mobile__network">
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
                  size={42}
                  aria-label="重新检测线路"
                  onClick={props.onRefreshServerProbe}
                  loading={props.serverProbeBusy}
                >
                  <IconRefresh size={18} />
                </ActionIcon>
              </Tooltip>
            </Group>
          </div>

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
              disabled={!supportBadge}
              label={supportBadge}
              color="red"
              size={16}
              offset={6}
              position="top-end"
              className="subscription-announcement-indicator"
            >
              <Button
                variant={isTeam ? "white" : "default"}
                color={isTeam ? "dark" : "gray"}
                leftSection={<IconLifebuoy size={16} />}
                rightSection={<IconChevronRight size={14} />}
                justify="space-between"
                fullWidth
                loading={props.supportOpening}
                aria-label={supportLabel}
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
      px="md"
      py={12}
      className={isTeam ? "subscription-card subscription-card--team" : "subscription-card"}
    >
      <div className="subscription-shell">
        <div className="subscription-head">
          <div className="subscription-copy">
            <Group gap="sm" align="baseline" wrap="wrap" className="subscription-title-row">
              <Title order={2} className="subscription-title">{title}</Title>
              <Text c={isTeam ? "rgba(255,255,255,0.82)" : "dimmed"} size="sm" className="subscription-email">
                {props.bootstrap.user.email}
              </Text>
            </Group>
            <Group gap="xs" wrap="wrap" className="subscription-subtitle-row">
              <Text c={isTeam ? "white" : "dimmed"} className="subscription-subtitle">
                {subtitle}
              </Text>
              {isTeam ? (
                <Badge variant="light" color="yellow">
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
              disabled={!supportBadge}
              label={supportBadge}
              color="red"
              size={16}
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
                loading={props.supportOpening}
                aria-label={supportLabel}
                onClick={props.onOpenTickets}
              >
                工单
              </Button>
            </Indicator>
            <Button
              variant={props.forceUpdate || updateReady || props.hasUpdate ? "filled" : isTeam ? "white" : "default"}
              color={props.forceUpdate ? "orange" : updateReady ? "teal" : props.hasUpdate ? "blue" : isTeam ? "dark" : "gray"}
              size="xs"
              leftSection={<IconRosetteDiscountCheck size={14} />}
              className="subscription-secondary-button subscription-toolbar-button"
              loading={props.updateBusy}
              title={updateReady ? updateReadyTitle : props.updateStatusDescription}
              onClick={updateReady ? props.onInstallUpdate : props.onCheckUpdate}
            >
              {props.forceUpdate ? "必须更新" : updateReady ? "重启更新" : props.hasUpdate ? "有新版本" : "检查更新"}
            </Button>
            {/* 刷新订阅与退出登录收进“更多操作”，给低频工具入口腾出位置；顺序与手机版菜单一致。 */}
            <Menu shadow="md" width={160} position="bottom-end">
              <Menu.Target>
                <ActionIcon
                  variant={isTeam ? "white" : "default"}
                  color={isTeam ? "dark" : "gray"}
                  size={30}
                  className="subscription-toolbar-more"
                  aria-label="更多操作"
                >
                  <IconDots size={16} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item leftSection={<IconRefresh size={14} />} onClick={props.onRefresh} disabled={props.refreshing}>
                  刷新订阅
                </Menu.Item>
                {props.onOpenLocalFiles ? (
                  <Menu.Item leftSection={<IconFolderOpen size={14} />} onClick={props.onOpenLocalFiles}>
                    本地文件
                  </Menu.Item>
                ) : null}
                <Menu.Divider />
                <Menu.Item color="red" leftSection={<IconLogout size={14} />} onClick={props.onLogout}>
                  退出登录
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
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
  if (status === "failed") return "red";
  return "gray";
}

function MetricItem(props: { label: string; value: string; inverse?: boolean; compactValue?: boolean }) {
  return (
    <div className={props.inverse ? "metric-item metric-item--inverse" : "metric-item"}>
      <Text size="xs" c={props.inverse ? "rgba(255,255,255,0.72)" : "dimmed"} className="metric-label">
        {props.label}
      </Text>
      <Text fw={650} className={props.compactValue ? "metric-value metric-value--compact" : "metric-value"}>
        {props.value}
      </Text>
    </div>
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
