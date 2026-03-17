import { useEffect, useState, type ReactNode } from "react";
import {
  AppShell,
  Badge,
  Card,
  Group,
  Loader,
  Paper,
  SimpleGrid,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title
} from "@mantine/core";
import type { AdminSnapshotDto } from "@chordv/shared";
import { IconBell, IconServer, IconShield, IconUsers } from "@tabler/icons-react";
import { getAdminSnapshot } from "./api/client";

export function App() {
  const [snapshot, setSnapshot] = useState<AdminSnapshotDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAdminSnapshot()
      .then(setSnapshot)
      .catch((reason: Error) => setError(reason.message));
  }, []);

  if (error) {
    return (
      <Paper p="xl" m="xl" shadow="sm" radius="xl" withBorder>
        加载后台数据失败：{error}
      </Paper>
    );
  }

  if (!snapshot) {
    return (
      <Group justify="center" mt="xl">
        <Loader />
      </Group>
    );
  }

  return (
    <AppShell padding="lg">
      <AppShell.Main>
        <Stack gap="lg">
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
                <Title order={3}>节点列表</Title>
                {snapshot.nodes.map((node) => (
                  <Paper key={node.id} withBorder radius="lg" p="md">
                    <Group justify="space-between" align="start">
                      <div>
                        <Text fw={600}>{node.name}</Text>
                        <Text size="sm" c="dimmed">
                          {node.region} · {node.provider} · {node.latencyMs}ms
                        </Text>
                      </div>
                      <Badge variant="dot">{node.tags.join(" / ")}</Badge>
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
