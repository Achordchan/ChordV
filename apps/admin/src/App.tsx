import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Accordion,
  ActionIcon,
  Alert,
  AppShell,
  Badge,
  Button,
  Card,
  Checkbox,
  Drawer,
  Group,
  Loader,
  Modal,
  MultiSelect,
  NavLink,
  NumberInput,
  Paper,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Textarea,
  ThemeIcon,
  Title
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type {
  AccessMode,
  AdminAnnouncementRecordDto,
  AdminNodeRecordDto,
  AdminPlanRecordDto,
  AdminPolicyRecordDto,
  AdminSnapshotDto,
  AdminSubscriptionRecordDto,
  AdminTeamRecordDto,
  AdminUserRecordDto,
  AnnouncementDisplayMode,
  AnnouncementLevel,
  ChangeSubscriptionPlanInputDto,
  ConnectionMode,
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
  SubscriptionState,
  TeamMemberRole,
  TeamStatus,
  UpdateAnnouncementInputDto,
  UpdateNodeInputDto,
  UpdatePlanInputDto,
  UpdatePolicyInputDto,
  UpdateSubscriptionInputDto,
  UpdateTeamInputDto,
  UpdateTeamMemberInputDto,
  UpdateUserInputDto,
  UserRole,
  UserStatus
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
  getAdminSnapshot,
  getSubscriptionNodeAccess,
  importNode,
  probeAllNodes,
  probeNode,
  refreshNode,
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

type SectionKey = "overview" | "users" | "plans" | "subscriptions" | "nodes" | "announcements" | "policies";
type DrawerType =
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

type EditorState = {
  type: DrawerType;
  recordId: string | null;
  parentId: string | null;
};

type UserFormState = {
  email: string;
  password: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
};

type PlanFormState = {
  name: string;
  scope: PlanScope;
  totalTrafficGb: number;
  renewable: boolean;
  isActive: boolean;
};

type SubscriptionCreateFormState = {
  userId: string;
  planId: string;
  totalTrafficGb: number;
  usedTrafficGb: number;
  expireAt: string;
  state: SubscriptionState;
  renewable: boolean;
};

type SubscriptionAdjustFormState = {
  totalTrafficGb: number;
  usedTrafficGb: number;
  expireAt: string;
  state: SubscriptionState;
  renewable: boolean;
};

type SubscriptionRenewFormState = {
  expireAt: string;
  extendDays: number;
  resetTraffic: boolean;
  totalTrafficGb: number | "";
};

type SubscriptionChangePlanFormState = {
  planId: string;
  totalTrafficGb: number;
  expireAt: string;
  renewable: boolean;
};

type TeamFormState = {
  name: string;
  ownerUserId: string;
  status: TeamStatus;
};

type TeamMemberFormState = {
  userId: string;
  role: TeamMemberRole;
};

type TeamSubscriptionFormState = {
  planId: string;
  totalTrafficGb: number;
  expireAt: string;
  renewable: boolean;
};

type NodeAccessEditorState = {
  subscriptionId: string;
  ownerLabel: string;
};

type NodeFormState = {
  subscriptionUrl: string;
  name: string;
  region: string;
  provider: string;
  tags: string;
  recommended: boolean;
  panelBaseUrl: string;
  panelApiBasePath: string;
  panelUsername: string;
  panelPassword: string;
  panelInboundId: number;
  panelEnabled: boolean;
};

type AnnouncementFormState = {
  title: string;
  body: string;
  level: AnnouncementLevel;
  publishedAt: string;
  isActive: boolean;
  displayMode: AnnouncementDisplayMode;
  countdownSeconds: number;
};

type PolicyFormState = {
  accessMode: AccessMode;
  defaultMode: ConnectionMode;
  modes: ConnectionMode[];
  blockAds: boolean;
  chinaDirect: boolean;
  aiServicesProxy: boolean;
  currentVersion: string;
  minimumVersion: string;
  forceUpgrade: boolean;
  changelog: string;
  downloadUrl: string;
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
    description: "账号、角色和当前套餐",
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
        item.currentSubscription?.planName ?? "",
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
  const nodeOptions = useMemo(
    () =>
      (snapshot?.nodes ?? []).map((item) => ({
        value: item.id,
        label: `${item.name} · ${item.region} · ${item.provider}`
      })),
    [snapshot?.nodes]
  );
  const currentAccessMode = policyForm?.accessMode ?? snapshot?.policy.accessMode ?? "xui";

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
        state: record.state,
        renewable: record.renewable
      });
    }

    if (type === "subscription-renew" && recordId) {
      const record = snapshot.subscriptions.find((item) => item.id === recordId);
      if (!record) return;
      setSubscriptionRenewForm({
        expireAt: toDateTimeLocal(record.expireAt),
        extendDays: 30,
        resetTraffic: false,
        totalTrafficGb: ""
      });
    }

    if (type === "subscription-change-plan" && recordId) {
      const record = snapshot.subscriptions.find((item) => item.id === recordId);
      if (!record) return;
      setSubscriptionChangePlanForm({
        planId: record.planId,
        totalTrafficGb: record.totalTrafficGb,
        expireAt: "",
        renewable: record.renewable
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
        expireAt: toDateTimeLocal(team?.currentSubscription?.expireAt ?? addDays(new Date(), 30).toISOString()),
        renewable: defaultPlan?.renewable ?? true
      });
    }

    if (type === "node") {
      if (recordId) {
        const record = snapshot.nodes.find((item) => item.id === recordId);
        if (!record) return;
        setNodeForm({
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
        });
      } else {
        setNodeForm(emptyNodeForm());
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
              state: subscriptionCreateForm.state,
              renewable: subscriptionCreateForm.renewable
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
              state: subscriptionAdjustForm.state,
              renewable: subscriptionAdjustForm.renewable
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
              extendDays: subscriptionRenewForm.extendDays || undefined,
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
              expireAt: subscriptionChangePlanForm.expireAt ? fromDateTimeLocal(subscriptionChangePlanForm.expireAt) : undefined,
              renewable: subscriptionChangePlanForm.renewable
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
              expireAt: fromDateTimeLocal(teamSubscriptionForm.expireAt) ?? new Date().toISOString(),
              renewable: teamSubscriptionForm.renewable
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
              <>
                <SimpleGrid cols={{ base: 1, sm: 2, xl: 5 }}>
                  <MetricCard label="用户数" value={snapshot.dashboard.users} icon={<IconUsers size={18} />} />
                  <MetricCard label="团队数" value={snapshot.teams.length} icon={<IconUsers size={18} />} />
                  <MetricCard label="有效套餐" value={snapshot.dashboard.activePlans} icon={<IconListDetails size={18} />} />
                  <MetricCard label="有效订阅" value={snapshot.dashboard.activeSubscriptions} icon={<IconUser size={18} />} />
                  <MetricCard label="节点数" value={snapshot.dashboard.activeNodes} icon={<IconMapPin size={18} />} />
                  <MetricCard label="在线公告" value={snapshot.dashboard.announcements} icon={<IconBell size={18} />} />
                </SimpleGrid>

                <SimpleGrid cols={{ base: 1, xl: 2 }}>
                  <Card withBorder radius="xl" p="lg">
                    <Stack gap="md">
                      <Group justify="space-between">
                        <Title order={4}>当前订阅</Title>
                        <Button size="xs" variant="subtle" onClick={() => setSection("subscriptions")}>
                          查看全部
                        </Button>
                      </Group>
                      <CompactSubscriptionList items={snapshot.subscriptions.slice(0, 6)} />
                    </Stack>
                  </Card>
                  <Card withBorder radius="xl" p="lg">
                    <Stack gap="md">
                      <Group justify="space-between">
                        <Title order={4}>节点状态</Title>
                        <Button size="xs" variant="subtle" onClick={() => setSection("nodes")}>
                          查看全部
                        </Button>
                      </Group>
                      <CompactNodeList items={snapshot.nodes.slice(0, 6)} />
                    </Stack>
                  </Card>
                </SimpleGrid>
              </>
            ) : null}

            {section === "users" ? (
              <Stack gap="lg">
                <SectionCard searchValue={search.users} onSearchChange={(value) => setSearch((current) => ({ ...current, users: value }))}>
                  <Tabs value={userTab} onChange={(value) => setUserTab((value as "personal" | "team") || "personal")}>
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
                            <Table.Th>当前套餐</Table.Th>
                            <Table.Th>操作</Table.Th>
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {users.filter((item) => item.accountType === "personal").map((item) => (
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
                                {item.currentSubscription ? (
                                  <Stack gap={0}>
                                    <Text>{item.currentSubscription.planName}</Text>
                                    <Text size="sm" c="dimmed">个人套餐 · 剩余 {item.currentSubscription.remainingTrafficGb} GB</Text>
                                  </Stack>
                                ) : (
                                  <Text c="dimmed">无套餐</Text>
                                )}
                              </Table.Td>
                              <Table.Td>
                                <ActionIcon variant="subtle" onClick={() => openDrawer("user", item.id)}>
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
                        {filteredTeams.map((item) => {
                          const teamSubscriptionRecord = item.currentSubscription
                            ? allSubscriptions.find((subscription) => subscription.id === item.currentSubscription?.id)
                            : null;

                          return (
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
                                  <Stack gap={0} miw={160}>
                                    <Text size="sm" c="dimmed">
                                      当前套餐
                                    </Text>
                                    <Text fw={600}>{item.currentSubscription?.planName ?? "未分配"}</Text>
                                  </Stack>
                                  <Stack gap={0} miw={120}>
                                    <Text size="sm" c="dimmed">
                                      剩余流量
                                    </Text>
                                    <Text fw={600}>
                                      {item.currentSubscription ? `${item.currentSubscription.remainingTrafficGb} GB` : "-"}
                                    </Text>
                                  </Stack>
                                </Group>
                                <StatusBadge color={item.status === "active" ? "green" : "gray"} label={item.status === "active" ? "启用" : "停用"} />
                              </Group>
                            </Accordion.Control>
                            <Accordion.Panel>
                              <Stack gap="md">
                                <Group justify="space-between">
                                  <Text size="sm" c="dimmed">
                                    团队主体下的登录账号与共享套餐
                                  </Text>
                                  <RowActions>
                                    <ActionIcon variant="subtle" onClick={() => openDrawer("team", item.id)}>
                                      <IconPencil size={16} />
                                    </ActionIcon>
                                    <ActionIcon variant="subtle" onClick={() => openDrawer("team-member", null, item.id)}>
                                      <IconUsers size={16} />
                                    </ActionIcon>
                                    <ActionIcon
                                      variant="subtle"
                                      onClick={() => openDrawer("team-subscription", null, item.id)}
                                      disabled={item.currentSubscription?.state === "active"}
                                    >
                                      <IconListDetails size={16} />
                                    </ActionIcon>
                                    {item.currentSubscription ? (
                                      <ActionIcon
                                        variant="subtle"
                                        onClick={() =>
                                          void openNodeAccessEditor(
                                            item.currentSubscription!.id,
                                            `${item.name} · ${item.currentSubscription!.planName}`
                                          )
                                        }
                                      >
                                        <IconMapPin size={16} />
                                      </ActionIcon>
                                    ) : null}
                                  </RowActions>
                                </Group>

                                <SimpleGrid cols={{ base: 1, lg: 3 }}>
                                  <Paper withBorder radius="lg" p="md">
                                    <Stack gap={4}>
                                      <Text size="sm" c="dimmed">
                                        共享套餐
                                      </Text>
                                      <Text fw={600}>{item.currentSubscription?.planName ?? "未分配"}</Text>
                                      <Text size="sm" c="dimmed">
                                        {item.currentSubscription
                                          ? `剩余 ${item.currentSubscription.remainingTrafficGb} GB · 到期 ${formatDateTime(item.currentSubscription.expireAt)}`
                                          : "请先分配 Team 套餐"}
                                      </Text>
                                    </Stack>
                                  </Paper>
                                  <Paper withBorder radius="lg" p="md">
                                    <Stack gap={4}>
                                      <Text size="sm" c="dimmed">
                                        节点授权
                                      </Text>
                                      <Text fw={600}>
                                        {item.currentSubscription
                                          ? teamSubscriptionRecord?.hasNodeAccess
                                            ? `${teamSubscriptionRecord.nodeCount} 个节点`
                                            : "未分配节点"
                                          : "未分配"}
                                      </Text>
                                      <Text size="sm" c="dimmed">
                                        {item.currentSubscription
                                          ? teamSubscriptionRecord?.hasNodeAccess
                                            ? "仅团队成员可见这些节点"
                                            : "当前订阅还未分配节点"
                                          : "无共享订阅时不可分配节点"}
                                      </Text>
                                    </Stack>
                                  </Paper>
                                  <Paper withBorder radius="lg" p="md">
                                    <Stack gap={4}>
                                      <Text size="sm" c="dimmed">
                                        团队状态
                                      </Text>
                                      <Text fw={600}>{item.status === "active" ? "启用" : "停用"}</Text>
                                      <Text size="sm" c="dimmed">
                                        成员 {item.memberCount} 人
                                      </Text>
                                    </Stack>
                                  </Paper>
                                </SimpleGrid>

                                <DataTable>
                                  <Table.Thead>
                                    <Table.Tr>
                                      <Table.Th>账号</Table.Th>
                                      <Table.Th>角色</Table.Th>
                                      <Table.Th>我的用量</Table.Th>
                                      <Table.Th>状态</Table.Th>
                                      <Table.Th>操作</Table.Th>
                                    </Table.Tr>
                                  </Table.Thead>
                                  <Table.Tbody>
                                    {item.members.map((member) => {
                                      const userRecord = snapshot.users.find((user) => user.id === member.userId);
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
                                          <Table.Td>{member.usedTrafficGb} GB</Table.Td>
                                          <Table.Td>
                                            <StatusBadge
                                              color={userRecord?.status === "active" ? "green" : "gray"}
                                              label={translateUserStatus(userRecord?.status ?? "disabled")}
                                            />
                                          </Table.Td>
                                          <Table.Td>
                                            <RowActions>
                                              <ActionIcon variant="subtle" onClick={() => openDrawer("user", member.userId)}>
                                                <IconPencil size={16} />
                                              </ActionIcon>
                                              <ActionIcon variant="subtle" onClick={() => openDrawer("team-member", member.id, item.id)}>
                                                <IconUsers size={16} />
                                              </ActionIcon>
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
                          );
                        })}
                      </Accordion>
                    </Tabs.Panel>
                  </Tabs>
                </SectionCard>
              </Stack>
            ) : null}

            {section === "plans" ? (
              <SectionCard searchValue={search.plans} onSearchChange={(value) => setSearch((current) => ({ ...current, plans: value }))}>
                <Tabs value={planScopeTab} onChange={(value) => setPlanScopeTab((value as PlanScope) || "personal")}>
                  <Tabs.List>
                    <Tabs.Tab value="personal">个人套餐</Tabs.Tab>
                    <Tabs.Tab value="team">Team 套餐</Tabs.Tab>
                  </Tabs.List>
                  <Tabs.Panel value={planScopeTab} pt="md">
                    <DataTable>
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>名称</Table.Th>
                          <Table.Th>总流量</Table.Th>
                          <Table.Th>续费</Table.Th>
                          <Table.Th>状态</Table.Th>
                          <Table.Th>订阅数</Table.Th>
                          <Table.Th>操作</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {plans.filter((item) => item.scope === planScopeTab).map((item) => (
                          <Table.Tr key={item.id}>
                            <Table.Td>{item.name}</Table.Td>
                            <Table.Td>{item.totalTrafficGb} GB</Table.Td>
                            <Table.Td>{item.renewable ? "可续费" : "不可续费"}</Table.Td>
                            <Table.Td>
                              <StatusBadge color={item.isActive ? "green" : "gray"} label={item.isActive ? "启用" : "停用"} />
                            </Table.Td>
                            <Table.Td>{item.subscriptionCount}</Table.Td>
                            <Table.Td>
                              <ActionIcon variant="subtle" onClick={() => openDrawer("plan", item.id)}>
                                <IconPencil size={16} />
                              </ActionIcon>
                            </Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </DataTable>
                  </Tabs.Panel>
                </Tabs>
              </SectionCard>
            ) : null}

            {section === "subscriptions" ? (
              <SectionCard searchValue={search.subscriptions} onSearchChange={(value) => setSearch((current) => ({ ...current, subscriptions: value }))}>
                <Tabs value={subscriptionTab} onChange={(value) => setSubscriptionTab((value as "personal" | "team") || "personal")}>
                  <Tabs.List>
                    <Tabs.Tab value="personal">个人订阅</Tabs.Tab>
                    <Tabs.Tab value="team">Team 订阅</Tabs.Tab>
                  </Tabs.List>
                  <Tabs.Panel value="personal" pt="md">
                    <DataTable>
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>用户</Table.Th>
                          <Table.Th>套餐</Table.Th>
                          <Table.Th>总量</Table.Th>
                          <Table.Th>剩余</Table.Th>
                          <Table.Th>节点</Table.Th>
                          <Table.Th>到期时间</Table.Th>
                          <Table.Th>状态</Table.Th>
                          <Table.Th>来源</Table.Th>
                          <Table.Th>操作</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {subscriptions.filter((item) => item.ownerType === "user").map((item) => (
                          <Table.Tr key={item.id}>
                            <Table.Td>
                              <Stack gap={0}>
                                <Text>{item.userDisplayName}</Text>
                                <Text size="sm" c="dimmed">{item.userEmail}</Text>
                              </Stack>
                            </Table.Td>
                            <Table.Td>{item.planName}</Table.Td>
                            <Table.Td>{item.totalTrafficGb} GB</Table.Td>
                            <Table.Td>{item.remainingTrafficGb} GB</Table.Td>
                            <Table.Td>
                              <Text c={item.hasNodeAccess ? undefined : "orange.7"}>
                                {item.hasNodeAccess ? `${item.nodeCount} 个节点` : "未分配节点"}
                              </Text>
                            </Table.Td>
                            <Table.Td>{formatDateTime(item.expireAt)}</Table.Td>
                            <Table.Td>
                              <StatusBadge color={subscriptionStateColor(item.state)} label={translateSubscriptionState(item.state)} />
                            </Table.Td>
                            <Table.Td>{translateSourceAction(item.sourceAction)}</Table.Td>
                            <Table.Td>
                              <RowActions>
                                <ActionIcon variant="subtle" onClick={() => openDrawer("subscription-renew", item.id)}>
                                  <IconRefresh size={16} />
                                </ActionIcon>
                                <ActionIcon variant="subtle" onClick={() => openDrawer("subscription-change-plan", item.id)}>
                                  <IconListDetails size={16} />
                                </ActionIcon>
                                <ActionIcon variant="subtle" onClick={() => openDrawer("subscription-adjust", item.id)}>
                                  <IconPencil size={16} />
                                </ActionIcon>
                                <ActionIcon
                                  variant="subtle"
                                  onClick={() =>
                                    void openNodeAccessEditor(
                                      item.id,
                                      `${item.userDisplayName ?? item.userEmail ?? "个人用户"} · ${item.planName}`
                                    )
                                  }
                                >
                                  <IconMapPin size={16} />
                                </ActionIcon>
                              </RowActions>
                            </Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </DataTable>
                  </Tabs.Panel>
                  <Tabs.Panel value="team" pt="md">
                    <DataTable>
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>团队</Table.Th>
                          <Table.Th>套餐</Table.Th>
                          <Table.Th>总量</Table.Th>
                          <Table.Th>剩余</Table.Th>
                          <Table.Th>节点</Table.Th>
                          <Table.Th>到期时间</Table.Th>
                          <Table.Th>状态</Table.Th>
                          <Table.Th>来源</Table.Th>
                          <Table.Th>操作</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {filteredTeamSubscriptions.map((team) => {
                          const teamSubscriptionRecord = team.currentSubscription
                            ? allSubscriptions.find((item) => item.id === team.currentSubscription?.id)
                            : null;

                          return (
                          <Table.Tr key={team.id}>
                            <Table.Td>
                              <Stack gap={0}>
                                <Text>{team.name}</Text>
                                <Text size="sm" c="dimmed">
                                  {team.ownerDisplayName} · {team.memberCount} 人
                                </Text>
                              </Stack>
                            </Table.Td>
                            <Table.Td>{team.currentSubscription?.planName ?? "未分配"}</Table.Td>
                            <Table.Td>{team.currentSubscription ? `${team.currentSubscription.totalTrafficGb} GB` : "-"}</Table.Td>
                            <Table.Td>{team.currentSubscription ? `${team.currentSubscription.remainingTrafficGb} GB` : "-"}</Table.Td>
                            <Table.Td>
                              {team.currentSubscription ? (
                                <Text c={teamSubscriptionRecord?.hasNodeAccess ? undefined : "orange.7"}>
                                  {teamSubscriptionRecord?.hasNodeAccess ? `${teamSubscriptionRecord.nodeCount} 个节点` : "未分配节点"}
                                </Text>
                              ) : (
                                <Text c="dimmed">未分配</Text>
                              )}
                            </Table.Td>
                            <Table.Td>{team.currentSubscription ? formatDateTime(team.currentSubscription.expireAt) : "-"}</Table.Td>
                            <Table.Td>
                              <StatusBadge
                                color={subscriptionStateColor(team.currentSubscription?.state ?? "paused")}
                                label={team.currentSubscription ? translateSubscriptionState(team.currentSubscription.state) : "未分配"}
                              />
                            </Table.Td>
                            <Table.Td>{team.currentSubscription ? "共享订阅" : "-"}</Table.Td>
                            <Table.Td>
                              <RowActions>
                                <ActionIcon variant="subtle" onClick={() => openDrawer("team", team.id)}>
                                  <IconUsers size={16} />
                                </ActionIcon>
                                {team.currentSubscription ? (
                                  <ActionIcon
                                    variant="subtle"
                                    onClick={() =>
                                      void openNodeAccessEditor(
                                        team.currentSubscription!.id,
                                        `${team.name} · ${team.currentSubscription!.planName}`
                                      )
                                    }
                                  >
                                    <IconMapPin size={16} />
                                  </ActionIcon>
                                ) : null}
                              </RowActions>
                            </Table.Td>
                          </Table.Tr>
                          );
                        })}
                      </Table.Tbody>
                    </DataTable>
                  </Tabs.Panel>
                </Tabs>
              </SectionCard>
            ) : null}

            {section === "nodes" ? (
              <SectionCard searchValue={search.nodes} onSearchChange={(value) => setSearch((current) => ({ ...current, nodes: value }))}>
                <DataTable>
                  <Table.Thead>
                      <Table.Tr>
                        <Table.Th>节点</Table.Th>
                        <Table.Th>地址</Table.Th>
                        <Table.Th>3x-ui</Table.Th>
                        {currentAccessMode === "relay" ? <Table.Th>中转</Table.Th> : null}
                        <Table.Th>探测状态</Table.Th>
                        <Table.Th>延迟</Table.Th>
                        <Table.Th>最后检测</Table.Th>
                      <Table.Th>错误</Table.Th>
                      <Table.Th>操作</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {nodes.map((item) => (
                      <Table.Tr key={item.id}>
                        <Table.Td>
                          <Stack gap={0}>
                            <Text>{item.name}</Text>
                            <Text size="sm" c="dimmed">
                              {item.region} · {item.provider}
                            </Text>
                          </Stack>
                        </Table.Td>
                        <Table.Td>{item.serverHost}:{item.serverPort}</Table.Td>
                        <Table.Td>
                          <StatusBadge color={nodePanelColor(item.panelStatus)} label={translatePanelStatus(item.panelStatus)} />
                        </Table.Td>
                        {currentAccessMode === "relay" ? (
                          <Table.Td>
                            <StatusBadge color={nodeGatewayColor(item.gatewayStatus)} label={translateGatewayStatus(item.gatewayStatus)} />
                          </Table.Td>
                        ) : null}
                        <Table.Td>
                          <StatusBadge color={nodeProbeColor(item.probeStatus)} label={translateProbeStatus(item.probeStatus)} />
                        </Table.Td>
                        <Table.Td>{item.probeLatencyMs !== null ? `${item.probeLatencyMs} ms` : "-"}</Table.Td>
                        <Table.Td>{item.probeCheckedAt ? formatDateTime(item.probeCheckedAt) : "-"}</Table.Td>
                        <Table.Td>
                          <Text size="sm" c="dimmed" lineClamp={2}>
                            {item.panelError || item.probeError || "-"}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <RowActions>
                            <ActionIcon
                              variant="subtle"
                              onClick={() => void handleProbeNode(item.id)}
                              loading={probingNodeId === item.id}
                            >
                              <IconBolt size={16} />
                            </ActionIcon>
                            <ActionIcon variant="subtle" onClick={() => void handleRefreshNode(item.id)}>
                              <IconRefresh size={16} />
                            </ActionIcon>
                            <ActionIcon variant="subtle" onClick={() => openDrawer("node", item.id)}>
                              <IconPencil size={16} />
                            </ActionIcon>
                            <ActionIcon color="red" variant="subtle" onClick={() => setDeleteNodeTarget(item)}>
                              <IconTrash size={16} />
                            </ActionIcon>
                          </RowActions>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </DataTable>
              </SectionCard>
            ) : null}

            {section === "announcements" ? (
              <SectionCard searchValue={search.announcements} onSearchChange={(value) => setSearch((current) => ({ ...current, announcements: value }))}>
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
                    {announcements.map((item) => (
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
                          <ActionIcon variant="subtle" onClick={() => openDrawer("announcement", item.id)}>
                            <IconPencil size={16} />
                          </ActionIcon>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </DataTable>
              </SectionCard>
            ) : null}

            {section === "policies" && policyForm ? (
              <Card withBorder radius="xl" p="lg">
                <Stack gap="lg">
                  <SimpleGrid cols={{ base: 1, xl: 2 }}>
                    <Card withBorder radius="xl" p="lg">
                      <Stack gap="md">
                        <Title order={4}>基础策略</Title>
                        <Select
                          label="接入模式"
                          data={[
                            { value: "xui", label: "3x-ui 直连模式" },
                            { value: "relay", label: "中心中转模式" }
                          ]}
                          value={policyForm.accessMode}
                          onChange={(value) => setPolicyForm((current) => current ? { ...current, accessMode: (value || "xui") as AccessMode } : current)}
                        />
                        {policyForm.accessMode === "xui" ? (
                          <Alert color="blue" variant="light">
                            当前使用 3x-ui 直连接入，中心负责开通、删号与汇总计量。
                          </Alert>
                        ) : (
                          <Alert color="yellow" variant="light">
                            当前使用中心中转接入，客户端不会直接拿到真实节点参数，但需要额外中转资源。
                          </Alert>
                        )}
                        <Select
                          label="默认模式"
                          data={modeOptions}
                          value={policyForm.defaultMode}
                          onChange={(value) => setPolicyForm((current) => current ? { ...current, defaultMode: (value || "rule") as ConnectionMode } : current)}
                        />
                        <Checkbox.Group
                          label="可用模式"
                          value={policyForm.modes}
                          onChange={(value) => setPolicyForm((current) => current ? { ...current, modes: value as ConnectionMode[] } : current)}
                        >
                          <Group mt="xs">
                            <Checkbox value="rule" label="规则模式" />
                            <Checkbox value="global" label="全局代理" />
                            <Checkbox value="direct" label="直连模式" />
                          </Group>
                        </Checkbox.Group>
                        <Group grow>
                          <Switch
                            checked={policyForm.blockAds}
                            onChange={(event) => setPolicyForm((current) => current ? { ...current, blockAds: event.currentTarget.checked } : current)}
                            label="广告拦截"
                          />
                          <Switch
                            checked={policyForm.chinaDirect}
                            onChange={(event) => setPolicyForm((current) => current ? { ...current, chinaDirect: event.currentTarget.checked } : current)}
                            label="大陆直连"
                          />
                          <Switch
                            checked={policyForm.aiServicesProxy}
                            onChange={(event) => setPolicyForm((current) => current ? { ...current, aiServicesProxy: event.currentTarget.checked } : current)}
                            label="AI 代理"
                          />
                        </Group>
                      </Stack>
                    </Card>

                    <Card withBorder radius="xl" p="lg">
                      <Stack gap="md">
                        <Title order={4}>版本更新</Title>
                        <TextInput
                          label="当前版本"
                          value={policyForm.currentVersion}
                          onChange={(event) => setPolicyForm((current) => current ? { ...current, currentVersion: event.currentTarget.value } : current)}
                        />
                        <TextInput
                          label="最低版本"
                          value={policyForm.minimumVersion}
                          onChange={(event) => setPolicyForm((current) => current ? { ...current, minimumVersion: event.currentTarget.value } : current)}
                        />
                        <Switch
                          checked={policyForm.forceUpgrade}
                          onChange={(event) => setPolicyForm((current) => current ? { ...current, forceUpgrade: event.currentTarget.checked } : current)}
                          label="强制升级"
                        />
                        <TextInput
                          label="下载地址"
                          value={policyForm.downloadUrl}
                          onChange={(event) => setPolicyForm((current) => current ? { ...current, downloadUrl: event.currentTarget.value } : current)}
                        />
                        <Textarea
                          label="更新日志"
                          minRows={6}
                          value={policyForm.changelog}
                          onChange={(event) => setPolicyForm((current) => current ? { ...current, changelog: event.currentTarget.value } : current)}
                        />
                      </Stack>
                    </Card>
                  </SimpleGrid>
                  <Group justify="flex-end">
                    <Button onClick={() => void handleSavePolicy()} loading={policySaving}>
                      保存策略
                    </Button>
                  </Group>
                </Stack>
              </Card>
            ) : null}
          </Stack>
        </AppShell.Main>
      </AppShell>

      <Drawer opened={drawer.type !== null} onClose={closeDrawer} title={drawerTitle(drawer.type)} position="right" size="lg">
        <Stack>
          {drawer.type === "user" ? (
            <>
              <TextInput
                label="邮箱"
                value={userForm.email}
                onChange={(event) => setUserForm((current) => ({ ...current, email: event.currentTarget.value }))}
                disabled={drawer.recordId !== null}
              />
              <TextInput
                label={drawer.recordId ? "重置密码" : "登录密码"}
                type="password"
                value={userForm.password}
                placeholder={drawer.recordId ? "留空则不修改" : ""}
                onChange={(event) => setUserForm((current) => ({ ...current, password: event.currentTarget.value }))}
              />
              <TextInput
                label="名称"
                value={userForm.displayName}
                onChange={(event) => setUserForm((current) => ({ ...current, displayName: event.currentTarget.value }))}
              />
              <Select
                label="角色"
                data={[
                  { value: "user", label: "用户" },
                  { value: "admin", label: "管理员" }
                ]}
                value={userForm.role}
                onChange={(value) => setUserForm((current) => ({ ...current, role: (value || "user") as UserRole }))}
              />
              {drawer.recordId ? (
                <Select
                  label="状态"
                  data={[
                    { value: "active", label: "启用" },
                    { value: "disabled", label: "禁用" }
                  ]}
                  value={userForm.status}
                  onChange={(value) => setUserForm((current) => ({ ...current, status: (value || "active") as UserStatus }))}
                />
              ) : null}
            </>
          ) : null}

          {drawer.type === "plan" ? (
            <>
              <TextInput
                label="套餐名称"
                value={planForm.name}
                onChange={(event) => setPlanForm((current) => ({ ...current, name: event.currentTarget.value }))}
              />
              <Select
                label="套餐类型"
                data={[
                  { value: "personal", label: "个人套餐" },
                  { value: "team", label: "Team 套餐" }
                ]}
                value={planForm.scope}
                onChange={(value) => setPlanForm((current) => ({ ...current, scope: (value || "personal") as PlanScope }))}
              />
              <NumberInput
                label="总流量 (GB)"
                min={0}
                value={planForm.totalTrafficGb}
                onChange={(value) => setPlanForm((current) => ({ ...current, totalTrafficGb: Number(value) || 0 }))}
              />
              <Group grow>
                <Switch
                  checked={planForm.renewable}
                  onChange={(event) => setPlanForm((current) => ({ ...current, renewable: event.currentTarget.checked }))}
                  label="允许续费"
                />
                <Switch
                  checked={planForm.isActive}
                  onChange={(event) => setPlanForm((current) => ({ ...current, isActive: event.currentTarget.checked }))}
                  label="启用"
                />
              </Group>
            </>
          ) : null}

          {drawer.type === "subscription-create" ? (
            <>
              <Select
                label="用户"
                data={eligiblePersonalUsers.map((item) => ({ value: item.id, label: `${item.displayName} · ${item.email}` }))}
                value={subscriptionCreateForm.userId}
                onChange={(value) => setSubscriptionCreateForm((current) => ({ ...current, userId: value || "" }))}
              />
              <Select
                label="套餐"
                data={snapshot.plans
                  .filter((item) => item.isActive && item.scope === "personal")
                  .map((item) => ({ value: item.id, label: item.name }))}
                value={subscriptionCreateForm.planId}
                onChange={(value) => setSubscriptionCreateForm((current) => applyPlanToCreateForm(snapshot, current, value || ""))}
              />
              <Group grow>
                <NumberInput
                  label="总流量 (GB)"
                  min={0}
                  value={subscriptionCreateForm.totalTrafficGb}
                  onChange={(value) => setSubscriptionCreateForm((current) => ({ ...current, totalTrafficGb: Number(value) || 0 }))}
                />
                <NumberInput
                  label="已用流量 (GB)"
                  min={0}
                  value={subscriptionCreateForm.usedTrafficGb}
                  onChange={(value) => setSubscriptionCreateForm((current) => ({ ...current, usedTrafficGb: Number(value) || 0 }))}
                />
              </Group>
              <TextInput
                label="到期时间"
                type="datetime-local"
                value={subscriptionCreateForm.expireAt}
                onChange={(event) => setSubscriptionCreateForm((current) => ({ ...current, expireAt: event.currentTarget.value }))}
              />
              <Group grow>
                <Select
                  label="状态"
                  data={subscriptionStateOptions}
                  value={subscriptionCreateForm.state}
                  onChange={(value) =>
                    setSubscriptionCreateForm((current) => ({ ...current, state: (value || "active") as SubscriptionState }))
                  }
                />
                <Switch
                  checked={subscriptionCreateForm.renewable}
                  onChange={(event) => setSubscriptionCreateForm((current) => ({ ...current, renewable: event.currentTarget.checked }))}
                  label="允许续费"
                  mt={30}
                />
              </Group>
            </>
          ) : null}

          {drawer.type === "subscription-adjust" ? (
            <>
              <NumberInput
                label="总流量 (GB)"
                min={0}
                value={subscriptionAdjustForm.totalTrafficGb}
                onChange={(value) => setSubscriptionAdjustForm((current) => ({ ...current, totalTrafficGb: Number(value) || 0 }))}
              />
              <NumberInput
                label="已用流量 (GB)"
                min={0}
                value={subscriptionAdjustForm.usedTrafficGb}
                onChange={(value) => setSubscriptionAdjustForm((current) => ({ ...current, usedTrafficGb: Number(value) || 0 }))}
              />
              <TextInput
                label="到期时间"
                type="datetime-local"
                value={subscriptionAdjustForm.expireAt}
                onChange={(event) => setSubscriptionAdjustForm((current) => ({ ...current, expireAt: event.currentTarget.value }))}
              />
              <Group grow>
                <Select
                  label="状态"
                  data={subscriptionStateOptions}
                  value={subscriptionAdjustForm.state}
                  onChange={(value) =>
                    setSubscriptionAdjustForm((current) => ({ ...current, state: (value || "active") as SubscriptionState }))
                  }
                />
                <Switch
                  checked={subscriptionAdjustForm.renewable}
                  onChange={(event) => setSubscriptionAdjustForm((current) => ({ ...current, renewable: event.currentTarget.checked }))}
                  label="允许续费"
                  mt={30}
                />
              </Group>
            </>
          ) : null}

          {drawer.type === "subscription-renew" ? (
            <>
              <TextInput
                label="新的到期时间"
                type="datetime-local"
                value={subscriptionRenewForm.expireAt}
                onChange={(event) => setSubscriptionRenewForm((current) => ({ ...current, expireAt: event.currentTarget.value }))}
              />
              <NumberInput
                label="顺延天数 (可选)"
                min={1}
                value={subscriptionRenewForm.extendDays}
                onChange={(value) => setSubscriptionRenewForm((current) => ({ ...current, extendDays: Number(value) || 1 }))}
              />
              <Group grow>
                <NumberInput
                  label="续后总流量 (留空保持原值)"
                  value={subscriptionRenewForm.totalTrafficGb}
                  min={0}
                  onChange={(value) =>
                    setSubscriptionRenewForm((current) => ({
                      ...current,
                      totalTrafficGb: value === "" || value === null ? "" : Number(value)
                    }))
                  }
                />
              </Group>
              <Switch
                checked={subscriptionRenewForm.resetTraffic}
                onChange={(event) => setSubscriptionRenewForm((current) => ({ ...current, resetTraffic: event.currentTarget.checked }))}
                label="续期时重置已用流量"
              />
            </>
          ) : null}

          {drawer.type === "subscription-change-plan" ? (
            <>
              <Select
                label="目标套餐"
                data={snapshot.plans
                  .filter((item) => item.isActive && item.scope === "personal")
                  .map((item) => ({ value: item.id, label: item.name }))}
                value={subscriptionChangePlanForm.planId}
                onChange={(value) => setSubscriptionChangePlanForm((current) => applyPlanToChangePlanForm(snapshot, current, value || ""))}
              />
              <NumberInput
                label="总流量 (GB)"
                min={0}
                value={subscriptionChangePlanForm.totalTrafficGb}
                onChange={(value) => setSubscriptionChangePlanForm((current) => ({ ...current, totalTrafficGb: Number(value) || 0 }))}
              />
              <TextInput
                label="到期时间 (留空保持原值)"
                type="datetime-local"
                value={subscriptionChangePlanForm.expireAt}
                onChange={(event) => setSubscriptionChangePlanForm((current) => ({ ...current, expireAt: event.currentTarget.value }))}
              />
              <Switch
                checked={subscriptionChangePlanForm.renewable}
                onChange={(event) =>
                  setSubscriptionChangePlanForm((current) => ({ ...current, renewable: event.currentTarget.checked }))
                }
                label="允许续费"
              />
            </>
          ) : null}

          {drawer.type === "node" ? (
            <>
              {currentAccessMode === "relay" ? (
                <TextInput
                  label="订阅地址"
                  value={nodeForm.subscriptionUrl}
                  onChange={(event) => setNodeForm((current) => ({ ...current, subscriptionUrl: event.currentTarget.value }))}
                />
              ) : (
                <Alert color="blue" variant="light">
                  当前为 3x-ui 直连模式，节点运行参数会直接从面板入站读取，无需填写订阅地址。
                </Alert>
              )}
              <TextInput
                label="节点名称"
                value={nodeForm.name}
                onChange={(event) => setNodeForm((current) => ({ ...current, name: event.currentTarget.value }))}
              />
              <Group grow>
                <TextInput
                  label="地区"
                  value={nodeForm.region}
                  onChange={(event) => setNodeForm((current) => ({ ...current, region: event.currentTarget.value }))}
                />
                <TextInput
                  label="供应商"
                  value={nodeForm.provider}
                  onChange={(event) => setNodeForm((current) => ({ ...current, provider: event.currentTarget.value }))}
                />
              </Group>
              <TextInput
                label="标签"
                description="使用英文逗号分隔"
                value={nodeForm.tags}
                onChange={(event) => setNodeForm((current) => ({ ...current, tags: event.currentTarget.value }))}
              />
              <Switch
                checked={nodeForm.recommended}
                onChange={(event) => setNodeForm((current) => ({ ...current, recommended: event.currentTarget.checked }))}
                label="推荐节点"
              />
              <Switch
                checked={nodeForm.panelEnabled}
                onChange={(event) => setNodeForm((current) => ({ ...current, panelEnabled: event.currentTarget.checked }))}
                label="启用 3x-ui 面板"
              />
              <TextInput
                label="面板地址"
                placeholder="https://panel.example.com:2053"
                value={nodeForm.panelBaseUrl}
                onChange={(event) => setNodeForm((current) => ({ ...current, panelBaseUrl: event.currentTarget.value }))}
              />
              <Group grow>
                <TextInput
                  label="面板路径"
                  placeholder="/"
                  value={nodeForm.panelApiBasePath}
                  onChange={(event) => setNodeForm((current) => ({ ...current, panelApiBasePath: event.currentTarget.value }))}
                />
                <NumberInput
                  label="入站 ID"
                  min={1}
                  value={nodeForm.panelInboundId}
                  onChange={(value) => setNodeForm((current) => ({ ...current, panelInboundId: Number(value) || 1 }))}
                />
              </Group>
              <Group grow>
                <TextInput
                  label="面板账号"
                  value={nodeForm.panelUsername}
                  onChange={(event) => setNodeForm((current) => ({ ...current, panelUsername: event.currentTarget.value }))}
                />
                <TextInput
                  label="面板密码"
                  type="password"
                  value={nodeForm.panelPassword}
                  onChange={(event) => setNodeForm((current) => ({ ...current, panelPassword: event.currentTarget.value }))}
                />
              </Group>
            </>
          ) : null}

          {drawer.type === "announcement" ? (
            <>
              <TextInput
                label="标题"
                value={announcementForm.title}
                onChange={(event) => setAnnouncementForm((current) => ({ ...current, title: event.currentTarget.value }))}
              />
              <Textarea
                label="内容"
                minRows={6}
                value={announcementForm.body}
                onChange={(event) => setAnnouncementForm((current) => ({ ...current, body: event.currentTarget.value }))}
              />
              <Group grow>
                <Select
                  label="级别"
                  data={announcementLevelOptions}
                  value={announcementForm.level}
                  onChange={(value) =>
                    setAnnouncementForm((current) => ({ ...current, level: (value || "info") as AnnouncementLevel }))
                  }
                />
                <TextInput
                  label="发布时间"
                  type="datetime-local"
                  value={announcementForm.publishedAt}
                  onChange={(event) => setAnnouncementForm((current) => ({ ...current, publishedAt: event.currentTarget.value }))}
                />
              </Group>
              <Select
                label="展示模式"
                data={displayModeOptions}
                value={announcementForm.displayMode}
                onChange={(value) =>
                  setAnnouncementForm((current) => ({
                    ...current,
                    displayMode: (value || "passive") as AnnouncementDisplayMode,
                    countdownSeconds: value === "modal_countdown" ? Math.max(1, current.countdownSeconds) : 0
                  }))
                }
              />
              {announcementForm.displayMode === "modal_countdown" ? (
                <NumberInput
                  label="倒计时秒数"
                  min={1}
                  value={announcementForm.countdownSeconds}
                  onChange={(value) => setAnnouncementForm((current) => ({ ...current, countdownSeconds: Number(value) || 1 }))}
                />
              ) : null}
              <Switch
                checked={announcementForm.isActive}
                onChange={(event) => setAnnouncementForm((current) => ({ ...current, isActive: event.currentTarget.checked }))}
                label="立即上线"
              />
            </>
          ) : null}

          {drawer.type === "team" ? (
            <>
              <TextInput
                label="团队名称"
                value={teamForm.name}
                onChange={(event) => setTeamForm((current) => ({ ...current, name: event.currentTarget.value }))}
              />
              <Select
                label="负责人"
                data={snapshot.users
                  .filter((item) => item.role === "user" && (drawer.recordId ? item.teamId === null || item.id === teamForm.ownerUserId : item.teamId === null))
                  .map((item) => ({ value: item.id, label: `${item.displayName} · ${item.email}` }))}
                value={teamForm.ownerUserId}
                onChange={(value) => setTeamForm((current) => ({ ...current, ownerUserId: value || "" }))}
              />
              <Select
                label="状态"
                data={[
                  { value: "active", label: "启用" },
                  { value: "disabled", label: "停用" }
                ]}
                value={teamForm.status}
                onChange={(value) => setTeamForm((current) => ({ ...current, status: (value || "active") as TeamStatus }))}
              />
              {drawer.recordId ? (
                <Card withBorder radius="xl" p="md">
                  <Stack gap="sm">
                    <Group justify="space-between">
                      <Title order={5}>成员</Title>
                      <Button size="xs" variant="default" onClick={() => openDrawer("team-member", null, drawer.recordId)}>
                        添加成员
                      </Button>
                    </Group>
                    {(snapshot.teams.find((item) => item.id === drawer.recordId)?.members ?? []).map((member) => (
                      <Paper key={member.id} withBorder radius="lg" p="sm">
                        <Group justify="space-between">
                          <div>
                            <Text fw={600}>{member.displayName}</Text>
                            <Text size="sm" c="dimmed">
                              {member.email} · 已用 {member.usedTrafficGb} GB
                            </Text>
                          </div>
                          <RowActions>
                            <ActionIcon variant="subtle" onClick={() => openDrawer("team-member", member.id, drawer.recordId)}>
                              <IconPencil size={16} />
                            </ActionIcon>
                            {member.role !== "owner" ? (
                              <ActionIcon color="red" variant="subtle" onClick={() => void handleDeleteTeamMember(drawer.recordId!, member.id)}>
                                <IconTrash size={16} />
                              </ActionIcon>
                            ) : null}
                          </RowActions>
                        </Group>
                      </Paper>
                    ))}
                  </Stack>
                </Card>
              ) : null}
              {drawer.recordId ? (
                <Card withBorder radius="xl" p="md">
                  <Stack gap="sm">
                    <Title order={5}>流量明细</Title>
                    {(snapshot.teams.find((item) => item.id === drawer.recordId)?.usage ?? []).map((entry) => (
                      <Paper key={entry.id} withBorder radius="lg" p="sm">
                        <Group justify="space-between">
                          <div>
                            <Text fw={600}>{entry.userDisplayName}</Text>
                            <Text size="sm" c="dimmed">
                              {entry.userEmail} · {formatDateTime(entry.recordedAt)}
                            </Text>
                          </div>
                          <Badge variant="light">{entry.usedTrafficGb} GB</Badge>
                        </Group>
                      </Paper>
                    ))}
                  </Stack>
                </Card>
              ) : null}
            </>
          ) : null}

          {drawer.type === "team-member" ? (
            <>
              <Select
                label="成员账号"
                disabled={drawer.recordId !== null}
                data={eligiblePersonalUsers
                  .map((item) => ({ value: item.id, label: `${item.displayName} · ${item.email}` }))}
                value={teamMemberForm.userId}
                onChange={(value) => setTeamMemberForm((current) => ({ ...current, userId: value || "" }))}
              />
              <Select
                label="角色"
                data={[
                  { value: "member", label: "成员" },
                  { value: "owner", label: "负责人" }
                ]}
                value={teamMemberForm.role}
                onChange={(value) => setTeamMemberForm((current) => ({ ...current, role: (value || "member") as TeamMemberRole }))}
              />
            </>
          ) : null}

          {drawer.type === "team-subscription" ? (
            <>
              <Select
                label="套餐"
                data={snapshot.plans
                  .filter((item) => item.isActive && item.scope === "team")
                  .map((item) => ({ value: item.id, label: item.name }))}
                value={teamSubscriptionForm.planId}
                onChange={(value) => setTeamSubscriptionForm((current) => applyPlanToTeamSubscriptionForm(snapshot, current, value || ""))}
              />
              <NumberInput
                label="总流量 (GB)"
                min={0}
                value={teamSubscriptionForm.totalTrafficGb}
                onChange={(value) => setTeamSubscriptionForm((current) => ({ ...current, totalTrafficGb: Number(value) || 0 }))}
              />
              <TextInput
                label="到期时间"
                type="datetime-local"
                value={teamSubscriptionForm.expireAt}
                onChange={(event) => setTeamSubscriptionForm((current) => ({ ...current, expireAt: event.currentTarget.value }))}
              />
              <Switch
                checked={teamSubscriptionForm.renewable}
                onChange={(event) => setTeamSubscriptionForm((current) => ({ ...current, renewable: event.currentTarget.checked }))}
                label="允许续费"
              />
            </>
          ) : null}

          <Group justify="flex-end">
            <Button variant="default" onClick={closeDrawer}>
              取消
            </Button>
            <Button onClick={() => void submitDrawer()} loading={drawerBusy}>
              保存
            </Button>
          </Group>
        </Stack>
      </Drawer>

      <Modal opened={deleteNodeTarget !== null} onClose={() => setDeleteNodeTarget(null)} title="删除节点" centered>
        <Stack>
          <Text>删除后不可恢复。</Text>
          <Text fw={600}>{deleteNodeTarget?.name}</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDeleteNodeTarget(null)}>
              取消
            </Button>
            <Button color="red" onClick={() => void handleDeleteNode()}>
              删除
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={nodeAccessEditor !== null}
        onClose={closeNodeAccessEditor}
        title="节点授权"
        centered
        size="lg"
      >
        <Stack>
          <Text size="sm" c="dimmed">
            {nodeAccessEditor?.ownerLabel ?? "当前订阅"}
          </Text>
          <MultiSelect
            label="可用节点"
            placeholder={nodeAccessLoading ? "正在加载节点..." : "选择当前订阅可用的节点"}
            searchable
            nothingFoundMessage="没有匹配节点"
            data={nodeOptions}
            value={nodeAccessSelection}
            onChange={setNodeAccessSelection}
            disabled={nodeAccessLoading || nodeAccessSaving}
          />
          <Group justify="space-between">
            <Text size="sm" c={nodeAccessSelection.length > 0 ? "dimmed" : "orange.7"}>
              {nodeAccessSelection.length > 0 ? `已分配 ${nodeAccessSelection.length} 个节点` : "当前订阅未分配节点"}
            </Text>
            <Group gap="xs">
              <Button variant="default" size="xs" onClick={() => setNodeAccessSelection(nodeOptions.map((item) => item.value))}>
                全选
              </Button>
              <Button variant="default" size="xs" onClick={() => setNodeAccessSelection([])}>
                清空
              </Button>
            </Group>
          </Group>
          <Group justify="flex-end">
            <Button variant="default" onClick={closeNodeAccessEditor}>
              取消
            </Button>
            <Button onClick={() => void saveNodeAccessEditor()} loading={nodeAccessSaving || nodeAccessLoading}>
              保存
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

function SectionCard(props: { searchValue: string; onSearchChange: (value: string) => void; children: ReactNode }) {
  return (
    <Card withBorder radius="xl" p="lg">
      <Stack gap="md">
        <TextInput
          leftSection={<IconSearch size={16} />}
          placeholder="搜索"
          value={props.searchValue}
          onChange={(event) => props.onSearchChange(event.currentTarget.value)}
        />
        {props.children}
      </Stack>
    </Card>
  );
}

function MetricCard(props: { label: string; value: number | string; icon: ReactNode }) {
  return (
    <Paper withBorder radius="xl" p="lg" className="metric-card">
      <Group justify="space-between">
        <div>
          <Text size="sm" c="dimmed">
            {props.label}
          </Text>
          <Title order={2} mt="sm">
            {props.value}
          </Title>
        </div>
        <ThemeIcon size={42} radius="lg" variant="light">
          {props.icon}
        </ThemeIcon>
      </Group>
    </Paper>
  );
}

function DataTable({ children }: { children: ReactNode }) {
  return (
    <ScrollArea>
      <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
        {children}
      </Table>
    </ScrollArea>
  );
}

function CompactSubscriptionList({ items }: { items: AdminSubscriptionRecordDto[] }) {
  return (
    <Stack gap="sm">
      {items.map((item) => (
        <Paper key={item.id} withBorder radius="lg" p="md">
          <Group justify="space-between" align="start">
            <div>
              <Text fw={600}>{item.userDisplayName}</Text>
              <Text size="sm" c="dimmed">
                {item.planName} · 到期 {formatDateTime(item.expireAt)}
              </Text>
            </div>
            <StatusBadge color={subscriptionStateColor(item.state)} label={translateSubscriptionState(item.state)} />
          </Group>
        </Paper>
      ))}
    </Stack>
  );
}

function CompactNodeList({ items }: { items: AdminNodeRecordDto[] }) {
  return (
    <Stack gap="sm">
      {items.map((item) => (
        <Paper key={item.id} withBorder radius="lg" p="md">
          <Group justify="space-between" align="start">
            <div>
              <Text fw={600}>{item.name}</Text>
              <Text size="sm" c="dimmed">
                {item.serverHost}:{item.serverPort}
              </Text>
            </div>
            <StatusBadge color={nodeProbeColor(item.probeStatus)} label={translateProbeStatus(item.probeStatus)} />
          </Group>
        </Paper>
      ))}
    </Stack>
  );
}

function StatusBadge(props: { color: string; label: string }) {
  return (
    <Badge color={props.color} variant="light">
      {props.label}
    </Badge>
  );
}

function RowActions({ children }: { children: ReactNode }) {
  return <Group gap={4} wrap="nowrap">{children}</Group>;
}

function emptyUserForm(): UserFormState {
  return {
    email: "",
    password: "",
    displayName: "",
    role: "user",
    status: "active"
  };
}

function emptyPlanForm(): PlanFormState {
  return {
    name: "",
    scope: "personal",
    totalTrafficGb: 100,
    renewable: true,
    isActive: true
  };
}

function emptySubscriptionCreateForm(snapshot?: AdminSnapshotDto | null): SubscriptionCreateFormState {
  const plan = snapshot?.plans.find((item) => item.isActive && item.scope === "personal") ?? snapshot?.plans.find((item) => item.scope === "personal");
  return {
    userId: snapshot?.users.find((item) => item.role === "user" && item.accountType === "personal" && item.currentSubscription === null)?.id ?? "",
    planId: plan?.id ?? "",
    totalTrafficGb: plan?.totalTrafficGb ?? 100,
    usedTrafficGb: 0,
    expireAt: toDateTimeLocal(addDays(new Date(), 30).toISOString()),
    state: "active",
    renewable: plan?.renewable ?? true
  };
}

function emptySubscriptionAdjustForm(): SubscriptionAdjustFormState {
  return {
    totalTrafficGb: 100,
    usedTrafficGb: 0,
    expireAt: toDateTimeLocal(new Date().toISOString()),
    state: "active",
    renewable: true
  };
}

function emptySubscriptionRenewForm(): SubscriptionRenewFormState {
  return {
    expireAt: toDateTimeLocal(addDays(new Date(), 30).toISOString()),
    extendDays: 30,
    resetTraffic: false,
    totalTrafficGb: ""
  };
}

function emptySubscriptionChangePlanForm(): SubscriptionChangePlanFormState {
  return {
    planId: "",
    totalTrafficGb: 100,
    expireAt: "",
    renewable: true
  };
}

function emptyTeamForm(snapshot?: AdminSnapshotDto | null): TeamFormState {
  return {
    name: "",
    ownerUserId: snapshot?.users.find((item) => item.role === "user" && item.accountType === "personal" && item.currentSubscription === null)?.id ?? "",
    status: "active"
  };
}

function emptyTeamMemberForm(): TeamMemberFormState {
  return {
    userId: "",
    role: "member"
  };
}

function emptyTeamSubscriptionForm(): TeamSubscriptionFormState {
  return {
    planId: "",
    totalTrafficGb: 100,
    expireAt: toDateTimeLocal(addDays(new Date(), 30).toISOString()),
    renewable: true
  };
}

function emptyNodeForm(): NodeFormState {
  return {
    subscriptionUrl: "",
    name: "",
    region: "",
    provider: "自有节点",
    tags: "",
    recommended: true,
    panelBaseUrl: "",
    panelApiBasePath: "/",
    panelUsername: "",
    panelPassword: "",
    panelInboundId: 1,
    panelEnabled: false
  };
}

function emptyAnnouncementForm(): AnnouncementFormState {
  return {
    title: "",
    body: "",
    level: "info",
    publishedAt: toDateTimeLocal(new Date().toISOString()),
    isActive: true,
    displayMode: "passive",
    countdownSeconds: 0
  };
}

function toPolicyForm(policy: AdminPolicyRecordDto): PolicyFormState {
  return {
    accessMode: policy.accessMode,
    defaultMode: policy.defaultMode,
    modes: policy.modes,
    blockAds: policy.features.blockAds,
    chinaDirect: policy.features.chinaDirect,
    aiServicesProxy: policy.features.aiServicesProxy,
    currentVersion: policy.currentVersion,
    minimumVersion: policy.minimumVersion,
    forceUpgrade: policy.forceUpgrade,
    changelog: policy.changelog.join("\n"),
    downloadUrl: policy.downloadUrl ?? ""
  };
}

function applyPlanToCreateForm(snapshot: AdminSnapshotDto, current: SubscriptionCreateFormState, planId: string): SubscriptionCreateFormState {
  const plan = snapshot.plans.find((item) => item.id === planId && item.scope === "personal");
  if (!plan) return { ...current, planId };
  return {
    ...current,
    planId,
    totalTrafficGb: plan.totalTrafficGb,
    renewable: plan.renewable
  };
}

function applyPlanToChangePlanForm(
  snapshot: AdminSnapshotDto,
  current: SubscriptionChangePlanFormState,
  planId: string
): SubscriptionChangePlanFormState {
  const plan = snapshot.plans.find((item) => item.id === planId && item.scope === "personal");
  if (!plan) return { ...current, planId };
  return {
    ...current,
    planId,
    totalTrafficGb: plan.totalTrafficGb,
    renewable: plan.renewable
  };
}

function applyPlanToTeamSubscriptionForm(
  snapshot: AdminSnapshotDto,
  current: TeamSubscriptionFormState,
  planId: string
): TeamSubscriptionFormState {
  const plan = snapshot.plans.find((item) => item.id === planId && item.scope === "team");
  if (!plan) return { ...current, planId };
  return {
    ...current,
    planId,
    totalTrafficGb: plan.totalTrafficGb,
    renewable: plan.renewable
  };
}

function readError(reason: unknown, fallback: string) {
  if (!(reason instanceof Error)) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(reason.message) as { message?: string[] | string };
    if (Array.isArray(parsed.message)) return parsed.message.join("，");
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    return reason.message || fallback;
  }
  return reason.message || fallback;
}

function isAccessTokenError(message: string) {
  return message.includes("缺少访问令牌") || message.includes("访问令牌无效") || message.includes("登录态已失效");
}

function filterByKeyword<T>(items: T[], keyword: string, projector: (item: T) => string[]) {
  if (!keyword.trim()) return items;
  const normalized = keyword.trim().toLowerCase();
  return items.filter((item) => projector(item).join(" ").toLowerCase().includes(normalized));
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

function toDateTimeLocal(value: string) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hour = `${date.getHours()}`.padStart(2, "0");
  const minute = `${date.getMinutes()}`.padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function fromDateTimeLocal(value: string) {
  return value ? new Date(value).toISOString() : undefined;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function addDays(base: Date, value: number) {
  const next = new Date(base);
  next.setDate(next.getDate() + value);
  return next;
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

function translateRole(role: UserRole) {
  return role === "admin" ? "管理员" : "用户";
}

function translateUserStatus(status: UserStatus) {
  return status === "active" ? "启用" : "禁用";
}

function translateSubscriptionState(state: SubscriptionState) {
  if (state === "active") return "有效";
  if (state === "paused") return "暂停";
  if (state === "expired") return "到期";
  return "流量耗尽";
}

function translateSourceAction(action: AdminSubscriptionRecordDto["sourceAction"]) {
  if (action === "created") return "新建";
  if (action === "renewed") return "续期";
  if (action === "plan_changed") return "变更套餐";
  return "校正";
}

function subscriptionStateColor(state: SubscriptionState) {
  if (state === "active") return "green";
  if (state === "paused") return "yellow";
  return "red";
}

function translateProbeStatus(status: AdminNodeRecordDto["probeStatus"]) {
  if (status === "healthy") return "正常";
  if (status === "degraded") return "降级";
  if (status === "offline") return "离线";
  return "未检测";
}

function nodeProbeColor(status: AdminNodeRecordDto["probeStatus"]) {
  if (status === "healthy") return "green";
  if (status === "degraded") return "yellow";
  if (status === "offline") return "red";
  return "gray";
}

function translateGatewayStatus(status: AdminNodeRecordDto["gatewayStatus"]) {
  if (status === "online") return "已就绪";
  if (status === "degraded") return "异常";
  return "未启动";
}

function nodeGatewayColor(status: AdminNodeRecordDto["gatewayStatus"]) {
  if (status === "online") return "green";
  if (status === "degraded") return "yellow";
  return "red";
}

function translatePanelStatus(status: AdminNodeRecordDto["panelStatus"]) {
  if (status === "online") return "在线";
  if (status === "degraded") return "异常";
  return "未配置";
}

function nodePanelColor(status: AdminNodeRecordDto["panelStatus"]) {
  if (status === "online") return "green";
  if (status === "degraded") return "yellow";
  return "gray";
}

function translateAnnouncementLevel(level: AnnouncementLevel) {
  if (level === "info") return "通知";
  if (level === "warning") return "提醒";
  return "成功";
}

function announcementLevelColor(level: AnnouncementLevel) {
  if (level === "info") return "blue";
  if (level === "warning") return "yellow";
  return "green";
}

function translateDisplayMode(mode: AnnouncementDisplayMode, countdownSeconds: number) {
  if (mode === "modal_confirm") return "确认弹窗";
  if (mode === "modal_countdown") return `倒计时确认 · ${countdownSeconds}s`;
  return "普通公告";
}

const modeOptions = [
  { value: "rule", label: "规则模式" },
  { value: "global", label: "全局代理" },
  { value: "direct", label: "直连模式" }
];

const subscriptionStateOptions = [
  { value: "active", label: "有效" },
  { value: "paused", label: "暂停" },
  { value: "expired", label: "到期" },
  { value: "exhausted", label: "流量耗尽" }
];

const announcementLevelOptions = [
  { value: "info", label: "通知" },
  { value: "warning", label: "提醒" },
  { value: "success", label: "成功" }
];

const displayModeOptions = [
  { value: "passive", label: "普通公告" },
  { value: "modal_confirm", label: "确认弹窗" },
  { value: "modal_countdown", label: "倒计时确认" }
];
