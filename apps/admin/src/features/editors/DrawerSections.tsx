import { Group, NumberInput, Select, Switch, TextInput, Textarea } from "@mantine/core";
import type {
  AdminSnapshotDto,
  AnnouncementDisplayMode,
  AnnouncementLevel,
  SubscriptionState,
  TeamMemberRole,
  TeamStatus,
  UserRole,
  UserStatus
} from "@chordv/shared";
import type { Dispatch, SetStateAction } from "react";
import { ExpireAtController } from "../shared/ExpireAtController";
import {
  announcementLevelOptions,
  applyPlanToChangePlanForm,
  applyPlanToCreateForm,
  applyPlanToTeamSubscriptionForm,
  displayModeOptions,
  subscriptionStateOptions,
  type AnnouncementFormState,
  type SubscriptionAdjustFormState,
  type SubscriptionChangePlanFormState,
  type SubscriptionCreateFormState,
  type TeamFormState,
  type TeamMemberFormState,
  type TeamSubscriptionFormState,
  type UserFormState
} from "../../utils/admin-forms";

export function UserEditorSection(props: {
  drawerRecordId: string | null;
  userForm: UserFormState;
  setUserForm: Dispatch<SetStateAction<UserFormState>>;
}) {
  return (
    <>
      <TextInput
        label="邮箱"
        value={props.userForm.email}
        onChange={(event) => props.setUserForm((current) => ({ ...current, email: event.currentTarget.value }))}
        disabled={props.drawerRecordId !== null}
      />
      <TextInput
        label={props.drawerRecordId ? "重置密码" : "登录密码"}
        type="password"
        value={props.userForm.password}
        placeholder={props.drawerRecordId ? "留空则不修改" : ""}
        onChange={(event) => props.setUserForm((current) => ({ ...current, password: event.currentTarget.value }))}
      />
      <TextInput
        label="名称"
        value={props.userForm.displayName}
        onChange={(event) => props.setUserForm((current) => ({ ...current, displayName: event.currentTarget.value }))}
      />
      <NumberInput
        label="最大并发覆盖"
        description="留空则使用套餐默认并发数"
        min={1}
        allowDecimal={false}
        value={props.userForm.maxConcurrentSessionsOverride}
        onChange={(value) =>
          props.setUserForm((current) => ({
            ...current,
            maxConcurrentSessionsOverride: value === "" || value === null ? "" : Number(value) || ""
          }))
        }
      />
      <Select
        label="角色"
        data={[
          { value: "user", label: "用户" },
          { value: "admin", label: "管理员" }
        ]}
        value={props.userForm.role}
        onChange={(value) => props.setUserForm((current) => ({ ...current, role: (value || "user") as UserRole }))}
      />
      {props.drawerRecordId ? (
        <Select
          label="状态"
          data={[
            { value: "active", label: "启用" },
            { value: "disabled", label: "禁用" }
          ]}
          value={props.userForm.status}
          onChange={(value) => props.setUserForm((current) => ({ ...current, status: (value || "active") as UserStatus }))}
        />
      ) : null}
    </>
  );
}

export { PlanEditorSection } from "./PlanEditor";

export function SubscriptionCreateEditorSection(props: {
  snapshot: AdminSnapshotDto;
  subscriptionCreateForm: SubscriptionCreateFormState;
  setSubscriptionCreateForm: Dispatch<SetStateAction<SubscriptionCreateFormState>>;
  eligiblePersonalUsers: Array<{ id: string; displayName: string; email: string }>;
}) {
  return (
    <>
      <Select
        label="用户"
        data={props.eligiblePersonalUsers.map((item) => ({ value: item.id, label: `${item.displayName} · ${item.email}` }))}
        value={props.subscriptionCreateForm.userId}
        onChange={(value) => props.setSubscriptionCreateForm((current) => ({ ...current, userId: value || "" }))}
      />
      <Select
        label="套餐"
        data={props.snapshot.plans.filter((item) => item.isActive && item.scope === "personal").map((item) => ({ value: item.id, label: item.name }))}
        value={props.subscriptionCreateForm.planId}
        onChange={(value) => props.setSubscriptionCreateForm((current) => applyPlanToCreateForm(props.snapshot, current, value || ""))}
      />
      <Group grow>
        <NumberInput
          label="总流量 (GB)"
          min={0}
          value={props.subscriptionCreateForm.totalTrafficGb}
          onChange={(value) => props.setSubscriptionCreateForm((current) => ({ ...current, totalTrafficGb: Number(value) || 0 }))}
        />
        <NumberInput
          label="已用流量 (GB)"
          min={0}
          value={props.subscriptionCreateForm.usedTrafficGb}
          onChange={(value) => props.setSubscriptionCreateForm((current) => ({ ...current, usedTrafficGb: Number(value) || 0 }))}
        />
      </Group>
      <TextInput
        label="到期时间"
        type="datetime-local"
        value={props.subscriptionCreateForm.expireAt}
        onChange={(event) => props.setSubscriptionCreateForm((current) => ({ ...current, expireAt: event.currentTarget.value }))}
      />
      <Select
        label="状态"
        data={subscriptionStateOptions}
        value={props.subscriptionCreateForm.state}
        onChange={(value) => props.setSubscriptionCreateForm((current) => ({ ...current, state: (value || "active") as SubscriptionState }))}
      />
    </>
  );
}

