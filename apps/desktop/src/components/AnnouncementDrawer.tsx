import { Badge, Drawer, Group, Paper, ScrollArea, Stack, Text, Title } from "@mantine/core";
import type { AnnouncementDto } from "@chordv/shared";

type AnnouncementDrawerProps = {
  opened: boolean;
  announcements: AnnouncementDto[];
  onClose: () => void;
};

export function AnnouncementDrawer(props: AnnouncementDrawerProps) {
  return (
    <Drawer opened={props.opened} onClose={props.onClose} position="right" size={420} title="公告">
      <Stack gap="md" h="100%">
        <div>
          <Title order={4}>历史公告</Title>
          <Text size="sm" c="dimmed" mt={4}>
            查看最近的通知、维护提醒和升级信息
          </Text>
        </div>

        <ScrollArea h="100%">
          <Stack gap="sm">
            {props.announcements.length === 0 ? (
              <Paper withBorder radius="lg" p="lg">
                <Text c="dimmed">当前没有公告</Text>
              </Paper>
            ) : (
              props.announcements.map((item) => (
                <Paper key={item.id} withBorder radius="lg" p="md">
                  <Stack gap="xs">
                    <Group justify="space-between" align="start">
                      <Text fw={700}>{item.title}</Text>
                      <Badge variant="light" color={levelColor(item.level)}>
                        {translateLevel(item.level)}
                      </Badge>
                    </Group>
                    <Text size="sm" c="dimmed">
                      {formatDate(item.publishedAt)}
                    </Text>
                    <Text size="sm">{item.body}</Text>
                  </Stack>
                </Paper>
              ))
            )}
          </Stack>
        </ScrollArea>
      </Stack>
    </Drawer>
  );
}

function translateLevel(level: AnnouncementDto["level"]) {
  if (level === "warning") return "提醒";
  if (level === "success") return "成功";
  return "通知";
}

function levelColor(level: AnnouncementDto["level"]) {
  if (level === "warning") return "yellow";
  if (level === "success") return "green";
  return "blue";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}
