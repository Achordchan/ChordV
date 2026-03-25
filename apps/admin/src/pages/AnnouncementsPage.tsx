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
  onOpenAnnouncementDrawer: (announcementId: string) => void;
  onDeleteAnnouncement: (announcementId: string) => void;
};

export function AnnouncementsPage(props: AnnouncementsPageProps) {
  return (
    <SectionCard searchValue={props.searchValue} onSearchChange={props.onSearchChange}>
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
                <StatusBadge color={item.isActive ? "green" : "gray"} label={item.isActive ? "上线" : "下线"} />
              </Table.Td>
              <Table.Td>
                <Stack gap={6}>
                  <ActionIcon variant="subtle" onClick={() => props.onOpenAnnouncementDrawer(item.id)}>
                    <IconPencil size={16} />
                  </ActionIcon>
                  <ActionIcon variant="subtle" color="red" onClick={() => props.onDeleteAnnouncement(item.id)}>
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