export function SubscriptionAdjustEditorSection(props: {
  subscriptionAdjustForm: SubscriptionAdjustFormState;
  setSubscriptionAdjustForm: Dispatch<SetStateAction<SubscriptionAdjustFormState>>;
}) {
  return (
    <>
      <NumberInput
        label="总流量 (GB)"
        min={0}
        value={props.subscriptionAdjustForm.totalTrafficGb}
        onChange={(value) => props.setSubscriptionAdjustForm((current) => ({ ...current, totalTrafficGb: Number(value) || 0 }))}
      />
      <NumberInput
        label="已用流量 (GB)"
        min={0}
        value={props.subscriptionAdjustForm.usedTrafficGb}
        onChange={(value) => props.setSubscriptionAdjustForm((current) => ({ ...current, usedTrafficGb: Number(value) || 0 }))}
      />
      <ExpireAtController
        label="到期时间"
        value={props.subscriptionAdjustForm.expireAt}
        baseValue={props.subscriptionAdjustForm.baseExpireAt}
        onChange={(value) => props.setSubscriptionAdjustForm((current) => ({ ...current, expireAt: value }))}
      />
      <Select
        label="状态"
        data={subscriptionStateOptions}
        value={props.subscriptionAdjustForm.state}
        onChange={(value) => props.setSubscriptionAdjustForm((current) => ({ ...current, state: (value || "active") as SubscriptionState }))}
      />
    </>
  );
}

export { SubscriptionRenewEditorSection } from "./SubscriptionRenewEditor";

export function SubscriptionChangePlanEditorSection(props: {
  snapshot: AdminSnapshotDto;
  subscriptionChangePlanForm: SubscriptionChangePlanFormState;
  setSubscriptionChangePlanForm: Dispatch<SetStateAction<SubscriptionChangePlanFormState>>;
}) {
  return (
    <>
      <Select
        label="目标套餐"
        data={props.snapshot.plans.filter((item) => item.isActive && item.scope === props.subscriptionChangePlanForm.scope).map((item) => ({ value: item.id, label: item.name }))}
        value={props.subscriptionChangePlanForm.planId}
        onChange={(value) => props.setSubscriptionChangePlanForm((current) => applyPlanToChangePlanForm(props.snapshot, current, value || ""))}
      />
      <NumberInput
        label="总流量 (GB)"
        min={0}
        value={props.subscriptionChangePlanForm.totalTrafficGb}
        onChange={(value) => props.setSubscriptionChangePlanForm((current) => ({ ...current, totalTrafficGb: Number(value) || 0 }))}
      />
      <ExpireAtController
        label="到期时间"
        value={props.subscriptionChangePlanForm.expireAt}
        baseValue={props.subscriptionChangePlanForm.baseExpireAt}
        onChange={(value) => props.setSubscriptionChangePlanForm((current) => ({ ...current, expireAt: value }))}
      />
    </>
  );
}

export function TeamEditorSection(props: {
  snapshot: AdminSnapshotDto;
  drawerRecordId: string | null;
  teamForm: TeamFormState;
  setTeamForm: Dispatch<SetStateAction<TeamFormState>>;
}) {
  return (
    <>
      <TextInput
        label="团队名称"
        value={props.teamForm.name}
        onChange={(event) => props.setTeamForm((current) => ({ ...current, name: event.currentTarget.value }))}
      />
      <Select
        label="负责人"
        data={props.snapshot.users
          .filter((item) => item.role === "user" && (props.drawerRecordId ? item.teamId === null || item.id === props.teamForm.ownerUserId : item.teamId === null))
          .map((item) => ({ value: item.id, label: `${item.displayName} · ${item.email}` }))}
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
    </>
  );
}

