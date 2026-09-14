import { Alert, Button, Modal, Stack, Text } from "@mantine/core";
import type { AdminSnapshotDto } from "@chordv/shared";
import { formatTrafficGb } from "../../utils/admin-format";
import styles from "./EditorDialog.module.css";
import { AnnouncementEditorSection, PlanEditorSection, SubscriptionAdjustEditorSection, SubscriptionChangePlanEditorSection, SubscriptionCreateEditorSection, SubscriptionRenewEditorSection, TeamEditorSection, TeamMemberEditorSection, TeamSubscriptionEditorSection, UserEditorSection } from "./DrawerSections";
import { NodeEditorSection } from "./NodeEditorSection";
import type {
  AnnouncementFormState,
  NodeFormState,
  PlanFormState,
  SubscriptionAdjustFormState,
  SubscriptionChangePlanFormState,
  SubscriptionCreateFormState,
  SubscriptionRenewFormState,
  TeamFormState,
  TeamMemberFormState,
  TeamSubscriptionFormState,
  UserFormState
} from "../../utils/admin-forms";

export type DrawerType =
  | "user"
  | "plan"
  | "subscription-create"
  | "subscription-adjust"
  | "subscription-renew"
  | "subscription-change-plan"
  | "team"
  | "team-member"
  | "team-subscription"
  | "node"
  | "announcement"
  | null;

type AdminDrawerFormProps = {
  opened: boolean;
  title: string;
  drawerType: DrawerType;
  drawerRecordId: string | null;
  snapshot: AdminSnapshotDto;
  eligiblePersonalUsers: Array<{ id: string; displayName: string; email: string }>;
  userForm: UserFormState;
  setUserForm: React.Dispatch<React.SetStateAction<UserFormState>>;
  planForm: PlanFormState;
  setPlanForm: React.Dispatch<React.SetStateAction<PlanFormState>>;
  subscriptionCreateForm: SubscriptionCreateFormState;
  setSubscriptionCreateForm: React.Dispatch<React.SetStateAction<SubscriptionCreateFormState>>;
  subscriptionAdjustForm: SubscriptionAdjustFormState;
  setSubscriptionAdjustForm: React.Dispatch<React.SetStateAction<SubscriptionAdjustFormState>>;
  subscriptionRenewForm: SubscriptionRenewFormState;
  setSubscriptionRenewForm: React.Dispatch<React.SetStateAction<SubscriptionRenewFormState>>;
  subscriptionChangePlanForm: SubscriptionChangePlanFormState;
  setSubscriptionChangePlanForm: React.Dispatch<React.SetStateAction<SubscriptionChangePlanFormState>>;
  teamForm: TeamFormState;
  setTeamForm: React.Dispatch<React.SetStateAction<TeamFormState>>;
  teamMemberForm: TeamMemberFormState;
  setTeamMemberForm: React.Dispatch<React.SetStateAction<TeamMemberFormState>>;
  teamSubscriptionForm: TeamSubscriptionFormState;
  setTeamSubscriptionForm: React.Dispatch<React.SetStateAction<TeamSubscriptionFormState>>;
  nodeForm: NodeFormState;
  setNodeForm: React.Dispatch<React.SetStateAction<NodeFormState>>;
  announcementForm: AnnouncementFormState;
  setAnnouncementForm: React.Dispatch<React.SetStateAction<AnnouncementFormState>>;
  drawerBusy: boolean;
  onClose: () => void;
  onSubmit: () => void;
};

