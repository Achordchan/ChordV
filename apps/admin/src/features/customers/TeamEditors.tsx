import { teamOwnerOptions } from "./team-owner-options";
import { Button, Group, Modal, Paper, Select, Stack, Text, TextInput } from "@mantine/core";
import type { AdminTeamRecordDto, TeamStatus } from "@chordv/shared";
import dialogStyles from "../editors/EditorDialog.module.css";
import type { UsersPageProps } from "./types";

export function TeamProfileEditorPanel(props: UsersPageProps & { team: AdminTeamRecordDto }) {
  return (
    <Paper withBorder radius="sm" p="md" className={dialogStyles.form}>
      <Stack gap="sm">
        <Text fw={600}>编辑团队</Text>
        <TextInput
          label="团队名称"
          value={props.teamForm.name}
          onChange={(event) => props.setTeamForm((current) => ({ ...current, name: event.currentTarget.value }))}
        />
        <Select
          label="负责人"
          searchable nothingFoundMessage="团队内没有可选成员"
          description="仅可转移给本团队已启用成员。"
          disabled={props.teamProfileBusyKey === props.team.id}
          data={teamOwnerOptions(props.allUsers, props.team.id, props.team.ownerUserId)}
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
          onChange={(value) => props.setTeamForm((current) => ({ ...current, status: (value || "active") as TeamStatus }))}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={props.onCloseTeamInlineEditor}>
            取消
          </Button>
          <Button color="#1c4d37" onClick={() => props.onSaveTeamInlineEditor(props.team.id)} loading={props.teamProfileBusyKey === props.team.id}>
            保存
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}

export function TeamMemberEditorPanel(props: UsersPageProps) {
  const editor = props.teamMemberInlineEditor;
  if (!editor) return null;
  const busy = props.teamMemberBusyKey !== null;
  const owner = props.teamMemberForm.role === "owner";
  const options = props.buildTeamMemberOptions(props.teamMemberForm.userId);
  return <Modal opened onClose={props.onCloseTeamMemberInlineEditor} title={editor.memberId ? "成员角色" : "添加团队成员"} centered size="md"
    closeOnClickOutside={!busy} closeOnEscape={!busy} withCloseButton={!busy}
    overlayProps={{ backgroundOpacity: .35, blur: 2 }} classNames={{ content: dialogStyles.content, header: dialogStyles.header, title: dialogStyles.title, body: dialogStyles.body }}>
    <div className={dialogStyles.form}>
      <Text size="sm" c="dimmed" mb="lg">成员加入后共用团队订阅的流量与节点授权。</Text>
      <Select label="成员账号" placeholder="搜索并选择已有账号" searchable nothingFoundMessage="没有可添加的账号" disabled={busy || editor.memberId !== null}
        data={options} value={props.teamMemberForm.userId} onChange={value => props.setTeamMemberForm(current => ({ ...current, userId: value || "" }))}/>
      <div className={dialogStyles.switchRow}><div><strong>团队角色</strong><p>{owner ? "负责人需在团队资料中转移，不能在此降级。" : "成员 · 使用团队共享权益"}</p></div></div>
      {!options.length && !editor.memberId && <Text size="sm" c="orange" mt="md">暂无可添加账号，请先创建客户。</Text>}
      <footer className={dialogStyles.footer}><Button variant="default" onClick={props.onCloseTeamMemberInlineEditor} disabled={busy}>取消</Button>
        <Button color="#1c4d37" onClick={props.onSaveTeamMemberInlineEditor} loading={busy} disabled={busy || owner || !props.teamMemberForm.userId}>{editor.memberId ? "保存成员" : "确认添加"}</Button></footer>
    </div>
  </Modal>;
}
