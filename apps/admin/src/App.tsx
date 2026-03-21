import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ActionIcon,
  Alert,
  AppShell,
  Button,
  Card,
  Group,
  Loader,
  NavLink,
  Paper,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type {
  AccessMode,
  AdminAnnouncementRecordDto,
  AdminNodeRecordDto,
  AdminNodePanelInboundDto,
  AdminPlanRecordDto,
  AdminPolicyRecordDto,
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
import {
  IconBell,
  IconBolt,
  IconLayoutDashboard,
  IconListDetails,
  IconMapPin,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconRoute,
  IconSearch,
  IconSpeakerphone,
  IconTrash,
  IconUser,
  IconUsers
} from "@tabler/icons-react";
import {
  changeSubscriptionPlan,
  createAnnouncement,
  createPlan,
  createSubscription,
  createTeam,
  createTeamMember,
  createTeamSubscription,
  createUser,
  deleteNode,
  deleteTeamMember,
  fetchNodePanelInbounds,
  getAdminSnapshot,
  getSubscriptionNodeAccess,
  importNode,
  kickTeamMember,
  probeAllNodes,
  probeNode,
  refreshNode,
  resetSubscriptionTraffic,
  renewSubscription,
  updateAnnouncement,
  updateNode,
  updatePlan,
  updatePolicy,
  updateSubscription,
  updateSubscriptionNodeAccess,
  clearAdminSession,
  getAdminRefreshToken,
  hasAdminSession,
  loginAdmin,
  logoutAdminSession,
  persistAdminSession,
  refreshAdminSession,
  updateTeam,
  updateTeamMember,
  updateUser
} from "./api/client";
import { AdminLoginPanel } from "./components/AdminLoginPanel";
import { AdminDrawerForm, type DrawerType } from "./features/editors/AdminDrawerForm";
import { DeleteNodeModal, KickMemberModal, NodeAccessEditorModal, TeamUsageDetailModal } from "./features/modals/AdminModals";
import { DataTable } from "./features/shared/DataTable";
import { SectionCard } from "./features/shared/SectionCard";
import { StatusBadge } from "./features/shared/StatusBadge";
import { AnnouncementsPage } from "./pages/AnnouncementsPage";
import { NodesPage } from "./pages/NodesPage";
import { OverviewPage } from "./pages/OverviewPage";
import { PlansPage } from "./pages/PlansPage";
import { PoliciesPage } from "./pages/PoliciesPage";
import { SubscriptionsPage } from "./pages/SubscriptionsPage";
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
  modeOptions,
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
import { filterByKeyword, readError } from "./utils/admin-filters";
import { addDays, formatDateTime, formatTrafficGb, fromDateTimeLocal, toDateTimeLocal } from "./utils/admin-format";
import {
  getRenewActionDescription,
  subscriptionStateColor,
  translateSubscriptionState
} from "./utils/admin-translate";

type SectionKey = "overview" | "users" | "plans" | "subscriptions" | "nodes" | "announcements" | "policies";
type EditorState = {
  type: DrawerType;
  recordId: string | null;
  parentId: string | null;
};

type NodeAccessEditorState = {
  subscriptionId: string;
  ownerLabel: string;
};

type AdminAuthFormState = {
  account: string;
  password: string;
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
  nodes: {
    label: "节点",
    description: "导入、刷新、探测、删除",
    icon: <IconMapPin size={18} />
  },
  announcements: {
    label: "公告",
    description: "普通公告与强提示弹窗",
    icon: <IconSpeakerphone size={18} />
  },
  policies: {
    label: "策略",
    description: "默认模式、版本和规则配置",
    icon: <IconRoute size={18} />
  }
};

export function App() {
  const [snapshot, setSnapshot] = useState<AdminSnapshotDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(() => hasAdminSession());
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authForm, setAuthForm] = useState<AdminAuthFormState>({
    account: "admin",
    password: ""
  });
  const [section, setSection] = useState<SectionKey>("overview");
  const [drawer, setDrawer] = useState<EditorState>({ type: null, recordId: null, parentId: null });
  const [drawerBusy, setDrawerBusy] = useState(false);
  const [teamInlineEditorId, setTeamInlineEditorId] = useState<string | null>(null);
  const [teamMemberInlineEditor, setTeamMemberInlineEditor] = useState<{ teamId: string; memberId: string | null } | null>(null);
  const [teamSubscriptionInlineEditorId, setTeamSubscriptionInlineEditorId] = useState<string | null>(null);
  const [teamInlineBusy, setTeamInlineBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userTab, setUserTab] = useState<"personal" | "team">("personal");
  const [planScopeTab, setPlanScopeTab] = useState<PlanScope>("personal");
  const [subscriptionTab, setSubscriptionTab] = useState<"personal" | "team">("personal");
  const [search, setSearch] = useState<Record<Exclude<SectionKey, "overview" | "policies">, string>>({
    users: "",
    plans: "",
    subscriptions: "",
    nodes: "",
    announcements: ""
  });
  const [deleteNodeTarget, setDeleteNodeTarget] = useState<AdminNodeRecordDto | null>(null);
  const [kickMemberTarget, setKickMemberTarget] = useState<{ teamId: string; memberId: string; memberName: string } | null>(null);
  const [kickDisableAccount, setKickDisableAccount] = useState(false);
  const [kickSubmitting, setKickSubmitting] = useState(false);
  const [resetTrafficBusyKey, setResetTrafficBusyKey] = useState<string | null>(null);
  const [teamUsageDetailTarget, setTeamUsageDetailTarget] = useState<{
    teamName: string;
    userDisplayName: string;
    userEmail: string;
    entry: AdminTeamUsageRecordDto;
  } | null>(null);
  const [probingNodeId, setProbingNodeId] = useState<string | null>(null);
  const [probingAll, setProbingAll] = useState(false);

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
  const [policySaving, setPolicySaving] = useState(false);
  const [nodeAccessEditor, setNodeAccessEditor] = useState<NodeAccessEditorState | null>(null);
  const [nodeAccessSelection, setNodeAccessSelection] = useState<string[]>([]);
  const [nodeAccessLoading, setNodeAccessLoading] = useState(false);
  const [nodeAccessSaving, setNodeAccessSaving] = useState(false);
  const [nodePanelInbounds, setNodePanelInbounds] = useState<AdminNodePanelInboundDto[]>([]);
  const [nodePanelInboundsLoading, setNodePanelInboundsLoading] = useState(false);

  useEffect(() => {
    if (!authenticated) {
      setSnapshot(null);
      setLoading(false);
      return;
    }
    void loadSnapshot();
  }, [authenticated]);

  useEffect(() => {
    if (snapshot) {
      setPolicyForm(toPolicyForm(snapshot.policy));
    }
  }, [snapshot]);

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
  const nodes = useMemo(
    () =>
      filterByKeyword(snapshot?.nodes ?? [], search.nodes, (item) => [
        item.name,
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
    () => (snapshot?.users ?? []).filter((item) => item.role === "user" && item.accountType === "personal" && item.currentSubscription === null),
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
        label: `${item.name} · ${item.region} · ${item.provider}`
      })),
    [snapshot?.nodes]
  );
  const currentAccessMode = policyForm?.accessMode ?? snapshot?.policy.accessMode ?? "xui";
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

  async function loadSnapshot() {
    try {
      setLoading(true);
      setError(null);
      const data = await getAdminSnapshot();
      setSnapshot(data);
    } catch (reason) {
      const message = readError(reason, "加载失败");
      if (isAccessTokenError(message) && (await tryRefreshAdminToken())) {
        try {
          const data = await getAdminSnapshot();
          setSnapshot(data);
          setError(null);
          return;
        } catch (refreshReason) {
          clearAdminSession();
          setAuthenticated(false);
          setAuthError(readError(refreshReason, "登录已失效，请重新登录"));
          return;
        }
      }

      if (isAccessTokenError(message)) {
        clearAdminSession();
        setAuthenticated(false);
        setAuthError("登录已失效，请重新登录");
        return;
      }

      setError(message);
    } finally {
      setLoading(false);
    }
  }

  async function handleLoadNodePanelInbounds(form: NodeFormState = nodeForm) {
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
      notifications.show({
        title: "读取失败",
        message: readError(reason, "读取 3x-ui 入站失败"),
        color: "red"
      });
      setNodePanelInbounds([]);
    } finally {
      setNodePanelInboundsLoading(false);
    }
  }

  async function tryRefreshAdminToken() {
    const refreshToken = getAdminRefreshToken();
    if (!refreshToken) {
      return false;
    }
    try {
      const session = await refreshAdminSession(refreshToken);
      if (session.user.role !== "admin") {
        return false;
      }
      persistAdminSession(session);
      return true;
    } catch {
      return false;
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

  async function runAction(action: () => Promise<unknown>, successText: string) {
    try {
      setError(null);
      await action();
      notifications.show({
        color: "green",
        title: "操作成功",
        message: successText
      });
      await loadSnapshot();
      return true;
    } catch (reason) {
      notifications.show({
        color: "red",
        title: "操作失败",
        message: readError(reason, "操作失败")
      });
      return false;
    }
  }

  async function openNodeAccessEditor(subscriptionId: string, ownerLabel: string) {
    try {
      setNodeAccessLoading(true);
      const result = await getSubscriptionNodeAccess(subscriptionId);
      setNodeAccessSelection(result.nodeIds);
      setNodeAccessEditor({ subscriptionId, ownerLabel });
    } catch (reason) {
      notifications.show({
        color: "red",
        title: "操作失败",
        message: readError(reason, "加载节点授权失败")
      });
    } finally {
      setNodeAccessLoading(false);
    }
  }

  function closeNodeAccessEditor() {
    setNodeAccessEditor(null);
    setNodeAccessSelection([]);
    setNodeAccessLoading(false);
    setNodeAccessSaving(false);
  }

  async function saveNodeAccessEditor() {
    if (!nodeAccessEditor) {
      return;
    }

    try {
      setNodeAccessSaving(true);
      await updateSubscriptionNodeAccess(nodeAccessEditor.subscriptionId, {
        nodeIds: nodeAccessSelection
      });
      notifications.show({
        color: "green",
        title: "操作成功",
        message: "节点授权已保存"
      });
      await loadSnapshot();
      closeNodeAccessEditor();
    } catch (reason) {
      notifications.show({
        color: "red",
        title: "操作失败",
        message: readError(reason, "保存节点授权失败")
      });
    } finally {
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
          status: record.status
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
          region: record.region,
          provider: record.provider,
          tags: record.tags.join(", "),
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
        if (currentAccessMode === "xui" && nextForm.panelBaseUrl && nextForm.panelUsername && nextForm.panelPassword) {
          void handleLoadNodePanelInbounds(nextForm);
        }
      } else {
        setNodePanelInbounds([]);
        setNodeForm({
          ...emptyNodeForm(),
          panelEnabled: currentAccessMode === "xui"
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
    setDrawer({ type: null, recordId: null, parentId: null });
  }

  async function submitDrawer() {
    if (!drawer.type || !snapshot) return;

    try {
      setDrawerBusy(true);

      if (drawer.type === "user") {
        const payload = {
          displayName: userForm.displayName,
          role: userForm.role,
          status: userForm.status,
          ...(userForm.password ? { password: userForm.password } : {})
        } satisfies UpdateUserInputDto;

        const success = drawer.recordId
          ? await runAction(() => updateUser(drawer.recordId!, payload), "用户已更新")
          : await runAction(
              () =>
                createUser({
                  email: userForm.email,
                  password: userForm.password,
                  displayName: userForm.displayName,
                  role: userForm.role
                } satisfies CreateUserInputDto),
              "用户已创建"
            );

        if (success) closeDrawer();
      }

      if (drawer.type === "plan") {
        const payload = {
          name: planForm.name,
          scope: planForm.scope,
          totalTrafficGb: planForm.totalTrafficGb,
          renewable: planForm.renewable,
          isActive: planForm.isActive
        };
        const success = drawer.recordId
          ? await runAction(() => updatePlan(drawer.recordId!, payload satisfies UpdatePlanInputDto), "套餐已更新")
          : await runAction(() => createPlan(payload satisfies CreatePlanInputDto), "套餐已创建");
        if (success) closeDrawer();
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
          "订阅已创建"
        );
        if (success) closeDrawer();
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
          "订阅已校正"
        );
        if (success) closeDrawer();
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
          "订阅已续期"
        );
        if (success) closeDrawer();
      }

      if (drawer.type === "subscription-change-plan" && drawer.recordId) {
        const success = await runAction(
          () =>
            changeSubscriptionPlan(drawer.recordId!, {
              planId: subscriptionChangePlanForm.planId,
              totalTrafficGb: subscriptionChangePlanForm.totalTrafficGb,
              expireAt: fromDateTimeLocal(subscriptionChangePlanForm.expireAt)
            } satisfies ChangeSubscriptionPlanInputDto),
          "套餐已变更"
        );
        if (success) closeDrawer();
      }

      if (drawer.type === "team") {
        const payload = {
          name: teamForm.name,
          ownerUserId: teamForm.ownerUserId,
          status: teamForm.status
        };
        const success = drawer.recordId
          ? await runAction(() => updateTeam(drawer.recordId!, payload satisfies UpdateTeamInputDto), "团队已更新")
          : await runAction(() => createTeam(payload satisfies CreateTeamInputDto), "团队已创建");
        if (success) closeDrawer();
      }

      if (drawer.type === "team-member" && drawer.parentId) {
        const payload = {
          userId: teamMemberForm.userId,
          role: teamMemberForm.role
        };
        const success = drawer.recordId
          ? await runAction(
              () => updateTeamMember(drawer.parentId!, drawer.recordId!, { role: teamMemberForm.role } satisfies UpdateTeamMemberInputDto),
              "成员已更新"
            )
          : await runAction(
              () => createTeamMember(drawer.parentId!, payload satisfies CreateTeamMemberInputDto),
              "成员已加入"
            );
        if (success) closeDrawer();
      }

      if (drawer.type === "team-subscription" && drawer.parentId) {
        const success = await runAction(
          () =>
            createTeamSubscription(drawer.parentId!, {
              planId: teamSubscriptionForm.planId,
              totalTrafficGb: teamSubscriptionForm.totalTrafficGb,
              expireAt: fromDateTimeLocal(teamSubscriptionForm.expireAt) ?? new Date().toISOString()
            } satisfies CreateTeamSubscriptionInputDto),
          "团队套餐已分配"
        );
        if (success) closeDrawer();
      }

      if (drawer.type === "node") {
        const isXuiMode = currentAccessMode === "xui";
        const payload = {
          subscriptionUrl: isXuiMode ? undefined : nodeForm.subscriptionUrl,
          name: nodeForm.name || undefined,
          region: nodeForm.region || undefined,
          provider: nodeForm.provider || undefined,
          tags: splitCsv(nodeForm.tags),
          recommended: nodeForm.recommended,
          panelBaseUrl: nodeForm.panelBaseUrl || undefined,
          panelApiBasePath: nodeForm.panelApiBasePath || undefined,
          panelUsername: nodeForm.panelUsername || undefined,
          panelPassword: nodeForm.panelPassword || undefined,
          panelInboundId: Number(nodeForm.panelInboundId) || undefined,
          panelEnabled: nodeForm.panelEnabled
        };
        const success = drawer.recordId
          ? await runAction(
              () =>
                updateNode(drawer.recordId!, {
                  subscriptionUrl: payload.subscriptionUrl || undefined,
                  name: payload.name,
                  region: payload.region,
                  provider: payload.provider,
                  tags: payload.tags,
                  recommended: payload.recommended,
                  panelBaseUrl: payload.panelBaseUrl,
                  panelApiBasePath: payload.panelApiBasePath,
                  panelUsername: payload.panelUsername,
                  panelPassword: payload.panelPassword,
                  panelInboundId: payload.panelInboundId,
                  panelEnabled: payload.panelEnabled
                } satisfies UpdateNodeInputDto),
              "节点已更新"
            )
          : await runAction(() => importNode(payload satisfies ImportNodeInputDto), "节点已导入");
        if (success) closeDrawer();
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
              "公告已更新"
            )
          : await runAction(() => createAnnouncement(payload satisfies CreateAnnouncementInputDto), "公告已创建");
        if (success) closeDrawer();
      }
    } finally {
      setDrawerBusy(false);
    }
  }

  async function handleProbeNode(nodeId: string) {
    try {
      setProbingNodeId(nodeId);
      await runAction(() => probeNode(nodeId), "节点已探测");
    } finally {
      setProbingNodeId(null);
    }
  }

  async function handleProbeAllNodes() {
    try {
      setProbingAll(true);
      await runAction(() => probeAllNodes(), "全部节点已探测");
    } finally {
      setProbingAll(false);
    }
  }

  async function handleRefreshNode(nodeId: string) {
    await runAction(() => refreshNode(nodeId), "节点已刷新");
  }

  async function handleDeleteNode() {
    if (!deleteNodeTarget) return;
    const success = await runAction(() => deleteNode(deleteNodeTarget.id), "节点已删除");
    if (success) setDeleteNodeTarget(null);
  }

  async function handleDeleteTeamMember(teamId: string, memberId: string) {
    await runAction(() => deleteTeamMember(teamId, memberId), "成员已移除");
  }

  function openKickMemberModal(teamId: string, memberId: string, memberName: string) {
    setKickMemberTarget({ teamId, memberId, memberName });
    setKickDisableAccount(false);
  }

  function closeKickMemberModal() {
    if (kickSubmitting) return;
    setKickMemberTarget(null);
    setKickDisableAccount(false);
  }

  async function handleKickMember() {
    if (!kickMemberTarget) return;

    try {
      setKickSubmitting(true);
      const success = await runAction(
        () =>
          kickTeamMember(kickMemberTarget.teamId, kickMemberTarget.memberId, {
            disableAccount: kickDisableAccount
          }),
        kickDisableAccount ? "成员已立即断网并禁用账号" : "成员已立即断网"
      );
      if (success) {
        closeKickMemberModal();
      }
    } finally {
      setKickSubmitting(false);
    }
  }

  async function handleResetSubscriptionTraffic(subscriptionId: string, ownerLabel: string, userId?: string) {
    const targetKey = `${subscriptionId}:${userId ?? "all"}`;
    const confirmed = window.confirm(
      `确认重置 ${ownerLabel} 的流量吗？这会同步清空 3x-ui 面板计量，并重置后台本地基线。`
    );
    if (!confirmed) {
      return;
    }

    try {
      setResetTrafficBusyKey(targetKey);
      await runAction(() => resetSubscriptionTraffic(subscriptionId, userId), "订阅流量已重置");
    } finally {
      setResetTrafficBusyKey(null);
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
    setTeamInlineEditorId(null);
    setTeamForm(emptyTeamForm(snapshot));
  }

  async function saveTeamInlineEditor(teamId: string) {
    try {
      setTeamInlineBusy(true);
      const success = await runAction(
        () =>
          updateTeam(teamId, {
            name: teamForm.name,
            ownerUserId: teamForm.ownerUserId,
            status: teamForm.status
          } satisfies UpdateTeamInputDto),
        "团队已更新"
      );
      if (success) {
        closeTeamInlineEditor();
      }
    } finally {
      setTeamInlineBusy(false);
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
    setTeamSubscriptionInlineEditorId(null);
    setTeamSubscriptionForm(emptyTeamSubscriptionForm());
  }

  async function saveTeamSubscriptionInlineEditor(teamId: string) {
    try {
      setTeamInlineBusy(true);
      const success = await runAction(
        () =>
          createTeamSubscription(teamId, {
            planId: teamSubscriptionForm.planId,
            totalTrafficGb: teamSubscriptionForm.totalTrafficGb,
            expireAt: fromDateTimeLocal(teamSubscriptionForm.expireAt) ?? new Date().toISOString()
          } satisfies CreateTeamSubscriptionInputDto),
        "团队套餐已分配"
      );
      if (success) {
        closeTeamSubscriptionInlineEditor();
      }
    } finally {
      setTeamInlineBusy(false);
    }
  }

  async function saveTeamMemberInlineEditor() {
    if (!teamMemberInlineEditor) return;

    try {
      setTeamInlineBusy(true);
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
            "成员已更新"
          )
        : await runAction(
            () =>
              createTeamMember(teamMemberInlineEditor.teamId, payload satisfies CreateTeamMemberInputDto),
            "成员已加入"
          );
      if (success) {
        closeTeamMemberInlineEditor();
      }
    } finally {
      setTeamInlineBusy(false);
    }
  }

  async function handleSavePolicy() {
    if (!policyForm) return;

    try {
      setPolicySaving(true);
      const success = await runAction(
        () =>
          updatePolicy({
            accessMode: policyForm.accessMode,
            defaultMode: policyForm.defaultMode,
            modes: policyForm.modes,
            blockAds: policyForm.blockAds,
            chinaDirect: policyForm.chinaDirect,
            aiServicesProxy: policyForm.aiServicesProxy,
            currentVersion: policyForm.currentVersion,
            minimumVersion: policyForm.minimumVersion,
            forceUpgrade: policyForm.forceUpgrade,
            changelog: splitLines(policyForm.changelog),
            downloadUrl: policyForm.downloadUrl || null
          } satisfies UpdatePolicyInputDto),
        "策略已更新"
      );
      if (success) closeDrawer();
    } finally {
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
          <Button onClick={() => void loadSnapshot()} loading={loading}>
            重试
          </Button>
        </Stack>
      </Paper>
    );
  }

  return (
    <>
      <AppShell
        className="admin-shell"
        navbar={{ width: 248, breakpoint: "sm" }}
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
                  onClick={() => setSection(key as SectionKey)}
                  variant="filled"
                />
              ))}
            </Stack>

            <Paper withBorder radius="xl" p="md" className="admin-side-card">
              <Stack gap={4}>
                <Text size="sm" fw={600}>
                  远程版本
                </Text>
                <Text size="xl" fw={700}>
                  {snapshot.policy.currentVersion}
                </Text>
                <Text size="sm" c="dimmed">
                  最低版本 {snapshot.policy.minimumVersion}
                </Text>
              </Stack>
            </Paper>
          </Stack>
        </AppShell.Navbar>

        <AppShell.Header px="lg" className="admin-header">
          <Group justify="space-between" h="100%">
            <div>
              <Title order={2}>{sectionMeta[section].label}</Title>
              <Text size="sm" c="dimmed">
                {sectionMeta[section].description}
              </Text>
            </div>

            <Group>
              <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={() => void loadSnapshot()} loading={loading}>
                刷新
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
                  <Button variant="default" leftSection={<IconBolt size={16} />} onClick={() => void handleProbeAllNodes()} loading={probingAll}>
                    全部探测
                  </Button>
                  <Button leftSection={<IconPlus size={16} />} onClick={() => openDrawer("node")}>
                    导入节点
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
            {section === "overview" ? (
              <OverviewPage
                snapshot={snapshot}
                onOpenSubscriptions={() => setSection("subscriptions")}
                onOpenNodes={() => setSection("nodes")}
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
                teamInlineEditorId={teamInlineEditorId}
                teamMemberInlineEditor={teamMemberInlineEditor}
                teamInlineBusy={teamInlineBusy}
                teamForm={teamForm}
                setTeamForm={setTeamForm}
                teamMemberForm={teamMemberForm}
                setTeamMemberForm={setTeamMemberForm}
                buildTeamMemberOptions={buildTeamMemberOptions}
                onOpenUserDrawer={(userId) => openDrawer("user", userId)}
                onOpenTeamInlineEditor={openTeamInlineEditor}
                onCloseTeamInlineEditor={closeTeamInlineEditor}
                onSaveTeamInlineEditor={(teamId) => void saveTeamInlineEditor(teamId)}
                onOpenTeamMemberInlineEditor={openTeamMemberInlineEditor}
                onCloseTeamMemberInlineEditor={closeTeamMemberInlineEditor}
                onSaveTeamMemberInlineEditor={() => void saveTeamMemberInlineEditor()}
                onDeleteTeamMember={(teamId, memberId) => void handleDeleteTeamMember(teamId, memberId)}
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
                teamInlineBusy={teamInlineBusy}
                onOpenRenewDrawer={(subscriptionId) => openDrawer("subscription-renew", subscriptionId)}
                onOpenChangePlanDrawer={(subscriptionId) => openDrawer("subscription-change-plan", subscriptionId)}
                onOpenAdjustDrawer={(subscriptionId) => openDrawer("subscription-adjust", subscriptionId)}
                onOpenNodeAccessEditor={(subscriptionId, ownerLabel) => void openNodeAccessEditor(subscriptionId, ownerLabel)}
                onOpenTeamSubscriptionInlineEditor={openTeamSubscriptionInlineEditor}
                onCloseTeamSubscriptionInlineEditor={closeTeamSubscriptionInlineEditor}
                onSaveTeamSubscriptionInlineEditor={(teamId) => void saveTeamSubscriptionInlineEditor(teamId)}
                onResetSubscriptionTraffic={(subscriptionId, ownerLabel, userId) =>
                  void handleResetSubscriptionTraffic(subscriptionId, ownerLabel, userId)
                }
                resetTrafficBusyKey={resetTrafficBusyKey}
                allUsers={snapshot.users.map((item) => ({ id: item.id, status: item.status }))}
                onOpenKickMemberModal={openKickMemberModal}
                onOpenTeamUsageDetail={setTeamUsageDetailTarget}
              />
            ) : null}

            {section === "nodes" ? (
              <NodesPage
                searchValue={search.nodes}
                onSearchChange={(value) => setSearch((current) => ({ ...current, nodes: value }))}
                nodes={nodes}
                currentAccessMode={currentAccessMode}
                probingNodeId={probingNodeId}
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
                onOpenAnnouncementDrawer={(announcementId) => openDrawer("announcement", announcementId)}
              />
            ) : null}

            {section === "policies" && policyForm ? (
              <PoliciesPage
                policyForm={policyForm}
                setPolicyForm={setPolicyForm}
                policySaving={policySaving}
                onSave={() => void handleSavePolicy()}
              />
            ) : null}
          </Stack>
        </AppShell.Main>
      </AppShell>

      <AdminDrawerForm
        opened={drawer.type !== null}
        title={renewActionDisabled ? `${drawerTitle(drawer.type)} · 已关闭` : drawerTitle(drawer.type)}
        drawerType={drawer.type}
        drawerRecordId={drawer.recordId}
        snapshot={snapshot}
        currentAccessMode={currentAccessMode}
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

      <DeleteNodeModal target={deleteNodeTarget} onClose={() => setDeleteNodeTarget(null)} onConfirm={() => void handleDeleteNode()} />

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

      <NodeAccessEditorModal
        opened={nodeAccessEditor !== null}
        ownerLabel={nodeAccessEditor?.ownerLabel ?? null}
        nodeOptions={nodeOptions}
        selection={nodeAccessSelection}
        loading={nodeAccessLoading}
        saving={nodeAccessSaving}
        onSelectionChange={setNodeAccessSelection}
        onSelectAll={() => setNodeAccessSelection(nodeOptions.map((item) => item.value))}
        onClear={() => setNodeAccessSelection([])}
        onClose={closeNodeAccessEditor}
        onSave={() => void saveNodeAccessEditor()}
      />
    </>
  );
}

function isAccessTokenError(message: string) {
  return message.includes("缺少访问令牌") || message.includes("访问令牌无效") || message.includes("登录态已失效");
}

function splitCsv(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitLines(value: string) {
  return value
    .split(/\r?\n/)
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