// The parent keeps the existing editor state and mutation handlers. Short
// editors share one modal shell while keeping their existing mutation contracts.
export function AdminDrawerForm(props: AdminDrawerFormProps) {
  const subscription = props.drawerRecordId && props.drawerType?.startsWith("subscription-")
    ? props.snapshot.subscriptions.find(item => item.id === props.drawerRecordId) ?? null : null;
  const plan = props.drawerType === "plan" && props.drawerRecordId
    ? props.snapshot.plans.find(item => item.id === props.drawerRecordId) ?? null : null;
  const needsSubscription = ["subscription-renew", "subscription-adjust", "subscription-change-plan"].includes(props.drawerType ?? "");
  const dateValid = Boolean(props.subscriptionRenewForm.expireAt) && Number.isFinite(Date.parse(props.subscriptionRenewForm.expireAt));
  const blocked = props.drawerBusy || (needsSubscription && !subscription) ||
    (props.drawerType === "subscription-renew" && (!subscription?.renewable || !dateValid));
  const submitLabel = props.drawerType === "subscription-renew" ? "确认续期"
    : props.drawerType === "subscription-change-plan" ? "确认变更"
    : props.drawerType === "subscription-adjust" ? "确认调整"
    : props.drawerType === "subscription-create" ? "开通订阅"
    : props.drawerType === "plan" ? (props.drawerRecordId ? "保存套餐" : "创建套餐")
    : props.drawerType === "user" ? (props.drawerRecordId ? "保存客户" : "创建客户") : props.drawerType === "node" ? "保存节点" : props.drawerType === "announcement" ? "保存公告" : "保存";
  const close = props.drawerBusy ? () => undefined : props.onClose;
  const content = <form className={styles.form} key={`${props.drawerType}:${props.drawerRecordId}:${props.opened}`} onSubmit={event => { event.preventDefault(); if (!blocked) props.onSubmit(); }}>
    {subscription && <div className={styles.context}><div><Text fw={600}>{subscription.ownerType === "team" ? subscription.teamName : subscription.userDisplayName || subscription.userEmail}</Text><Text size="xs" c="dimmed" mt={4}>{subscription.planName}{subscription.ownerType === "team" ? " · 团队共享订阅" : " · 个人订阅"}</Text></div><div><small>当前剩余</small><strong>{formatTrafficGb(subscription.remainingTrafficGb)} GB</strong></div></div>}
    {plan && <div className={styles.context}><Text fw={600}>{plan.name}</Text><Text size="sm" c="dimmed">关联 {plan.subscriptionCount} 个订阅</Text></div>}
    {needsSubscription && !subscription && <Alert color="red" mb="md">订阅已不存在或尚未加载，请关闭后刷新客户数据。</Alert>}
    {props.drawerType === "subscription-renew" && subscription && !subscription.renewable && <Alert color="orange" mb="md">当前套餐不支持续期，请先关闭此窗口并查看套餐规则。</Alert>}
    <fieldset className={styles.fields} disabled={props.drawerBusy || (needsSubscription && !subscription) || (props.drawerType === "subscription-renew" && !subscription?.renewable)}><Stack gap="md">

        {props.drawerType === "user" ? (
          <UserEditorSection drawerRecordId={props.drawerRecordId} userForm={props.userForm} setUserForm={props.setUserForm} />
        ) : null}
        {props.drawerType === "plan" ? (
          <PlanEditorSection planForm={props.planForm} setPlanForm={props.setPlanForm} record={plan} />
        ) : null}
        {props.drawerType === "subscription-create" ? (
          <SubscriptionCreateEditorSection
            snapshot={props.snapshot}
            subscriptionCreateForm={props.subscriptionCreateForm}
            setSubscriptionCreateForm={props.setSubscriptionCreateForm}
            eligiblePersonalUsers={props.eligiblePersonalUsers}
          />
        ) : null}
        {props.drawerType === "subscription-adjust" ? (
          <SubscriptionAdjustEditorSection
            subscriptionAdjustForm={props.subscriptionAdjustForm}
            setSubscriptionAdjustForm={props.setSubscriptionAdjustForm}
          />
        ) : null}
        {props.drawerType === "subscription-renew" ? (
          <SubscriptionRenewEditorSection
            subscription={subscription}
            subscriptionRenewForm={props.subscriptionRenewForm}
            setSubscriptionRenewForm={props.setSubscriptionRenewForm}
          />
        ) : null}
        {props.drawerType === "subscription-change-plan" ? (
          <SubscriptionChangePlanEditorSection
            snapshot={props.snapshot}
            subscriptionChangePlanForm={props.subscriptionChangePlanForm}
            setSubscriptionChangePlanForm={props.setSubscriptionChangePlanForm}
          />
        ) : null}
        {props.drawerType === "team" ? (
          <TeamEditorSection
            snapshot={props.snapshot}
            drawerRecordId={props.drawerRecordId}
            teamForm={props.teamForm}
            setTeamForm={props.setTeamForm}
          />
        ) : null}
        {props.drawerType === "team-member" ? (
          <TeamMemberEditorSection
            eligiblePersonalUsers={props.eligiblePersonalUsers}
            drawerRecordId={props.drawerRecordId}
            teamMemberForm={props.teamMemberForm}
            setTeamMemberForm={props.setTeamMemberForm}
          />
        ) : null}
        {props.drawerType === "team-subscription" ? (
          <TeamSubscriptionEditorSection
            snapshot={props.snapshot}
            teamSubscriptionForm={props.teamSubscriptionForm}
            setTeamSubscriptionForm={props.setTeamSubscriptionForm}
          />
        ) : null}
        {props.drawerType === "node" ? (
          <NodeEditorSection
            node={props.snapshot.nodes.find((item) => item.id === props.drawerRecordId) ?? null}
            nodeForm={props.nodeForm}
            setNodeForm={props.setNodeForm}
          />
        ) : null}
        {props.drawerType === "announcement" ? (
          <AnnouncementEditorSection
            announcementForm={props.announcementForm}
            setAnnouncementForm={props.setAnnouncementForm}
          />
        ) : null}

    </Stack></fieldset>
    <footer className={styles.footer}><Button type="button" variant="default" onClick={props.onClose} disabled={props.drawerBusy}>取消</Button><Button type="submit" color="#1c4d37" loading={props.drawerBusy} disabled={blocked}>{submitLabel}</Button></footer>
  </form>;
  return <Modal opened={props.opened} onClose={close} title={props.drawerType === "node" ? "编辑节点" : props.title} centered size={props.drawerType === "subscription-renew" ? 600 : "lg"}
    closeOnClickOutside={!props.drawerBusy} closeOnEscape={!props.drawerBusy} withCloseButton={!props.drawerBusy}
    overlayProps={{ backgroundOpacity: 0.35, blur: 2 }} classNames={{ content: styles.content, header: styles.header, title: styles.title, body: styles.body }}>
    {content}
  </Modal>;
}
