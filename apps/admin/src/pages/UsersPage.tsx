import type { Dispatch, SetStateAction } from "react";
import { Accordion, ActionIcon, Badge, Button, Group, Paper, Select, Stack, Table, Tabs, Text, TextInput } from "@mantine/core";
import type { AdminTeamRecordDto, AdminUserRecordDto, TeamMemberRole, TeamStatus } from "@chordv/shared";
import { IconLock, IconLockOpen2, IconPencil, IconTrash, IconUsers } from "@tabler/icons-react";
import { DataTable } from "../features/shared/DataTable";
import { RowActions } from "../features/shared/RowActions";
import { SectionCard } from "../features/shared/SectionCard";
import { StatusBadge } from "../features/shared/StatusBadge";
import type { TeamFormState, TeamMemberFormState } from "../utils/admin-forms";
import { translateRole, translateUserStatus } from "../utils/admin-translate";

type UsersPageProps = {
  searchValue: string;
  onSearchChange: (value: string) => void;
  userTab: "personal" | "team";
  onUserTabChange: (value: "personal" | "team") => void;
  users: AdminUserRecordDto[];
  filteredTeams: AdminTeamRecordDto[];
  allUsers: AdminUserRecordDto[];
  teamInlineEditorId: string | null;
  teamMemberInlineEditor: { teamId: string; memberId: string | null } | null;
  teamInlineBusy: boolean;
  teamForm: TeamFormState;
  setTeamForm: Dispatch<SetStateAction<TeamFormState>>;
  teamMemberForm: TeamMemberFormState;
  setTeamMemberForm: Dispatch<SetStateAction<TeamMemberFormState>>;
  buildTeamMemberOptions: (currentUserId?: string) => Array<{ value: string; label: string }>;
  onOpenUserDrawer: (userId: string) => void;
  onOpenTeamInlineEditor: (teamId: string) => void;
  onCloseTeamInlineEditor: () => void;
  onSaveTeamInlineEditor: (teamId: string) => void;
  onOpenTeamMemberInlineEditor: (teamId: string, memberId?: string | null) => void;
  onCloseTeamMemberInlineEditor: () => void;
  onSaveTeamMemberInlineEditor: () => void;
  onDeleteTeamMember: (teamId: string, memberId: string) => void;
  onToggleTeamUserStatus: (userId: string, nextStatus: "active" | "disabled", displayName: string) => void;
};

