import { startTransition, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Alert,
  AppShell,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Loader,
  Modal,
  NumberInput,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  ThemeIcon,
  Title
} from "@mantine/core";
import type {
  AdminPanelConfigDto,
  AdminSnapshotDto,
  AdminSubscriptionRecordDto,
  PanelSyncRunDto,
  SubscriptionState
} from "@chordv/shared";
import {
  IconBell,
  IconRefresh,
  IconServer,
  IconSettings,
  IconShield,
  IconUsers
} from "@tabler/icons-react";
import { getAdminSnapshot, syncPanel, syncPanels, updatePanel, updateSubscription } from "./api/client";

type SubscriptionDraft = {
  panelClientEmail: string;
  totalTrafficGb: number;
  expireAt: string;
  state: SubscriptionState;
  renewable: boolean;
};

type PanelDraft = {
  name: string;
  baseUrl: string;
  apiBasePath: string;
  username: string;
  password: string;
  syncEnabled: boolean;
};

export function App() {
  const [snapshot, setSnapshot] = useState<AdminSnapshotDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [subscriptionModalOpen, setSubscriptionModalOpen] = useState(false);
  const [editingSubscription, setEditingSubscription] = useState<AdminSubscriptionRecordDto | null>(null);
  const [subscriptionDraft, setSubscriptionDraft] = useState<SubscriptionDraft | null>(null);
  const [panelModalOpen, setPanelModalOpen] = useState(false);
  const [editingPanel, setEditingPanel] = useState<AdminPanelConfigDto | null>(null);
  const [panelDraft, setPanelDraft] = useState<PanelDraft | null>(null);

  async function loadSnapshot() {
    try {
      setLoading(true);
      setError(null);
      const nextSnapshot = await getAdminSnapshot();
      startTransition(() => {
        setSnapshot(nextSnapshot);
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "后台加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSnapshot();
  }, []);

  const panelHealthText = useMemo(() => {
    if (!snapshot) {
      return "加载中";
    }

    return translatePanelHealth(snapshot.dashboard.panelHealth);
  }, [snapshot]);

  function openSubscriptionEditor(subscription: AdminSubscriptionRecordDto) {
    setEditingSubscription(subscription);
    setSubscriptionDraft({
      panelClientEmail: subscription.panelClientEmail ?? "",
      totalTrafficGb: subscription.totalTrafficGb,
      expireAt: toDateTimeLocal(subscription.expireAt),
      state: subscription.state,
      renewable: subscription.renewable
    });
    setSubscriptionModalOpen(true);
  }

  function openPanelEditor(panel: AdminPanelConfigDto) {
    setEditingPanel(panel);
    setPanelDraft({
      name: panel.name,
      baseUrl: panel.baseUrl,
      apiBasePath: panel.apiBasePath,
      username: panel.username ?? "",
      password: "",
      syncEnabled: panel.syncEnabled
    });
    setPanelModalOpen(true);
  }

  async function handleSaveSubscription() {
    if (!editingSubscription || !subscriptionDraft) {
      return;
    }

    try {
      setBusyKey(`subscription:${editingSubscription.id}`);
      setError(null);
      setNotice(null);
      await updateSubscription(editingSubscription.id, {
        panelClientEmail: subscriptionDraft.panelClientEmail,
        totalTrafficGb: subscriptionDraft.totalTrafficGb,
        expireAt: new Date(subscriptionDraft.expireAt).toISOString(),
        state: subscriptionDraft.state,
        renewable: subscriptionDraft.renewable
      });
      setSubscriptionModalOpen(false);
      setNotice("订阅已保存");
      await loadSnapshot();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setBusyKey(null);
    }
  }

  async function handleSavePanel() {
    if (!editingPanel || !panelDraft) {
      return;
    }

    try {
      setBusyKey(`panel:${editingPanel.panelId}`);
      setError(null);
      setNotice(null);
      await updatePanel(editingPanel.panelId, {
        name: panelDraft.name,
        baseUrl: panelDraft.baseUrl,
        apiBasePath: panelDraft.apiBasePath,
        username: panelDraft.username,
        password: panelDraft.password.length > 0 ? panelDraft.password : undefined,
        syncEnabled: panelDraft.syncEnabled
      });
      setPanelModalOpen(false);
      setNotice("面板已保存");
      await loadSnapshot();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setBusyKey(null);
    }
  }

  async function handleSyncAll() {
    try {
      setBusyKey("sync:all");
      setError(null);
      const results = await syncPanels();
      setNotice(buildSyncSummary(results));
      await loadSnapshot();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "同步失败");
    } finally {
      setBusyKey(null);
    }
  }

  async function handleSyncPanel(panel: AdminPanelConfigDto) {
    try {
      setBusyKey(`sync:${panel.panelId}`);
      setError(null);
      const result = await syncPanel(panel.panelId);
      setNotice(buildSyncSummary([result]));
      await loadSnapshot();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "同步失败");
    } finally {
      setBusyKey(null);
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
        后台加载失败
      </Paper>
    );
  }

  return (
    <>
      <AppShell padding="lg">
        <AppShell.Main>
          <Stack gap="lg">
            <Paper p="xl" radius="xl" shadow="sm" withBorder>
              <Group justify="space-between" align="end">
                <Stack gap="xs">
                  <Text size="xs" c="blue" fw={700} tt="uppercase">
                    ChordV
                  </Text>
                  <Title order={1}>运营后台</Title>
                </Stack>
                <Group>
                  <Button
                    variant="light"
                    leftSection={<IconRefresh size={16} />}
                    loading={busyKey === "sync:all" || loading}
                    onClick={() => void loadSnapshot()}
                  >
                    刷新
                  </Button>
                  <Button
                    leftSection={<IconRefresh size={16} />}
                    loading={busyKey === "sync:all"}
                    onClick={() => void handleSyncAll()}
                  >
                    同步全部面板
                  </Button>
                </Group>
              </Group>
            </Paper>

            {notice ? <Alert color="green">{notice}</Alert> : null}
            {error ? <Alert color="red">{error}</Alert> : null}

            <SimpleGrid cols={{ base: 1, md: 2, xl: 4 }}>
              <MetricCard icon={<IconUsers size={18} />} label="用户" value={snapshot.dashboard.users} />
              <MetricCard icon={<IconShield size={18} />} label="有效订阅" value={snapshot.dashboard.activeSubscriptions} />
              <MetricCard icon={<IconServer size={18} />} label="节点" value={snapshot.dashboard.activeNodes} />
              <MetricCard icon={<IconSettings size={18} />} label="面板状态" value={panelHealthText} />
            </SimpleGrid>

            <Tabs defaultValue="subscriptions" variant="outline" radius="lg">
              <Tabs.List>
                <Tabs.Tab value="subscriptions">订阅</Tabs.Tab>
                <Tabs.Tab value="panels">面板</Tabs.Tab>
                <Tabs.Tab value="users">用户</Tabs.Tab>
                <Tabs.Tab value="nodes">节点</Tabs.Tab>
                <Tabs.Tab value="announcements">公告</Tabs.Tab>
              </Tabs.List>

              <Tabs.Panel value="subscriptions" pt="lg">
                <Card radius="xl" shadow="sm" withBorder>
                  <Stack gap="md">
                    <Title order={3}>订阅管理</Title>
                    <Table.ScrollContainer minWidth={980}>
                      <Table highlightOnHover>
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th>用户</Table.Th>
                            <Table.Th>套餐</Table.Th>
                            <Table.Th>面板标识</Table.Th>
                            <Table.Th>已用 / 总量</Table.Th>
                            <Table.Th>到期</Table.Th>
                            <Table.Th>状态</Table.Th>
                            <Table.Th>最近同步</Table.Th>
                            <Table.Th>操作</Table.Th>
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {snapshot.subscriptions.map((subscription) => (
                            <Table.Tr key={subscription.id}>
                              <Table.Td>
                                <Text fw={600}>{subscription.userDisplayName}</Text>
                                <Text size="sm" c="dimmed">
                                  {subscription.userEmail}
                                </Text>
                              </Table.Td>
                              <Table.Td>{subscription.planName}</Table.Td>
                              <Table.Td>{subscription.panelClientEmail || "-"}</Table.Td>
                              <Table.Td>
                                {subscription.usedTrafficGb} GB / {subscription.totalTrafficGb} GB
                              </Table.Td>
                              <Table.Td>{formatDateTime(subscription.expireAt)}</Table.Td>
                              <Table.Td>
                                <Badge color={subscriptionStateColor(subscription.state)} variant="light">
                                  {translateSubscriptionState(subscription.state)}
                                </Badge>
                              </Table.Td>
                              <Table.Td>{formatDateTime(subscription.lastSyncedAt)}</Table.Td>
                              <Table.Td>
                                <Button
                                  size="xs"
                                  variant="light"
                                  loading={busyKey === `subscription:${subscription.id}`}
                                  onClick={() => openSubscriptionEditor(subscription)}
                                >
                                  编辑
                                </Button>
                              </Table.Td>
                            </Table.Tr>
                          ))}
                        </Table.Tbody>
                      </Table>
                    </Table.ScrollContainer>
                  </Stack>
                </Card>
              </Tabs.Panel>

              <Tabs.Panel value="panels" pt="lg">
                <Card radius="xl" shadow="sm" withBorder>
                  <Stack gap="md">
                    <Title order={3}>面板管理</Title>
                    <Table.ScrollContainer minWidth={1080}>
                      <Table highlightOnHover>
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th>名称</Table.Th>
                            <Table.Th>地址</Table.Th>
                            <Table.Th>账号</Table.Th>
                            <Table.Th>状态</Table.Th>
                            <Table.Th>延迟</Table.Th>
                            <Table.Th>活跃用户</Table.Th>
                            <Table.Th>最近同步</Table.Th>
                            <Table.Th>操作</Table.Th>
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {snapshot.panels.map((panel) => (
                            <Table.Tr key={panel.panelId}>
                              <Table.Td>
                                <Text fw={600}>{panel.name}</Text>
                                <Text size="sm" c="dimmed">
                                  {panel.apiBasePath}
                                </Text>
                              </Table.Td>
                              <Table.Td>{panel.baseUrl}</Table.Td>
                              <Table.Td>{panel.username || "-"}</Table.Td>
                              <Table.Td>
                                <Badge color={panelHealthColor(panel.health)} variant="light">
                                  {translatePanelHealth(panel.health)}
                                </Badge>
                              </Table.Td>
                              <Table.Td>{panel.latencyMs} ms</Table.Td>
                              <Table.Td>{panel.activeUsers}</Table.Td>
                              <Table.Td>{formatDateTime(panel.lastSyncedAt)}</Table.Td>
                              <Table.Td>
                                <Group gap="xs">
                                  <Button
                                    size="xs"
                                    variant="light"
                                    loading={busyKey === `sync:${panel.panelId}`}
                                    onClick={() => void handleSyncPanel(panel)}
                                  >
                                    同步
                                  </Button>
                                  <Button
                                    size="xs"
                                    variant="subtle"
                                    loading={busyKey === `panel:${panel.panelId}`}
                                    onClick={() => openPanelEditor(panel)}
                                  >
                                    编辑
                                  </Button>
                                </Group>
                              </Table.Td>
                            </Table.Tr>
                          ))}
                        </Table.Tbody>
                      </Table>
                    </Table.ScrollContainer>
                  </Stack>
                </Card>
              </Tabs.Panel>

              <Tabs.Panel value="users" pt="lg">
                <Card radius="xl" shadow="sm" withBorder>
                  <Stack gap="md">
                    <Title order={3}>用户</Title>
                    <Table.ScrollContainer minWidth={720}>
                      <Table highlightOnHover>
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th>邮箱</Table.Th>
                            <Table.Th>名称</Table.Th>
                            <Table.Th>角色</Table.Th>
                            <Table.Th>状态</Table.Th>
                            <Table.Th>最近在线</Table.Th>
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {snapshot.users.map((user) => (
                            <Table.Tr key={user.id}>
                              <Table.Td>{user.email}</Table.Td>
                              <Table.Td>{user.displayName}</Table.Td>
                              <Table.Td>{translateUserRole(user.role)}</Table.Td>
                              <Table.Td>{translateUserStatus(user.status)}</Table.Td>
                              <Table.Td>{formatDateTime(user.lastSeenAt)}</Table.Td>
                            </Table.Tr>
                          ))}
                        </Table.Tbody>
                      </Table>
                    </Table.ScrollContainer>
                  </Stack>
                </Card>
              </Tabs.Panel>

              <Tabs.Panel value="nodes" pt="lg">
                <SimpleGrid cols={{ base: 1, xl: 2 }}>
                  {snapshot.nodes.map((node) => (
                    <Card key={node.id} radius="xl" shadow="sm" withBorder>
                      <Stack gap="xs">
                        <Group justify="space-between">
                          <Text fw={700}>{node.name}</Text>
                          <Badge variant="light">{node.latencyMs} ms</Badge>
                        </Group>
                        <Text c="dimmed" size="sm">
                          {node.region} · {node.provider}
                        </Text>
                        <Group gap="xs">
                          {node.tags.map((tag) => (
                            <Badge key={tag} variant="dot">
                              {tag}
                            </Badge>
                          ))}
                        </Group>
                      </Stack>
                    </Card>
                  ))}
                </SimpleGrid>
              </Tabs.Panel>

              <Tabs.Panel value="announcements" pt="lg">
                <SimpleGrid cols={{ base: 1, xl: 2 }}>
                  {snapshot.announcements.map((announcement) => (
                    <Card key={announcement.id} radius="xl" shadow="sm" withBorder>
                      <Stack gap="xs">
                        <Group justify="space-between" align="start">
                          <Text fw={700}>{announcement.title}</Text>
                          <Badge color={announcementLevelColor(announcement.level)} variant="light">
                            {translateAnnouncementLevel(announcement.level)}
                          </Badge>
                        </Group>
                        <Text c="dimmed" size="sm">
                          {announcement.body}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {formatDateTime(announcement.publishedAt)}
                        </Text>
                      </Stack>
                    </Card>
                  ))}
                </SimpleGrid>
              </Tabs.Panel>
            </Tabs>
          </Stack>
        </AppShell.Main>
      </AppShell>

      <Modal
        opened={subscriptionModalOpen}
        onClose={() => setSubscriptionModalOpen(false)}
        title="编辑订阅"
        centered
      >
        {subscriptionDraft ? (
          <Stack>
            <TextInput
              label="面板标识"
              value={subscriptionDraft.panelClientEmail}
              onChange={(event) =>
                setSubscriptionDraft((current) =>
                  current
                    ? {
                        ...current,
                        panelClientEmail: event.currentTarget.value
                      }
                    : current
                )
              }
            />
            <NumberInput
              label="总流量（GB）"
              min={0}
              decimalScale={2}
              value={subscriptionDraft.totalTrafficGb}
              onChange={(value) =>
                setSubscriptionDraft((current) =>
                  current
                    ? {
                        ...current,
                        totalTrafficGb: Number(value) || 0
                      }
                    : current
                )
              }
            />
            <TextInput
              label="到期时间"
              type="datetime-local"
              value={subscriptionDraft.expireAt}
              onChange={(event) =>
                setSubscriptionDraft((current) =>
                  current
                    ? {
                        ...current,
                        expireAt: event.currentTarget.value
                      }
                    : current
                )
              }
            />
            <Select
              label="状态"
              value={subscriptionDraft.state}
              data={[
                { value: "active", label: "有效" },
                { value: "expired", label: "到期" },
                { value: "exhausted", label: "流量用尽" },
                { value: "paused", label: "暂停" }
              ]}
              onChange={(value) =>
                setSubscriptionDraft((current) =>
                  current && value
                    ? {
                        ...current,
                        state: value as SubscriptionState
                      }
                    : current
                )
              }
            />
            <Checkbox
              label="允许续费"
              checked={subscriptionDraft.renewable}
              onChange={(event) =>
                setSubscriptionDraft((current) =>
                  current
                    ? {
                        ...current,
                        renewable: event.currentTarget.checked
                      }
                    : current
                )
              }
            />
            <Button onClick={() => void handleSaveSubscription()} loading={busyKey?.startsWith("subscription:")}>
              保存
            </Button>
          </Stack>
        ) : null}
      </Modal>

      <Modal opened={panelModalOpen} onClose={() => setPanelModalOpen(false)} title="编辑面板" centered>
        {panelDraft ? (
          <Stack>
            <TextInput
              label="名称"
              value={panelDraft.name}
              onChange={(event) =>
                setPanelDraft((current) =>
                  current
                    ? {
                        ...current,
                        name: event.currentTarget.value
                      }
                    : current
                )
              }
            />
            <TextInput
              label="地址"
              value={panelDraft.baseUrl}
              onChange={(event) =>
                setPanelDraft((current) =>
                  current
                    ? {
                        ...current,
                        baseUrl: event.currentTarget.value
                      }
                    : current
                )
              }
            />
            <TextInput
              label="API 路径"
              value={panelDraft.apiBasePath}
              onChange={(event) =>
                setPanelDraft((current) =>
                  current
                    ? {
                        ...current,
                        apiBasePath: event.currentTarget.value
                      }
                    : current
                )
              }
            />
            <TextInput
              label="账号"
              value={panelDraft.username}
              onChange={(event) =>
                setPanelDraft((current) =>
                  current
                    ? {
                        ...current,
                        username: event.currentTarget.value
                      }
                    : current
                )
              }
            />
            <TextInput
              label="密码"
              type="password"
              placeholder="留空则不修改"
              value={panelDraft.password}
              onChange={(event) =>
                setPanelDraft((current) =>
                  current
                    ? {
                        ...current,
                        password: event.currentTarget.value
                      }
                    : current
                )
              }
            />
            <Checkbox
              label="启用同步"
              checked={panelDraft.syncEnabled}
              onChange={(event) =>
                setPanelDraft((current) =>
                  current
                    ? {
                        ...current,
                        syncEnabled: event.currentTarget.checked
                      }
                    : current
                )
              }
            />
            <Button onClick={() => void handleSavePanel()} loading={busyKey?.startsWith("panel:")}>
              保存
            </Button>
          </Stack>
        ) : null}
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

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function toDateTimeLocal(value: string) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hour = `${date.getHours()}`.padStart(2, "0");
  const minute = `${date.getMinutes()}`.padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}`;
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

function translateSubscriptionState(state: SubscriptionState) {
  if (state === "active") return "有效";
  if (state === "expired") return "到期";
  if (state === "exhausted") return "流量用尽";
  return "暂停";
}

function panelHealthColor(health: "healthy" | "degraded" | "offline") {
  if (health === "healthy") return "green";
  if (health === "degraded") return "yellow";
  return "red";
}

function announcementLevelColor(level: "info" | "warning" | "success") {
  if (level === "info") return "blue";
  if (level === "warning") return "yellow";
  return "green";
}

function subscriptionStateColor(state: SubscriptionState) {
  if (state === "active") return "green";
  if (state === "paused") return "yellow";
  return "red";
}

function buildSyncSummary(results: PanelSyncRunDto[]) {
  if (results.length === 0) {
    return "没有可同步的面板";
  }

  return results
    .map((result) => {
      const status = translatePanelHealth(result.health);
      const detail = `用户 ${result.synchronizedUsers}，命中 ${result.matchedSubscriptions}`;
      return `${result.panelId}：${status}，${detail}`;
    })
    .join("；");
}
