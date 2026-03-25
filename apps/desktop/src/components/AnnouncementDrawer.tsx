import { Badge, Group, Modal, Paper, Stack, Text, Title } from "@mantine/core";
import type { AnnouncementDto } from "@chordv/shared";

type AnnouncementDrawerProps = {
  opened: boolean;
  announcements: AnnouncementDto[];
  onClose: () => void;
};

export function AnnouncementDrawer(props: AnnouncementDrawerProps) {
  return (
    <Modal
      opened={props.opened}
      onClose={props.onClose}
      title="公告中心"
      size="86%"
      centered
      classNames={{
        content: "announcement-center__modal-content",
        header: "announcement-center__modal-header",
        body: "announcement-center__modal-body"
      }}
    >
      <Stack gap="md" className="announcement-center">
        <div className="announcement-center__headline">
          <Title order={4}>历史公告</Title>
          <Text size="sm" c="dimmed">
            查看最近的通知、维护提醒和升级信息。
          </Text>
        </div>

        <div className="announcement-center__list">
          <Stack gap="sm">
            {props.announcements.length === 0 ? (
              <Paper withBorder radius="md" p="md" className="announcement-center__card announcement-center__card--empty">
                <Text c="dimmed">当前没有公告</Text>
              </Paper>
            ) : (
              props.announcements.map((item) => (
                <Paper key={item.id} withBorder radius="md" p="md" className="announcement-center__card">
                  <Stack gap="xs">
                    <Group justify="space-between" align="start" wrap="nowrap">
                      <Text fw={700}>{item.title}</Text>
                      <Badge variant="light" color={levelColor(item.level)}>
                        {translateLevel(item.level)}
                      </Badge>
                    </Group>
                    <Text size="sm" c="dimmed">
                      {formatDate(item.publishedAt)}
                    </Text>
                    <Text size="sm" className="announcement-center__body">
                      {item.body}
                    </Text>
                  </Stack>
                </Paper>
              ))
            )}
          </Stack>
        </div>
      </Stack>
    </Modal>
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
