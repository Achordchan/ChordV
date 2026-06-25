import { ActionIcon, Badge, Stack, Table, Text } from "@mantine/core";
import type { AdminAnnouncementRecordDto } from "@chordv/shared";
import { IconPencil, IconTrash } from "@tabler/icons-react";
import { DataTable } from "../features/shared/DataTable";
import { SectionCard } from "../features/shared/SectionCard";
import { StatusBadge } from "../features/shared/StatusBadge";
import { formatDateTime } from "../utils/admin-format";
import { announcementLevelColor, translateAnnouncementLevel, translateDisplayMode } from "../utils/admin-translate";

type AnnouncementsPageProps = {
  searchValue: string;
  onSearchChange: (value: string) => void;
  announcements: AdminAnnouncementRecordDto[];
  actionBusyKey: string | null;
  onOpenAnnouncementDrawer: (announcementId: string) => void;
  onDeleteAnnouncement: (announcementId: string) => void;
};

export function AnnouncementsPage(props: AnnouncementsPageProps) {
  return (
    <SectionCard
      title="公告管理"
      searchValue={props.searchValue}
      onSearchChange={props.onSearchChange}
      searchPlaceholder="搜索公告标题或内容"
    >
      <DataTable>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>标题</Table.Th>
            <Table.Th>级别</Table.Th>
            <Table.Th>模式</Table.Th>
            <Table.Th>发布时间</Table.Th>
            <Table.Th>状态</Table.Th>
            <Table.Th>操作</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {props.announcements.map((item) => (
            <Table.Tr key={item.id}>
              <Table.Td>
                <Stack gap={0}>
                  <Text>{item.title}</Text>
                  <Text size="sm" c="dimmed" lineClamp={1}>
                    {item.body}
                  </Text>
                </Stack>
              </Table.Td>
              <Table.Td>
                <Badge variant="light" color={announcementLevelColor(item.level)}>
                  {translateAnnouncementLevel(item.level)}
                </Badge>
              </Table.Td>
              <Table.Td>{translateDisplayMode(item.displayMode, item.countdownSeconds)}</Table.Td>
              <Table.Td>{formatDateTime(item.publishedAt)}</Table.Td>
              <Table.Td>
                <StatusBadge {...announcementStatus(item)} />
              </Table.Td>
              <Table.Td>
                <Stack gap={6}>
                  <ActionIcon
                    variant="subtle"
                    onClick={() => props.onOpenAnnouncementDrawer(item.id)}
                    disabled={props.actionBusyKey !== null}
                    title="编辑公告"
                    aria-label="编辑公告"
                  >
                    <IconPencil size={16} />
                  </ActionIcon>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    onClick={() => props.onDeleteAnnouncement(item.id)}
                    loading={props.actionBusyKey === `announcement-delete:${item.id}`}
                    disabled={props.actionBusyKey !== null && props.actionBusyKey !== `announcement-delete:${item.id}`}
                    title="删除公告"
                    aria-label="删除公告"
                  >
                    <IconTrash size={16} />
                  </ActionIcon>
                </Stack>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </DataTable>
    </SectionCard>
  );
}

function announcementStatus(item: AdminAnnouncementRecordDto) {
  if (!item.isActive) {
    return { color: "gray", label: "下线" };
  }
  if (new Date(item.publishedAt).getTime() > Date.now()) {
    return { color: "yellow", label: "待发布" };
  }
  return { color: "green", label: "上线" };
}
