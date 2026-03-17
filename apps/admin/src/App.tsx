import { useEffect, useState, type ReactNode } from "react";
import {
  Alert,
  AppShell,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Modal,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  ThemeIcon,
  Title
} from "@mantine/core";
import type { AdminSnapshotDto } from "@chordv/shared";
import { IconBell, IconPlus, IconServer, IconShield, IconUsers } from "@tabler/icons-react";
import { getAdminSnapshot, importNode } from "./api/client";

export function App() {
  const [snapshot, setSnapshot] = useState<AdminSnapshotDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [importOpened, setImportOpened] = useState(false);
  const [importing, setImporting] = useState(false);
  const [subscriptionUrl, setSubscriptionUrl] = useState("");
  const [nodeName, setNodeName] = useState("");
  const [nodeRegion, setNodeRegion] = useState("");

  useEffect(() => {
    void loadSnapshot();
  }, []);

  async function loadSnapshot() {
    try {
      setLoading(true);
      setError(null);
      const data = await getAdminSnapshot();
      setSnapshot(data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }

  async function handleImportNode() {
    try {
      setImporting(true);
      setError(null);
      setNotice(null);
      await importNode({
        subscriptionUrl,
        name: nodeName || undefined,
        region: nodeRegion || undefined
      });
      setNotice("节点已导入");
      setImportOpened(false);
      setSubscriptionUrl("");
      setNodeName("");
      setNodeRegion("");
      await loadSnapshot();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "导入失败");
    } finally {
      setImporting(false);
    }
  }

  if (loading && !snapshot) {
    return (
      <Group justify="center" mt="xl">
        <Loader />
      </Group>
    );
  }

  if (!snapshot) {
    return (
      <Paper p="xl" m="xl" shadow="sm" radius="xl" withBorder>
        <Stack>
          <Text>后台加载失败</Text>
          {error ? <Text c="red.4">{error}</Text> : null}
          <Button onClick={() => void loadSnapshot()} loading={loading}>
            重试
          </Button>
        </Stack>
      </Paper>
    );
  }

  return (
    <>
      <AppShell padding="lg">
        <AppShell.Main>
          <Stack gap="lg">
            {notice ? <Alert color="green">{notice}</Alert> : null}
            {error ? <Alert color="red">{error}</Alert> : null}
            <Paper p="xl" radius="xl" shadow="sm" withBorder>
              <Stack gap="xs">
                <Text size="xs" c="blue" fw={700} tt="uppercase">
                  ChordV
                </Text>
                <Title order={1}>运营后台</Title>
              </Stack>
            </Paper>

            <SimpleGrid cols={{ base: 1, md: 2, xl: 4 }}>
              <MetricCard icon={<IconUsers size={18} />} label="用户数" value={snapshot.dashboard.users} />
              <MetricCard
                icon={<IconShield size={18} />}
                label="有效订阅"
                value={snapshot.dashboard.activeSubscriptions}
              />
              <MetricCard icon={<IconServer size={18} />} label="可用节点" value={snapshot.dashboard.activeNodes} />
              <MetricCard icon={<IconBell size={18} />} label="公告数" value={snapshot.dashboard.announcements} />
            </SimpleGrid>

            <SimpleGrid cols={{ base: 1, xl: 2 }}>
              <Card radius="xl" shadow="sm" withBorder>
                <Stack gap="md">
                  <Title order={3}>用户列表</Title>
                  <Table.ScrollContainer minWidth={560}>
                    <Table highlightOnHover>
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>Email</Table.Th>
                          <Table.Th>名称</Table.Th>
                          <Table.Th>角色</Table.Th>
                          <Table.Th>状态</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {snapshot.users.map((user) => (
                          <Table.Tr key={user.id}>
                            <Table.Td>{user.email}</Table.Td>
                            <Table.Td>{user.displayName}</Table.Td>
                            <Table.Td>
                              <Badge variant="light">{translateUserRole(user.role)}</Badge>
                            </Table.Td>
                            <Table.Td>
                              <Badge color={user.status === "active" ? "green" : "red"} variant="light">
                                {translateUserStatus(user.status)}
                              </Badge>
                            </Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  </Table.ScrollContainer>
                </Stack>
              </Card>

              <Card radius="xl" shadow="sm" withBorder>
                <Stack gap="md">
                  <Title order={3}>面板状态</Title>
                  {snapshot.panels.map((panel) => (
                    <Paper key={panel.panelId} withBorder radius="lg" p="md">
                      <Group justify="space-between" align="start">
                        <div>
                          <Text fw={600}>{panel.name}</Text>
                          <Text size="sm" c="dimmed">
                            {panel.baseUrl}
                          </Text>
                        </div>
                        <Badge color={panel.health === "healthy" ? "green" : panel.health === "degraded" ? "yellow" : "red"}>
                          {translatePanelHealth(panel.health)}
                        </Badge>
                      </Group>
                    </Paper>
                  ))}
                </Stack>
              </Card>

              <Card radius="xl" shadow="sm" withBorder>
                <Stack gap="md">
                  <Group justify="space-between">
                    <Title order={3}>节点列表</Title>
                    <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setImportOpened(true)}>
                      导入节点
                    </Button>
                  </Group>
                  {snapshot.nodes.map((node) => (
                    <Paper key={node.id} withBorder radius="lg" p="md">
                      <Group justify="space-between" align="start">
                        <div>
                          <Text fw={600}>{node.name}</Text>
                          <Text size="sm" c="dimmed">
                            {node.region} · {node.provider} · {node.serverHost}:{node.serverPort}
                          </Text>
                        </div>
                        <Badge variant="dot">{node.panelId || "未绑定面板"}</Badge>
                      </Group>
                    </Paper>
                  ))}
                </Stack>
              </Card>

              <Card radius="xl" shadow="sm" withBorder>
                <Stack gap="md">
                  <Title order={3}>公告列表</Title>
                  {snapshot.announcements.map((announcement) => (
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
          </Stack>
        </AppShell.Main>
      </AppShell>
      <Modal opened={importOpened} onClose={() => setImportOpened(false)} title="导入节点" centered>
        <Stack>
          <TextInput
            label="订阅地址"
            placeholder="https://..."
            value={subscriptionUrl}
            onChange={(event) => setSubscriptionUrl(event.currentTarget.value)}
          />
          <TextInput
            label="节点名称"
            placeholder="留空则使用订阅备注"
            value={nodeName}
            onChange={(event) => setNodeName(event.currentTarget.value)}
          />
          <Select
            label="地区"
            placeholder="自动识别"
            data={["香港", "新加坡", "日本", "美国", "未分组"]}
            value={nodeRegion || null}
            onChange={(value) => setNodeRegion(value || "")}
            clearable
          />
          <Button loading={importing} onClick={() => void handleImportNode()}>
            导入
          </Button>
        </Stack>
      </Modal>
    </>
  );
}

function MetricCard(props: { icon: ReactNode; label: string; value: number | string }) {
  return (
    <Paper p="lg" radius="xl" shadow="sm" withBorder>
      <Group justify="space-between">
        <ThemeIcon size="lg" radius="md" variant="light">
          {props.icon}
        </ThemeIcon>
        <Text c="dimmed" size="sm">
          {props.label}
        </Text>
      </Group>
      <Title order={2} mt="md">
        {props.value}
      </Title>
    </Paper>
  );
}

function translateUserRole(role: "user" | "admin") {
  return role === "admin" ? "管理员" : "用户";
}

function translateUserStatus(status: "active" | "disabled") {
  return status === "active" ? "启用" : "禁用";
}

function translatePanelHealth(health: "healthy" | "degraded" | "offline") {
  if (health === "healthy") return "正常";
  if (health === "degraded") return "降级";
  return "离线";
}

function translateAnnouncementLevel(level: "info" | "warning" | "success") {
  if (level === "info") return "通知";
  if (level === "warning") return "提醒";
  return "成功";
}
