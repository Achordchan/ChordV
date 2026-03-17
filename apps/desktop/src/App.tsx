import { useEffect, useState, type ReactNode } from "react";
import {
  AppShell,
  Badge,
  Button,
  Card,
  Code,
  Group,
  Loader,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title
} from "@mantine/core";
import type {
  AuthSessionDto,
  ClientBootstrapDto,
  ConnectionMode,
  GeneratedRuntimeConfigDto,
  NodeSummaryDto
} from "@chordv/shared";
import { IconBolt, IconCloudLock, IconKey, IconPlugConnected } from "@tabler/icons-react";
import { connectSession, disconnectSession, fetchBootstrap, fetchNodes, login } from "./api/client";
import { invokeDesktopConnect, invokeDesktopDisconnect, loadDesktopRuntimeStatus } from "./lib/runtime";

const defaultEmail = "demo@chordv.app";
const defaultPassword = "demo123456";

export function App() {
  const [session, setSession] = useState<AuthSessionDto | null>(null);
  const [bootstrap, setBootstrap] = useState<ClientBootstrapDto | null>(null);
  const [nodes, setNodes] = useState<NodeSummaryDto[]>([]);
  const [selectedNode, setSelectedNode] = useState<NodeSummaryDto | null>(null);
  const [mode, setMode] = useState<ConnectionMode>("rule");
  const [runtime, setRuntime] = useState<GeneratedRuntimeConfigDto | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<string>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadDesktopRuntimeStatus()
      .then((status) => setRuntimeStatus(status.status))
      .catch(() => setRuntimeStatus("idle"));
  }, []);

  async function handleLogin() {
    try {
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
    }
  }

  async function handleConnect() {
    if (!bootstrap) {
      return;
    }

    const nodeToUse = selectedNode ?? bootstrapNode(bootstrap, nodes);
    if (!nodeToUse) {
      return;
    }

    try {
      setError(null);
      setRuntimeStatus("connecting");
      const config = await connectSession({
        accessToken: session?.accessToken ?? "",
        nodeId: nodeToUse.id,
        mode
      });
      await invokeDesktopConnect(config);
      const status = await loadDesktopRuntimeStatus();
      setRuntime(config);
      setRuntimeStatus(status.status);
    } catch (reason) {
      setRuntimeStatus("error");
      setError(reason instanceof Error ? reason.message : "连接失败");
    }
  }

  async function handleDisconnect() {
    try {
      setError(null);
      setRuntimeStatus("disconnecting");
      await disconnectSession(session?.accessToken ?? "");
      await invokeDesktopDisconnect();
      const status = await loadDesktopRuntimeStatus();
      setRuntime(null);
      setRuntimeStatus(status.status);
    } catch (reason) {
      setRuntimeStatus("error");
      setError(reason instanceof Error ? reason.message : "断开失败");
    }
  }

  return (
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
              value={translateRuntimeStatus(runtimeStatus)}
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
              <Button leftSection={<IconBolt size={18} />} onClick={handleLogin}>
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
                    套餐信息
                  </Text>
                  <Title order={2}>{bootstrap.subscription.planName}</Title>
                  <Text c="dimmed">
                    {bootstrap.user.displayName} · 到期 {formatDate(bootstrap.subscription.expireAt)}
                  </Text>
                </div>

                <SimpleGrid cols={{ base: 1, sm: 2, xl: 4 }}>
                  <Stat label="总流量" value={`${bootstrap.subscription.totalTrafficGb} GB`} />
                  <Stat label="已使用" value={`${bootstrap.subscription.usedTrafficGb} GB`} />
                  <Stat label="剩余流量" value={`${bootstrap.subscription.remainingTrafficGb} GB`} />
                  <Stat label="最近同步" value={formatDate(bootstrap.subscription.lastSyncedAt)} />
                </SimpleGrid>
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
                  <Title order={3}>连接控制</Title>
                  <Group>
                    <Button onClick={handleConnect}>启动连接</Button>
                    <Button variant="light" color="gray" onClick={handleDisconnect}>
                      断开
                    </Button>
                  </Group>
                  <Text c="dimmed">HTTP {runtime?.localHttpPort ?? "-"} / SOCKS {runtime?.localSocksPort ?? "-"}</Text>
                  <Code block>{runtime ? runtime.outbound.server : "当前还没有下发运行配置"}</Code>
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

            {error ? <Text c="red.4">{error}</Text> : null}
          </Stack>
        )}
      </AppShell.Main>
    </AppShell>
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
