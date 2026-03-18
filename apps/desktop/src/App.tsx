import { useEffect, useState, type ReactNode } from "react";
import {
  Alert,
  AppShell,
  Badge,
  Button,
  Card,
  Code,
  Group,
  LoadingOverlay,
  Loader,
  Modal,
  Paper,
  ScrollArea,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title
} from "@mantine/core";
import type {
  AnnouncementDto,
  AuthSessionDto,
  ClientBootstrapDto,
  ConnectionMode,
  GeneratedRuntimeConfigDto,
  NodeSummaryDto
} from "@chordv/shared";
import { IconBolt, IconCloudLock, IconKey, IconPlugConnected, IconRefresh } from "@tabler/icons-react";
import { connectSession, disconnectSession, fetchBootstrap, fetchNodes, login } from "./api/client";
import {
  invokeDesktopConnect,
  invokeDesktopDisconnect,
  focusDesktopWindow,
  loadDesktopRuntimeLogs,
  loadDesktopRuntimeStatus,
  type DesktopRuntimeStatus
} from "./lib/runtime";

const defaultEmail = "demo@chordv.app";
const defaultPassword = "demo123456";
const appVersion = import.meta.env.VITE_APP_VERSION ?? "0.1.0";

export function App() {
  const [session, setSession] = useState<AuthSessionDto | null>(null);
  const [bootstrap, setBootstrap] = useState<ClientBootstrapDto | null>(null);
  const [nodes, setNodes] = useState<NodeSummaryDto[]>([]);
  const [selectedNode, setSelectedNode] = useState<NodeSummaryDto | null>(null);
  const [mode, setMode] = useState<ConnectionMode>("rule");
  const [runtime, setRuntime] = useState<GeneratedRuntimeConfigDto | null>(null);
  const [desktopStatus, setDesktopStatus] = useState<DesktopRuntimeStatus>({
    status: "idle",
    activeSessionId: null,
    configPath: null,
    logPath: null,
    xrayBinaryPath: null,
    activePid: null,
    lastError: null
  });
  const [runtimeLog, setRuntimeLog] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [actionBusy, setActionBusy] = useState<"connect" | "disconnect" | null>(null);
  const [booting, setBooting] = useState(true);
  const [forcedAnnouncement, setForcedAnnouncement] = useState<AnnouncementDto | null>(null);
  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    void focusDesktopWindow();
    void refreshRuntime().finally(() => {
      window.setTimeout(() => setBooting(false), 500);
    });
    const timer = window.setInterval(() => {
      void refreshRuntime();
    }, 2000);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!bootstrap) {
      setForcedAnnouncement(null);
      setCountdown(0);
      return;
    }

    const pending = bootstrap.announcements.find((item) => {
      if (item.displayMode === "passive") {
        return false;
      }
      return localStorage.getItem(announcementStorageKey(item.id)) !== "ack";
    });

    setForcedAnnouncement(pending ?? null);
    setCountdown(pending?.displayMode === "modal_countdown" ? pending.countdownSeconds : 0);
  }, [bootstrap]);

  useEffect(() => {
    if (!forcedAnnouncement || forcedAnnouncement.displayMode !== "modal_countdown" || countdown <= 0) {
      return;
    }

    const timer = window.setTimeout(() => {
      setCountdown((current) => current - 1);
    }, 1000);

    return () => window.clearTimeout(timer);
  }, [forcedAnnouncement, countdown]);

  async function refreshRuntime() {
    try {
      const [status, logs] = await Promise.all([loadDesktopRuntimeStatus(), loadDesktopRuntimeLogs()]);
      setDesktopStatus(status);
      if (!status.activeSessionId && status.status !== "connecting" && status.status !== "disconnecting") {
        setRuntime(null);
      }
      setRuntimeLog(logs.log);
    } catch {
      setDesktopStatus({
        status: "idle",
        activeSessionId: null,
        configPath: null,
        logPath: null,
        xrayBinaryPath: null,
        activePid: null,
        lastError: null
      });
      setRuntime(null);
      setRuntimeLog("");
    }
  }

  async function handleLogin() {
    if (loggingIn) {
      return;
    }

    try {
      setLoggingIn(true);
      setError(null);
      const nextSession = await login(defaultEmail, defaultPassword);
      const [nextBootstrap, nextNodes] = await Promise.all([
        fetchBootstrap(nextSession.accessToken),
        fetchNodes(nextSession.accessToken)
      ]);
      setSession(nextSession);
      setBootstrap(nextBootstrap);
      setNodes(nextNodes);
      setSelectedNode(nextNodes[0] ?? null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "登录失败");
    } finally {
      setLoggingIn(false);
    }
  }

  async function handleConnect() {
    if (!bootstrap || actionBusy || desktopStatus.status === "connected" || desktopStatus.status === "connecting") {
      return;
    }

    const nodeToUse = selectedNode ?? bootstrapNode(bootstrap, nodes);
    if (!nodeToUse) {
      return;
    }

    try {
      setActionBusy("connect");
      setError(null);
      setDesktopStatus((current) => ({ ...current, status: "connecting", lastError: null }));
      const config = await connectSession({
        accessToken: session?.accessToken ?? "",
        nodeId: nodeToUse.id,
        mode
      });
      await invokeDesktopConnect(config);
      setRuntime(config);
      await refreshRuntime();
    } catch (reason) {
      await refreshRuntime();
      setError(reason instanceof Error ? reason.message : "连接失败");
    } finally {
      setActionBusy(null);
    }
  }

  async function handleDisconnect() {
    if (actionBusy || (desktopStatus.status !== "connected" && desktopStatus.status !== "error")) {
      return;
    }

    try {
      setActionBusy("disconnect");
      setError(null);
      setDesktopStatus((current) => ({ ...current, status: "disconnecting", lastError: null }));
      await disconnectSession(session?.accessToken ?? "");
      await invokeDesktopDisconnect();
      setRuntime(null);
      await refreshRuntime();
    } catch (reason) {
      await refreshRuntime();
      setError(reason instanceof Error ? reason.message : "断开失败");
    } finally {
      setActionBusy(null);
    }
  }

  function acknowledgeAnnouncement() {
    if (!forcedAnnouncement) {
      return;
    }

    localStorage.setItem(announcementStorageKey(forcedAnnouncement.id), "ack");
    setForcedAnnouncement(null);
    setCountdown(0);
  }

  return (
    <div style={{ position: "relative", minHeight: "100vh" }}>
      <LoadingOverlay visible={booting} zIndex={200} overlayProps={{ blur: 1 }} />
      <AppShell
        navbar={{
          width: 320,
          breakpoint: "md"
        }}
        padding="lg"
      >
        <AppShell.Navbar p="lg">
        <Stack justify="space-between" h="100%">
          <Stack gap="lg">
            <div>
              <Text size="xs" fw={700} tt="uppercase" c="cyan.3">
                ChordV
              </Text>
              <Title order={2} mt="xs">
                连接与订阅
              </Title>
            </div>

            <StatusCard
              icon={<IconPlugConnected size={18} />}
              label="运行状态"
              value={translateRuntimeStatus(desktopStatus.status)}
              description={runtime?.node.name ?? "未连接"}
            />
            <StatusCard
              icon={<IconCloudLock size={18} />}
              label="版本信息"
              value={bootstrap?.version.currentVersion ?? "0.1.0"}
              description="客户端"
            />
          </Stack>

          <Paper withBorder radius="xl" p="md">
            <Stack gap="xs">
              <Group gap="xs">
                <ThemeIcon radius="md" variant="light" color="cyan">
                  <IconKey size={16} />
                </ThemeIcon>
                <Text fw={600}>演示账号</Text>
              </Group>
              <Code>{defaultEmail}</Code>
              <Code>{defaultPassword}</Code>
            </Stack>
          </Paper>
        </Stack>
        </AppShell.Navbar>

        <AppShell.Main>
          {!session || !bootstrap ? (
            <Paper withBorder radius="xl" p="xl" maw={560}>
            <Stack>
              <Title order={3}>快速登录</Title>
              <Text c="dimmed">使用演示账号进入</Text>
              <Button leftSection={<IconBolt size={18} />} onClick={handleLogin} loading={loggingIn}>
                登录
              </Button>
              {error ? <Text c="red.4">{error}</Text> : null}
            </Stack>
            </Paper>
          ) : (
            <Stack gap="lg">
            <Paper withBorder radius="xl" p="xl">
              <Stack gap="lg">
                <div>
                  <Text size="xs" fw={700} tt="uppercase" c="cyan.3">
                    {bootstrap.subscription.ownerType === "team" ? "团队套餐" : "套餐信息"}
                  </Text>
                  <Title order={2}>{bootstrap.subscription.planName}</Title>
                  <Text c="dimmed">
                    {bootstrap.subscription.ownerType === "team"
                      ? `${bootstrap.team?.name ?? bootstrap.subscription.teamName ?? "团队"} · 到期 ${formatDate(bootstrap.subscription.expireAt)}`
                      : `${bootstrap.user.displayName} · 到期 ${formatDate(bootstrap.subscription.expireAt)}`}
                  </Text>
                </div>

                <SimpleGrid cols={{ base: 1, sm: 2, xl: 4 }}>
                  <Stat label="总流量" value={`${bootstrap.subscription.totalTrafficGb} GB`} />
                  <Stat label="已使用" value={`${bootstrap.subscription.usedTrafficGb} GB`} />
                  <Stat label="剩余流量" value={`${bootstrap.subscription.remainingTrafficGb} GB`} />
                  <Stat label="最近同步" value={formatDate(bootstrap.subscription.lastSyncedAt)} />
                </SimpleGrid>
                {bootstrap.subscription.ownerType === "team" ? (
                  <SimpleGrid cols={{ base: 1, sm: 2 }}>
                    <Stat label="团队名称" value={bootstrap.team?.name ?? bootstrap.subscription.teamName ?? "团队"} />
                    <Stat label="我的已用" value={`${bootstrap.subscription.memberUsedTrafficGb ?? 0} GB`} />
                  </SimpleGrid>
                ) : null}
              </Stack>
            </Paper>

            <SimpleGrid cols={{ base: 1, xl: 2 }}>
              <Card withBorder radius="xl" padding="lg">
                <Stack>
                  <Title order={3}>节点列表</Title>
                  {nodes.length === 0 ? <Loader size="sm" /> : null}
                  {nodes.map((node) => (
                    <Paper
                      key={node.id}
                      withBorder
                      radius="lg"
                      p="md"
                      style={{
                        cursor: "pointer",
                        borderColor: selectedNode?.id === node.id ? "var(--mantine-color-cyan-5)" : undefined
                      }}
                      onClick={() => setSelectedNode(node)}
                    >
                      <Group justify="space-between" align="start">
                        <div>
                          <Text fw={600}>{node.name}</Text>
                          <Text size="sm" c="dimmed">
                            {node.region} · {node.provider}
                          </Text>
                        </div>
                        <Badge variant="light">{node.latencyMs}ms</Badge>
                      </Group>
                    </Paper>
                  ))}
                </Stack>
              </Card>

              <Card withBorder radius="xl" padding="lg">
                <Stack>
                  <Title order={3}>分流策略</Title>
                  <SegmentedControl
                    value={mode}
                    onChange={(value) => setMode(value as ConnectionMode)}
                    data={bootstrap.policies.modes.map((candidate) => ({
                      label: translateMode(candidate),
                      value: candidate
                    }))}
                  />
                  <Badge variant="light">规则版本 {bootstrap.policies.ruleVersion}</Badge>
                  <Text c="dimmed">DNS 配置：{bootstrap.policies.dnsProfile}</Text>
                  <Text c="dimmed">
                    AI 代理{bootstrap.policies.features.aiServicesProxy ? "已启用" : "未启用"} · 广告拦截
                    {bootstrap.policies.features.blockAds ? "已启用" : "未启用"}
                  </Text>
                </Stack>
              </Card>

              <Card withBorder radius="xl" padding="lg">
                <Stack>
                  <Group justify="space-between" align="center">
                    <Title order={3}>连接控制</Title>
                    <Button
                      variant="subtle"
                      size="compact-sm"
                      leftSection={<IconRefresh size={14} />}
                      onClick={() => void refreshRuntime()}
                    >
                      刷新
                    </Button>
                  </Group>
                  <Group>
                    <Button
                      onClick={handleConnect}
                      loading={actionBusy === "connect"}
                      disabled={desktopStatus.status === "connected" || desktopStatus.status === "connecting"}
                    >
                      启动连接
                    </Button>
                    <Button
                      variant="light"
                      color="gray"
                      onClick={handleDisconnect}
                      loading={actionBusy === "disconnect"}
                      disabled={desktopStatus.status !== "connected" && desktopStatus.status !== "error"}
                    >
                      断开
                    </Button>
                  </Group>
                  <Text c="dimmed">HTTP {runtime?.localHttpPort ?? "-"} / SOCKS {runtime?.localSocksPort ?? "-"}</Text>
                  <Code block>{runtime ? runtime.outbound.server : "当前还没有下发运行配置"}</Code>
                  <SimpleGrid cols={{ base: 1, sm: 2 }}>
                    <Stat label="进程 PID" value={desktopStatus.activePid ? `${desktopStatus.activePid}` : "-"} />
                    <Stat label="会话" value={desktopStatus.activeSessionId ?? "-"} />
                  </SimpleGrid>
                  <Text c="dimmed" size="sm">
                    内核：{desktopStatus.xrayBinaryPath ?? "未安装"}
                  </Text>
                  <Text c="dimmed" size="sm">
                    配置：{desktopStatus.configPath ?? "-"}
                  </Text>
                  <Text c="dimmed" size="sm">
                    日志：{desktopStatus.logPath ?? "-"}
                  </Text>
                  {desktopStatus.lastError ? <Text c="red.4">{desktopStatus.lastError}</Text> : null}
                </Stack>
              </Card>

              <Card withBorder radius="xl" padding="lg">
                <Stack>
                  <Title order={3}>公告通知</Title>
                  {bootstrap.announcements.map((announcement) => (
                    <Paper key={announcement.id} withBorder radius="lg" p="md">
                      <Group align="start" wrap="nowrap">
                        <Badge color={announcement.level === "success" ? "green" : announcement.level === "warning" ? "yellow" : "blue"}>
                          {translateAnnouncementLevel(announcement.level)}
                        </Badge>
                        <div>
                          <Text fw={600}>{announcement.title}</Text>
                          <Text size="sm" c="dimmed">
                            {announcement.body}
                          </Text>
                        </div>
                      </Group>
                    </Paper>
                  ))}
                </Stack>
              </Card>
            </SimpleGrid>

            <Card withBorder radius="xl" padding="lg">
              <Stack>
                <Title order={3}>内核日志</Title>
                <ScrollArea h={260} type="always">
                  <Code block>{runtimeLog || "暂无日志"}</Code>
                </ScrollArea>
              </Stack>
            </Card>

            {error ? <Text c="red.4">{error}</Text> : null}
            {bootstrap && shouldShowUpdate(bootstrap) ? (
              <Alert color={bootstrap.version.forceUpgrade ? "red" : "blue"}>
                <Group justify="space-between" align="center">
                  <div>
                    <Text fw={600}>发现新版本 {bootstrap.version.currentVersion}</Text>
                    <Text size="sm" c="dimmed">
                      当前版本 {appVersion}
                    </Text>
                  </div>
                  <Button
                    size="xs"
                    onClick={() => {
                      const target = bootstrap.version.downloadUrl || "https://github.com/Achordchan/ChordV/releases";
                      window.open(target, "_blank", "noopener,noreferrer");
                    }}
                  >
                    去更新
                  </Button>
                </Group>
              </Alert>
            ) : null}
            </Stack>
          )}
        </AppShell.Main>
      </AppShell>
      <Modal
        opened={forcedAnnouncement !== null}
        onClose={() => {
          if (forcedAnnouncement?.displayMode === "passive") {
            setForcedAnnouncement(null);
          }
        }}
        closeOnClickOutside={false}
        closeOnEscape={false}
        withCloseButton={false}
        centered
        title={forcedAnnouncement?.title ?? "公告"}
      >
        <Stack>
          <Badge color={forcedAnnouncement?.level === "warning" ? "yellow" : forcedAnnouncement?.level === "success" ? "green" : "blue"} variant="light">
            {forcedAnnouncement ? translateAnnouncementLevel(forcedAnnouncement.level) : "通知"}
          </Badge>
          <Text>{forcedAnnouncement?.body}</Text>
          <Button
            onClick={acknowledgeAnnouncement}
            disabled={forcedAnnouncement?.displayMode === "modal_countdown" && countdown > 0}
          >
            {forcedAnnouncement?.displayMode === "modal_countdown" && countdown > 0 ? `请等待 ${countdown} 秒` : "我已知晓"}
          </Button>
        </Stack>
      </Modal>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Paper withBorder radius="xl" p="lg">
      <Text c="dimmed" size="sm">
        {label}
      </Text>
      <Title order={3} mt="sm">
        {value}
      </Title>
    </Paper>
  );
}

