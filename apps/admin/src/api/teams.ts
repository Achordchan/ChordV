import type {
  AdminSubscriptionRecordDto,
  AdminTeamRecordDto,
  AdminTeamUsageRecordDto,
  CreateTeamInputDto,
  CreateTeamMemberInputDto,
  CreateTeamSubscriptionInputDto,
  DeleteTeamMemberResultDto,
  KickTeamMemberInputDto,
  KickTeamMemberResultDto,
  UpdateTeamInputDto,
  UpdateTeamMemberInputDto
} from "@chordv/shared";
import { request } from "./base";

const PANEL_SYNC_ACTION_TIMEOUT_MS = 60 * 1000;
const ADMIN_READ_TIMEOUT_MS = 60 * 1000;

export function fetchAdminTeams() {
  return request<AdminTeamRecordDto[]>("/admin/teams", {
    timeoutMs: ADMIN_READ_TIMEOUT_MS
  });
}

export function createTeam(input: CreateTeamInputDto) {
  return request<AdminTeamRecordDto>("/admin/teams", {
    method: "POST",
    body: JSON.stringify(input),
    timeoutMs: PANEL_SYNC_ACTION_TIMEOUT_MS
  });
}

export function updateTeam(teamId: string, input: UpdateTeamInputDto) {
  return request<AdminTeamRecordDto>(`/admin/teams/${teamId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
    timeoutMs: PANEL_SYNC_ACTION_TIMEOUT_MS
  });
}

export function createTeamMember(teamId: string, input: CreateTeamMemberInputDto) {
  return request<AdminTeamRecordDto>(`/admin/teams/${teamId}/members`, {
    method: "POST",
    body: JSON.stringify(input),
    timeoutMs: PANEL_SYNC_ACTION_TIMEOUT_MS
  });
}

export function updateTeamMember(teamId: string, memberId: string, input: UpdateTeamMemberInputDto) {
  return request<AdminTeamRecordDto>(`/admin/teams/${teamId}/members/${memberId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
    timeoutMs: PANEL_SYNC_ACTION_TIMEOUT_MS
  });
}

export function deleteTeamMember(teamId: string, memberId: string) {
  return request<DeleteTeamMemberResultDto>(`/admin/teams/${teamId}/members/${memberId}`, {
    method: "DELETE",
    timeoutMs: PANEL_SYNC_ACTION_TIMEOUT_MS
  });
}

export function kickTeamMember(teamId: string, memberId: string, input: KickTeamMemberInputDto) {
  return request<KickTeamMemberResultDto>(`/admin/teams/${teamId}/members/${memberId}/kick`, {
    method: "POST",
    body: JSON.stringify(input),
    timeoutMs: PANEL_SYNC_ACTION_TIMEOUT_MS
  });
}

export function createTeamSubscription(teamId: string, input: CreateTeamSubscriptionInputDto) {
  return request<AdminSubscriptionRecordDto>(`/admin/teams/${teamId}/subscriptions`, {
    method: "POST",
    body: JSON.stringify(input),
    timeoutMs: PANEL_SYNC_ACTION_TIMEOUT_MS
  });
}

export function getTeamUsage(teamId: string) {
  return request<AdminTeamUsageRecordDto[]>(`/admin/teams/${teamId}/usage`, {
    timeoutMs: ADMIN_READ_TIMEOUT_MS
  });
}
