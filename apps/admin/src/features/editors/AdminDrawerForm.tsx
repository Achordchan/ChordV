import { Button, Drawer, Group, Stack } from "@mantine/core";
import type { AccessMode, AdminNodePanelInboundDto, AdminSnapshotDto } from "@chordv/shared";
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
  currentAccessMode: AccessMode;
  eligiblePersonalUsers: Array<{ id: string; displayName: string; email: string }>;
  nodePanelInbounds: AdminNodePanelInboundDto[];
  nodePanelInboundsLoading: boolean;
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
  onLoadNodePanelInbounds: () => void;
};

export function AdminDrawerForm(props: AdminDrawerFormProps) {
  return (
    <Drawer opened={props.opened} onClose={props.onClose} title={props.title} position="right" size="lg">
      <Stack>
        {props.drawerType === "user" ? (
          <UserEditorSection drawerRecordId={props.drawerRecordId} userForm={props.userForm} setUserForm={props.setUserForm} />
        ) : null}
        {props.drawerType === "plan" ? (
          <PlanEditorSection planForm={props.planForm} setPlanForm={props.setPlanForm} />
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
            currentAccessMode={props.currentAccessMode}
            nodeForm={props.nodeForm}
            setNodeForm={props.setNodeForm}
            nodePanelInbounds={props.nodePanelInbounds}
            nodePanelInboundsLoading={props.nodePanelInboundsLoading}
            onLoadNodePanelInbounds={props.onLoadNodePanelInbounds}
          />
        ) : null}
        {props.drawerType === "announcement" ? (
          <AnnouncementEditorSection
            announcementForm={props.announcementForm}
            setAnnouncementForm={props.setAnnouncementForm}
          />
        ) : null}
        <Group justify="flex-end">
          <Button variant="default" onClick={props.onClose}>
            取消
          </Button>
          <Button onClick={props.onSubmit} loading={props.drawerBusy}>
            保存
          </Button>
        </Group>
      </Stack>
    </Drawer>
  );
}
