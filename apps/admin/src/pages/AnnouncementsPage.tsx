import { useState } from "react";
import { ActionIcon, Menu, SegmentedControl, Table, Text, TextInput } from "@mantine/core";
import type { AdminAnnouncementRecordDto } from "@chordv/shared";
import { IconDots, IconPencil, IconSearch, IconTrash } from "@tabler/icons-react";
import { DataTable } from "../features/shared/DataTable";
import { formatDateTime } from "../utils/admin-format";
import { announcementLevelColor, translateAnnouncementLevel, translateDisplayMode } from "../utils/admin-translate";
import styles from "../features/announcements/Announcements.module.css";

type AnnouncementsPageProps = {
  searchValue: string;
  onSearchChange: (value: string) => void;
  announcements: AdminAnnouncementRecordDto[];
  actionBusyKey: string | null;
  onOpenAnnouncementDrawer: (announcementId: string) => void;
  onDeleteAnnouncement: (announcementId: string) => void;
};

export function AnnouncementsPage(props: AnnouncementsPageProps) {
  const [filter, setFilter] = useState("全部");
  const records = props.announcements.filter(item => filter === "全部" || announcementStatus(item) === filter);
  return <section className={styles.workspace} aria-label="公告列表">
    <div className={styles.toolbar}><TextInput aria-label="搜索公告" placeholder="搜索标题或内容" leftSection={<IconSearch size={16}/>} value={props.searchValue} onChange={event => props.onSearchChange(event.currentTarget.value)}/><SegmentedControl classNames={{root: styles.filters, label: styles.filterLabel, indicator: styles.filterIndicator}} value={filter} onChange={setFilter} data={["全部", "已上线", "待发布", "已下线"]}/></div>
    <div className={styles.table}><DataTable minWidth={760}>
      <Table.Thead><Table.Tr><Table.Th>公告内容</Table.Th><Table.Th>展示方式</Table.Th><Table.Th>发布时间</Table.Th><Table.Th>状态</Table.Th><Table.Th/></Table.Tr></Table.Thead>
      <Table.Tbody>{records.length ? records.map(item => <Table.Tr key={item.id}>
        <Table.Td><button className={styles.title} disabled={props.actionBusyKey !== null} onClick={() => props.onOpenAnnouncementDrawer(item.id)}>{item.title}</button><Text size="sm" c="dimmed" lineClamp={2} className={styles.excerpt}>{item.body}</Text></Table.Td>
        <Table.Td><Text size="sm">{translateDisplayMode(item.displayMode, item.countdownSeconds)}</Text><Text size="xs" c={announcementLevelColor(item.level)} mt={6}>{translateAnnouncementLevel(item.level)}</Text></Table.Td>
        <Table.Td><Text size="sm" c="dimmed">{formatDateTime(item.publishedAt)}</Text></Table.Td>
        <Table.Td><Text size="sm" className={styles.status} data-active={item.isActive}>{announcementStatus(item)}</Text></Table.Td>
        <Table.Td><Menu position="bottom-end" withinPortal><Menu.Target><ActionIcon aria-label={`${item.title}的操作`} variant="subtle" color="gray" loading={props.actionBusyKey === `announcement-delete:${item.id}`} disabled={props.actionBusyKey !== null}><IconDots size={18}/></ActionIcon></Menu.Target><Menu.Dropdown><Menu.Item leftSection={<IconPencil size={16}/>} onClick={() => props.onOpenAnnouncementDrawer(item.id)}>编辑公告</Menu.Item><Menu.Item color="red" leftSection={<IconTrash size={16}/>} onClick={() => props.onDeleteAnnouncement(item.id)}>删除公告</Menu.Item></Menu.Dropdown></Menu></Table.Td>
      </Table.Tr>) : <Table.Tr><Table.Td colSpan={5}><Text className={styles.empty}>没有符合条件的公告</Text></Table.Td></Table.Tr>}</Table.Tbody>
    </DataTable></div><Text ta="right" size="xs" c="dimmed" mt="lg">当前显示 {records.length} 条公告</Text>
  </section>;
}

function announcementStatus(item: AdminAnnouncementRecordDto) {
  if (!item.isActive) return "已下线";
  if (new Date(item.publishedAt).getTime() > Date.now()) return "待发布";
  return "已上线";
}