export function TeamMemberEditorSection(props: {
  eligiblePersonalUsers: Array<{ id: string; displayName: string; email: string }>;
  drawerRecordId: string | null;
  teamMemberForm: TeamMemberFormState;
  setTeamMemberForm: Dispatch<SetStateAction<TeamMemberFormState>>;
}) {
  const roleOptions =
    props.teamMemberForm.role === "owner"
      ? [
          { value: "owner", label: "负责人", disabled: true },
          { value: "member", label: "成员" }
        ]
      : [{ value: "member", label: "成员" }];

  return (
    <>
      <Select
        label="成员账号"
        disabled={props.drawerRecordId !== null}
        data={props.eligiblePersonalUsers.map((item) => ({ value: item.id, label: `${item.displayName} · ${item.email}` }))}
        value={props.teamMemberForm.userId}
        onChange={(value) => props.setTeamMemberForm((current) => ({ ...current, userId: value || "" }))}
      />
      <Select
        label="角色"
        description="负责人只能通过团队编辑里的负责人字段转移"
        data={roleOptions}
        disabled={props.teamMemberForm.role === "owner"}
        value={props.teamMemberForm.role}
        onChange={(value) => props.setTeamMemberForm((current) => ({ ...current, role: (value || "member") as TeamMemberRole }))}
      />
    </>
  );
}

export function TeamSubscriptionEditorSection(props: {
  snapshot: AdminSnapshotDto;
  teamSubscriptionForm: TeamSubscriptionFormState;
  setTeamSubscriptionForm: Dispatch<SetStateAction<TeamSubscriptionFormState>>;
}) {
  return (
    <>
      <Select
        label="套餐"
        data={props.snapshot.plans.filter((item) => item.isActive && item.scope === "team").map((item) => ({ value: item.id, label: item.name }))}
        value={props.teamSubscriptionForm.planId}
        onChange={(value) => props.setTeamSubscriptionForm((current) => applyPlanToTeamSubscriptionForm(props.snapshot, current, value || ""))}
      />
      <NumberInput
        label="总流量 (GB)"
        min={0}
        value={props.teamSubscriptionForm.totalTrafficGb}
        onChange={(value) => props.setTeamSubscriptionForm((current) => ({ ...current, totalTrafficGb: Number(value) || 0 }))}
      />
      <NumberInput
        label="已用流量 GB"
        min={0}
        value={props.teamSubscriptionForm.usedTrafficGb}
        onChange={(value) => props.setTeamSubscriptionForm((current) => ({ ...current, usedTrafficGb: Number(value) || 0 }))}
      />
      <TextInput
        label="到期时间"
        type="datetime-local"
        value={props.teamSubscriptionForm.expireAt}
        onChange={(event) => props.setTeamSubscriptionForm((current) => ({ ...current, expireAt: event.currentTarget.value }))}
      />
    </>
  );
}

export function AnnouncementEditorSection(props: {
  announcementForm: AnnouncementFormState;
  setAnnouncementForm: Dispatch<SetStateAction<AnnouncementFormState>>;
}) {
  return (
    <>
      <TextInput
        label="标题"
        value={props.announcementForm.title}
        onChange={(event) => props.setAnnouncementForm((current) => ({ ...current, title: event.currentTarget.value }))}
      />
      <Textarea
        label="内容"
        minRows={6}
        value={props.announcementForm.body}
        onChange={(event) => props.setAnnouncementForm((current) => ({ ...current, body: event.currentTarget.value }))}
      />
      <Group grow>
        <Select
          label="级别"
          data={announcementLevelOptions}
          value={props.announcementForm.level}
          onChange={(value) => props.setAnnouncementForm((current) => ({ ...current, level: (value || "info") as AnnouncementLevel }))}
        />
        <TextInput
          label="发布时间"
          type="datetime-local"
          value={props.announcementForm.publishedAt}
          onChange={(event) => props.setAnnouncementForm((current) => ({ ...current, publishedAt: event.currentTarget.value }))}
        />
      </Group>
      <Select
        label="展示模式"
        data={displayModeOptions}
        value={props.announcementForm.displayMode}
        onChange={(value) =>
          props.setAnnouncementForm((current) => ({
            ...current,
            displayMode: (value || "passive") as AnnouncementDisplayMode,
            countdownSeconds: value === "modal_countdown" ? Math.max(1, current.countdownSeconds) : 0
          }))
        }
      />
      {props.announcementForm.displayMode === "modal_countdown" ? (
        <NumberInput
          label="倒计时秒数"
          min={1}
          step={1}
          allowDecimal={false}
          value={props.announcementForm.countdownSeconds}
          onChange={(value) => props.setAnnouncementForm((current) => ({ ...current, countdownSeconds: Math.max(1, Math.trunc(Number(value) || 1)) }))}
        />
      ) : null}
      <Switch
        checked={props.announcementForm.isActive}
        onChange={(event) => props.setAnnouncementForm((current) => ({ ...current, isActive: event.currentTarget.checked }))}
        label="启用公告（按发布时间展示）"
      />
    </>
  );
}
