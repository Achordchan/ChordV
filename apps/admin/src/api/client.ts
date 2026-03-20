import type {
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
  RenewSubscriptionInputDto,
  SubscriptionNodeAccessDto,
  AuthSessionDto,
  UpdateAnnouncementInputDto,
  UpdateNodeInputDto,
  UpdatePlanInputDto,
  UpdatePlanSecurityInputDto,
  UpdatePolicyInputDto,
  UpdateSubscriptionInputDto,
  UpdateSubscriptionNodeAccessInputDto,
  UpdateTeamInputDto,
  UpdateTeamMemberInputDto,
  UpdateUserSecurityInputDto,
  UpdateUserInputDto
} from "@chordv/shared";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";
const ADMIN_ACCESS_TOKEN_KEY = "chordv_admin_access_token";
const ADMIN_REFRESH_TOKEN_KEY = "chordv_admin_refresh_token";

async function request<T>(path: string, init?: RequestInit, useAuth = true) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 15000);
  let response: Response;

  const adminAccessToken = useAuth
    ? localStorage.getItem(ADMIN_ACCESS_TOKEN_KEY) ?? import.meta.env.VITE_ADMIN_ACCESS_TOKEN ?? ""
    : "";

  try {
    response = await fetch(`${API_BASE}/api${path}`, {
      ...init,
      signal: init?.signal ?? controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(adminAccessToken ? { Authorization: `Bearer ${adminAccessToken}` } : {}),
        ...(init?.headers ?? {})
      }
    });
  } finally {
    window.clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export function getAdminSnapshot() {
  return request<AdminSnapshotDto>("/admin/snapshot");
}

export function loginAdmin(account: string, password: string) {
  return request<AuthSessionDto>(
    "/auth/login",
    {
      method: "POST",
      body: JSON.stringify({ email: account, password })
    },
    false
  );
}

export function refreshAdminSession(refreshToken: string) {
  return request<AuthSessionDto>(
    "/auth/refresh",
    {
      method: "POST",
      body: JSON.stringify({ refreshToken })
    },
    false
  );
}

export function logoutAdminSession() {
  return request<{ ok: boolean }>("/auth/logout", {
    method: "POST"
  });
}

export function persistAdminSession(session: AuthSessionDto) {
  localStorage.setItem(ADMIN_ACCESS_TOKEN_KEY, session.accessToken);
  localStorage.setItem(ADMIN_REFRESH_TOKEN_KEY, session.refreshToken);
}

export function clearAdminSession() {
  localStorage.removeItem(ADMIN_ACCESS_TOKEN_KEY);
  localStorage.removeItem(ADMIN_REFRESH_TOKEN_KEY);
}

export function hasAdminSession() {
  const adminAccessToken =
    localStorage.getItem(ADMIN_ACCESS_TOKEN_KEY) ?? import.meta.env.VITE_ADMIN_ACCESS_TOKEN ?? "";
  return Boolean(adminAccessToken);
}

export function getAdminRefreshToken() {
  return localStorage.getItem(ADMIN_REFRESH_TOKEN_KEY) ?? "";
}

export function createUser(input: CreateUserInputDto) {
  return request<AdminUserRecordDto>("/admin/users", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function updateUser(userId: string, input: UpdateUserInputDto) {
  return request<AdminUserRecordDto>(`/admin/users/${userId}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function updateUserSecurity(userId: string, input: UpdateUserSecurityInputDto) {
  return request<AdminUserRecordDto>(`/admin/users/${userId}/security`, {
    method: "PUT",
    body: JSON.stringify(input)
  });
}

export function createPlan(input: CreatePlanInputDto) {
  return request<AdminPlanRecordDto>("/admin/plans", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function updatePlan(planId: string, input: UpdatePlanInputDto) {
  return request<AdminPlanRecordDto>(`/admin/plans/${planId}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function updatePlanSecurity(planId: string, input: UpdatePlanSecurityInputDto) {
  return request<AdminPlanRecordDto>(`/admin/plans/${planId}/security`, {
    method: "PUT",
    body: JSON.stringify(input)
  });
}

export function createSubscription(input: CreateSubscriptionInputDto) {
  return request<AdminSubscriptionRecordDto>("/admin/subscriptions", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function renewSubscription(subscriptionId: string, input: RenewSubscriptionInputDto) {
  return request<AdminSubscriptionRecordDto>(`/admin/subscriptions/${subscriptionId}/renew`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function changeSubscriptionPlan(subscriptionId: string, input: ChangeSubscriptionPlanInputDto) {
  return request<AdminSubscriptionRecordDto>(`/admin/subscriptions/${subscriptionId}/change-plan`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function updateSubscription(subscriptionId: string, input: UpdateSubscriptionInputDto) {
  return request<AdminSubscriptionRecordDto>(`/admin/subscriptions/${subscriptionId}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function getSubscriptionNodeAccess(subscriptionId: string) {
  return request<SubscriptionNodeAccessDto>(`/admin/subscriptions/${subscriptionId}/nodes`);
}

export function updateSubscriptionNodeAccess(subscriptionId: string, input: UpdateSubscriptionNodeAccessInputDto) {
  return request<SubscriptionNodeAccessDto>(`/admin/subscriptions/${subscriptionId}/nodes`, {
    method: "PUT",
    body: JSON.stringify(input)
  });
}

export function createTeam(input: CreateTeamInputDto) {
  return request<AdminTeamRecordDto>("/admin/teams", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function updateTeam(teamId: string, input: UpdateTeamInputDto) {
  return request<AdminTeamRecordDto>(`/admin/teams/${teamId}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function createTeamMember(teamId: string, input: CreateTeamMemberInputDto) {
  return request<AdminTeamRecordDto>(`/admin/teams/${teamId}/members`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function updateTeamMember(teamId: string, memberId: string, input: UpdateTeamMemberInputDto) {
  return request<AdminTeamRecordDto>(`/admin/teams/${teamId}/members/${memberId}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function deleteTeamMember(teamId: string, memberId: string) {
  return request<{ ok: boolean }>(`/admin/teams/${teamId}/members/${memberId}`, {
    method: "DELETE"
  });
}

export function createTeamSubscription(teamId: string, input: CreateTeamSubscriptionInputDto) {
  return request<AdminSubscriptionRecordDto>(`/admin/teams/${teamId}/subscriptions`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function getTeamUsage(teamId: string) {
  return request<AdminTeamUsageRecordDto[]>(`/admin/teams/${teamId}/usage`);
}

export function importNode(input: ImportNodeInputDto) {
  return request<AdminNodeRecordDto>("/admin/nodes/import", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function fetchNodePanelInbounds(input: {
  panelBaseUrl: string;
  panelApiBasePath?: string;
  panelUsername: string;
  panelPassword: string;
}) {
  return request<AdminNodePanelInboundDto[]>("/admin/nodes/panel-inbounds", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function updateNode(nodeId: string, input: UpdateNodeInputDto) {
  return request<AdminNodeRecordDto>(`/admin/nodes/${nodeId}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function refreshNode(nodeId: string) {
  return request<AdminNodeRecordDto>(`/admin/nodes/${nodeId}/refresh`, {
    method: "POST"
  });
}

export function probeNode(nodeId: string) {
  return request<AdminNodeRecordDto>(`/admin/nodes/${nodeId}/probe`, {
    method: "POST"
  });
}

export function probeAllNodes() {
  return request<AdminNodeRecordDto[]>("/admin/nodes/probe-all", {
    method: "POST"
  });
}

export function deleteNode(nodeId: string) {
  return request<{ ok: boolean }>(`/admin/nodes/${nodeId}`, {
    method: "DELETE"
  });
}

export function createAnnouncement(input: CreateAnnouncementInputDto) {
  return request<AdminAnnouncementRecordDto>("/admin/announcements", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function updateAnnouncement(announcementId: string, input: UpdateAnnouncementInputDto) {
  return request<AdminAnnouncementRecordDto>(`/admin/announcements/${announcementId}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function updatePolicy(input: UpdatePolicyInputDto) {
  return request<AdminPolicyRecordDto>("/admin/policies", {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}
