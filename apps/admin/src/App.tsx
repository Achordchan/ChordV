import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActionIcon,
  Alert,
  AppShell,
  Badge,
  Burger,
  Button,
  Card,
  Group,
  Loader,
  Modal,
  NavLink,
  Paper,
  PasswordInput,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type {
  AdminAnnouncementRecordDto,
  AdminNodeRecordDto,
  AdminNodePanelInboundDto,
  AdminPanelSyncJobDto,
  AdminPlanRecordDto,
  AdminPolicyRecordDto,
  AdminSecurityUpdateResultDto,
  AdminSnapshotDto,
  AdminSubscriptionRecordDto,
  AdminTeamRecordDto,
  AdminTeamUsageRecordDto,
  AdminUserRecordDto,
  ChangeSubscriptionPlanInputDto,
  CreateAnnouncementInputDto,
  CreatePlanInputDto,
  CreateSubscriptionInputDto,
  CreateTeamInputDto,
  CreateTeamMemberInputDto,
  CreateTeamSubscriptionInputDto,
  CreateUserInputDto,
  ImportNodeInputDto,
  PlanScope,
  RenewSubscriptionInputDto,
  UpdateAnnouncementInputDto,
  UpdateNodeInputDto,
  UpdatePlanInputDto,
  UpdatePolicyInputDto,
  UpdateSubscriptionInputDto,
  UpdateTeamInputDto,
  UpdateTeamMemberInputDto,
  UpdateUserInputDto
} from "@chordv/shared";
import { resolveCountryCode } from "@chordv/shared";
import {
  IconBell,
  IconBolt,
  IconCloudDownload,
  IconCpu,
  IconLayoutDashboard,
  IconListDetails,
  IconMapPin,
  IconMessageCircle,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconRoute,
  IconSearch,
  IconSpeakerphone,
  IconTrash,
  IconUser,
  IconUsers,
  IconPhoto
} from "@tabler/icons-react";
import {
  changeSubscriptionPlan,
  convertPersonalSubscriptionToTeam,
  createAnnouncement,
  createPlan,
  createSubscription,
  createTeam,
  createTeamMember,
  createTeamSubscription,
  createUser,
  deleteAnnouncement,
  deleteNode,
  deleteTeamMember,
  disconnectUser,
  fetchAdminAnnouncements,
  fetchAdminDashboard,
  fetchAdminLeaseRevocationJobs,
  fetchAdminNodes,
  fetchAdminPanelSyncJobs,
  fetchAdminPlans,
  fetchAdminPolicy,
  fetchAdminSubscriptions,
  fetchAdminTeams,
  fetchAdminUsers,
  fetchNodePanelInbounds,
  getAdminProfile,
  getTeamUsage,
  getSubscriptionNodeAccess,
  importNode,
  kickTeamMember,
  probeAllNodes,
  probeNode,
  refreshNode,
  resetSubscriptionTraffic,
  renewSubscription,
  retryAdminLeaseRevocationJob,
  retryAdminLeaseRevocationJobsForNode,
  retryAdminPanelSyncJob,
  retryAdminPanelSyncJobsForNode,
  subscribeAdminRuntimeEvents,
  updateAnnouncement,
  updateNode,
  updatePlan,
  updatePolicy,
  updateSubscription,
  updateSubscriptionNodeAccess,
  clearAdminSession,
  hasAdminSession,
  loginAdmin,
  logoutAdminSession,
  persistAdminSession,
  refreshAdminSession,
  updateTeam,
  updateTeamMember,
  updateCurrentAdminSecurity,
  updateUser
} from "./api/client";
import { ADMIN_SESSION_EXPIRED_EVENT, isAdminSessionExpiredMessage } from "./api/base";
import { AdminLoginPanel } from "./components/AdminLoginPanel";
import { AdminDrawerForm, type DrawerType } from "./features/editors/AdminDrawerForm";
import { DeleteNodeModal, KickMemberModal, NodeAccessEditorModal, TeamUsageDetailModal } from "./features/modals/AdminModals";
import { AnnouncementsPage } from "./pages/AnnouncementsPage";
import { ImageBedPage } from "./pages/ImageBedPage";
import { NodesPage, PanelSyncQueueDrawer, type PanelSyncQueueFilter } from "./pages/NodesPage";
import { OverviewPage } from "./pages/OverviewPage";
import { PlansPage } from "./pages/PlansPage";
import { PoliciesPage } from "./pages/PoliciesPage";
import { ReleasesPage } from "./pages/ReleasesPage";
import { RuntimeComponentsPage } from "./pages/RuntimeComponentsPage";
import { SubscriptionsPage } from "./pages/SubscriptionsPage";
import { TicketsPage } from "./pages/TicketsPage";
import { UsersPage } from "./pages/UsersPage";
import {
  applyPlanToChangePlanForm,
  applyPlanToCreateForm,
  applyPlanToTeamSubscriptionForm,
  emptyAnnouncementForm,
  emptyNodeForm,
  emptyPlanForm,
  emptySubscriptionAdjustForm,
  emptySubscriptionChangePlanForm,
  emptySubscriptionCreateForm,
  emptySubscriptionRenewForm,
  emptyTeamForm,
  emptyTeamMemberForm,
  emptyTeamSubscriptionForm,
  emptyUserForm,
  toPolicyForm,
  type AnnouncementFormState,
  type NodeFormState,
  type PlanFormState,
  type PolicyFormState,
  type SubscriptionAdjustFormState,
  type SubscriptionChangePlanFormState,
  type SubscriptionCreateFormState,
  type SubscriptionRenewFormState,
  type TeamFormState,
  type TeamMemberFormState,
  type TeamSubscriptionFormState,
  type UserFormState
} from "./utils/admin-forms";
import {
  buildUncertainMutationMessage,
  filterByKeyword,
  isDefiniteLocalSaveFailure,
  isLikelySavedAfterFailure,
  isPotentiallyCompletedMutationFailure,
  isUncertainRequestFailure,
  readError,
  summarizeAdminDiagnosticMessage
} from "./utils/admin-filters";
import { addDays, formatDateTime, formatTrafficGb, fromDateTimeLocal, toDateTimeLocal } from "./utils/admin-format";
import {
  getRenewActionDescription,
  subscriptionStateColor,
  translateSubscriptionState
} from "./utils/admin-translate";

const MAX_NODE_ACCESS_SELECTION = 100;

function requiresAdminSessionRefresh(
  result: AdminSecurityUpdateResultDto
): result is Extract<AdminSecurityUpdateResultDto, { sessionRefreshRequired: true }> {
  return "sessionRefreshRequired" in result && result.sessionRefreshRequired === true;
}

type SectionKey =
  | "overview"
  | "users"
  | "plans"
  | "subscriptions"
  | "tickets"
  | "nodes"
  | "announcements"
  | "policies"
  | "releases"
  | "runtimeComponents"
  | "imageBed";
type EditorState = {
  type: DrawerType;
  recordId: string | null;
  parentId: string | null;
};

type NodeAccessEditorState = {
  subscriptionId: string;
  ownerLabel: string;
};

type SnapshotListKey = Exclude<keyof AdminSnapshotDto, "dashboard" | "policy">;

type AdminAuthFormState = {
  account: string;
  password: string;
};

type AdminSecurityFormState = {
  email: string;
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
};

type PanelSyncQueueState = {
  opened: boolean;
  filter: PanelSyncQueueFilter | null;
};

const sectionMeta: Record<SectionKey, { label: string; description: string; icon: ReactNode }> = {
  overview: {
    label: "概览",
    description: "查看运营总览和关键变化",
    icon: <IconLayoutDashboard size={18} />
  },
  users: {
    label: "用户",
    description: "账号、角色和启停状态",
    icon: <IconUsers size={18} />
  },
  plans: {
    label: "套餐",
    description: "流量模板与续费规则",
    icon: <IconListDetails size={18} />
  },
  subscriptions: {
    label: "订阅",
    description: "新建、续期、变更套餐、校正",
    icon: <IconUser size={18} />
  },
  tickets: {
    label: "工单",
    description: "查看、回复、关闭与重开工单",
    icon: <IconMessageCircle size={18} />
  },
  nodes: {
    label: "节点",
    description: "添加面板、刷新、探测、删除",
    icon: <IconMapPin size={18} />
  },
  announcements: {
    label: "公告",
    description: "普通公告与强提示弹窗",
    icon: <IconSpeakerphone size={18} />
  },
  policies: {
    label: "策略",
    description: "接入与连接策略",
    icon: <IconRoute size={18} />
  },
  releases: {
    label: "发布中心",
    description: "版本发布与安装包",
    icon: <IconCloudDownload size={18} />
  },
  runtimeComponents: {
    label: "内核组件",
    description: "管理 Xray 与规则集",
    icon: <IconCpu size={18} />
  },
  imageBed: {
    label: "图床",
    description: "配置工单附件图床，并管理已上传图片",
    icon: <IconPhoto size={18} />
  }
};

