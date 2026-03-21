import { Group, NumberInput, Select, Switch, TextInput, Textarea } from "@mantine/core";
import type {
  AdminSnapshotDto,
  AnnouncementDisplayMode,
  AnnouncementLevel,
  PlanScope,
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
  type PlanFormState,
  type SubscriptionAdjustFormState,
  type SubscriptionChangePlanFormState,
  type SubscriptionCreateFormState,
  type SubscriptionRenewFormState,
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

export function PlanEditorSection(props: {
  planForm: PlanFormState;
  setPlanForm: Dispatch<SetStateAction<PlanFormState>>;
}) {
  return (
    <>
      <TextInput
        label="套餐名称"
        value={props.planForm.name}
        onChange={(event) => props.setPlanForm((current) => ({ ...current, name: event.currentTarget.value }))}
      />
      <Select
        label="套餐类型"
        data={[
          { value: "personal", label: "个人套餐" },
          { value: "team", label: "Team 套餐" }
        ]}
        value={props.planForm.scope}
        onChange={(value) => props.setPlanForm((current) => ({ ...current, scope: (value || "personal") as PlanScope }))}
      />
      <NumberInput
        label="总流量 (GB)"
        min={0}
        value={props.planForm.totalTrafficGb}
        onChange={(value) => props.setPlanForm((current) => ({ ...current, totalTrafficGb: Number(value) || 0 }))}
      />
      <Group grow>
        <Switch
          checked={props.planForm.renewable}
          onChange={(event) => props.setPlanForm((current) => ({ ...current, renewable: event.currentTarget.checked }))}
          label="允许续费"
        />
        <Switch
          checked={props.planForm.isActive}
          onChange={(event) => props.setPlanForm((current) => ({ ...current, isActive: event.currentTarget.checked }))}
          label="启用"
        />
      </Group>
    </>
  );
}

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

export function SubscriptionRenewEditorSection(props: {
  subscriptionRenewForm: SubscriptionRenewFormState;
  setSubscriptionRenewForm: Dispatch<SetStateAction<SubscriptionRenewFormState>>;
}) {
  return (
    <>
      <ExpireAtController
        label="新的到期时间"
        value={props.subscriptionRenewForm.expireAt}
        baseValue={props.subscriptionRenewForm.baseExpireAt}
        onChange={(value) => props.setSubscriptionRenewForm((current) => ({ ...current, expireAt: value }))}
      />
      <NumberInput
        label="续后总流量 (留空保持原值)"
        value={props.subscriptionRenewForm.totalTrafficGb}
        min={0}
        onChange={(value) =>
          props.setSubscriptionRenewForm((current) => ({
            ...current,
            totalTrafficGb: value === "" || value === null ? "" : Number(value)
          }))
        }
      />
      <Switch
        checked={props.subscriptionRenewForm.resetTraffic}
        onChange={(event) => props.setSubscriptionRenewForm((current) => ({ ...current, resetTraffic: event.currentTarget.checked }))}
        label="续期时重置已用流量"
      />
    </>
  );
}

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
        data={[
          { value: "member", label: "成员" },
          { value: "owner", label: "负责人" }
        ]}
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
          value={props.announcementForm.countdownSeconds}
          onChange={(value) => props.setAnnouncementForm((current) => ({ ...current, countdownSeconds: Number(value) || 1 }))}
        />
      ) : null}
      <Switch
        checked={props.announcementForm.isActive}
        onChange={(event) => props.setAnnouncementForm((current) => ({ ...current, isActive: event.currentTarget.checked }))}
        label="立即上线"
      />
    </>
  );
}