function formatDate(input: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(input));
}

function bootstrapNode(bootstrap: ClientBootstrapDto, nodes: NodeSummaryDto[]) {
  const preferredId = bootstrap.policies.strategyGroups[0]?.defaultNodeId;
  return nodes.find((node) => node.id === preferredId) ?? nodes[0] ?? null;
}

function StatusCard(props: { icon: ReactNode; label: string; value: string; description: string }) {
  return (
    <Paper withBorder radius="xl" p="md">
      <Group justify="space-between" align="start">
        <div>
          <Text c="dimmed" size="sm">
            {props.label}
          </Text>
          <Title order={4} mt="sm">
            {props.value}
          </Title>
          <Text c="dimmed" size="sm" mt="xs">
            {props.description}
          </Text>
        </div>
        <ThemeIcon radius="md" variant="light" color="cyan">
          {props.icon}
        </ThemeIcon>
      </Group>
    </Paper>
  );
}

function translateMode(mode: ConnectionMode) {
  if (mode === "global") return "全局代理";
  if (mode === "rule") return "规则模式";
  return "直连模式";
}

function translateRuntimeStatus(status: string) {
  if (status === "idle") return "空闲";
  if (status === "connecting") return "连接中";
  if (status === "connected") return "已连接";
  if (status === "disconnecting") return "断开中";
  if (status === "error") return "异常";
  return status;
}

function translateAnnouncementLevel(level: "info" | "warning" | "success") {
  if (level === "info") return "通知";
  if (level === "warning") return "提醒";
  return "成功";
}

function announcementStorageKey(id: string) {
  return `chordv_announcement_ack_${id}`;
}

function shouldShowUpdate(bootstrap: ClientBootstrapDto) {
  return compareVersion(bootstrap.version.currentVersion, appVersion) > 0
    || compareVersion(bootstrap.version.minimumVersion, appVersion) > 0
    || bootstrap.version.forceUpgrade;
}

function compareVersion(left: string, right: string) {
  const leftParts = left.split(".").map((item) => Number(item) || 0);
  const rightParts = right.split(".").map((item) => Number(item) || 0);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue > rightValue) return 1;
    if (leftValue < rightValue) return -1;
  }

  return 0;
}