export function UsersPage(props: UsersPageProps) {
  return (
    <Stack gap="lg">
      <SectionCard searchValue={props.searchValue} onSearchChange={props.onSearchChange}>
        <Tabs value={props.userTab} onChange={(value) => props.onUserTabChange((value as "personal" | "team") || "personal")}>
          <Tabs.List>
            <Tabs.Tab value="personal">个人用户</Tabs.Tab>
            <Tabs.Tab value="team">Team 用户</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="personal" pt="md">
            <DataTable>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>邮箱</Table.Th>
                  <Table.Th>名称</Table.Th>
                  <Table.Th>角色</Table.Th>
                  <Table.Th>状态</Table.Th>
                  <Table.Th>操作</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {props.users.filter((item) => item.accountType === "personal").map((item) => (
                  <Table.Tr key={item.id}>
                    <Table.Td>{item.email}</Table.Td>
                    <Table.Td>{item.displayName}</Table.Td>
                    <Table.Td>
                      <Badge variant="light">{translateRole(item.role)}</Badge>
                    </Table.Td>
                    <Table.Td>
                      <StatusBadge color={item.status === "active" ? "green" : "gray"} label={translateUserStatus(item.status)} />
                    </Table.Td>
                    <Table.Td>
                      <ActionIcon variant="subtle" onClick={() => props.onOpenUserDrawer(item.id)}>
                        <IconPencil size={16} />
                      </ActionIcon>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </DataTable>
          </Tabs.Panel>
          <Tabs.Panel value="team" pt="md">
            <Accordion variant="separated" radius="xl">
              {props.filteredTeams.map((item) => (
                <Accordion.Item key={item.id} value={item.id}>
                  <Accordion.Control>
                    <Group justify="space-between" wrap="nowrap">
                      <Group gap="xl" wrap="nowrap">
                        <Stack gap={0} miw={220}>
                          <Text fw={600}>{item.name}</Text>
                          <Text size="sm" c="dimmed">
                            {item.ownerDisplayName} · {item.ownerEmail}
                          </Text>
                        </Stack>
                        <Stack gap={0} miw={120}>
                          <Text size="sm" c="dimmed">
                            成员数
                          </Text>
                          <Text fw={600}>{item.memberCount}</Text>
                        </Stack>
                      </Group>
                      <StatusBadge color={item.status === "active" ? "green" : "gray"} label={item.status === "active" ? "启用" : "停用"} />
                    </Group>
                  </Accordion.Control>
                  <Accordion.Panel>
                    <Stack gap="md">
                      <Group justify="space-between">
                        <Text size="sm" c="dimmed">
                          这里只处理团队组织、负责人和成员关系，不展示共享订阅、节点和流量账单。
                        </Text>
                        <RowActions>
                          <ActionIcon variant="subtle" onClick={() => props.onOpenTeamInlineEditor(item.id)}>
                            <IconPencil size={16} />
                          </ActionIcon>
                          <ActionIcon variant="subtle" onClick={() => props.onOpenTeamMemberInlineEditor(item.id)}>
                            <IconUsers size={16} />
                          </ActionIcon>
                        </RowActions>
                      </Group>

                      {props.teamInlineEditorId === item.id ? (
                        <Paper withBorder radius="lg" p="md">
                          <Stack gap="sm">
                            <Text fw={600}>编辑团队</Text>
                            <TextInput
                              label="团队名称"
                              value={props.teamForm.name}
                              onChange={(event) => props.setTeamForm((current) => ({ ...current, name: event.currentTarget.value }))}
                            />
                            <Select
                              label="负责人"
                              data={props.allUsers
                                .filter(
                                  (user) =>
                                    user.role === "user" &&
                                    (user.teamId === null || user.id === props.teamForm.ownerUserId || user.id === item.ownerUserId)
                                )
                                .map((user) => ({ value: user.id, label: `${user.displayName} · ${user.email}` }))}
                              value={props.teamForm.ownerUserId}
                              onChange={(value) => props.setTeamForm((current) => ({ ...current, ownerUserId: value || "" }))}
                            />
                            <Select
                              label="状态"
                              data={[
                                { value: "active", label: "启用" },
                                { value: "disabled", label: "停用" }
                              ]}
                              value={props.teamForm.status}
                              onChange={(value) =>
                                props.setTeamForm((current) => ({ ...current, status: (value || "active") as TeamStatus }))
                              }
                            />
                            <Group justify="flex-end">
                              <Button variant="default" onClick={props.onCloseTeamInlineEditor}>
                                取消
                              </Button>
                              <Button onClick={() => props.onSaveTeamInlineEditor(item.id)} loading={props.teamInlineBusy}>
                                保存
                              </Button>
                            </Group>
                          </Stack>
                        </Paper>
                      ) : null}

                      {props.teamMemberInlineEditor?.teamId === item.id ? (
                        <Paper withBorder radius="lg" p="md">
                          <Stack gap="sm">
                            <Text fw={600}>{props.teamMemberInlineEditor.memberId ? "编辑成员" : "添加成员"}</Text>
                            <Select
                              label="成员账号"
                              disabled={props.teamMemberInlineEditor.memberId !== null}
                              data={props.buildTeamMemberOptions(props.teamMemberForm.userId)}
                              value={props.teamMemberForm.userId}
                              onChange={(value) => props.setTeamMemberForm((current) => ({ ...current, userId: value || "" }))}
                            />
                            <Select
                              label="角色"
                              data={[
                                { value: "member", label: "成员" },
                                { value: "owner", label: "负责人" }
                              ]}
                              value={props.teamMemberForm.role}
                              onChange={(value) =>
                                props.setTeamMemberForm((current) => ({ ...current, role: (value || "member") as TeamMemberRole }))
                              }
                            />
                            <Group justify="flex-end">
                              <Button variant="default" onClick={props.onCloseTeamMemberInlineEditor}>
                                取消
                              </Button>
                              <Button onClick={props.onSaveTeamMemberInlineEditor} loading={props.teamInlineBusy}>
                                保存
                              </Button>
                            </Group>
                          </Stack>
                        </Paper>
                      ) : null}

                      <DataTable>
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th>账号</Table.Th>
                            <Table.Th>角色</Table.Th>
                            <Table.Th>状态</Table.Th>
                            <Table.Th>操作</Table.Th>
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {item.members.map((member) => {
                            const userRecord = props.allUsers.find((user) => user.id === member.userId);
                            return (
                              <Table.Tr key={member.id}>
                                <Table.Td>
                                  <Stack gap={0}>
                                    <Text>{member.displayName}</Text>
                                    <Text size="sm" c="dimmed">
                                      {member.email}
                                    </Text>
                                  </Stack>
                                </Table.Td>
                                <Table.Td>
                                  <Badge variant="light">{member.role === "owner" ? "负责人" : "成员"}</Badge>
                                </Table.Td>
                                <Table.Td>
                                  <StatusBadge
                                    color={userRecord?.status === "active" ? "green" : "gray"}
                                    label={translateUserStatus(userRecord?.status ?? "disabled")}
                                  />
                                </Table.Td>
                                <Table.Td>
                                  <RowActions>
                                    <ActionIcon
                                      variant="subtle"
                                      color={userRecord?.status === "active" ? "red" : "green"}
                                      onClick={() =>
                                        props.onToggleTeamUserStatus(
                                          member.userId,
                                          userRecord?.status === "active" ? "disabled" : "active",
                                          member.displayName
                                        )
                                      }
                                      title={userRecord?.status === "active" ? "禁用账号" : "启用账号"}
                                    >
                                      {userRecord?.status === "active" ? <IconLock size={16} /> : <IconLockOpen2 size={16} />}
                                    </ActionIcon>
                                    <ActionIcon variant="subtle" onClick={() => props.onOpenTeamMemberInlineEditor(item.id, member.id)}>
                                      <IconUsers size={16} />
                                    </ActionIcon>
                                    {member.role !== "owner" ? (
                                      <ActionIcon color="red" variant="subtle" onClick={() => props.onDeleteTeamMember(item.id, member.id)}>
                                        <IconTrash size={16} />
                                      </ActionIcon>
                                    ) : null}
                                  </RowActions>
                                </Table.Td>
                              </Table.Tr>
                            );
                          })}
                        </Table.Tbody>
                      </DataTable>
                    </Stack>
                  </Accordion.Panel>
                </Accordion.Item>
              ))}
            </Accordion>
          </Tabs.Panel>
        </Tabs>
      </SectionCard>
    </Stack>
  );
}
