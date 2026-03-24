import { Badge, Button, Group, Indicator, Paper, Text, Title } from "@mantine/core";
import type { ClientBootstrapDto } from "@chordv/shared";
import { IconBell, IconLifebuoy, IconLogout, IconRefresh, IconSparkles } from "@tabler/icons-react";

export type SubscriptionServerProbe = {
  status: "checking" | "healthy" | "slow" | "failed";
  label: string;
  detail: string;
};

type SubscriptionPanelProps = {
  bootstrap: ClientBootstrapDto;
  hasUnreadAnnouncements: boolean;
  refreshing: boolean;
  updateBusy: boolean;
  hasUpdate: boolean;
  serverProbe: SubscriptionServerProbe;
  onOpenAnnouncements: () => void;
  onOpenTickets: () => void;
  onRefresh: () => void;
  onCheckUpdate: () => void;
  onLogout: () => void;
};

export function SubscriptionPanel(props: SubscriptionPanelProps) {
  const isTeam = props.bootstrap.subscription.ownerType === "team";
  const title = isTeam ? props.bootstrap.team?.name ?? props.bootstrap.subscription.teamName ?? "团队订阅" : props.bootstrap.user.displayName;
  const subtitle = isTeam ? props.bootstrap.subscription.planName : `${props.bootstrap.subscription.planName} · 个人订阅`;
  const metrics = [
    { label: isTeam ? "团队总流量" : "总流量", value: `${formatTrafficGb(props.bootstrap.subscription.totalTrafficGb)} GB` },
    { label: isTeam ? "团队已使用" : "已使用", value: `${formatTrafficGb(props.bootstrap.subscription.usedTrafficGb)} GB` },
    { label: isTeam ? "团队剩余流量" : "剩余流量", value: `${formatTrafficGb(props.bootstrap.subscription.remainingTrafficGb)} GB` },
    { label: "到期时间", value: formatDate(props.bootstrap.subscription.expireAt) },
    ...(isTeam ? [{ label: "我已使用", value: `${formatTrafficGb(props.bootstrap.subscription.memberUsedTrafficGb ?? 0)} GB` }] : [])
  ];

  return (
    <Paper
      withBorder
      radius="lg"
      p="lg"
      className={isTeam ? "subscription-card subscription-card--team" : "subscription-card"}
    >
      <div className="subscription-shell">
        <div className="subscription-head">
          <div className="subscription-copy">
            <Group gap="xs" mb={10} className="subscription-status-row">
              <Text className="desktop-eyebrow">{isTeam ? "Team" : "订阅"}</Text>
              {isTeam ? (
                <Badge variant="light" color="amber">
                  高级订阅
                </Badge>
              ) : null}
            </Group>
            <Group gap="sm" align="baseline" wrap="wrap" className="subscription-title-row">
              <Title order={2}>{title}</Title>
              <Text c={isTeam ? "rgba(255,255,255,0.82)" : "dimmed"} size="sm" className="subscription-email">
                {props.bootstrap.user.email}
              </Text>
            </Group>
            <Text c={isTeam ? "white" : "dimmed"} className="subscription-subtitle">
              {subtitle}
            </Text>
            <div
              className={
                isTeam
                  ? `subscription-server-pill subscription-server-pill--team subscription-server-pill--${props.serverProbe.status}`
                  : `subscription-server-pill subscription-server-pill--${props.serverProbe.status}`
              }
            >
              <span className="subscription-server-pill__dot" aria-hidden="true" />
              <div className="subscription-server-pill__copy">
                <Text size="sm" fw={600}>
                  {props.serverProbe.label}
                </Text>
                <Text size="xs" c={isTeam ? "rgba(255,255,255,0.74)" : "dimmed"}>
                  {props.serverProbe.detail}
                </Text>
              </div>
            </div>
          </div>

          <Group gap="xs" align="center" className="subscription-actions subscription-actions--toolbar">
            {isTeam ? <IconSparkles size={18} className="team-icon" /> : null}
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
                size="sm"
                leftSection={<IconBell size={15} />}
                className="subscription-secondary-button subscription-toolbar-button"
                onClick={props.onOpenAnnouncements}
              >
                公告
              </Button>
            </Indicator>
            <Button
              variant={isTeam ? "white" : "default"}
              color={isTeam ? "dark" : "gray"}
              size="sm"
              leftSection={<IconLifebuoy size={15} />}
              className="subscription-secondary-button subscription-toolbar-button"
              onClick={props.onOpenTickets}
            >
              工单
            </Button>
            <Button
              variant={isTeam ? "white" : "default"}
                color={isTeam ? "dark" : "gray"}
                size="sm"
                leftSection={<IconRefresh size={15} />}
                className="subscription-secondary-button subscription-toolbar-button"
                loading={props.refreshing}
                onClick={props.onRefresh}
              >
                刷新
              </Button>
            <Button
              variant={props.hasUpdate ? "filled" : isTeam ? "white" : "default"}
                color={props.hasUpdate ? "blue" : isTeam ? "dark" : "gray"}
                size="sm"
                className="subscription-secondary-button subscription-toolbar-button"
                loading={props.updateBusy}
                onClick={props.onCheckUpdate}
              >
                {props.hasUpdate ? "查看更新" : "检查更新"}
              </Button>
            <Button
              variant={isTeam ? "white" : "default"}
                color={isTeam ? "dark" : "gray"}
                size="sm"
                leftSection={<IconLogout size={15} />}
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

function MetricItem(props: { label: string; value: string; inverse?: boolean; compactValue?: boolean }) {
  return (
    <Paper withBorder radius="lg" p="md" className={props.inverse ? "metric-item metric-item--inverse" : "metric-item"}>
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
