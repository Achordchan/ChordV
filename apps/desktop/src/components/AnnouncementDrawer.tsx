import { useEffect, useState } from "react";
import { Badge, Button, Collapse, Group, Modal, Paper, Stack, Text, Title } from "@mantine/core";
import type { AnnouncementDto } from "@chordv/shared";

type AnnouncementDrawerProps = {
  opened: boolean;
  announcements: AnnouncementDto[];
  onClose: () => void;
};

export function AnnouncementDrawer(props: AnnouncementDrawerProps) {
  const [expandedAnnouncements, setExpandedAnnouncements] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!props.opened) {
      setExpandedAnnouncements({});
    }
  }, [props.opened]);

  function toggleAnnouncement(announcementId: string) {
    setExpandedAnnouncements((current) => ({
      ...current,
      [announcementId]: !current[announcementId]
    }));
  }

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
        </div>

        <div className="announcement-center__list">
          <Stack gap="sm">
            {props.announcements.length === 0 ? (
              <Paper withBorder radius="md" p="md" className="announcement-center__card announcement-center__card--empty">
                <Text c="dimmed">当前没有公告</Text>
              </Paper>
            ) : (
              props.announcements.map((item) => {
                const isExpanded = expandedAnnouncements[item.id] === true;
                const bodyId = `announcement-body-${item.id}`;

                return (
                  <Paper key={item.id} withBorder radius="md" p="md" className="announcement-center__card">
                    <Stack gap="xs">
                      <Group justify="space-between" align="start" wrap="nowrap" className="announcement-center__summary">
                        <Stack gap={4} className="announcement-center__summary-main">
                          <Text fw={700} className="announcement-center__title">
                            {item.title}
                          </Text>
                          <Text size="sm" c="dimmed">
                            {formatDate(item.publishedAt)}
                          </Text>
                        </Stack>
                        <Group gap="xs" wrap="nowrap" className="announcement-center__summary-actions">
                          <Badge variant="light" color={levelColor(item.level)}>
                            {translateLevel(item.level)}
                          </Badge>
                          <Button
                            type="button"
                            variant="subtle"
                            size="compact-xs"
                            onClick={() => toggleAnnouncement(item.id)}
                            aria-expanded={isExpanded}
                            aria-controls={bodyId}
                          >
                            {isExpanded ? "收起" : "展开"}
                          </Button>
                        </Group>
                      </Group>
                      <Collapse in={isExpanded}>
                        <Text id={bodyId} size="sm" className="announcement-center__body">
                          {item.body}
                        </Text>
                      </Collapse>
                    </Stack>
                  </Paper>
                );
              })
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