export function App() {
  const [snapshot, setSnapshot] = useState<AdminSnapshotDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [sectionLoading, setSectionLoading] = useState(false);
  const [loadedSections, setLoadedSections] = useState<Set<SectionKey>>(() => new Set());
  const [refreshingDashboard, setRefreshingDashboard] = useState(false);
  const [authenticated, setAuthenticated] = useState(() => hasAdminSession());
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authForm, setAuthForm] = useState<AdminAuthFormState>({
    account: "",
    password: ""
  });
  const [adminSecurityOpened, setAdminSecurityOpened] = useState(false);
  const [adminSecuritySaving, setAdminSecuritySaving] = useState(false);
  const adminSecuritySavingRef = useRef(false);
  const [adminSecurityForm, setAdminSecurityForm] = useState<AdminSecurityFormState>({
    email: "",
    currentPassword: "",
    newPassword: "",
    confirmPassword: ""
  });
  const [section, setSection] = useState<SectionKey>("overview");
  const sectionRef = useRef<SectionKey>("overview");
  const [releaseRefreshSignal, setReleaseRefreshSignal] = useState(0);
  const [ticketRefreshSignal, setTicketRefreshSignal] = useState(0);
  const [runtimeComponentRefreshSignal, setRuntimeComponentRefreshSignal] = useState(0);
  const [imageBedRefreshSignal, setImageBedRefreshSignal] = useState(0);
  const [mobileNavOpened, setMobileNavOpened] = useState(false);
  const [drawer, setDrawer] = useState<EditorState>({ type: null, recordId: null, parentId: null });
  const [drawerBusy, setDrawerBusy] = useState(false);
  const drawerBusyRef = useRef(false);
  const [teamInlineEditorId, setTeamInlineEditorId] = useState<string | null>(null);
  const [teamMemberInlineEditor, setTeamMemberInlineEditor] = useState<{ teamId: string; memberId: string | null } | null>(null);
  const [teamSubscriptionInlineEditorId, setTeamSubscriptionInlineEditorId] = useState<string | null>(null);
  const [teamProfileBusyKey, setTeamProfileBusyKey] = useState<string | null>(null);
  const teamProfileBusyRef = useRef<string | null>(null);
  const [teamMemberBusyKey, setTeamMemberBusyKey] = useState<string | null>(null);
  const teamMemberBusyRef = useRef<string | null>(null);
  const [teamSubscriptionBusyKey, setTeamSubscriptionBusyKey] = useState<string | null>(null);
  const teamSubscriptionBusyRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [userTab, setUserTab] = useState<"personal" | "team">("personal");
  const [planScopeTab, setPlanScopeTab] = useState<PlanScope>("personal");
  const [subscriptionTab, setSubscriptionTab] = useState<"personal" | "team">("personal");
  const [authBootstrapped, setAuthBootstrapped] = useState(() => hasAdminSession());
  const [search, setSearch] = useState<Record<Exclude<SectionKey, "overview" | "tickets" | "policies" | "releases" | "runtimeComponents">, string>>({
    users: "",
    plans: "",
    subscriptions: "",
    nodes: "",
    announcements: "",
    imageBed: ""
  });
  const [deleteNodeTarget, setDeleteNodeTarget] = useState<AdminNodeRecordDto | null>(null);
  const [deleteNodeSubmitting, setDeleteNodeSubmitting] = useState(false);
  const deleteNodeSubmittingRef = useRef(false);
  const [kickMemberTarget, setKickMemberTarget] = useState<{ teamId: string; memberId: string; memberName: string } | null>(null);
  const [kickDisableAccount, setKickDisableAccount] = useState(false);
  const [kickSubmitting, setKickSubmitting] = useState(false);
  const kickSubmittingRef = useRef(false);
  const [resetTrafficBusyKey, setResetTrafficBusyKey] = useState<string | null>(null);
  const resetTrafficBusyRef = useRef(false);
  const [convertSubscriptionTarget, setConvertSubscriptionTarget] = useState<{
    subscriptionId: string;
    ownerLabel: string;
    ownerEmail: string;
    currentPlanName: string;
  } | null>(null);
  const [convertTargetTeamId, setConvertTargetTeamId] = useState<string | null>(null);
  const [convertSubmitting, setConvertSubmitting] = useState(false);
  const convertSubmittingRef = useRef(false);
  const [entityActionBusyKey, setEntityActionBusyKey] = useState<string | null>(null);
  const entityActionBusyRef = useRef<string | null>(null);
  const [teamUsageDetailTarget, setTeamUsageDetailTarget] = useState<{
    teamName: string;
    userDisplayName: string;
    userEmail: string;
    entry: AdminTeamUsageRecordDto;
  } | null>(null);
  const [teamUsageByTeamId, setTeamUsageByTeamId] = useState<Record<string, AdminTeamUsageRecordDto[]>>({});
  const [teamUsageLoadingByTeamId, setTeamUsageLoadingByTeamId] = useState<Record<string, boolean>>({});
  const [teamUsageErrorByTeamId, setTeamUsageErrorByTeamId] = useState<Record<string, string | null>>({});
  const [probingNodeId, setProbingNodeId] = useState<string | null>(null);
  const [probingAll, setProbingAll] = useState(false);
  const probingBusyRef = useRef(false);
  const [refreshingNodeId, setRefreshingNodeId] = useState<string | null>(null);
  const refreshingNodeRef = useRef<string | null>(null);
  const [panelSyncRetryBusyKey, setPanelSyncRetryBusyKey] = useState<string | null>(null);
  const panelSyncRetryBusyRef = useRef(false);
  const [leaseRevocationRetryBusyKey, setLeaseRevocationRetryBusyKey] = useState<string | null>(null);
  const leaseRevocationRetryBusyRef = useRef(false);
  const dashboardRefreshSeqRef = useRef(0);
  const sectionRequestSeqRef = useRef(0);
  const sectionMutationSeqRef = useRef(0);
  const pendingSyncQueueRefreshRef = useRef(false);

  const [userForm, setUserForm] = useState<UserFormState>(emptyUserForm());
  const [planForm, setPlanForm] = useState<PlanFormState>(emptyPlanForm());
  const [subscriptionCreateForm, setSubscriptionCreateForm] = useState<SubscriptionCreateFormState>(emptySubscriptionCreateForm());
  const [subscriptionAdjustForm, setSubscriptionAdjustForm] = useState<SubscriptionAdjustFormState>(emptySubscriptionAdjustForm());
  const [subscriptionRenewForm, setSubscriptionRenewForm] = useState<SubscriptionRenewFormState>(emptySubscriptionRenewForm());
  const [subscriptionChangePlanForm, setSubscriptionChangePlanForm] =
    useState<SubscriptionChangePlanFormState>(emptySubscriptionChangePlanForm());
  const [teamForm, setTeamForm] = useState<TeamFormState>(emptyTeamForm());
  const [teamMemberForm, setTeamMemberForm] = useState<TeamMemberFormState>(emptyTeamMemberForm());
  const [teamSubscriptionForm, setTeamSubscriptionForm] = useState<TeamSubscriptionFormState>(emptyTeamSubscriptionForm());
  const [nodeForm, setNodeForm] = useState<NodeFormState>(emptyNodeForm());
  const [announcementForm, setAnnouncementForm] = useState<AnnouncementFormState>(emptyAnnouncementForm());
  const [policyForm, setPolicyForm] = useState<PolicyFormState | null>(null);
  const [policyDirty, setPolicyDirty] = useState(false);
  const [policySaving, setPolicySaving] = useState(false);
  const policySavingRef = useRef(false);
  const [nodeAccessEditor, setNodeAccessEditor] = useState<NodeAccessEditorState | null>(null);
  const [nodeAccessSelection, setNodeAccessSelection] = useState<string[]>([]);
  const [nodeAccessLoading, setNodeAccessLoading] = useState(false);
  const [nodeAccessSaving, setNodeAccessSaving] = useState(false);
  const nodeAccessSavingRef = useRef(false);
  const nodeAccessRequestSeqRef = useRef(0);
  const [nodePanelInbounds, setNodePanelInbounds] = useState<AdminNodePanelInboundDto[]>([]);
  const [nodePanelInboundsLoading, setNodePanelInboundsLoading] = useState(false);
  const [panelSyncQueue, setPanelSyncQueue] = useState<PanelSyncQueueState>({ opened: false, filter: null });

  const openPanelSyncQueue = (filter?: PanelSyncQueueFilter) => {
    setPanelSyncQueue({ opened: true, filter: filter ?? null });
  };

  const closePanelSyncQueue = () => {
    setPanelSyncQueue((current) => ({ ...current, opened: false }));
  };

  const selectSection = (nextSection: SectionKey) => {
    setSection(nextSection);
    setMobileNavOpened(false);
  };

  useEffect(() => {
    if (authBootstrapped) {
      return;
    }

    let disposed = false;
    void (async () => {
      try {
        const session = await refreshAdminSession();
        if (disposed) {
          return;
        }
        if (session.user.role !== "admin") {
          clearAdminSession();
          setAuthenticated(false);
          setLoading(false);
          return;
        }
        persistAdminSession(session);
        setAuthenticated(true);
        setError(null);
      } catch {
        if (!disposed) {
          clearAdminSession();
          setAuthenticated(false);
          setLoading(false);
        }
      } finally {
        if (!disposed) {
          setAuthBootstrapped(true);
        }
      }
    })();

    return () => {
      disposed = true;
    };
  }, [authBootstrapped]);

  useEffect(() => {
    if (!authBootstrapped) {
      return;
    }
    if (!authenticated) {
      setSnapshot(null);
      setLoading(false);
      return;
    }
    void loadInitialAdminData();
  }, [authenticated, authBootstrapped]);

  useEffect(() => {
    if (!authenticated || !snapshot) {
      return;
    }
    void loadSectionData(section);
  }, [authenticated, section, snapshot]);

  useEffect(() => {
    sectionRef.current = section;
  }, [section]);

  useEffect(() => {
    if (!snapshot) {
      return;
    }
    setPolicyForm((current) => (policyDirty && current ? current : toPolicyForm(snapshot.policy)));
  }, [policyDirty, snapshot?.policy]);

  useEffect(() => {
    if (!authenticated) {
      return;
    }
    const refreshVisibleAdminData = () => {
      if (document.visibilityState === "hidden") {
        return;
      }
      if (pendingSyncQueueRefreshRef.current) {
        pendingSyncQueueRefreshRef.current = false;
        void refreshPanelSyncJobsAfterPending().catch(() => undefined);
      }
      if (sectionRef.current === "releases") {
        setReleaseRefreshSignal((current) => current + 1);
      }
      void refreshDashboard({ silent: true });
      void refreshCurrentSectionSilently();
    };
    window.addEventListener("focus", refreshVisibleAdminData);
    document.addEventListener("visibilitychange", refreshVisibleAdminData);
    return () => {
      window.removeEventListener("focus", refreshVisibleAdminData);
      document.removeEventListener("visibilitychange", refreshVisibleAdminData);
    };
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated) {
      return;
    }
    return subscribeAdminRuntimeEvents((event) => {
      if (event.type === "keepalive") {
        return;
      }
      if (event.type === "sync_queue_updated") {
        if (document.visibilityState === "hidden") {
          pendingSyncQueueRefreshRef.current = true;
          return;
        }
        void refreshPanelSyncJobsAfterPending().catch(() => undefined);
        void refreshDashboard({ silent: true });
        return;
      }
      if (document.visibilityState === "hidden") {
        return;
      }
      if (event.type === "version_updated") {
        setReleaseRefreshSignal((current) => current + 1);
      }
      void refreshDashboard({ silent: true });
      if (sectionRef.current === "tickets") {
        if (event.type === "ticket_updated") {
          setTicketRefreshSignal((current) => current + 1);
        }
        return;
      }
      void refreshCurrentSectionSilently();
    });
  }, [authenticated]);

  useEffect(() => {
    const handleSessionExpired = () => {
      handleSessionExpiredState();
    };

    window.addEventListener(ADMIN_SESSION_EXPIRED_EVENT, handleSessionExpired);
    return () => {
      window.removeEventListener(ADMIN_SESSION_EXPIRED_EVENT, handleSessionExpired);
    };
  }, []);

  const users = useMemo(
    () => filterByKeyword(snapshot?.users ?? [], search.users, (item) => [item.email, item.displayName, item.role]),
    [snapshot?.users, search.users]
  );
  const plans = useMemo(
    () =>
      filterByKeyword(snapshot?.plans ?? [], search.plans, (item) => [item.name, String(item.totalTrafficGb)]),
    [snapshot?.plans, search.plans]
  );
  const allSubscriptions = useMemo(() => snapshot?.subscriptions ?? [], [snapshot?.subscriptions]);
  const subscriptions = useMemo(
    () =>
      filterByKeyword(allSubscriptions, search.subscriptions, (item) => [
        item.userEmail ?? "",
        item.userDisplayName ?? "",
        item.teamName ?? "",
        item.planName,
        item.state,
        item.sourceAction
      ]),
    [allSubscriptions, search.subscriptions]
  );
  const teams = useMemo(() => snapshot?.teams ?? [], [snapshot?.teams]);
  const filteredTeams = useMemo(
    () =>
      filterByKeyword(teams, search.users, (item) => [
        item.name,
        item.ownerDisplayName,
        item.ownerEmail,
        item.status
      ]),
    [teams, search.users]
  );
  const filteredTeamSubscriptions = useMemo(
    () =>
      filterByKeyword(teams, search.subscriptions, (item) => [
        item.name,
        item.ownerDisplayName,
        item.currentSubscription?.planName ?? "",
        item.currentSubscription?.state ?? "",
        item.status
      ]),
    [teams, search.subscriptions]
  );
  const teamsWithCurrentSubscription = useMemo(
    () =>
      teams.filter(
        (item) =>
          item.status === "active" &&
          item.currentSubscription !== null &&
          (item.currentSubscription.state === "active" || item.currentSubscription.state === "paused")
      ),
    [teams]
  );
  const convertTargetTeamOptions = useMemo(
    () =>
      teamsWithCurrentSubscription.map((item) => ({
        value: item.id,
        label: `${item.name} · ${item.currentSubscription!.planName} · 到期 ${formatDateTime(item.currentSubscription!.expireAt)}`
      })),
    [teamsWithCurrentSubscription]
  );
  const selectedConvertTargetTeam = useMemo(
    () => teamsWithCurrentSubscription.find((item) => item.id === convertTargetTeamId) ?? null,
    [convertTargetTeamId, teamsWithCurrentSubscription]
  );
  const nodes = useMemo(
    () =>
      filterByKeyword(snapshot?.nodes ?? [], search.nodes, (item) => [
        item.name,
        item.countryCode ?? "",
        item.region,
        item.provider,
        item.serverHost,
        item.probeStatus
      ]),
    [snapshot?.nodes, search.nodes]
  );
  const announcements = useMemo(
    () =>
      filterByKeyword(snapshot?.announcements ?? [], search.announcements, (item) => [
        item.title,
        item.body,
        item.level,
        item.displayMode
      ]),
    [snapshot?.announcements, search.announcements]
  );
  const eligiblePersonalUsers = useMemo(
    () =>
      (snapshot?.users ?? []).filter(
        (item) =>
          item.role === "user" &&
          item.accountType === "personal" &&
          item.status === "active" &&
          item.currentSubscription === null
      ),
    [snapshot?.users]
  );
  const buildTeamMemberOptions = (currentUserId?: string) => {
    const base = eligiblePersonalUsers.map((item) => ({ value: item.id, label: `${item.displayName} · ${item.email}` }));
    if (!currentUserId || !snapshot) {
      return base;
    }
    const currentUser = snapshot.users.find((item) => item.id === currentUserId);
    if (!currentUser || base.some((item) => item.value === currentUserId)) {
      return base;
    }
    return [{ value: currentUser.id, label: `${currentUser.displayName} · ${currentUser.email}` }, ...base];
  };
  const nodeOptions = useMemo(
    () =>
      (snapshot?.nodes ?? []).map((item) => ({
        value: item.id,
        label: buildNodeAccessOptionLabel(item)
      })),
    [snapshot?.nodes]
  );
  const renewTargetSubscription =
    drawer.type === "subscription-renew" && drawer.recordId
      ? snapshot?.subscriptions.find((item) => item.id === drawer.recordId) ?? null
      : null;
  const renewActionDisabled = drawer.type === "subscription-renew" && renewTargetSubscription !== null && !renewTargetSubscription.renewable;
  const nodePanelInboundOptions = useMemo(
    () =>
      nodePanelInbounds.map((item) => ({
        value: String(item.id),
        label: `${item.remark} · ID ${item.id} · ${item.protocol.toUpperCase()} · ${item.port} · ${item.clientCount} 个客户端`
      })),
    [nodePanelInbounds]
  );

  function handleSessionExpiredState() {
    clearAdminSession();
    setSnapshot(null);
    setAuthenticated(false);
    setLoading(false);
    setSectionLoading(false);
    setLoadedSections(new Set());
    setRefreshingDashboard(false);
    setError(null);
    setAuthError("登录已失效，请重新登录");
    setDrawer({ type: null, recordId: null, parentId: null });
    setDeleteNodeTarget(null);
    setKickMemberTarget(null);
    setKickDisableAccount(false);
    setKickSubmitting(false);
    setResetTrafficBusyKey(null);
    setConvertSubscriptionTarget(null);
    setConvertTargetTeamId(null);
    convertSubmittingRef.current = false;
    setConvertSubmitting(false);
    setTeamUsageDetailTarget(null);
    setTeamUsageByTeamId({});
    setTeamUsageLoadingByTeamId({});
    setTeamUsageErrorByTeamId({});
    setNodeAccessEditor(null);
    setNodeAccessSelection([]);
    setNodeAccessLoading(false);
    setNodeAccessSaving(false);
    setNodePanelInbounds([]);
    setNodePanelInboundsLoading(false);
    setPanelSyncQueue({ opened: false, filter: null });
    setDrawerBusy(false);
    setTeamProfileBusyKey(null);
    teamProfileBusyRef.current = null;
    setTeamMemberBusyKey(null);
    teamMemberBusyRef.current = null;
    setTeamSubscriptionBusyKey(null);
    teamSubscriptionBusyRef.current = null;
    setPolicySaving(false);
    setProbingNodeId(null);
    setProbingAll(false);
    setRefreshingNodeId(null);
    refreshingNodeRef.current = null;
  }

  function ensureAuthenticated(message: string) {
    if (!isAdminSessionExpiredMessage(message)) {
      return false;
    }
    handleSessionExpiredState();
    return true;
  }

  function mergeSnapshot(patch: Partial<AdminSnapshotDto>) {
    setSnapshot((current) => {
      const base: AdminSnapshotDto = current ?? {
        dashboard: {
          users: 0,
          teams: 0,
          activePlans: 0,
          activeSubscriptions: 0,
          activeNodes: 0,
          announcements: 0,
          openTickets: 0,
          waitingAdminTickets: 0,
          closedTickets: 0
        },
        users: [],
        plans: [],
        subscriptions: [],
        teams: [],
        nodes: [],
        panelSyncJobs: [],
        leaseRevocationJobs: [],
        announcements: [],
        policy: patch.policy as AdminPolicyRecordDto,
        releases: []
      };
      return { ...base, ...patch };
    });
  }

  async function loadInitialAdminData() {
    try {
      setLoading(true);
      setError(null);
      const [dashboard, policy] = await Promise.all([fetchAdminDashboard(), fetchAdminPolicy()]);
      mergeSnapshot({ dashboard, policy });
      setLoadedSections(new Set());
    } catch (reason) {
      const message = readError(reason, "加载失败");
      if (ensureAuthenticated(message)) {
        return;
      }

      setError(message);
    } finally {
      setLoading(false);
    }
  }

  async function loadFullSnapshot() {
    try {
      setLoading(true);
      setError(null);
      const [dashboard, policy, users, plans, subscriptions, teams, nodes, panelSyncJobs, leaseRevocationJobs, announcements] =
        await Promise.all([
        fetchAdminDashboard(),
        fetchAdminPolicy(),
        fetchAdminUsers(),
        fetchAdminPlans(),
        fetchAdminSubscriptions(),
        fetchAdminTeams(),
        fetchAdminNodes(),
        fetchAdminPanelSyncJobs(),
        fetchAdminLeaseRevocationJobs(),
        fetchAdminAnnouncements()
      ]);
      mergeSnapshot({ dashboard, policy, users, plans, subscriptions, teams, nodes, panelSyncJobs, leaseRevocationJobs, announcements });
      setLoadedSections(new Set(Object.keys(sectionMeta) as SectionKey[]));
    } catch (reason) {
      const message = readError(reason, "加载失败");
      if (ensureAuthenticated(message)) {
        return;
      }
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  async function refreshDashboard(options?: { silent?: boolean }) {
    const requestSeq = ++dashboardRefreshSeqRef.current;
    try {
      setRefreshingDashboard(true);
      const dashboard = await fetchAdminDashboard();
      if (requestSeq !== dashboardRefreshSeqRef.current) {
        return;
      }
      mergeSnapshot({ dashboard });
    } catch (reason) {
      if (options?.silent) {
        return;
      }
      throw reason;
    } finally {
      if (requestSeq === dashboardRefreshSeqRef.current) {
        setRefreshingDashboard(false);
      }
    }
  }

  function refreshCurrentSectionSilently() {
    if (sectionRef.current === "tickets") {
      setTicketRefreshSignal((current) => current + 1);
      return;
    }
    if (sectionRef.current === "imageBed") {
      setImageBedRefreshSignal((current) => current + 1);
      return;
    }
    void loadSectionData(sectionRef.current, { force: true, silent: true }).catch(() => {
      // Silent background refreshes are opportunistic; explicit actions report refresh failures separately.
    });
  }

  function refreshDashboardAfterTicketMutation() {
    void refreshDashboard({ silent: true }).catch(() => undefined);
  }

  function applyListPatch<K extends SnapshotListKey>(key: K, value: AdminSnapshotDto[K]) {
    mergeSnapshot({ [key]: value } as Pick<AdminSnapshotDto, K>);
  }

  async function loadSectionData(targetSection: SectionKey, options?: { force?: boolean; silent?: boolean }) {
    if (!options?.force && loadedSections.has(targetSection)) {
      return;
    }
    const requestSeq = sectionRequestSeqRef.current + 1;
    sectionRequestSeqRef.current = requestSeq;
    const mutationSeqAtStart = sectionMutationSeqRef.current;
    const canApplySectionResult = () =>
      sectionRequestSeqRef.current === requestSeq && sectionMutationSeqRef.current === mutationSeqAtStart;
    try {
      if (!options?.silent) {
        setSectionLoading(true);
      }
      if (targetSection === "overview") {
        const [subscriptions, nodes] = await Promise.all([fetchAdminSubscriptions(), fetchAdminNodes()]);
        if (!canApplySectionResult()) return;
        mergeSnapshot({ subscriptions, nodes });
      } else if (targetSection === "users") {
        const [users, teams, leaseRevocationJobs] = await Promise.all([
          fetchAdminUsers(),
          fetchAdminTeams(),
          fetchAdminLeaseRevocationJobs()
        ]);
        if (!canApplySectionResult()) return;
        mergeSnapshot({ users, teams, leaseRevocationJobs });
      } else if (targetSection === "plans") {
        const plans = await fetchAdminPlans();
        if (!canApplySectionResult()) return;
        applyListPatch("plans", plans);
      } else if (targetSection === "subscriptions") {
        const [users, plans, subscriptions, teams, leaseRevocationJobs] = await Promise.all([
          fetchAdminUsers(),
          fetchAdminPlans(),
          fetchAdminSubscriptions(),
          fetchAdminTeams(),
          fetchAdminLeaseRevocationJobs()
        ]);
        if (!canApplySectionResult()) return;
        mergeSnapshot({ users, plans, subscriptions, teams, leaseRevocationJobs });
      } else if (targetSection === "nodes") {
        const [nodes, panelSyncJobs, leaseRevocationJobs] = await Promise.all([
          fetchAdminNodes(),
          fetchAdminPanelSyncJobs(),
          fetchAdminLeaseRevocationJobs()
        ]);
        if (!canApplySectionResult()) return;
        mergeSnapshot({ nodes, panelSyncJobs, leaseRevocationJobs });
      } else if (targetSection === "announcements") {
        const announcements = await fetchAdminAnnouncements();
        if (!canApplySectionResult()) return;
        applyListPatch("announcements", announcements);
      } else if (targetSection === "policies") {
        const policy = await fetchAdminPolicy();
        if (!canApplySectionResult()) return;
        mergeSnapshot({ policy });
      }
      setLoadedSections((current) => new Set(current).add(targetSection));
    } catch (reason) {
      const message = readError(reason, "加载失败");
      if (ensureAuthenticated(message)) {
        return;
      }
      if (!options?.silent) {
        notifications.show({
          color: "red",
          title: "加载失败",
          message
        });
      }
      if (options?.silent) {
        throw reason;
      }
    } finally {
      if (!options?.silent && sectionRequestSeqRef.current === requestSeq) {
        setSectionLoading(false);
      }
    }
  }

  async function refreshCurrentDataAfterAction() {
    await Promise.all([
      refreshDashboard(),
      loadSectionData(section, { force: true, silent: true })
    ]);
  }

  async function refreshPanelSyncJobsAfterPending() {
    const [panelSyncJobs, leaseRevocationJobs, nodes] = await Promise.all([
      fetchAdminPanelSyncJobs(),
      fetchAdminLeaseRevocationJobs(),
      fetchAdminNodes()
    ]);
    mergeSnapshot({ panelSyncJobs, leaseRevocationJobs, nodes });
  }

  function refreshAdminNodesAfterPanelSyncRetry() {
    void fetchAdminNodes()
      .then((nodes) => {
        mergeSnapshot({ nodes });
      })
      .catch((reason) => {
        notifications.show({
          color: "yellow",
          title: "重试已提交，节点列表刷新失败",
          message: readError(reason, "节点列表刷新失败，请稍后手动刷新确认")
        });
      });
  }

  async function handleHeaderRefresh() {
    await loadFullSnapshot();
    if (sectionRef.current === "releases") {
      setReleaseRefreshSignal((current) => current + 1);
    } else if (sectionRef.current === "tickets") {
      setTicketRefreshSignal((current) => current + 1);
    } else if (sectionRef.current === "runtimeComponents") {
      setRuntimeComponentRefreshSignal((current) => current + 1);
    } else if (sectionRef.current === "imageBed") {
      setImageBedRefreshSignal((current) => current + 1);
    }
  }

  async function handleRetryPanelSyncJob(jobId: string) {
    const busyKey = `job:${jobId}`;
    if (panelSyncRetryBusyRef.current) {
      return;
    }
    try {
      panelSyncRetryBusyRef.current = true;
      setPanelSyncRetryBusyKey(busyKey);
      const panelSyncJobs = await retryAdminPanelSyncJob(jobId);
      mergeSnapshot({ panelSyncJobs });
      refreshAdminNodesAfterPanelSyncRetry();
      notifications.show({
        color: "green",
        title: "已重新排队",
        message: "面板同步任务已加入最近重试队列"
      });
    } catch (reason) {
      const retryMessage = readError(reason, "同步任务重新排队失败");
      const retryUncertain = isPotentiallyCompletedMutationFailure(retryMessage);
      if (retryUncertain) {
        void refreshPanelSyncJobsAfterPending().catch(() => undefined);
      }
      notifications.show({
        color: retryUncertain ? "yellow" : "red",
        title: retryUncertain ? "重试状态不确定" : "重试失败",
        message: retryUncertain ? `${retryMessage} 请求可能已提交，请刷新同步队列确认。` : retryMessage
      });
    } finally {
      setPanelSyncRetryBusyKey(null);
      panelSyncRetryBusyRef.current = false;
    }
  }

  async function handleRetryNodePanelSyncJobs(nodeId: string) {
    const busyKey = `node:${nodeId}`;
    if (panelSyncRetryBusyRef.current) {
      return;
    }
    try {
      panelSyncRetryBusyRef.current = true;
      setPanelSyncRetryBusyKey(busyKey);
      const panelSyncJobs = await retryAdminPanelSyncJobsForNode(nodeId);
      mergeSnapshot({ panelSyncJobs });
      refreshAdminNodesAfterPanelSyncRetry();
      notifications.show({
        color: "green",
        title: "已重新排队",
        message: "该节点的面板同步任务已加入最近重试队列"
      });
    } catch (reason) {
      const retryMessage = readError(reason, "节点同步任务重新排队失败");
      const retryUncertain = isPotentiallyCompletedMutationFailure(retryMessage);
      if (retryUncertain) {
        void refreshPanelSyncJobsAfterPending().catch(() => undefined);
      }
      notifications.show({
        color: retryUncertain ? "yellow" : "red",
        title: retryUncertain ? "重试状态不确定" : "重试失败",
        message: retryUncertain ? `${retryMessage} 请求可能已提交，请刷新同步队列确认。` : retryMessage
      });
    } finally {
      setPanelSyncRetryBusyKey(null);
      panelSyncRetryBusyRef.current = false;
    }
  }

  async function handleRetryLeaseRevocationJob(jobId: string) {
    const busyKey = `lease-job:${jobId}`;
    if (leaseRevocationRetryBusyRef.current) {
      return;
    }
    try {
      leaseRevocationRetryBusyRef.current = true;
      setLeaseRevocationRetryBusyKey(busyKey);
      const leaseRevocationJobs = await retryAdminLeaseRevocationJob(jobId);
      mergeSnapshot({ leaseRevocationJobs });
      notifications.show({
        color: "green",
        title: "已重新排队",
        message: "连接撤销任务已加入最近重试队列"
      });
    } catch (reason) {
      const retryMessage = readError(reason, "连接撤销任务重新排队失败");
      const retryUncertain = isPotentiallyCompletedMutationFailure(retryMessage);
      if (retryUncertain) {
        void refreshPanelSyncJobsAfterPending().catch(() => undefined);
      }
      notifications.show({
        color: retryUncertain ? "yellow" : "red",
        title: retryUncertain ? "重试状态不确定" : "重试失败",
        message: retryUncertain ? `${retryMessage} 请求可能已提交，请刷新同步队列确认。` : retryMessage
      });
    } finally {
      setLeaseRevocationRetryBusyKey(null);
      leaseRevocationRetryBusyRef.current = false;
    }
  }

  async function handleRetryNodeLeaseRevocationJobs(nodeId: string) {
    const busyKey = `lease-node:${nodeId}`;
    if (leaseRevocationRetryBusyRef.current) {
      return;
    }
    try {
      leaseRevocationRetryBusyRef.current = true;
      setLeaseRevocationRetryBusyKey(busyKey);
      const leaseRevocationJobs = await retryAdminLeaseRevocationJobsForNode(nodeId);
      mergeSnapshot({ leaseRevocationJobs });
      notifications.show({
        color: "green",
        title: "已重新排队",
        message: "该节点的连接撤销任务已加入最近重试队列"
      });
    } catch (reason) {
      const retryMessage = readError(reason, "节点连接撤销任务重新排队失败");
      const retryUncertain = isPotentiallyCompletedMutationFailure(retryMessage);
      if (retryUncertain) {
        void refreshPanelSyncJobsAfterPending().catch(() => undefined);
      }
      notifications.show({
        color: retryUncertain ? "yellow" : "red",
        title: retryUncertain ? "重试状态不确定" : "重试失败",
        message: retryUncertain ? `${retryMessage} 请求可能已提交，请刷新同步队列确认。` : retryMessage
      });
    } finally {
      setLeaseRevocationRetryBusyKey(null);
      leaseRevocationRetryBusyRef.current = false;
    }
  }

  async function handleLoadNodePanelInbounds(form: NodeFormState = nodeForm, options: { automatic?: boolean } = {}) {
    if (!form.panelBaseUrl || !form.panelUsername || !form.panelPassword) {
      notifications.show({
        title: "缺少面板信息",
        message: "请先填写面板地址、账号和密码",
        color: "yellow"
      });
      return;
    }

    try {
      setNodePanelInboundsLoading(true);
      const result = await fetchNodePanelInbounds({
        panelBaseUrl: form.panelBaseUrl,
        panelApiBasePath: form.panelApiBasePath || "/",
        panelUsername: form.panelUsername,
        panelPassword: form.panelPassword
      });
      setNodePanelInbounds(result);

      if (result.length > 0) {
        const hasCurrent = result.some((item) => item.id === form.panelInboundId);
        if (!hasCurrent) {
          setNodeForm((current) => ({ ...current, panelInboundId: result[0].id }));
        }
      }

      notifications.show({
        title: "读取成功",
        message: result.length > 0 ? `已获取 ${result.length} 条入站` : "面板中暂无可用入站",
        color: result.length > 0 ? "green" : "yellow"
      });
    } catch (reason) {
      const message = readError(reason, "读取 3x-ui 入站失败。该操作会直接访问面板；如果面板离线或路径错误，请先手动填写入站 ID。");
      if (ensureAuthenticated(message)) {
        return;
      }
      const definiteLocalSaveFailure = isDefiniteLocalSaveFailure(message);
      const uncertain = !definiteLocalSaveFailure && isUncertainRequestFailure(message);
      notifications.show({
        title: options.automatic || uncertain ? "面板入站暂不可用" : "读取失败",
        message:
          options.automatic || uncertain
            ? `${message} 这不会影响保存已有节点配置，可手动填写入站 ID。`
            : message,
        color: options.automatic || uncertain ? "yellow" : "red"
      });
      setNodePanelInbounds([]);
    } finally {
      setNodePanelInboundsLoading(false);
    }
  }

  async function handleAdminLogin() {
    if (!authForm.account.trim() || !authForm.password.trim()) {
      setAuthError("请输入管理员账号和密码");
      return;
    }

    try {
      setAuthSubmitting(true);
      setAuthError(null);
      const session = await loginAdmin(authForm.account.trim(), authForm.password);
      if (session.user.role !== "admin") {
        throw new Error("当前账号没有后台权限");
      }
      persistAdminSession(session);
      setAuthenticated(true);
      setError(null);
      setAuthForm((current) => ({ ...current, password: "" }));
    } catch (reason) {
      setAuthError(readError(reason, "登录失败"));
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function handleAdminLogout() {
    try {
      await logoutAdminSession();
    } catch {
      // ignore
    } finally {
      clearAdminSession();
      setSnapshot(null);
      setAuthenticated(false);
      setAuthError(null);
      setError(null);
    }
  }

  function openAdminSecurityModal() {
    const adminProfile = getAdminProfile();
    setAdminSecurityForm({
      email: adminProfile?.email ?? "",
      currentPassword: "",
      newPassword: "",
      confirmPassword: ""
    });
    setAdminSecurityOpened(true);
  }

  function closeAdminSecurityModal() {
    if (adminSecuritySaving) return;
    setAdminSecurityOpened(false);
    setAdminSecurityForm({
      email: "",
      currentPassword: "",
      newPassword: "",
      confirmPassword: ""
    });
  }

  async function saveAdminSecurity() {
    if (adminSecuritySavingRef.current) {
      return;
    }
    const email = adminSecurityForm.email.trim();
    const newPassword = adminSecurityForm.newPassword.trim();
    if (!email || !adminSecurityForm.currentPassword.trim()) {
      notifications.show({
        color: "red",
        title: "账号安全",
        message: "请输入管理员账号和当前密码"
      });
      return;
    }
    if (newPassword && newPassword !== adminSecurityForm.confirmPassword.trim()) {
      notifications.show({
        color: "red",
        title: "账号安全",
        message: "两次输入的新密码不一致"
      });
      return;
    }
    if (newPassword && newPassword.length < 8) {
      notifications.show({
        color: "red",
        title: "账号安全",
        message: "新密码至少 8 位"
      });
      return;
    }

    try {
      adminSecuritySavingRef.current = true;
      setAdminSecuritySaving(true);
      const session = await updateCurrentAdminSecurity({
        email,
        currentPassword: adminSecurityForm.currentPassword,
        ...(newPassword ? { newPassword } : {})
      });
      if (requiresAdminSessionRefresh(session)) {
        clearAdminSession();
        setAuthenticated(false);
        setAuthError(null);
        setAuthForm({ account: email, password: "" });
        setAdminSecurityOpened(false);
        setAdminSecurityForm({
          email: "",
          currentPassword: "",
          newPassword: "",
          confirmPassword: ""
        });
        notifications.show({
          color: "yellow",
          title: "账号安全",
          message: session.message || "管理员安全设置已保存，请重新登录。"
        });
        return;
      }
      persistAdminSession(session);
      setAuthForm({ account: email, password: "" });
      setAdminSecurityOpened(false);
      setAdminSecurityForm({
        email: "",
        currentPassword: "",
        newPassword: "",
        confirmPassword: ""
      });
      try {
        await loadFullSnapshot();
      } catch (refreshReason) {
        notifications.show({
          color: "yellow",
          title: "账号已更新，但列表刷新失败",
          message: `${readError(refreshReason, "后台数据刷新失败")} 账号安全保存请求已经成功返回，可手动刷新确认。`
        });
      }
      notifications.show({
        color: "green",
        title: "账号安全",
        message: "管理员账号安全信息已更新"
      });
    } catch (reason) {
      const message = readError(reason, "更新管理员账号失败");
      const definiteLocalSaveFailure = isDefiniteLocalSaveFailure(message);
      const completedAfterFailure = isLikelySavedAfterFailure(message);
      const uncertain = !definiteLocalSaveFailure && (isUncertainRequestFailure(message) || completedAfterFailure);
      if (uncertain) {
        void loadFullSnapshot().catch(() => undefined);
      }
      notifications.show({
        color: uncertain ? "yellow" : "red",
        title: uncertain ? "账号安全状态不确定" : "账号安全",
        message: uncertain
          ? completedAfterFailure
            ? `${message} 管理员账号安全信息可能已保存，请刷新后台确认。`
            : buildUncertainMutationMessage("账号安全")
          : message
      });
    } finally {
      adminSecuritySavingRef.current = false;
      setAdminSecuritySaving(false);
    }
  }

  async function runAction(
    action: () => Promise<unknown>,
    successText: string,
    options: {
      successTitle?: string;
      failureTitle?: string;
      failureFallback?: string;
      uncertainMessage?: (message: string) => string;
      refreshAfter?: boolean;
      treatUncertainAsCompleted?: boolean;
      resolveSuccess?: (result: unknown) => { color?: "green" | "yellow"; title?: string; message?: string } | null;
    } = {}
  ) {
    sectionMutationSeqRef.current += 1;
    try {
      setError(null);
      const result = await action();
      const resolvedMessage = extractActionMessage(result, successText);
      const panelSyncPending = hasPendingPanelSync(result);
      const successOverride = options.resolveSuccess?.(result) ?? null;
      notifications.show({
        color: panelSyncPending ? "yellow" : successOverride?.color ?? "green",
        title: panelSyncPending ? "已保存，后台同步待处理" : successOverride?.title ?? options.successTitle ?? "操作成功",
        message: successOverride?.message ?? resolvedMessage
      });
      if (options.refreshAfter ?? true) void refreshCurrentDataAfterAction().catch((refreshReason) => {
        notifications.show({
          color: "yellow",
          title: "操作已完成，但刷新失败",
          message: readError(refreshReason, "刷新最新数据失败")
        });
      });
      if (panelSyncPending) {
        void refreshPanelSyncJobsAfterPending().catch((refreshReason) => {
          notifications.show({
            color: "yellow",
            title: "面板同步队列刷新失败",
            message: readError(refreshReason, "同步队列刷新失败")
          });
        });
      }
      return true;
    } catch (reason) {
      const message = readError(reason, options.failureFallback ?? "操作失败");
      if (ensureAuthenticated(message)) {
        return false;
      }
      const definiteLocalSaveFailure = isDefiniteLocalSaveFailure(message);
      const completedAfterFailure = isLikelySavedAfterFailure(message);
      const uncertain = !definiteLocalSaveFailure && (isUncertainRequestFailure(message) || completedAfterFailure);
      const savedPendingSync = uncertain && completedAfterFailure;
      if (uncertain && (options.refreshAfter ?? true)) {
        void refreshCurrentDataAfterAction().catch((refreshReason) => {
          notifications.show({
            color: "yellow",
            title: savedPendingSync ? "已保存，后台同步待处理" : "请求状态不确定",
            message: readError(refreshReason, "状态刷新失败")
          });
        });
        void refreshPanelSyncJobsAfterPending().catch((refreshReason) => {
          notifications.show({
            color: "yellow",
            title: "同步队列刷新失败",
            message: readError(refreshReason, "同步队列刷新失败")
          });
        });
      }
      notifications.show({
        color: uncertain ? "yellow" : "red",
        title: uncertain ? (savedPendingSync ? "已保存，后台同步待处理" : "请求状态不确定") : options.failureTitle ?? "操作失败",
        message: uncertain
          ? options.uncertainMessage?.(message) ?? buildUncertainMutationMessage("操作", message)
          : message
      });
      return Boolean(uncertain && options.treatUncertainAsCompleted && completedAfterFailure);
    }
  }

  const dbFirstMutationOptions = {
    treatUncertainAsCompleted: true,
    uncertainMessage: (message: string) => buildUncertainMutationMessage("操作", message)
  } as const;

  async function openNodeAccessEditor(subscriptionId: string, ownerLabel: string) {
    const requestSeq = nodeAccessRequestSeqRef.current + 1;
    nodeAccessRequestSeqRef.current = requestSeq;
    try {
      setNodeAccessLoading(true);
      const result = await getSubscriptionNodeAccess(subscriptionId);
      if (nodeAccessRequestSeqRef.current !== requestSeq) {
        return;
      }
      setNodeAccessSelection(result.nodeIds);
      setNodeAccessEditor({ subscriptionId, ownerLabel });
    } catch (reason) {
      const message = readError(reason, "加载节点授权失败");
      if (ensureAuthenticated(message)) {
        return;
      }
      const uncertain = isUncertainRequestFailure(message);
      notifications.show({
        color: uncertain ? "yellow" : "red",
        title: uncertain ? "节点授权加载状态不确定" : "节点授权加载失败",
        message: uncertain ? `${message} 未进入编辑状态，请刷新后重试。` : `${message} 未修改节点授权，请稍后重试。`
      });
    } finally {
      if (nodeAccessRequestSeqRef.current === requestSeq) {
        setNodeAccessLoading(false);
      }
    }
  }

  function closeNodeAccessEditor() {
    nodeAccessRequestSeqRef.current += 1;
    setNodeAccessEditor(null);
    setNodeAccessSelection([]);
    setNodeAccessLoading(false);
    nodeAccessSavingRef.current = false;
    setNodeAccessSaving(false);
  }

  async function saveNodeAccessEditor() {
    if (!nodeAccessEditor || nodeAccessLoading || nodeAccessSaving || nodeAccessSavingRef.current) {
      return;
    }

    nodeAccessSavingRef.current = true;
    try {
      setNodeAccessSaving(true);
      const nodeIds = Array.from(
        new Set(nodeAccessSelection.map((nodeId) => nodeId.trim()).filter((nodeId) => nodeId.length > 0))
      );
      if (nodeIds.length > MAX_NODE_ACCESS_SELECTION) {
        notifications.show({
          color: "yellow",
          title: "节点授权数量过多",
          message: `单次最多保存 ${MAX_NODE_ACCESS_SELECTION} 个节点，请减少选择后再保存。`
        });
        return;
      }
      const result = await updateSubscriptionNodeAccess(nodeAccessEditor.subscriptionId, {
        nodeIds
      });
      const panelSyncPending = result.panelSyncStatus === "pending";
      notifications.show({
        color: panelSyncPending ? "yellow" : "green",
        title: panelSyncPending ? "已保存，后台同步待处理" : "操作成功",
        message:
          summarizeAdminDiagnosticMessage(result.message, "节点授权已保存，后台同步待处理。") ??
          summarizeAdminDiagnosticMessage(result.panelSyncMessage, "节点授权已保存，后台同步待处理。") ??
          "节点授权已保存"
      });
      closeNodeAccessEditor();
      void refreshCurrentDataAfterAction().catch((refreshReason) => {
        notifications.show({
          color: "yellow",
          title: "节点授权已保存，但列表刷新失败",
          message: `${readError(refreshReason, "刷新最新数据失败")} 本次保存请求已经成功返回，可手动刷新订阅列表和同步队列确认最新状态。`
        });
      });
      if (panelSyncPending) {
        void refreshPanelSyncJobsAfterPending().catch((refreshReason) => {
          notifications.show({
            color: "yellow",
            title: "面板同步队列刷新失败",
            message: readError(refreshReason, "同步队列刷新失败")
          });
        });
      }
    } catch (reason) {
      const message = readError(reason, "保存节点授权失败");
      if (ensureAuthenticated(message)) {
        return;
      }
      const definiteLocalSaveFailure = isDefiniteLocalSaveFailure(message);
      const completedAfterFailure = isLikelySavedAfterFailure(message);
      const uncertain = !definiteLocalSaveFailure && (isUncertainRequestFailure(message) || completedAfterFailure);
      const savedPendingSync = uncertain && completedAfterFailure;
      if (uncertain) {
        if (completedAfterFailure) {
          closeNodeAccessEditor();
        }
        void refreshCurrentDataAfterAction().catch((refreshReason) => {
          notifications.show({
            color: "yellow",
            title: savedPendingSync ? "节点授权已保存，后台同步待处理" : "节点授权状态不确定",
            message: readError(refreshReason, "节点授权状态刷新失败")
          });
        });
        void refreshPanelSyncJobsAfterPending().catch((refreshReason) => {
          notifications.show({
            color: "yellow",
            title: "同步队列刷新失败",
            message: readError(refreshReason, "同步队列刷新失败")
          });
        });
      }
      notifications.show({
        color: uncertain ? "yellow" : "red",
        title: uncertain ? (savedPendingSync ? "节点授权已保存，后台同步待处理" : "节点授权状态不确定") : "操作失败",
        message: uncertain ? buildUncertainMutationMessage("节点授权", message) : message
      });
    } finally {
      nodeAccessSavingRef.current = false;
      setNodeAccessSaving(false);
    }
  }

  function openDrawer(type: DrawerType, recordId: string | null = null, parentId: string | null = null) {
    if (!snapshot) return;

    if (type === "user") {
      if (recordId) {
        const record = snapshot.users.find((item) => item.id === recordId);
        if (!record) return;
        setUserForm({
          email: record.email,
          password: "",
          displayName: record.displayName,
          role: record.role,
          status: record.status,
          maxConcurrentSessionsOverride: record.maxConcurrentSessionsOverride ?? ""
        });
      } else {
        setUserForm(emptyUserForm());
      }
    }

    if (type === "plan") {
      if (recordId) {
        const record = snapshot.plans.find((item) => item.id === recordId);
        if (!record) return;
        setPlanForm({
          name: record.name,
          scope: record.scope,
          totalTrafficGb: record.totalTrafficGb,
          renewable: record.renewable,
          maxConcurrentSessions: record.maxConcurrentSessions,
          isActive: record.isActive
        });
      } else {
        setPlanForm({
          ...emptyPlanForm(),
          scope: planScopeTab
        });
      }
    }

    if (type === "subscription-create") {
      setSubscriptionCreateForm(emptySubscriptionCreateForm(snapshot));
    }

    if (type === "subscription-adjust" && recordId) {
      const record = snapshot.subscriptions.find((item) => item.id === recordId);
      if (!record) return;
      setSubscriptionAdjustForm({
        totalTrafficGb: record.totalTrafficGb,
        usedTrafficGb: record.usedTrafficGb,
        expireAt: toDateTimeLocal(record.expireAt),
        baseExpireAt: toDateTimeLocal(record.expireAt),
        state: record.state
      });
    }

    if (type === "subscription-renew" && recordId) {
      const record = snapshot.subscriptions.find((item) => item.id === recordId);
      if (!record) return;
      if (!record.renewable) {
        notifications.show({
          color: "yellow",
          title: "当前套餐不支持续期",
          message: getRenewActionDescription(false)
        });
        return;
      }
      setSubscriptionRenewForm({
        expireAt: toDateTimeLocal(record.expireAt),
        baseExpireAt: toDateTimeLocal(record.expireAt),
        resetTraffic: false,
        totalTrafficGb: ""
      });
    }

    if (type === "subscription-change-plan" && recordId) {
      const record = snapshot.subscriptions.find((item) => item.id === recordId);
      if (!record) return;
      const targetPlan = snapshot.plans.find((item) => item.id === record.planId);
      setSubscriptionChangePlanForm({
        scope: targetPlan?.scope ?? "personal",
        planId: record.planId,
        totalTrafficGb: record.totalTrafficGb,
        expireAt: toDateTimeLocal(record.expireAt),
        baseExpireAt: toDateTimeLocal(record.expireAt)
      });
    }

    if (type === "team") {
      if (recordId) {
        const record = snapshot.teams.find((item) => item.id === recordId);
        if (!record) return;
        setTeamForm({
          name: record.name,
          ownerUserId: record.ownerUserId,
          status: record.status
        });
      } else {
        setTeamForm(emptyTeamForm(snapshot));
      }
    }

    if (type === "team-member") {
      if (recordId && parentId) {
        const team = snapshot.teams.find((item) => item.id === parentId);
        const record = team?.members.find((item) => item.id === recordId);
        if (!record) return;
        setTeamMemberForm({
          userId: record.userId,
          role: record.role
        });
      } else {
        setTeamMemberForm(emptyTeamMemberForm());
      }
    }

    if (type === "team-subscription") {
      const team = snapshot.teams.find((item) => item.id === parentId);
      const defaultPlan = snapshot.plans.find((item) => item.isActive && item.scope === "team") ?? snapshot.plans.find((item) => item.scope === "team");
      setTeamSubscriptionForm({
        planId: defaultPlan?.id ?? "",
        totalTrafficGb: defaultPlan?.totalTrafficGb ?? 100,
        expireAt: toDateTimeLocal(team?.currentSubscription?.expireAt ?? addDays(new Date(), 30).toISOString())
      });
    }

    if (type === "node") {
      if (recordId) {
        const record = snapshot.nodes.find((item) => item.id === recordId);
        if (!record) return;
        const nextForm = {
          subscriptionUrl: record.subscriptionUrl ?? "",
          name: record.name,
          countryCode: record.countryCode ?? resolveCountryCode({ region: record.region }) ?? "",
          region: record.region,
          provider: record.provider,
          tags: record.tags.join(", "),
          isActive: record.isActive ?? true,
          recommended: record.recommended,
          panelBaseUrl: record.panelBaseUrl ?? "",
          panelApiBasePath: record.panelApiBasePath ?? "/",
          panelUsername: record.panelUsername ?? "",
          panelPassword: record.panelPassword ?? "",
          panelInboundId: record.panelInboundId ?? 1,
          panelEnabled: record.panelEnabled
        };
        setNodePanelInbounds([]);
        setNodeForm(nextForm);
        if (nextForm.panelBaseUrl && nextForm.panelUsername && nextForm.panelPassword) {
          void handleLoadNodePanelInbounds(nextForm, { automatic: true });
        }
      } else {
        setNodePanelInbounds([]);
        setNodeForm({
          ...emptyNodeForm(),
          isActive: true,
          panelEnabled: true
        });
      }
    }

    if (type === "announcement") {
      if (recordId) {
        const record = snapshot.announcements.find((item) => item.id === recordId);
        if (!record) return;
        setAnnouncementForm({
          title: record.title,
          body: record.body,
          level: record.level,
          publishedAt: toDateTimeLocal(record.publishedAt),
          isActive: record.isActive,
          displayMode: record.displayMode,
          countdownSeconds: record.countdownSeconds
        });
      } else {
        setAnnouncementForm(emptyAnnouncementForm());
      }
    }

    setDrawer({ type, recordId, parentId });
  }

  function closeDrawer() {
    if (drawerBusyRef.current) {
      return;
    }
    forceCloseDrawer();
  }

  function forceCloseDrawer() {
    setDrawer({ type: null, recordId: null, parentId: null });
  }

  async function submitDrawer() {
    if (!drawer.type || !snapshot) return;
    if (drawerBusyRef.current) {
      return;
    }

    drawerBusyRef.current = true;
    try {
      setDrawerBusy(true);

      if (drawer.type === "user") {
        const payload = {
          displayName: userForm.displayName,
          role: userForm.role,
          status: userForm.status,
          maxConcurrentSessionsOverride:
            userForm.maxConcurrentSessionsOverride === "" ? null : Number(userForm.maxConcurrentSessionsOverride),
          ...(userForm.password ? { password: userForm.password } : {})
        } satisfies UpdateUserInputDto;

        const success = drawer.recordId
          ? await runAction(() => updateUser(drawer.recordId!, payload), "用户已更新", dbFirstMutationOptions)
          : await runAction(
              () =>
                createUser({
                  email: userForm.email,
                  password: userForm.password,
                  displayName: userForm.displayName,
                  role: userForm.role,
                  maxConcurrentSessionsOverride:
                    userForm.maxConcurrentSessionsOverride === "" ? null : Number(userForm.maxConcurrentSessionsOverride)
                } satisfies CreateUserInputDto),
              "用户已创建",
              dbFirstMutationOptions
            );

        if (success) forceCloseDrawer();
      }

      if (drawer.type === "plan") {
        const payload = {
          name: planForm.name,
          scope: planForm.scope,
          totalTrafficGb: planForm.totalTrafficGb,
          renewable: planForm.renewable,
          maxConcurrentSessions: planForm.maxConcurrentSessions,
          isActive: planForm.isActive
        };
        const success = drawer.recordId
          ? await runAction(() => updatePlan(drawer.recordId!, payload satisfies UpdatePlanInputDto), "套餐已更新", dbFirstMutationOptions)
          : await runAction(() => createPlan(payload satisfies CreatePlanInputDto), "套餐已创建", dbFirstMutationOptions);
        if (success) forceCloseDrawer();
      }

      if (drawer.type === "subscription-create") {
        const success = await runAction(
          () =>
            createSubscription({
              userId: subscriptionCreateForm.userId,
              planId: subscriptionCreateForm.planId,
              totalTrafficGb: subscriptionCreateForm.totalTrafficGb,
              usedTrafficGb: subscriptionCreateForm.usedTrafficGb,
              expireAt: fromDateTimeLocal(subscriptionCreateForm.expireAt) ?? new Date().toISOString(),
              state: subscriptionCreateForm.state
            } satisfies CreateSubscriptionInputDto),
          "订阅已创建",
          dbFirstMutationOptions
        );
        if (success) forceCloseDrawer();
      }

      if (drawer.type === "subscription-adjust" && drawer.recordId) {
        const success = await runAction(
          () =>
            updateSubscription(drawer.recordId!, {
              totalTrafficGb: subscriptionAdjustForm.totalTrafficGb,
              usedTrafficGb: subscriptionAdjustForm.usedTrafficGb,
              expireAt: fromDateTimeLocal(subscriptionAdjustForm.expireAt),
              state: subscriptionAdjustForm.state
            } satisfies UpdateSubscriptionInputDto),
          "订阅已校正",
          dbFirstMutationOptions
        );
        if (success) forceCloseDrawer();
      }

      if (drawer.type === "subscription-renew" && drawer.recordId) {
        const success = await runAction(
          () =>
            renewSubscription(drawer.recordId!, {
              expireAt: fromDateTimeLocal(subscriptionRenewForm.expireAt),
              resetTraffic: subscriptionRenewForm.resetTraffic,
              totalTrafficGb:
                subscriptionRenewForm.totalTrafficGb === "" ? undefined : Number(subscriptionRenewForm.totalTrafficGb)
            } satisfies RenewSubscriptionInputDto),
          "订阅已续期",
          dbFirstMutationOptions
        );
        if (success) forceCloseDrawer();
      }

      if (drawer.type === "subscription-change-plan" && drawer.recordId) {
        const success = await runAction(
          () =>
            changeSubscriptionPlan(drawer.recordId!, {
              planId: subscriptionChangePlanForm.planId,
              totalTrafficGb: subscriptionChangePlanForm.totalTrafficGb,
              expireAt: fromDateTimeLocal(subscriptionChangePlanForm.expireAt)
            } satisfies ChangeSubscriptionPlanInputDto),
          "套餐已变更",
          dbFirstMutationOptions
        );
        if (success) forceCloseDrawer();
      }

      if (drawer.type === "team") {
        const payload = {
          name: teamForm.name,
          ownerUserId: teamForm.ownerUserId,
          status: teamForm.status
        };
        const success = drawer.recordId
          ? await runAction(() => updateTeam(drawer.recordId!, payload satisfies UpdateTeamInputDto), "团队已更新", dbFirstMutationOptions)
          : await runAction(() => createTeam(payload satisfies CreateTeamInputDto), "团队已创建", dbFirstMutationOptions);
        if (success) forceCloseDrawer();
      }

      if (drawer.type === "team-member" && drawer.parentId) {
        const payload = {
          userId: teamMemberForm.userId,
          role: teamMemberForm.role
        };
        const success = drawer.recordId
          ? await runAction(
              () => updateTeamMember(drawer.parentId!, drawer.recordId!, { role: teamMemberForm.role } satisfies UpdateTeamMemberInputDto),
              "成员已更新",
              dbFirstMutationOptions
            )
          : await runAction(
              () => createTeamMember(drawer.parentId!, payload satisfies CreateTeamMemberInputDto),
              "成员已加入",
              dbFirstMutationOptions
            );
        if (success) forceCloseDrawer();
      }

      if (drawer.type === "team-subscription" && drawer.parentId) {
        const success = await runAction(
          () =>
            createTeamSubscription(drawer.parentId!, {
              planId: teamSubscriptionForm.planId,
              totalTrafficGb: teamSubscriptionForm.totalTrafficGb,
              expireAt: fromDateTimeLocal(teamSubscriptionForm.expireAt) ?? new Date().toISOString()
            } satisfies CreateTeamSubscriptionInputDto),
          "团队套餐已分配",
          dbFirstMutationOptions
        );
        if (success) forceCloseDrawer();
      }

      if (drawer.type === "node") {
        if (
          nodeForm.panelEnabled &&
          (!nodeForm.panelBaseUrl.trim() ||
            !nodeForm.panelUsername.trim() ||
            !nodeForm.panelPassword.trim() ||
            !Number.isFinite(Number(nodeForm.panelInboundId)) ||
            Number(nodeForm.panelInboundId) <= 0)
        ) {
          notifications.show({
            color: "yellow",
            title: "面板信息不完整",
            message: "启用 3x-ui 面板时必须填写面板地址、账号、密码，并先选择有效入站。"
          });
          return;
        }

        const updatePayload = {
          subscriptionUrl: undefined,
          name: nodeForm.name || undefined,
          countryCode: nodeForm.countryCode || undefined,
          region: nodeForm.region || undefined,
          provider: nodeForm.provider || undefined,
          tags: splitCsv(nodeForm.tags),
          isActive: nodeForm.isActive,
          recommended: nodeForm.recommended,
          panelBaseUrl: nodeForm.panelBaseUrl || null,
          panelApiBasePath: nodeForm.panelApiBasePath || null,
          panelUsername: nodeForm.panelUsername || null,
          panelPassword: nodeForm.panelPassword || null,
          panelInboundId: Number(nodeForm.panelInboundId) || null,
          panelEnabled: nodeForm.panelEnabled
        };
        const importPayload = {
          ...updatePayload,
          panelBaseUrl: updatePayload.panelBaseUrl ?? undefined,
          panelApiBasePath: updatePayload.panelApiBasePath ?? undefined,
          panelUsername: updatePayload.panelUsername ?? undefined,
          panelPassword: updatePayload.panelPassword ?? undefined,
          panelInboundId: updatePayload.panelInboundId ?? undefined
        };
        const success = drawer.recordId
          ? await runAction(
              () =>
                updateNode(drawer.recordId!, {
                  subscriptionUrl: updatePayload.subscriptionUrl || undefined,
                  name: updatePayload.name,
                  countryCode: updatePayload.countryCode,
                  region: updatePayload.region,
                  provider: updatePayload.provider,
                  tags: updatePayload.tags,
                  isActive: updatePayload.isActive,
                  recommended: updatePayload.recommended,
                  panelBaseUrl: updatePayload.panelBaseUrl,
                  panelApiBasePath: updatePayload.panelApiBasePath,
                  panelUsername: updatePayload.panelUsername,
                  panelPassword: updatePayload.panelPassword,
                  panelInboundId: updatePayload.panelInboundId,
                  panelEnabled: updatePayload.panelEnabled
                } satisfies UpdateNodeInputDto),
              "节点已更新",
              dbFirstMutationOptions
            )
          : await runAction(() => importNode(importPayload satisfies ImportNodeInputDto), "节点已添加", {
              failureTitle: "新增节点失败，未保存",
              failureFallback:
                "新增节点需要先读取可用运行参数。请填写有效订阅地址，或修复 3x-ui 面板连接并选择入站后重试。",
              ...dbFirstMutationOptions
            });
        if (success) forceCloseDrawer();
      }

      if (drawer.type === "announcement") {
        const payload = {
          title: announcementForm.title,
          body: announcementForm.body,
          level: announcementForm.level,
          publishedAt: fromDateTimeLocal(announcementForm.publishedAt),
          isActive: announcementForm.isActive,
          displayMode: announcementForm.displayMode,
          countdownSeconds: announcementForm.countdownSeconds
        };
        const success = drawer.recordId
          ? await runAction(
              () => updateAnnouncement(drawer.recordId!, payload satisfies UpdateAnnouncementInputDto),
              "公告已更新",
              dbFirstMutationOptions
            )
          : await runAction(() => createAnnouncement(payload satisfies CreateAnnouncementInputDto), "公告已创建", dbFirstMutationOptions);
        if (success) closeDrawer();
      }
    } finally {
      drawerBusyRef.current = false;
      setDrawerBusy(false);
    }
  }

  async function handleProbeNode(nodeId: string) {
    if (probingBusyRef.current) {
      return;
    }
    probingBusyRef.current = true;
    try {
      setProbingNodeId(nodeId);
      await runAction(() => probeNode(nodeId), "节点探测已完成", {
        successTitle: "探测完成",
        failureTitle: "探测失败",
        failureFallback: "节点网络探测失败",
        uncertainMessage: (message) => `${message} 节点探测状态不确定，请刷新节点列表确认最新探测结果。`,
        resolveSuccess: (result) => {
          const node = result as AdminNodeRecordDto;
          if (node.panelStatus === "degraded") {
            return {
              color: "yellow",
              title: "探测完成，面板异常",
              message: `节点连通性已探测，但 3x-ui 面板不可达：${
                summarizeAdminDiagnosticMessage(node.panelError, "请检查面板地址、路径或账号密码。") ?? "请检查面板地址、路径或账号密码。"
              }`
            };
          }
          if (node.probeStatus !== "healthy") {
            return {
              color: "yellow",
              title: "探测完成，节点异常",
              message: summarizeAdminDiagnosticMessage(node.probeError, "节点网络探测未通过。") ?? "节点网络探测未通过。"
            };
          }
          return null;
        }
      });
    } finally {
      setProbingNodeId(null);
      probingBusyRef.current = false;
    }
  }

  async function handleProbeAllNodes() {
    if (probingBusyRef.current) {
      return;
    }
    probingBusyRef.current = true;
    try {
      setProbingAll(true);
      await runAction(() => probeAllNodes(), "全部节点探测已完成", {
        successTitle: "探测完成",
        failureTitle: "探测失败",
        failureFallback: "批量节点网络探测失败",
        uncertainMessage: (message) => `${message} 批量探测状态不确定，请刷新节点列表确认最新探测结果。`,
        resolveSuccess: (result) => {
          const nodes = Array.isArray(result) ? (result as AdminNodeRecordDto[]) : [];
          const degradedCount = nodes.filter((node) => node.panelStatus === "degraded").length;
          const failedProbeCount = nodes.filter((node) => node.probeStatus !== "healthy").length;
          if (degradedCount > 0 || failedProbeCount > 0) {
            return {
              color: "yellow",
              title: "探测完成，存在异常",
              message: `已完成 ${nodes.length} 个节点探测；面板异常 ${degradedCount} 个，节点连通异常 ${failedProbeCount} 个。`
            };
          }
          return null;
        }
      });
    } finally {
      setProbingAll(false);
      probingBusyRef.current = false;
    }
  }

  async function handleRefreshNode(nodeId: string) {
    if (refreshingNodeRef.current) {
      return;
    }
    refreshingNodeRef.current = nodeId;
    setRefreshingNodeId(nodeId);
    try {
    await runAction(() => refreshNode(nodeId), "节点已从 3x-ui 面板刷新", {
      successTitle: "读取面板成功",
      failureTitle: "读取面板失败",
      failureFallback: "读取 3x-ui 面板并刷新节点失败",
      uncertainMessage: (message) => `${message} 面板读取状态不确定，请刷新节点列表确认节点运行时是否已更新。`,
      resolveSuccess: (result) => {
        const node = result as AdminNodeRecordDto;
        if (node.panelStatus === "degraded") {
          return {
            color: "yellow",
            title: "面板读取失败，本地配置已保留",
            message: summarizeAdminDiagnosticMessage(node.panelError, "3x-ui 面板暂不可用，节点本地运行参数未被覆盖。") ?? "3x-ui 面板暂不可用，节点本地运行参数未被覆盖。"
          };
        }
        return null;
      }
    });
    } finally {
      refreshingNodeRef.current = null;
      setRefreshingNodeId(null);
    }
  }

  async function handleDeleteAnnouncement(announcementId: string) {
    const actionKey = `announcement-delete:${announcementId}`;
    if (entityActionBusyRef.current) {
      return;
    }
    entityActionBusyRef.current = actionKey;
    setEntityActionBusyKey(actionKey);
    const confirmed = window.confirm("确认删除这条公告吗？删除后软件端会立即同步移除。");
    if (!confirmed) {
      entityActionBusyRef.current = null;
      setEntityActionBusyKey(null);
      return;
    }
    try {
      await runAction(() => deleteAnnouncement(announcementId), "公告已删除", dbFirstMutationOptions);
    } finally {
      entityActionBusyRef.current = null;
      setEntityActionBusyKey(null);
    }
  }

  async function handleDeleteNode() {
    if (!deleteNodeTarget || deleteNodeSubmittingRef.current) return;
    try {
      deleteNodeSubmittingRef.current = true;
      setDeleteNodeSubmitting(true);
      const success = await runAction(() => deleteNode(deleteNodeTarget.id), "节点已停用，面板清理任务已排队", {
        ...dbFirstMutationOptions
      });
      if (success) setDeleteNodeTarget(null);
    } finally {
      setDeleteNodeSubmitting(false);
      deleteNodeSubmittingRef.current = false;
    }
  }

  async function handleDeleteTeamMember(teamId: string, memberId: string) {
    const actionKey = `team-member-delete:${memberId}`;
    if (entityActionBusyRef.current) {
      return;
    }
    entityActionBusyRef.current = actionKey;
    setEntityActionBusyKey(actionKey);
    const confirmed = window.confirm("确认移出这个团队成员吗？他的 Team 订阅访问会进入后台撤销任务。");
    if (!confirmed) {
      entityActionBusyRef.current = null;
      setEntityActionBusyKey(null);
      return;
    }

    try {
      await runAction(() => deleteTeamMember(teamId, memberId), "成员已移除", dbFirstMutationOptions);
    } finally {
      entityActionBusyRef.current = null;
      setEntityActionBusyKey(null);
    }
  }

  async function handleToggleUserStatus(
    userId: string,
    nextStatus: "active" | "disabled",
    displayName: string,
    source: "personal" | "team-member" = "personal"
  ) {
    const actionKey = `user-status:${userId}`;
    if (entityActionBusyRef.current) {
      return;
    }
    entityActionBusyRef.current = actionKey;
    setEntityActionBusyKey(actionKey);
    const teamScopeHint = source === "team-member" ? "这是账号级操作，不会移出团队关系。" : "";
    const confirmed = window.confirm(
      nextStatus === "disabled"
        ? `确认禁用 ${displayName} 的账号吗？这会立刻停止该账号的订阅连接。${teamScopeHint}`
        : `确认启用 ${displayName} 的账号吗？启用后该账号可以重新登录和连接。${teamScopeHint}`
    );
    if (!confirmed) {
      entityActionBusyRef.current = null;
      setEntityActionBusyKey(null);
      return;
    }

    try {
      await runAction(
        () => updateUser(userId, { status: nextStatus }),
        nextStatus === "disabled" ? "账号已禁用" : "账号已启用",
        dbFirstMutationOptions
      );
    } finally {
      entityActionBusyRef.current = null;
      setEntityActionBusyKey(null);
    }
  }

  async function handleDisconnectUser(
    userId: string,
    displayName: string,
    source: "personal" | "team-member" = "personal"
  ) {
    const actionKey = `user-disconnect:${userId}`;
    if (entityActionBusyRef.current) {
      return;
    }
    entityActionBusyRef.current = actionKey;
    setEntityActionBusyKey(actionKey);
    const teamScopeHint = source === "team-member" ? "这是账号级操作，不会移出团队成员。" : "";
    const confirmed = window.confirm(
      `确认提交 ${displayName} 的连接撤销任务吗？账号会保持启用，用户稍后可以重新连接。${teamScopeHint}`
    );
    if (!confirmed) {
      entityActionBusyRef.current = null;
      setEntityActionBusyKey(null);
      return;
    }

    try {
      await runAction(
        () => disconnectUser(userId),
        "账号连接撤销任务已提交",
        dbFirstMutationOptions
      );
    } finally {
      entityActionBusyRef.current = null;
      setEntityActionBusyKey(null);
    }
  }

  function openUserSubscriptions(user: AdminUserRecordDto) {
    setSubscriptionTab("personal");
    setSearch((current) => ({
      ...current,
      subscriptions: user.email || user.displayName || user.id
    }));
    selectSection("subscriptions");
  }

  function openCreateSubscriptionForUser(user: AdminUserRecordDto) {
    if (!snapshot) return;
    setSubscriptionTab("personal");
    setSearch((current) => ({
      ...current,
      subscriptions: user.email || user.displayName || user.id
    }));
    setSubscriptionCreateForm({
      ...emptySubscriptionCreateForm(snapshot),
      userId: user.id
    });
    setDrawer({ type: "subscription-create", recordId: null, parentId: null });
    selectSection("subscriptions");
  }

  function openTeamSubscriptions(team: AdminTeamRecordDto) {
    setSubscriptionTab("team");
    setSearch((current) => ({
      ...current,
      subscriptions: team.name || team.ownerEmail || team.id
    }));
    selectSection("subscriptions");
  }

  async function loadTeamUsage(teamId: string, options: { force?: boolean } = {}) {
    if (!options.force && (teamUsageByTeamId[teamId] || teamUsageLoadingByTeamId[teamId])) {
      return;
    }
    setTeamUsageLoadingByTeamId((current) => ({ ...current, [teamId]: true }));
    setTeamUsageErrorByTeamId((current) => ({ ...current, [teamId]: null }));
    try {
      const usage = await getTeamUsage(teamId);
      setTeamUsageByTeamId((current) => ({ ...current, [teamId]: usage }));
    } catch (reason) {
      const message = readError(reason, "Team 用量加载失败");
      setTeamUsageErrorByTeamId((current) => ({ ...current, [teamId]: message }));
      notifications.show({
        color: "yellow",
        title: "Team 用量加载失败",
        message
      });
    } finally {
      setTeamUsageLoadingByTeamId((current) => ({ ...current, [teamId]: false }));
    }
  }

  function openKickMemberModal(teamId: string, memberId: string, memberName: string) {
    setKickMemberTarget({ teamId, memberId, memberName });
    setKickDisableAccount(false);
  }

  function closeKickMemberModal() {
    if (kickSubmittingRef.current) return;
    setKickMemberTarget(null);
    setKickDisableAccount(false);
  }

  async function handleKickMember() {
    if (!kickMemberTarget || kickSubmittingRef.current) return;

    try {
      kickSubmittingRef.current = true;
      setKickSubmitting(true);
      const success = await runAction(
        () =>
          kickTeamMember(kickMemberTarget.teamId, kickMemberTarget.memberId, {
            disableAccount: kickDisableAccount
          }),
        kickDisableAccount ? "成员断网任务已提交，账号已禁用" : "成员断网任务已提交",
        dbFirstMutationOptions
      );
      if (success) {
        closeKickMemberModal();
      }
    } finally {
      setKickSubmitting(false);
      kickSubmittingRef.current = false;
    }
  }

  async function handleResetSubscriptionTraffic(subscriptionId: string, ownerLabel: string, userId?: string) {
    if (resetTrafficBusyRef.current) {
      return;
    }
    const targetKey = `${subscriptionId}:${userId ?? "all"}`;
    const confirmed = window.confirm(
      `确认重置 ${ownerLabel} 的流量吗？这会同步清空 3x-ui 面板计量，并重置后台本地基线。`
    );
    if (!confirmed) {
      return;
    }

    try {
      resetTrafficBusyRef.current = true;
      setResetTrafficBusyKey(targetKey);
      setTeamUsageByTeamId({});
      await runAction(() => resetSubscriptionTraffic(subscriptionId, userId), "订阅流量已重置", dbFirstMutationOptions);
    } finally {
      setResetTrafficBusyKey(null);
      resetTrafficBusyRef.current = false;
    }
  }

  function openConvertToTeamModal(record: AdminSubscriptionRecordDto) {
    if (!record.userId) {
      notifications.show({
        color: "yellow",
        title: "无法转入 Team",
        message: "当前订阅缺少用户归属信息，请先检查订阅数据。"
      });
      return;
    }

    const owner =
      record.userId && snapshot
        ? snapshot.users.find((item) => item.id === record.userId) ?? null
        : null;
    if (!owner) {
      notifications.show({
        color: "yellow",
        title: "无法转入 Team",
        message: "当前用户信息未同步，请刷新后重试。"
      });
      return;
    }
    if (owner && owner.status !== "active") {
      notifications.show({
        color: "yellow",
        title: "无法转入 Team",
        message: "该账号已禁用，不能转入 Team 共享订阅。"
      });
      return;
    }

    if (teamsWithCurrentSubscription.length === 0) {
      notifications.show({
        color: "yellow",
        title: "暂无可转入目标",
        message: "请先保证至少有一个 Team 已分配共享订阅。"
      });
      return;
    }

    setConvertSubscriptionTarget({
      subscriptionId: record.id,
      ownerLabel: record.userDisplayName ?? record.userEmail ?? "个人用户",
      ownerEmail: record.userEmail ?? "-",
      currentPlanName: record.planName
    });
    setConvertTargetTeamId(teamsWithCurrentSubscription[0]?.id ?? null);
  }

  function closeConvertToTeamModal() {
    if (convertSubmitting || convertSubmittingRef.current) return;
    forceCloseConvertToTeamModal();
  }

  function forceCloseConvertToTeamModal() {
    setConvertSubscriptionTarget(null);
    setConvertTargetTeamId(null);
  }

  async function handleConvertToTeam() {
    if (!convertSubscriptionTarget || !convertTargetTeamId || convertSubmittingRef.current) {
      return;
    }

    const selectedTeam = teamsWithCurrentSubscription.find((item) => item.id === convertTargetTeamId);
    if (!selectedTeam?.currentSubscription) {
      notifications.show({
        color: "yellow",
        title: "无法转入 Team",
        message: "目标团队当前没有可用共享订阅，请刷新后重试。"
      });
      return;
    }

    const confirmed = window.confirm(
      `确认把 ${convertSubscriptionTarget.ownerLabel} 的个人订阅转入 ${selectedTeam?.name ?? "目标团队"} 吗？当前个人订阅会被停用，并保留面板同步清理记录；原订阅剩余流量和历史不会继承到 Team。`
    );
    if (!confirmed) {
      return;
    }

    try {
      convertSubmittingRef.current = true;
      setConvertSubmitting(true);
      const success = await runAction(
        () =>
          convertPersonalSubscriptionToTeam(convertSubscriptionTarget.subscriptionId, {
            targetTeamId: convertTargetTeamId
          }),
        "订阅已转入 Team",
        dbFirstMutationOptions
      );
      if (success) {
        forceCloseConvertToTeamModal();
      }
    } finally {
      convertSubmittingRef.current = false;
      setConvertSubmitting(false);
    }
  }

  function openTeamInlineEditor(teamId: string) {
    if (!snapshot) return;
    const team = snapshot.teams.find((item) => item.id === teamId);
    if (!team) return;
    setTeamForm({
      name: team.name,
      ownerUserId: team.ownerUserId,
      status: team.status
    });
    setTeamInlineEditorId(teamId);
    setTeamMemberInlineEditor(null);
    setTeamSubscriptionInlineEditorId(null);
  }

  function closeTeamInlineEditor() {
    if (teamProfileBusyRef.current) {
      return;
    }
    forceCloseTeamInlineEditor();
  }

  function forceCloseTeamInlineEditor() {
    setTeamInlineEditorId(null);
    setTeamForm(emptyTeamForm(snapshot));
  }

  async function saveTeamInlineEditor(teamId: string) {
    if (teamProfileBusyRef.current) {
      return;
    }

    try {
      teamProfileBusyRef.current = teamId;
      setTeamProfileBusyKey(teamId);
      const success = await runAction(
        () =>
          updateTeam(teamId, {
            name: teamForm.name,
            ownerUserId: teamForm.ownerUserId,
            status: teamForm.status
          } satisfies UpdateTeamInputDto),
        "团队已更新",
        dbFirstMutationOptions
      );
      if (success) {
        forceCloseTeamInlineEditor();
      }
    } finally {
      teamProfileBusyRef.current = null;
      setTeamProfileBusyKey(null);
    }
  }

  function openTeamMemberInlineEditor(teamId: string, memberId: string | null = null) {
    if (!snapshot) return;
    if (memberId) {
      const team = snapshot.teams.find((item) => item.id === teamId);
      const member = team?.members.find((item) => item.id === memberId);
      if (!member) return;
      setTeamMemberForm({
        userId: member.userId,
        role: member.role
      });
    } else {
      setTeamMemberForm(emptyTeamMemberForm());
    }
    setTeamMemberInlineEditor({ teamId, memberId });
    setTeamInlineEditorId(null);
    setTeamSubscriptionInlineEditorId(null);
  }

  function closeTeamMemberInlineEditor() {
    if (teamMemberBusyRef.current) {
      return;
    }
    forceCloseTeamMemberInlineEditor();
  }

  function forceCloseTeamMemberInlineEditor() {
    setTeamMemberInlineEditor(null);
    setTeamMemberForm(emptyTeamMemberForm());
  }

  function openTeamSubscriptionInlineEditor(teamId: string) {
    if (!snapshot) return;
    const team = snapshot.teams.find((item) => item.id === teamId);
    const defaultPlan = snapshot.plans.find((item) => item.isActive && item.scope === "team") ?? snapshot.plans.find((item) => item.scope === "team");
    setTeamSubscriptionForm({
      planId: defaultPlan?.id ?? "",
      totalTrafficGb: defaultPlan?.totalTrafficGb ?? 100,
      expireAt: toDateTimeLocal(team?.currentSubscription?.expireAt ?? addDays(new Date(), 30).toISOString())
    });
    setTeamSubscriptionInlineEditorId(teamId);
    setTeamInlineEditorId(null);
    setTeamMemberInlineEditor(null);
  }

  function closeTeamSubscriptionInlineEditor() {
    if (teamSubscriptionBusyRef.current) {
      return;
    }
    forceCloseTeamSubscriptionInlineEditor();
  }

  function forceCloseTeamSubscriptionInlineEditor() {
    setTeamSubscriptionInlineEditorId(null);
    setTeamSubscriptionForm(emptyTeamSubscriptionForm());
  }

  async function saveTeamSubscriptionInlineEditor(teamId: string) {
    if (teamSubscriptionBusyRef.current) {
      return;
    }

    try {
      teamSubscriptionBusyRef.current = teamId;
      setTeamSubscriptionBusyKey(teamId);
      const success = await runAction(
        () =>
          createTeamSubscription(teamId, {
            planId: teamSubscriptionForm.planId,
            totalTrafficGb: teamSubscriptionForm.totalTrafficGb,
            expireAt: fromDateTimeLocal(teamSubscriptionForm.expireAt) ?? new Date().toISOString()
          } satisfies CreateTeamSubscriptionInputDto),
        "团队套餐已分配",
        dbFirstMutationOptions
      );
      if (success) {
        forceCloseTeamSubscriptionInlineEditor();
      }
    } finally {
      teamSubscriptionBusyRef.current = null;
      setTeamSubscriptionBusyKey(null);
    }
  }

  async function saveTeamMemberInlineEditor() {
    if (!teamMemberInlineEditor) return;
    const busyKey = `${teamMemberInlineEditor.teamId}:${teamMemberInlineEditor.memberId ?? "new"}`;
    if (teamMemberBusyRef.current) {
      return;
    }

    try {
      teamMemberBusyRef.current = busyKey;
      setTeamMemberBusyKey(busyKey);
      const payload = {
        userId: teamMemberForm.userId,
        role: teamMemberForm.role
      };
      const success = teamMemberInlineEditor.memberId
        ? await runAction(
            () =>
              updateTeamMember(teamMemberInlineEditor.teamId, teamMemberInlineEditor.memberId!, {
                role: teamMemberForm.role
              } satisfies UpdateTeamMemberInputDto),
            "成员已更新",
            dbFirstMutationOptions
          )
        : await runAction(
            () =>
              createTeamMember(teamMemberInlineEditor.teamId, payload satisfies CreateTeamMemberInputDto),
            "成员已加入",
            dbFirstMutationOptions
      );
      if (success) {
        forceCloseTeamMemberInlineEditor();
      }
    } finally {
      teamMemberBusyRef.current = null;
      setTeamMemberBusyKey(null);
    }
  }

  async function handleSavePolicy() {
    if (!policyForm) return;
    if (policySavingRef.current) return;

    try {
      policySavingRef.current = true;
      setPolicySaving(true);
      if (!policyForm.modes.includes(policyForm.defaultMode)) {
        notifications.show({
          color: "red",
          title: "策略配置错误",
          message: "默认模式必须包含在可用模式中"
        });
        return;
      }
      const policy = await updatePolicy({
        defaultMode: policyForm.defaultMode,
        modes: policyForm.modes,
        blockAds: policyForm.blockAds,
        chinaDirect: policyForm.chinaDirect,
        aiServicesProxy: policyForm.aiServicesProxy
      } satisfies UpdatePolicyInputDto);
      setPolicyDirty(false);
      setPolicyForm(toPolicyForm(policy));
      mergeSnapshot({ policy });
      notifications.show({
        color: "green",
        title: "操作成功",
        message: "策略已更新"
      });
    } catch (reason) {
      const message = readError(reason, "策略更新失败");
      if (ensureAuthenticated(message)) {
        return;
      }
      const definiteLocalSaveFailure = isDefiniteLocalSaveFailure(message);
      const completedAfterFailure = isLikelySavedAfterFailure(message);
      const uncertain = !definiteLocalSaveFailure && (isUncertainRequestFailure(message) || completedAfterFailure);
      if (uncertain) {
        void fetchAdminPolicy()
          .then((policy) => {
            setPolicyDirty(false);
            setPolicyForm(toPolicyForm(policy));
            mergeSnapshot({ policy });
          })
          .catch(() => undefined);
      }
      notifications.show({
        color: uncertain ? "yellow" : "red",
        title: uncertain ? "请求状态不确定" : "操作失败",
        message: uncertain
          ? completedAfterFailure
            ? `${message} 策略可能已保存，请刷新页面确认。`
            : buildUncertainMutationMessage("策略")
          : message
      });
    } finally {
      policySavingRef.current = false;
      setPolicySaving(false);
    }
  }

  if (!authenticated) {
    return (
      <AdminLoginPanel
        account={authForm.account}
        password={authForm.password}
        loading={authSubmitting}
        error={authError}
        onAccountChange={(value) => setAuthForm((current) => ({ ...current, account: value }))}
        onPasswordChange={(value) => setAuthForm((current) => ({ ...current, password: value }))}
        onSubmit={() => void handleAdminLogin()}
      />
    );
  }

  if (loading && !snapshot) {
    return (
      <Group justify="center" mt="xl">
        <Loader />
      </Group>
    );
  }

  if (!snapshot) {
    return (
      <Paper p="xl" m="xl" radius="xl" withBorder>
        <Stack>
          <Text>后台加载失败</Text>
          {error ? <Alert color="red">{error}</Alert> : null}
          <Button onClick={() => void loadInitialAdminData()} loading={loading}>
            重试
          </Button>
        </Stack>
      </Paper>
    );
  }

  const backgroundSyncQueueCount = snapshot.panelSyncJobs.length + snapshot.leaseRevocationJobs.length;
  const waitingAdminTicketCount = snapshot.dashboard.waitingAdminTickets;

  return (
    <>
      <AppShell
        className="admin-shell"
        navbar={{ width: 248, breakpoint: "sm", collapsed: { mobile: !mobileNavOpened } }}
        header={{ height: 76 }}
        padding="lg"
      >
        <AppShell.Navbar p="md" className="admin-nav">
          <Stack justify="space-between" h="100%">
            <Stack gap="xs">
              <div className="admin-brand">
                <Text size="xs" fw={700} c="blue" tt="uppercase">
                  ChordV
                </Text>
                <Title order={3}>运营后台</Title>
              </div>
              {Object.entries(sectionMeta).map(([key, item]) => (
                <NavLink
                  key={key}
                  active={section === key}
                  label={item.label}
                  description={item.description}
                  leftSection={item.icon}
                  rightSection={
                    key === "tickets" && waitingAdminTicketCount > 0 ? (
                      <Badge size="sm" color="red" variant="filled" radius="xl">
                        {waitingAdminTicketCount > 99 ? "99+" : waitingAdminTicketCount}
                      </Badge>
                    ) : undefined
                  }
                  onClick={() => selectSection(key as SectionKey)}
                  variant="filled"
                />
              ))}
            </Stack>

            <Paper withBorder radius="xl" p="md" className="admin-side-card">
              <Stack gap={4}>
                <Text size="sm" fw={600}>
                  当前接入
                </Text>
                <Text size="xl" fw={700}>
                  3x-ui 直连
                </Text>
                <Text size="sm" c="dimmed">
                  默认模式 {snapshot.policy.defaultMode === "rule" ? "规则模式" : snapshot.policy.defaultMode === "global" ? "全局代理" : "直连模式"}
                </Text>
              </Stack>
            </Paper>
          </Stack>
        </AppShell.Navbar>

        <AppShell.Header px="lg" className="admin-header">
          <Group justify="space-between" h="100%">
            <Group gap="sm" wrap="nowrap" className="admin-header-title">
              <Burger
                opened={mobileNavOpened}
                onClick={() => setMobileNavOpened((opened) => !opened)}
                hiddenFrom="sm"
                size="sm"
                aria-label="切换导航"
              />
              <div>
                <Title order={2}>{sectionMeta[section].label}</Title>
                <Text size="sm" c="dimmed">
                  {sectionMeta[section].description}
                </Text>
              </div>
            </Group>

            <Group className="admin-header-actions">
              <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={() => void handleHeaderRefresh()} loading={loading || sectionLoading || refreshingDashboard}>
                刷新
              </Button>
              <Button variant="default" leftSection={<IconListDetails size={16} />} onClick={() => openPanelSyncQueue()}>
                同步队列{backgroundSyncQueueCount > 0 ? ` · ${backgroundSyncQueueCount}` : ""}
              </Button>
              <Button variant="default" onClick={openAdminSecurityModal}>
                账号安全
              </Button>
              <Button variant="default" onClick={() => void handleAdminLogout()}>
                退出登录
              </Button>
              {section === "users" ? (
                <Group gap="xs">
                  <Button leftSection={<IconPlus size={16} />} onClick={() => openDrawer("user")}>
                    新建用户
                  </Button>
                  <Button variant="default" leftSection={<IconPlus size={16} />} onClick={() => openDrawer("team")}>
                    新建团队
                  </Button>
                </Group>
              ) : null}
              {section === "plans" ? (
                <Button leftSection={<IconPlus size={16} />} onClick={() => openDrawer("plan")}>
                  新建套餐
                </Button>
              ) : null}
              {section === "subscriptions" ? (
                <Button
                  leftSection={<IconPlus size={16} />}
                  onClick={() => openDrawer("subscription-create")}
                  disabled={eligiblePersonalUsers.length === 0}
                >
                  新建订阅
                </Button>
              ) : null}
              {section === "nodes" ? (
                <Group gap="xs">
                  <Button
                    variant="default"
                    leftSection={<IconBolt size={16} />}
                    onClick={() => void handleProbeAllNodes()}
                    loading={probingAll}
                    disabled={probingNodeId !== null}
                  >
                    全部探测
                  </Button>
                  <Button leftSection={<IconPlus size={16} />} onClick={() => openDrawer("node")}>
                    添加面板
                  </Button>
                </Group>
              ) : null}
              {section === "announcements" ? (
                <Button leftSection={<IconPlus size={16} />} onClick={() => openDrawer("announcement")}>
                  新建公告
                </Button>
              ) : null}
            </Group>
          </Group>
        </AppShell.Header>

        <AppShell.Main>
          <Stack gap="lg">
            {sectionLoading ? (
              <Alert color="blue" variant="light">
                正在加载当前模块数据
              </Alert>
            ) : null}

            {section === "overview" ? (
              <OverviewPage
                snapshot={snapshot}
                onOpenSubscriptions={() => selectSection("subscriptions")}
                onOpenNodes={() => selectSection("nodes")}
              />
            ) : null}

            {section === "users" ? (
              <UsersPage
                searchValue={search.users}
                onSearchChange={(value) => setSearch((current) => ({ ...current, users: value }))}
                userTab={userTab}
                onUserTabChange={setUserTab}
                users={users}
                filteredTeams={filteredTeams}
                allUsers={snapshot.users}
                leaseRevocationJobs={snapshot.leaseRevocationJobs}
                leaseRevocationRetryBusyKey={leaseRevocationRetryBusyKey}
                actionBusyKey={entityActionBusyKey}
                teamInlineEditorId={teamInlineEditorId}
                teamMemberInlineEditor={teamMemberInlineEditor}
                teamProfileBusyKey={teamProfileBusyKey}
                teamMemberBusyKey={teamMemberBusyKey}
                teamForm={teamForm}
                setTeamForm={setTeamForm}
                teamMemberForm={teamMemberForm}
                setTeamMemberForm={setTeamMemberForm}
                buildTeamMemberOptions={buildTeamMemberOptions}
                onOpenUserDrawer={(userId) => openDrawer("user", userId)}
                onOpenUserSubscriptions={openUserSubscriptions}
                onCreateSubscriptionForUser={openCreateSubscriptionForUser}
                onOpenTeamSubscriptions={openTeamSubscriptions}
                onOpenTeamInlineEditor={openTeamInlineEditor}
                onCloseTeamInlineEditor={closeTeamInlineEditor}
                onSaveTeamInlineEditor={(teamId) => void saveTeamInlineEditor(teamId)}
                onOpenTeamMemberInlineEditor={openTeamMemberInlineEditor}
                onCloseTeamMemberInlineEditor={closeTeamMemberInlineEditor}
                onSaveTeamMemberInlineEditor={() => void saveTeamMemberInlineEditor()}
                onDeleteTeamMember={(teamId, memberId) => void handleDeleteTeamMember(teamId, memberId)}
                onToggleUserStatus={(userId, nextStatus, displayName) =>
                  void handleToggleUserStatus(userId, nextStatus, displayName)
                }
                onToggleTeamUserStatus={(userId, nextStatus, displayName) =>
                  void handleToggleUserStatus(userId, nextStatus, displayName, "team-member")
                }
                onDisconnectUser={(userId, displayName, source) => void handleDisconnectUser(userId, displayName, source)}
                onRetryLeaseRevocationJob={(jobId) => void handleRetryLeaseRevocationJob(jobId)}
                onOpenPanelSyncQueue={openPanelSyncQueue}
              />
            ) : null}

            {section === "plans" ? (
              <PlansPage
                searchValue={search.plans}
                onSearchChange={(value) => setSearch((current) => ({ ...current, plans: value }))}
                planScopeTab={planScopeTab}
                onPlanScopeTabChange={setPlanScopeTab}
                plans={plans}
                onOpenPlanDrawer={(planId) => openDrawer("plan", planId)}
              />
            ) : null}

            {section === "subscriptions" ? (
              <SubscriptionsPage
                searchValue={search.subscriptions}
                onSearchChange={(value) => setSearch((current) => ({ ...current, subscriptions: value }))}
                subscriptionTab={subscriptionTab}
                onSubscriptionTabChange={setSubscriptionTab}
                subscriptions={subscriptions}
                filteredTeamSubscriptions={filteredTeamSubscriptions}
                allSubscriptions={allSubscriptions}
                plans={snapshot.plans}
                teamSubscriptionInlineEditorId={teamSubscriptionInlineEditorId}
                teamSubscriptionForm={teamSubscriptionForm}
                setTeamSubscriptionForm={setTeamSubscriptionForm}
                teamSubscriptionBusyKey={teamSubscriptionBusyKey}
                onOpenRenewDrawer={(subscriptionId) => openDrawer("subscription-renew", subscriptionId)}
                onOpenChangePlanDrawer={(subscriptionId) => openDrawer("subscription-change-plan", subscriptionId)}
                onOpenAdjustDrawer={(subscriptionId) => openDrawer("subscription-adjust", subscriptionId)}
                onOpenNodeAccessEditor={(subscriptionId, ownerLabel) => void openNodeAccessEditor(subscriptionId, ownerLabel)}
                onOpenConvertToTeamModal={openConvertToTeamModal}
                hasAvailableTeamTransferTarget={teamsWithCurrentSubscription.length > 0}
                onOpenTeamSubscriptionInlineEditor={openTeamSubscriptionInlineEditor}
                onCloseTeamSubscriptionInlineEditor={closeTeamSubscriptionInlineEditor}
                onSaveTeamSubscriptionInlineEditor={(teamId) => void saveTeamSubscriptionInlineEditor(teamId)}
                onResetSubscriptionTraffic={(subscriptionId, ownerLabel, userId) =>
                  void handleResetSubscriptionTraffic(subscriptionId, ownerLabel, userId)
                }
                resetTrafficBusyKey={resetTrafficBusyKey}
                allUsers={snapshot.users}
                leaseRevocationJobs={snapshot.leaseRevocationJobs}
                leaseRevocationRetryBusyKey={leaseRevocationRetryBusyKey}
                onOpenKickMemberModal={openKickMemberModal}
                onRetryLeaseRevocationJob={(jobId) => void handleRetryLeaseRevocationJob(jobId)}
                onOpenTeamUsageDetail={setTeamUsageDetailTarget}
                teamUsageByTeamId={teamUsageByTeamId}
                teamUsageLoadingByTeamId={teamUsageLoadingByTeamId}
                teamUsageErrorByTeamId={teamUsageErrorByTeamId}
                onLoadTeamUsage={(teamId, options) => void loadTeamUsage(teamId, options)}
                onOpenPanelSyncQueue={openPanelSyncQueue}
              />
            ) : null}

            {section === "tickets" ? (
              <TicketsPage refreshSignal={ticketRefreshSignal} onTicketMutated={refreshDashboardAfterTicketMutation} />
            ) : null}

            {section === "nodes" ? (
              <NodesPage
                searchValue={search.nodes}
                onSearchChange={(value) => setSearch((current) => ({ ...current, nodes: value }))}
                nodes={nodes}
                panelSyncJobs={snapshot.panelSyncJobs}
                leaseRevocationJobs={snapshot.leaseRevocationJobs}
                panelSyncQueueOpened={panelSyncQueue.opened}
                panelSyncRetryBusyKey={panelSyncRetryBusyKey}
                leaseRevocationRetryBusyKey={leaseRevocationRetryBusyKey}
                probingNodeId={probingNodeId}
                probingAll={probingAll}
                refreshingNodeId={refreshingNodeId}
                onOpenPanelSyncQueue={openPanelSyncQueue}
                onClosePanelSyncQueue={closePanelSyncQueue}
                onRetryPanelSyncJob={(jobId) => void handleRetryPanelSyncJob(jobId)}
                onRetryNodePanelSyncJobs={(nodeId) => void handleRetryNodePanelSyncJobs(nodeId)}
                onRetryLeaseRevocationJob={(jobId) => void handleRetryLeaseRevocationJob(jobId)}
                onRetryNodeLeaseRevocationJobs={(nodeId) => void handleRetryNodeLeaseRevocationJobs(nodeId)}
                onProbeNode={(nodeId) => void handleProbeNode(nodeId)}
                onRefreshNode={(nodeId) => void handleRefreshNode(nodeId)}
                onOpenNodeDrawer={(nodeId) => openDrawer("node", nodeId)}
                onDeleteNode={setDeleteNodeTarget}
              />
            ) : null}

            {section === "announcements" ? (
              <AnnouncementsPage
                searchValue={search.announcements}
                onSearchChange={(value) => setSearch((current) => ({ ...current, announcements: value }))}
                announcements={announcements}
                actionBusyKey={entityActionBusyKey}
                onOpenAnnouncementDrawer={(announcementId) => openDrawer("announcement", announcementId)}
                onDeleteAnnouncement={(announcementId) => void handleDeleteAnnouncement(announcementId)}
              />
            ) : null}

            {section === "policies" && policyForm ? (
              <PoliciesPage
                policyForm={policyForm}
                setPolicyForm={(updater) => {
                  setPolicyDirty(true);
                  setPolicyForm(updater);
                }}
                policySaving={policySaving}
                onSave={() => void handleSavePolicy()}
              />
            ) : null}

            {section === "releases" ? <ReleasesPage refreshSignal={releaseRefreshSignal} /> : null}

            {section === "runtimeComponents" ? <RuntimeComponentsPage refreshSignal={runtimeComponentRefreshSignal} /> : null}

            {section === "imageBed" ? <ImageBedPage refreshSignal={imageBedRefreshSignal} /> : null}
          </Stack>
        </AppShell.Main>
      </AppShell>

      <AdminDrawerForm
        opened={drawer.type !== null}
        title={renewActionDisabled ? `${drawerTitle(drawer.type)} · 已关闭` : drawerTitle(drawer.type)}
        drawerType={drawer.type}
        drawerRecordId={drawer.recordId}
        snapshot={snapshot}
        eligiblePersonalUsers={eligiblePersonalUsers}
        nodePanelInbounds={nodePanelInbounds}
        nodePanelInboundsLoading={nodePanelInboundsLoading}
        userForm={userForm}
        setUserForm={setUserForm}
        planForm={planForm}
        setPlanForm={setPlanForm}
        subscriptionCreateForm={subscriptionCreateForm}
        setSubscriptionCreateForm={setSubscriptionCreateForm}
        subscriptionAdjustForm={subscriptionAdjustForm}
        setSubscriptionAdjustForm={setSubscriptionAdjustForm}
        subscriptionRenewForm={subscriptionRenewForm}
        setSubscriptionRenewForm={setSubscriptionRenewForm}
        subscriptionChangePlanForm={subscriptionChangePlanForm}
        setSubscriptionChangePlanForm={setSubscriptionChangePlanForm}
        teamForm={teamForm}
        setTeamForm={setTeamForm}
        teamMemberForm={teamMemberForm}
        setTeamMemberForm={setTeamMemberForm}
        teamSubscriptionForm={teamSubscriptionForm}
        setTeamSubscriptionForm={setTeamSubscriptionForm}
        nodeForm={nodeForm}
        setNodeForm={setNodeForm}
        announcementForm={announcementForm}
        setAnnouncementForm={setAnnouncementForm}
        drawerBusy={drawerBusy}
        onClose={closeDrawer}
        onSubmit={() => {
          if (renewActionDisabled) {
            notifications.show({
              color: "yellow",
              title: "当前套餐不支持续期",
              message: getRenewActionDescription(false)
            });
            return;
          }
          void submitDrawer();
        }}
        onLoadNodePanelInbounds={() => void handleLoadNodePanelInbounds()}
      />

      <Modal opened={convertSubscriptionTarget !== null} onClose={closeConvertToTeamModal} title="转入 Team 订阅" centered size="lg">
        <Stack gap="md">
          <Alert color="blue" variant="light">
            转入后会删除当前个人订阅，用户后续改按目标团队的共享订阅规则使用服务。原个人订阅的剩余流量、到期时间和历史不会继承。
          </Alert>

          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="sm">
            <Card withBorder radius="lg" p="md">
              <Stack gap={4}>
                <Text size="sm" c="dimmed">当前个人用户</Text>
                <Text fw={600}>{convertSubscriptionTarget?.ownerLabel ?? "-"}</Text>
                <Text size="sm" c="dimmed">{convertSubscriptionTarget?.ownerEmail ?? "-"}</Text>
              </Stack>
            </Card>
            <Card withBorder radius="lg" p="md">
              <Stack gap={4}>
                <Text size="sm" c="dimmed">当前个人套餐</Text>
                <Text fw={600}>{convertSubscriptionTarget?.currentPlanName ?? "-"}</Text>
              </Stack>
            </Card>
          </SimpleGrid>

          <Select
            label="目标 Team（需已有共享订阅）"
            placeholder="请选择团队"
            value={convertTargetTeamId}
            data={convertTargetTeamOptions}
            onChange={(value) => setConvertTargetTeamId(value)}
            searchable
            nothingFoundMessage="没有可用团队"
          />

          {selectedConvertTargetTeam?.currentSubscription ? (
            <Alert color="teal" variant="light">
              目标团队当前订阅：{selectedConvertTargetTeam.currentSubscription.planName}，到期时间{" "}
              {formatDateTime(selectedConvertTargetTeam.currentSubscription.expireAt)}。
            </Alert>
          ) : (
            <Alert color="yellow" variant="light">
              当前没有可用 Team 订阅，请先给团队分配共享订阅。
            </Alert>
          )}

          <Group justify="flex-end">
            <Button variant="default" onClick={closeConvertToTeamModal} disabled={convertSubmitting}>
              取消
            </Button>
            <Button
              color="blue"
              onClick={() => void handleConvertToTeam()}
              loading={convertSubmitting}
              disabled={!convertTargetTeamId || !selectedConvertTargetTeam?.currentSubscription}
            >
              确认转入 Team
            </Button>
          </Group>
        </Stack>
      </Modal>

      <DeleteNodeModal
        target={deleteNodeTarget}
        submitting={deleteNodeSubmitting}
        onClose={() => setDeleteNodeTarget(null)}
        onConfirm={() => void handleDeleteNode()}
      />

      <KickMemberModal
        opened={kickMemberTarget !== null}
        memberName={kickMemberTarget?.memberName ?? null}
        disableAccount={kickDisableAccount}
        submitting={kickSubmitting}
        onDisableAccountChange={setKickDisableAccount}
        onClose={closeKickMemberModal}
        onConfirm={() => void handleKickMember()}
      />

      <TeamUsageDetailModal
        opened={teamUsageDetailTarget !== null}
        target={teamUsageDetailTarget}
        onClose={() => setTeamUsageDetailTarget(null)}
      />

      <PanelSyncQueueDrawer
        opened={panelSyncQueue.opened}
        jobs={snapshot.panelSyncJobs}
        leaseRevocationJobs={snapshot.leaseRevocationJobs}
        panelRetryBusyKey={panelSyncRetryBusyKey}
        leaseRetryBusyKey={leaseRevocationRetryBusyKey}
        filter={panelSyncQueue.filter}
        onClose={closePanelSyncQueue}
        onShowAll={() => openPanelSyncQueue()}
        onRetryJob={(jobId) => void handleRetryPanelSyncJob(jobId)}
        onRetryNode={(nodeId) => void handleRetryNodePanelSyncJobs(nodeId)}
        onRetryLeaseJob={(jobId) => void handleRetryLeaseRevocationJob(jobId)}
        onRetryLeaseNode={(nodeId) => void handleRetryNodeLeaseRevocationJobs(nodeId)}
      />

      <NodeAccessEditorModal
        opened={nodeAccessEditor !== null}
        ownerLabel={nodeAccessEditor?.ownerLabel ?? null}
        nodeOptions={nodeOptions}
        selection={nodeAccessSelection}
        loading={nodeAccessLoading}
        saving={nodeAccessSaving}
        onSelectionChange={(value) => {
          if (!nodeAccessLoading && !nodeAccessSaving) {
            setNodeAccessSelection(value);
          }
        }}
        onSelectAll={() => {
          if (!nodeAccessLoading && !nodeAccessSaving) {
            const selectedNodeIds = nodeOptions.slice(0, MAX_NODE_ACCESS_SELECTION).map((item) => item.value);
            setNodeAccessSelection(selectedNodeIds);
            if (nodeOptions.length > MAX_NODE_ACCESS_SELECTION) {
              notifications.show({
                color: "yellow",
                title: "已选择前 100 个节点",
                message: "节点授权单次最多保存 100 个，请按需筛选后再保存。"
              });
            }
          }
        }}
        onClear={() => {
          if (!nodeAccessLoading && !nodeAccessSaving) {
            setNodeAccessSelection([]);
          }
        }}
        onClose={closeNodeAccessEditor}
        onSave={() => void saveNodeAccessEditor()}
      />

      <Modal opened={adminSecurityOpened} onClose={closeAdminSecurityModal} title="账号安全" centered size="md">
        <Stack gap="md">
          <TextInput
            label="管理员账号"
            value={adminSecurityForm.email}
            placeholder="请输入新的后台登录账号"
            autoComplete="username"
            onChange={(event) => setAdminSecurityForm((current) => ({ ...current, email: event.currentTarget.value }))}
          />
          <PasswordInput
            label="当前密码"
            value={adminSecurityForm.currentPassword}
            placeholder="用于确认本次修改"
            autoComplete="current-password"
            onChange={(event) => setAdminSecurityForm((current) => ({ ...current, currentPassword: event.currentTarget.value }))}
          />
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <PasswordInput
              label="新密码"
              value={adminSecurityForm.newPassword}
              placeholder="不修改可留空"
              autoComplete="new-password"
              onChange={(event) => setAdminSecurityForm((current) => ({ ...current, newPassword: event.currentTarget.value }))}
            />
            <PasswordInput
              label="确认新密码"
              value={adminSecurityForm.confirmPassword}
              placeholder="再次输入新密码"
              autoComplete="new-password"
              onChange={(event) => setAdminSecurityForm((current) => ({ ...current, confirmPassword: event.currentTarget.value }))}
            />
          </SimpleGrid>
          <Alert color="blue" variant="light">
            保存后会刷新后台登录态，其他已登录会话需要重新登录。
          </Alert>
          <Group justify="flex-end">
            <Button variant="default" onClick={closeAdminSecurityModal} disabled={adminSecuritySaving}>
              取消
            </Button>
            <Button onClick={() => void saveAdminSecurity()} loading={adminSecuritySaving}>
              保存修改
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

function extractActionMessage(result: unknown, fallback: string) {
  if (result && typeof result === "object" && "message" in result) {
    const message = (result as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return summarizeAdminDiagnosticMessage(message, fallback) ?? fallback;
    }
  }
  if (result && typeof result === "object" && "panelSyncMessage" in result) {
    const message = (result as { panelSyncMessage?: unknown }).panelSyncMessage;
    if (typeof message === "string" && message.trim().length > 0) {
      return summarizeAdminDiagnosticMessage(message, fallback) ?? fallback;
    }
  }
  return fallback;
}

function hasPendingPanelSync(result: unknown): boolean {
  if (!result || typeof result !== "object") {
    return false;
  }
  const record = result as Record<string, unknown>;
  if (record.panelSyncStatus === "pending") {
    return true;
  }
  return ["data", "result", "payload", "response"].some((key) => hasPendingPanelSync(record[key]));
}

function buildNodeAccessOptionLabel(node: AdminNodeRecordDto) {
  const statusParts = [
    translateNodeAccessPanelStatus(node),
    node.panelSyncPendingCount ? `待同步 ${node.panelSyncPendingCount}` : null,
    node.panelSyncRunningCount ? `同步中 ${node.panelSyncRunningCount}` : null,
    node.panelSyncFailedCount ? `失败 ${node.panelSyncFailedCount}` : null
  ].filter(Boolean);
  const statusSuffix = statusParts.length > 0 ? ` · ${statusParts.join(" / ")}` : "";
  return `${node.name} · ${node.region} · ${node.provider}${statusSuffix}`;
}

function translateNodeAccessPanelStatus(node: AdminNodeRecordDto) {
  if (!node.panelEnabled) {
    return "面板停用";
  }
  if (node.panelStatus === "offline") {
    return "离线";
  }
  if (node.panelStatus === "degraded") {
    return "异常";
  }
  return null;
}

function splitCsv(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function drawerTitle(type: DrawerType) {
  if (type === "user") return "用户";
  if (type === "plan") return "套餐";
  if (type === "subscription-create") return "新建订阅";
  if (type === "subscription-adjust") return "校正订阅";
  if (type === "subscription-renew") return "订阅续期";
  if (type === "subscription-change-plan") return "变更套餐";
  if (type === "team") return "团队";
  if (type === "team-member") return "团队成员";
  if (type === "team-subscription") return "团队套餐";
  if (type === "node") return "节点";
  if (type === "announcement") return "公告";
  return "";
}
